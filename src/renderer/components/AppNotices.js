/**
 * Notices in the window (#1001, the notice channel of #978).
 *
 * Two families: a store's file that was set aside or is not saved (#1001),
 * and the errors nobody caught (#978), counted in one notice that offers the
 * diagnostics and the log file.
 *
 * A strip under the title bar, one entry per notice. Main posts a notice as a
 * kind plus the facts it is about; it is worded here, in the interface
 * language, and worded again when that changes. Notices posted before the
 * window existed come with the first list; later ones arrive as pushes.
 *
 * The strip is a polite live region: entries are added and removed one by
 * one, never redrawn as a whole, so each new notice is read out once.
 */

import contracts from '../generated/contracts.js';
import { getLocale, onLocaleChange, t } from '../i18n.js';
import { settingsHelpTarget } from '../manual/settings-help-links.js';

const { NOTICE_KINDS, normalizeNotice } = contracts;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Heading, text, tone and help link per kind. A store's heading names the
 * store in words; the background-error text says how many errors there were.
 */
const WORDING = Object.freeze({
  [NOTICE_KINDS.STORE_SET_ASIDE]: {
    heading: (notice) => t(`notice.storeSetAside.${notice.store}`),
    text: (notice) => t('notice.storeSetAside.text', { file: notice.file }),
    tone: 'info',
    help: 'notice.store',
  },
  [NOTICE_KINDS.STORE_NOT_SAVED]: {
    heading: (notice) => t(`notice.storeNotSaved.${notice.store}`),
    text: (notice) => t('notice.storeNotSaved.text', { file: notice.file }),
    tone: 'error',
    help: 'notice.store',
  },
  [NOTICE_KINDS.BACKGROUND_ERROR]: {
    heading: () => t('notice.backgroundError'),
    text: (notice) => (notice.count === 1
      ? t('notice.backgroundError.text.one')
      : t('notice.backgroundError.text.other', { count: notice.count })),
    tone: 'error',
    help: 'notice.backgroundError',
  },
  // Developer mode (#1213): which way it was switched, and what it opens.
  [NOTICE_KINDS.DEVELOPER_MODE]: {
    heading: (notice) => t(notice.on ? 'notice.developerMode.on' : 'notice.developerMode.off'),
    text: (notice) => t(notice.on ? 'notice.developerMode.on.text' : 'notice.developerMode.off.text'),
    tone: 'info',
    help: null,
  },
  // No help link until the manual has its remote access chapter (#1110).
  [NOTICE_KINDS.REMOTE_WORKSPACE_SWITCHED]: {
    heading: () => t('notice.remoteWorkspaceSwitched'),
    text: (notice) => t('notice.remoteWorkspaceSwitched.text', { folder: notice.folder }),
    tone: 'info',
    help: null,
  },
});

/** How long *Copied* stays on the button before it reads *Copy diagnostics* again. */
const COPIED_FEEDBACK_MS = 2500;

const REVEAL_KEYS = Object.freeze({
  darwin: 'contextMenu.reveal.darwin',
  win32: 'contextMenu.reveal.win32',
});

function svgIcon(className, paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of paths) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    svg.appendChild(el);
  }
  return svg;
}

/** "i" for a notice that informs, "!" for one that warns — the shape says it, not only the colour. */
function toneIcon(tone) {
  const mark = tone === 'error'
    ? [['path', { d: 'M8 4.75v3.75' }], ['path', { d: 'M8 11.1v.15' }]]
    : [['path', { d: 'M8 7.25v4' }], ['path', { d: 'M8 4.75v.15' }]];
  return svgIcon('app-notice-icon', [['circle', { cx: '8', cy: '8', r: '6.25' }], ...mark]);
}

