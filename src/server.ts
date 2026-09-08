import { Server } from 'http';
import app from './app';
import { config } from './config/env';
import { prisma } from './config/prisma';

let server: Server;

async function bootstrap(): Promise<void> {
  await prisma.$connect();
  console.log('[db] connected');

  server = app.listen(config.PORT, () => {
    console.log(`[server] listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
  });
}

/** Close the HTTP listener and the pool before exiting so Neon frees the slot. */
const shutdown = async (reason: string): Promise<void> => {
  console.log(`[server] shutting down: ${reason}`);
  server?.close(() => console.log('[server] http closed'));
  await prisma.$disconnect();
  process.exit(reason === 'SIGTERM' || reason === 'SIGINT' ? 0 : 1);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('[unhandledRejection]', error);
  void shutdown('unhandledRejection');
});
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
  void shutdown('uncaughtException');
});

bootstrap().catch((error) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});
