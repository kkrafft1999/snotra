/**
 * Selbst-Update (Issue #232).
 *
 * Ein einziger Dialog fuehrt durch den ganzen Vorgang: gefunden → wird geladen
 * → bereit → wird installiert. Jeder Uebergang ist ein Klick des Nutzers, nie
 * ein Automatismus — die App laedt nichts, ohne gefragt zu haben, und
 * installiert nichts, ohne noch einmal gefragt zu haben.
 *
 * Abbrechen geht bis einschliesslich „bereit": waehrend des Downloads bricht
 * der Knopf den Strom wirklich ab, danach verwirft „Abbrechen" die geladene
 * Datei. Erst ab „wird installiert" gibt es kein Zurueck mehr; das steht dann
 * auch so im Dialog, statt einen wirkungslosen Knopf anzubieten.
 *
 * Die Daten kommen aus dem PUSH-Kanal update:available (Auto-Check beim Start
 * oder manueller Check aus dem Menue) und dem Fortschritt aus update:progress.
 * Adressen kennt dieser Code nicht — der Renderer stoesst nur an, geladen wird
 * ausschliesslich, was der Main-Prozess selbst bei GitHub nachgeschlagen hat.
 */

import { t, onLocaleChange } from '../i18n.js';

const FOCUSABLE = 'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** Bytes als „12,4 MB" — eine Nachkommastelle reicht, um Bewegung zu sehen. */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const mb = value / (1024 * 1024);
  if (mb < 1) return `${(value / 1024).toFixed(0)} kB`;
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

/**
 * Macht aus den Release-Notizen von GitHub eine schlichte Aufzaehlung.
 *
 * GitHub setzt seine Notizen automatisch zusammen: eine Ueberschrift
 * „What's Changed", je Aenderung eine Zeile „… by @name in <PR-Link>" und
 * zum Schluss einen Vergleichs-Link. Im Dialog interessiert davon nur, *was*
 * sich geaendert hat — wer es gemacht hat und unter welcher Nummer, steht auf
 * der Release-Seite. Also bleibt hier die nackte Aufzaehlung stehen.
 */
function formatReleaseNotes(notes) {
  const lines = String(notes || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  // „New Contributors" ist eine reine Namensliste — die faellt komplett weg.
  let skipping = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s{0,3}(\*\*)?Full Changelog(\*\*)?\s*:/i.test(line)) continue;

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*$/);
    if (heading) {
      const text = heading[1];
      skipping = /^new contributors$/i.test(text);
      if (skipping || /^what'?s changed$/i.test(text)) continue;
      out.push(text);
      continue;
    }
    if (skipping) continue;

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const text = stripAuthorAndLink(bullet[2]);
      if (text) out.push(`${bullet[1]}• ${text}`);
      continue;
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** „Titel by @name in https://…/pull/42" → „Titel". */
function stripAuthorAndLink(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+in\s+<?https?:\/\/\S+>?\s*$/i, '')
    .replace(/\s+by\s+@[^\s]+\s*$/i, '')
    .replace(/\s*<?https?:\/\/\S+>?\s*$/, '')
    .trim();
}

