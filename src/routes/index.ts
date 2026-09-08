import { Router } from 'express';
import { AuthRoutes } from '../modules/auth/auth.route';

const router = Router();

/**
 * Module routers are registered here as each phase lands, so `app.ts` never
 * changes again and route ownership stays in one readable table.
 */
const moduleRoutes: { path: string; route: Router }[] = [
  { path: '/auth', route: AuthRoutes },
];

moduleRoutes.forEach(({ path, route }) => router.use(path, route));

export default router;
