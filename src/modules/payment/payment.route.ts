import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { PaymentController } from './payment.controller';
import { PaymentValidation } from './payment.validation';

const router = Router();

// Stripe redirect targets — public, since the browser arrives without a token.
router.get('/success', PaymentController.success);
router.get('/cancel', PaymentController.cancel);

// NOTE: POST /payments/webhook is mounted directly in app.ts, ahead of the JSON
// body parser, so Stripe's signature can be verified against the raw bytes.

router.get('/', auth(Role.COMPANY, Role.ADMIN), validateRequest(PaymentValidation.list), PaymentController.listPayments);
router.post(
  '/checkout-session',
  auth(Role.COMPANY),
  validateRequest(PaymentValidation.checkout),
  PaymentController.createCheckoutSession,
);
router.get(
  '/:id',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(PaymentValidation.byId),
  PaymentController.getPaymentById,
);

export const PaymentRoutes = router;

/**
 * Mounted separately at /credit-packs. The catalogue is readable by any
 * authenticated user so a company can see prices before committing to a role.
 */
const packRouter = Router();
packRouter.get('/', auth(), PaymentController.listPacks);

export const CreditPackRoutes = packRouter;
