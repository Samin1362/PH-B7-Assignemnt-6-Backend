import { Role } from '@prisma/client';
import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { CreditService } from './credit.service';

const router = Router();

const ledgerQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'amount', 'type']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  type: z.enum(['PURCHASE', 'CONSUME', 'REFUND', 'ADMIN_ADJUST']).optional(),
});

router.get(
  '/balance',
  auth(Role.COMPANY),
  catchAsync(async (req, res) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Credit balance retrieved successfully',
      data: await CreditService.getBalance(req.user!.id),
    });
  }),
);

router.get(
  '/transactions',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest({ query: ledgerQuery }),
  catchAsync(async (req, res) => {
    const query = (req.validatedQuery ?? req.query) as z.infer<typeof ledgerQuery>;
    const { data, meta } = await CreditService.listTransactions(query, req.user!);

    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Credit transactions retrieved successfully',
      meta,
      data,
    });
  }),
);

export const CreditRoutes = router;
