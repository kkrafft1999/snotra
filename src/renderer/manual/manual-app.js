/**
 * The help window (#790): the user manual that ships with the app.
 *
 * Layout A of the mockup — chapters on the left, the page in the middle, *On
 * this page* on the right — folding into a *Contents* button on a narrow
 * window. The pages are the Markdown of `manual/`, rendered by the same
 * pipeline as the file preview (`renderMarkdownFragment`: marked, DOMPurify,
 * heading anchors, table frames). Everything comes from `window.manualApi`,
 * which reads the bundled copy and nothing else.
 */

import { t, setLocale, getLocale } from '../i18n.js';
import { classifyLink, renderMarkdownFragment } from '../file-views/markdown-document.js';
import { MARKDOWN_ZOOM_STEPS } from '../file-views/markdown-zoom.js';
import { ZOOM_IN_ICON, ZOOM_OUT_ICON, iconButton, nextZoom } from '../file-views/zoom-tools.js';
import { initTheme } from '../components/ThemeManager.js';
import {
  SINCE_MARKER,
  manualWebUrl,
  resolveManualLink,
  screenshotMotif,
} from './manual-links.js';

const api = window.manualApi;
const ZOOM_KEY = 'manual.zoom';
const NARROW = window.matchMedia('(max-width: 799px)');
/** Where a heading counts as the one being read, from the top of the scroll area. */
const OUTLINE_OFFSET = 96;
/** The device scale factor the manual's screenshots are taken at. */
const SCREENSHOT_SCALE = 2;
const isMac = /Mac/.test(navigator.userAgent ?? '');

const els = {
  root: document.getElementById('manual'),
  side: document.getElementById('manual-side'),
  sideClose: document.getElementById('manual-side-close'),
  scrim: document.getElementById('manual-scrim'),
  main: document.querySelector('.manual-main'),
  nav: document.getElementById('manual-nav'),
  version: document.getElementById('manual-version'),
  back: document.getElementById('manual-back'),
  forward: document.getElementById('manual-forward'),
  contents: document.getElementById('manual-contents'),
  crumbs: document.getElementById('manual-crumbs'),
  zoom: document.getElementById('manual-zoom'),
  web: document.getElementById('manual-web'),
  scroll: document.getElementById('manual-scroll'),
  doc: document.getElementById('manual-doc'),
  outline: document.getElementById('manual-outline'),
  outlineList: document.getElementById('manual-outline-list'),
};

const state = {
  context: null,
  index: null,
  /** { slug, fragment } of the page on show. */
  current: null,
  /** The pages this window showed, like a browser's history. */
  history: [],
  at: -1,
  zoom: readZoom(),
  /** Bumped on every page change, so that a late screenshot lands nowhere. */
  render: 0,
  navOpen: false,
};

const theme = initTheme();

// ── Start ───────────────────────────────────────────────────────────────────

async function start() {
  state.context = await api.context();
  setLocale(state.context.locale, { force: true });
  els.version.textContent = state.context.version;
  els.version.title = t('manual.version', { version: state.context.version });
  buildZoomTools();
  await loadIndex();

  const query = new URLSearchParams(window.location.search);
  await openPage(query.get('page') || 'index', query.get('section') || '', { focus: false });

  api.onNavigate(({ slug, fragment }) => { void openPage(slug, fragment); });
  api.onHistory((direction) => { void step(direction === 'back' ? -1 : 1); });
  api.onZoom((direction) => { zoomBy(direction); });
  api.onLocale((locale) => { void changeLocale(locale); });
}

async function loadIndex() {
  state.index = await api.index(getLocale());
  renderNav();
}

async function changeLocale(locale) {
  if (locale === getLocale()) return;
  setLocale(locale);
  applyZoomLabels();
  els.version.title = t('manual.version', { version: state.context.version });
  await loadIndex();
  if (state.current) {
    const top = els.scroll.scrollTop;
    await showPage(state.current.slug, '', { scrollTop: top, focus: false });
  }
}

// ── Pages ───────────────────────────────────────────────────────────────────

function pageMeta(slug) {
  return state.index?.pages?.[slug] ?? null;
}

