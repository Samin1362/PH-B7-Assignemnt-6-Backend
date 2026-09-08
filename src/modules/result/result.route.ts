import { Router } from 'express';
import { Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { ResultService } from './result.service';

const idParams = z.object({ id: z.uuid('Invalid id') });
const leaderboardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Mounted at /attempts/:id/result — readable by the candidate and the company. */
const attemptResult = Router({ mergeParams: true });
attemptResult.get(
  '/',
  auth(),
  validateRequest({ params: idParams }),
  catchAsync(async (req, res) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Result retrieved successfully',
      data: await ResultService.getAttemptResult(req.params.id, req.user!),
    });
  }),
);

/** Mounted at /assessments/:id — company analytics. */
const assessmentAnalytics = Router({ mergeParams: true });

assessmentAnalytics.get(
  '/report',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest({ params: idParams }),
  catchAsync(async (req, res) => {
    const { data, cached } = await ResultService.getReport(req.params.id, req.user!);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: `Report retrieved successfully${cached ? ' (from cache)' : ''}`,
      data: { ...data, cached },
    });
  }),
);

assessmentAnalytics.get(
  '/leaderboard',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest({ params: idParams, query: leaderboardQuery }),
  catchAsync(async (req, res) => {
    const query = (req.validatedQuery ?? req.query) as z.infer<typeof leaderboardQuery>;
    const { data, cached } = await ResultService.getLeaderboard(
      req.params.id,
      query.limit ?? 20,
      req.user!,
    );
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: `Leaderboard retrieved successfully${cached ? ' (from cache)' : ''}`,
      data: { ...data, cached },
    });
  }),
);

export const AttemptResultRoutes = attemptResult;
export const AssessmentAnalyticsRoutes = assessmentAnalytics;
