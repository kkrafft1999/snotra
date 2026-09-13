/**
 * Dateigrößen für Nutzertexte im Main-Prozess (Issue #101).
 *
 * Deutsche Schreibweise mit Komma als Dezimaltrenner — dieselbe Staffelung
 * wie `formatSize` im Renderer (src/renderer/utils/helpers.js), nur als
 * CommonJS, damit Service und IPC-Handler sie nutzen können.
 */
'use strict';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytesDe(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value === 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const scaled = value / 1024 ** i;
  const text = i === 0 ? String(Math.round(scaled)) : scaled.toFixed(1).replace('.', ',');
  return `${text} ${UNITS[i]}`;
}

module.exports = { formatBytesDe };
