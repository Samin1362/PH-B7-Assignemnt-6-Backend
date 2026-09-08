import { PrismaClient } from '@prisma/client';
import { config } from './env';

/**
 * On Vercel every cold start would otherwise open a fresh pool, and hot reloads
 * in dev leak clients on each save. Caching on globalThis keeps exactly one
 * client per process in both environments.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}
