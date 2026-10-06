const { generateUUIDv7 } = require('../db/utils');
const { activateSubscription } = require('./subscriptions');
const { logAuditEvent, AUDIT_ACTIONS } = require('../audit/audit_service');

/**
 * Manual Subscription Billing Service (CCP / BaridiMob)
 */

async function createManualSubscriptionOrder(tx, {
  subscriptionId,
  planId,
  monthsCount = 1
}) {
  const plan = tx.db.tables.plans.get(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const amountCentimes = BigInt(plan.monthly_price_centimes) * BigInt(monthsCount);
  const invoiceNumber = `FAC-MAHAL-${Date.now().toString().slice(-6)}`;

  const invoice = await tx.insert('subscription_invoices', {
    subscription_id: subscriptionId,
    invoice_number: invoiceNumber,
    amount_centimes: amountCentimes,
    payment_method: 'MANUAL_BARIDIMOB',
    status: 'PENDING',
    months_count: monthsCount
  });

  return {
    invoiceId: invoice.id,
    invoiceNumber,
    amountCentimes,
    ccpAccount: '0012345678 Clé 99',
    baridiMobRip: '00799999001234567899',
    instructions: `Effectuez le virement CCP ou BaridiMob de ${amountCentimes / 100n} DA et mentionnez la référence ${invoiceNumber}`
  };
}

async function submitPaymentReceipt(tx, { invoiceId, paymentReference, receiptUrl }) {
  const invoice = await tx.findById('subscription_invoices', invoiceId);
  if (!invoice || invoice.status !== 'PENDING') {
    throw new Error('Invoice not found or already processed');
  }

  const payment = await tx.insert('subscription_payments', {
    invoice_id: invoiceId,
    payment_reference: paymentReference,
    receipt_url: receiptUrl
  });

  return { submitted: true, paymentId: payment.id };
}

async function approveManualPayment(tx, { invoiceId, superAdminUserId }) {
  const invoice = await tx.findById('subscription_invoices', invoiceId);
  if (!invoice || invoice.status !== 'PENDING') {
    throw new Error('Invoice not found or not in pending state');
  }

  await tx.update('subscription_invoices', invoice.id, {
    status: 'PAID'
  });

  // Activate subscription
  await activateSubscription(tx, {
    subscriptionId: invoice.subscription_id,
    monthsCount: invoice.months_count
  });

  // Log audit trail
  await logAuditEvent(tx, {
    action: AUDIT_ACTIONS.PAYMENT_APPROVAL,
    entityType: 'subscription_invoices',
    entityId: invoice.id,
    metadata: {
      super_admin_id: superAdminUserId,
      amount: invoice.amount_centimes
    }
  });

  return { approved: true, invoiceId: invoice.id };
}

module.exports = {
  createManualSubscriptionOrder,
  submitPaymentReceipt,
  approveManualPayment
};
