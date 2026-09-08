import { AssessmentStatus, CreditTxType, InvitationStatus, Prisma, Role } from '@prisma/client';
import crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { buildMeta, buildSearchCondition, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import {
  CreateInvitationInput,
  ListInvitationQuery,
  MyInvitationQuery,
} from './invitation.validation';

interface Actor {
  id: string;
  email: string;
  role: Role;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const INVITATION_SORTABLE_FIELDS = ['createdAt', 'expiresAt', 'status', 'email'] as const;

/** Opaque, high-entropy, and unique — this is what a candidate redeems. */
const generateToken = (): string => crypto.randomBytes(32).toString('hex');

const assertOwnsAssessment = async (assessmentId: string, actor: Actor) => {
  const assessment = await prisma.assessment.findFirst({
    where: { id: assessmentId, deletedAt: null },
    select: { id: true, companyId: true, status: true, title: true, endsAt: true },
  });

  if (!assessment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Assessment not found', [
      { path: 'id', message: 'No assessment exists with this id' },
    ]);
  }

  if (actor.role !== Role.ADMIN && assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only manage your own assessments', [
      { path: 'id', message: 'This assessment belongs to another company' },
    ]);
  }

  return assessment;
};

/**
 * Invites candidates, spending one credit each.
 *
 * The credit account row is locked with SELECT ... FOR UPDATE before the
 * balance is read, so two concurrent invite requests serialise on that row
 * instead of both reading the same balance and each believing they can afford
 * it. The lock is held until the transaction commits, which is what makes the
 * check-then-decrement safe.
 */
