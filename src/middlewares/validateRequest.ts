import { RequestHandler } from 'express';
import { ZodType } from 'zod';

/**
 * Parses body/query/params against a Zod schema and writes the parsed result
 * back, so controllers receive coerced, trimmed, defaulted values rather than
 * raw strings. Failures fall through to the global handler as a ZodError.
 */
export const validateRequest = (schema: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}): RequestHandler => {
  return async (req, _res, next) => {
    try {
      if (schema.body) req.body = await schema.body.parseAsync(req.body);
      if (schema.params) req.params = (await schema.params.parseAsync(req.params)) as never;
      if (schema.query) {
        // Express 5 makes req.query a getter; assign onto a shadow property.
        const parsedQuery = await schema.query.parseAsync(req.query);
        Object.defineProperty(req, 'validatedQuery', { value: parsedQuery, writable: true });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};
