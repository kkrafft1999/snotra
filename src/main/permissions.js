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
    if (permission === 'media' || permission === 'audioCapture') {
      callback(true);
      return;
    }
    callback(false);
  };
}

/**
 * Allows microphone capture for voice input (Whisper) in the renderer.
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
  RENDERER_URL,
};
