# BoutiqFlow DZ — Database Schema & Data Architecture

**Engine:** PostgreSQL 15+  
**Isolation Architecture:** Row-Level Security (`FORCE ROW LEVEL SECURITY`) with Composite Keys `(tenant_id, id)`  
**Monetary Precision:** Strict Integer Centimes (`bigint`, 1 DZD = 100 centimes)

---

## 1. Schema Design Philosophy

1. **Dual-Layer Multi-Tenant Scoping:**
   - Every table containing store data includes a `tenant_id uuid NOT NULL REFERENCES tenants(id)`.
   - Primary keys on tenant tables are composite: `PRIMARY KEY (tenant_id, id)`.
   - Foreign keys between tenant tables always enforce tenant parity:
     `FOREIGN KEY (tenant_id, foreign_id) REFERENCES target_table(tenant_id, id)`.
   - All tenant tables enforce PostgreSQL Row-Level Security:
     `ALTER TABLE table_name FORCE ROW LEVEL SECURITY;`
2. **Immutable Financial & Inventory Ledgers:**
   - Physical records (`stock_movements`, `sale_payments`, `audit_logs`, `customer_ledger`) are append-only.
   - Deletions are forbidden on financial transactions; adjustments are handled via reversing compensating entries.
3. **Integer Currency Architecture:**
   - All prices, discounts, delivery fees, and debts are stored as `bigint` in Algerian centimes ($100\text{ centimes} = 1.00\text{ DZD}$).
   - Zero floating-point rounding or IEEE-754 precision errors.

---

## 2. Core Entity Relationship Overview

```
                      +-------------------+
                      |      tenants      |
                      +-------------------+
                                | 1:N
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
  +-----------+           +-----------+           +-------------------+
  |   users   |           | locations |           |      products     |
  +-----------+           +-----------+           +-------------------+
        |                       |                           | 1:N
        | 1:N                   |                           v
        v                       |                 +-------------------+
  +-----------+                 |                 |  product_variants |
  | sessions  |                 |                 +-------------------+
  +-----------+                 |                   | (SKU, Barcode)
        |                       |                   |
        v                       v                   v
+-------------------+     +-------------------------------------------+
| register_sessions |     |               stock_levels                |
+-------------------+     +-------------------------------------------+
        |                                   |
        v 1:N                               v 1:N
  +-----------+                   +-----------------------------------+
  |   sales   | ──[ generates ]──>|          stock_movements          |
  +-----------+                   | (SALE, PURCHASE, RETURN, TRANSFER)|
        |                         +-----------------------------------+
        v 1:N                               ^
  +-----------+                             | [ reserves / fulfills ]
  |sale_items |                             |
  +-----------+                   +-----------------------------------+
                                  |         stock_reservations        |
                                  +-----------------------------------+
                                            ^
                                            | 1:N
                                  +-----------------------------------+
                                  |           online_orders           |
                                  +-----------------------------------+
                                            |
                                            v 1:N
                                  +-----------------------------------+
                                  |             shipments             |
                                  +-----------------------------------+
```

---

## 3. Data Dictionary & Table Definitions

### 3.1 Tenancy & Authentication

#### `tenants`
Root organization record for each boutique.
```sql
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  domain varchar(100) UNIQUE,
  currency varchar(10) DEFAULT 'DZD',
  is_active boolean DEFAULT true,
  soft_deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

#### `users`
Boutique staff with specific RBAC roles.
```sql
CREATE TABLE users (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  salt varchar(64) NOT NULL,
  role varchar(50) NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'STOCK_MANAGER', 'CASHIER', 'ACCOUNTANT')),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);
```

#### `audit_logs`
Immutable security and compliance log.
```sql
CREATE TABLE audit_logs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action varchar(100) NOT NULL,
  target_type varchar(100) NOT NULL,
  target_id varchar(100),
  before_state jsonb,
  after_state jsonb,
  ip_address varchar(45),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

---

### 3.2 Catalog & Real Clothing Variants

#### `products`
Clothing model template.
```sql
CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  category varchar(100),
  brand varchar(100),
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

#### `product_variants`
Physical items differentiated by color and size.
```sql
CREATE TABLE product_variants (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  sku varchar(100) NOT NULL,
  barcode varchar(50) NOT NULL,
  color varchar(50) NOT NULL,
  size varchar(20) NOT NULL,
  cost_price_centimes bigint NOT NULL DEFAULT 0,
  selling_price_centimes bigint NOT NULL,
  discount_price_centimes bigint,
  low_stock_threshold int DEFAULT 3,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);
