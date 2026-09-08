import { z } from 'zod';

const checkoutBody = z.object({
  packId: z.uuid('Provide a valid credit pack id'),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'amountCents', 'status', 'paidAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED']).optional(),
});

const idParams = z.object({ id: z.uuid('Invalid payment id') });

export const PaymentValidation = {
  checkout: { body: checkoutBody },
  list: { query: listQuery },
  byId: { params: idParams },
};

export type ListPaymentQuery = z.infer<typeof listQuery>;
