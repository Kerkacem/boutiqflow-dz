/**
 * Audit Logging Service for BoutiqFlow DZ
 * Records security-sensitive and operational events.
 * Enforces append-only semantics and safe BigInt serialization.
 */

const AUDIT_ACTIONS = {
  // Authentication & Session
  AUTH_LOGIN_SUCCESS: 'auth:login_success',
  AUTH_LOGIN_FAILURE: 'auth:login_failure',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_PASSWORD_CHANGE: 'auth:password_change',

  // Administrative & Membership
  ROLE_CHANGE: 'auth:role_change',
  MEMBER_ADDED: 'tenant:member_added',
  MEMBER_REMOVED: 'tenant:member_removed',
  PERMISSION_CHANGE: 'permission:change',
  PERMISSION_DENIED: 'auth:permission_denied',

  // Security & Boundary Violations
  SUSPICIOUS_CROSS_TENANT_ATTEMPT: 'security:suspicious_cross_tenant_attempt',
  PII_ACCESS_EMERGENCY: 'privacy:pii_access_emergency',

  // Business Operational Auditing
  PRICE_CHANGE: 'price:change',
  DISCOUNT_OVERRIDE: 'discount:override',
  SALE_VOID: 'sale:void',
  STOCK_ADJUSTMENT: 'stock:adjustment',
  DATA_EXPORT: 'data:export',
  IMPERSONATION_START: 'impersonation:start',
  PAYMENT_APPROVAL: 'payment:approval'
};

function safeJsonStringify(obj) {
  if (!obj) return null;
  return JSON.stringify(obj, (key, value) => {
    return typeof value === 'bigint' ? value.toString() : value;
  });
}

async function logAuditEvent(tx, { action, entityType, entityId, metadata }) {
  if (!tx || !tx.session || !tx.session.tenantId) {
    throw new Error('Audit log requires active tenant transaction session');
  }

  const record = {
    tenant_id: tx.session.tenantId,
    user_id: tx.session.userId || null,
    action,
    entity_type: entityType,
    entity_id: entityId || null,
    metadata: safeJsonStringify(metadata),
    created_at: new Date().toISOString()
  };

  return await tx.insert('audit_logs', record);
}

module.exports = {
  AUDIT_ACTIONS,
  safeJsonStringify,
  logAuditEvent
};
