import { Assessment, AssessmentStatus, Prisma, Role } from '@prisma/client';
import crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import {
  buildMeta,
  buildSearchCondition,
  resolvePagination,
} from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import {
  ALLOWED_TRANSITIONS,
  ASSESSMENT_SEARCHABLE_FIELDS,
  ASSESSMENT_SORTABLE_FIELDS,
  EDITABLE_FIELDS,
} from './assessment.constant';
import {
  AttachProblemsInput,
  CreateAssessmentInput,
  ListAssessmentQuery,
  UpdateAssessmentInput,
} from './assessment.validation';

interface Actor {
  id: string;
  email: string;
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

const uniqueSlug = async (title: string): Promise<string> => {
  const base = slugify(title) || 'assessment';
  const taken = await prisma.assessment.findUnique({ where: { slug: base }, select: { id: true } });
  return taken ? `${base}-${crypto.randomBytes(3).toString('hex')}` : base;
};

/**
 * Who may see which assessments. A candidate sees only published assessments
 * they were actually invited to — matched on the invitation's linked account or
 * its email, since an invite can be sent before the candidate registers.
 */
const visibilityScope = (actor: Actor): Prisma.AssessmentWhereInput => {
  if (actor.role === Role.ADMIN) return {};
  if (actor.role === Role.COMPANY) return { companyId: actor.id };

  return {
    status: AssessmentStatus.PUBLISHED,
    invitations: {
      some: {
        OR: [{ candidateId: actor.id }, { email: actor.email }],
        status: { in: ['PENDING', 'ACCEPTED'] },
      },
    },
  };
};

const detailInclude = {
  company: { select: { id: true, name: true } },
  problems: {
    orderBy: { order: 'asc' },
    include: {
      problem: {
        include: {
          options: { orderBy: { sortOrder: 'asc' } },
          testCases: { orderBy: { sortOrder: 'asc' } },
        },
      },
    },
  },
  _count: { select: { invitations: true, attempts: true } },
} satisfies Prisma.AssessmentInclude;

type AssessmentDetail = Prisma.AssessmentGetPayload<{ include: typeof detailInclude }>;

/** Sum of the per-assessment point overrides — the denominator for scoring. */
const computeMaxScore = (assessment: AssessmentDetail): number =>
  assessment.problems.reduce((total, entry) => total + entry.points, 0);

/**
 * A candidate viewing an assessment gets its shape — how many problems, how
 * long, what it is worth — but never the problem bodies or answer keys. Those
 * are released only through the attempt endpoints, once a timer is running.
 */
const shapeDetail = (assessment: AssessmentDetail, actor: Actor): Record<string, unknown> => {
  const maxScore = computeMaxScore(assessment);

  if (actor.role === Role.CANDIDATE) {
    const { problems, ...rest } = assessment;
    return {
      ...rest,
      maxScore,
      problemCount: problems.length,
      problems: undefined,
    };
  }

  return { ...assessment, maxScore };
};

const findVisibleOrThrow = async (id: string, actor: Actor): Promise<AssessmentDetail> => {
  const assessment = await prisma.assessment.findFirst({
    where: { id, deletedAt: null, ...visibilityScope(actor) },
    include: detailInclude,
  });

  if (!assessment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Assessment not found', [
      { path: 'id', message: 'No assessment exists with this id, or it is not visible to you' },
    ]);
  }

  return assessment;
};

/** Write access: the owning company, or an admin. */
const assertCanMutate = async (id: string, actor: Actor): Promise<Assessment> => {
  const assessment = await prisma.assessment.findFirst({ where: { id, deletedAt: null } });

  if (!assessment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Assessment not found', [
      { path: 'id', message: 'No assessment exists with this id' },
    ]);
  }

  if (actor.role !== Role.ADMIN && assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only modify your own assessments', [
      { path: 'id', message: 'This assessment belongs to another company' },
    ]);
  }

  return assessment;
};

/** Problem composition is frozen the moment candidates can start attempting. */
const assertComposable = (assessment: Assessment): void => {
  if (assessment.status !== AssessmentStatus.DRAFT) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      'Problems can only be changed while an assessment is in DRAFT',
      [
        {
          path: 'status',
          message: `This assessment is ${assessment.status}. Candidates may already have attempts in progress.`,
        },
      ],
    );
  }
};

