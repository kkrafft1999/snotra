import contracts from '../generated/contracts.js';
import { t } from '../i18n.js';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'json', 'html', 'htm', 'css',
  'scss', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'sh', 'bash', 'zsh', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'swift', 'kt', 'scala', 'php', 'sql', 'r',
  'vue', 'svelte', 'astro', 'env', 'gitignore', 'dockerfile',
  'makefile', 'cmake', 'gradle', 'properties', 'log', 'csv', 'svg',
  'lock', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc',
]);

export function getExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return filename.slice(dotIndex + 1).toLowerCase();
}

/**
 * Dot files come into the tree with #436, and nearly all of them are
 * configuration: `.gitignore`, `.npmrc`, `.nvmrc`, `.editorconfig`. One without
 * a further extension therefore counts as text — `getExtension` sees none in
 * it. With an extension, the extension decides as for any file, so a vim swap
 * file (`.notes.md.swp`) stays on the info card. `.env.local` and its siblings
 * carry their stage where the extension would be; the `.env` in front decides.
 */
const ENV_FILE = /^\.env(\.|$)/;

export function isTextFile(filename) {
  const ext = getExtension(filename);
  const lower = filename.toLowerCase();
  if (ENV_FILE.test(lower)) return true;
  if (!ext) {
    if (lower.startsWith('.') && lower.length > 1) return true;
    return ['makefile', 'dockerfile', 'readme', 'license', 'changelog'].some(
      (n) => lower === n || lower.startsWith(n + '.')
    );
  }
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Dateigröße für die Oberfläche. Die Einheiten heißen in beiden Sprachen
 * gleich; das Dezimaltrennzeichen nicht, und das kommt seit #292 aus dem
 * Katalog. Gegenstück im Main-Prozess: `shared/runtime/format-bytes.js`.
 */
export function formatSize(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.max(Math.floor(Math.log(value) / Math.log(1024)), 0), units.length - 1);
  const scaled = value / Math.pow(1024, i);
  const text = i === 0
    ? String(Math.round(scaled))
    : scaled.toFixed(1).replace('.', t('format.decimal'));
  return `${text} ${units[i]}`;
}

/**
 * Always in MB with one decimal, for a progress line whose two numbers have to
 * share a unit ("46.0 MB of 92.0 MB"), where `formatSize` might switch units.
 */
export function formatMegabytes(bytes) {
  const value = Number(bytes);
  const mb = Number.isFinite(value) && value > 0 ? value / (1024 * 1024) : 0;
  return `${mb.toFixed(1).replace('.', t('format.decimal'))} MB`;
}

/**
 * A whole number with the thousands separator of the interface language
 * ("12,345" / "12.345"). By hand for the same reason as `groupDigits` in
 * `main/services/file-info.js`: the separator comes from the catalogue.
 */
export function formatCount(value) {
  const n = Math.trunc(Number(value) || 0);
  const digits = String(Math.abs(n));
  const separator = t('format.group');
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += separator;
    out += digits[i];
  }
  return n < 0 ? `-${out}` : out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Zeitpunkt für die Oberfläche: „21.09.2026, 14:32“ auf Deutsch,
 * „2026-09-21, 14:32“ auf Englisch. Von Hand statt über `toLocaleString`, wie
 * im Main-Prozess (`main/services/file-info.js`) — beide Stellen zeigen
 * denselben Zeitpunkt, und dann sollen sie ihn auch gleich schreiben (#292).
 */
export function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return t('fileInfo.unknown');
  const day = t('format.date', {
    day: pad2(date.getDate()),
    month: pad2(date.getMonth() + 1),
    year: String(date.getFullYear()),
  });
  return `${day}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Links that may stay clickable in an answer (#82): http, https and a strict
 * `mailto:`. The same contract decides in the main process whether to open
 * one, so the chat never shows a link that then does nothing (CR-B11-09).
 */
export function isOpenableLink(href) {
  return contracts.isOpenableUrl(href);
}
let domPurifyConfigured = false;
// Set for the duration of one sanitize call that renders a workspace file
// (#344). DOMPurify runs synchronously, so a module flag is enough to tell the
// hook which of the two callers it is working for.
let keepRelativeLinks = false;

/** Relative to the document: no scheme, no `//host`. `#anchor` counts too. */
function isRelativeLink(href) {
  return Boolean(href) && !href.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

function configureDomPurify() {
  if (domPurifyConfigured || typeof DOMPurify === 'undefined') return;
  // Windows-Pfad mit Laufwerksbuchstaben an einem Bild stehen lassen (Issue
  // #244). DOMPurify liest `D:` als unbekanntes URL-Schema und wirft das
  // `src` weg — ein absoluter Pfad des Modells kaeme unter Windows also nie
  // an, waehrend `/Users/…` auf macOS und Linux durchgeht.
  //
  // Die Ausnahme ist so eng wie moeglich: nur `<img src>`, nur ein echter
  // Laufwerkspfad. Sie oeffnet nichts — der Wert wird nie geladen, sondern in
  // workspaceImages.js durch einen `data:`-URI oder einen Platzhalter ersetzt,
  // und selbst wenn das ausbliebe, laesst die CSP (`img-src 'self' data:`)
  // kein `d:` zu. Geprueft wird der Pfad ohnehin erst im Main-Prozess.
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName !== 'src') return;
    // `<img>` is the only element whose `src` survives (#423): it is moved
    // aside before anything loads and resolved by the main process (#402).
    // Any other one — `<input type="image">` above all, which the task lists
    // need as a tag — would read a local file straight from disk.
    if (node.tagName !== 'IMG') {
      data.keepAttr = false;
      return;
    }
    if (contracts.isWindowsDrivePath(data.attrValue)) data.forceKeepAttr = true;
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      const href = node.getAttribute('href') || '';
      if (!isOpenableLink(href)) {
        // A link to another file of the workspace means nothing to the chat,
        // but it does in the file preview. It never stays an `href`: the
        // viewer resolves it and opens the file itself (#344).
        if (keepRelativeLinks && isRelativeLink(href.trim())) {
          node.setAttribute('data-workspace-href', href.trim());
        }
        node.removeAttribute('href');
      }
    }
  });
  domPurifyConfigured = true;
}

