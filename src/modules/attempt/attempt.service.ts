import {
  AssessmentStatus,
  AttemptStatus,
  InvitationStatus,
  Prisma,
  ProblemType,
  Role,
} from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { buildMeta, buildSearchCondition, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import { scoreAnswer } from './scoring';
import {
  AnswerInput,
  AssessmentAttemptQuery,
  EvaluateInput,
  MyAttemptQuery,
} from './attempt.validation';

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
 * Everything needed to score an attempt: the per-assessment point overrides
 * plus each problem's answer key.
 */
const scoringInclude = {
  assessment: {
    include: {
      problems: {
        orderBy: { order: 'asc' },
        include: { problem: { include: { options: true, testCases: true } } },
      },
    },
  },
  submissions: true,
} satisfies Prisma.AttemptInclude;

type AttemptForScoring = Prisma.AttemptGetPayload<{ include: typeof scoringInclude }>;

/**
 * Starts an attempt against an invitation token.
 *
 * The deadline is computed here, from the server clock and the assessment's
 * duration — never supplied by the client. Everything else in the timer story
 * is measured against this one stored value.
 */
const start = async (token: string, actor: Actor, meta: ClientMeta): Promise<Record<string, unknown>> => {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { assessment: { select: { id: true, status: true, durationMinutes: true, title: true, startsAt: true, endsAt: true, deletedAt: true } } },
  });

  if (!invitation) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Invitation not found', [
      { path: 'token', message: 'No invitation matches this token' },
    ]);
  }

  // The token alone is not authorisation — it must have been issued to you.
  const isRecipient =
    invitation.candidateId === actor.id ||
    invitation.email.toLowerCase() === actor.email.toLowerCase();

  if (!isRecipient) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'This invitation was issued to someone else', [
      { path: 'token', message: 'You cannot use another candidate\'s invitation' },
    ]);
  }

  if (invitation.status === InvitationStatus.REVOKED) {
    throw new ApiError(StatusCodes.CONFLICT, 'This invitation was revoked', [
      { path: 'token', message: 'Contact the company for a new invitation' },
    ]);
  }

  if (invitation.expiresAt < new Date()) {
    throw new ApiError(StatusCodes.CONFLICT, 'This invitation has expired', [
      { path: 'token', message: `Expired on ${invitation.expiresAt.toISOString()}` },
    ]);
  }

  const assessment = invitation.assessment;

  if (assessment.deletedAt || assessment.status !== AssessmentStatus.PUBLISHED) {
    throw new ApiError(StatusCodes.CONFLICT, 'This assessment is not open for attempts', [
      { path: 'assessment', message: `Assessment status is ${assessment.status}` },
    ]);
  }

  const now = new Date();
  if (assessment.startsAt && assessment.startsAt > now) {
    throw new ApiError(StatusCodes.CONFLICT, 'This assessment has not opened yet', [
      { path: 'startsAt', message: `Opens at ${assessment.startsAt.toISOString()}` },
    ]);
  }
  if (assessment.endsAt && assessment.endsAt < now) {
    throw new ApiError(StatusCodes.CONFLICT, 'This assessment has closed', [
      { path: 'endsAt', message: `Closed at ${assessment.endsAt.toISOString()}` },
    ]);
  }

  const expiresAt = new Date(now.getTime() + assessment.durationMinutes * 60 * 1000);

  try {
    const attempt = await prisma.$transaction(async (tx) => {
      const created = await tx.attempt.create({
        data: {
          assessmentId: assessment.id,
          candidateId: actor.id,
          invitationId: invitation.id,
          startedAt: now,
          expiresAt,
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatus.ACCEPTED,
          acceptedAt: now,
          // Links the invite to the account that redeemed it, when it was sent
          // to an address that had not registered yet.
          candidateId: invitation.candidateId ?? actor.id,
        },
      });

      return created;
    });

    await logAudit({
      actorId: actor.id,
      action: 'ATTEMPT_STARTED',
      entity: 'Attempt',
      entityId: attempt.id,
      after: { assessmentId: assessment.id, expiresAt: expiresAt.toISOString() },
      ...meta,
    });

    return {
      attemptId: attempt.id,
      assessment: { id: assessment.id, title: assessment.title },
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      durationMinutes: assessment.durationMinutes,
      remainingSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    };
  } catch (error) {
    // @@unique([assessmentId, candidateId]) — a second start is a clean 409
    // rather than two live timers for one candidate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.attempt.findUnique({
        where: {
          assessmentId_candidateId: { assessmentId: assessment.id, candidateId: actor.id },
        },
        select: { id: true, status: true, expiresAt: true },
      });

      throw new ApiError(StatusCodes.CONFLICT, 'You have already started this assessment', [
        {
          path: 'attempt',
          message: `Existing attempt ${existing?.id} is ${existing?.status}`,
        },
      ]);
    }
    throw error;
  }
};

