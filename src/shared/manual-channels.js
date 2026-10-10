'use strict';

/**
 * IPC channels of the help window (#790).
 *
 * Kept apart from `ipc-channels.js` on purpose: the help window gets these and
 * nothing else. Its preload exposes only them, and main answers them only for
 * the help page (`isManualRendererUrl`), while the app window's channels refuse
 * the help page the same way they refuse any other sender.
 */
const MANUAL_REQUEST_CHANNELS = Object.freeze({
  /** → { locale, version, webBase } */
  CONTEXT: 'manual:context',
  /** (locale) → { nav, pages } of the bundled manual */
  INDEX: 'manual:index',
  /** (locale, slug) → { slug, title, description, chapter, markdown } */
  PAGE: 'manual:page',
  /** (motif, locale, theme) → data URL of the screenshot variant */
  SCREENSHOT: 'manual:screenshot',
  /** (url) → opens an https link of the manual in the browser */
  OPEN_EXTERNAL: 'manual:openExternal',
});

const MANUAL_PUSH_CHANNELS = Object.freeze({
  /** { slug, fragment } — open this page, sent when the window is already open */
  NAVIGATE: 'manual:navigate',
  /** locale — the app language changed */
  LOCALE: 'manual:locale',
  /** 'back' | 'forward' — the history shortcut or the View menu */
  HISTORY: 'manual:history',
  /** 'in' | 'out' | 'reset' — Cmd/Ctrl with +, − or 0 */
  ZOOM: 'manual:zoom',
});

module.exports = { MANUAL_REQUEST_CHANNELS, MANUAL_PUSH_CHANNELS };
