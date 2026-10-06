/**
 * Role-Based Access Control (RBAC) System for BoutiqFlow DZ
 * Implements Principle of Least Privilege: Deny by Default.
 * Specifically protects cost prices, profit margins, voids, roles, and personal data.
 */

const ROLES = {
  OWNER: 'owner',
  MANAGER: 'manager',
  CASHIER: 'cashier',
  STOCK_MANAGER: 'stock_manager',
  STOCK_CLERK: 'stock_clerk', // Alias for backwards compatibility
  ONLINE_MANAGER: 'online_manager',
  ACCOUNTANT: 'accountant'
};

const PERMISSIONS = {
  // Catalog
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',
  CATALOG_VIEW_COST: 'catalog:view_cost',         // Denied to Cashier, Stock Manager, Online Manager
  CATALOG_PRICE_MODIFY: 'catalog:price_modify',   // Denied to Cashier

  // Sales & POS
  SALES_READ: 'sales:read',
  SALES_CREATE: 'sales:create',
  SALES_VOID: 'sales:void',                      // Denied to Cashier, Stock Manager
  SALES_REFUND: 'sales:refund',                  // Denied to Cashier without Manager override
  PRICE_OVERRIDE: 'sales:price_override',        // Denied to Cashier

  // Cash Register
  CASH_REGISTER_OPEN: 'cash_register:open',
  CASH_REGISTER_CLOSE: 'cash_register:close',
  CASH_ADJUST: 'cash_register:adjust',           // Denied to Cashier

  // Inventory
  INVENTORY_READ: 'inventory:read',
  INVENTORY_TRANSFER: 'inventory:transfer',
  INVENTORY_ADJUST: 'inventory:adjust',

  // Procurement & Suppliers (Phase 05)
  SUPPLIERS_MANAGE: 'suppliers:manage',
  PURCHASES_MANAGE: 'purchases:manage',
  PURCHASES_RECEIVE: 'purchases:receive',
  SUPPLIER_PAYMENTS_MANAGE: 'supplier_payments:manage',

  // Online Orders & COD
  ONLINE_ORDERS_MANAGE: 'online_orders:manage',
  COD_CONFIRM: 'cod:confirm',

  // Finance & Reporting
  FINANCE_VIEW_PROFIT: 'finance:view_profit',     // Denied to Cashier, Stock Manager, Online Manager
  FINANCE_MANAGE_EXPENSES: 'finance:manage_expenses',

  // System & Administration
  DATA_EXPORT: 'data:export',                    // Denied to Cashier, Stock Manager
  SETTINGS_MANAGE: 'settings:manage',            // Denied to Cashier, Stock Manager, Online Manager
  USERS_MANAGE: 'users:manage',                  // Denied to Cashier, Stock Manager, Online Manager, Accountant
  ROLES_MANAGE: 'roles:manage',                  // Denied to Cashier, Stock Manager, Online Manager, Accountant

  // Privacy & PII
  CUSTOMER_PII_VIEW: 'customer:pii_view'         // Restricted by role (masking applied)
};

// Explicit grant matrix - deny by default
const ROLE_PERMISSIONS = {
  [ROLES.OWNER]: Object.values(PERMISSIONS),

  [ROLES.MANAGER]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.CATALOG_WRITE,
    PERMISSIONS.CATALOG_VIEW_COST,
    PERMISSIONS.CATALOG_PRICE_MODIFY,
    PERMISSIONS.SALES_READ,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.SALES_VOID,
    PERMISSIONS.SALES_REFUND,
    PERMISSIONS.PRICE_OVERRIDE,
    PERMISSIONS.CASH_REGISTER_OPEN,
    PERMISSIONS.CASH_REGISTER_CLOSE,
    PERMISSIONS.CASH_ADJUST,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_TRANSFER,
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.SUPPLIERS_MANAGE,
    PERMISSIONS.PURCHASES_MANAGE,
    PERMISSIONS.PURCHASES_RECEIVE,
    PERMISSIONS.SUPPLIER_PAYMENTS_MANAGE,
    PERMISSIONS.ONLINE_ORDERS_MANAGE,
    PERMISSIONS.COD_CONFIRM,
    PERMISSIONS.FINANCE_VIEW_PROFIT,
    PERMISSIONS.FINANCE_MANAGE_EXPENSES,
    PERMISSIONS.DATA_EXPORT,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.CUSTOMER_PII_VIEW
    // Excluded: USERS_MANAGE, ROLES_MANAGE (Reserved for Owner)
  ],

  [ROLES.CASHIER]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.SALES_READ,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.CASH_REGISTER_OPEN,
    PERMISSIONS.CASH_REGISTER_CLOSE,
    PERMISSIONS.INVENTORY_READ
    // Explicitly denied: CATALOG_VIEW_COST, CATALOG_PRICE_MODIFY, SALES_VOID, SALES_REFUND, CASH_ADJUST, PRICE_OVERRIDE, FINANCE_VIEW_PROFIT, DATA_EXPORT, ROLES_MANAGE, SUPPLIERS_MANAGE, PURCHASES_MANAGE, PURCHASES_RECEIVE, SUPPLIER_PAYMENTS_MANAGE, FINANCE_MANAGE_EXPENSES
  ],

  [ROLES.STOCK_MANAGER]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.CATALOG_WRITE,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_TRANSFER,
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.PURCHASES_RECEIVE
    // Explicitly denied: CATALOG_VIEW_COST, FINANCE_VIEW_PROFIT, SALES_VOID, DATA_EXPORT, ROLES_MANAGE, SUPPLIER_PAYMENTS_MANAGE, FINANCE_MANAGE_EXPENSES
  ],

  [ROLES.STOCK_CLERK]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.CATALOG_WRITE,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_TRANSFER,
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.PURCHASES_RECEIVE
  ],

  [ROLES.ONLINE_MANAGER]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.SALES_READ,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.ONLINE_ORDERS_MANAGE,
    PERMISSIONS.COD_CONFIRM,
    PERMISSIONS.CUSTOMER_PII_VIEW
    // Explicitly denied: CATALOG_VIEW_COST, FINANCE_VIEW_PROFIT, SETTINGS_MANAGE, ROLES_MANAGE
  ],

  [ROLES.ACCOUNTANT]: [
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.CATALOG_VIEW_COST,
    PERMISSIONS.SALES_READ,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.SUPPLIERS_MANAGE,
    PERMISSIONS.SUPPLIER_PAYMENTS_MANAGE,
    PERMISSIONS.FINANCE_VIEW_PROFIT,
    PERMISSIONS.FINANCE_MANAGE_EXPENSES,
    PERMISSIONS.DATA_EXPORT
    // Read-only accountant: no sales create, no inventory adjustments, no settings/role mutations, no goods receipt
  ]
};

function hasPermission(role, permission) {
  if (!role || !permission) return false;
  const normalizedRole = role.toLowerCase();
  const granted = ROLE_PERMISSIONS[normalizedRole];
  if (!granted) return false;
  return granted.includes(permission);
}

function authorize(role, permission) {
  if (!hasPermission(role, permission)) {
    const error = new Error(`Access Denied: Role '${role}' lacks required permission '${permission}'`);
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }
  return true;
}

module.exports = {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  authorize
};