/** Opens a page as a new step of the history. */
async function openPage(slug, fragment = '', { focus = true } = {}) {
  const target = pageMeta(slug) ? slug : 'index';
  const sameSpot = state.current && state.current.slug === target && !fragment;
  if (sameSpot) {
    els.scroll.scrollTo({ top: 0 });
    return;
  }
  rememberScroll();
  state.history = state.history.slice(0, state.at + 1);
  state.history.push({ slug: target, fragment, scrollTop: null });
  state.at = state.history.length - 1;
  await showPage(target, fragment, { focus });
}

async function step(delta) {
  const next = state.at + delta;
  if (next < 0 || next >= state.history.length) return;
  rememberScroll();
  state.at = next;
  const entry = state.history[next];
  await showPage(entry.slug, entry.fragment, { scrollTop: entry.scrollTop, focus: false });
}

function rememberScroll() {
  const entry = state.history[state.at];
  if (entry) entry.scrollTop = els.scroll.scrollTop;
}

async function showPage(slug, fragment, { scrollTop = null, focus = true } = {}) {
  const render = ++state.render;
  let page;
  try {
    page = await api.page(getLocale(), slug);
  } catch {
    if (render === state.render) showError();
    return;
  }
  if (render !== state.render) return;

  state.current = { slug, fragment };
  els.doc.replaceChildren(buildDocument(page, render));
  els.doc.style.setProperty('--md-zoom', String(state.zoom));
  document.title = slug === 'index'
    ? t('manual.window.title')
    : t('manual.document.title', { page: page.title });

  markCurrentInNav(slug);
  renderCrumbs(slug, page.title);
  renderOutline();
  renderHistoryButtons();
  closeNav({ restoreFocus: false });

  const heading = fragment ? els.doc.querySelector(`[data-md-anchor="${CSS.escape(fragment)}"]`) : null;
  if (scrollTop !== null) els.scroll.scrollTop = scrollTop;
  else if (heading) scrollToHeading(heading);
  else els.scroll.scrollTop = 0;
  updateOutlineCurrent();

  if (focus) focusHeading(heading ?? els.doc.querySelector('h1'));
}

function showError() {
  const box = document.createElement('div');
  box.className = 'manual-error';
  const message = document.createElement('p');
  message.textContent = t('manual.page.error');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.textContent = t('manual.page.toOverview');
  button.addEventListener('click', () => { void openPage('index'); });
  box.append(message, button);
  els.doc.replaceChildren(box);
  els.outline.hidden = true;
}

function buildDocument(page, render) {
  const fragment = document.createDocumentFragment();
  const title = document.createElement('h1');
  title.textContent = page.title;
  title.tabIndex = -1;
  fragment.append(title);
  if (page.description) {
    const lead = document.createElement('p');
    lead.className = 'manual-lead';
    lead.textContent = page.description;
    fragment.append(lead);
  }
  const body = renderMarkdownFragment(page.markdown);
  markSince(body);
  prepareImages(body, render);
  prepareLinks(body);
  fragment.append(body);
  return fragment;
}

/** `[since 1.17]` becomes a small badge, as on the web. Never inside code. */
function markSince(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('code, pre')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    SINCE_MARKER.lastIndex = 0;
    if (SINCE_MARKER.test(node.nodeValue)) texts.push(node);
  }
  for (const node of texts) {
    const parts = document.createDocumentFragment();
    const value = node.nodeValue;
    let last = 0;
    SINCE_MARKER.lastIndex = 0;
    for (const match of value.matchAll(SINCE_MARKER)) {
      if (match.index > last) parts.append(value.slice(last, match.index));
      const badge = document.createElement('span');
      badge.className = 'manual-since';
      badge.textContent = t('manual.since', { version: match[1] });
      parts.append(badge);
      last = match.index + match[0].length;
    }
    if (last < value.length) parts.append(value.slice(last));
    node.replaceWith(parts);
  }
}

// ── Screenshots ─────────────────────────────────────────────────────────────