```

---

### 3.3 Authoritative Inventory Engine

#### `stock_levels`
Current cached balances by physical location.
```sql
CREATE TABLE stock_levels (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  on_hand int NOT NULL DEFAULT 0,
  reserved int NOT NULL DEFAULT 0,
  available int GENERATED ALWAYS AS (on_hand - reserved) STORED,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, variant_id, location_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id),
  CONSTRAINT non_negative_reserved CHECK (reserved >= 0),
  CONSTRAINT valid_available CHECK (available <= on_hand)
);
```

#### `stock_movements`
Append-only authoritative ledger of all stock modifications.
```sql
CREATE TABLE stock_movements (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  qty int NOT NULL,
  cost_price_centimes bigint NOT NULL,
  reason varchar(50) NOT NULL CHECK (reason IN (
    'OPENING_BALANCE', 'PURCHASE', 'RECEIVING', 'SALE', 'POS_SALE',
    'RETURN_RESTOCK', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT',
    'STOCKTAKE_ADJUSTMENT', 'ONLINE_SHIPMENT'
  )),
  reference_type varchar(50),
  reference_id varchar(100),
  actor_id uuid,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES inventory_locations(tenant_id, id)
);
```

#### `stock_reservations`
Temporary stock holds for online orders.
```sql
CREATE TABLE stock_reservations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  order_id uuid,
  qty int NOT NULL CHECK (qty > 0),
  status varchar(20) NOT NULL CHECK (status IN ('ACTIVE', 'FULFILLED', 'RELEASED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);
```

---

### 3.4 Store POS & Cash Control

#### `register_sessions`
Cash drawer shift sessions.
```sql
CREATE TABLE register_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cashier_id uuid NOT NULL,
  location_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opening_cash_centimes bigint NOT NULL,
  closing_cash_centimes bigint,
  expected_cash_centimes bigint,
  cash_variance_centimes bigint,
  status varchar(20) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  PRIMARY KEY (tenant_id, id)
);
```

#### `sales` & `sale_items`
```sql
CREATE TABLE sales (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  receipt_number varchar(50) NOT NULL,
  session_id uuid NOT NULL,
  cashier_id uuid NOT NULL,
  customer_id uuid,
  subtotal_centimes bigint NOT NULL,
  discount_centimes bigint NOT NULL DEFAULT 0,
  total_centimes bigint NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('COMPLETED', 'RETURNED', 'CANCELLED')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, receipt_number)
);

CREATE TABLE sale_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty int NOT NULL,
  unit_price_centimes bigint NOT NULL,
  cost_price_centimes bigint NOT NULL,
  total_centimes bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES product_variants(tenant_id, id)
);
```

---

### 3.5 Online Orders & Logistics

#### `online_orders` & `order_items`
```sql
CREATE TABLE online_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_number varchar(50) NOT NULL,
  source varchar(50) NOT NULL, -- 'MANUAL', 'SHOPIFY', 'WOOCOMMERCE', 'FACEBOOK', 'INSTAGRAM'
  status varchar(50) NOT NULL CHECK (status IN (
    'NEW', 'PENDING_CONFIRMATION', 'CONFIRMED', 'PREPARING',
    'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'
  )),
  customer_name varchar(255) NOT NULL,
  customer_phone varchar(50) NOT NULL,
  wilaya varchar(100) NOT NULL,
  commune varchar(100) NOT NULL,
  address text NOT NULL,
  shipping_fee_centimes bigint NOT NULL DEFAULT 0,
  total_centimes bigint NOT NULL,
  cod_amount_centimes bigint NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_number)
);
```

---

## 4. Performance Indexes
```sql
CREATE INDEX idx_variants_sku ON product_variants(tenant_id, sku);
CREATE INDEX idx_variants_barcode ON product_variants(tenant_id, barcode);
CREATE INDEX idx_stock_levels_lookup ON stock_levels(tenant_id, variant_id, location_id);
CREATE INDEX idx_movements_variant ON stock_movements(tenant_id, variant_id, created_at DESC);
CREATE INDEX idx_sales_created ON sales(tenant_id, created_at DESC);
CREATE INDEX idx_orders_status ON online_orders(tenant_id, status, created_at DESC);
CREATE INDEX idx_audit_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_idempotency ON idempotency_keys(tenant_id, key);
```
