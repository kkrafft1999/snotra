// Update-Notifier-Banner (Stufe 1). Zeigt dezent oben an, wenn eine neuere
// Version verfuegbar ist, und verlinkt auf die Release-Seite. Es wird nichts
// automatisch heruntergeladen — der Download laeuft ueber den Browser.
//
// Quelle der Daten: PUSH-Kanal update:available aus dem Main-Prozess, entweder
// vom Auto-Check beim Start (manual=false) oder von einem manuellen Check
// (manual=true), bei dem auch "Du bist aktuell" / Fehler angezeigt werden.

const AUTO_HIDE_MS = 6000;

export function initUpdateBanner({ api }) {
  if (!api?.onUpdateAvailable) return { checkNow: async () => {} };

  const host = document.getElementById('app');
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner hidden';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  if (host && host.parentNode) {
    host.parentNode.insertBefore(banner, host);
  } else {
    document.body.insertBefore(banner, document.body.firstChild);
  }

  let autoHideTimer = null;

  function clearAutoHide() {
    if (autoHideTimer !== null) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }

  function hide() {
    clearAutoHide();
    banner.classList.add('hidden');
    banner.replaceChildren();
  }

  function makeButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderUpdate(payload) {
    clearAutoHide();
    banner.classList.remove('update-banner--info');
    banner.replaceChildren();

    const text = document.createElement('span');
    text.className = 'update-banner-text';
    const tag = payload.isPrerelease ? ' (Vorab-Version)' : '';
    text.textContent = `Neue Version ${payload.latestVersion} verfügbar${tag} – aktuell ${payload.currentVersion}.`;
    banner.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'update-banner-actions';
    actions.appendChild(makeButton('Herunterladen', 'btn-primary', async () => {
      if (!payload.releaseUrl) return;
      // Der Main-Prozess oeffnet den Link; scheitert das, bleibt die Meldung
      // stehen, statt das Banner wortlos verschwinden zu lassen (Issue #64).
      let result;
      try {
        result = await api.openExternal(payload.releaseUrl);
      } catch {
        result = { ok: false };
      }
      if (result && result.ok === false) {
        renderInfo(`Release-Seite konnte nicht geöffnet werden: ${result.error || 'unbekannter Fehler'}`);
        return;
      }
      hide();
    }));
    actions.appendChild(makeButton('Überspringen', 'btn-secondary', async () => {
      try { await api.ignoreUpdateVersion(payload.latestVersion); } catch { /* ignore */ }
      hide();
    }));
    const close = makeButton('×', 'update-banner-close', hide);
    close.setAttribute('aria-label', 'Schließen');
    actions.appendChild(close);
    banner.appendChild(actions);

    banner.classList.remove('hidden');
  }

  function renderInfo(message) {
    clearAutoHide();
    banner.classList.add('update-banner--info');
    banner.replaceChildren();

    const text = document.createElement('span');
    text.className = 'update-banner-text';
    text.textContent = message;
    banner.appendChild(text);

    const close = makeButton('×', 'update-banner-close', hide);
    close.setAttribute('aria-label', 'Schließen');
    banner.appendChild(close);

    banner.classList.remove('hidden');
    autoHideTimer = setTimeout(hide, AUTO_HIDE_MS);
  }

  function handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.updateAvailable) {
      renderUpdate(payload);
    } else if (payload.manual) {
      // Rueckmeldung nur bei manuellem Check, sonst still bleiben.
      renderInfo(payload.error
        ? `Update-Prüfung fehlgeschlagen: ${payload.error}`
        : `Du bist aktuell (Version ${payload.currentVersion}).`);
    }
  }

  api.onUpdateAvailable(handlePayload);

  async function checkNow() {
    if (!api.checkForUpdate) return;
    try {
      const result = await api.checkForUpdate();
      handlePayload({ ...result, manual: true });
    } catch {
      renderInfo('Update-Prüfung fehlgeschlagen.');
    }
  }

  return { checkNow };
}
