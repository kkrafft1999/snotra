/**
 * Laufende Version als Badge neben der Wortmarke (Issue #153).
 *
 * Der native Fenstertitel traegt die Version zwar (src/main/window.js), macOS
 * zeichnet ihn bei `titleBarStyle: 'hiddenInset'` aber nicht — sichtbar wird
 * sie erst hier im Renderer.
 *
 * Die Version kommt ueber denselben Weg wie in den Einstellungen
 * (`api.getAppVersion()`), damit es nur eine Quelle gibt. Bis die Antwort da
 * ist, bleibt das Element `hidden`: ein leerer Badge waere ein sichtbarer
 * Rahmen ohne Inhalt.
 */
export async function initAppVersionBadge({ api, element = document.getElementById('app-version') } = {}) {
  if (!element || !api || typeof api.getAppVersion !== 'function') return null;

  try {
    const info = await api.getAppVersion();
    const version = info && typeof info.version === 'string' ? info.version.trim() : '';
    if (!version) return null;

    element.textContent = version;
    // Der Badge sitzt neben der Wortmarke und ergaebe vorgelesen nur "1.6.0".
    element.setAttribute('aria-label', `Version ${version}`);
    element.hidden = false;
    return version;
  } catch {
    // Ohne Version bleibt der Badge weg — lieber nichts als ein leerer Rahmen.
    return null;
  }
}
