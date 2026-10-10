const path = require('path');
const { pathToFileURL } = require('url');

const RENDERER_URL = pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'index.html')).href;

/**
 * Single source of truth for the app renderer URL. Both navigation and permission
 * grants use this check so another local file can never inherit the main window's
 * privileges.
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
const MANUAL_URL = pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'manual.html')).href;

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

function createRendererNavigationHandler() {
  return (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  };
}

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
 */
function isAudioOnlyRequest(details) {
  const types = details && details.mediaTypes;
  return Array.isArray(types) && types.length > 0 && types.every((type) => type === 'audio');
}

/**
 * Allows microphone capture for voice input (Whisper) in the renderer — the
 * microphone only, never the camera.
 * Denies other permission prompts explicitly (default Electron behavior is prompt/deny depending on OS).
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
