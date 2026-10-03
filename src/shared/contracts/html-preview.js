'use strict';

/**
 * Contract for the HTML view in the file preview (#479): an `.html` file of
 * the open folder shown as a live page, scripts included, isolated from the
 * app.
 *
 * The page does not run in the app's renderer. The renderer's CSP
 * (`default-src 'none'`, no `frame-src`) admits no frame at all, and an
 * `about:srcdoc` frame would inherit `script-src 'self'` and run no script —
 * both stay as they are. The page runs in a `WebContentsView` of its own that
 * the main process lays over the preview column: its own process, its own
 * in-memory session, no preload, and a scheme of its own, `snotra-html:`,
 * that only that session knows. Main decides every byte the page gets; the
 * renderer only says where the view goes. See `html-preview-service.js`.
 */

const HTML_PREVIEW_SCHEME = 'snotra-html';

/** The session the pages live in. No `persist:` prefix: in memory only. */
const HTML_PREVIEW_PARTITION = 'snotra-html-preview';

const HTML_FILE_EXTENSIONS = Object.freeze(['html', 'htm']);

/** The page itself, and any other HTML file it loads: the preview limit of `fs:readFile`. */
const MAX_HTML_PREVIEW_BYTES = 1024 * 1024;

/** Any other file the page loads: the limit of a workspace image (#244). */
const MAX_HTML_ASSET_BYTES = 10 * 1024 * 1024;

/** How many refused requests a page lists; the count goes on beyond it. */
const MAX_HTML_PREVIEW_BLOCKED = 200;

/**
 * Why the page itself is not shown. The first four share their values with
 * the image and PDF contracts.
 */
const HTML_PREVIEW_ERRORS = Object.freeze({
  NO_WORKSPACE: 'no-workspace',
  OUTSIDE_WORKSPACE: 'outside-workspace',
  NOT_FOUND: 'not-found',
  TOO_LARGE: 'too-large',
  UNAVAILABLE: 'unavailable',
});

/**
 * Why a page did not get something it asked for. Every one is listed in the
 * notice above the page — a broken page with no word about it would be a
 * state without feedback.
 */
const HTML_PREVIEW_BLOCK_REASONS = Object.freeze({
  /** Anything that would leave the machine: http(s), WebSocket, a form post. */
  NETWORK: 'network',
  /** A path that resolves outside the open folder, a symlink out of it included. */
  OUTSIDE_WORKSPACE: 'outside-workspace',
  /** A local file that is not there. */
  NOT_FOUND: 'not-found',
  /** A local file over the limit. */
  TOO_LARGE: 'too-large',
  /** A link followed or a window opened by script, without a click. */
  NAVIGATION: 'navigation',
  /** A download, which the preview never starts. */
  DOWNLOAD: 'download',
});

/**
 * Content types by extension. A page whose stylesheet arrives as
 * `application/octet-stream` is not styled, and a module script is not run,
 * so the common ones are spelled out; everything else is octet-stream and
 * `nosniff` keeps it that way.
 */
const HTML_PREVIEW_MIME_TYPES = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'application/xhtml+xml',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
});

function extensionOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Is this a file the HTML view takes? By name, as the registry decides. */
function isHtmlFileName(name) {
  return HTML_FILE_EXTENSIONS.includes(extensionOf(name));
}

function htmlPreviewMimeType(name) {
  return HTML_PREVIEW_MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * A link in a chat answer that points at an HTML file (#479): relative,
 * absolute, a Windows drive path or a `file:` URL. Answers
 * `{ path, fragment }` — the path as written, percent-decoding undone, query
 * and fragment split off while still encoded — or null for anything else. The
 * path is not resolved here: the renderer puts a relative one under the open
 * folder, and the tree refuses what lies outside it.
 */
function htmlLinkTargetOf(href) {
  let raw = typeof href === 'string' ? href.trim() : '';
  if (!raw || raw.startsWith('//')) return null;
  let fromFileUrl = false;
  if (/^file:/i.test(raw)) {
    raw = raw.replace(/^file:(\/\/[^/]*)?/i, '');
    fromFileUrl = true;
    // `file:///C:/x.html` carries a drive after the slash.
    if (/^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(raw)) {
    return null;
  }
  const hashAt = raw.indexOf('#');
  const fragmentRaw = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  let pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const queryAt = pathPart.indexOf('?');
  if (queryAt >= 0) pathPart = pathPart.slice(0, queryAt);
  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(pathPart);
    fragment = decodeURIComponent(fragmentRaw);
  } catch {
    return null;
  }
  if (!decodedPath || decodedPath.includes('\0')) return null;
  if (fromFileUrl && !decodedPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(decodedPath)) return null;
  if (!isHtmlFileName(decodedPath)) return null;
  return { path: decodedPath, fragment };
}

module.exports = {
  HTML_PREVIEW_SCHEME,
  HTML_PREVIEW_PARTITION,
  HTML_FILE_EXTENSIONS,
  MAX_HTML_PREVIEW_BYTES,
  MAX_HTML_ASSET_BYTES,
  MAX_HTML_PREVIEW_BLOCKED,
  HTML_PREVIEW_ERRORS,
  HTML_PREVIEW_BLOCK_REASONS,
  HTML_PREVIEW_MIME_TYPES,
  isHtmlFileName,
  htmlPreviewMimeType,
  htmlLinkTargetOf,
};
