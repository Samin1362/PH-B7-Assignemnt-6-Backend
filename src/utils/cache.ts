import { isCacheEnabled, redis } from '../config/redis';

/** Namespaced so a flush of this app's keys cannot touch anything else. */
const PREFIX = 'devassess';

export const cacheKeys = {
  assessmentReport: (assessmentId: string): string => `${PREFIX}:report:${assessmentId}`,
  assessmentLeaderboard: (assessmentId: string): string =>
    `${PREFIX}:leaderboard:${assessmentId}`,
  adminStats: (): string => `${PREFIX}:admin:stats`,
  creditPacks: (): string => `${PREFIX}:credit-packs`,
};

export const TTL = {
  report: 120,
  leaderboard: 120,
  adminStats: 60,
  creditPacks: 300,
} as const;

/**
 * Every cache operation is best-effort. A Redis outage degrades the API to
 * "always compute", never to "return an error", so caching can never become a
 * new source of downtime.
 */
const safeGet = async <T>(key: string): Promise<T | null> => {
  if (!isCacheEnabled() || !redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    console.error('[cache] get failed:', (error as Error).message);
    return null;
  }
};

const safeSet = async (key: string, value: unknown, ttlSeconds: number): Promise<void> => {
  if (!isCacheEnabled() || !redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    console.error('[cache] set failed:', (error as Error).message);
  }
};

const safeDel = async (...keys: string[]): Promise<void> => {
  if (!isCacheEnabled() || !redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (error) {
    console.error('[cache] delete failed:', (error as Error).message);
  }
};

/**
 * Read-through cache. Returns the value plus whether it came from Redis, so
 * endpoints can report cache status and the behaviour is observable rather than
 * something you have to take on trust.
 */
const wrap = async <T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ data: T; cached: boolean }> => {
  const hit = await safeGet<T>(key);
  if (hit !== null) return { data: hit, cached: true };

  const data = await compute();
  await safeSet(key, data, ttlSeconds);
  return { data, cached: false };
};

/**
 * Called whenever an attempt is scored or re-scored. Reports and leaderboards
 * derive entirely from attempt data, so a write there must drop both.
 */
const invalidateAssessment = async (assessmentId: string): Promise<void> =>
  safeDel(
    cacheKeys.assessmentReport(assessmentId),
    cacheKeys.assessmentLeaderboard(assessmentId),
    cacheKeys.adminStats(),
  );

export const cache = { get: safeGet, set: safeSet, del: safeDel, wrap, invalidateAssessment };