const create = async (
  input: CreateAssessmentInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const assessment = await prisma.assessment.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      durationMinutes: input.durationMinutes,
      passingScore: input.passingScore,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      slug: await uniqueSlug(input.title),
      companyId: actor.id,
    },
    include: detailInclude,
  });

  await logAudit({
    actorId: actor.id,
    action: 'ASSESSMENT_CREATED',
    entity: 'Assessment',
    entityId: assessment.id,
    after: { title: assessment.title, durationMinutes: assessment.durationMinutes },
    ...meta,
  });

  return shapeDetail(assessment, actor);
};

const list = async (
  query: ListAssessmentQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, ASSESSMENT_SORTABLE_FIELDS);

  const where: Prisma.AssessmentWhereInput = {
    AND: [
      { deletedAt: null },
      visibilityScope(actor),
      ...buildSearchCondition<Prisma.AssessmentWhereInput>(query.q, ASSESSMENT_SEARCHABLE_FIELDS),
      ...(query.status ? [{ status: query.status }] : []),
    ],
  };

  const [total, assessments] = await prisma.$transaction([
    prisma.assessment.count({ where }),
    prisma.assessment.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        company: { select: { id: true, name: true } },
        problems: { select: { points: true } },
        _count: { select: { problems: true, invitations: true, attempts: true } },
      },
    }),
  ]);

  const data = assessments.map(({ problems, ...rest }) => ({
    ...rest,
    maxScore: problems.reduce((sum, entry) => sum + entry.points, 0),
  }));

  return { data, meta: buildMeta(page, limit, total) };
};

const getById = async (id: string, actor: Actor): Promise<Record<string, unknown>> =>
  shapeDetail(await findVisibleOrThrow(id, actor), actor);

const update = async (
  id: string,
  input: UpdateAssessmentInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const before = await assertCanMutate(id, actor);

  const editable = EDITABLE_FIELDS[before.status];
  const attempted = Object.keys(input);
  const rejected = attempted.filter((field) => !editable.includes(field));

  if (rejected.length > 0) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `These fields cannot be changed while the assessment is ${before.status}`,
      rejected.map((field) => ({
        path: field,
        message: editable.length
          ? `Editable in ${before.status}: ${editable.join(', ')}`
          : `Nothing is editable once an assessment is ${before.status}`,
      })),
    );
  }

  const updated = await prisma.assessment.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }),
      ...(input.passingScore !== undefined && { passingScore: input.passingScore }),
      ...(input.startsAt !== undefined && {
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
      }),
      ...(input.endsAt !== undefined && { endsAt: input.endsAt ? new Date(input.endsAt) : null }),
    },
    include: detailInclude,
  });

  await logAudit({
    actorId: actor.id,
    action: 'ASSESSMENT_UPDATED',
    entity: 'Assessment',
    entityId: id,
    before: { title: before.title, durationMinutes: before.durationMinutes },
    after: { title: updated.title, durationMinutes: updated.durationMinutes },
    ...meta,
  });

  return shapeDetail(updated, actor);
};

/**
 * The state machine. Every transition is checked against ALLOWED_TRANSITIONS,
 * and publishing additionally requires at least one attached problem — an empty
 * assessment would be unscoreable.
 */
const changeStatus = async (
  id: string,
  next: AssessmentStatus,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const assessment = await assertCanMutate(id, actor);
  const allowed = ALLOWED_TRANSITIONS[assessment.status];

  if (assessment.status === next) {
    throw new ApiError(StatusCodes.CONFLICT, `Assessment is already ${next}`, [
      { path: 'status', message: `Allowed transitions: ${allowed.join(', ') || 'none'}` },
    ]);
  }

  if (!allowed.includes(next)) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `Cannot move an assessment from ${assessment.status} to ${next}`,
      [
        {
          path: 'status',
          message: `Allowed transitions from ${assessment.status}: ${allowed.join(', ') || 'none (terminal state)'}`,
        },
      ],
    );
  }

  if (next === AssessmentStatus.PUBLISHED) {
    const problemCount = await prisma.assessmentProblem.count({ where: { assessmentId: id } });
    if (problemCount === 0) {
      throw new ApiError(StatusCodes.CONFLICT, 'Cannot publish an assessment with no problems', [
        { path: 'problems', message: 'Attach at least one problem before publishing' },
      ]);
    }
  }

  const updated = await prisma.assessment.update({
    where: { id },
    data: {
      status: next,
      ...(next === AssessmentStatus.PUBLISHED && { publishedAt: new Date() }),
    },
    include: detailInclude,
  });

  await logAudit({
    actorId: actor.id,
    action: `ASSESSMENT_${next}`,
    entity: 'Assessment',
    entityId: id,
    before: { status: assessment.status },
    after: { status: next },
    ...meta,
  });

  return shapeDetail(updated, actor);
};