function prepareImages(root, render) {
  for (const img of root.querySelectorAll('img[data-md-src]')) {
    const motif = screenshotMotif(img.getAttribute('data-md-src'));
    img.removeAttribute('data-md-src');
    if (!motif) {
      img.replaceWith(missingImage(img.getAttribute('alt')));
      continue;
    }
    img.dataset.motif = motif;
    img.classList.add('md-image', 'manual-shot');
    img.decoding = 'async';
    void loadScreenshot(img, render);
  }
}

async function loadScreenshot(img, render) {
  try {
    const src = await api.screenshot(img.dataset.motif, getLocale(), theme.getTheme());
    if (render !== state.render || !img.isConnected) return;
    // Taken at twice the size (manual/scripts/screenshots.mjs); shown at half,
    // as on the web, so that a small motif is not blown up to the column.
    img.addEventListener('load', () => {
      img.style.width = `${Math.round(img.naturalWidth / SCREENSHOT_SCALE)}px`;
    }, { once: true });
    img.src = src;
  } catch {
    if (render === state.render && img.isConnected) img.replaceWith(missingImage(img.alt));
  }
}

function missingImage(alt) {
  const box = document.createElement('span');
  box.className = 'manual-shot-missing';
  box.textContent = t('manual.image.missing');
  if (alt) box.title = alt;
  return box;
}

/** The other theme's variant, when the app switches between light and dark. */
function reloadScreenshots() {
  for (const img of els.doc.querySelectorAll('img[data-motif]')) void loadScreenshot(img, state.render);
}

// ── Links ───────────────────────────────────────────────────────────────────

function prepareLinks(root) {
  for (const anchor of root.querySelectorAll('a')) {
    const link = classifyLink(anchor);
    anchor.removeAttribute('data-workspace-href');
    anchor.removeAttribute('target');
    if (!link) {
      anchor.removeAttribute('href');
      continue;
    }
    if (link.kind === 'external') {
      anchor.classList.add('md-link--external');
      anchor.dataset.external = link.href;
      anchor.title = link.href;
      continue;
    }
    anchor.setAttribute('href', '#');
    if (link.kind === 'anchor') {
      anchor.dataset.anchor = link.slug;
      continue;
    }
    const slug = resolveManualLink(link.target, state.current?.slug ?? 'index', state.index.pages);
    if (!slug) {
      anchor.removeAttribute('href');
      continue;
    }
    anchor.dataset.page = slug;
    anchor.dataset.fragment = link.fragment;
  }
}

els.doc.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a');
  if (!anchor || !els.doc.contains(anchor)) return;
  event.preventDefault();
  if (anchor.dataset.external) {
    void api.openExternal(anchor.dataset.external);
  } else if (anchor.dataset.page) {
    void openPage(anchor.dataset.page, anchor.dataset.fragment ?? '');
  } else if (anchor.dataset.anchor !== undefined) {
    const heading = els.doc.querySelector(`[data-md-anchor="${CSS.escape(anchor.dataset.anchor)}"]`);
    if (heading) {
      scrollToHeading(heading);
      focusHeading(heading);
    }
  }
});

/** Reading continues from here — for a screen reader and for the next Tab. */
function focusHeading(heading) {
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function scrollToHeading(heading) {
  const top = heading.getBoundingClientRect().top - els.scroll.getBoundingClientRect().top;
  els.scroll.scrollTop += top - 16;
}

// ── Navigation: chapters, breadcrumbs, outline ──────────────────────────────

function renderNav() {
  const list = document.createElement('ul');
  list.className = 'manual-nav__list';
  for (const item of state.index.nav) {
    const li = document.createElement('li');
    if (!item.chapter) {
      li.append(navLink(item.slug, item.label, 'manual-nav__top'));
    } else {
      const details = document.createElement('details');
      details.className = 'manual-nav__chapter';
      details.dataset.chapter = item.chapter;
      const summary = document.createElement('summary');
      summary.textContent = item.label;
      const pages = document.createElement('ul');
      for (const slug of item.pages) {
        const entry = document.createElement('li');
        entry.append(navLink(slug, pageMeta(slug)?.title ?? slug));
        pages.append(entry);
      }
      details.append(summary, pages);
      li.append(details);
    }
    list.append(li);
  }
  els.nav.replaceChildren(list);
  if (state.current) markCurrentInNav(state.current.slug);
}

function navLink(slug, label, extraClass = '') {
  const link = document.createElement('a');
  link.href = '#';
  link.className = `manual-nav__link ${extraClass}`.trim();
  link.dataset.page = slug;
  link.textContent = label;
  return link;
}

els.nav.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-page]');
  if (!link) return;
  event.preventDefault();
  void openPage(link.dataset.page);
});

