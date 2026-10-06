# BoutiqFlow DZ — منصة التجارة الإلكترونية ونقاط البيع المتكاملة لمحلات الملابس في الجزائر

[![Node.js CI](https://github.com/your-username/boutiqflow-dz/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/boutiqflow-dz/actions)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-blue.svg)](LICENSE)
[![Security Baseline: OWASP ASVS 5.0](https://img.shields.io/badge/Security-OWASP%20ASVS%205.0-green.svg)](docs/SECURITY_BASELINE.md)
[![Compliance: Algerian Law 18--07 / 25--11](https://img.shields.io/badge/Compliance-Law%2018--07%20%2F%2025--11-emerald.svg)](docs/compliance/LEGAL_SOURCES.md)

**BoutiqFlow DZ** هي منصة SaaS سحابية متعددة المستأجرين (Multi-tenant) متخصصة لتجارة الملابس والتجزئة في الجزائر. تدمج بين نقاط البيع المادية بالمحل (POS Caisse)، وتجارة التوصيل والدفع عند الاستلام (COD Logistics عبر 58 ولاية)، ومزامنة المخزون المركزي مع المتاجر الإلكترونية (Shopify & WooCommerce).

---

## 🚀 المميزات الرئيسية (Core Features)

### 1. نقطة البيع السريعة للمحل (POS & In-Store Cashier)
- واجهة كاشير سريعة تدعم الشاشات اللمسية وقارئ الباركود (Barcode Scanner).
- دعم كامل للطباعة الحرارية المباشرة (ESC/POS Thermal Receipts) بمقاسي 58mm و80mm بدون الحاجة لخوادم وسيطة.
- إدارة ورديات الصندوق (Cash Sessions)، فتح وإغلاق الصندوق مع تقرير نهاية اليوم (Z-Report) وحساب الفروقات النقدية بدقة السنتيم.
- استبدال المقاسات والألوان في حركة واحدة بالمحل (In-Store Size Exchange).

### 2. دفتر أستاذ المخزون الموحد (Unified Inventory Ledger)
- مصفوفة المقاسات والألوان المخصصة للألبسة (Size $\times$ Color Matrix) مع توليد باركود قياسي EAN-13 (بادئة 20-29).
- دفتر حركات مخزون ثابت وغير قابل للتعديل (Immutable Movement Ledger).
- قاعدة رياضية صارمة: المخزون المتاح = المخزون الفعلي - المحجوز (`available = on_hand - reserved`)، مع استحالة وصول المخزون لقيم سالبة.
- حساب تكلفة المخزون بطريقة المتوسط المرجح المتحرك (Weighted Average Cost - WAC).

### 3. لوجستيات الدفع عند الاستلام (COD & Algerian Delivery)
- دعم كامل لـ 58 ولاية و1541 بلدية مع مرجعية جغرافية جزائرية دقيقة.
- موصلات ربط جاهزة مع كبرى شركات التوصيل: **Yalidine**, **ZR Express**, **Noest**, **Maystro**, **Ecotrack**.
- تتبع دورة حياة الطرد: `NEW` $\to$ `CONFIRMED` $\to$ `SHIPPED` $\to$ `DELIVERED` / `RETURNED`.
- مطابقة التحصيل المالي الثلاثي (Reconciliation): المتوقع $\leftrightarrow$ المحصل $\leftrightarrow$ المسوّى مع رصد الفروقات آلياً.

### 4. وضع عدم الاتصال والمزامنة (Offline-First PWA)
- استمرار البيع في المحل حتى عند انقطاع الإنترنت عبر IndexedDB Outbox.
- مزامنة آمنة ومقاومة للتكرار (Idempotent Sync) عند عودة الاتصال.
- نظام مخصصات المخزون للجهاز (Device Stock Allowance) لحماية المخزون من البيع الزائد أثناء العمل دون اتصال.

### 5. الامتثال لقانون حماية المعطيات الشخصية (قانون 18-07 المعدل بالقانون 25-11)
- سجل أنشطة المعالجة الإلزامي (Registre des activités de traitement - المادة 39 مكرر).
- الدفتر المؤتمت للعمليات (`Carnet automatisé des opérations` - المادة 41 مكرر 3) مشفر بسلسلة تجزئة SHA-256 لمنع التلاعب.
- إدارة إشعارات الخروقات الأمنية وفق المهلة القانونية الصارمة (5 أيام لسلطة ANPDP - المادة 45 مكرر 8).
- دراسة أثر حماية البيانات (DPIA) وحصانة التجميد القانوني (Legal Hold).

### 6. إدارة الاشتراكات التجارية والفوترة (SaaS Commercial Engine)
- خطط اشتراك سنوية وشهرية: **Starter** (1,490 دج)، **Pro** (2,990 دج)، **Business** (5,990 دج).
- فواتير غير قابلة للتعديل بترقيم تسلسلي أحادي (`BF-YYYY-000001`).
- تكامل مع بوابات الدفع الجزائرية (Chargily Pay V2 / البطاقة الذهبية وCIB) والدفع اليدوي عبر بريدي موب / CCP.

---

## 🛠️ المتطلبات التقنية (Prerequisites)

- **Node.js**: الإصدار LTS 20 أو 22 فما فوق.
- **PostgreSQL**: الإصدار 16.15+ أو 17.11+ (مصحح ضد ثغرة RLS policy cache CVE-2026-14666).
- **Docker & Docker Compose** (اختياري للتشغيل بالحاويات).

---

## ⚡ التشغيل السريع محلياً (Local Quickstart)

```bash
# 1. استنساخ المستودع
git clone https://github.com/<your-username>/boutiqflow-dz.git
cd boutiqflow-dz

# 2. إعداد متغيرات البيئة
cp .env.example .env

# 3. تشغيل الاختبارات وفحص السلامة الكامل (100% Pass)
bash scripts/verify.sh

# 4. تشغيل خادم المنصة
node src/server.js
```

افتح المتصفح على الرابط: `http://localhost:3000` للوصول للواجهة التفاعلية.

---

## 🐳 النشر باستخدام Docker Compose (Production Deployment)

يتضمن المشروع ملفات جاهزة للإنتاج (`Dockerfile`, `docker-compose.yml`, `Caddyfile`) مع شهادات SSL تلقائية من Let's Encrypt:

```bash
# تشغيل جميع الخدمات (Node.js App + PostgreSQL + Caddy TLS Reverse Proxy)
docker-compose up -d --build

# فحص صحة الخادم
curl -s http://localhost:3000/api/health
```

---

## 🧪 التحقق والاختبارات الآلية (Verification Suite)

يحتوي المستودع على أكثر من 112 جناح اختبار تغطي كافة السيناريوهات والعمليات الحساسة:

```bash
# تشغيل كل الفحوصات الأمنية والانحدار واختبارات الضغط
npm run verify
```

---

## 📁 هيكلية المشروع (Project Structure)

```text
├── src/
│   ├── auth/          # المصادقة، التشفير وإدارة الجلسات
│   ├── billing/       # الخطط، الاشتراكات، الفواتير والمدفوعات
│   ├── catalog/       # المنتجات، مصفوفة المقاسات والألوان EAN-13
│   ├── compliance/    # سجل المعالجة، الدفتر المؤتمت، قانون 25-11
│   ├── connectors/    # موصلات Shopify وWooCommerce
│   ├── couriers/      # موصلات شركات التوصيل الجزائرية
│   ├── db/            # محرك قاعدة البيانات مع عزل RLS المتشدد
│   ├── finance/       # حساب الأرباح الحقيقية P&L والمصروفات
│   ├── inventory/     # دفتر أستاذ المخزون الموحد والحجوزات
│   ├── offline/       # المزامنة غير المتصلة وإدارة الأجهزة
│   ├── orders/        # طلبيات الدفع عند الاستلام COD وتأكيد الاتصال
│   ├── pos/           # نقطة البيع Caisse والطباعة الحرارية ESC/POS
│   ├── rbac/          # مصفوفة الصلاحيات (Owner, Cashier, etc.)
│   ├── reporting/     # التقارير، التحليلات، ونماذج القراءة
│   └── security/      # إدارة المفاتيح، نسخ الاحتياط واستعادة الكوارث
├── docs/              # التوثيق الشامل، الأدلة القانونية ومعمارية النظام
├── migrations/        # ملفات ترحيل قاعدة البيانات وسياسات RLS
├── scripts/           # سكربتات التحقق، الفحص الأمني، والـCI
└── tests/             # أجنحة الاختبارات الآلية (112+ جناح اختبار)
```

---

## 📜 الترخيص (License)

هذا البرنامج محمي بحقوق الملكية الفكرية لصالح مالك المشروع. للاستخدام التجاري أو الشخصي وفقاً للشروط المحددة.
