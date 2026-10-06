const fs = require('fs');
const { generateUUIDv7 } = require('./utils');

/**
 * Mahal Multi-Tenant Database Client with PostgreSQL Row-Level Security (RLS) Simulation
 * Enforces dual-layer tenant isolation:
 * Layer 1: Application-layer tenant scoping via withTenant(context, callback)
 * Layer 2: Simulated PostgreSQL FORCE ROW LEVEL SECURITY checks on every read/write
 */

const PROTECTED_INVENTORY_TABLES = new Set([
  'stock_levels',
  'stock_movements',
  'stock_reservations',
  'stock_transfers'
]);

class MahalDatabase {
  constructor(options = {}) {
    this.persistencePath = options.persistencePath || null;
    this.tables = {
      tenants: new Map(),
      tenant_settings: new Map(),
      users: new Map(),
      sessions: new Map(),
      categories: new Map(),
      brands: new Map(),
      suppliers: new Map(),
      supplier_contacts: new Map(),
      purchase_orders: new Map(),
      purchase_lines: new Map(),
      purchase_receipts: new Map(),
      purchase_receipt_lines: new Map(),
      purchase_returns: new Map(),
      purchase_return_lines: new Map(),
      supplier_invoices: new Map(),
      supplier_payments: new Map(),
      customers: new Map(),
      customer_ledger: new Map(),
      inventory_locations: new Map(),
      products: new Map(),
      product_variants: new Map(),
      idempotency_keys: new Map(),
      stock_levels: new Map(),
      stock_movements: new Map(),
      stock_reservations: new Map(),
      stock_transfers: new Map(),
      stocktake_sessions: new Map(),
      stocktake_items: new Map(),
      cash_registers: new Map(),
      register_sessions: new Map(),
      cash_sessions: new Map(),
      cash_transactions: new Map(),
      sales: new Map(),
      sale_items: new Map(),
      sale_payments: new Map(),
      refunds: new Map(),
      refund_lines: new Map(),
      courier_accounts: new Map(),
      online_orders: new Map(),
      order_items: new Map(),
      order_call_attempts: new Map(),
      cod_confirmations: new Map(),
      confirmation_attempts: new Map(),
      shipments: new Map(),
      cod_remittances: new Map(),
      delivery_provider_accounts: new Map(),
      provider_events: new Map(),
      shipment_events: new Map(),
      shipment_items: new Map(),
      courier_collections: new Map(),
      courier_settlements: new Map(),
      shipment_returns: new Map(),
      transfer_records: new Map(),
      delivery_geo_references: new Map(),
      devices: new Map(),
      processed_operations: new Map(),
      offline_stock_allowances: new Map(),
      sync_conflicts: new Map(),
      local_outbox: new Map(),
      expense_categories: new Map(),
      expenses: new Map(),
      income_entries: new Map(),
      financial_entries: new Map(),
      plans: new Map(),
      subscriptions: new Map(),
      subscription_invoices: new Map(),
      subscription_payments: new Map(),
      audit_logs: new Map(),
      processing_register: new Map(),
      processing_journal: new Map(),
      breach_register: new Map(),
      print_jobs: new Map(),
      unmapped_items: new Map(),
      daily_sales_summaries: new Map(),
      daily_profit_summaries: new Map(),
      inventory_summaries: new Map(),
      report_snapshots: new Map(),
      reporting_events_log: new Map(),
      integrations: new Map(),
      integration_credentials: new Map(),
      integration_mappings: new Map(),
      integration_events: new Map(),
      integration_outbox: new Map(),
      public_api_keys: new Map(),
      public_idempotency_keys: new Map(),
      webhook_subscriptions: new Map(),
      outbound_webhook_deliveries: new Map(),
      processing_activities: new Map(),
      privacy_roles: new Map(),
      retention_policies: new Map(),
      legal_holds: new Map(),
      privacy_requests: new Map(),
      privacy_request_audits: new Map(),
      dpia_records: new Map(),
      dpia_risks: new Map(),
      subprocessors: new Map(),
      dpa_records: new Map(),
      consent_records: new Map(),
      privacy_notices: new Map(),
      tracking_technologies: new Map(),
      backup_records: new Map(),
      compliance_evidence_exports: new Map(),
      privacy_support_sessions: new Map(),
      security_incidents: new Map(),
      plan_versions: new Map(),
      subscription_changes: new Map(),
      trials: new Map(),
      phone_verifications: new Map(),
      tenant_lifecycles: new Map(),
      billing_accounts: new Map(),
      invoices: new Map(),
      invoice_lines: new Map(),
      credit_notes: new Map(),
      payments: new Map(),
      payment_attempts: new Map(),
      billing_provider_events: new Map(),
      usage_events: new Map(),
      usage_aggregates: new Map(),
      entitlement_overrides: new Map(),
      abuse_signals: new Map(),
      abuse_decisions: new Map(),
      billing_dunning_events: new Map()
    };
    this.rlsEnabled = true;

    // Seed global plans (INV-12-01, INV-12-03)
    this.tables.plans.set('STARTER', { id: 'STARTER', code: 'STARTER', name: 'البداية (Starter)', monthly_price_centimes: 149000n, max_users: 2, max_locations: 1, max_variants: 500 });
    this.tables.plans.set('PRO', { id: 'PRO', code: 'PRO', name: 'احترافية (Pro)', monthly_price_centimes: 299000n, max_users: 5, max_locations: 2, max_variants: 5000 });
    this.tables.plans.set('BUSINESS', { id: 'BUSINESS', code: 'BUSINESS', name: 'أعمال (Business)', monthly_price_centimes: 599000n, max_users: 20, max_locations: 10, max_variants: 50000 });
    this.tables.plans.set('BASIC', { id: 'BASIC', code: 'BASIC', name: 'أساسية (Basic)', monthly_price_centimes: 150000n, max_users: 2, max_locations: 1, max_variants: 500 });
    this.tables.plans.set('ENTERPRISE', { id: 'ENTERPRISE', code: 'ENTERPRISE', name: 'شركات (Enterprise)', monthly_price_centimes: 550000n, max_users: 20, max_locations: 10, max_variants: 50000 });

    // Seed default plan versions
    this.tables.plan_versions.set('STARTER_V1', {
      id: 'STARTER_V1',
      plan_id: 'STARTER',
      version: 'v1',
      price_amount: 1490,
      price_amount_cents: 149000n,
      currency: 'DZD',
      billing_interval: 'MONTHLY',
      features: ['FEATURE_POS', 'FEATURE_OFFLINE_POS', 'FEATURE_COD', 'FEATURE_DELIVERY', 'FEATURE_EXPORT'],
      limits: { MAX_USERS: 2, MAX_LOCATIONS: 1, MAX_PRODUCTS: 500, MAX_MONTHLY_ORDERS: 500, MAX_DEVICES: 2 },
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    });
    this.tables.plan_versions.set('PRO_V1', {
      id: 'PRO_V1',
      plan_id: 'PRO',
      version: 'v1',
      price_amount: 2990,
      price_amount_cents: 299000n,
      currency: 'DZD',
      billing_interval: 'MONTHLY',
      features: ['FEATURE_POS', 'FEATURE_OFFLINE_POS', 'FEATURE_COD', 'FEATURE_DELIVERY', 'FEATURE_EXPORT', 'FEATURE_REPORTS_ADVANCED', 'FEATURE_SHOPIFY', 'FEATURE_WOOCOMMERCE', 'FEATURE_TEAM_MEMBERS'],
      limits: { MAX_USERS: 5, MAX_LOCATIONS: 2, MAX_PRODUCTS: 5000, MAX_MONTHLY_ORDERS: 2500, MAX_DEVICES: 5 },
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    });
    this.tables.plan_versions.set('BUSINESS_V1', {
      id: 'BUSINESS_V1',
      plan_id: 'BUSINESS',
      version: 'v1',
      price_amount: 5990,
      price_amount_cents: 599000n,
      currency: 'DZD',
      billing_interval: 'MONTHLY',
      features: ['FEATURE_POS', 'FEATURE_OFFLINE_POS', 'FEATURE_COD', 'FEATURE_DELIVERY', 'FEATURE_EXPORT', 'FEATURE_REPORTS_ADVANCED', 'FEATURE_SHOPIFY', 'FEATURE_WOOCOMMERCE', 'FEATURE_TEAM_MEMBERS', 'FEATURE_API', 'FEATURE_MULTI_LOCATION'],
      limits: { MAX_USERS: 20, MAX_LOCATIONS: 10, MAX_PRODUCTS: 50000, MAX_MONTHLY_ORDERS: 10000, MAX_DEVICES: 20 },
      status: 'ACTIVE',
      created_at: new Date().toISOString()
    });

    if (this.persistencePath) {
      this._loadFromDisk();
    }
  }

