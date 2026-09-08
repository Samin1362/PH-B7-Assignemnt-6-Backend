/**
 * Vercel serverless entry point.
 *
 * Exports the Express app without calling listen(): on Vercel each invocation
 * is handed a request directly, and binding a port would be both unnecessary
 * and wrong. `src/server.ts` remains the entry for running locally.
 */
import app from '../src/app';

export default app;