const attachProblems = async (
  id: string,
  input: AttachProblemsInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const assessment = await assertCanMutate(id, actor);
  assertComposable(assessment);

  const requestedIds = input.problems.map((entry) => entry.problemId);

  // Only problems the company may actually use: its own, or shared publicly.
  const usable = await prisma.problem.findMany({
    where: {
      id: { in: requestedIds },
      deletedAt: null,
      ...(actor.role === Role.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { isPublic: true }] }),
    },
    select: { id: true, points: true },
  });

  const usableMap = new Map(usable.map((problem) => [problem.id, problem]));
  const unusable = requestedIds.filter((problemId) => !usableMap.has(problemId));

  if (unusable.length > 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Some problems could not be attached', [
      {
        path: 'problems',
        message: `Not found, deleted, or not accessible to you: ${unusable.join(', ')}`,
      },
    ]);
  }

  const already = await prisma.assessmentProblem.findMany({
    where: { assessmentId: id, problemId: { in: requestedIds } },
    select: { problemId: true },
  });

  if (already.length > 0) {
    throw new ApiError(StatusCodes.CONFLICT, 'Some problems are already attached', [
      {
        path: 'problems',
        message: `Already on this assessment: ${already.map((entry) => entry.problemId).join(', ')}`,
      },
    ]);
  }

  const highest = await prisma.assessmentProblem.aggregate({
    where: { assessmentId: id },
    _max: { order: true },
  });
  let nextOrder = (highest._max.order ?? 0) + 1;

  await prisma.assessmentProblem.createMany({
    data: input.problems.map((entry) => ({
      assessmentId: id,
      problemId: entry.problemId,
      // Falls back to the problem's own default weighting.
      points: entry.points ?? usableMap.get(entry.problemId)!.points,
      order: entry.order ?? nextOrder++,
    })),
  });

  await logAudit({
    actorId: actor.id,
    action: 'ASSESSMENT_PROBLEMS_ATTACHED',
    entity: 'Assessment',
    entityId: id,
    after: { attached: requestedIds },
    ...meta,
  });

  return shapeDetail(
    await prisma.assessment.findUniqueOrThrow({ where: { id }, include: detailInclude }),
    actor,
  );
};

const detachProblem = async (
  id: string,
  problemId: string,
  actor: Actor,
  meta: ClientMeta,
): Promise<void> => {
  const assessment = await assertCanMutate(id, actor);
  assertComposable(assessment);

  const link = await prisma.assessmentProblem.findUnique({
    where: { assessmentId_problemId: { assessmentId: id, problemId } },
  });

  if (!link) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'That problem is not on this assessment', [
      { path: 'problemId', message: 'No such problem is attached' },
    ]);
  }

  await prisma.assessmentProblem.delete({ where: { id: link.id } });

  await logAudit({
    actorId: actor.id,
    action: 'ASSESSMENT_PROBLEM_DETACHED',
    entity: 'Assessment',
    entityId: id,
    before: { problemId, points: link.points },
    ...meta,
  });
};

/** Soft delete, refused while candidates could still be attempting. */
const softDelete = async (id: string, actor: Actor, meta: ClientMeta): Promise<void> => {
  const assessment = await assertCanMutate(id, actor);

  if (assessment.status === AssessmentStatus.PUBLISHED) {
    throw new ApiError(StatusCodes.CONFLICT, 'A published assessment cannot be deleted', [
      { path: 'status', message: 'Close it first so in-flight attempts are not orphaned' },
    ]);
  }

  await prisma.assessment.update({ where: { id }, data: { deletedAt: new Date() } });

  await logAudit({
    actorId: actor.id,
    action: 'ASSESSMENT_DELETED',
    entity: 'Assessment',
    entityId: id,
    before: { title: assessment.title, status: assessment.status },
    after: { deletedAt: new Date().toISOString() },
    ...meta,
  });
};

export const AssessmentService = {
  create,
  list,
  getById,
  update,
  changeStatus,
  attachProblems,
  detachProblem,
  softDelete,
};
