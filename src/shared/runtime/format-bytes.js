/**
 * Dateigrößen für Nutzertexte im Main-Prozess (Issue #101).
 *
 * Dieselbe Staffelung wie `formatSize` im Renderer
 * (src/renderer/utils/helpers.js), nur als CommonJS, damit Service und
 * IPC-Handler sie nutzen können. Die Einheiten heißen in beiden Sprachen
 * gleich; was sich unterscheidet, ist das Dezimaltrennzeichen — deshalb kommt
 * es seit #292 aus dem Katalog statt aus einem festen Komma.
 */
'use strict';

const { translate } = require('../i18n');

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes, locale) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value === 0) return '0 B';
  // Below one byte the logarithm turns negative; clamp to 'B' instead of UNITS[-1].
  let i = Math.min(Math.max(Math.floor(Math.log(value) / Math.log(1024)), 0), UNITS.length - 1);
  const rounded = (unit) => (unit === 0 ? String(Math.round(value)) : (value / 1024 ** unit).toFixed(1));
  // The unit is chosen after rounding (#650): 1,048,575 B is 1023.999 KB,
  // which one decimal turns into "1024.0 KB" — that reads "1.0 MB".
  if (i < UNITS.length - 1 && Number(rounded(i)) >= 1024) i += 1;
  const text = i === 0 ? rounded(0) : rounded(i).replace('.', translate(locale, 'format.decimal'));
  return `${text} ${UNITS[i]}`;
}

module.exports = { formatBytes };
