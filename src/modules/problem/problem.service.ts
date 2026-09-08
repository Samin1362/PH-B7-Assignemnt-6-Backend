import { Prisma, Problem, Role } from '@prisma/client';
import crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { PaginationMeta } from '../../utils/sendResponse';
import {
  buildMeta,
  buildSearchCondition,
  parseCsv,
  resolvePagination,
} from '../../utils/queryBuilder';
import { PROBLEM_SEARCHABLE_FIELDS, PROBLEM_SORTABLE_FIELDS } from './problem.constant';
import { CreateProblemInput, ListProblemQuery, UpdateProblemInput } from './problem.validation';

interface Actor {
  id: string;
  role: Role;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);

/**
 * Titles repeat across companies, so a colliding slug gets a short random
 * suffix rather than failing the request.
 */
const uniqueSlug = async (title: string): Promise<string> => {
  const base = slugify(title) || 'problem';
  const taken = await prisma.problem.findUnique({ where: { slug: base }, select: { id: true } });
  return taken ? `${base}-${crypto.randomBytes(3).toString('hex')}` : base;
};

/** A company may read its own problems plus anything shared publicly. */
const visibilityScope = (actor: Actor): Prisma.ProblemWhereInput =>
  actor.role === Role.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { isPublic: true }] };

const fullInclude = {
  options: { orderBy: { sortOrder: 'asc' } },
  testCases: { orderBy: { sortOrder: 'asc' } },
  owner: { select: { id: true, name: true } },
  _count: { select: { assessmentProblems: true } },
} satisfies Prisma.ProblemInclude;

type ProblemWithRelations = Prisma.ProblemGetPayload<{ include: typeof fullInclude }>;

/**
 * Answer keys and hidden test cases belong to the owner. A company browsing
 * another company's public problem sees the question, not the solution.
 */
const redactForNonOwner = (
  problem: ProblemWithRelations,
  actor: Actor,
): Record<string, unknown> => {
  const isOwner = problem.ownerId === actor.id || actor.role === Role.ADMIN;
  if (isOwner) return problem;

  return {
    ...problem,
    options: problem.options.map(({ isCorrect: _isCorrect, ...rest }) => rest),
    testCases: problem.testCases
      .filter((testCase) => !testCase.isHidden)
      .map(({ expectedOutput: _expectedOutput, ...rest }) => rest),
  };
};

/** Loads a problem and enforces read visibility in one place. */
const findVisibleOrThrow = async (id: string, actor: Actor): Promise<ProblemWithRelations> => {
  const problem = await prisma.problem.findFirst({
    where: { id, deletedAt: null, ...visibilityScope(actor) },
    include: fullInclude,
  });

  if (!problem) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Problem not found', [
      { path: 'id', message: 'No problem exists with this id, or it is not visible to you' },
    ]);
  }

  return problem;
};

/** Write access is stricter than read access: owner or admin only. */
const assertCanMutate = async (id: string, actor: Actor): Promise<Problem> => {
  const problem = await prisma.problem.findFirst({ where: { id, deletedAt: null } });

  if (!problem) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Problem not found', [
      { path: 'id', message: 'No problem exists with this id' },
    ]);
  }

  if (actor.role !== Role.ADMIN && problem.ownerId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only modify your own problems', [
      { path: 'id', message: 'This problem belongs to another company' },
    ]);
  }

  return problem;
};

const create = async (
  input: CreateProblemInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<ProblemWithRelations> => {
  const { options, testCases, ...rest } = input;

  const problem = await prisma.problem.create({
    data: {
      ...rest,
      slug: await uniqueSlug(input.title),
      ownerId: actor.id,
      options: options?.length
        ? { create: options.map((option, index) => ({ ...option, sortOrder: index + 1 })) }
        : undefined,
      testCases: testCases?.length
        ? { create: testCases.map((testCase, index) => ({ ...testCase, sortOrder: index + 1 })) }
        : undefined,
    },
    include: fullInclude,
  });

  await logAudit({
    actorId: actor.id,
    action: 'PROBLEM_CREATED',
    entity: 'Problem',
    entityId: problem.id,
    after: { title: problem.title, type: problem.type, difficulty: problem.difficulty },
    ...meta,
  });

  return problem;
};

const list = async (
  query: ListProblemQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, PROBLEM_SORTABLE_FIELDS);
  const tags = parseCsv(query.tags);

  const where: Prisma.ProblemWhereInput = {
    AND: [
      { deletedAt: null },
      visibilityScope(actor),
      ...buildSearchCondition<Prisma.ProblemWhereInput>(query.q, PROBLEM_SEARCHABLE_FIELDS),
      ...(query.type ? [{ type: query.type }] : []),
      ...(query.difficulty ? [{ difficulty: query.difficulty }] : []),
      ...(query.isPublic !== undefined ? [{ isPublic: query.isPublic }] : []),
      // `hasSome` returns problems carrying any of the requested tags.
      ...(tags ? [{ tags: { hasSome: tags } }] : []),
    ],
  };

  // Count and page are issued together so the total reflects the same snapshot.
  const [total, problems] = await prisma.$transaction([
    prisma.problem.count({ where }),
    prisma.problem.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        owner: { select: { id: true, name: true } },
        _count: { select: { options: true, testCases: true, assessmentProblems: true } },
      },
    }),
  ]);

  return { data: problems, meta: buildMeta(page, limit, total) };
};