/**
 * Markdown to sanitized HTML — the one path for chat answers and for Markdown
 * files in the preview (#344), so there is only one sanitizer to get right.
 *
 * The defaults are those of the chat. A file differs in two ways:
 *   * `breaks: false` — a file is hard-wrapped at some column, and a single
 *     line break inside a paragraph is a space, as on GitHub. A chat answer
 *     means every line break it contains.
 *   * `keepRelativeLinks: true` — a link without a scheme leaves the sanitizer
 *     as `data-workspace-href` instead of disappearing, see the hook above.
 */
export function markdownToSafeHtml(raw, { breaks = true, keepRelativeLinks: keepRelative = false } = {}) {
  const text = String(raw ?? '');
  if (typeof marked !== 'undefined' && typeof marked.parse === 'function' && typeof DOMPurify !== 'undefined') {
    configureDomPurify();
    const html = marked.parse(text, { breaks, gfm: true });
    keepRelativeLinks = keepRelative;
    try {
      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        // Media elements load their `src` and `poster` on their own, from any
        // local file `'self'` covers (#423). The chat has no use for them —
        // the CSP now says `media-src 'none'`.
        // `background` is a table's image, loaded under `img-src 'self'`.
        // An image map would be a second kind of link the hook above never
        // sees: `<area href="?x">` reloads the app (CR-B11-08).
        FORBID_TAGS: ['style', 'iframe', 'form', 'video', 'audio', 'source', 'track', 'picture', 'map', 'area'],
        FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'usemap'],
      });
    } finally {
      keepRelativeLinks = false;
    }
  }
  const esc = document.createElement('div');
  esc.textContent = text;
  return esc.innerHTML.replace(/\n/g, '<br>');
}

/**
 * Sanitized HTML as a fragment in which no image has started loading (#402).
 *
 * The HTML is parsed inside a `<template>`, whose content belongs to an inert
 * document: nothing there fetches anything. Every `<img src>` then moves to
 * `data-md-src` before a node can reach the window. Assigned to a live node
 * instead, an `<img>` fetches its `src` at once — even while the node is not
 * attached yet — and a local path reaches the disk before the main process has
 * decided whether it lies inside the workspace.
 *
 * Whoever renders the fragment fills the images in: `applyWorkspaceImages()`
 * in the chat, `markdown-view.js` in the file preview.
 */
export function inertHtmlFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const img of template.content.querySelectorAll('img')) {
    img.setAttribute('data-md-src', img.getAttribute('src') ?? '');
    img.removeAttribute('src');
  }
  return template.content;
}

export function svgChevron() {
  return `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function svgFolder() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`;
}

/** „@“-Zeichen (Issue #56): Knopf „Im Chat referenzieren“ in der Baumzeile. */
export function svgAt() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
  </svg>`;
}

export function svgFile(filename) {
  const ext = getExtension(filename);
  const colorMap = {
    js: '#f1e05a', ts: '#3178c6', jsx: '#61dafb', tsx: '#3178c6',
    json: '#a8d08d', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
    py: '#3572A5', rb: '#cc342d', java: '#b07219', go: '#00ADD8',
    rs: '#dea584', md: '#519aba', svg: '#ff9900', xml: '#e44b23',
    yaml: '#cb171e', yml: '#cb171e', sh: '#89e051', sql: '#e38c00',
  };
  const color = colorMap[ext] || '#888';

  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="${color}">
    <path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0H4zM9 1v3.5a.5.5 0 0 0 .5.5H13L9 1zM4 1h4v4h5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>
  </svg>`;
}

// Gemeinsames Outside-Click-Muster für Menüs/Drawer (Review 2026-05-23, G1):
// schließt das Element bei Klicks außerhalb, solange isOpen() true liefert.
// ownsTarget entscheidet, welche Klicks als "innen" gelten (z. B. Menü +
// zugehöriger Toggle-Button).
export function dismissOnOutsideClick({ isOpen, ownsTarget, onDismiss }) {
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (ownsTarget?.(e.target)) return;
    onDismiss();
  });
}

/**
 * The keyboard half of the pattern above (#583, #585): a popup closes when
 * the focus moves on to something outside `container` — Tab past its last
 * item, say. Leaving the window is not "elsewhere": the popup is still there
 * when the user comes back. `isPaused()` covers a popup that rebuilds itself
 * and drops the focus for a moment.
 */
export function dismissOnFocusLeave({ container, isOpen, onDismiss, isPaused = () => false }) {
  container?.addEventListener('focusout', (e) => {
    if (!isOpen() || isPaused()) return;
    if (e.relatedTarget && container.contains(e.relatedTarget)) return;
    if (!e.relatedTarget && !document.hasFocus()) return;
    onDismiss();
  });
}
