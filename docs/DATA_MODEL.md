# BoutiqFlow DZ — Comprehensive Data Model & Entity Specifications

**Database Engine:** PostgreSQL 15+  
**Multi-Tenant Architecture:** Composite Keys `(tenant_id, id)` with `FORCE ROW LEVEL SECURITY`  
**Monetary Precision:** Algerian Centimes (`bigint`, 1 DZD = 100 centimes)

---

## 1. Compliance, Privacy & Audit Entities (Law 25-11 / 18-07)

### `processing_register`
Internal register of personal data processing activities (Art. 39 bis Law 25-11).
```sql
CREATE TABLE processing_register (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  purpose varchar(255) NOT NULL,
  legal_basis varchar(100) NOT NULL, -- 'CONTRACT_EXECUTION', 'LEGAL_OBLIGATION', 'CONSENT'
  data_categories text[] NOT NULL,   -- e.g. ['NAME', 'PHONE', 'ADDRESS', 'PURCHASE_HISTORY']
  data_subjects text[] NOT NULL,     -- e.g. ['CUSTOMERS', 'EMPLOYEES']
  recipients text[] NOT NULL,        -- e.g. ['DELIVERY_COURIERS', 'PAYMENT_PROCESSORS']
  retention_months int NOT NULL DEFAULT 24,
  international_transfer boolean DEFAULT false,
  security_measures text[] NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

### `processing_journal` (`carnet_automatisé`)
Automated log tracking all access, consultation, modification, and deletion of personal data (Art. 41 bis 3 Law 25-11).
```sql
CREATE TABLE processing_journal (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_role varchar(50) NOT NULL,
  operation varchar(50) NOT NULL CHECK (operation IN (
    'COLLECTION', 'RECORDING', 'CONSULTATION', 'MODIFICATION',
    'EXTRACTION', 'USE', 'DISCLOSURE', 'TRANSFER', 'DELETION'
  )),
  data_subject_type varchar(50) NOT NULL, -- 'CUSTOMER', 'EMPLOYEE'
  data_subject_id varchar(100),
  purpose varchar(100) NOT NULL,
  ip_address varchar(45),
  user_agent varchar(255),
  details jsonb,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

### `breach_register`
Record of security incidents and data breaches (Art. 45 bis 8 Law 25-11).
```sql
CREATE TABLE breach_register (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  incident_title varchar(255) NOT NULL,
  discovered_at timestamptz NOT NULL,
  contained_at timestamptz,
  severity varchar(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  compromised_data_categories text[] NOT NULL,
  estimated_affected_count int NOT NULL DEFAULT 0,
  root_cause text NOT NULL,
  remediation_steps text NOT NULL,
  notified_merchant_at timestamptz,
  notified_anpdp_at timestamptz,
  anpdp_deadline_at timestamptz GENERATED ALWAYS AS (discovered_at + interval '5 days') STORED,
  is_resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

---

## 2. COD Confirmation & Call Attempt Entities

### `order_call_attempts`
Tracks phone call and WhatsApp confirmation attempts for online orders.
```sql
CREATE TABLE order_call_attempts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  attempt_number int NOT NULL,
  agent_id uuid NOT NULL REFERENCES users(id),
  channel varchar(30) NOT NULL CHECK (channel IN ('PHONE_CALL', 'WHATSAPP_MESSAGE', 'SMS')),
  outcome varchar(50) NOT NULL CHECK (outcome IN (
    'ANSWERED_CONFIRMED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER',
    'ASKED_DELAY', 'REFUSED'
  )),
  next_attempt_scheduled_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES online_orders(tenant_id, id)
);
```

---

## 3. Hardware & POS Printing Entities

### `print_jobs`
Local and network thermal receipt print requests.
```sql
CREATE TABLE print_jobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  register_session_id uuid NOT NULL,
  receipt_number varchar(50) NOT NULL,
  printer_type varchar(30) NOT NULL CHECK (printer_type IN ('BROWSER', 'ESC_POS_USB', 'ESC_POS_NETWORK', 'BLUETOOTH')),
  paper_width_mm int NOT NULL DEFAULT 80,
  payload_escpos bytea,
  status varchar(20) NOT NULL CHECK (status IN ('PENDING', 'PRINTED', 'FAILED')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```

---

## 4. Multi-Channel Connectors & Unmapped Items

### `unmapped_items`
Holds external order line items or products with unknown SKUs for operator triage.
```sql
CREATE TABLE unmapped_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_id varchar(100) NOT NULL,
  external_product_id varchar(100),
  external_sku varchar(100),
  title varchar(255) NOT NULL,
  reason varchar(50) NOT NULL CHECK (reason IN ('MISSING_SKU', 'UNMATCHED_SKU')),
  raw_payload jsonb NOT NULL,
  resolved_variant_id uuid,
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'IGNORED')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
```
