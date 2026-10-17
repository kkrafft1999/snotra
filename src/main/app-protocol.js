'use strict';

/**
 * The app's own pages come from `snotra-app://app/`, not from `file:`
 * (AR-37, #1012).
 *
 * Under `file:` the CSP's `'self'` meant every file on the disk: a script tag
 * that slipped past DOMPurify could have loaded any `.js` the user has. From a
 * scheme of its own, `'self'` is this origin, and the origin answers from
 * `src/renderer/` alone — inside app.asar in the packaged app. No page needs
 * `file:` any more, so the GrantFileProtocolExtraPrivileges fuse is off
 * (#1086).
 *
 * The handler lives in the default session only. The HTML preview has its own
 * session (#479) and cannot reach the app's files through this scheme.
 */

const nodePath = require('path');

const APP_SCHEME = 'snotra-app';
const APP_HOST = 'app';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const RENDERER_ROOT = nodePath.resolve(__dirname, '..', 'renderer');

/** The scheme for the app's start, before `app.whenReady()`. */
const APP_SCHEME_PRIVILEGES = Object.freeze({
  scheme: APP_SCHEME,
  // `standard` for relative URLs and one origin, `secure` for the microphone,
  // the audio worklet and `crypto.randomUUID`, `codeCache` so V8 keeps what
  // it compiled across starts, as it did under `file:`. No fetch API and no
  // CORS: the CSP has `connect-src 'none'`, and no other origin reads from
  // here. No service workers, no bypass of the CSP.
  privileges: { standard: true, secure: true, codeCache: true },
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
});

function appMimeType(filePath) {
  return MIME_TYPES[nodePath.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** The URL of a file in `src/renderer/`, given relative to it with `/`. */
function appUrl(relativePath) {
  return `${APP_ORIGIN}/${relativePath}`;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The file a URL of the scheme names, or null: another scheme or host, an
 * encoded separator, a dot segment, anything that would leave `root`.
 */
function resolveAppPath(rawUrl, root = RENDERER_ROOT) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  const segments = url.pathname.split('/').slice(1).map(safeDecode);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === null || segment === '' || segment === '.' || segment === '..') return null;
    if (/[\\/\0]/.test(segment)) return null;
  }
  const resolvedRoot = nodePath.resolve(root);
  const absPath = nodePath.resolve(resolvedRoot, ...segments);
  if (!absPath.startsWith(resolvedRoot + nodePath.sep)) return null;
  return absPath;
}

/** `(request) → Response` for `protocol.handle`. */
function createAppProtocolHandler({ root = RENDERER_ROOT, readFile = require('fs/promises').readFile } = {}) {
  return async function serveAppFile(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const absPath = resolveAppPath(request.url, root);
    if (!absPath) return new Response(null, { status: 404 });
    let body;
    try {
      body = await readFile(absPath);
    } catch {
      return new Response(null, { status: 404 });
    }
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': appMimeType(absPath),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}

/** Serves the scheme in the default session; once the app is ready. */
function registerAppProtocol(protocol, options) {
  protocol.handle(APP_SCHEME, createAppProtocolHandler(options));
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME_PRIVILEGES,
  RENDERER_ROOT,
  appUrl,
  appMimeType,
  resolveAppPath,
  createAppProtocolHandler,
  registerAppProtocol,
};
