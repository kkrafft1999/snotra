/**
 * Notices in the window (#1001, the notice channel of #978).
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

/** Heading and text per kind; the heading names the store in words. */
const WORDING = Object.freeze({
  [NOTICE_KINDS.STORE_SET_ASIDE]: { heading: 'notice.storeSetAside', text: 'notice.storeSetAside.text', tone: 'info' },
  [NOTICE_KINDS.STORE_NOT_SAVED]: { heading: 'notice.storeNotSaved', text: 'notice.storeNotSaved.text', tone: 'error' },
});

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

  function revealLabel() {
    return t(REVEAL_KEYS[platform] || 'contextMenu.reveal.other');
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
    heading.textContent = t(`${wording.heading}.${notice.store}`);
    const text = document.createElement('p');
    text.className = 'app-notice-text';
    text.textContent = t(wording.text, { file: notice.file });
    body.append(heading, text);
    if (notice.location) {
      const where = document.createElement('p');
      where.className = 'app-notice-path';
      where.textContent = notice.location;
      body.appendChild(where);
    }

    const actions = document.createElement('p');
    actions.className = 'app-notice-actions';
    if (notice.canReveal) {
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'app-notice-link';
      reveal.dataset.action = 'reveal';
      reveal.textContent = revealLabel();
      reveal.addEventListener('click', () => {
        void Promise.resolve(api.revealNotice?.(notice.id)).catch(() => {});
      });
      actions.appendChild(reveal);
    }
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'app-notice-link';
    help.dataset.action = 'help';
    help.textContent = t('notice.help');
    help.addEventListener('click', () => {
      const target = settingsHelpTarget('notice.store', getLocale());
      if (target) void Promise.resolve(api.openManual?.({ slug: target.slug, fragment: target.fragment })).catch(() => {});
    });
    actions.appendChild(help);
    body.appendChild(actions);
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
      previous.element.replaceWith(element);
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
