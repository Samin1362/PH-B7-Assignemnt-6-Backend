import { RequestHandler } from 'express';
import { StatusCodes } from 'http-status-codes';

export const notFound: RequestHandler = (req, res) => {
  res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
    errors: [{ path: req.originalUrl, message: 'This endpoint does not exist' }],
  });
};
