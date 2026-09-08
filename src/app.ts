import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import { StatusCodes } from 'http-status-codes';
import { config } from './config/env';
import { prisma } from './config/prisma';
import { globalErrorHandler } from './middlewares/globalErrorHandler';
import { notFound } from './middlewares/notFound';
import routes from './routes';
import { sendResponse } from './utils/sendResponse';

const app: Application = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/', (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'DevAssess API is running',
    data: {
      name: 'Developer Assessment & Coding Platform',
      version: 'v1',
      docs: '/api/v1',
    },
  });
});

app.get('/health', async (_req: Request, res: Response) => {
  // A trivial query proves the pooled connection is actually reachable, which
  // a plain 200 would not.
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Service healthy',
    data: {
      status: 'ok',
      database: 'connected',
      latencyMs: Date.now() - startedAt,
      environment: config.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

app.use('/api/v1', routes);

app.use(notFound);
app.use(globalErrorHandler);

export default app;
