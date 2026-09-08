import { Role } from '@prisma/client';
import { RequestHandler } from 'express';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../config/prisma';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/jwt';

/**
 * Verifies the Bearer token and, when roles are supplied, enforces them.
 *
 * The user row is re-read on every request rather than trusted from the token
 * payload, so blocking or soft-deleting an account takes effect immediately
 * instead of lingering until the access token expires.
 */
export const auth = (...allowedRoles: Role[]): RequestHandler => {
  return async (req, _res, next) => {
    try {
      const header = req.headers.authorization;

      if (!header?.startsWith('Bearer ')) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, 'Authentication required', [
          { path: 'authorization', message: 'Provide a Bearer token in the Authorization header' },
        ]);
      }

      const token = header.slice(7).trim();
      const payload = verifyAccessToken(token);

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, role: true, isActive: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new ApiError(StatusCodes.UNAUTHORIZED, 'Account no longer exists', [
          { path: 'user', message: 'This account has been removed' },
        ]);
      }

      if (!user.isActive) {
        throw new ApiError(StatusCodes.FORBIDDEN, 'Account is blocked', [
          { path: 'user', message: 'Contact an administrator to restore access' },
        ]);
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        throw new ApiError(
          StatusCodes.FORBIDDEN,
          'You do not have permission to perform this action',
          [
            {
              path: 'role',
              message: `Requires role: ${allowedRoles.join(' or ')}. Your role is ${user.role}.`,
            },
          ],
        );
      }

      req.user = { id: user.id, email: user.email, role: user.role };
      next();
    } catch (error) {
      next(error);
    }
  };
};