  _saveToDisk() {
    if (!this.persistencePath) return;
    const dump = {};
    for (const [tblName, map] of Object.entries(this.tables)) {
      dump[tblName] = Array.from(map.entries());
    }
    const json = JSON.stringify(dump, (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v));
    fs.writeFileSync(this.persistencePath + '.tmp', json, 'utf8');
    fs.renameSync(this.persistencePath + '.tmp', this.persistencePath);
  }

  _loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const json = fs.readFileSync(this.persistencePath, 'utf8');
      const dump = JSON.parse(json, (k, v) => (v && v.__bigint !== undefined ? BigInt(v.__bigint) : v));
      for (const [tblName, entries] of Object.entries(dump)) {
        if (!this.tables[tblName]) this.tables[tblName] = new Map();
        this.tables[tblName] = new Map(entries);
      }
    } catch (e) {}
  }

  _setRLSEnabled(enabled) {
    this.rlsEnabled = Boolean(enabled);
  }

  async withTenant(context, callback) {
    if (!context || !context.tenantId) {
      throw new Error('Tenant context error: tenantId is required for all database operations');
    }

    if (this.persistencePath) {
      this._loadFromDisk();
    }

    const tx = new TenantTransaction(this, context);
    try {
      const result = await callback(tx);
      await tx.commit();
      if (this.persistencePath) {
        this._saveToDisk();
      }
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}

class TenantTransaction {
  constructor(db, session) {
    this.db = db;
    this.session = session;
    this.stagedInserts = [];
    this.stagedUpdates = [];
    this.stagedDeletes = [];
    this.committed = false;
    this.rolledBack = false;
    this.isInventoryAuthoritative = false;
  }

  _passesRLS(row, tableName) {
    if (tableName === 'plans') return true;
    if (tableName === 'tenants') {
      return row.id === this.session.tenantId;
    }
    if (!this.db.rlsEnabled) {
      return true;
    }
    return row.tenant_id === this.session.tenantId;
  }

  async commit() {
    if (this.committed || this.rolledBack) return;
    this.committed = true;
  }

  async rollback() {
    if (this.committed || this.rolledBack) return;
    this.rolledBack = true;

    // Rollback inserts (delete them)
    for (let i = this.stagedInserts.length - 1; i >= 0; i--) {
      const { tableName, id } = this.stagedInserts[i];
      this.db.tables[tableName].delete(id);
    }

    // Rollback updates (restore previous values)
    for (let i = this.stagedUpdates.length - 1; i >= 0; i--) {
      const { tableName, id, previous } = this.stagedUpdates[i];
      this.db.tables[tableName].set(id, previous);
    }

    // Rollback deletes (re-insert)
    for (let i = this.stagedDeletes.length - 1; i >= 0; i--) {
      const { tableName, id, previous } = this.stagedDeletes[i];
      this.db.tables[tableName].set(id, previous);
    }
  }

  async query(tableName, filterFn = () => true) {
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const table = this.db.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);

    const results = [];
    for (const row of table.values()) {
      if (!this._passesRLS(row, tableName)) continue;
      if (filterFn(row)) {
        results.push({ ...row });
      }
    }
    return results;
  }

  async getById(tableName, id) {
    return this.findById(tableName, id);
  }

  async findById(tableName, id) {
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const table = this.db.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);

    const row = table.get(id);
    if (!row) return null;
    if (!this._passesRLS(row, tableName)) return null;

    return { ...row };
  }

  async insert(tableName, data) {
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const table = this.db.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);

    // Architectural boundary enforcement (INV-03-13)
    if (PROTECTED_INVENTORY_TABLES.has(tableName) && !this.isInventoryAuthoritative) {
      throw new Error(`Architectural Boundary Violation: Direct inventory table mutation is prohibited (INV-03-13). All stock mutations must pass through InventoryService.`);
    }

    const tenantId = this.session.tenantId;
    if (tableName !== 'plans') {
      if (data.tenant_id && data.tenant_id !== tenantId) {
        throw new Error(`Security Violation: Cannot insert row for tenant ${data.tenant_id} inside session for ${tenantId}`);
      }
    }

    const id = data.id || generateUUIDv7();
    const record = {
      ...data,
      id,
      tenant_id: tableName !== 'plans' ? tenantId : undefined,
      created_at: data.created_at || new Date().toISOString()
    };

    table.set(id, record);
    this.stagedInserts.push({ tableName, id });
    return { ...record };
  }

  async update(tableName, id, updates) {
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const table = this.db.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);

    // Ledger immutability enforcement (INV-03-06)
    if (tableName === 'stock_movements') {
      throw new Error('Ledger Violation: stock_movements are strictly immutable (INV-03-06). Updates and deletes are prohibited.');
    }

    // Financial entries immutability (INV-05-12)
    if (tableName === 'financial_entries') {
      throw new Error('Financial Ledger Violation: financial_entries are strictly immutable (INV-05-12). Updates and deletes are prohibited.');
    }

    // Confirmation attempts, Processing Journal & Provider Events immutability (INV-06-12, INV-06-13, INV-07-05, INV-07-15)
    if (['confirmation_attempts', 'processing_journal', 'provider_events', 'shipment_events', 'transfer_records', 'processed_operations', 'report_snapshots', 'reporting_events_log', 'integration_events', 'privacy_request_audits', 'compliance_evidence_exports', 'invoice_lines', 'credit_notes', 'usage_events', 'billing_provider_events'].includes(tableName)) {
      throw new Error(`Audit Trail Violation: ${tableName} records are strictly immutable and append-only (INV-06-12, INV-07-05).`);
    }

    // Architectural boundary enforcement (INV-03-13)
    if (PROTECTED_INVENTORY_TABLES.has(tableName) && !this.isInventoryAuthoritative) {
      throw new Error(`Architectural Boundary Violation: Direct inventory table mutation is prohibited (INV-03-13). All stock mutations must pass through InventoryService.`);
    }

    const existing = table.get(id);
    if (!existing || !this._passesRLS(existing, tableName)) {
      return null;
    }


    // Invoice Immutability Enforcement (INV-12-04)
    if (tableName === 'invoices') {
      const forbiddenEdits = ['subtotal_cents', 'total_cents', 'discount_cents', 'tax_cents', 'currency', 'invoice_number', 'tenant_id', 'plan_version_id'];
      for (const field of forbiddenEdits) {
        if (updates[field] !== undefined && updates[field] !== existing[field]) {
          throw new Error(`Invoice Immutability Violation: Invoices are immutable after issuance (INV-12-04). Cannot mutate "${field}". Use credit notes or voiding.`);
        }
      }
    }

    // Sale Immutability Enforcement (INV-04-01)
    if (tableName === 'sales' && existing.status === 'COMPLETED') {
      const forbiddenEdits = ['subtotal_centimes', 'total_centimes', 'discount_centimes', 'receipt_number', 'location_id', 'cashier_id'];
      for (const field of forbiddenEdits) {
        if (updates[field] !== undefined && updates[field] !== existing[field]) {
          throw new Error(`Sale Immutability Violation: Completed sale '${field}' cannot be modified (INV-04-01). Financial records are permanent.`);
        }
      }
      if (updates.status && !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'].includes(updates.status)) {
        throw new Error(`Sale Lifecycle Violation: Invalid status transition from COMPLETED to '${updates.status}'`);
      }
    }

    // Expense immutability enforcement (INV-05-09)
    if (tableName === 'expenses') {
      if (existing.status === 'POSTED') {
        const forbiddenEdits = ['amount_centimes', 'category_id', 'expense_date', 'payment_method'];
        for (const field of forbiddenEdits) {
          if (updates[field] !== undefined && updates[field] !== existing[field]) {
            throw new Error(`Expense Immutability Violation: Posted expense '${field}' cannot be modified (INV-05-09). Use voidExpense() instead.`);
          }
        }
        if (updates.status && updates.status !== 'POSTED' && updates.status !== 'VOIDED') {
          throw new Error(`Expense Lifecycle Violation: Invalid status transition from POSTED to '${updates.status}'`);
        }
      } else if (existing.status === 'VOIDED') {
        throw new Error('Expense Immutability Violation: Voided expenses are permanently immutable and cannot be updated (INV-05-09).');
      }
    }

    // Purchase Order lifecycle enforcement (INV-05-03)
    if (tableName === 'purchase_orders') {
      if (existing.status === 'RECEIVED' && updates.status && updates.status !== 'RECEIVED') {
        throw new Error(`Purchase Order Lifecycle Violation: Cannot transition RECEIVED purchase order back to '${updates.status}' (INV-05-03).`);
      }
      if (existing.status === 'CANCELLED' && updates.status && updates.status !== 'CANCELLED') {
        throw new Error(`Purchase Order Lifecycle Violation: Cancelled purchase orders cannot be transitioned back to '${updates.status}'`);
      }
    }

    // Purchase receipt and return lines snapshot immutability (INV-05-04, INV-05-10)
    if (tableName === 'purchase_receipt_lines' || tableName === 'purchase_return_lines') {
      throw new Error(`Procurement Immutability Violation: Receipt and return lines are immutable (INV-05-04).`);
    }

    // Online order lifecycle & price immutability (INV-06-08, INV-06-09, INV-06-10)
    if (tableName === 'online_orders') {
      if (existing.status === 'DELIVERED') {
        if (updates.status && updates.status !== 'DELIVERED' && updates.status !== 'RETURNED') {
          throw new Error(`Order Lifecycle Violation: Cannot transition DELIVERED order back to '${updates.status}'`);
        }
      }
      if (existing.status === 'SHIPPED') {
        if (updates.status && ['NEW', 'PENDING_CONFIRMATION'].includes(updates.status)) {
          throw new Error(`Order Lifecycle Violation: Cannot transition SHIPPED order back to '${updates.status}'`);
        }
      }
      if (existing.status === 'CANCELLED' && updates.status && updates.status !== 'CANCELLED') {
        throw new Error(`Order Lifecycle Violation: Cancelled order cannot transition to '${updates.status}'`);
      }
      if (existing.status === 'REFUSED' && updates.status && updates.status !== 'REFUSED') {
        throw new Error(`Order Lifecycle Violation: Refused order cannot transition to '${updates.status}'`);
      }

      if (['CONFIRMED', 'RESERVED', 'SHIPPED', 'DELIVERED'].includes(existing.status)) {
        const protectedFields = ['subtotal_centimes', 'total_centimes', 'delivery_fee_centimes', 'shipping_fee_centimes', 'cod_amount_centimes'];
        for (const field of protectedFields) {
          if (updates[field] !== undefined && updates[field] !== existing[field]) {
            throw new Error(`Order Immutability Violation: Confirmed/shipped order '${field}' cannot be modified (INV-06-10).`);
          }
        }
      }
    }

    if (tableName === 'shipments') {
      if (existing.status === 'CANCELLED' && updates.status && updates.status !== 'CANCELLED') {
        throw new Error(`Shipment Lifecycle Violation: Cancelled shipment cannot transition to '${updates.status}'`);
      }
      if (existing.status === 'DELIVERED' && updates.status && !['DELIVERED', 'RETURN_IN_PROGRESS'].includes(updates.status)) {
        throw new Error(`Shipment Lifecycle Violation: Delivered shipment cannot regress to '${updates.status}' (INV-07-09).`);
      }
      if (updates.shipping_fee_at_creation_centimes !== undefined && existing.shipping_fee_at_creation_centimes !== undefined && updates.shipping_fee_at_creation_centimes !== existing.shipping_fee_at_creation_centimes) {
        throw new Error('Shipment Immutability Violation: Historical shipping fee snapshot cannot be modified (INV-07-11).');
      }
      if (updates.order_id !== undefined && updates.order_id !== existing.order_id) {
        throw new Error('Shipment Immutability Violation: Shipment order_id cannot be modified (INV-07-01).');
      }
    }

    if (tableName === 'order_items') {
      const parentOrder = this.db.tables.online_orders.get(existing.order_id);
      if (parentOrder && ['CONFIRMED', 'RESERVED', 'SHIPPED', 'DELIVERED'].includes(parentOrder.status)) {
        if (updates.unit_price_centimes !== undefined && updates.unit_price_centimes !== existing.unit_price_centimes) {
          throw new Error(`Order Line Immutability Violation: Unit price of confirmed order line cannot be altered (INV-06-09).`);
        }
      }
    }

    if (updates.tenant_id && updates.tenant_id !== this.session.tenantId) {
      throw new Error('Security Violation: Modification of tenant_id is strictly forbidden');
    }

    const previous = { ...existing };
    const updated = {
      ...existing,
      ...updates,
      id: existing.id,
      tenant_id: existing.tenant_id,
      updated_at: new Date().toISOString()
    };

    table.set(id, updated);
    this.stagedUpdates.push({ tableName, id, previous });
    return { ...updated };
  }

  async delete(tableName, id) {
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const table = this.db.tables[tableName];
    if (!table) throw new Error(`Unknown table: ${tableName}`);

    // Ledger immutability enforcement (INV-03-06)
    if (tableName === 'stock_movements') {
      throw new Error('Ledger Violation: stock_movements are strictly immutable (INV-03-06). Updates and deletes are prohibited.');
    }

    // Financial entries immutability (INV-05-12)
    if (tableName === 'financial_entries') {
      throw new Error('Financial Ledger Violation: financial_entries are strictly immutable (INV-05-12). Updates and deletes are prohibited.');
    }

    // Confirmation attempts, Processing Journal & Provider Events immutability (INV-06-12, INV-06-13, INV-07-05, INV-07-15)
    if (['confirmation_attempts', 'processing_journal', 'provider_events', 'shipment_events', 'transfer_records', 'processed_operations', 'report_snapshots', 'reporting_events_log', 'integration_events', 'privacy_request_audits', 'compliance_evidence_exports', 'invoices', 'invoice_lines', 'credit_notes', 'usage_events', 'billing_provider_events'].includes(tableName)) {
      throw new Error(`Audit Trail Violation: ${tableName} records cannot be deleted (INV-06-12, INV-07-05).`);
    }

    // Architectural boundary enforcement (INV-03-13)
    if (PROTECTED_INVENTORY_TABLES.has(tableName) && !this.isInventoryAuthoritative) {
      throw new Error(`Architectural Boundary Violation: Direct inventory table mutation is prohibited (INV-03-13). All stock mutations must pass through InventoryService.`);
    }

    const existing = table.get(id);
    if (!existing || !this._passesRLS(existing, tableName)) {
      return false;
    }

    // Completed Sale Deletion Protection (INV-04-07)
    if (tableName === 'sales' && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'].includes(existing.status)) {
      throw new Error('Sale Immutability Violation: Completed sales cannot be deleted (INV-04-07). Completed records are permanent.');
    }

    if (tableName === 'sale_items' || tableName === 'sale_payments') {
      const parentSale = this.db.tables.sales.get(existing.sale_id);
      if (parentSale && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'].includes(parentSale.status)) {
        throw new Error(`Sale Immutability Violation: Cannot delete lines or payments of completed sale ${existing.sale_id} (INV-04-07).`);
      }
    }

    // Expense deletion protection (INV-05-09)
    if (tableName === 'expenses' && (existing.status === 'POSTED' || existing.status === 'VOIDED')) {
      throw new Error('Expense Immutability Violation: Posted or voided expenses cannot be deleted (INV-05-09). Use voidExpense() instead.');
    }

    // Purchase Order deletion protection
    if (tableName === 'purchase_orders' && (existing.status === 'RECEIVED' || existing.status === 'PARTIALLY_RECEIVED')) {
      throw new Error(`Purchase Order Immutability Violation: Cannot delete purchase order in '${existing.status}' status (INV-05-03).`);
    }

    if (tableName === 'purchase_receipts' || tableName === 'purchase_receipt_lines') {
      throw new Error('Procurement Immutability Violation: Purchase receipts and lines cannot be deleted (INV-05-04).');
    }

    if (tableName === 'purchase_returns' || tableName === 'purchase_return_lines') {
      throw new Error('Procurement Immutability Violation: Purchase returns and lines cannot be deleted (INV-05-10).');
    }

    if (tableName === 'supplier_payments') {
      throw new Error('Supplier Payment Immutability Violation: Supplier payments cannot be deleted (INV-05-08).');
    }

    // Shipment Deletion Protection (INV-07-06)
    if (tableName === 'shipments') {
      throw new Error('Shipment Immutability Violation: Shipments cannot be deleted (INV-07-06). Use cancelShipment() instead.');
    }
    if (tableName === 'courier_collections' || tableName === 'courier_settlements') {
      throw new Error(`Settlement Immutability Violation: ${tableName} records cannot be deleted (INV-07-19).`);
    }
    if (tableName === 'sync_conflicts') {
      throw new Error('Conflict Immutability Violation: sync_conflicts records cannot be deleted (INV-08-08).');
    }
    if (tableName === 'devices') {
      throw new Error('Device Immutability Violation: Registered devices cannot be deleted (INV-08-23). Use revokeDevice() instead.');
    }
    if (tableName === 'shipment_returns' && ['RESTOCKED', 'RECEIVED', 'INSPECTED'].includes(existing.status)) {
      throw new Error(`Return Immutability Violation: Processed return in '${existing.status}' status cannot be deleted (INV-07-12).`);
    }

    // Online Order deletion protection (INV-06-08)
    if (tableName === 'online_orders' && ['CONFIRMED', 'RESERVED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'].includes(existing.status)) {
      throw new Error(`Order Immutability Violation: Order in status '${existing.status}' cannot be deleted.`);
    }

    if (tableName === 'order_items') {
      const parentOrder = this.db.tables.online_orders.get(existing.order_id);
      if (parentOrder && ['CONFIRMED', 'RESERVED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'].includes(parentOrder.status)) {
        throw new Error(`Order Immutability Violation: Cannot delete items of confirmed order ${existing.order_id}.`);
      }
    }

    const previous = { ...existing };
    table.delete(id);
    this.stagedDeletes.push({ tableName, id, previous });
    return true;
  }
}

const globalDb = new MahalDatabase();

module.exports = {
  MahalDatabase,
  globalDb,
  withTenant: (ctx, fn) => globalDb.withTenant(ctx, fn)
};
