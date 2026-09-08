import { z } from 'zod';

/** ADMIN is intentionally absent — privilege is granted, never self-selected. */
const selfServiceRole = z.enum(['CANDIDATE', 'COMPANY']);

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const registerBody = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
    email: z.email('Provide a valid email address').toLowerCase().trim(),
    password,
    role: selfServiceRole.default('CANDIDATE'),
    companyName: z.string().trim().min(2).max(150).optional(),
  })
  .superRefine((data, ctx) => {
    // A company account is meaningless without the company it represents.
    if (data.role === 'COMPANY' && !data.companyName) {
      ctx.addIssue({
        code: 'custom',
        path: ['companyName'],
        message: 'companyName is required when registering as a COMPANY',
      });
    }
  });

const loginBody = z.object({
  email: z.email('Provide a valid email address').toLowerCase().trim(),
  password: z.string().min(1, 'Password is required'),
});

const googleBody = z.object({
  idToken: z.string().min(1, 'idToken is required'),
  role: selfServiceRole.default('CANDIDATE'),
  companyName: z.string().trim().min(2).max(150).optional(),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1).optional(),
});

const changePasswordBody = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current password',
  });

export const AuthValidation = {
  register: { body: registerBody },
  login: { body: loginBody },
  google: { body: googleBody },
  refresh: { body: refreshBody },
  changePassword: { body: changePasswordBody },
};

export type RegisterInput = z.infer<typeof registerBody>;
export type LoginInput = z.infer<typeof loginBody>;
export type GoogleInput = z.infer<typeof googleBody>;
export type ChangePasswordInput = z.infer<typeof changePasswordBody>;
