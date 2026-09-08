import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { constructWebhookEvent } from '../../config/stripe';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { PaymentService } from './payment.service';
import { ListPaymentQuery } from './payment.validation';

const listPacks = catchAsync(async (_req, res) => {
  const data = await PaymentService.listPacks();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Credit packs retrieved successfully',
    data,
  });
});

const createCheckoutSession = catchAsync(async (req, res) => {
  const data = await PaymentService.createCheckoutSession(
    req.body.packId,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Checkout session created. Complete payment at checkoutUrl.',
    data,
  });
});

/**
 * Receives Stripe events. `req.body` here is a raw Buffer, not parsed JSON —
 * the route is mounted before the JSON parser precisely so the bytes Stripe
 * signed are the bytes we verify.
 *
 * Not wrapped in catchAsync: a verification failure must return 400 to Stripe
 * rather than travelling through the generic error handler, and every other
 * outcome is acknowledged with 200 so Stripe stops retrying an event we have
 * already reasoned about.
 */
const webhook = async (req: Request, res: Response): Promise<void> => {
  let result: { status: string; detail?: string };

  try {
    const event = constructWebhookEvent(
      req.body as Buffer,
      req.headers['stripe-signature'] as string | undefined,
    );
    result = await PaymentService.handleWebhookEvent(event);
    console.log(`[stripe] ${event.type} → ${result.status}${result.detail ? `: ${result.detail}` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed';
    console.error('[stripe] webhook rejected:', message);
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message,
      errors: [{ path: 'webhook', message }],
    });
    return;
  }

  res.status(StatusCodes.OK).json({ received: true, ...result });
};

const listPayments = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as ListPaymentQuery;
  const { data, meta } = await PaymentService.listPayments(query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Payments retrieved successfully',
    meta,
    data,
  });
});

const getPaymentById = catchAsync(async (req, res) => {
  const data = await PaymentService.getPaymentById(req.params.id, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Payment retrieved successfully',
    data,
  });
});

/** Stripe redirects the browser here; there is no UI, so we answer in JSON. */
const success = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Payment completed. Credits are granted once the webhook is processed.',
    data: { sessionId: req.query.session_id ?? null },
  });
});

const cancel = catchAsync(async (_req, res) => {
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Checkout was cancelled. No payment was taken.',
  });
});

export const PaymentController = {
  listPacks,
  createCheckoutSession,
  webhook,
  listPayments,
  getPaymentById,
  success,
  cancel,
};
