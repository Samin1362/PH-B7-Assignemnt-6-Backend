import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../config/prisma';

type PrismaTx = Prisma.TransactionClient;

export interface AuditInput {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** Pulls client metadata off the request for the audit trail. */
export const requestContext = (req: Request): { ip: string | null; userAgent: string | null } => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

/**
 * Writes one audit row. Pass `tx` when the log must commit or roll back with
 * the mutation it describes; omit it for standalone events.
 *
 * Never rejects: a failed audit write must not fail the operation it records.
 */
export const logAudit = async (input: AuditInput, tx?: PrismaTx): Promise<void> => {
  const client = tx ?? prisma;
  try {
    await client.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: (input.before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (input.after ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error('[audit] failed to write log', { action: input.action, error });
  }
};