/**
 * Scores every submission on an attempt and finalises it.
 *
 * Runs inside one transaction so a partially-scored attempt is never visible:
 * either the whole scorecard lands or none of it does.
 */
const settle = async (
  attempt: AttemptForScoring,
  finalStatusWhenExpired = false,
): Promise<void> => {
  const submissionByProblem = new Map(attempt.submissions.map((s) => [s.problemId, s]));

  const maxScore = attempt.assessment.problems.reduce((sum, entry) => sum + entry.points, 0);

  await prisma.$transaction(async (tx) => {
    let totalScore = 0;
    let pendingManual = 0;

    for (const entry of attempt.assessment.problems) {
      const submission = submissionByProblem.get(entry.problemId);
      const problem = entry.problem;

      // Unanswered problems still need a zero-scored row so the scorecard is
      // complete and the evaluator can see what was skipped.
      const result = submission
        ? scoreAnswer(
            problem.type,
            {
              selectedOptionId: submission.selectedOptionId,
              output: submission.output,
              code: submission.code,
              answerText: submission.answerText,
            },
            entry.points,
            problem.options,
            problem.testCases,
          )
        : {
            score: 0,
            autoScored: problem.type !== ProblemType.WRITTEN,
            testCasesPassed: 0,
            testCasesTotal: 0,
          };

      if (!result.autoScored) pendingManual += 1;
      totalScore += result.score;

      await tx.submission.upsert({
        where: { attemptId_problemId: { attemptId: attempt.id, problemId: entry.problemId } },
        create: {
          attemptId: attempt.id,
          problemId: entry.problemId,
          maxScore: entry.points,
          score: result.score,
          autoScored: result.autoScored,
          testCasesPassed: result.testCasesPassed,
          testCasesTotal: result.testCasesTotal,
        },
        update: {
          maxScore: entry.points,
          score: result.score,
          autoScored: result.autoScored,
          testCasesPassed: result.testCasesPassed,
          testCasesTotal: result.testCasesTotal,
        },
      });
    }

    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 10000) / 100 : 0;

    await tx.attempt.update({
      where: { id: attempt.id },
      data: {
        // A written answer awaiting an evaluator keeps the attempt at SUBMITTED;
        // only a fully-scored attempt is EVALUATED.
        status: pendingManual > 0 ? AttemptStatus.SUBMITTED : AttemptStatus.EVALUATED,
        submittedAt: attempt.submittedAt ?? new Date(),
        evaluatedAt: pendingManual > 0 ? null : new Date(),
        totalScore: Math.round(totalScore * 100) / 100,
        maxScore,
        percentage,
        passed: percentage >= attempt.assessment.passingScore,
      },
    });
  });

  void finalStatusWhenExpired;
};

/** Loads an attempt for scoring, refusing if it is not the caller's to act on. */
const loadOwnAttempt = async (attemptId: string, actor: Actor): Promise<AttemptForScoring> => {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: scoringInclude,
  });

  if (!attempt) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Attempt not found');
  }

  if (attempt.candidateId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'This attempt belongs to another candidate');
  }

  return attempt;
};

/**
 * If the clock ran out while the attempt was still open, settle it now.
 * Saved answers are scored — running out of time loses the remaining questions,
 * not the work already done.
 */
