// How long a turn took (#1254): a quiet line under its last message — the
// answer, or the error below it. The time runs from the moment main had the
// question until the run ended, waiting for an approval included; main takes
// it and stores it with the message, so a chat opened again shows it too.
// A chat saved before has no duration and shows no line.

import { t, getLocale } from '../i18n.js';
import { formatElapsedLabel } from '../utils/tool-log-summary.js';

// A clock, drawn for 16 px like the other glyphs in the chat.
const CLOCK_ICON_HTML = '<svg class="chat-turn-duration-icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

/**
 * The duration a message carries, or null.
 * @param {unknown} message
 * @returns {number|null}
 */
export function turnDurationOf(message) {
  const ms = /** @type {{ durationMs?: unknown }} */ (message)?.durationMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * "4.2 sec", "42 sec", "3:05 min", "1:02:10 h" — in the language of the interface.
 * Seconds as a number while they are few, a clock once there are minutes.
 * @param {number} ms
 */
export function formatTurnDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  const whole = Math.round(seconds);
  if (whole < 60) {
    const fine = seconds < 9.95;
    return new Intl.NumberFormat(getLocale(), {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'short',
      maximumFractionDigits: fine ? 1 : 0,
    }).format(fine ? seconds : whole);
  }
  // Rounded like the seconds above: 59.6 s reads "1:00 min", not "0:59 min".
  const clock = formatElapsedLabel(whole * 1000);
  return whole >= 3600 ? t('chat.duration.hours', { clock }) : t('chat.duration.minutes', { clock });
}

/**
 * "Answered in 4.2 sec", "Stopped after 12 sec", "Failed after 3.1 sec".
 * @param {{ isError?: boolean, stopped?: boolean }} message
 * @param {number} ms
 */
export function describeTurnDuration(message, ms) {
  const time = formatTurnDuration(ms);
  if (message.isError) return t('chat.duration.failed', { time });
  if (message.stopped) return t('chat.duration.stopped', { time });
  return t('chat.duration.answered', { time });
}

/**
 * The line under a turn's last message, or null when it has no duration.
 * Plain text, so a copied chat keeps it.
 * @param {{ isError?: boolean, stopped?: boolean, durationMs?: number }} message
 * @returns {HTMLElement|null}
 */
export function buildTurnDurationLine(message) {
  const ms = turnDurationOf(message);
  if (ms === null) return null;
  const line = document.createElement('p');
  line.className = 'chat-turn-duration';
  line.title = t('chat.duration.hint');
  line.insertAdjacentHTML('afterbegin', CLOCK_ICON_HTML);
  const text = document.createElement('span');
  text.textContent = describeTurnDuration(message, ms);
  line.appendChild(text);
  return line;
}
