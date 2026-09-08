import { AttemptStatus, InvitationStatus, Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { cache, cacheKeys, TTL } from '../../utils/cache';

interface Actor {
  id: string;
  email: string;
  role: Role;
}

const round = (value: number, dp = 2): number => {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

/**
 * A candidate's scorecard: what they scored on each problem and why.
 *
 * Answer keys stay hidden even after scoring — a candidate learning the correct
 * option would compromise the question for everyone still to sit it. They see
 * their own answer, their mark, and any evaluator feedback.
 */
const getAttemptResult = async (attemptId: string, actor: Actor): Promise<Record<string, unknown>> => {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      candidate: { select: { id: true, name: true, email: true } },
      assessment: {
        select: {
          id: true, title: true, passingScore: true, durationMinutes: true, companyId: true,
          company: { select: { id: true, name: true } },
          problems: { select: { problemId: true, order: true, points: true } },
        },
      },
      submissions: {
        include: {
          problem: { select: { id: true, title: true, type: true, difficulty: true } },
          evaluator: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!attempt) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Attempt not found');
  }

  const isOwner = attempt.candidateId === actor.id;
  const isCompany = attempt.assessment.companyId === actor.id;

  if (!isOwner && !isCompany && actor.role !== Role.ADMIN) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You cannot view this result', [
      { path: 'id', message: 'This result belongs to another candidate' },
    ]);
  }

  if (attempt.status === AttemptStatus.IN_PROGRESS) {
    throw new ApiError(StatusCodes.CONFLICT, 'This attempt has not been submitted yet', [
      { path: 'status', message: 'Results are available once the attempt is submitted' },
    ]);
  }

  const orderByProblem = new Map(
    attempt.assessment.problems.map((entry) => [entry.problemId, entry.order]),
  );

  const breakdown = attempt.submissions
    .map((submission) => ({
      problemId: submission.problemId,
      order: orderByProblem.get(submission.problemId) ?? 0,
      title: submission.problem.title,
      type: submission.problem.type,
      difficulty: submission.problem.difficulty,
      score: submission.score,
      maxScore: submission.maxScore,
      percentage: submission.maxScore > 0 ? round((submission.score / submission.maxScore) * 100) : 0,
      autoScored: submission.autoScored,
      testCasesPassed: submission.testCasesPassed,
      testCasesTotal: submission.testCasesTotal,
      feedback: submission.feedback,
      evaluatedBy: submission.evaluator?.name ?? null,
      // The company reviewing the result needs to see what was written; the
      // candidate already knows what they wrote.
      ...(isCompany || actor.role === Role.ADMIN
        ? { answerText: submission.answerText, code: submission.code, language: submission.language }
        : {}),
    }))
    .sort((a, b) => a.order - b.order);

  const durationSeconds = attempt.submittedAt
    ? Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)
    : null;

  return {
    attemptId: attempt.id,
    status: attempt.status,
    candidate: attempt.candidate,
    assessment: {
      id: attempt.assessment.id,
      title: attempt.assessment.title,
      passingScore: attempt.assessment.passingScore,
      company: attempt.assessment.company,
    },
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    percentage: attempt.percentage,
    passed: attempt.passed,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    evaluatedAt: attempt.evaluatedAt,
    timeTakenSeconds: durationSeconds,
    allowedSeconds: attempt.assessment.durationMinutes * 60,
    awaitingManualReview: attempt.submissions.filter((s) => !s.autoScored).length,
    breakdown,
  };
};

const assertCompanyOwnsAssessment = async (assessmentId: string, actor: Actor): Promise<void> => {
  const assessment = await prisma.assessment.findFirst({
    where: { id: assessmentId, deletedAt: null },
    select: { companyId: true },
  });

  if (!assessment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Assessment not found');
  }

  if (actor.role !== Role.ADMIN && assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only view your own assessments');
  }
};

/**
 * Aggregate performance across every attempt at an assessment, plus a
 * per-problem breakdown that shows which questions are actually discriminating
 * between candidates.
 */
