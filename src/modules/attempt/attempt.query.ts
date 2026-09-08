import { AttemptStatus, Prisma, ProblemType, Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { buildMeta, buildSearchCondition, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import { AttemptService } from './attempt.service';
import { AssessmentAttemptQuery, EvaluateInput, MyAttemptQuery } from './attempt.validation';

interface Actor {
  id: string;
  email: string;
  role: Role;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const ATTEMPT_SORTABLE_FIELDS = ['createdAt', 'submittedAt', 'totalScore', 'status'] as const;

/**
 * The candidate's live view of an attempt: the questions, their saved answers,
 * and how long is left.
 *
 * Answer keys are stripped here — `isCorrect`, hidden test cases and their
 * expected outputs never reach a candidate, even mid-attempt.
 */
const getForCandidate = async (attemptId: string, actor: Actor): Promise<Record<string, unknown>> => {
  await AttemptService.settleIfExpired(attemptId);

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      assessment: {
        include: {
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
        },
      },
      submissions: true,
      candidate: { select: { id: true, name: true, email: true } },
    },
  });

  if (!attempt) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Attempt not found');
  }

  const isCandidate = attempt.candidateId === actor.id;
  const isOwningCompany = attempt.assessment.companyId === actor.id;

  if (!isCandidate && !isOwningCompany && actor.role !== Role.ADMIN) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You cannot view this attempt', [
      { path: 'id', message: 'This attempt belongs to another candidate' },
    ]);
  }

  const revealAnswers = !isCandidate;
  const submissionByProblem = new Map(attempt.submissions.map((s) => [s.problemId, s]));

  const problems = attempt.assessment.problems.map((entry) => {
    const problem = entry.problem;
    const submission = submissionByProblem.get(entry.problemId);

    return {
      problemId: problem.id,
      order: entry.order,
      points: entry.points,
      title: problem.title,
      description: problem.description,
      type: problem.type,
      difficulty: problem.difficulty,
      language: problem.language,
      starterCode: problem.starterCode,
      options: problem.options.map((option) =>
        revealAnswers
          ? option
          : { id: option.id, text: option.text, sortOrder: option.sortOrder },
      ),
      // Candidates see sample cases only; hidden ones stay hidden.
      testCases: problem.testCases
        .filter((testCase) => revealAnswers || !testCase.isHidden)
        .map((testCase) =>
          revealAnswers
            ? testCase
            : {
                id: testCase.id,
                input: testCase.input,
                expectedOutput: testCase.expectedOutput,
                sortOrder: testCase.sortOrder,
              },
        ),
      answer: submission
        ? {
            selectedOptionId: submission.selectedOptionId,
            code: submission.code,
            language: submission.language,
            output: submission.output,
            answerText: submission.answerText,
            ...(attempt.status !== AttemptStatus.IN_PROGRESS && {
              score: submission.score,
              maxScore: submission.maxScore,
              autoScored: submission.autoScored,
              testCasesPassed: submission.testCasesPassed,
              testCasesTotal: submission.testCasesTotal,
              feedback: submission.feedback,
            }),
          }
        : null,
    };
  });

  const remainingSeconds =
    attempt.status === AttemptStatus.IN_PROGRESS
      ? Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000))
      : 0;

  return {
    id: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    submittedAt: attempt.submittedAt,
    remainingSeconds,
    ...(attempt.status !== AttemptStatus.IN_PROGRESS && {
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      percentage: attempt.percentage,
      passed: attempt.passed,
    }),
    candidate: revealAnswers ? attempt.candidate : undefined,
    assessment: {
      id: attempt.assessment.id,
      title: attempt.assessment.title,
      description: attempt.assessment.description,
      durationMinutes: attempt.assessment.durationMinutes,
      passingScore: attempt.assessment.passingScore,
      company: attempt.assessment.company,
    },
    problems,
  };
};

