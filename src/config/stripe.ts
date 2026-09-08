import { StatusCodes } from 'http-status-codes';
import Stripe from 'stripe';
import { ApiError } from '../utils/ApiError';
import { config } from './env';

const client = config.features.stripe
  ? new Stripe(config.STRIPE_SECRET_KEY as string, { typescript: true })
  : null;

/**
 * Stripe is optional at boot so the rest of the API runs without a key, but any
 * route that actually needs it fails loudly rather than dereferencing null.
 */
export const getStripe = (): Stripe => {
  if (!client) {
    throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, 'Payments are not configured', [
      { path: 'STRIPE_SECRET_KEY', message: 'Set STRIPE_SECRET_KEY to enable payments' },
    ]);
  }
  return client;
};

/**
 * Verifies the `stripe-signature` header against the raw request body. This is
 * the only thing standing between the webhook and anyone who can POST to it, so
 * an unset signing secret is treated as a hard failure, never as "skip check".
 */
export const constructWebhookEvent = (payload: Buffer, signature: string | undefined): Stripe.Event => {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, 'Webhook secret is not configured', [
      { path: 'STRIPE_WEBHOOK_SECRET', message: 'Set STRIPE_WEBHOOK_SECRET to accept webhooks' },
    ]);
  }

  if (!signature) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Missing stripe-signature header', [
      { path: 'stripe-signature', message: 'Request did not carry a Stripe signature' },
    ]);
  }

  try {
    return getStripe().webhooks.constructEvent(payload, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Webhook signature verification failed', [
      { path: 'stripe-signature', message: (error as Error).message },
    ]);
  }
};