const getById = async (id: string, actor: Actor): Promise<Record<string, unknown>> => {
  const problem = await findVisibleOrThrow(id, actor);
  return redactForNonOwner(problem, actor);
};

const update = async (
  id: string,
  input: UpdateProblemInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<ProblemWithRelations> => {
  const before = await assertCanMutate(id, actor);

  const updated = await prisma.problem.update({
    where: { id },
    data: input,
    include: fullInclude,
  });

  await logAudit({
    actorId: actor.id,
    action: 'PROBLEM_UPDATED',
    entity: 'Problem',
    entityId: id,
    before: { title: before.title, difficulty: before.difficulty, points: before.points },
    after: { title: updated.title, difficulty: updated.difficulty, points: updated.points },
    ...meta,
  });

  return updated;
};

/**
 * Soft delete. A problem already used in an assessment is never physically
 * removed, so historical attempts and scorecards keep resolving.
 */
const softDelete = async (id: string, actor: Actor, meta: ClientMeta): Promise<void> => {
  const problem = await assertCanMutate(id, actor);

  const usage = await prisma.assessmentProblem.count({
    where: { problemId: id, assessment: { status: { in: ['PUBLISHED'] }, deletedAt: null } },
  });

  if (usage > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      'This problem is in use by a published assessment',
      [{ path: 'id', message: `Detach it from ${usage} published assessment(s) first` }],
    );
  }

  await prisma.problem.update({ where: { id }, data: { deletedAt: new Date() } });

  await logAudit({
    actorId: actor.id,
    action: 'PROBLEM_DELETED',
    entity: 'Problem',
    entityId: id,
    before: { title: problem.title, deletedAt: null },
    after: { deletedAt: new Date().toISOString() },
    ...meta,
  });
};

const addTestCases = async (
  id: string,
  testCases: { input: string; expectedOutput: string; isHidden: boolean; weight: number }[],
  actor: Actor,
  meta: ClientMeta,
): Promise<ProblemWithRelations> => {
  const problem = await assertCanMutate(id, actor);

  if (problem.type !== 'CODING') {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Test cases apply to CODING problems only', [
      { path: 'type', message: `This problem is of type ${problem.type}` },
    ]);
  }

  const existing = await prisma.testCase.count({ where: { problemId: id } });

  await prisma.testCase.createMany({
    data: testCases.map((testCase, index) => ({
      ...testCase,
      problemId: id,
      sortOrder: existing + index + 1,
    })),
  });

  await logAudit({
    actorId: actor.id,
    action: 'PROBLEM_TEST_CASES_ADDED',
    entity: 'Problem',
    entityId: id,
    after: { added: testCases.length },
    ...meta,
  });

  return prisma.problem.findUniqueOrThrow({ where: { id }, include: fullInclude });
};

const removeTestCase = async (
  id: string,
  testCaseId: string,
  actor: Actor,
  meta: ClientMeta,
): Promise<void> => {
  await assertCanMutate(id, actor);

  const testCase = await prisma.testCase.findFirst({ where: { id: testCaseId, problemId: id } });

  if (!testCase) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Test case not found', [
      { path: 'testCaseId', message: 'No test case with this id belongs to this problem' },
    ]);
  }

  await prisma.testCase.delete({ where: { id: testCaseId } });

  await logAudit({
    actorId: actor.id,
    action: 'PROBLEM_TEST_CASE_REMOVED',
    entity: 'Problem',
    entityId: id,
    before: { testCaseId, input: testCase.input },
    ...meta,
  });
};

export const ProblemService = {
  create,
  list,
  getById,
  update,
  softDelete,
  addTestCases,
  removeTestCase,
};