const create = async (
  assessmentId: string,
  input: CreateInvitationInput,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const assessment = await assertOwnsAssessment(assessmentId, actor);

  // Inviting to a draft would hand out links to something nobody can attempt.
  if (assessment.status !== AssessmentStatus.PUBLISHED) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `Candidates can only be invited to a PUBLISHED assessment`,
      [{ path: 'status', message: `This assessment is ${assessment.status}` }],
    );
  }

  const emails = [...new Set(input.emails.map((email) => email.toLowerCase().trim()))];

  // Accounts that exist but are not candidates cannot sit an assessment.
  const existingUsers = await prisma.user.findMany({
    where: { email: { in: emails }, deletedAt: null },
    select: { id: true, email: true, role: true },
  });

  const wrongRole = existingUsers.filter((user) => user.role !== Role.CANDIDATE);
  if (wrongRole.length > 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Some addresses belong to non-candidate accounts', [
      {
        path: 'emails',
        message: `Cannot invite: ${wrongRole.map((u) => `${u.email} (${u.role})`).join(', ')}`,
      },
    ]);
  }

  const candidateByEmail = new Map(existingUsers.map((user) => [user.email, user.id]));

  const alreadyInvited = await prisma.invitation.findMany({
    where: { assessmentId, email: { in: emails }, status: { not: InvitationStatus.REVOKED } },
    select: { email: true },
  });
  const skipped = new Set(alreadyInvited.map((invite) => invite.email));
  const toInvite = emails.filter((email) => !skipped.has(email));

  if (toInvite.length === 0) {
    throw new ApiError(StatusCodes.CONFLICT, 'Every address has already been invited', [
      { path: 'emails', message: `Already invited: ${[...skipped].join(', ')}` },
    ]);
  }

  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  const cost = toInvite.length;

  const result = await prisma.$transaction(
    async (tx) => {
      /*
       * Conditional decrement: the `balance >= cost` guard lives inside the
       * UPDATE, so the check and the deduction are one atomic statement rather
       * than a read followed by a write. Zero rows back means the balance was
       * insufficient at the instant the row lock was acquired.
       *
       * This replaces an explicit SELECT ... FOR UPDATE followed by a separate
       * UPDATE. Postgres still takes the row lock and still serialises
       * concurrent spenders, but the lock is now held across one round trip
       * instead of two - which matters because every extra round trip inside
       * the lock is time every other waiter spends queued.
       */
      const updated = await tx.$queryRaw<{ balance: number }[]>`
        UPDATE credit_accounts
        SET balance = balance - ${cost},
            "totalConsumed" = "totalConsumed" + ${cost},
            "updatedAt" = NOW()
        WHERE "companyId" = ${assessment.companyId}
          AND balance >= ${cost}
        RETURNING balance
      `;

      if (updated.length === 0) {
        const account = await tx.creditAccount.findUnique({
          where: { companyId: assessment.companyId },
          select: { balance: true },
        });

        if (!account) {
          throw new ApiError(StatusCodes.NOT_FOUND, 'No credit account found for this company');
        }

        throw new ApiError(
          StatusCodes.PAYMENT_REQUIRED,
          `Not enough credits: ${cost} needed, ${account.balance} available`,
          [
            {
              path: 'credits',
              message: `Purchase more credits at POST /api/v1/payments/checkout-session`,
            },
          ],
        );
      }

      const balanceAfter = updated[0].balance;

      await tx.invitation.createMany({
        data: toInvite.map((email) => ({
          assessmentId,
          email,
          candidateId: candidateByEmail.get(email) ?? null,
          invitedById: actor.id,
          token: generateToken(),
          expiresAt,
        })),
      });

      await tx.creditTransaction.create({
        data: {
          companyId: assessment.companyId,
          type: CreditTxType.CONSUME,
          amount: -cost,
          balanceAfter,
          description: `Invited ${cost} candidate(s) to "${assessment.title}"`,
          referenceId: assessmentId,
        },
      });

      return { balance: balanceAfter };
    },
    // Neon adds real latency per round trip, and holding a row lock serialises
    // every other spender behind this transaction, so the defaults (2s wait /
    // 5s run) are too tight for a burst of concurrent invites.
    { maxWait: 15000, timeout: 30000 },
  );

  // Written after commit: the CreditTransaction ledger is the authoritative
  // record of the spend, so the audit row is observability and does not need to
  // hold the balance lock open for another round trip.
  await logAudit({
    actorId: actor.id,
    action: 'INVITATIONS_SENT',
    entity: 'Assessment',
    entityId: assessmentId,
    after: { balance: result.balance, invited: toInvite, creditsSpent: cost },
    ...meta,
  });

  const created = await prisma.invitation.findMany({
    where: { assessmentId, email: { in: toInvite } },
    select: {
      id: true,
      email: true,
      token: true,
      status: true,
      expiresAt: true,
      candidateId: true,
    },
  });

  return {
    invited: created,
    creditsSpent: cost,
    balanceAfter: result.balance,
    skipped: [...skipped],
  };
};

const listForAssessment = async (
  assessmentId: string,
  query: ListInvitationQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  await assertOwnsAssessment(assessmentId, actor);
  const { page, limit, skip, orderBy } = resolvePagination(query, INVITATION_SORTABLE_FIELDS);

  const where: Prisma.InvitationWhereInput = {
    AND: [
      { assessmentId },
      ...buildSearchCondition<Prisma.InvitationWhereInput>(query.q, ['email']),
      ...(query.status ? [{ status: query.status }] : []),
    ],
  };

  const [total, invitations] = await prisma.$transaction([
    prisma.invitation.count({ where }),
    prisma.invitation.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true,
        email: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        createdAt: true,
        candidate: { select: { id: true, name: true } },
        attempt: { select: { id: true, status: true, totalScore: true } },
      },
    }),
  ]);

  return { data: invitations, meta: buildMeta(page, limit, total) };
};

/**
 * Revokes an unused invitation and refunds its credit in the same transaction.
 *
 * Only PENDING invitations refund: once a candidate has started, the credit has
 * bought what it was for and the attempt still needs to resolve.
 */
