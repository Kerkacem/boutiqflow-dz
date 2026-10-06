const test = require('node:test');
const assert = require('node:assert');
const { LOCALES, TRANSLATIONS, getDirection, t } = require('../src/i18n/index');

test('Internationalization & RTL Shell Engine', async (tCase) => {
  await tCase.test('Directionality: Arabic is RTL, French is LTR', () => {
    assert.strictEqual(getDirection(LOCALES.AR), 'rtl', 'Arabic must be RTL');
    assert.strictEqual(getDirection(LOCALES.FR), 'ltr', 'French must be LTR');
  });

  await tCase.test('Catalog Key Parity: ar and fr contain identical translation keys', () => {
    const arKeys = Object.keys(TRANSLATIONS.ar).sort();
    const frKeys = Object.keys(TRANSLATIONS.fr).sort();

    assert.deepStrictEqual(arKeys, frKeys, 'Arabic and French dictionaries must have 100% key parity');
  });

  await tCase.test('Translation lookup with graceful fallback', () => {
    assert.strictEqual(t('app_title', 'ar'), 'محل — نظام إدارة محلات الملابس');
    assert.strictEqual(t('app_title', 'fr'), 'MAHAL — Gestion de Boutiques de Prêt-à-Porter');

    // Non-existent key returns key name gracefully without throwing
    assert.strictEqual(t('non_existent_key', 'ar'), 'non_existent_key');
  });
});
