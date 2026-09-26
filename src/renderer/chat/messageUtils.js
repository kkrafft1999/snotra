/**
 * Renderer-Hilfen für Chat-Verlauf — nur DOM/Zeitformatierung.
 * Titel, Sanitisierung und Loaded-Message-Form leben in Main/Storage.
 */

import { getLocale } from '../i18n.js';

// The interface language decides the form, not the machine's locale (#290, #375).
export function formatHistoryTime(ts, now = new Date()) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}
