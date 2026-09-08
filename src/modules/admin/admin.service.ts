import { AttemptStatus, CreditTxType, PaymentStatus, Prisma, Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { cache, cacheKeys, TTL } from '../../utils/cache';
import { buildMeta, buildSearchCondition, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import {
  AuditLogQuery,
  CreditAdjustBody,
  ListUsersQuery,
  RoleBody,
  StatusBody,
} from './admin.validation';

interface Actor {
  id: string;
  email: string;
  role: Role;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const USER_SORTABLE_FIELDS = ['createdAt', 'updatedAt', 'name', 'email', 'role'] as const;

const listUsers = async (
  query: ListUsersQuery,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, USER_SORTABLE_FIELDS);

  const where: Prisma.UserWhereInput = {
    AND: [
      // Soft-deleted users stay hidden unless explicitly asked for, so the
      // default listing matches what "users" means to an operator.
      ...(query.includeDeleted ? [] : [{ deletedAt: null }]),
      ...buildSearchCondition<Prisma.UserWhereInput>(query.q, ['name', 'email']),
      ...(query.role ? [{ role: query.role }] : []),
      ...(query.isActive !== undefined ? [{ isActive: query.isActive }] : []),
    ],
  };

  const [total, users] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true, email: true, name: true, role: true, isActive: true,
        deletedAt: true, createdAt: true, avatarUrl: true,
        companyProfile: { select: { companyName: true } },
        candidateProfile: { select: { headline: true, experienceYears: true } },
        creditAccount: { select: { balance: true } },
        _count: { select: { assessments: true, attempts: true, problems: true } },
      },
    }),
  ]);

  return { data: users, meta: buildMeta(page, limit, total) };
};

/** Loads a user for a privileged action, refusing self-targeting. */
const loadTarget = async (userId: string, actor: Actor) => {
  if (userId === actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Administrators cannot modify their own account', [
      { path: 'id', message: 'Ask another administrator to make this change' },
    ]);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, isActive: true, deletedAt: true },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  return user;
};

/**
 * Changes a user's role, creating whatever side tables the new role needs.
 *
 * Promoting to COMPANY provisions a credit account in the same transaction, so
 * the invariant established at registration — no company without a balance row —
 * still holds for accounts that arrive at the role later.
 */