export function initAppNotices({ api, root = document.getElementById('app-notices') } = {}) {
  if (!root || !api?.listNotices) return { refresh: async () => {} };

  /** id → { notice, element }, in the order they came. */
  const shown = new Map();
  let platform = '';

  function revealLabel(notice) {
    if (notice.kind === NOTICE_KINDS.BACKGROUND_ERROR) return t('notice.backgroundError.showLog');
    return t(REVEAL_KEYS[platform] || 'contextMenu.reveal.other');
  }

  function linkButton(action, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-notice-link';
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /** The button says what came of the click, then goes back to its label. */
  function copyDiagnosticsButton() {
    let reset = null;
    const button = linkButton('copy-diagnostics', t('notice.backgroundError.copy'), async () => {
      let ok = false;
      try {
        ok = (await api.copyDiagnostics?.())?.ok === true;
      } catch {
        ok = false;
      }
      // The shorter word must not pull the buttons beside it to the left.
      if (!reset) button.style.minWidth = `${button.offsetWidth}px`;
      button.textContent = t(ok ? 'notice.backgroundError.copied' : 'notice.backgroundError.copyFailed');
      clearTimeout(reset);
      reset = setTimeout(() => {
        reset = null;
        button.textContent = t('notice.backgroundError.copy');
        button.style.minWidth = '';
      }, COPIED_FEEDBACK_MS);
    });
    return button;
  }

  function build(notice) {
    const wording = WORDING[notice.kind];
    const el = document.createElement('div');
    el.className = `app-notice app-notice--${wording.tone}`;
    el.dataset.noticeId = notice.id;

    el.appendChild(toneIcon(wording.tone));

    const body = document.createElement('div');
    body.className = 'app-notice-body';
    const heading = document.createElement('p');
    heading.className = 'app-notice-heading';
    heading.textContent = wording.heading(notice);
    const text = document.createElement('p');
    text.className = 'app-notice-text';
    text.textContent = wording.text(notice);
    body.append(heading, text);
    // A store's notice shows where its file is; the log's path is one click away.
    if (notice.location && notice.kind !== NOTICE_KINDS.BACKGROUND_ERROR) {
      const where = document.createElement('p');
      where.className = 'app-notice-path';
      where.textContent = notice.location;
      body.appendChild(where);
    }

    const actions = document.createElement('p');
    actions.className = 'app-notice-actions';
    if (notice.kind === NOTICE_KINDS.BACKGROUND_ERROR) actions.appendChild(copyDiagnosticsButton());
    if (notice.canReveal) {
      actions.appendChild(linkButton('reveal', revealLabel(notice), () => {
        void Promise.resolve(api.revealNotice?.(notice.id)).catch(() => {});
      }));
    }
    if (wording.help) {
      actions.appendChild(linkButton('help', t('notice.help'), () => {
        const target = settingsHelpTarget(wording.help, getLocale());
        if (target) void Promise.resolve(api.openManual?.({ slug: target.slug, fragment: target.fragment })).catch(() => {});
      }));
    }
    if (actions.childElementCount > 0) body.appendChild(actions);
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-notice-close';
    close.dataset.action = 'dismiss';
    close.setAttribute('aria-label', t('notice.dismiss'));
    close.title = t('notice.dismiss');
    close.appendChild(svgIcon('app-notice-close-icon', [
      ['path', { d: 'M4.5 4.5l7 7' }],
      ['path', { d: 'M11.5 4.5l-7 7' }],
    ]));
    close.addEventListener('click', () => dismiss(notice.id));
    el.appendChild(close);
    return el;
  }

  function syncHidden() {
    root.hidden = shown.size === 0;
  }

  function show(raw) {
    const notice = normalizeNotice(raw);
    if (!notice || !WORDING[notice.kind]) return;
    const element = build(notice);
    const previous = shown.get(notice.id);
    if (previous) {
      // A count that goes up redraws the entry; whoever was on one of its
      // buttons stays on the same button.
      const focused = previous.element.contains(document.activeElement) ? document.activeElement : null;
      previous.element.replaceWith(element);
      const action = focused?.dataset?.action;
      if (action) element.querySelector(`[data-action="${action}"]`)?.focus?.();
    } else {
      root.appendChild(element);
    }
    shown.set(notice.id, { notice, element });
    syncHidden();
  }

  function remove(id) {
    const entry = shown.get(id);
    if (!entry) return false;
    const hadFocus = entry.element.contains(document.activeElement);
    entry.element.remove();
    shown.delete(id);
    syncHidden();
    // Focus would otherwise fall to the page: hand it to the next notice, or
    // to the chat input, where work goes on.
    if (hadFocus) {
      const next = root.querySelector('.app-notice-close') || document.getElementById('chat-input');
      next?.focus?.();
    }
    return true;
  }

  function dismiss(id) {
    if (remove(id)) void Promise.resolve(api.dismissNotice?.(id)).catch(() => {});
  }

  function rewordAll() {
    for (const { notice, element } of shown.values()) {
      const fresh = build(notice);
      element.replaceWith(fresh);
      shown.get(notice.id).element = fresh;
    }
    root.setAttribute('aria-label', t('notice.region'));
  }

  // Listen first, then list: a notice posted in between arrives twice and is
  // shown once, because the id holds its place.
  api.onNoticePosted?.((notice) => show(notice));
  api.onNoticeWithdrawn?.((payload) => {
    if (typeof payload?.id === 'string') remove(payload.id);
  });
  onLocaleChange(rewordAll);

  async function refresh() {
    let result;
    try {
      result = await api.listNotices();
    } catch {
      return;
    }
    if (typeof result?.platform === 'string' && result.platform !== platform) {
      platform = result.platform;
      rewordAll();
    }
    for (const notice of Array.isArray(result?.notices) ? result.notices : []) show(notice);
  }

  root.setAttribute('aria-label', t('notice.region'));
  syncHidden();
  void refresh();

  return { refresh };
}
