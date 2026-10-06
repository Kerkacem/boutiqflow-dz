const { logAuditEvent, AUDIT_ACTIONS } = require('../audit/audit_service');

/**
 * Super-Admin & Tenant Portability / Deletion Subsystem (UAT-16)
 * Enforces strict justification and audit logging for any super-admin access.
 */

async function exportTenantData(tx) {
  const tenantId = tx.session.tenantId;

  // Retrieve complete tenant dataset
  const products = await tx.query('products');
  const variants = await tx.query('product_variants');
  const stockLevels = await tx.query('stock_levels');
  const stockMovements = await tx.query('stock_movements');
  const sales = await tx.query('sales');
  const saleItems = await tx.query('sale_items');
  const customers = await tx.query('customers');
  const customerLedger = await tx.query('customer_ledger');
  const expenses = await tx.query('expenses');

  // Log export action in audit log
  await logAuditEvent(tx, {
    action: AUDIT_ACTIONS.DATA_EXPORT,
    entityType: 'tenants',
    entityId: tenantId,
    metadata: {
      exportedTablesCount: 9,
      timestamp: new Date().toISOString()
    }
  });

  return {
    tenantId,
    exportDate: new Date().toISOString(),
    catalog: { products, variants },
    inventory: { stockLevels, stockMovements },
    sales: { sales, saleItems },
    customers: { customers, customerLedger },
    finance: { expenses }
  };
}

/**
 * Initiates 30-day soft deletion retention window (UAT-16)
 */
async function initiateTenantDeletion(tx, reason = 'Owner requested account closure') {
  const tenantId = tx.session.tenantId;
  const now = new Date();
  const scheduledDate = new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();

  const subscriptions = await tx.query('subscriptions');
  for (const s of subscriptions) {
    await tx.update('subscriptions', s.id, {
      status: 'SUSPENDED',
      scheduled_deletion_at: scheduledDate
    });
  }

  return {
    tenantId,
    status: 'SCHEDULED_FOR_DELETION',
    scheduledDeletionDate: scheduledDate,
    retentionDays: 30,
    reason
  };
}

/**
 * Super-Admin Impersonation with mandatory audited justification (Privacy Boundary)
 */
async function startSuperAdminImpersonation(tx, { superAdminId, targetTenantId, reason }) {
  if (!superAdminId || !targetTenantId || !reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('Super-admin impersonation strictly requires superAdminId, targetTenantId, and an audited justification reason');
  }

  await logAuditEvent(tx, {
    action: AUDIT_ACTIONS.IMPERSONATION_START,
    entityType: 'tenants',
    entityId: targetTenantId,
    metadata: {
      super_admin_id: superAdminId,
      reason: reason.trim()
    }
  });

  return {
    impersonating: true,
    targetTenantId,
    startedAt: new Date().toISOString()
  };
}

module.exports = {
  exportTenantData,
  initiateTenantDeletion,
  startSuperAdminImpersonation
};