const changeRole = async (
  userId: string,
  input: RoleBody,
  actor: Actor,
  meta: ClientMeta,
): Promise<unknown> => {
  const target = await loadTarget(userId, actor);

  if (target.role === input.role) {
    throw new ApiError(StatusCodes.CONFLICT, `User is already a ${input.role}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (input.role === Role.COMPANY) {
      await tx.companyProfile.upsert({
        where: { userId },
        update: {},
        create: { userId, companyName: input.companyName ?? target.name },
      });
      await tx.creditAccount.upsert({ where: { companyId: userId }, update: {}, create: { companyId: userId } });
    }

    if (input.role === Role.CANDIDATE) {
      await tx.candidateProfile.upsert({ where: { userId }, update: {}, create: { userId } });
    }

    // A role change alters what every existing session is allowed to do, so
    // those sessions are ended rather than left carrying a stale claim.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return tx.user.update({
      where: { id: userId },
      data: { role: input.role },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
  });

  await logAudit({
    actorId: actor.id,
    action: 'ADMIN_CHANGED_USER_ROLE',
    entity: 'User',
    entityId: userId,
    before: { role: target.role },
    after: { role: input.role },
    ...meta,
  });

  await cache.del(cacheKeys.adminStats());
  return updated;
};

const changeStatus = async (
  userId: string,
  input: StatusBody,
  actor: Actor,
  meta: ClientMeta,
): Promise<unknown> => {
  const target = await loadTarget(userId, actor);

  if (target.isActive === input.isActive) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `User is already ${input.isActive ? 'active' : 'blocked'}`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (!input.isActive) {
      // Blocking must end current sessions, not merely prevent new ones.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return tx.user.update({
      where: { id: userId },
      data: { isActive: input.isActive },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
  });

  await logAudit({
    actorId: actor.id,
    action: input.isActive ? 'ADMIN_UNBLOCKED_USER' : 'ADMIN_BLOCKED_USER',
    entity: 'User',
    entityId: userId,
    before: { isActive: target.isActive },
    after: { isActive: input.isActive, reason: input.reason ?? null },
    ...meta,
  });

  await cache.del(cacheKeys.adminStats());
  return updated;
};

/** Soft delete: the row stays so attempts, payments and audit rows still resolve. */
const removeUser = async (userId: string, actor: Actor, meta: ClientMeta): Promise<void> => {
  const target = await loadTarget(userId, actor);

  if (target.deletedAt) {
    throw new ApiError(StatusCodes.CONFLICT, 'This user is already deleted');
  }

  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), isActive: false },
    });
  });

  await logAudit({
    actorId: actor.id,
    action: 'ADMIN_DELETED_USER',
    entity: 'User',
    entityId: userId,
    before: { email: target.email, role: target.role, deletedAt: null },
    after: { deletedAt: new Date().toISOString() },
    ...meta,
  });

  await cache.del(cacheKeys.adminStats());
};

/**
 * Manual credit grant or deduction — for support fixes and goodwill.
 *
 * Deductions use the same conditional guard as an invite spend, so an admin
 * cannot drive a balance negative by racing a company's own invitations.
 */
const adjustCredits = async (
  input: CreditAdjustBody,
  actor: Actor,
  meta: ClientMeta,
): Promise<unknown> => {
  const company = await prisma.user.findFirst({
    where: { id: input.companyId, role: Role.COMPANY, deletedAt: null },
    select: { id: true, email: true },
  });

  if (!company) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Company not found', [
      { path: 'companyId', message: 'No active company account with this id' },
    ]);
  }

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ balance: number }[]>`
      UPDATE credit_accounts
      SET balance = balance + ${input.amount},
          "totalPurchased" = "totalPurchased" + ${Math.max(0, input.amount)},
          "updatedAt" = NOW()
      WHERE "companyId" = ${input.companyId}
        AND balance + ${input.amount} >= 0
      RETURNING balance
    `;

    if (rows.length === 0) {
      const account = await tx.creditAccount.findUnique({
        where: { companyId: input.companyId },
        select: { balance: true },
      });

      if (!account) {
        throw new ApiError(StatusCodes.NOT_FOUND, 'This company has no credit account');
      }

      throw new ApiError(StatusCodes.CONFLICT, 'Adjustment would make the balance negative', [
        { path: 'amount', message: `Balance is ${account.balance}; cannot apply ${input.amount}` },
      ]);
    }

    const balanceAfter = rows[0].balance;

    await tx.creditTransaction.create({
      data: {
        companyId: input.companyId,
        type: CreditTxType.ADMIN_ADJUST,
        amount: input.amount,
        balanceAfter,
        description: input.reason,
        referenceId: actor.id,
      },
    });

    return { balanceAfter };
  });

  await logAudit({
    actorId: actor.id,
    action: 'ADMIN_ADJUSTED_CREDITS',
    entity: 'CreditAccount',
    entityId: input.companyId,
    after: { amount: input.amount, balanceAfter: result.balanceAfter, reason: input.reason },
    ...meta,
  });

  return { companyId: input.companyId, adjustment: input.amount, balanceAfter: result.balanceAfter };
};

const buildDashboardStats = async (): Promise<Record<string, unknown>> => {
  const [usersByRole, blocked, deleted, assessments, attempts, revenue, credits, problems] =
    await Promise.all([
      prisma.user.groupBy({ by: ['role'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.user.count({ where: { isActive: false, deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: { not: null } } }),
      prisma.assessment.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      prisma.attempt.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.payment.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { amountCents: true, credits: true },
        _count: { _all: true },
      }),
      prisma.creditAccount.aggregate({ _sum: { balance: true, totalConsumed: true } }),
      prisma.problem.count({ where: { deletedAt: null } }),
    ]);

  const roleCount = (role: Role): number =>
    usersByRole.find((row) => row.role === role)?._count._all ?? 0;

  const attemptCount = (status: AttemptStatus): number =>
    attempts.find((row) => row.status === status)?._count._all ?? 0;

  const finished = attemptCount(AttemptStatus.SUBMITTED) + attemptCount(AttemptStatus.EVALUATED);

  const passed = await prisma.attempt.count({
    where: { passed: true, status: { not: AttemptStatus.IN_PROGRESS } },
  });

  return {
    users: {
      total: usersByRole.reduce((sum, row) => sum + row._count._all, 0),
      candidates: roleCount(Role.CANDIDATE),
      companies: roleCount(Role.COMPANY),
      admins: roleCount(Role.ADMIN),
      blocked,
      softDeleted: deleted,
    },
    content: {
      problems,
      assessments: assessments.reduce((sum, row) => sum + row._count._all, 0),
      byStatus: Object.fromEntries(assessments.map((row) => [row.status, row._count._all])),
    },
    attempts: {
      total: attempts.reduce((sum, row) => sum + row._count._all, 0),
      inProgress: attemptCount(AttemptStatus.IN_PROGRESS),
      completed: finished,
      passed,
      failed: finished - passed,
      passRate: finished > 0 ? Math.round((passed / finished) * 10000) / 100 : 0,
    },
    revenue: {
      paidPayments: revenue._count._all,
      grossCents: revenue._sum.amountCents ?? 0,
      grossFormatted: `$${((revenue._sum.amountCents ?? 0) / 100).toFixed(2)}`,
      creditsSold: revenue._sum.credits ?? 0,
    },
    credits: {
      outstandingBalance: credits._sum.balance ?? 0,
      totalConsumed: credits._sum.totalConsumed ?? 0,
    },
    generatedAt: new Date().toISOString(),
  };
};

const getDashboardStats = async (): Promise<{ data: Record<string, unknown>; cached: boolean }> =>
  cache.wrap(cacheKeys.adminStats(), TTL.adminStats, buildDashboardStats);

const listAuditLogs = async (
  query: AuditLogQuery,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip } = resolvePagination(query, ['createdAt']);

  const where: Prisma.AuditLogWhereInput = {
    ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
    ...(query.entity ? { entity: query.entity } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  const [total, logs] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: query.sortOrder === 'asc' ? 'asc' : 'desc' },
      select: {
        id: true, action: true, entity: true, entityId: true,
        before: true, after: true, ip: true, userAgent: true, createdAt: true,
        actor: { select: { id: true, name: true, email: true, role: true } },
      },
    }),
  ]);

  return { data: logs, meta: buildMeta(page, limit, total) };
};

export const AdminService = {
  listUsers,
  changeRole,
  changeStatus,
  removeUser,
  adjustCredits,
  getDashboardStats,
  listAuditLogs,
};
