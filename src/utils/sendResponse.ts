import { Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPage: number;
}

export interface ApiResponse<T> {
  statusCode: number;
  success: boolean;
  message: string;
  data?: T;
  meta?: PaginationMeta;
}

/**
 * The one place a success response is shaped. Every controller routes through
 * this so the mandated `{ success, message, data }` contract cannot drift.
 */
export const sendResponse = <T>(res: Response, payload: ApiResponse<T>): void => {
  const body: Record<string, unknown> = {
    success: payload.success,
    message: payload.message,
  };

  if (payload.meta !== undefined) body.meta = payload.meta;
  if (payload.data !== undefined) body.data = payload.data;

  res.status(payload.statusCode).json(body);
};
