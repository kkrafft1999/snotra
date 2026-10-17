'use strict';

/**
 * Carries the renderer's `localStorage` over from `file://` to the app's own
 * scheme, once per profile (#1012).
 *
 * `localStorage` belongs to an origin. Until #1012 the pages came from
 * `file://`; from `snotra-app://app` they start with an empty store, and the
 * user's appearance (light or dark) and the manual's zoom would fall back to
 * their defaults on the first start after the update. The appearance has to
 * be there at the first paint (ThemeManager.js), so the values move before
 * the app window opens.
 *
 * A hidden window reads them on an empty page under `file:` — written to
 * userData for the moment — and writes them on `storage-carrier.html` under
 * the new origin. A profile without a `Local Storage` folder never had a store
 * and gets no page at all. A marker file in userData ends it for good,
 * whatever came of it: a profile whose old store could not be read keeps the
 * defaults, as a fresh one does. The whole step has a deadline, so it never
 * holds up the start.
 */

const nodePath = require('path');
const { pathToFileURL } = require('url');
const { appUrl } = require('./app-protocol');

// Written out again in READ_SCRIPT below; the test holds the two together.
const MIGRATED_KEYS = Object.freeze(['theme', 'manual.zoom']);
const MARKER_FILENAME = 'renderer-storage-origin.json';
const DEADLINE_MS = 3000;
// An empty page: it has an origin and runs nothing. Under the app scheme it
// is served from src/renderer/; for file: a copy is written to userData,
// because with GrantFileProtocolExtraPrivileges off `file:` no longer reads
// inside app.asar. Every file: URL is the one origin `file://`.
const CARRIER = 'storage-carrier.html';
const FILE_CARRIER_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Snotra Agent</title></head><body></body></html>\n';

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Both scripts are fixed text: no value from either store is ever part of
// code. The keys are written out here; the values travel to the new origin in
// the page's fragment, which never reaches the protocol handler.
const READ_SCRIPT = `(() => {
  const out = {};
  for (const key of ['theme', 'manual.zoom']) {
    const value = localStorage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
})()`;
// What the new origin already holds was set after the update and wins.
const WRITE_SCRIPT = `(() => {
  const values = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
})()`;

async function copyStorage(contents, keys, fileCarrier) {
  await contents.loadURL(pathToFileURL(fileCarrier).href);
  const values = await contents.executeJavaScript(READ_SCRIPT);
  const found = keys.filter((key) => typeof values?.[key] === 'string');
  if (found.length === 0) return [];
  const moved = Object.fromEntries(found.map((key) => [key, values[key]]));
  await contents.loadURL(`${appUrl(CARRIER)}#${encodeURIComponent(JSON.stringify(moved))}`);
  await contents.executeJavaScript(WRITE_SCRIPT);
  return found;
}

async function hasStore(userDataDir, fs) {
  try {
    await fs.access(nodePath.join(userDataDir, 'Local Storage'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `createWindow()` → a hidden BrowserWindow (a WebContents without a window
 * does not load `file:`), `userDataDir` holds the marker. The result's
 * `release()` closes that window; the caller calls it once the app window is
 * open, since off macOS the last window closing ends the app.
 */
async function migrateRendererStorage({ createWindow, userDataDir, fs, log = console, deadlineMs = DEADLINE_MS }) {
  const nothing = () => {};
  const marker = nodePath.join(userDataDir, MARKER_FILENAME);
  try {
    await fs.access(marker);
    return { skipped: true, moved: [], release: nothing };
  } catch {
    // Not done yet.
  }
  let carrier = null;
  let moved = [];
  const fileCarrier = nodePath.join(userDataDir, CARRIER);
  try {
    // A profile that never had a store has nothing to carry: no page then.
    if (await hasStore(userDataDir, fs)) {
      await fs.writeFile(fileCarrier, FILE_CARRIER_HTML, 'utf8');
      carrier = createWindow();
      moved = await withDeadline(copyStorage(carrier.webContents, MIGRATED_KEYS, fileCarrier), deadlineMs);
    }
  } catch (error) {
    log.warn?.('Renderer storage was not carried over to the app scheme:', error?.message ?? error);
  }
  await fs.rm(fileCarrier, { force: true }).catch(() => {});
  const release = () => {
    try {
      if (carrier && !carrier.isDestroyed()) carrier.destroy();
    } catch {
      // Gone already.
    }
  };
  try {
    await fs.writeFile(marker, `${JSON.stringify({ origin: 'snotra-app://app', moved })}\n`, 'utf8');
  } catch (error) {
    log.warn?.('The marker of the storage move could not be written:', error?.message ?? error);
  }
  return { skipped: false, moved, release };
}

module.exports = { migrateRendererStorage, MIGRATED_KEYS, MARKER_FILENAME };
