/**
 * Vercel serverless entry point.
 *
 * Exports the Express app without calling listen(): on Vercel each invocation
 * is handed a request directly, and binding a port would be both unnecessary
 * and wrong. `src/server.ts` remains the entry for running locally.
 *
 * The import is guarded because anything that throws while the module graph
 * loads - a missing environment variable, a Prisma client that was not
 * generated - crashes the function before Express exists. Vercel then reports
 * only FUNCTION_INVOCATION_FAILED, which says nothing about the cause.
 *
 * The fallback deliberately uses plain Node http APIs rather than Express
 * helpers: it runs precisely when Express failed to load, so it cannot depend
 * on anything Express adds to the response object.
 */
import type { IncomingMessage, ServerResponse } from 'http';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  handler = require('../src/app').default as Handler;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error('[boot] the application failed to start:', message);
  if (stack) console.error(stack);

  handler = (_req, res) => {
    const body = JSON.stringify({
      success: false,
      message: 'Server failed to start',
      errors: [{ path: 'startup', message }],
      hint: 'Check this deployment’s environment variables, then redeploy so the new values are picked up.',
    });

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
  };
}

export default handler;
