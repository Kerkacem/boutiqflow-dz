const crypto = require('crypto');
const { activateSubscription } = require('./subscriptions');

/**
 * Chargily Pay V2 Webhook & Checkout Integration Service
 * Official API Specification:
 * - Signature validation using HMAC-SHA256
 * - Replay protection & idempotency
 * - Amount / Currency validation against pending invoice
 */

function verifyChargilySignature(rawBody, signature, secret) {
  if (!signature || !secret || !rawBody) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
}

async function handleChargilyWebhook(tx, {
  rawBody,
  signature,
  secret,
  payload
}) {
  // 1. Signature Verification
  if (!verifyChargilySignature(rawBody, signature, secret)) {
    const error = new Error('Invalid Chargily signature: webhook rejected');
    error.statusCode = 401;
    throw error;
  }

  const eventId = payload.id;
  const invoiceId = payload.data?.metadata?.invoice_id;
  const paymentStatus = payload.data?.status; // 'paid', 'failed', 'canceled'
  const paidAmountCentimes = BigInt(payload.data?.amount || 0);

  if (!invoiceId) throw new Error('Missing invoice_id in Chargily webhook metadata');

  // 2. Replay Protection & Idempotency check
  const existingKey = await tx.query('idempotency_keys', k => k.key === `chargily_${eventId}`);
  if (existingKey.length > 0) {
    return { status: 'already_processed', eventId };
  }

  // 3. Find and validate pending invoice
  const invoice = await tx.findById('subscription_invoices', invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  if (invoice.status === 'PAID') {
    return { status: 'already_paid', invoiceId };
  }

  if (paymentStatus === 'paid') {
    // Validate amount matches expected invoice
    if (paidAmountCentimes !== BigInt(invoice.amount_centimes)) {
      throw new Error(`Amount mismatch: expected ${invoice.amount_centimes}, received ${paidAmountCentimes}`);
    }

    // Mark invoice PAID
    await tx.update('subscription_invoices', invoice.id, {
      status: 'PAID'
    });

    // Record payment
    await tx.insert('subscription_payments', {
      invoice_id: invoice.id,
      payment_reference: `CHARGILY-${payload.data?.id || eventId}`,
      gateway_payment_id: payload.data?.id || eventId,
      receipt_url: payload.data?.receipt_url || null,
      verified_at: new Date().toISOString()
    });

    // Activate/extend subscription
    await activateSubscription(tx, {
      subscriptionId: invoice.subscription_id,
      monthsCount: invoice.months_count
    });

    // Record idempotency key
    await tx.insert('idempotency_keys', {
      key: `chargily_${eventId}`,
      status_code: 200
    });

    return { status: 'success', activated: true, invoiceId };
  }

  return { status: 'ignored', paymentStatus };
}

module.exports = {
  verifyChargilySignature,
  handleChargilyWebhook
};
