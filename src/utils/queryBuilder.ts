import { PaginationMeta } from './sendResponse';

export const PAGINATION = {
  defaultPage: 1,
  defaultLimit: 10,
  maxLimit: 100,
} as const;

export type SortOrder = 'asc' | 'desc';

export interface PaginationInput {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
}

export interface ResolvedPagination {
  page: number;
  limit: number;
  skip: number;
  orderBy: Record<string, SortOrder>;
}

/**
 * Turns validated query params into Prisma's skip/take/orderBy.
 *
 * `sortBy` is constrained to a whitelist at the Zod layer, but the fallback
 * here is a second line of defence: an unrecognised field can never reach
 * `orderBy`, where Prisma would throw at runtime on user-controlled input.
 */
export const resolvePagination = (
  input: PaginationInput,
  allowedSortFields: readonly string[],
  defaultSortBy = 'createdAt',
): ResolvedPagination => {
  const page = Math.max(1, input.page ?? PAGINATION.defaultPage);
  const limit = Math.min(Math.max(1, input.limit ?? PAGINATION.defaultLimit), PAGINATION.maxLimit);

  const sortBy =
    input.sortBy && allowedSortFields.includes(input.sortBy) ? input.sortBy : defaultSortBy;
  const sortOrder: SortOrder = input.sortOrder === 'asc' ? 'asc' : 'desc';

  return { page, limit, skip: (page - 1) * limit, orderBy: { [sortBy]: sortOrder } };
};

export const buildMeta = (page: number, limit: number, total: number): PaginationMeta => ({
  page,
  limit,
  total,
  totalPage: Math.max(1, Math.ceil(total / limit)),
});

/**
 * Case-insensitive OR across the given text columns. Returns an empty array
 * when there is no search term, so it can be spread into an AND list without
 * the caller branching.
 */
export const buildSearchCondition = <T>(
  term: string | undefined,
  fields: readonly string[],
): T[] => {
  const trimmed = term?.trim();
  if (!trimmed) return [];

  return [
    {
      OR: fields.map((field) => ({
        [field]: { contains: trimmed, mode: 'insensitive' },
      })),
    } as T,
  ];
};

/** Drops undefined entries so absent filters do not narrow the query. */
export const buildExactFilters = <T>(filters: Record<string, unknown>): T[] =>
  Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([field, value]) => ({ [field]: value }) as T);

/** Parses `?tags=a,b,c` into a trimmed, de-duplicated list. */
export const parseCsv = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const items = [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
};
