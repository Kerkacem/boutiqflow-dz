/**
 * Internationalization (i18n) and RTL Layout Engine
 * Arabic (default, RTL) and French (LTR)
 */

const LOCALES = {
  AR: 'ar',
  FR: 'fr'
};

const DEFAULT_LOCALE = LOCALES.AR;

const TRANSLATIONS = {
  ar: {
    // Navigation & Common
    app_title: 'محل — نظام إدارة محلات الملابس',
    welcome: 'مرحباً',
    save: 'حفظ',
    cancel: 'إلغاء',
    confirm: 'تأكيد',
    delete: 'حذف',
    search: 'بحث بالباركود أو الاسم...',
    loading: 'جاري التحميل...',
    error_generic: 'حدث خطأ غير متوقع، يرجى المحاولة لاحقاً',

    // POS & Register
    pos_title: 'نقطة البيع (الكاشير)',
    pos_sell: 'إتمام البيع',
    pos_cart_empty: 'السلة فارغة',
    pos_total: 'المجموع الكلي',
    pos_cash: 'نقداً',
    pos_card: 'بطاقة بنكية',
    pos_credit: 'كريدي (دين)',
    pos_baridimob: 'بريدي موب',
    pos_receipt_number: 'رقم الوصل',
    pos_change_due: 'الباقي للزبون',

    // Roles
    role_owner: 'المالك',
    role_manager: 'المدير',
    role_cashier: 'أمين الصندوق (كاشير)',
    role_stock_clerk: 'مسؤول المخزن',
    role_accountant: 'المحاسب',

    // Errors & Security
    forbidden_cost: 'ليس لديك صلاحية للاطلاع على أسعار التكلفة',
    forbidden_profit: 'ليس لديك صلاحية للاطلاع على تقارير الأرباح',
    forbidden_void: 'ليس لديك صلاحية لإلغاء المبيعات',
    forbidden_export: 'ليس لديك صلاحية لتصدير البيانات'
  },

  fr: {
    // Navigation & Common
    app_title: 'MAHAL — Gestion de Boutiques de Prêt-à-Porter',
    welcome: 'Bienvenue',
    save: 'Enregistrer',
    cancel: 'Annuler',
    confirm: 'Confirmer',
    delete: 'Supprimer',
    search: 'Rechercher par code-barres ou nom...',
    loading: 'Chargement en cours...',
    error_generic: 'Une erreur inattendue est survenue, veuillez réessayer',

    // POS & Register
    pos_title: 'Point de Vente (Caisse)',
    pos_sell: 'Finaliser la vente',
    pos_cart_empty: 'Le panier est vide',
    pos_total: 'Total Général',
    pos_cash: 'Espèces',
    pos_card: 'Carte Bancaire',
    pos_credit: 'Crédit Client',
    pos_baridimob: 'BaridiMob',
    pos_receipt_number: 'N° de Reçu',
    pos_change_due: 'Monnaie Rendue',

    // Roles
    role_owner: 'Propriétaire',
    role_manager: 'Gérant',
    role_cashier: 'Caissier',
    role_stock_clerk: 'Magasinier',
    role_accountant: 'Comptable',

    // Errors & Security
    forbidden_cost: 'Accès refusé: consultation des prix de revient non autorisée',
    forbidden_profit: 'Accès refusé: rapports de marges non autorisés',
    forbidden_void: 'Accès refusé: annulation de vente non autorisée',
    forbidden_export: 'Accès refusé: exportation de données non autorisée'
  }
};

function getDirection(locale = DEFAULT_LOCALE) {
  return locale === LOCALES.AR ? 'rtl' : 'ltr';
}

function t(key, locale = DEFAULT_LOCALE) {
  const dict = TRANSLATIONS[locale] || TRANSLATIONS[DEFAULT_LOCALE];
  return dict[key] || TRANSLATIONS[DEFAULT_LOCALE][key] || key;
}

module.exports = {
  LOCALES,
  DEFAULT_LOCALE,
  TRANSLATIONS,
  getDirection,
  t
};
