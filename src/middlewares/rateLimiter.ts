import { RequestHandler } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import { StatusCodes } from 'http-status-codes';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config/env';
import { redis } from '../config/redis';

const windowMs = config.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;

/**
 * Redis-backed when available so the limit is shared across every serverless
 * instance — an in-memory counter on Vercel would let each cold start hand out
 * a fresh quota, which is barely a limit at all.
 *
 * Falls back to the in-memory store when Redis is not configured: a weaker
 * limit is better than no limit.
 */
const buildStore = (prefix: string): Options['store'] | undefined => {
  const client = redis;
  if (!client) return undefined;

  return new RedisStore({
    prefix: `devassess:rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<never>,
  });
};

const limitHandler = (message: string): Options['handler'] =>
  (req, res) => {
    res.status(StatusCodes.TOO_MANY_REQUESTS).json({
      success: false,
      message,
      errors: [
        {
          path: 'rateLimit',
          message: `Try again after ${config.RATE_LIMIT_WINDOW_MINUTES} minutes`,
        },
      ],
    });
  };

/** Applied to the whole API. */
export const globalLimiter: RequestHandler = rateLimit({
  windowMs,
  limit: config.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('global'),
  // Fail open. If Redis is unreachable the limiter cannot count, and refusing
  // every request would turn a cache outage into a full outage - strictly worse
  // than a temporarily unenforced limit.
  passOnStoreError: true,
  handler: limitHandler('Too many requests from this IP'),
  // Health checks are for uptime monitors, which poll far more often than a
  // user ever would.
  skip: (req) => req.path === '/health' || req.path === '/',
});

/**
 * Much tighter, and applied only to the credential-accepting routes: these are
 * what a password-guessing attack actually targets.
 */
export const authLimiter: RequestHandler = rateLimit({
  windowMs,
  limit: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('auth'),
  passOnStoreError: true,
  handler: limitHandler('Too many authentication attempts from this IP'),
  // A successful login is not an attack, so only failures count toward the cap.
  skipSuccessfulRequests: true,
});
