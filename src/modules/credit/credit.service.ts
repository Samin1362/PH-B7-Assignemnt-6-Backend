import { Prisma, Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { buildMeta, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';

interface Actor {
  id: string;
  role: Role;
}

const LEDGER_SORTABLE_FIELDS = ['createdAt', 'amount', 'type'] as const;

const getBalance = async (companyId: string): Promise<unknown> => {
  const account = await prisma.creditAccount.findUnique({
    where: { companyId },
    select: { balance: true, totalPurchased: true, totalConsumed: true, updatedAt: true },
  });

  if (!account) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'No credit account found for this company');
  }

  return account;
};

const listTransactions = async (
  query: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'asc' | 'desc'; type?: string },
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, LEDGER_SORTABLE_FIELDS);

  const where: Prisma.CreditTransactionWhereInput = {
    ...(actor.role === Role.ADMIN ? {} : { companyId: actor.id }),
    ...(query.type ? { type: query.type as Prisma.EnumCreditTxTypeFilter['equals'] } : {}),
  };

  const [total, transactions] = await prisma.$transaction([
    prisma.creditTransaction.count({ where }),
    prisma.creditTransaction.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true,
        type: true,
        amount: true,
        balanceAfter: true,
        description: true,
        referenceId: true,
        paymentId: true,
        createdAt: true,
      },
    }),
  ]);

  return { data: transactions, meta: buildMeta(page, limit, total) };
};

export const CreditService = { getBalance, listTransactions };
