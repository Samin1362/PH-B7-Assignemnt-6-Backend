import { Router } from 'express';

const router = Router();

/**
 * Module routers are registered here as each phase lands, so `app.ts` never
 * changes again and route ownership stays in one readable table.
 */
const moduleRoutes: { path: string; route: Router }[] = [];

moduleRoutes.forEach(({ path, route }) => router.use(path, route));

export default router;
