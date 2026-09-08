import { Prisma } from '@prisma/client';

/**
 * The only user shape that leaves the service layer. Declaring it as a `select`
 * rather than deleting fields afterwards means the password hash is never even
 * fetched from the database.
 */
export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