const buildReport = async (assessmentId: string): Promise<Record<string, unknown>> => {
  const [assessment, invitedCount, attempts, perProblem] = await Promise.all([
    prisma.assessment.findUniqueOrThrow({
      where: { id: assessmentId },
      select: {
        id: true, title: true, status: true, passingScore: true, durationMinutes: true,
        problems: {
          orderBy: { order: 'asc' },
          select: {
            problemId: true, order: true, points: true,
            problem: { select: { title: true, type: true, difficulty: true } },
          },
        },
      },
    }),
    prisma.invitation.count({
      where: { assessmentId, status: { not: InvitationStatus.REVOKED } },
    }),
    prisma.attempt.findMany({
      where: { assessmentId },
      select: {
        status: true, totalScore: true, maxScore: true, percentage: true, passed: true,
        startedAt: true, submittedAt: true,
      },
    }),
    prisma.submission.groupBy({
      by: ['problemId'],
      where: { attempt: { assessmentId, status: { not: AttemptStatus.IN_PROGRESS } } },
      _avg: { score: true },
      _max: { score: true },
      _min: { score: true },
      _count: { _all: true },
    }),
  ]);

  const finished = attempts.filter((a) => a.status !== AttemptStatus.IN_PROGRESS);
  const inProgress = attempts.length - finished.length;
  const passedCount = finished.filter((a) => a.passed).length;

  const percentages = finished.map((a) => a.percentage);
  const average = percentages.length
    ? round(percentages.reduce((sum, p) => sum + p, 0) / percentages.length)
    : 0;

  const durations = finished
    .filter((a) => a.submittedAt)
    .map((a) => Math.round((a.submittedAt!.getTime() - a.startedAt.getTime()) / 1000));

  const statsByProblem = new Map(perProblem.map((row) => [row.problemId, row]));

  const problemBreakdown = assessment.problems.map((entry) => {
    const stats = statsByProblem.get(entry.problemId);
    const avgScore = round(stats?._avg.score ?? 0);
    return {
      problemId: entry.problemId,
      order: entry.order,
      title: entry.problem.title,
      type: entry.problem.type,
      difficulty: entry.problem.difficulty,
      points: entry.points,
      answeredBy: stats?._count._all ?? 0,
      averageScore: avgScore,
      averagePercentage: entry.points > 0 ? round((avgScore / entry.points) * 100) : 0,
      highestScore: round(stats?._max.score ?? 0),
      lowestScore: round(stats?._min.score ?? 0),
    };
  });

  const answered = problemBreakdown.filter((p) => p.answeredBy > 0);
  const hardest = [...answered].sort((a, b) => a.averagePercentage - b.averagePercentage)[0];
  const easiest = [...answered].sort((a, b) => b.averagePercentage - a.averagePercentage)[0];

  return {
    assessment: {
      id: assessment.id,
      title: assessment.title,
      status: assessment.status,
      passingScore: assessment.passingScore,
      durationMinutes: assessment.durationMinutes,
      problemCount: assessment.problems.length,
      maxScore: assessment.problems.reduce((sum, entry) => sum + entry.points, 0),
    },
    participation: {
      invited: invitedCount,
      started: attempts.length,
      inProgress,
      completed: finished.length,
      notStarted: Math.max(0, invitedCount - attempts.length),
      startRate: invitedCount > 0 ? round((attempts.length / invitedCount) * 100) : 0,
      completionRate: attempts.length > 0 ? round((finished.length / attempts.length) * 100) : 0,
    },
    scores: {
      averagePercentage: average,
      highestPercentage: percentages.length ? round(Math.max(...percentages)) : 0,
      lowestPercentage: percentages.length ? round(Math.min(...percentages)) : 0,
      passed: passedCount,
      failed: finished.length - passedCount,
      passRate: finished.length > 0 ? round((passedCount / finished.length) * 100) : 0,
    },
    timing: {
      averageSeconds: durations.length
        ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
        : null,
      fastestSeconds: durations.length ? Math.min(...durations) : null,
      slowestSeconds: durations.length ? Math.max(...durations) : null,
    },
    problemBreakdown,
    insights: {
      hardestProblem: hardest ? { title: hardest.title, averagePercentage: hardest.averagePercentage } : null,
      easiestProblem: easiest ? { title: easiest.title, averagePercentage: easiest.averagePercentage } : null,
    },
    generatedAt: new Date().toISOString(),
  };
};

const getReport = async (
  assessmentId: string,
  actor: Actor,
): Promise<{ data: Record<string, unknown>; cached: boolean }> => {
  await assertCompanyOwnsAssessment(assessmentId, actor);
  return cache.wrap(cacheKeys.assessmentReport(assessmentId), TTL.report, () =>
    buildReport(assessmentId),
  );
};

/**
 * Ranked candidates. Ties on score are broken by who submitted first, so the
 * ordering is deterministic rather than whatever the database happens to return.
 */
const buildLeaderboard = async (assessmentId: string, limit: number): Promise<Record<string, unknown>> => {
  const attempts = await prisma.attempt.findMany({
    where: { assessmentId, status: { not: AttemptStatus.IN_PROGRESS } },
    orderBy: [{ totalScore: 'desc' }, { submittedAt: 'asc' }],
    take: limit,
    select: {
      id: true, totalScore: true, maxScore: true, percentage: true, passed: true,
      startedAt: true, submittedAt: true, status: true,
      candidate: { select: { id: true, name: true, email: true } },
    },
  });

  return {
    assessmentId,
    total: attempts.length,
    entries: attempts.map((attempt, index) => ({
      rank: index + 1,
      candidate: attempt.candidate,
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      percentage: attempt.percentage,
      passed: attempt.passed,
      status: attempt.status,
      timeTakenSeconds: attempt.submittedAt
        ? Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)
        : null,
    })),
    generatedAt: new Date().toISOString(),
  };
};

const getLeaderboard = async (
  assessmentId: string,
  limit: number,
  actor: Actor,
): Promise<{ data: Record<string, unknown>; cached: boolean }> => {
  await assertCompanyOwnsAssessment(assessmentId, actor);
  return cache.wrap(cacheKeys.assessmentLeaderboard(assessmentId), TTL.leaderboard, () =>
    buildLeaderboard(assessmentId, limit),
  );
};

export const ResultService = { getAttemptResult, getReport, getLeaderboard };
