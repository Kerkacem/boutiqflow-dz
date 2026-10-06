/**
 * BoutiqFlow DZ — Tenant-Aware Timezone Utilities (INV-09-11)
 * Enforces correct day boundary evaluation in tenant's configured timezone
 * while maintaining pure UTC storage in the database.
 */

const { DEFAULT_TIMEZONE } = require('./constants');

/**
 * Returns YYYY-MM-DD day key for an ISO date string in the tenant timezone
 */
function toTenantDayKey(isoString, timeZone = DEFAULT_TIMEZONE) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(d);
}

/**
 * Returns local hour (0-23) for an ISO date string in the tenant timezone
 */
function toTenantHour(isoString, timeZone = DEFAULT_TIMEZONE) {
  if (!isoString) return 0;
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false
  }).formatToParts(d);
  const hPart = parts.find(p => p.type === 'hour');
  const h = Number(hPart ? hPart.value : 0);
  return h === 24 ? 0 : h;
}

/**
 * Returns local day of week ('Sunday'..'Saturday') in the tenant timezone
 */
function toTenantDayOfWeek(isoString, timeZone = DEFAULT_TIMEZONE) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(d);
}

/**
 * Converts a local date or date-range (YYYY-MM-DD) into exact UTC timestamps [startUtc, endUtc]
 */
function getUtcRangeForLocalDate(dateString, timeZone = DEFAULT_TIMEZONE) {
  if (!dateString) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  const guessUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  }).formatToParts(guessUtc);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const localHour = map.hour === '24' ? 0 : Number(map.hour);
  const localDateFromGuess = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), localHour, Number(map.minute), Number(map.second))
  );

  const offsetMs = localDateFromGuess.getTime() - guessUtc.getTime();
  const startUtc = new Date(guessUtc.getTime() - offsetMs);
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000 - 1);

  return {
    startUtc: startUtc.toISOString(),
    endUtc: endUtc.toISOString()
  };
}

/**
 * Resolves filter date range into UTC start and end bounds
 */
function resolveDateRangeFilter({ dateFrom, dateTo, timeZone = DEFAULT_TIMEZONE }) {
  let startUtc = null;
  let endUtc = null;

  if (dateFrom) {
    if (dateFrom.includes('T')) {
      startUtc = dateFrom;
    } else {
      const range = getUtcRangeForLocalDate(dateFrom, timeZone);
      startUtc = range.startUtc;
    }
  }

  if (dateTo) {
    if (dateTo.includes('T')) {
      endUtc = dateTo;
    } else {
      const range = getUtcRangeForLocalDate(dateTo, timeZone);
      endUtc = range.endUtc;
    }
  }

  return { startUtc, endUtc };
}

module.exports = {
  toTenantDayKey,
  toTenantHour,
  toTenantDayOfWeek,
  getUtcRangeForLocalDate,
  resolveDateRangeFilter
};
