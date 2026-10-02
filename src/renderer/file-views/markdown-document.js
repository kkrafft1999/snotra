// The parts of the Markdown viewer (#344) that do not need a mounted view:
// splitting off the front matter, resolving the paths a document points to,
// and turning sanitized HTML into a tree that is safe to put on screen.
//
// Nothing here talks to the main process. `markdown-view.js` owns the
// lifecycle, the images and the clicks.

import contracts from '../generated/contracts.js';
import frontmatterParser from '../generated/skill-frontmatter.js';
import { inertHtmlFragment, isOpenableLink, markdownToSafeHtml } from '../utils/helpers.js';
import { resolveNative } from '../utils/nativePath.js';

const { decodeWorkspaceImageSource, isWindowsDrivePath } = contracts;
const { splitFrontmatter, parseFrontmatterLines } = frontmatterParser;

const TOP_LEVEL_KEY = /^([A-Za-z0-9_.-]+)\s*:/;
const BLOCK_SCALAR = /:\s*[|>][0-9]*[-+]?\s*(#.*)?$/;

// ── Front matter ────────────────────────────────────────────────────────────

/**
 * Splits a document into its YAML head and the Markdown after it.
 *
 * `frontMatter` is null without a head, otherwise either
 * `{ entries: [{ key, value }|{ key, nested }] }` or, when the head cannot be
 * read as key/value pairs, `{ raw }` with the lines as they are.
 */
export function splitDocument(text) {
  const source = String(text ?? '');
  const split = splitFrontmatter(source);
  if (!split) return { frontMatter: null, body: source };
  return { frontMatter: readFrontMatter(split.frontmatterLines), body: split.body };
}

/**
 * Every top-level key is parsed on its own. The shared parser flattens a
 * nested map into its parent (it only ever needs `name` and `description`), so
 * handing it the whole head would put `owner:` from under `metadata:` next to
 * `name:` as if it were one of them. A nested map is shown as it is written.
 */
function readFrontMatter(lines) {
  const groups = [];
  for (const line of lines) {
    if (TOP_LEVEL_KEY.test(line)) {
      groups.push([line]);
    } else if (groups.length > 0) {
      groups[groups.length - 1].push(line);
    } else if (line.trim() && !line.trim().startsWith('#')) {
      // Content before the first key is no key/value head.
      return { raw: lines.join('\n') };
    }
  }
  if (groups.length === 0) return lines.some((line) => line.trim()) ? { raw: lines.join('\n') } : null;

  const entries = groups.map((group) => {
    const key = TOP_LEVEL_KEY.exec(group[0])[1];
    const continuation = group.slice(1);
    const isNestedMap = !BLOCK_SCALAR.test(group[0])
      && continuation.some((line) => /^\s+[A-Za-z0-9_.-]+\s*:/.test(line));
    if (isNestedMap) return { key, nested: dedent(continuation).join('\n').trimEnd() };
    const value = parseFrontmatterLines(group)[key];
    if (Array.isArray(value)) return { key, value: value.join(', ') };
    return { key, value: value === undefined ? '' : String(value).replace(/\n+$/, '') };
  });
  return { entries };
}

function dedent(lines) {
  const indents = lines.filter((line) => line.trim()).map((line) => /^ */.exec(line.replace(/\t/g, '  '))[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.replace(/\t/g, '  ').slice(cut));
}

// ── Paths inside the document ───────────────────────────────────────────────

/**
 * The path a link or image names, as the reader wrote it: without query and
 * fragment, percent-decoding undone — what a tooltip or a notice shows.
 *
 * Query and fragment are split off while the address is still encoded
 * (CR-B18-09, #641): `plot%231.png` is a file called `plot#1.png`, and
 * decoding first would leave a `#` that cuts the name down to `plot`.
 */
export function documentPathOf(raw) {
  return decodeWorkspaceImageSource(String(raw ?? '').trim().replace(/[?#].*$/, ''));
}

/**
 * Where a link or image of the document points, as a native absolute path.
 *
 * Relative paths start at the folder of the file. A leading `/` means the root
 * of the open folder, as it does on GitHub — a README is written for its
 * repository, not for the disk it happens to lie on. A Windows drive path is
 * taken as it is. Query and fragment are not part of the path.
 */
export function resolveDocumentPath(raw, { fileDir, workspaceRoot }) {
  const pathPart = documentPathOf(raw);
  if (!pathPart) return null;
  if (isWindowsDrivePath(pathPart)) return pathPart;
  const posix = pathPart.replace(/\\/g, '/');
  if (posix.startsWith('/')) {
    return workspaceRoot ? resolveNative(workspaceRoot, posix.slice(1)) : null;
  }
  return resolveNative(fileDir, posix);
}

/** Slug of a heading, the way GitHub builds it for `#anchor` links. */
export function headingSlug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * What a link of the document does when clicked:
 *   { kind: 'external', href }   — http(s)/mailto, opened by the main process
 *   { kind: 'anchor', slug }     — a heading in this document
 *   { kind: 'file', target, fragment } — another file of the workspace
 *   null                         — nothing; the link text stays as text
 */
export function classifyLink(anchor) {
  const workspaceHref = anchor.getAttribute('data-workspace-href');
  const href = (workspaceHref ?? anchor.getAttribute('href') ?? '').trim();
  if (!href) return null;
  if (workspaceHref === null && isOpenableLink(href)) return { kind: 'external', href };
  if (href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith('#')) return { kind: 'anchor', slug: decodeFragment(href.slice(1)) };
  const hashAt = href.indexOf('#');
  return {
    kind: 'file',
    target: hashAt === -1 ? href : href.slice(0, hashAt),
    fragment: hashAt === -1 ? '' : decodeFragment(href.slice(hashAt + 1)),
  };
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// ── From Markdown to a tree ─────────────────────────────────────────────────

/**
 * Renders the Markdown body into an inert fragment.
 *
 * `inertHtmlFragment()` keeps every image from loading: its `src` waits in
 * `data-md-src` until `markdown-view.js` fills it in through
 * `fs:readWorkspaceImage` or replaces it with a placeholder.
 */
export function renderMarkdownFragment(body) {
  const root = inertHtmlFragment(
    markdownToSafeHtml(body, { breaks: false, keepRelativeLinks: true })
  );

  for (const img of root.querySelectorAll('img')) {
    // An image alone in its paragraph is a figure and gets the full width; one
    // inside a sentence — a badge in a README line — stays in the line.
    const paragraph = img.closest('p');
    if (paragraph && paragraph.querySelectorAll('img').length === 1 && !paragraph.textContent.trim()) {
      paragraph.classList.add('md-figure');
    }
  }

  // Anchors for `#section` links. Deliberately not `id`: a heading called
  // "Chat input" must not become a second `#chat-input` in the window — and
  // the sanitizer drops every `id` the document writes itself (#635). A
  // `data-*` attribute does get through it, so only a heading may carry the
  // anchor: one the document put on a `<div>` would take the link's scroll
  // and focus away from the heading it names.
  for (const el of root.querySelectorAll('[data-md-anchor]')) el.removeAttribute('data-md-anchor');
  const seen = new Map();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = headingSlug(heading.textContent);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.setAttribute('data-md-anchor', count === 0 ? base : `${base}-${count}`);
  }

  // A wide table scrolls inside its own frame instead of widening the pane.
  for (const table of root.querySelectorAll('table')) {
    const frame = document.createElement('div');
    frame.className = 'md-table-frame';
    table.replaceWith(frame);
    frame.append(table);
  }

  return root;
}
