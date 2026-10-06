/**
 * BoutiqFlow DZ — Payment Service & Webhook Integrity (INV-12-06, INV-12-07, INV-12-08, INV-12-28, Critical Test 60)
 * Validates expected invoice totals, currencies, idempotency keys, and ensures webhook replays produce zero duplicate credits.
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');
const {
  PAYMENT_STATUSES,
  INVOICE_STATUSES,
  SUBSCRIPTION_STATUSES,
  BILLING_ERRORS
} = require('./constants');
const { SubscriptionService } = require('./subscription_service');
const { EntitlementEngine } = require('./entitlement_engine');

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

class PaymentService {
  /**
   * Initiates a payment attempt with strict idempotency key enforcement (INV-12-08)
   */
  static async createPaymentAttempt(tx, {
    invoiceId,
    amountCents,
    currency = 'DZD',
    paymentMethod = 'EDAHABIA_CIB',
    idempotencyKey = null
  }) {
    const tenantId = tx.session.tenantId;

    if (!invoiceId) throw new Error('invoiceId is required');
    const invoice = await tx.findById('invoices', invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    const payloadNormalized = {
      invoiceId,
      amountCents: String(amountCents),
      currency: currency.toUpperCase(),
      paymentMethod
    };
    const reqHash = hashPayload(payloadNormalized);

    if (idempotencyKey) {
      const existing = await tx.query('payment_attempts', a =>
        a.tenant_id === tenantId && a.idempotency_key === idempotencyKey
      );

      if (existing.length > 0) {
        const prev = existing[0];
        if (prev.request_hash !== reqHash) {
          const err = new Error('Idempotency Conflict: Same key submitted with different payload (INV-12-08)');
          err.code = BILLING_ERRORS.IDEMPOTENCY_PAYLOAD_MISMATCH;
          err.statusCode = 409;
          throw err;
        }
        return {
          replayed: true,
          attempt: prev
        };
      }
    }

    const attemptId = `ATT-${crypto.randomUUID().slice(0, 8)}`;
    const attemptRecord = {
      id: attemptId,
      tenant_id: tenantId,
      invoice_id: invoiceId,
      amount_cents: BigInt(amountCents),
      currency: currency.toUpperCase(),
      payment_method: paymentMethod,
      idempotency_key: idempotencyKey,
      request_hash: reqHash,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };

    await tx.insert('payment_attempts', attemptRecord);

    return {
      replayed: false,
      attempt: attemptRecord
    };
  }

  /**
   * Processes an incoming payment webhook with deduplication and amount verification (Critical Test 60)
   */
  static async processPaymentWebhook(tx, {
    provider = 'CHARGILY',
    externalEventId,
    payload = {}
  }) {
    const tenantId = tx.session.tenantId;

    if (!externalEventId) {
      throw new Error('Payment webhook requires externalEventId');
    }

    // 1. Webhook Deduplication Check (INV-12-06)
    const existingEvents = await tx.query('billing_provider_events', e =>
      e.provider === provider && e.external_event_id === externalEventId
    );

    if (existingEvents.length > 0) {
      return {
        replayed: true,
        status: 'ALREADY_PROCESSED',
        message: 'Payment webhook replayed idempotently (INV-12-06)'
      };
    }

    // 2. Identify Invoice
    const invoiceId = payload.invoiceId || payload.metadata?.invoiceId;
    const invoiceNumber = payload.invoiceNumber || payload.metadata?.invoiceNumber;

    let invoice = null;
    if (invoiceId) {
      invoice = await tx.findById('invoices', invoiceId);
    }
    if (!invoice && invoiceNumber) {
      const invs = await tx.query('invoices', i => i.tenant_id === tenantId && i.invoice_number === invoiceNumber);
      if (invs.length > 0) invoice = invs[0];
    }

    if (!invoice) {
      throw new Error(`Invoice not found for payment payload (invoiceId: ${invoiceId}, invoiceNumber: ${invoiceNumber})`);
    }

    // 3. Strict Amount and Currency Verification (INV-12-07, INV-12-28, Critical Test 60)
    const incomingAmount = BigInt(payload.amountCents !== undefined ? payload.amountCents : payload.amount);
    const incomingCurrency = (payload.currency || 'DZD').toUpperCase();

    const expectedAmount = BigInt(invoice.total_cents);
    const expectedCurrency = invoice.currency.toUpperCase();

    if (incomingAmount !== expectedAmount || incomingCurrency !== expectedCurrency) {
      // Record mismatch event in billing_provider_events without activating subscription (INV-12-07)
      await tx.insert('billing_provider_events', {
        id: generateUUIDv7(),
        tenant_id: tenantId,
        provider,
        external_event_id: externalEventId,
        event_type: 'PAYMENT_MISMATCH',
        status: 'REJECTED_MISMATCH',
        received_at: new Date().toISOString(),
        processed_at: new Date().toISOString()
      });

      const err = new Error(`Payment Mismatch: Received ${incomingAmount} ${incomingCurrency}, expected ${expectedAmount} ${expectedCurrency} (INV-12-07)`);
      err.code = BILLING_ERRORS.PAYMENT_MISMATCH;
      err.statusCode = 400;
      err.expectedAmount = expectedAmount;
      err.incomingAmount = incomingAmount;
      throw err;
    }

    // 4. Record Payment Success
    const paymentId = generateUUIDv7();
    const paymentNumber = `PAY-${Date.now()}`;

    const paymentRecord = {
      id: paymentId,
      tenant_id: tenantId,
      invoice_id: invoice.id,
      payment_number: paymentNumber,
      amount_cents: incomingAmount,
      currency: incomingCurrency,
      status: PAYMENT_STATUSES.SUCCEEDED,
      payment_method: payload.paymentMethod || 'EDAHABIA_CIB',
      provider,
      provider_payment_id: payload.providerPaymentId || externalEventId,
      created_at: new Date().toISOString()
    };

    await tx.insert('payments', paymentRecord);

    // 5. Update Invoice status to PAID
    await tx.update('invoices', invoice.id, {
      status: INVOICE_STATUSES.PAID,
      paid_at: new Date().toISOString()
    });

    // 6. Transition Subscription to ACTIVE
    if (invoice.subscription_id) {
      await SubscriptionService.transitionStatus(tx, invoice.subscription_id, SUBSCRIPTION_STATUSES.ACTIVE, {
        reason: 'PAYMENT_SUCCEEDED',
        actorId: 'billing_webhook'
      });
    }

    // 7. Record Deduplication Entry
    await tx.insert('billing_provider_events', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      provider,
      external_event_id: externalEventId,
      event_type: 'PAYMENT_SUCCEEDED',
      status: 'PROCESSED',
      received_at: new Date().toISOString(),
      processed_at: new Date().toISOString()
    });

    // Invalidate cache immediately
    EntitlementEngine.invalidateTenantCache(tenantId);

    return {
      replayed: false,
      status: 'PROCESSED',
      paymentId,
      invoiceId: invoice.id,
      amountCents: incomingAmount
    };
  }
}

module.exports = {
  PaymentService
};
