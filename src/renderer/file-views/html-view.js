// HTML in the file preview (#479): the page as it runs, scripts included,
// with a switch back to the source.
//
// The page is not part of this document. The renderer's CSP admits no frame,
// and it stays that way: the main process shows the page in a view of its own
// (`html-preview-service.js`) and lays it over the stage this view keeps
// free. All this view does is say which file and where the stage is — and
// hide the page while something of the app lies on top of it, because a
// native view always paints above the window's own content.
//
// Around the stage it shows what the page could not have: a notice above it
// lists what was blocked, and why. The header carries "Preview | Source",
// "Reload" and "Open in browser".
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, tPlural, onLocaleChange } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { MODES, buildModeSwitch } from './mode-switch.js';
import { plainTextView } from './plain-text-view.js';
import { readFailureMessageKey, readFailureOf } from './read-failures.js';

const {
  HTML_PREVIEW_ERRORS: ERRORS,
  HTML_PREVIEW_BLOCK_REASONS: BLOCK,
  MAX_HTML_PREVIEW_BYTES,
  isHtmlFileName,
} = contracts;

// What of the app can lie over the preview column: the settings dialog with
// its nested dialogs, the update dialog, the image lightbox. While one of
// them is open the page is hidden — it would otherwise cover the dialog.
export const COVERING_LAYERS = '.modal:not(.hidden), .add-model-overlay:not(.hidden)';
const LAYER_ROOTS = '.modal, .add-model-overlay';

// A move without a change of size — a column toggled next to the preview —
// reaches no observer; it is caught by looking again at this pace.
const BOUNDS_POLL_MS = 250;

// The stage keeps this much of its edge free of the page, so that the focus
// ring around it stays visible while the page has the keyboard.
const STAGE_INSET_PX = 2;

const NOTICE_MS = 5000;

const ERROR_KEYS = Object.freeze({
  [ERRORS.NO_WORKSPACE]: 'noWorkspace',
  [ERRORS.OUTSIDE_WORKSPACE]: 'outsideWorkspace',
  [ERRORS.NOT_FOUND]: 'notFound',
  [ERRORS.TOO_LARGE]: 'tooLarge',
  [ERRORS.UNAVAILABLE]: 'unavailable',
});

