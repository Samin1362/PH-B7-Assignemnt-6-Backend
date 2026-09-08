import { z } from 'zod';

const listUsersQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'email', 'role']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  q: z.string().trim().max(200).optional(),
  role: z.enum(['CANDIDATE', 'COMPANY', 'ADMIN']).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const auditLogQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  action: z.string().trim().max(100).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const roleBody = z.object({
  role: z.enum(['CANDIDATE', 'COMPANY', 'ADMIN'], {
    error: 'role must be CANDIDATE, COMPANY or ADMIN',
  }),
  companyName: z.string().trim().min(2).max(150).optional(),
});

const statusBody = z.object({
  isActive: z.boolean({ error: 'isActive must be true or false' }),
  reason: z.string().trim().max(500).optional(),
});

const creditAdjustBody = z.object({
  companyId: z.uuid('Provide a valid company id'),
  amount: z
    .number()
    .int('Credits are whole numbers')
    .refine((v) => v !== 0, 'Amount cannot be zero'),
  reason: z
    .string({ error: 'A reason is required for every manual credit adjustment' })
    .trim()
    .min(3, 'Give a reason for the adjustment')
    .max(500),
});

export const AdminValidation = {
  listUsers: { query: listUsersQuery },
  auditLogs: { query: auditLogQuery },
  changeRole: { body: roleBody, params: z.object({ id: z.uuid('Invalid user id') }) },
  changeStatus: { body: statusBody, params: z.object({ id: z.uuid('Invalid user id') }) },
  removeUser: { params: z.object({ id: z.uuid('Invalid user id') }) },
  adjustCredits: { body: creditAdjustBody },
};

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type AuditLogQuery = z.infer<typeof auditLogQuery>;
export type RoleBody = z.infer<typeof roleBody>;
export type StatusBody = z.infer<typeof statusBody>;
export type CreditAdjustBody = z.infer<typeof creditAdjustBody>;
