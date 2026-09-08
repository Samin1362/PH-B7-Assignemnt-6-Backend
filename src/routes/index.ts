import { Router } from 'express';
import { AssessmentRoutes } from '../modules/assessment/assessment.route';
import {
  AssessmentAttemptRoutes,
  AttemptRoutes,
  SubmissionRoutes,
} from '../modules/attempt/attempt.route';
import { AuthRoutes } from '../modules/auth/auth.route';
import { CreditRoutes } from '../modules/credit/credit.route';
import {
  AssessmentInvitationRoutes,
  InvitationRoutes,
} from '../modules/invitation/invitation.route';
import { CreditPackRoutes, PaymentRoutes } from '../modules/payment/payment.route';
import { ProblemRoutes } from '../modules/problem/problem.route';
import { UserRoutes } from '../modules/user/user.route';

const router = Router();

/**
 * Module routers are registered here as each phase lands, so `app.ts` never
 * changes again and route ownership stays in one readable table.
 */
const moduleRoutes: { path: string; route: Router }[] = [
  { path: '/auth', route: AuthRoutes },
  { path: '/users', route: UserRoutes },
  { path: '/problems', route: ProblemRoutes },
  // Registered before /assessments so the nested path wins the match.
  { path: '/assessments/:id/invitations', route: AssessmentInvitationRoutes },
  { path: '/assessments/:id/attempts', route: AssessmentAttemptRoutes },
  { path: '/assessments', route: AssessmentRoutes },
  { path: '/invitations', route: InvitationRoutes },
  { path: '/attempts', route: AttemptRoutes },
  { path: '/submissions', route: SubmissionRoutes },
  { path: '/credit-packs', route: CreditPackRoutes },
  { path: '/payments', route: PaymentRoutes },
  { path: '/credits', route: CreditRoutes },
];

moduleRoutes.forEach(({ path, route }) => router.use(path, route));

export default router;
