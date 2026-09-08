import Redis from 'ioredis';
import { config } from './env';

/**
 * Reused across hot reloads and Vercel invocations, the same way the Prisma
 * client is, so a burst of requests does not open a connection each.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis | null };

const create = (): Redis | null => {
  if (!config.features.redis) return null;

  const client = new Redis(config.REDIS_URL as string, {
    // A slow cache must never become a slow API: two retries then fail, so a
    // caller falls through to the database instead of waiting on Redis.
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // Commands issued before the socket is ready are queued rather than
    // rejected. The rate limiter initialises its store at boot, which happens
    // before the connection settles; without the queue that init fails
    // permanently and the limiter silently stops limiting. maxRetriesPerRequest
    // still bounds how long a queued command can hang if Redis is truly down.
    enableOfflineQueue: true,
    lazyConnect: true,
  });

  // Without a listener, a connection error would be an unhandled 'error' event
  // and take the process down.
  client.on('error', (error) => {
    console.error('[redis] connection error:', error.message);
  });

  client.connect().catch((error) => {
    console.error('[redis] initial connect failed:', error.message);
  });

  return client;
};

export const redis: Redis | null = globalForRedis.redis ?? create();

if (!config.isProduction) {
  globalForRedis.redis = redis;
}

export const isCacheEnabled = (): boolean => redis !== null && redis.status === 'ready';
