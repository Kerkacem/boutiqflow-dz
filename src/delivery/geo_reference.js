/**
 * BoutiqFlow DZ — Algerian Geographic Reference
 * 58 Wilayas Official Administrative Division & Provider Normalization
 */

const ALGERIA_WILAYAS = Object.freeze([
  { code: '01', name: 'Adrar', nameAr: 'أدرار', zone: 'SOUTH' },
  { code: '02', name: 'Chlef', nameAr: 'الشلف', zone: 'NORTH' },
  { code: '03', name: 'Laghouat', nameAr: 'الأغواط', zone: 'HIGHLANDS' },
  { code: '04', name: 'Oum El Bouaghi', nameAr: 'أم البواقي', zone: 'EAST' },
  { code: '05', name: 'Batna', nameAr: 'باتنة', zone: 'EAST' },
  { code: '06', name: 'Béjaïa', nameAr: 'بجاية', zone: 'NORTH' },
  { code: '07', name: 'Biskra', nameAr: 'بسكرة', zone: 'SOUTH' },
  { code: '08', name: 'Béchar', nameAr: 'بشار', zone: 'SOUTH' },
  { code: '09', name: 'Blida', nameAr: 'البليدة', zone: 'CENTRE' },
  { code: '10', name: 'Bouira', nameAr: 'البويرة', zone: 'CENTRE' },
  { code: '11', name: 'Tamanrasset', nameAr: 'تمنراست', zone: 'SOUTH' },
  { code: '12', name: 'Tébessa', nameAr: 'تبسة', zone: 'EAST' },
  { code: '13', name: 'Tlemcen', nameAr: 'تلمسان', zone: 'WEST' },
  { code: '14', name: 'Tiaret', nameAr: 'تيارت', zone: 'HIGHLANDS' },
  { code: '15', name: 'Tizi Ouzou', nameAr: 'تيزي وزو', zone: 'CENTRE' },
  { code: '16', name: 'Alger', nameAr: 'الجزائر', zone: 'CAPITAL' },
  { code: '17', name: 'Djelfa', nameAr: 'الجلفة', zone: 'HIGHLANDS' },
  { code: '18', name: 'Jijel', nameAr: 'جيجل', zone: 'EAST' },
  { code: '19', name: 'Sétif', nameAr: 'سطيف', zone: 'EAST' },
  { code: '20', name: 'Saïda', nameAr: 'سعيدة', zone: 'WEST' },
  { code: '21', name: 'Skikda', nameAr: 'سكيكدة', zone: 'EAST' },
  { code: '22', name: 'Sidi Bel Abbès', nameAr: 'سيدي بلعباس', zone: 'WEST' },
  { code: '23', name: 'Annaba', nameAr: 'عنابة', zone: 'EAST' },
  { code: '24', name: 'Guelma', nameAr: 'قالمة', zone: 'EAST' },
  { code: '25', name: 'Constantine', nameAr: 'قسنطينة', zone: 'EAST' },
  { code: '26', name: 'Médéa', nameAr: 'المدية', zone: 'CENTRE' },
  { code: '27', name: 'Mostaganem', nameAr: 'مستغانم', zone: 'WEST' },
  { code: '28', name: "M'Sila", nameAr: 'المسيلة', zone: 'HIGHLANDS' },
  { code: '29', name: 'Mascara', nameAr: 'معسكر', zone: 'WEST' },
  { code: '30', name: 'Ouargla', nameAr: 'ورقلة', zone: 'SOUTH' },
  { code: '31', name: 'Oran', nameAr: 'وهران', zone: 'WEST' },
  { code: '32', name: 'El Bayadh', nameAr: 'البيض', zone: 'HIGHLANDS' },
  { code: '33', name: 'Illizi', nameAr: 'إليزي', zone: 'SOUTH' },
  { code: '34', name: 'Bordj Bou Arréridj', nameAr: 'برج بوعريريج', zone: 'EAST' },
  { code: '35', name: 'Boumerdès', nameAr: 'بومرداس', zone: 'CENTRE' },
  { code: '36', name: 'El Tarf', nameAr: 'الطارف', zone: 'EAST' },
  { code: '37', name: 'Tindouf', nameAr: 'تندوف', zone: 'SOUTH' },
  { code: '38', name: 'Tissemsilt', nameAr: 'تيسمسيلت', zone: 'HIGHLANDS' },
  { code: '39', name: 'El Oued', nameAr: 'الوادي', zone: 'SOUTH' },
  { code: '40', name: 'Khenchela', nameAr: 'خنشلة', zone: 'EAST' },
  { code: '41', name: 'Souk Ahras', nameAr: 'سوق أهراس', zone: 'EAST' },
  { code: '42', name: 'Tipaza', nameAr: 'تيبازة', zone: 'CENTRE' },
  { code: '43', name: 'Mila', nameAr: 'ميلة', zone: 'EAST' },
  { code: '44', name: 'Aïn Defla', nameAr: 'عين الدفلى', zone: 'CENTRE' },
  { code: '45', name: 'Naâma', nameAr: 'النعامة', zone: 'HIGHLANDS' },
  { code: '46', name: 'Aïn Témouchent', nameAr: 'عين تموشنت', zone: 'WEST' },
  { code: '47', name: 'Ghardaïa', nameAr: 'غرداية', zone: 'SOUTH' },
  { code: '48', name: 'Relizane', nameAr: 'غليزان', zone: 'WEST' },
  { code: '49', name: 'Timimoun', nameAr: 'تيميمون', zone: 'SOUTH' },
  { code: '50', name: 'Bordj Badji Mokhtar', nameAr: 'برج باجي مختار', zone: 'SOUTH' },
  { code: '51', name: 'Ouled Djellal', nameAr: 'أولاد جلال', zone: 'SOUTH' },
  { code: '52', name: 'Béni Abbès', nameAr: 'بني عباس', zone: 'SOUTH' },
  { code: '53', name: 'In Salah', nameAr: 'عين صالح', zone: 'SOUTH' },
  { code: '54', name: 'In Guezzam', nameAr: 'عين قزام', zone: 'SOUTH' },
  { code: '55', name: 'Touggourt', nameAr: 'تقرت', zone: 'SOUTH' },
  { code: '56', name: 'Djanet', nameAr: 'جانت', zone: 'SOUTH' },
  { code: '57', name: "El M'Ghair", nameAr: 'المغير', zone: 'SOUTH' },
  { code: '58', name: 'El Meniaa', nameAr: 'المنيعة', zone: 'SOUTH' }
]);

