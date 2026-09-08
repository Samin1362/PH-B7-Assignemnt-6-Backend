import { CreditTxType, PaymentStatus, Prisma, Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import Stripe from 'stripe';
import { config } from '../../config/env';
import { prisma } from '../../config/prisma';
import { getStripe } from '../../config/stripe';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { buildMeta, resolvePagination } from '../../utils/queryBuilder';
import { PaginationMeta } from '../../utils/sendResponse';
import { ListPaymentQuery } from './payment.validation';

interface Actor {
  id: string;
  email: string;
  role: Role;
}

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

const PAYMENT_SORTABLE_FIELDS = ['createdAt', 'amountCents', 'status', 'paidAt'] as const;

const listPacks = async (): Promise<unknown[]> =>
  prisma.creditPack.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      credits: true,
      priceCents: true,
      currency: true,
      description: true,
    },
  });

/**
 * Creates a Stripe Checkout Session and records a PENDING payment against it.
 *
 * Credits are deliberately NOT granted here. The row exists only so the webhook
 * has something to reconcile against; nothing is credited until Stripe tells us
 * the money actually moved.
 */
const createCheckoutSession = async (
  packId: string,
  actor: Actor,
  meta: ClientMeta,
): Promise<{ paymentId: string; sessionId: string; checkoutUrl: string | null; amountCents: number; credits: number }> => {
  const pack = await prisma.creditPack.findFirst({ where: { id: packId, isActive: true } });

  if (!pack) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Credit pack not found', [
      { path: 'packId', message: 'No active credit pack exists with this id' },
    ]);
  }

  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: actor.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: pack.currency,
          unit_amount: pack.priceCents,
          product_data: {
            name: `${pack.name} — ${pack.credits} invitation credits`,
            description: pack.description ?? undefined,
          },
        },
      },
    ],
    success_url: `${config.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: config.STRIPE_CANCEL_URL,
    client_reference_id: actor.id,
    // Echoed back on the webhook, so fulfilment never has to trust the client.
    metadata: {
      companyId: actor.id,
      packId: pack.id,
      credits: String(pack.credits),
    },
  });

  const payment = await prisma.payment.create({
    data: {
      companyId: actor.id,
      packId: pack.id,
      stripeSessionId: session.id,
      amountCents: pack.priceCents,
      currency: pack.currency,
      credits: pack.credits,
      status: PaymentStatus.PENDING,
    },
  });

  await logAudit({
    actorId: actor.id,
    action: 'PAYMENT_SESSION_CREATED',
    entity: 'Payment',
    entityId: payment.id,
    after: { packId: pack.id, credits: pack.credits, amountCents: pack.priceCents },
    ...meta,
  });

  return {
    paymentId: payment.id,
    sessionId: session.id,
    checkoutUrl: session.url,
    amountCents: pack.priceCents,
    credits: pack.credits,
  };
};

/**
 * Grants credits for a completed checkout.
 *
 * Idempotency is a compare-and-swap: the PENDING → PAID update is scoped to
 * rows still in PENDING, and a zero row count means another delivery of the
 * same event already won. Stripe retries webhooks, and may deliver the same
 * event more than once, so this has to hold under genuine concurrency rather
 * than merely re-reading the row first.
 */
const fulfilCheckout = async (
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
): Promise<{ status: string; detail?: string }> => {
  const payment = await prisma.payment.findUnique({ where: { stripeSessionId: session.id } });

  if (!payment) {
    // A session we never recorded — nothing to reconcile. Acknowledge so Stripe
    // stops retrying rather than hammering us forever.
    return { status: 'ignored', detail: 'No local payment matches this session' };
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        stripePaymentIntentId: paymentIntentId,
        rawEvent: event as unknown as Prisma.InputJsonValue,
      },
    });

    if (claimed.count === 0) {
      return { status: 'duplicate', detail: 'This session was already fulfilled' };
    }

    const account = await tx.creditAccount.update({
      where: { companyId: payment.companyId },
      data: {
        balance: { increment: payment.credits },
        totalPurchased: { increment: payment.credits },
      },
    });

    await tx.creditTransaction.create({
      data: {
        companyId: payment.companyId,
        type: CreditTxType.PURCHASE,
        amount: payment.credits,
        balanceAfter: account.balance,
        description: `Purchased ${payment.credits} credits`,
        referenceId: session.id,
        paymentId: payment.id,
      },
    });

    await logAudit(
      {
        actorId: payment.companyId,
        action: 'PAYMENT_COMPLETED',
        entity: 'Payment',
        entityId: payment.id,
        before: { status: PaymentStatus.PENDING, balance: account.balance - payment.credits },
        after: { status: PaymentStatus.PAID, balance: account.balance },
      },
      tx,
    );

    return { status: 'fulfilled', detail: `Granted ${payment.credits} credits` };
  });
};

/** Terminal non-success outcomes. No credits move; the row records why. */
const markUnsuccessful = async (
  sessionId: string,
  status: PaymentStatus,
  reason: string,
  event: Stripe.Event,
): Promise<{ status: string; detail?: string }> => {
  const updated = await prisma.payment.updateMany({
    where: { stripeSessionId: sessionId, status: PaymentStatus.PENDING },
    data: { status, failureReason: reason, rawEvent: event as unknown as Prisma.InputJsonValue },
  });

  if (updated.count === 0) {
    return { status: 'ignored', detail: 'No pending payment matched this session' };
  }

  await logAudit({
    action: `PAYMENT_${status}`,
    entity: 'Payment',
    entityId: sessionId,
    after: { status, reason },
  });

  return { status: 'recorded', detail: `Payment marked ${status}` };
};

/** Routes a verified Stripe event to the right handler. */
const handleWebhookEvent = async (event: Stripe.Event): Promise<{ status: string; detail?: string }> => {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // `paid` covers cards that complete asynchronously.
      if (session.payment_status !== 'paid') {
        return { status: 'ignored', detail: `payment_status is ${session.payment_status}` };
      }
      return fulfilCheckout(event, session);
    }

    case 'checkout.session.expired':
      return markUnsuccessful(
        (event.data.object as Stripe.Checkout.Session).id,
        PaymentStatus.EXPIRED,
        'Checkout session expired before completion',
        event,
      );

    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const sessions = await getStripe().checkout.sessions.list({ payment_intent: intent.id, limit: 1 });
      const sessionId = sessions.data[0]?.id;
      if (!sessionId) return { status: 'ignored', detail: 'No checkout session for this intent' };

      return markUnsuccessful(
        sessionId,
        PaymentStatus.FAILED,
        intent.last_payment_error?.message ?? 'Payment failed',
        event,
      );
    }

    default:
      return { status: 'ignored', detail: `Unhandled event type ${event.type}` };
  }
};

const listPayments = async (
  query: ListPaymentQuery,
  actor: Actor,
): Promise<{ data: unknown[]; meta: PaginationMeta }> => {
  const { page, limit, skip, orderBy } = resolvePagination(query, PAYMENT_SORTABLE_FIELDS);

  const where: Prisma.PaymentWhereInput = {
    ...(actor.role === Role.ADMIN ? {} : { companyId: actor.id }),
    ...(query.status ? { status: query.status } : {}),
  };

  const [total, payments] = await prisma.$transaction([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true,
        amountCents: true,
        currency: true,
        credits: true,
        status: true,
        paidAt: true,
        failureReason: true,
        createdAt: true,
        stripeSessionId: true,
        pack: { select: { id: true, name: true, credits: true } },
        company: { select: { id: true, name: true } },
      },
    }),
  ]);

  return { data: payments, meta: buildMeta(page, limit, total) };
};

const getPaymentById = async (id: string, actor: Actor): Promise<unknown> => {
  const payment = await prisma.payment.findFirst({
    where: { id, ...(actor.role === Role.ADMIN ? {} : { companyId: actor.id }) },
    select: {
      id: true,
      amountCents: true,
      currency: true,
      credits: true,
      status: true,
      paidAt: true,
      failureReason: true,
      createdAt: true,
      stripeSessionId: true,
      stripePaymentIntentId: true,
      pack: { select: { id: true, name: true, credits: true } },
      creditTransactions: {
        select: { id: true, type: true, amount: true, balanceAfter: true, createdAt: true },
      },
    },
  });

  if (!payment) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Payment not found', [
      { path: 'id', message: 'No payment exists with this id, or it belongs to another company' },
    ]);
  }

  return payment;
};

export const PaymentService = {
  listPacks,
  createCheckoutSession,
  handleWebhookEvent,
  listPayments,
  getPaymentById,
};