function markCurrentInNav(slug) {
  for (const link of els.nav.querySelectorAll('a[data-page]')) {
    if (link.dataset.page === slug) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const chapter = pageMeta(slug)?.chapter;
  const details = chapter ? els.nav.querySelector(`details[data-chapter="${CSS.escape(chapter)}"]`) : null;
  if (details) details.open = true;
  els.nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
}

function chapterLabel(chapter) {
  return state.index.nav.find((item) => item.chapter === chapter)?.label ?? '';
}

function renderCrumbs(slug, title) {
  const list = document.createElement('ol');
  const chapter = pageMeta(slug)?.chapter;
  if (chapter) {
    const li = document.createElement('li');
    li.textContent = chapterLabel(chapter);
    list.append(li);
  }
  const current = document.createElement('li');
  current.setAttribute('aria-current', 'page');
  current.textContent = title;
  list.append(current);
  els.crumbs.replaceChildren(list);
  els.crumbs.title = [chapter ? chapterLabel(chapter) : '', title].filter(Boolean).join(' › ');
}

function renderOutline() {
  const headings = [...els.doc.querySelectorAll('h2[data-md-anchor]')];
  els.outline.hidden = headings.length < 2;
  els.outlineList.replaceChildren(...headings.map((heading) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'manual-outline__link';
    link.dataset.anchor = heading.dataset.mdAnchor;
    link.textContent = heading.textContent;
    li.append(link);
    return li;
  }));
}

els.outlineList.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-anchor]');
  if (!link) return;
  event.preventDefault();
  const heading = els.doc.querySelector(`[data-md-anchor="${CSS.escape(link.dataset.anchor)}"]`);
  if (!heading) return;
  scrollToHeading(heading);
  focusHeading(heading);
});

/** Marks the section being read: the last heading above the reading line. */
function updateOutlineCurrent() {
  if (els.outline.hidden) return;
  const line = els.scroll.getBoundingClientRect().top + OUTLINE_OFFSET;
  let current = null;
  for (const heading of els.doc.querySelectorAll('h2[data-md-anchor]')) {
    if (heading.getBoundingClientRect().top <= line) current = heading.dataset.mdAnchor;
  }
  const atEnd = els.scroll.scrollTop + els.scroll.clientHeight >= els.scroll.scrollHeight - 2;
  const links = [...els.outlineList.querySelectorAll('a')];
  if (atEnd && links.length) current = links.at(-1).dataset.anchor;
  for (const link of links) {
    if (link.dataset.anchor === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

let outlineFrame = 0;
els.scroll.addEventListener('scroll', () => {
  if (outlineFrame) return;
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = 0;
    updateOutlineCurrent();
  });
}, { passive: true });

// ── History ─────────────────────────────────────────────────────────────────

function renderHistoryButtons() {
  els.back.disabled = state.at <= 0;
  els.forward.disabled = state.at >= state.history.length - 1;
}

els.back.setAttribute('aria-keyshortcuts', isMac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
els.forward.setAttribute('aria-keyshortcuts', isMac ? 'Meta+BracketRight' : 'Alt+ArrowRight');
els.back.addEventListener('click', () => { void step(-1); });
els.forward.addEventListener('click', () => { void step(1); });

// The side buttons of a mouse, as in the preview.
window.addEventListener('mouseup', (event) => {
  if (event.button === 3) { event.preventDefault(); void step(-1); }
  if (event.button === 4) { event.preventDefault(); void step(1); }
});

// ── Contents on a narrow window ─────────────────────────────────────────────

function applyNarrow() {
  const narrow = NARROW.matches;
  els.root.classList.toggle('manual--narrow', narrow);
  if (!narrow) {
    state.navOpen = false;
    els.root.classList.remove('manual--nav-open');
    els.scrim.hidden = true;
  }
  els.side.inert = narrow && !state.navOpen;
  // While the chapters lie over the page, the page behind them is out of reach.
  els.main.inert = narrow && state.navOpen;
  els.contents.setAttribute('aria-expanded', String(narrow && state.navOpen));
}

function openNav() {
  if (!NARROW.matches) return;
  state.navOpen = true;
  els.root.classList.add('manual--nav-open');
  els.scrim.hidden = false;
  applyNarrow();
  (els.nav.querySelector('[aria-current="page"]') ?? els.nav.querySelector('a'))?.focus();
}

function closeNav({ restoreFocus = true } = {}) {
  if (!state.navOpen) return;
  state.navOpen = false;
  els.root.classList.remove('manual--nav-open');
  els.scrim.hidden = true;
  applyNarrow();
  if (restoreFocus) els.contents.focus();
}

els.contents.addEventListener('click', () => (state.navOpen ? closeNav() : openNav()));
els.sideClose.addEventListener('click', () => closeNav());
els.scrim.addEventListener('click', () => closeNav());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.navOpen) {
    event.preventDefault();
    closeNav();
  }
});
NARROW.addEventListener('change', applyNarrow);
applyNarrow();

