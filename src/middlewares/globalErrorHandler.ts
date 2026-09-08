import { Prisma } from '@prisma/client';
import { ErrorRequestHandler } from 'express';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import { ZodError } from 'zod';
import { config } from '../config/env';
import { ApiError, ErrorDetail } from '../utils/ApiError';

interface NormalizedError {
  statusCode: number;
  message: string;
  errors: ErrorDetail[];
}

const handleZodError = (error: ZodError): NormalizedError => ({
  statusCode: StatusCodes.BAD_REQUEST,
  message: 'Validation failed',
  errors: error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  })),
});

const handlePrismaKnownError = (
  error: Prisma.PrismaClientKnownRequestError,
): NormalizedError => {
  switch (error.code) {
    case 'P2002': {
      // Unique constraint violation — surface which field collided.
      const target = (error.meta?.target as string[] | undefined) ?? [];
      const field = target.join(', ') || 'field';
      return {
        statusCode: StatusCodes.CONFLICT,
        message: `A record with this ${field} already exists`,
        errors: [{ path: field, message: `${field} must be unique` }],
      };
    }
    case 'P2025':
      return {
        statusCode: StatusCodes.NOT_FOUND,
        message: 'Requested record was not found',
        errors: [{ path: 'id', message: (error.meta?.cause as string) ?? 'Record not found' }],
      };
    case 'P2003': {
      const field = (error.meta?.field_name as string | undefined) ?? 'reference';
      return {
        statusCode: StatusCodes.BAD_REQUEST,
        message: 'Related record does not exist',
        errors: [{ path: field, message: `Invalid reference for ${field}` }],
      };
    }
    case 'P2028':
      // Interactive transaction expired - almost always lock contention under
      // load, which is retryable rather than a client mistake.
      return {
        statusCode: StatusCodes.SERVICE_UNAVAILABLE,
        message: 'The server is busy, please retry',
        errors: [{ path: 'transaction', message: 'Transaction timed out waiting on a lock' }],
      };
    case 'P2034':
      return {
        statusCode: StatusCodes.CONFLICT,
        message: 'Conflicting concurrent request, please retry',
        errors: [{ path: 'transaction', message: 'Write conflict or deadlock detected' }],
      };
    case 'P2014':
      return {
        statusCode: StatusCodes.BAD_REQUEST,
        message: 'Operation would violate an existing relation',
        errors: [{ path: 'relation', message: 'Dependent records must be removed first' }],
      };
    default:
      return {
        statusCode: StatusCodes.BAD_REQUEST,
        message: 'Database request failed',
        errors: [{ path: 'database', message: error.message.split('\n').pop()?.trim() ?? error.code }],
      };
  }
};

export const globalErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  let normalized: NormalizedError = {
    statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
    message: 'Something went wrong',
    errors: [],
  };

  if (error instanceof ZodError) {
    normalized = handleZodError(error);
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    normalized = handlePrismaKnownError(error);
  } else if (error instanceof Prisma.PrismaClientValidationError) {
    normalized = {
      statusCode: StatusCodes.BAD_REQUEST,
      message: 'Invalid data supplied to the database',
      errors: [{ path: 'body', message: 'One or more fields have the wrong type or are missing' }],
    };
  } else if (error instanceof TokenExpiredError) {
    normalized = {
      statusCode: StatusCodes.UNAUTHORIZED,
      message: 'Session expired, please log in again',
      errors: [{ path: 'token', message: 'Token has expired' }],
    };
  } else if (error instanceof JsonWebTokenError) {
    normalized = {
      statusCode: StatusCodes.UNAUTHORIZED,
      message: 'Invalid authentication token',
      errors: [{ path: 'token', message: 'Token could not be verified' }],
    };
  } else if (error instanceof ApiError) {
    normalized = {
      statusCode: error.statusCode,
      message: error.message,
      errors: error.errors,
    };
  } else if (error instanceof Error) {
    normalized = {
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      message: error.message || 'Something went wrong',
      errors: [],
    };
  }

  // Unexpected failures are worth a server-side trace; handled ones are not.
  if (normalized.statusCode >= 500) {
    console.error('[error]', error);
  }

  res.status(normalized.statusCode).json({
    success: false,
    message: normalized.message,
    errors: normalized.errors,
    ...(config.isProduction ? {} : { stack: (error as Error)?.stack }),
  });
};