const WILAYA_LOOKUP = new Map();

for (const w of ALGERIA_WILAYAS) {
  const normCode = String(parseInt(w.code, 10));
  WILAYA_LOOKUP.set(w.code, w);
  WILAYA_LOOKUP.set(normCode, w);
  WILAYA_LOOKUP.set(w.name.toLowerCase(), w);
  WILAYA_LOOKUP.set(w.nameAr, w);
  // Also strip accents
  const noAccents = w.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  WILAYA_LOOKUP.set(noAccents, w);
}

function normalizeWilaya(input) {
  if (!input) return null;
  const str = String(input).trim();
  const lower = str.toLowerCase();
  const match = WILAYA_LOOKUP.get(str) || WILAYA_LOOKUP.get(lower) || WILAYA_LOOKUP.get(str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
  if (match) return { ...match };

  // Check numeric
  const num = parseInt(str, 10);
  if (!isNaN(num) && num >= 1 && num <= 58) {
    const pad = String(num).padStart(2, '0');
    const m = WILAYA_LOOKUP.get(pad);
    if (m) return { ...m };
  }

  return null;
}

function isValidWilaya(input) {
  return Boolean(normalizeWilaya(input));
}

function listWilayas() {
  return ALGERIA_WILAYAS.map(w => ({ ...w }));
}

function normalizeCommune(communeStr) {
  if (!communeStr || typeof communeStr !== 'string') return '';
  return communeStr.trim();
}

module.exports = {
  ALGERIA_WILAYAS,
  normalizeWilaya,
  isValidWilaya,
  listWilayas,
  normalizeCommune
};
