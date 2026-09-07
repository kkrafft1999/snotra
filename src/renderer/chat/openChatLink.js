import { ALLOWED_LINK_PROTOS } from '../utils/helpers.js';

/**
 * Oeffnen von Links aus Modellantworten (Issues #82, #83).
 *
 * Der Renderer darf `shell.openExternal` nicht selbst rufen (sandboxed
 * Preload), also geht jeder Klick ueber den Main-Prozess. Die Logik liegt hier
 * statt im Klick-Handler, damit sie ohne DOM testbar ist.
 */

/** Klickbar ist nur, was der Markdown-Sanitizer auch stehen laesst. */
export function isOpenableChatLink(href) {
  return typeof href === 'string' && ALLOWED_LINK_PROTOS.test(href.trim());
}

/**
 * Oeffnet den Link ueber den Main-Prozess und liefert immer ein Ergebnis
 * zurueck — nie eine abgewiesene Promise. Ohne das blieb ein fehlgeschlagener
 * Klick unsichtbar (Issue #83) und eine abgewiesene IPC-Promise unbehandelt.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function openChatLink(api, href) {
  if (!isOpenableChatLink(href)) {
    return { ok: false, error: 'Dieser Link kann nicht geöffnet werden.' };
  }
  if (typeof api?.openExternal !== 'function') {
    return { ok: false, error: 'Links können in dieser Umgebung nicht geöffnet werden.' };
  }
  try {
    const result = await api.openExternal(href);
    if (result?.ok) return { ok: true };
    return { ok: false, error: result?.error || 'Link konnte nicht geöffnet werden.' };
  } catch (e) {
    return { ok: false, error: e?.message || 'Link konnte nicht geöffnet werden.' };
  }
}