const revoke = async (
  invitationId: string,
  actor: Actor,
  meta: ClientMeta,
): Promise<Record<string, unknown>> => {
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { assessment: { select: { companyId: true, title: true } } },
  });

  if (!invitation) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Invitation not found', [
      { path: 'id', message: 'No invitation exists with this id' },
    ]);
  }

  if (actor.role !== Role.ADMIN && invitation.assessment.companyId !== actor.id) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You can only revoke your own invitations', [
      { path: 'id', message: 'This invitation belongs to another company' },
    ]);
  }

  if (invitation.status !== InvitationStatus.PENDING) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      `Only a PENDING invitation can be revoked`,
      [
        {
          path: 'status',
          message:
            invitation.status === InvitationStatus.ACCEPTED
              ? 'The candidate has already started this assessment'
              : `This invitation is ${invitation.status}`,
        },
      ],
    );
  }

  return prisma.$transaction(async (tx) => {
    /*
     * Claiming the invitation first is what makes the refund safe: only the
     * caller whose updateMany actually flipped PENDING -> REVOKED proceeds to
     * increment the balance, so two concurrent revokes cannot both refund.
     */
    const claimed = await tx.invitation.updateMany({
      where: { id: invitationId, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED, revokedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new ApiError(StatusCodes.CONFLICT, 'This invitation was already resolved', [
        { path: 'status', message: 'It is no longer PENDING' },
      ]);
    }

    const account = await tx.creditAccount.update({
      where: { companyId: invitation.assessment.companyId },
      data: { balance: { increment: 1 }, totalConsumed: { decrement: 1 } },
    });

    await tx.creditTransaction.create({
      data: {
        companyId: invitation.assessment.companyId,
        type: CreditTxType.REFUND,
        amount: 1,
        balanceAfter: account.balance,
        description: `Revoked invitation for ${invitation.email}`,
        referenceId: invitationId,
      },
    });

    await logAudit(
      {
        actorId: actor.id,
        action: 'INVITATION_REVOKED',
        entity: 'Invitation',
        entityId: invitationId,
        before: { status: InvitationStatus.PENDING, balance: account.balance - 1 },
        after: { status: InvitationStatus.REVOKED, balance: account.balance },
        ...meta,
      },
      tx,
    );

    return { invitationId, status: InvitationStatus.REVOKED, refunded: 1, balanceAfter: account.balance };
  });
};

/**
 * A candidate's own invitations, matched on the linked account or the address
 * they were invited by — an invite can be sent before the candidate registers.
 *
 * Expiry is reported as a computed flag rather than mutated on read, so a GET
 * stays a GET; the authoritative check happens when an attempt is started.
 */
const listMine = async (
  query: MyInvitationQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, [
    'createdAt',
    'expiresAt',
    'status',
  ]);

  const where: Prisma.InvitationWhereInput = {
    AND: [
      { OR: [{ candidateId: actor.id }, { email: actor.email }] },
      ...(query.status ? [{ status: query.status }] : []),
    ],
  };

  const [total, invitations] = await prisma.$transaction([
    prisma.invitation.count({ where }),
    prisma.invitation.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true,
        token: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        assessment: {
          select: {
            id: true,
            title: true,
            description: true,
            durationMinutes: true,
            passingScore: true,
            status: true,
            endsAt: true,
            company: { select: { id: true, name: true } },
            _count: { select: { problems: true } },
          },
        },
        attempt: { select: { id: true, status: true, submittedAt: true } },
      },
    }),
  ]);

  const now = Date.now();
  const data = invitations.map((invitation) => ({
    ...invitation,
    isExpired: invitation.expiresAt.getTime() < now,
    canStart:
      invitation.status === InvitationStatus.PENDING &&
      invitation.expiresAt.getTime() >= now &&
      invitation.assessment.status === AssessmentStatus.PUBLISHED &&
      !invitation.attempt,
  }));

  return { data, meta: buildMeta(page, limit, total) };
};

export const InvitationService = { create, listForAssessment, revoke, listMine };
