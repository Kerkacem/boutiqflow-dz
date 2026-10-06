# دليل نشر مشروع BoutiqFlow DZ على حسابك الشخصي في GitHub

هذا الدليل يوضح لك بالخطوات السهلة كيفية رفع المشروع بالكامل إلى حسابك الشخصي على **GitHub** وتشغيله.

---

## 📋 الخطوة 1: إنشاء مستودع جديد على GitHub (Create New Repository)

1. سجل الدخول إلى حسابك في [GitHub](https://github.com).
2. اضغط على علامة **`+`** في الزاوية العلوية واقترح **New repository**.
3. املأ البيانات كالتالي:
   - **Repository name**: `boutiqflow-dz` (أو أي اسم تفضله مثل `mahal-saas`).
   - **Description**: `نظام إدارة محلات الملابس والتجارة الإلكترونية في الجزائر (POS + COD + SaaS)`.
   - **Public / Private**: اختر **Private** لحماية الكود التجاري الخاص بك، أو **Public**.
   - ⚠️ **هام جداً**: **لا تقم** بوضع علامة على `Add a README file` أو `Add .gitignore` لأنها موجودة وجاهزة داخل المشروع بالفعل.
4. اضغط على زر **Create repository**.

---

## 💻 الخطوة 2: ربط المشروع المحلي بمستودع GitHub ورفع الكود (Git Push)

افتح موجه الأوامر (Terminal أو Git Bash) داخل مجلد المشروع، ثم نفّذ الأوامر التالية:

```bash
# 1. التأكد من وجودك في المسار الصحيح للمشروع
cd /مسار/المشروع/boutiqflow-dz

# 2. التحقق من حالة الملفات
git status

# 3. تسمية الفرع الأساسي main
git branch -M main

# 4. ربط المستودع برابط GitHub الخاص بك (استبدل YOUR_USERNAME و REPO_NAME بروابطك الفعلية)
git remote add origin https://github.com/YOUR_USERNAME/boutiqflow-dz.git

# 5. رفع كل الفروع والتاريخ والملفات بالكامل إلى GitHub
git push -u origin main
```

> **ملاحظة بخصوص كلمة المرور في GitHub**:
> إذا طلب منك GitHub إدخال كلمة المرور، يجب عليك استخدام **Personal Access Token (PAT)** بدلاً من كلمة المرور العادية. يمكنك إنشاؤها من:  
> `GitHub Settings` $\to$ `Developer settings` $\to$ `Personal access tokens` $\to$ `Tokens (classic)` $\to$ تفعيل صلاحية `repo`.

---

## ⚙️ الخطوة 3: إعداد GitHub Actions للفحص الآلي (CI/CD)

يحتوي المشروع بالفعل على مسار عمل جاهز في المسار:
`.github/workflows/ci.yml`

بمجرد رفع الكود (Push)، سيبدأ GitHub Actions تلقائياً في تشغيل:
- فحص سلامة التنسيق (Linter).
- التحقق من العقود والأنواع (Typecheck).
- فحص الأمان والثغرات وشهادات الـRLS (Security Scan).
- التحقق من الامتثال لقانون حماية البيانات الجزائري (Privacy CI Gate).
- تشغيل كافة أجنحة الاختبارات الآلية للتأكد من خلو المشروع من أي خلل.

---

## 🚀 الخطوة 4: تشغيل المنصة على خادم سحابي (VPS Deployment)

عندما ترغب بنشر المنصة على خادم VPS (مثل DigitalOcean, Hetzner, OVH, أو خادم محلي):

1. قم بتثبيت **Docker** و **Docker Compose** على الخادم.
2. استنسخ المستودع:
   ```bash
   git clone https://github.com/YOUR_USERNAME/boutiqflow-dz.git
   cd boutiqflow-dz
   ```
3. أنشئ ملف الإعدادات `.env`:
   ```bash
   cp .env.example .env
   # قم بتعديل كلمات المرور والمفاتيح في ملف .env
   ```
4. شغّل المنصة بأمر واحد:
   ```bash
   docker-compose up -d --build
   ```
5. سيعمل خادم Caddy تلقائياً على إصدار شهادة SSL مشفرة وتأمين المنصة عبر HTTPS.

---

## 📦 محتويات الحزمة المرفقة
الحزمة المضغوطة `boutiqflow-dz-full-source.zip` تحتوي على:
- كامل الشيفرة المصدرية (جميع الـ14 مرحلة المعمارية).
- كافة اختبارات الموثوقية والأمان والـRed-Team.
- ملفات التشغيل والإنتاج والحاويات (`Dockerfile`, `docker-compose.yml`, `Caddyfile`).
- الوثائق القانونية والتقنية الشاملة.