export function initUpdateDialog({ api }) {
  const root = document.getElementById('modal-update');
  const backdrop = document.getElementById('modal-update-backdrop');
  const dialog = root?.querySelector('.update-dialog');
  const titleEl = document.getElementById('modal-update-title');
  const summaryEl = document.getElementById('modal-update-summary');
  const hintEl = document.getElementById('modal-update-hint');
  const notesEl = document.getElementById('modal-update-notes');
  const notesBodyEl = document.getElementById('modal-update-notes-body');
  const progressEl = document.getElementById('modal-update-progress');
  const trackEl = document.getElementById('modal-update-track');
  const barEl = document.getElementById('modal-update-bar');
  const progressTextEl = document.getElementById('modal-update-progress-text');
  const actionsEl = document.getElementById('modal-update-actions');
  const footerEl = document.getElementById('modal-update-footer');
  const closeBtn = document.getElementById('modal-update-close');

  if (!root || !api?.onUpdateAvailable || !actionsEl) {
    return { checkNow: async () => {}, isOpen: () => false };
  }

  /** Letzter Befund des Main-Prozesses; Grundlage aller Texte im Dialog. */
  let info = null;
  /** Aufbereitete Aenderungsliste; leer heisst: es gibt nichts zu zeigen. */
  let notesText = '';
  /** 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'info' */
  let state = 'available';
  let lastMessage = '';
  let lastFocused = null;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  /** Waehrend Download und Installation bleibt der Dialog stehen. */
  function isDismissable() {
    return state !== 'downloading' && state !== 'installing';
  }

  function close() {
    if (!isOpen()) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    const back = lastFocused;
    lastFocused = null;
    if (back && back.isConnected) back.focus();
  }

  function open() {
    if (!isOpen()) {
      lastFocused = document.activeElement;
      root.classList.remove('hidden');
      root.setAttribute('aria-hidden', 'false');
    }
  }

  function makeButton(label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setProgress({ receivedBytes, totalBytes }) {
    progressEl.classList.remove('hidden');
    const known = Number(totalBytes) > 0;
    const percent = known
      ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100)))
      : 0;
    // Ohne Content-Length gibt es keinen sinnvollen Balkenstand — dann laeuft
    // eine unbestimmte Animation statt einer erfundenen Prozentzahl.
    trackEl.classList.toggle('update-progress__track--indeterminate', !known);
    barEl.style.width = known ? `${percent}%` : '';
    if (known) {
      trackEl.setAttribute('aria-valuenow', String(percent));
      progressTextEl.textContent =
        t('update.progress', { percent, received: formatBytes(receivedBytes), total: formatBytes(totalBytes) });
    } else {
      trackEl.removeAttribute('aria-valuenow');
      progressTextEl.textContent = `${formatBytes(receivedBytes)} geladen`;
    }
  }

  function focusFirstAction() {
    const first = actionsEl.querySelector(FOCUSABLE);
    if (first) first.focus();
    else closeBtn.focus();
  }

  async function openReleasePage() {
    if (!info?.releaseUrl || !api.openExternal) return;
    try {
      const result = await api.openExternal(info.releaseUrl);
      if (result && result.ok === false) {
        render('error', t('update.releasePage.failed', { error: result.error || t('mcpImport.failed.unknown') }));
      }
    } catch {
      render('error', t('update.releasePage.failedPlain'));
    }
  }

  async function skipVersion() {
    try { await api.ignoreUpdateVersion(info?.latestVersion); } catch { /* egal */ }
    close();
  }

  async function startDownload() {
    render('downloading');
    setProgress({ receivedBytes: 0, totalBytes: info?.asset?.size || 0 });
    let result;
    try {
      result = await api.downloadUpdate();
    } catch (err) {
      result = { ok: false, error: err?.message || t('update.download.failed') };
    }
    if (result?.canceled) {
      render('available');
      return;
    }
    if (!result?.ok) {
      render('error', result?.error || t('update.download.failed'));
      return;
    }
    render('ready');
  }

  async function cancelDownload() {
    try { await api.cancelUpdateDownload(); } catch { /* der Lauf endet ohnehin */ }
  }

  async function discardDownload() {
    try { await api.discardUpdateDownload(); } catch { /* egal */ }
    // Erst zurueck auf „verfuegbar" stellen, dann schliessen: sonst faende
    // focusFirstAction() Knoepfe in einem bereits unsichtbaren Dialog.
    render('available');
    close();
  }

  async function startInstall() {
    render('installing');
    let result;
    try {
      result = await api.installUpdate();
    } catch (err) {
      result = { ok: false, error: err?.message || t('update.install.failed') };
    }
    // Im Erfolgsfall beendet sich die App — hierher kommt nur der Fehlerfall.
    if (!result?.ok) render('error', result?.error || t('update.install.failed'));
  }

  /** Baut Titel, Text und Knoepfe fuer den aktuellen Schritt neu auf. */
  function render(next, message = '') {
    state = next;
    // Nur die Zustaende mit eigenem Text merken sich einen; ein Wechsel nach
    // 'available' soll die Fehlermeldung nicht mitschleppen.
    if (next === 'error' || next === 'info') lastMessage = message;

    const version = info?.latestVersion || '';
    const current = info?.currentVersion || '';
    const canSelfUpdate = info?.canSelfUpdate === true;

    actionsEl.replaceChildren();
    hintEl.classList.add('hidden');
    hintEl.classList.remove('error');
    progressEl.classList.add('hidden');
    // Die Aenderungsliste hilft nur bei der Entscheidung „laden/installieren?".
    // Waehrend des Ladens, beim Einspielen und im Fehlerfall lenkt sie ab.
    const notesHelpHere = next === 'available' || next === 'ready';
    notesEl.classList.toggle('hidden', !notesHelpHere || !notesText);
    root.classList.toggle('modal-update--busy', !isDismissable());
    closeBtn.disabled = !isDismissable();

    if (next === 'available') {
      const tag = info?.isPrerelease ? t('update.prerelease') : '';
      const size = info?.asset?.size ? ` (${formatBytes(info.asset.size)})` : '';
      titleEl.textContent = t('update.available.title', { version, tag });
      // Die Groesse steht im Text, nicht auf dem Knopf: drei Knoepfe muessen
      // in eine Zeile passen, sonst rutscht der letzte allein in die zweite.
      summaryEl.textContent = canSelfUpdate
        ? t('update.available.selfUpdate', { current, size })
        : t('update.available.manual', { current });
      if (!canSelfUpdate) {
        hintEl.textContent = info?.selfUpdateBlockedReason
          || t('update.available.manualHint');
        hintEl.classList.remove('hidden');
        actionsEl.appendChild(makeButton(t('update.openReleasePage'), 'btn-primary', openReleasePage));
      } else {
        actionsEl.appendChild(makeButton(t('update.download'), 'btn-primary', startDownload));
      }
      // Beide Knoepfe schliessen den Dialog, aber nur einer davon fuer immer.
      // Das steht jetzt in der Beschriftung statt in einem Titel-Text, den
      // per Tastatur ohnehin niemand zu sehen bekommt. „Überspringen" wirkt
      // dauerhaft und steht deshalb leise und abgesetzt links — auffindbar
      // fuer den, der es sucht, kein Nachbar der Hauptaktion fuer den, der
      // nur wegklicken will (die Reihenfolge macht das CSS).
      actionsEl.appendChild(makeButton(t('update.remindLater'), 'btn-secondary', close));
      actionsEl.appendChild(makeButton(t('update.skipVersion'), 'btn-tertiary', skipVersion));
    } else if (next === 'downloading') {
      titleEl.textContent = t('update.downloading.title', { version });
      summaryEl.textContent = t('update.downloading.body');
      progressEl.classList.remove('hidden');
      actionsEl.appendChild(makeButton(t('update.cancel'), 'btn-secondary', cancelDownload));
    } else if (next === 'ready') {
      titleEl.textContent = t('update.ready.title', { version });
      summaryEl.textContent = t('update.ready.body');
      actionsEl.appendChild(makeButton(t('update.ready.install'), 'btn-primary', startInstall));
      actionsEl.appendChild(makeButton(t('update.cancel'), 'btn-secondary', discardDownload));
    } else if (next === 'installing') {
      titleEl.textContent = t('update.installing.title', { version });
      summaryEl.textContent = t('update.installing.body');
      progressEl.classList.remove('hidden');
      trackEl.classList.add('update-progress__track--indeterminate');
      trackEl.removeAttribute('aria-valuenow');
      barEl.style.width = '';
      progressTextEl.textContent = t('update.installing.progress');
    } else if (next === 'error') {
      titleEl.textContent = t('update.error.title');
      summaryEl.textContent = lastMessage;
      hintEl.textContent = t('update.error.body');
      hintEl.classList.remove('hidden');
      if (canSelfUpdate) {
        actionsEl.appendChild(makeButton(t('update.retry'), 'btn-primary', startDownload));
      }
      if (info?.releaseUrl) {
        actionsEl.appendChild(makeButton(t('update.openReleasePage'), canSelfUpdate ? 'btn-secondary' : 'btn-primary', openReleasePage));
      }
      actionsEl.appendChild(makeButton(t('update.closeButton'), 'btn-secondary', close));
    } else if (next === 'info') {
      titleEl.textContent = t('update.none.title');
      summaryEl.textContent = lastMessage;
      notesEl.classList.add('hidden');
      actionsEl.appendChild(makeButton(t('update.closeButton'), 'btn-primary', close));
    }

    // Waehrend der Installation gibt es nichts zu entscheiden. Eine leere
    // Fussleiste sieht aus wie ein abgeschnittener Dialog — also weg damit.
    footerEl?.classList.toggle('hidden', actionsEl.childElementCount === 0);

    focusFirstAction();
  }

  function showNotes(notes) {
    notesText = formatReleaseNotes(notes);
    notesBodyEl.textContent = notesText;
    notesEl.open = false;
  }

  function handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.updateAvailable) {
      info = payload;
      showNotes(payload.notes);
      open();
      render('available');
      return;
    }
    // Ohne Update meldet sich nur der von Hand angestossene Check zurueck —
    // ein stiller Start-Check bleibt still.
    if (!payload.manual) return;
    info = payload;
    open();
    render('info', payload.error
      ? t('update.check.failed', { error: payload.error })
      : t('update.check.upToDate', { version: payload.currentVersion }));
  }

  api.onUpdateAvailable(handlePayload);
  api.onUpdateProgress?.((progress) => {
    if (state === 'downloading' && progress) setProgress(progress);
  });

  backdrop?.addEventListener('click', () => { if (isDismissable()) close(); });
  closeBtn.addEventListener('click', () => { if (isDismissable()) close(); });

  // Fokus-Kaefig: Tab laeuft im Dialog im Kreis, Escape schliesst ihn, solange
  // nichts laeuft, das man nicht einfach stehen lassen kann.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (isDismissable()) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    // Sichtbarkeit ueber `.hidden` am Vorfahren statt ueber offsetParent —
    // der Dialog blendet genau so aus, und es bleibt ohne Layout pruefbar.
    const items = Array.from(dialog?.querySelectorAll(FOCUSABLE) || [])
      .filter((el) => !el.disabled && !el.closest('.hidden'));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /** „Nach Updates suchen…" aus dem Menue. */
  async function checkNow() {
    if (!api.checkForUpdate) return;
    try {
      const result = await api.checkForUpdate();
      handlePayload({ ...result, manual: true });
    } catch {
      info = null;
      open();
      render('info', t('update.check.failedPlain'));
    }
  }

  // Language change (epic #277): the dialog builds title, text and buttons
  // itself. Closed, there is nothing to draw — the next step does it anyway.
  onLocaleChange(() => {
    if (!isOpen()) return;
    render(state, lastMessage);
  });

  return { checkNow, isOpen };
}

export { formatBytes, formatReleaseNotes };
