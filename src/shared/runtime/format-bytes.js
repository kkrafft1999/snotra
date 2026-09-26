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
  const i = Math.min(Math.max(Math.floor(Math.log(value) / Math.log(1024)), 0), UNITS.length - 1);
  const scaled = value / 1024 ** i;
  const text = i === 0
    ? String(Math.round(scaled))
    : scaled.toFixed(1).replace('.', translate(locale, 'format.decimal'));
  return `${text} ${UNITS[i]}`;
}

module.exports = { formatBytes };