// ── Zoom ────────────────────────────────────────────────────────────────────

let zoomOut = null;
let zoomIn = null;
let zoomValue = null;

function readZoom() {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    return MARKDOWN_ZOOM_STEPS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

function buildZoomTools() {
  zoomOut = iconButton('pdf-tools__zoom-out', ZOOM_OUT_ICON);
  zoomValue = document.createElement('output');
  zoomValue.className = 'pdf-tools__zoom';
  zoomValue.setAttribute('aria-live', 'off');
  zoomIn = iconButton('pdf-tools__zoom-in', ZOOM_IN_ICON);
  els.zoom.replaceChildren(zoomOut, zoomValue, zoomIn);
  zoomOut.addEventListener('click', () => zoomBy('out'));
  zoomIn.addEventListener('click', () => zoomBy('in'));
  applyZoomLabels();
  renderZoom();
}

function applyZoomLabels() {
  if (!zoomOut) return;
  els.zoom.setAttribute('aria-label', t('fileView.markdown.zoom.label'));
  zoomOut.setAttribute('aria-label', t('fileView.markdown.zoom.out'));
  zoomOut.title = zoomOut.getAttribute('aria-label');
  zoomIn.setAttribute('aria-label', t('fileView.markdown.zoom.in'));
  zoomIn.title = zoomIn.getAttribute('aria-label');
}

function renderZoom() {
  zoomValue.textContent = `${Math.round(state.zoom * 100)} %`;
  zoomOut.disabled = state.zoom <= MARKDOWN_ZOOM_STEPS[0] + 0.001;
  zoomIn.disabled = state.zoom >= MARKDOWN_ZOOM_STEPS.at(-1) - 0.001;
}

function zoomBy(direction) {
  const next = direction === 'reset' ? 1 : nextZoom(state.zoom, direction === 'in' ? 1 : -1, MARKDOWN_ZOOM_STEPS);
  if (next === state.zoom) return;
  const before = els.scroll.scrollHeight;
  const share = before > 0 ? els.scroll.scrollTop / before : 0;
  state.zoom = next;
  els.doc.style.setProperty('--md-zoom', String(next));
  if (share > 0) els.scroll.scrollTop = Math.round(share * els.scroll.scrollHeight);
  try { localStorage.setItem(ZOOM_KEY, String(next)); } catch { /* the zoom just isn't kept */ }
  renderZoom();
}

// ── The web, language and theme ─────────────────────────────────────────────

els.web.addEventListener('click', () => {
  if (!state.context || !state.current) return;
  void api.openExternal(manualWebUrl(state.context.webBase, getLocale(), state.current.slug));
});

// The theme lives in localStorage, shared with the app window: a change there
// arrives here as a storage event (ThemeManager.js).
window.addEventListener('storage', (event) => {
  if (event.key !== 'theme') return;
  theme.setTheme(event.newValue);
  reloadScreenshots();
});

void start().catch((error) => {
  console.error('The manual could not be opened:', error);
  showError();
});
