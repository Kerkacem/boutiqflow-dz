# BoutiqFlow DZ — Privacy & Personal Data Protection Specification

**Governing Framework:** Algerian Law No. 18-07 on the Protection of Personal Data, as amended by Law No. 25-11 (Promulgated July 24, 2025).  
**Supervisory Authority:** National Authority for the Protection of Personal Data (ANPDP - السلطة الوطنية لحماية المعطيات ذات الطابع الشخصي).  
**Core Principle:** Privacy by Design & Default (Principle #0).

---

## 1. Governance & Legal Roles

### 1.1 Data Controller vs. Data Processor Distinction
It is critical to establish the precise legal qualification under Algerian law:

| Entity | Role under Law 18-07 / 25-11 | Responsibilities |
| :--- | :--- | :--- |
| **Clothing Boutique Merchant (Tenant)** | **Data Controller** (`Responsable du traitement`) | Determines the purposes and means of customer data processing (sales, delivery, loyalty, marketing). Directly liable to data subjects and the ANPDP. |
| **BoutiqFlow DZ (SaaS Platform)** | **Data Processor** (`Sous-traitant`) | Processes personal data solely on behalf of, and under documented instructions from, the Boutique Merchant. Implements security, confidentiality, and technical privacy controls. |

*Architectural Mandate:* BoutiqFlow DZ does NOT claim global ownership of customer personal data. Each tenant's dataset is isolated, and processing activities are documented per merchant.

---

## 2. Register of Processing Activities (`Registre des activités de traitement`)

Under Law 25-11, data controllers and processors must maintain a comprehensive register. BoutiqFlow DZ embeds this register directly into the SaaS product (`src/compliance/processing_register.js`):

For each processing activity, the platform records:
1. **Processing Purpose (`Finalité`):** e.g., Order fulfillment, Cash-on-Delivery shipping, customer debt tracking.
2. **Legal Basis (`Base légale`):** e.g., Contract execution (sale agreement), legal obligation, consent.
3. **Data Categories (`Catégories de données`):** Identification (name, phone), location (Wilaya, commune, delivery address), financial (debt balance).
4. **Data Subjects (`Personnes concernées`):** Boutique customers, shop employees, suppliers.
5. **Recipients (`Destinataires`):** Delivery couriers (Yalidine, ZR Express, etc.), SMS/WhatsApp gateways, payment providers.
6. **Retention Period (`Durée de conservation`):** Specific retention timelines per category (e.g., active orders: duration of delivery + 1 year for fiscal proofs).
7. **International Transfers (`Transferts internationaux`):** Status, destination country, adequacy basis.
8. **Technical Security Measures (`Mesures de sécurité`):** RLS isolation, salted password hashing, TLS 1.3 encryption in transit, AES-256 backup encryption.

---

## 3. Automated Processing Journal (`Carnet automatisé des opérations`)

### 3.1 Legal Requirement: Article 41 bis 3 of Law 25-11
Article 41 bis 3 mandates that systems maintain an automated journal (`carnet automatisé`) documenting all personal data operations to enable oversight of legality, internal control, and data integrity.

### 3.2 Dual Audit Architecture
BoutiqFlow DZ separates operational business auditing from personal data access auditing:
1. **Business Audit Log:** Records non-PII operational events (stock movement, product price change, cash register drawer close, permission change).
2. **Personal Data Processing Journal (`carnet automatisé`):**
   Records every access or modification of personal data with:
   - `timestamp` (ISO-8601 with millisecond precision).
   - `actor_id` & `role` (who initiated the access).
   - `tenant_id` (store boundary).
   - `operation_type` (`COLLECTION`, `RECORDING`, `CONSULTATION`, `MODIFICATION`, `EXTRACTION`, `USE`, `DISCLOSURE`, `TRANSFER`, `DELETION`).
   - `data_subject_type` (`CUSTOMER`, `EMPLOYEE`).
   - `data_subject_id` / `record_reference`.
   - `purpose` (e.g., `ORDER_CONFIRMATION`, `DELIVERY_DISPATCH`, `CREDIT_LOOKUP`).
   - `ip_address` & `user_agent` (where technologically feasible and necessary).

---

## 4. Incident & Breach Management Protocol

### 4.1 Legal Notification Timelines (Article 45 bis 8 of Law 25-11)
- **Controller Notification to ANPDP:** The Data Controller (Boutique) must notify the ANPDP within a maximum of **5 days** from becoming aware of a personal data breach. Any notification made after 5 days must state the justified grounds for delay.
- **Processor Notification to Controller:** BoutiqFlow DZ (as processor) MUST notify the affected boutique merchant **immediately** upon discovering or reasonably suspecting a breach.
- **Data Subject Notification:** If a breach is likely to result in a high risk to the rights and freedoms of individuals (e.g., exposed phone numbers with customer delivery history), the controller must communicate the breach to the affected individuals in clear, plain language without undue delay.

### 4.2 Embedded Breach Register
The platform maintains an internal breach register recording:
- Incident identification, discovery date/time, and containment date/time.
- Nature and categories of compromised personal data and estimated number of affected persons.
- Root cause analysis and severity rating.
- Remedial and mitigation measures taken.
- Notification logs (Merchant notified, ANPDP notification draft generated).

---

## 5. Data Residency & International Transfer Controls

### 5.1 Reality-Based Hosting Policy
Rather than making unfounded claims that "Algerian law forbids hosting abroad", BoutiqFlow DZ implements strict international transfer controls aligned with Law 18-07/25-11 requirements:
- Data residency can be pinned to Algerian infrastructure (`REGION=dz`) or qualified regions (`EU`, `OTHER`).
- All personal data transfers to foreign entities or external servers require explicit authorization workflows and verification of compliance safeguards.
- Hosting provider selection is subject to formal legal review.

---

## 6. Privacy by Design: Field-Level Masking

Personal data is masked by default based on role:
- **Cashier Role:** Phone numbers are partially masked in lookup screens (`+213 555 *** *56`) unless needed to call the customer for order confirmation.
- **Delivery Courier Handover:** Couriers only receive delivery-essential fields (recipient name, phone, delivery address, COD amount).
- **Super-Admin Console:** System administrators cannot inspect customer PII across tenant boutiques without an emergency support ticket and explicit, audited merchant authorization.
