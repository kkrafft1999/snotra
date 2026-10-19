const { appUrl } = require('./app-protocol');

// Served from the app's own scheme, not from `file:` (#1012).
const RENDERER_URL = appUrl('index.html');

/**
 * Single source of truth for the app renderer URL. Both navigation and permission
 * grants use this check so another local file can never inherit the main window's
 * privileges.
 *
 * @param {unknown} rawUrl
 */
function isTrustedRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return false;
  }
  return (
    rawUrl === RENDERER_URL ||
    rawUrl.startsWith(`${RENDERER_URL}#`) ||
    rawUrl.startsWith(`${RENDERER_URL}?`)
  );
}

/** The help window's page (#790). It gets the manual channels and nothing else. */
const MANUAL_URL = appUrl('manual.html');

/** @param {unknown} rawUrl */
function isManualRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return false;
  }
  return (
    rawUrl === MANUAL_URL ||
    rawUrl.startsWith(`${MANUAL_URL}#`) ||
    rawUrl.startsWith(`${MANUAL_URL}?`)
  );
}

/** @returns {(event: { preventDefault: () => void }, url: string) => void} */
function createRendererNavigationHandler() {
  return (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  };
}

/** @returns {NonNullable<Parameters<import('electron').Session['setPermissionRequestHandler']>[0]>} */
function createPermissionRequestHandler() {
  return (webContents, permission, callback, details) => {
    const requestingUrl =
      (details && details.requestingUrl) || (webContents && webContents.getURL()) || '';
    if (!isTrustedRendererUrl(requestingUrl)) {
      callback(false);
      return;
    }
    callback(permission === 'media' && isAudioOnlyRequest(details));
  };
}

/**
 * A `media` request covers the camera as well; `mediaTypes` says what it asks
 * for (#509). Only the microphone alone is granted — a request without the
 * list, or with `video` in it, is not.
 *
 * @param {object|null|undefined} details  Electron's request details; only a media request has `mediaTypes`
 */
function isAudioOnlyRequest(details) {
  const types = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
  return Array.isArray(types) && types.length > 0 && types.every((type) => type === 'audio');
}

/**
 * Allows microphone capture for voice input (Whisper) in the renderer — the
 * microphone only, never the camera.
 * Denies other permission prompts explicitly (default Electron behavior is prompt/deny depending on OS).
 *
 * @param {Pick<import('electron').Session, 'setPermissionRequestHandler'>} [browserSession]  the default session when left out
 */
function registerMediaCapturePermissions(browserSession) {
  const targetSession = browserSession || require('electron').session.defaultSession;
  targetSession.setPermissionRequestHandler(createPermissionRequestHandler());
}

module.exports = {
  registerMediaCapturePermissions,
  createPermissionRequestHandler,
  createRendererNavigationHandler,
  isTrustedRendererUrl,
  isManualRendererUrl,
  RENDERER_URL,
  MANUAL_URL,
};
