/**
 * BoutiqFlow DZ — Idempotent Tenant & Trial Provisioning Service (INV-12-10, INV-12-11)
 * Coordinates tenant creation, owner registration, billing account setup, and trial onboarding
 * with full replay-safety to prevent duplicate records during network timeouts or rapid retries.
 */

const { generateUUIDv7 } = require('../db/utils');
const { hashPassword } = require('../auth/auth_service');
const { SUBSCRIPTION_STATUSES, TENANT_LIFECYCLE_STATES } = require('./constants');
const { SubscriptionService } = require('./subscription_service');
const { TenantLifecycleService } = require('./tenant_lifecycle_service');

class TenantProvisioningService {
  /**
   * Provisions a new boutique tenant idempotently (INV-12-10, INV-12-11)
   */
  static async provisionTenant(tx, {
    tenantId = null,
    tenantName,
    ownerName,
    email,
    phone,
    planCode = 'STARTER',
    trialDays = 14
  }) {
    if (!tenantName || !email) {
      throw new Error('Tenant provisioning requires tenantName and email');
    }

    const effectiveTenantId = tenantId || generateUUIDv7();

    // 1. Idempotency Check: Check if tenant already exists (INV-12-11)
    const existingTenants = await tx.query('tenants', t => t.id === effectiveTenantId || t.name === tenantName);
    if (existingTenants.length > 0) {
      const tenant = existingTenants[0];
      const subs = await tx.query('subscriptions', s => s.tenant_id === tenant.id);
      const owners = await tx.query('users', u => u.tenant_id === tenant.id && u.role === 'OWNER');

      return {
        replayed: true,
        tenant,
        owner: owners[0] || null,
        subscription: subs[0] || null,
        message: 'Tenant already provisioned idempotently (INV-12-11)'
      };
    }

    // 2. Create Tenant Record
    const tenantRecord = {
      id: effectiveTenantId,
      name: tenantName,
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    };
    await tx.insert('tenants', tenantRecord);

    // 3. Create Owner User
    const ownerId = generateUUIDv7();
    const ownerRecord = {
      id: ownerId,
      tenant_id: effectiveTenantId,
      name: ownerName || 'Propriétaire Boutique',
      email: email.toLowerCase(),
      phone: phone || '',
      role: 'OWNER',
      password_hash: hashPassword('InitialPass123!').hash,
      created_at: new Date().toISOString()
    };
    await tx.insert('users', ownerRecord);

    // 4. Create Billing Account
    const billingAccount = {
      id: generateUUIDv7(),
      tenant_id: effectiveTenantId,
      legal_name: tenantName,
      billing_email: email.toLowerCase(),
      billing_phone: phone || '',
      created_at: new Date().toISOString()
    };
    await tx.insert('billing_accounts', billingAccount);

    // 5. Create 14-Day Trial & Subscription (INV-12-10)
    const trialEndsAt = new Date(Date.now() + trialDays * 24 * 3600 * 1000).toISOString();
    const planVersionId = `${planCode.toUpperCase()}_V1`;

    const subscription = await SubscriptionService.createSubscription(tx, {
      tenantId: effectiveTenantId,
      planVersionId,
      planId: planCode.toUpperCase(),
      status: SUBSCRIPTION_STATUSES.TRIALING,
      trialEndsAt
    });

    const trialRecord = {
      id: generateUUIDv7(),
      tenant_id: effectiveTenantId,
      subscription_id: subscription.id,
      started_at: new Date().toISOString(),
      ends_at: trialEndsAt,
      source: 'DIRECT_SIGNUP',
      verification_status: 'VERIFIED',
      created_at: new Date().toISOString()
    };
    await tx.insert('trials', trialRecord);

    // 6. Set Lifecycle to ACTIVE
    await TenantLifecycleService.transitionLifecycle(tx, effectiveTenantId, TENANT_LIFECYCLE_STATES.ACTIVE, 'Initial trial provisioning');

    return {
      replayed: false,
      tenant: tenantRecord,
      owner: ownerRecord,
      billingAccount,
      subscription,
      trial: trialRecord
    };
  }
}

module.exports = {
  TenantProvisioningService
};
