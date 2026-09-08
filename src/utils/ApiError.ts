export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The single error type thrown by services. Carrying the status code and the
 * structured `errors[]` on the throw site means the global handler never has to
 * guess how a failure should surface to the client.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errors: ErrorDetail[];

  constructor(statusCode: number, message: string, errors: ErrorDetail[] = [], stack = '') {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
