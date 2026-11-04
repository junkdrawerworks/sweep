// Lengths and areas the way people read them: feet and inches to the nearest inch, or metres to the centimetre.

export const INCH = 0.0254;
export const SQFT = 0.09290304;

export function defaultUnits(lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US') {
  return /^en-(US|LR)$|^my\b/i.test(lang) ? 'ft' : 'm';
}

export function fmtLength(m, units = 'ft') {
  if (!Number.isFinite(m)) return '–';
  if (units === 'm') return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;
  const inches = Math.round(m / INCH);
  const ft = Math.floor(inches / 12);
  const inch = inches - ft * 12;
  return ft === 0 ? `${inch}″` : `${ft}′ ${inch}″`;
}

export function fmtArea(m2, units = 'ft') {
  if (!Number.isFinite(m2)) return '–';
  return units === 'm' ? `${m2.toFixed(1)} m²` : `${Math.round(m2 / SQFT).toLocaleString('en-US')} sq ft`;
}

export function fmtSize(w, h, units = 'ft') { return `${fmtLength(w, units)} × ${fmtLength(h, units)}`; }

// Reads a typed length into metres: 12' 4", 12ft 4in, 12'4, 148", 148 in, 12.5', 3.76 m, 376 cm, 3760 mm.
// A bare number is feet (with units 'ft') or metres (with units 'm'); with feet, two bare numbers are feet and
// inches ("12 4"), which is quicker on a phone's keyboard. Returns null if it can't read it.
export function parseLength(text, units = 'ft') {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/,/g, '.');
  if (!t) return null;
  const num = '(\\d+(?:\\.\\d+)?)';
  let m;
  if ((m = t.match(new RegExp(`^${num}\\s*(?:'|ft|feet|foot)\\s*(?:${num}\\s*(?:"|in|inch|inches)?)?$`)))) {
    return (parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0)) * INCH;
  }
  if ((m = t.match(new RegExp(`^${num}\\s*(?:"|in|inch|inches)$`)))) return parseFloat(m[1]) * INCH;
  if ((m = t.match(new RegExp(`^${num}\\s*mm$`)))) return parseFloat(m[1]) / 1000;
  if ((m = t.match(new RegExp(`^${num}\\s*cm$`)))) return parseFloat(m[1]) / 100;
  if ((m = t.match(new RegExp(`^${num}\\s*(?:m|metres|meters|metre|meter)$`)))) return parseFloat(m[1]);
  if ((m = t.match(new RegExp(`^${num}$`)))) return units === 'm' ? parseFloat(m[1]) : parseFloat(m[1]) * 12 * INCH;
  if (units !== 'm' && (m = t.match(new RegExp(`^${num}\\s+${num}$`)))) return (parseFloat(m[1]) * 12 + parseFloat(m[2])) * INCH;
  return null;
}