const listMine = async (
  query: MyAttemptQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, ATTEMPT_SORTABLE_FIELDS);

  const where: Prisma.AttemptWhereInput = {
    candidateId: actor.id,
    ...(query.status ? { status: query.status } : {}),
  };

  const [total, attempts] = await prisma.$transaction([
    prisma.attempt.count({ where }),
    prisma.attempt.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true, status: true, startedAt: true, expiresAt: true, submittedAt: true,
        totalScore: true, maxScore: true, percentage: true, passed: true,
        assessment: {
          select: {
            id: true, title: true, durationMinutes: true, passingScore: true,
            company: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  return { data: attempts, meta: buildMeta(page, limit, total) };
};

/** The company's view of everyone who attempted one of its assessments. */
const listForAssessment = async (
  assessmentId: string,
  query: AssessmentAttemptQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const assessment = await prisma.assessment.findFirst({
    where: { id: assessmentId, deletedAt: null },
    select: { id: true, companyId: true },
  });

  if (!assessment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Assessment not found');
  }

  if (actor.role !== Role.ADMIN && assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only view your own assessments');
  }

  const { page, limit, skip, orderBy } = resolvePagination(query, ATTEMPT_SORTABLE_FIELDS);

  const where: Prisma.AttemptWhereInput = {
    AND: [
      { assessmentId },
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.passed !== undefined ? [{ passed: query.passed }] : []),
      ...(query.q
        ? [
            {
              candidate: {
                OR: buildSearchCondition<Prisma.UserWhereInput>(query.q, ['name', 'email'])[0]?.OR,
              },
            } as Prisma.AttemptWhereInput,
          ]
        : []),
    ],
  };

  const [total, attempts] = await prisma.$transaction([
    prisma.attempt.count({ where }),
    prisma.attempt.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true, status: true, startedAt: true, submittedAt: true, evaluatedAt: true,
        totalScore: true, maxScore: true, percentage: true, passed: true,
        candidate: { select: { id: true, name: true, email: true } },
        _count: { select: { submissions: true } },
      },
    }),
  ]);

  return { data: attempts, meta: buildMeta(page, limit, total) };
};

/**
 * Manual evaluation of a written (or overridden) answer.
 *
 * Re-totals the attempt from its submissions afterwards, and promotes it to
 * EVALUATED once nothing is left awaiting a human — so the attempt's headline
 * score is always the sum of its parts rather than a separately-maintained
 * number that could drift.
 */
const evaluateSubmission = async (
  submissionId: string,
  input: EvaluateInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      attempt: { include: { assessment: { select: { companyId: true, passingScore: true } } } },
      problem: { select: { title: true, type: true } },
    },
  });

  if (!submission) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Submission not found');
  }

  if (actor.role !== Role.ADMIN && submission.attempt.assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only evaluate your own assessments');
  }

  if (submission.attempt.status === AttemptStatus.IN_PROGRESS) {
    throw new ApiError(StatusCodes.CONFLICT, 'This attempt has not been submitted yet', [
      { path: 'attempt', message: 'Wait until the candidate submits' },
    ]);
  }

  if (input.score > submission.maxScore) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Score exceeds the maximum for this problem', [
      { path: 'score', message: `Maximum is ${submission.maxScore}` },
    ]);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.submission.update({
      where: { id: submissionId },
      data: {
        score: input.score,
        feedback: input.feedback ?? null,
        autoScored: true,
        evaluatorId: actor.id,
        evaluatedAt: new Date(),
      },
    });

    const siblings = await tx.submission.findMany({
      where: { attemptId: submission.attemptId },
      select: { score: true, maxScore: true, autoScored: true },
    });

    const totalScore = Math.round(siblings.reduce((sum, s) => sum + s.score, 0) * 100) / 100;
    const maxScore = siblings.reduce((sum, s) => sum + s.maxScore, 0);
    const pending = siblings.filter((s) => !s.autoScored).length;
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 10000) / 100 : 0;

    return tx.attempt.update({
      where: { id: submission.attemptId },
      data: {
        totalScore,
        maxScore,
        percentage,
        passed: percentage >= submission.attempt.assessment.passingScore,
        status: pending > 0 ? AttemptStatus.SUBMITTED : AttemptStatus.EVALUATED,
        evaluatedAt: pending > 0 ? null : new Date(),
      },
      select: {
        id: true, status: true, totalScore: true, maxScore: true, percentage: true, passed: true,
      },
    });
  });

  await logAudit({
    actorId: actor.id,
    action: 'SUBMISSION_EVALUATED',
    entity: 'Submission',
    entityId: submissionId,
    before: { score: submission.score, autoScored: submission.autoScored },
    after: { score: input.score, attemptTotal: result.totalScore },
    ...meta,
  });

  return { submissionId, awardedScore: input.score, attempt: result };
};

void ProblemType;

export const AttemptQuery = { getForCandidate, listMine, listForAssessment, evaluateSubmission };
