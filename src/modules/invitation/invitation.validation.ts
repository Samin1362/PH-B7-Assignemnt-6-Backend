import { z } from 'zod';

const createBody = z.object({
  emails: z
    .array(z.email('Provide valid email addresses').toLowerCase().trim())
    .min(1, 'Provide at least one email address')
    .max(50, 'At most 50 candidates can be invited at once'),
  expiresInDays: z
    .number()
    .int()
    .min(1, 'An invitation must be valid for at least 1 day')
    .max(90, 'An invitation cannot be valid for more than 90 days')
    .default(7),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'expiresAt', 'status', 'email']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']).optional(),
  q: z.string().trim().max(200).optional(),
});

const myQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'expiresAt', 'status']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']).optional(),
});

export const InvitationValidation = {
  create: { body: createBody, params: z.object({ id: z.uuid('Invalid assessment id') }) },
  list: { query: listQuery, params: z.object({ id: z.uuid('Invalid assessment id') }) },
  revoke: { params: z.object({ id: z.uuid('Invalid invitation id') }) },
  my: { query: myQuery },
};

export type CreateInvitationInput = z.infer<typeof createBody>;
export type ListInvitationQuery = z.infer<typeof listQuery>;
export type MyInvitationQuery = z.infer<typeof myQuery>;
