# BoutiqFlow DZ — Legal Sources of Truth

## 1. Statutory Framework
All privacy, data governance, and personal data protection controls in BoutiqFlow DZ are strictly grounded in Algerian legislation published in the Official Gazette (الجريدة الرسمية للجمهورية الجزائرية الديمقراطية الشعبية):

1. **Law No. 18-07 of 25 Ramadhan 1439 corresponding to 10 June 2018**:
   - Title: Relative à la protection des personnes physiques dans le traitement des données à caractère personnel (قانون رقم 18-07 يتعلق بحماية الأشخاص الطبيعيين في مجال معالجة المعطيات ذات الطابع الشخصي).
   - Official Gazette: Journal Officiel n° 34 du 10 juin 2018.
2. **Law No. 25-11 of 23 Muharram 1447 corresponding to 19 July 2025**:
   - Title: Modifiant et complétant la loi n° 18-07 relative à la protection des personnes physiques dans le traitement des données à caractère personnel (قانون رقم 25-11 يعدل ويتمم القانون رقم 18-07).
   - Official Gazette: Journal Officiel n° 48 du 24 juillet 2025.
3. **National Authority for Personal Data Protection (ANPDP)**:
   - Autorité Nationale de Protection des Données à Caractère Personnel (السلطة الوطنية لحماية المعطيات ذات الطابع الشخصي).
   - Guidelines, notification forms, register templates, and statutory reporting frameworks.

---

## 2. Fundamental Operating Principle
**No Claim of 100% Legal Compliance by Software Alone.**
BoutiqFlow provides automated technical and organizational controls, immutable journals, registers, and cryptographic evidence. Ultimate statutory compliance depends on:
1. Respective legal roles (Data Controller vs Data Processor) governed by written contracts (Data Processing Agreements - DPAs).
2. Operational and human procedures within each boutique merchant.
3. Hosting agreements, cloud geographic boundaries, and ANPDP authorizations.
4. Formal legal review decisions.

Status classifications throughout the system:
- `CONFIGURED`: Technical control configured in application.
- `LEGAL_REVIEW_REQUIRED`: Requires independent legal counsel determination before activation.
- `NOT_APPLICABLE`: Requirement does not apply to this context.
- `APPROVED`: Formally reviewed and sanctioned.
- `REJECTED`: Legally rejected; technical enforcement blocks processing.

---

## 3. Statutory Requirement Tracking Register

| Requirement ID | Legal Source | Article Reference | Product Control | Implementation Status | Legal Review Status | Last Reviewed | Reviewed By | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **REQ-LAW25-01** | Law 25-11 | Art. 39 bis | Register of Processing Activities (Registre des activités de traitement) | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Maintained for Controllers and Processors with purpose, categories, recipients, and security measures. |
| **REQ-LAW25-02** | Law 25-11 | Art. 41 bis 3 | Automated Processing Journal (Carnet automatisé des opérations) | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Append-only journal logging collection, consultation, modification, disclosure, and deletion with cryptographic chaining. |
| **REQ-LAW25-03** | Law 25-11 | Art. 45 bis 8 | 5-Day Regulatory Breach Notification Window to ANPDP | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | 5 calendar days from discovery time; late notification strictly mandates delay justification. |
| **REQ-LAW25-04** | Law 25-11 | Art. 45 bis 8 | Processor-to-Controller Immediate Breach Notification | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | BoutiqFlow (as Processor) notifies Merchant (Controller) immediately without waiting for regulatory window. |
| **REQ-LAW25-05** | Law 25-11 | Art. 45 bis 8 | High-Risk Breach Notice to Affected Individuals | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Plain-language, non-alarming notification in Arabic and French when breach poses high risk to personal rights. |
| **REQ-LAW25-06** | Law 25-11 | Art. 41 bis 1 | Data Protection Impact Assessment (DPIA / Étude d'impact) | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Mandatory prior impact study for high-risk processing; DPIA approval gate blocks activity activation. |
| **REQ-LAW25-07** | Law 25-11 | Art. 44 bis | Data Protection Officer (DPO / Délégué à la protection des données) | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Contact point appointment metadata; least-privilege view access without browsing raw customer PII. |
| **REQ-LAW18-08** | Law 18-07 | Art. 44–47 | Cross-Border International Data Transfers | IMPLEMENTED | LEGAL_REVIEW_REQUIRED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | TransferRecord tracking; transmission guard blocks unapproved foreign transfers until review is completed. |
| **REQ-LAW18-09** | Law 18-07 | Art. 32–36 | Data Subject Rights (Access, Rectification, Objection) | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Identity verification gate; rectification preserves immutable sales ledger history; controlled exports. |
| **REQ-LAW18-10** | Law 18-07 | Art. 38 | Security & Confidentiality of Processing | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | AES-256-GCM encryption at rest, PBKDF2/Argon2 passwords, TLS in transit, and role-based phone/address masking. |
| **REQ-LAW18-11** | Law 18-07 | Art. 27 | Purpose Limitation & Data Minimization | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Each processing activity requires explicit purpose; cashiers receive masked minimal operational data. |
| **REQ-LAW18-12** | Law 18-07 | Art. 29 | Storage Limitation & Retention Engine | IMPLEMENTED | LEGAL_REVIEW_REQUIRED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Configurable retention periods; legal hold engine prevents deletion during statutory disputes. |
| **REQ-SYS-13** | BoutiqFlow DZ | Architecture | Super Admin Customer PII Isolation & Break-Glass | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | SaaS platform super-admins have zero default browse access to tenant customer PII. |
| **REQ-SYS-14** | BoutiqFlow DZ | Architecture | Privacy CI Gate for New Fields | IMPLEMENTED | APPROVED | 2026-10-06 | BoutiqFlow Legal & Privacy Team | Automated CI checks block unclassified PII fields missing purpose, retention, and access policies. |