const BLOCK_KEYS = Object.freeze({
  [BLOCK.NETWORK]: 'fileView.html.blocked.reason.network',
  [BLOCK.OUTSIDE_WORKSPACE]: 'fileView.html.blocked.reason.outside',
  [BLOCK.NOT_FOUND]: 'fileView.html.blocked.reason.notFound',
  [BLOCK.TOO_LARGE]: 'fileView.html.blocked.reason.tooLarge',
  [BLOCK.NAVIGATION]: 'fileView.html.blocked.reason.navigation',
  [BLOCK.DOWNLOAD]: 'fileView.html.blocked.reason.download',
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function nbsp(text) {
  return text.replace(' ', '\u00a0');
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function iconButton(className, path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `html-tools__button ${className}`;
  button.append(icon(path));
  return button;
}

/** Focusable, and not inside anything hidden. Layout is not asked. */
function isReachable(el) {
  return !el.closest('[hidden], .hidden, [inert]');
}

export const htmlView = {
  id: 'html',
  kind: 'viewer',
  reads: 'none',

  canHandle({ name }) {
    return isHtmlFileName(name);
  },

  mount(hostEl, context) {
    const { api, file } = context;
    const preview = api?.htmlPreview ?? null;
    let id = null;
    let mode = MODES.PREVIEW;
    let disposed = false;
    // { reason, size } while the page itself cannot be shown.
    let failure = null;
    let empty = false;
    // 'ok', 'unresponsive' or 'gone'.
    let health = 'ok';
    let blocked = { entries: [], total: 0 };
    let listOpen = false;
    let openTicket = 0;
    let lastBounds = '';
    let noticeTimer = null;
    let flashText = '';
    let sourceGeneration = 0;
    let sourceInstance = null;
    let sourceFailure = null;
    // Events that arrive while the page is still being opened, before its id
    // is known: main starts the load before it answers.
    const early = [];

    // ── Elements ──────────────────────────────────────────────────────────

    const previewEl = document.createElement('div');
    previewEl.className = 'html-view';

    const noticeEl = document.createElement('div');
    noticeEl.className = 'html-view__notice';
    noticeEl.hidden = true;
    // A page that hangs or ended: a row of its own, with a way out.
    const healthRow = document.createElement('div');
    healthRow.className = 'html-view__notice-row html-view__notice-row--health';
    healthRow.setAttribute('role', 'status');
    const healthText = document.createElement('span');
    healthText.className = 'html-view__notice-text html-view__notice-text--health';
    const noticeReload = document.createElement('button');
    noticeReload.type = 'button';
    noticeReload.className = 'html-view__notice-button';
    healthRow.append(healthText, noticeReload);
    // What was blocked: a count, and the list on demand.
    const blockedRow = document.createElement('div');
    blockedRow.className = 'html-view__notice-row html-view__notice-row--blocked';
    blockedRow.setAttribute('role', 'status');
    blockedRow.setAttribute('aria-live', 'polite');
    const blockedText = document.createElement('span');
    blockedText.className = 'html-view__notice-text html-view__notice-text--blocked';
    const noticeToggle = document.createElement('button');
    noticeToggle.type = 'button';
    noticeToggle.className = 'html-view__notice-button';
    noticeToggle.setAttribute('aria-expanded', 'false');
    blockedRow.append(blockedText, noticeToggle);
    const noticeList = document.createElement('ul');
    noticeList.className = 'html-view__blocked';
    noticeList.id = `html-view-blocked-${Math.random().toString(36).slice(2, 10)}`;
    noticeList.hidden = true;
    noticeToggle.setAttribute('aria-controls', noticeList.id);
    const flashEl = document.createElement('div');
    flashEl.className = 'html-view__notice-row html-view__flash';
    flashEl.setAttribute('role', 'status');
    flashEl.hidden = true;
    noticeEl.append(healthRow, blockedRow, noticeList, flashEl);

    // Where the page goes. Focusable, so that Tab can reach the page: the
    // focus is handed on to it, and F6 inside the page brings it back.
    const stageEl = document.createElement('div');
    stageEl.className = 'html-view__stage';
    stageEl.tabIndex = 0;
    stageEl.setAttribute('role', 'group');
    stageEl.hidden = true;

    const messageEl = document.createElement('div');
    messageEl.className = 'html-view__message';
    messageEl.setAttribute('role', 'status');
    messageEl.hidden = true;

    previewEl.append(noticeEl, stageEl, messageEl);

    const sourceEl = document.createElement('div');
    sourceEl.className = 'html-view__source';
    sourceEl.hidden = true;
    const sourceMessageEl = document.createElement('div');
    sourceMessageEl.className = 'html-view__message';
    sourceMessageEl.setAttribute('role', 'status');
    sourceMessageEl.hidden = true;
    const sourceTextEl = document.createElement('div');
    sourceTextEl.className = 'html-view__source-text';
    sourceEl.append(sourceMessageEl, sourceTextEl);

    hostEl.append(previewEl, sourceEl);

    const modeSwitch = buildModeSwitch((next) => setMode(next));
    // ↻ and a box with an arrow out of it.
    const reloadButton = iconButton('html-tools__reload', 'M13 8a5 5 0 1 1-1.46-3.54M13 2.5v2.5h-2.5');
    const browserButton = iconButton('html-tools__browser', 'M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4');
    const toolsEl = document.createElement('div');
    toolsEl.className = 'html-tools';
    toolsEl.append(reloadButton, browserButton);
    context.setTools([modeSwitch.element, toolsEl]);

    // ── Labels ────────────────────────────────────────────────────────────

    function applyLabels() {
      modeSwitch.applyLabels();
      for (const [button, key] of [[reloadButton, 'fileView.html.reload'], [browserButton, 'fileView.html.openInBrowser']]) {
        const label = t(key);
        button.setAttribute('aria-label', label);
        button.title = label;
      }
      stageEl.setAttribute('aria-label', t('fileView.html.stage', { name: file.name }));
      noticeReload.textContent = t('fileView.html.reload');
      renderNotice();
      if (failure) renderFailure();
      else if (empty) renderEmpty();
      if (sourceFailure) renderSourceFailure();
    }

    // ── The notice above the page ─────────────────────────────────────────

    function renderNotice() {
      healthText.textContent = health === 'unresponsive' ? t('fileView.html.unresponsive')
        : health === 'gone' ? t('fileView.html.gone') : '';
      healthRow.hidden = health === 'ok';

      const showBlocked = blocked.total > 0 && !failure;
      blockedText.textContent = showBlocked
        ? `${tPlural('fileView.html.blocked.count', blocked.total)} ${t('fileView.html.blocked.why')}`
        : '';
      blockedRow.hidden = !showBlocked;
      noticeToggle.textContent = t(listOpen ? 'fileView.html.blocked.hide' : 'fileView.html.blocked.show');
      noticeToggle.setAttribute('aria-expanded', String(listOpen && showBlocked));

      noticeList.hidden = !(listOpen && showBlocked);
      if (!noticeList.hidden) {
        const items = blocked.entries.map((entry) => {
          const item = document.createElement('li');
          item.className = 'html-view__blocked-item';
          const reason = document.createElement('span');
          reason.className = 'html-view__blocked-reason';
          reason.textContent = t(BLOCK_KEYS[entry.reason] ?? BLOCK_KEYS[BLOCK.NETWORK]);
          const url = document.createElement('span');
          url.className = 'html-view__blocked-url';
          url.textContent = entry.url;
          url.title = entry.url;
          item.append(reason, url);
          return item;
        });
        if (blocked.total > blocked.entries.length) {
          const more = document.createElement('li');
          more.className = 'html-view__blocked-more';
          more.textContent = tPlural('fileView.html.blocked.more', blocked.total - blocked.entries.length);
          items.push(more);
        }
        noticeList.replaceChildren(...items);
      }
      flashEl.textContent = flashText;
      flashEl.hidden = !flashText;
      noticeEl.hidden = healthRow.hidden && blockedRow.hidden && flashEl.hidden;
      scheduleSync();
    }

    function flash(text) {
      clearTimeout(noticeTimer);
      flashText = text;
      renderNotice();
      noticeTimer = setTimeout(() => {
        flashText = '';
        if (!disposed) renderNotice();
      }, NOTICE_MS);
    }

    noticeToggle.addEventListener('click', () => {
      listOpen = !listOpen;
      renderNotice();
    });
    noticeReload.addEventListener('click', () => void reload());

    // ── States instead of the page ────────────────────────────────────────

    function message(target, title, detail) {
      const titleEl = document.createElement('strong');
      titleEl.className = 'html-view__message-title';
      titleEl.textContent = title;
      const nodes = [titleEl];
      if (detail) {
        const detailEl = document.createElement('span');
        detailEl.className = 'html-view__message-detail';
        detailEl.textContent = detail;
        nodes.push(detailEl);
      }
      target.replaceChildren(...nodes);
      target.hidden = false;
    }

    function renderFailure() {
      const key = ERROR_KEYS[failure.reason] ?? ERROR_KEYS[ERRORS.NOT_FOUND];
      message(messageEl, t(`fileView.html.error.${key}.title`), t(`fileView.html.error.${key}.detail`, {
        limit: nbsp(formatSize(MAX_HTML_PREVIEW_BYTES)),
        size: nbsp(formatSize(failure.size ?? file.size)),
      }));
    }

    function renderEmpty() {
      message(messageEl, t('fileView.html.empty.title'), t('fileView.html.empty.detail'));
    }

    function showPage() {
      failure = null;
      messageEl.hidden = !empty;
      if (empty) renderEmpty();
      stageEl.hidden = empty;
      renderNotice();
      syncBounds(true);
    }

    function showFailure(reason, size) {
      failure = { reason: ERROR_KEYS[reason] ? reason : ERRORS.NOT_FOUND, size };
      stageEl.hidden = true;
      renderFailure();
      if (Number.isFinite(size)) context.setMeta({ size });
      renderNotice();
      syncBounds(true);
    }

    function setEmpty(next) {
      if (next === empty) return;
      empty = next;
      if (!failure) showPage();
    }

    // ── The page ──────────────────────────────────────────────────────────

    // An open under way: a refresh that comes meanwhile — the watcher, a
    // second click — waits for it instead of making a second page.
    let pendingOpen = null;
    function openPage() {
      if (!pendingOpen) {
        pendingOpen = startOpen().finally(() => {
          pendingOpen = null;
        });
      }
      return pendingOpen;
    }

    async function startOpen() {
      const ticket = ++openTicket;
      if (!preview) {
        showFailure(ERRORS.UNAVAILABLE);
        return;
      }
      let result;
      try {
        result = await preview.open(file.path, { fragment: context.fragment || '' });
      } catch {
        result = null;
      }
      if (disposed || ticket !== openTicket) {
        if (result?.ok) void preview.close(result.id);
        return;
      }
      if (!result?.ok) {
        early.length = 0;
        showFailure(result?.reason ?? ERRORS.UNAVAILABLE, result?.size);
        return;
      }
      id = result.id;
      health = 'ok';
      context.setMeta({ size: result.size });
      empty = result.size === 0;
      showPage();
      for (const event of early.splice(0)) onEvent(event);
    }

    function closePage() {
      if (!id) return;
      const closing = id;
      id = null;
      lastBounds = '';
      blocked = { entries: [], total: 0 };
      health = 'ok';
      void preview?.close(closing).catch(() => {});
    }

    /** The file, or something the page loaded, may have changed on disk. */
    async function refresh() {
      if (!id) {
        await openPage();
      } else {
        const checking = id;
        let result;
        try {
          result = await preview.check(checking);
        } catch {
          result = null;
        }
        if (disposed || id !== checking) return;
        if (!result?.ok) {
          closePage();
          showFailure(result?.reason ?? ERRORS.UNAVAILABLE, result?.size);
        } else {
          context.setMeta({ size: result.size });
          setEmpty(result.size === 0);
        }
      }
      if (mode === MODES.SOURCE) await readSource();
    }

    async function reload() {
      if (disposed) return;
      if (!id) {
        await openPage();
        return;
      }
      health = 'ok';
      renderNotice();
      try {
        await preview.reload(id);
      } catch {
        // The next look at the file tries again.
      }
    }

    async function openInBrowser() {
      let result;
      try {
        result = await preview?.openInBrowser(file.path);
      } catch {
        result = null;
      }
      if (!disposed && !result?.ok) flash(t('fileView.html.openInBrowser.failed'));
    }

    reloadButton.addEventListener('click', () => void reload());
    browserButton.addEventListener('click', () => void openInBrowser());

    // ── What main reports ─────────────────────────────────────────────────

    function onEvent(event) {
      if (disposed || !event || typeof event !== 'object') return;
      if (!id) {
        if (openTicket > 0 && early.length < 20) early.push(event);
        return;
      }
      if (event.id !== id) return;
      switch (event.type) {
        case 'blocked':
          blocked = {
            entries: Array.isArray(event.entries) ? event.entries : [],
            total: Number.isFinite(event.total) ? event.total : 0,
          };
          if (blocked.total === 0) listOpen = false;
          renderNotice();
          break;
        case 'unresponsive':
          health = 'unresponsive';
          renderNotice();
          break;
        case 'responsive':
        case 'loaded':
          if (health !== 'ok') {
            health = 'ok';
            renderNotice();
          }
          break;
        case 'gone':
          health = 'gone';
          renderNotice();
          break;
        case 'focus-leave':
          leaveStage(event.reverse === true);
          break;
        case 'open-file':
          void followFile(event.path, event.fragment);
          break;
        default:
          break;
      }
    }

    async function followFile(path, fragment) {
      if (typeof path !== 'string' || !path) return;
      // A link to this very page with a fragment: main only reports it when
      // it left the document, which it does not for an anchor.
      const result = typeof context.openFile === 'function'
        ? await context.openFile(path, { fragment: typeof fragment === 'string' ? fragment : '' })
        : { ok: false, reason: 'not-found' };
      if (disposed || result?.ok || result?.reason === 'stale') return;
      flash(t(result?.reason === 'outside' ? 'fileView.html.link.outside' : 'fileView.html.link.notFound', { path }));
    }

    const stopEvents = preview?.onEvent?.(onEvent) ?? (() => {});

    // ── Focus ─────────────────────────────────────────────────────────────

    stageEl.addEventListener('focus', () => {
      if (id && !stageEl.hidden) void preview.focus(id).catch(() => {});
    });

    /** F6 in the page: on to what comes after the stage, or back before it. */
    function leaveStage(reverse) {
      const all = [...document.querySelectorAll(FOCUSABLE)].filter((el) => el === stageEl || isReachable(el));
      const at = all.indexOf(stageEl);
      const target = reverse ? all[at - 1] ?? all[all.length - 1] : all[at + 1] ?? all[0];
      (target && target !== stageEl ? target : reloadButton).focus();
    }

    // ── Where the page goes ───────────────────────────────────────────────

    function measure() {
      if (!id || mode !== MODES.PREVIEW || failure || empty || stageEl.hidden || !stageEl.isConnected) return null;
      if (document.querySelector(COVERING_LAYERS)) return null;
      const rect = stageEl.getBoundingClientRect();
      const left = Math.max(0, rect.left + STAGE_INSET_PX);
      const top = Math.max(0, rect.top + STAGE_INSET_PX);
      const right = Math.min(window.innerWidth, rect.right - STAGE_INSET_PX);
      const bottom = Math.min(window.innerHeight, rect.bottom - STAGE_INSET_PX);
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function syncBounds(force = false) {
      if (disposed || !id) return;
      const bounds = measure();
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'hidden';
      if (!force && key === lastBounds) return;
      lastBounds = key;
      void preview.setBounds(id, bounds).catch(() => {});
    }

    let syncQueued = false;
    function scheduleSync() {
      if (syncQueued || disposed) return;
      syncQueued = true;
      requestAnimationFrame(() => {
        syncQueued = false;
        syncBounds();
      });
    }

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleSync) : null;
    resizeObserver?.observe(stageEl);
    const layerObserver = new MutationObserver(scheduleSync);
    for (const layer of document.querySelectorAll(LAYER_ROOTS)) {
      layerObserver.observe(layer, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    window.addEventListener('resize', scheduleSync);
    const pollTimer = setInterval(() => syncBounds(), BOUNDS_POLL_MS);

    // ── Source ────────────────────────────────────────────────────────────

    // Whichever read started last wins, as for an SVG (#641).
    async function readSource() {
      const generation = ++sourceGeneration;
      let result;
      try {
        result = await api.readFile(file.path);
      } catch {
        result = null;
      }
      if (disposed || generation !== sourceGeneration) return;
      if (!result || result.error || typeof result.content !== 'string') {
        sourceFailure = readFailureOf(result);
        renderSourceFailure();
        return;
      }
      sourceFailure = null;
      sourceMessageEl.hidden = true;
      sourceTextEl.hidden = false;
      if (sourceInstance) sourceInstance.update({ content: result.content });
      else sourceInstance = plainTextView.mount(sourceTextEl, { ...context, content: result.content });
    }

    function renderSourceFailure() {
      message(sourceMessageEl, t('fileView.source.unavailable'), t(readFailureMessageKey(sourceFailure)));
      sourceTextEl.hidden = true;
    }

    function setMode(next) {
      if (next === mode || disposed) return;
      mode = next;
      modeSwitch.select(mode);
      previewEl.hidden = mode !== MODES.PREVIEW;
      sourceEl.hidden = mode !== MODES.SOURCE;
      syncBounds(true);
      if (mode === MODES.SOURCE) void readSource();
    }

    const stopFollowingLocale = onLocaleChange(applyLabels);
    applyLabels();
    const opened = openPage();

    return {
      update() {
        return refresh();
      },
      /**
       * A watcher report for other folders: a stylesheet or a script the
       * page loaded may lie there. Main compares what it served with the disk
       * and reloads only when something differs.
       */
      revalidate() {
        if (!id) return Promise.resolve();
        return refresh();
      },
      unmount() {
        disposed = true;
        clearTimeout(noticeTimer);
        clearInterval(pollTimer);
        resizeObserver?.disconnect();
        layerObserver.disconnect();
        window.removeEventListener('resize', scheduleSync);
        stopFollowingLocale();
        stopEvents();
        closePage();
        sourceInstance?.unmount();
      },
      command(name) {
        if (name !== 'toggle-source') return false;
        setMode(mode === MODES.PREVIEW ? MODES.SOURCE : MODES.PREVIEW);
        return true;
      },
      /** For tests: the first open, the id of the page, which side is on show. */
      opened,
      get pageId() {
        return id;
      },
      get mode() {
        return mode;
      },
    };
  },
};
