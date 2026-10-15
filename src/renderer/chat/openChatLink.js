import { isOpenableLink } from '../utils/helpers.js';
import { t, tMessage } from '../i18n.js';
import manualAddress from '../generated/manual-address.js';

const { parseManualAddress } = manualAddress;

/**
 * Oeffnen von Links aus Modellantworten (Issues #82, #83).
 *
 * Der Renderer darf `shell.openExternal` nicht selbst rufen (sandboxed
 * Preload), also geht jeder Klick ueber den Main-Prozess. Die Logik liegt hier
 * statt im Klick-Handler, damit sie ohne DOM testbar ist.
 */

/** Klickbar ist nur, was der Markdown-Sanitizer auch stehen laesst. */
export function isOpenableChatLink(href) {
  return isOpenableLink(href);
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
    return { ok: false, error: t('chat.link.error.notOpenable') };
  }
  // A page of the manual opens in the help window, in the version that is
  // installed (#947). Main says no when the bundle lacks the page; then the
  // browser gets the address as before.
  const page = parseManualAddress(href);
  if (page && typeof api?.openManual === 'function') {
    try {
      const result = await api.openManual({ slug: page.slug, fragment: page.fragment });
      if (result?.ok) return { ok: true };
    } catch {
      // Falls through to the browser.
    }
  }
  if (typeof api?.openExternal !== 'function') {
    return { ok: false, error: t('chat.link.error.noEnvironment') };
  }
  try {
    const result = await api.openExternal(href);
    if (result?.ok) return { ok: true };
    return { ok: false, error: result?.error ? tMessage(result.error) : t('chat.link.error.failed') };
  } catch (e) {
    return { ok: false, error: e?.message || t('chat.link.error.failed') };
  }
}
