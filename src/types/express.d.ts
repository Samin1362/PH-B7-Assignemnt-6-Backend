import { Role } from '@prisma/client';

/** Identity attached by the auth middleware after a Bearer token verifies. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Result of a Zod query schema — req.query itself is read-only in some setups. */
      validatedQuery?: unknown;
    }
  }
}

export {};