const settleIfExpired = async (attemptId: string): Promise<boolean> => {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: scoringInclude,
  });

  if (!attempt || attempt.status !== AttemptStatus.IN_PROGRESS) return false;
  if (attempt.expiresAt > new Date()) return false;

  await settle(attempt, true);
  await logAudit({
    actorId: attempt.candidateId,
    action: 'ATTEMPT_AUTO_SUBMITTED_ON_EXPIRY',
    entity: 'Attempt',
    entityId: attempt.id,
  });
  return true;
};

const saveAnswer = async (
  attemptId: string,
  input: AnswerInput,
  actor: Actor,
): Promise<Record<string, unknown>> => {
  await settleIfExpired(attemptId);
  const attempt = await loadOwnAttempt(attemptId, actor);

  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw new ApiError(StatusCodes.CONFLICT, 'This attempt is no longer open', [
      { path: 'status', message: `Attempt is ${attempt.status}` },
    ]);
  }

  if (attempt.expiresAt < new Date()) {
    throw new ApiError(StatusCodes.CONFLICT, 'Time is up for this attempt', [
      { path: 'expiresAt', message: 'The deadline passed; answers can no longer be saved' },
    ]);
  }

  const entry = attempt.assessment.problems.find((p) => p.problemId === input.problemId);
  if (!entry) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'That problem is not on this assessment', [
      { path: 'problemId', message: 'Unknown problem for this attempt' },
    ]);
  }

  // An option id must belong to the problem it is being submitted against.
  if (input.selectedOptionId) {
    const valid = entry.problem.options.some((option) => option.id === input.selectedOptionId);
    if (!valid) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'That option does not belong to this problem', [
        { path: 'selectedOptionId', message: 'Invalid option for this problem' },
      ]);
    }
  }

  const payload = {
    selectedOptionId: entry.problem.type === ProblemType.MCQ ? (input.selectedOptionId ?? null) : null,
    code: entry.problem.type === ProblemType.CODING ? (input.code ?? null) : null,
    language: entry.problem.type === ProblemType.CODING ? (input.language ?? null) : null,
    output: entry.problem.type === ProblemType.CODING ? (input.output ?? null) : null,
    answerText: entry.problem.type === ProblemType.WRITTEN ? (input.answerText ?? null) : null,
  };

  // @@unique([attemptId, problemId]) makes autosave a plain upsert with no
  // read-then-write race between rapid saves.
  const submission = await prisma.submission.upsert({
    where: { attemptId_problemId: { attemptId, problemId: input.problemId } },
    create: { attemptId, problemId: input.problemId, maxScore: entry.points, ...payload },
    update: payload,
    select: { id: true, problemId: true, updatedAt: true },
  });

  return {
    ...submission,
    remainingSeconds: Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000)),
  };
};

const submit = async (
  attemptId: string,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const attempt = await loadOwnAttempt(attemptId, actor);

  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw new ApiError(StatusCodes.CONFLICT, 'This attempt has already been submitted', [
      { path: 'status', message: `Attempt is ${attempt.status}` },
    ]);
  }

  await settle(attempt);

  const settled = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: {
      submissions: {
        select: {
          id: true, problemId: true, score: true, maxScore: true,
          autoScored: true, testCasesPassed: true, testCasesTotal: true,
        },
      },
    },
  });

  await logAudit({
    actorId: actor.id,
    action: 'ATTEMPT_SUBMITTED',
    entity: 'Attempt',
    entityId: attemptId,
    after: { totalScore: settled.totalScore, percentage: settled.percentage, passed: settled.passed },
    ...meta,
  });

  return {
    attemptId: settled.id,
    status: settled.status,
    totalScore: settled.totalScore,
    maxScore: settled.maxScore,
    percentage: settled.percentage,
    passed: settled.passed,
    awaitingManualReview: settled.submissions.filter((s) => !s.autoScored).length,
    submissions: settled.submissions,
  };
};

export const AttemptService = { start, saveAnswer, submit, settleIfExpired, loadOwnAttempt };
export { ATTEMPT_SORTABLE_FIELDS, scoringInclude, settle };
export type { Actor, ClientMeta, AttemptForScoring };
