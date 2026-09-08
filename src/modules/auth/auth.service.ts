import { Prisma, Role, User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { StatusCodes } from 'http-status-codes';
import { verifyGoogleIdToken } from '../../config/google';
import { config } from '../../config/env';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import {
  createTokenPair,
  getTokenExpiry,
  hashToken,
  TokenPair,
  TokenPayload,
  verifyRefreshToken,
} from '../../utils/jwt';
import { ChangePasswordInput, GoogleInput, LoginInput, RegisterInput } from './auth.validation';

/** Shape returned to clients — never includes the password hash. */
const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarUrl: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const toPayload = (user: Pick<User, 'id' | 'email' | 'role'>): TokenPayload => ({
  sub: user.id,
  email: user.email,
  role: user.role,
});

/**
 * Issues a token pair and persists the refresh token's digest so it can be
 * revoked on logout or rotated on refresh.
 */
const issueTokens = async (
  user: Pick<User, 'id' | 'email' | 'role'>,
  meta: ClientMeta,
  tx?: Prisma.TransactionClient,
): Promise<TokenPair> => {
  const client = tx ?? prisma;
  const tokens = createTokenPair(toPayload(user));

  await client.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(tokens.refreshToken),
      expiresAt: getTokenExpiry(tokens.refreshToken),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });

  return tokens;
};

/**
 * Side-tables a new account needs. A COMPANY gets a profile and a credit
 * account in the same transaction as the user, so no company can ever exist
 * without the balance row that invitations lock.
 */
const roleScaffold = (
  role: Role,
  name: string,
  companyName?: string,
): Pick<Prisma.UserCreateInput, 'companyProfile' | 'candidateProfile' | 'creditAccount'> => {
  if (role === Role.COMPANY) {
    return {
      companyProfile: { create: { companyName: companyName ?? name } },
      creditAccount: { create: {} },
    };
  }
  return { candidateProfile: { create: {} } };
};

const register = async (input: RegisterInput, meta: ClientMeta): Promise<AuthResult> => {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existing) {
    throw new ApiError(StatusCodes.CONFLICT, 'An account with this email already exists', [
      { path: 'email', message: 'Email is already registered' },
    ]);
  }

  const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_SALT_ROUNDS);

  const { user, tokens } = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        password: passwordHash,
        role: input.role as Role,
        ...roleScaffold(input.role as Role, input.name, input.companyName),
      },
      select: publicUserSelect,
    });

    const issued = await issueTokens(created, meta, tx);

    await logAudit(
      {
        actorId: created.id,
        action: 'USER_REGISTERED',
        entity: 'User',
        entityId: created.id,
        after: { email: created.email, role: created.role },
        ...meta,
      },
      tx,
    );

    return { user: created, tokens: issued };
  });

  return { user, tokens };
};

const login = async (input: LoginInput, meta: ClientMeta): Promise<AuthResult> => {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // One message for both "no such user" and "wrong password" so the endpoint
  // cannot be used to enumerate registered emails.
  const invalid = new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid email or password', [
    { path: 'credentials', message: 'Email or password is incorrect' },
  ]);

  if (!user || user.deletedAt) throw invalid;

  if (!user.password) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This account uses Google sign-in', [
      { path: 'password', message: 'Sign in with Google, or set a password first' },
    ]);
  }

  const matches = await bcrypt.compare(input.password, user.password);
  if (!matches) throw invalid;

  if (!user.isActive) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Account is blocked', [
      { path: 'user', message: 'Contact an administrator to restore access' },
    ]);
  }

  const tokens = await issueTokens(user, meta);

  await logAudit({
    actorId: user.id,
    action: 'USER_LOGGED_IN',
    entity: 'User',
    entityId: user.id,
    ...meta,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive,
      createdAt: user.createdAt,
    },
    tokens,
  };
};

/**
 * Verifies a Google ID token, then links it to an existing account by email or
 * provisions a new one. Linking by email means a user who registered with a
 * password can later sign in with Google without creating a duplicate.
 */
const googleLogin = async (input: GoogleInput, meta: ClientMeta): Promise<AuthResult> => {
  const identity = await verifyGoogleIdToken(input.idToken);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ googleId: identity.googleId }, { email: identity.email }] },
  });

  if (existing) {
    if (existing.deletedAt) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Account no longer exists', [
        { path: 'user', message: 'This account has been removed' },
      ]);
    }
    if (!existing.isActive) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Account is blocked', [
        { path: 'user', message: 'Contact an administrator to restore access' },
      ]);
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        googleId: existing.googleId ?? identity.googleId,
        avatarUrl: existing.avatarUrl ?? identity.avatarUrl,
      },
      select: publicUserSelect,
    });

    const tokens = await issueTokens(user, meta);

    await logAudit({
      actorId: user.id,
      action: existing.googleId ? 'USER_LOGGED_IN_GOOGLE' : 'USER_LINKED_GOOGLE',
      entity: 'User',
      entityId: user.id,
      ...meta,
    });

    return { user, tokens };
  }

  const role = input.role as Role;

  const { user, tokens } = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: identity.email,
        googleId: identity.googleId,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        role,
        ...roleScaffold(role, identity.name, input.companyName),
      },
      select: publicUserSelect,
    });

    const issued = await issueTokens(created, meta, tx);

    await logAudit(
      {
        actorId: created.id,
        action: 'USER_REGISTERED_GOOGLE',
        entity: 'User',
        entityId: created.id,
        after: { email: created.email, role: created.role },
        ...meta,
      },
      tx,
    );

    return { user: created, tokens: issued };
  });

  return { user, tokens };
};

/**
 * Rotates the refresh token: the presented one is revoked and a fresh pair is
 * issued, so a stolen token is usable at most once before it stops working.
 */
const refresh = async (token: string, meta: ClientMeta): Promise<TokenPair> => {
  const payload = verifyRefreshToken(token);
  const tokenHash = hashToken(token);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, role: true, isActive: true, deletedAt: true } } },
  });

  if (!stored || stored.revokedAt) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Refresh token is no longer valid', [
      { path: 'refreshToken', message: 'Token was revoked or never issued' },
    ]);
  }

  if (stored.expiresAt < new Date()) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Refresh token has expired', [
      { path: 'refreshToken', message: 'Log in again to continue' },
    ]);
  }

  if (stored.user.deletedAt || !stored.user.isActive || stored.userId !== payload.sub) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Refresh token is no longer valid', [
      { path: 'refreshToken', message: 'Account is unavailable' },
    ]);
  }

  return prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return issueTokens(stored.user, meta, tx);
  });
};

const logout = async (token: string | undefined, userId: string): Promise<{ revoked: number }> => {
  // With a token, drop that one session; without, drop every session.
  if (token) {
    const result = await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count };
};

const changePassword = async (
  userId: string,
  input: ChangePasswordInput,
  meta: ClientMeta,
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  if (!user.password) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'This account has no password set', [
      { path: 'currentPassword', message: 'Account was created through Google sign-in' },
    ]);
  }

  const matches = await bcrypt.compare(input.currentPassword, user.password);
  if (!matches) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Current password is incorrect', [
      { path: 'currentPassword', message: 'Password does not match our records' },
    ]);
  }

  const passwordHash = await bcrypt.hash(input.newPassword, config.BCRYPT_SALT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { password: passwordHash } });

    // Any session opened with the old password is no longer trustworthy.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await logAudit(
      { actorId: userId, action: 'PASSWORD_CHANGED', entity: 'User', entityId: userId, ...meta },
      tx,
    );
  });
};

export const AuthService = {
  register,
  login,
  googleLogin,
  refresh,
  logout,
  changePassword,
};
