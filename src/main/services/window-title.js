'use strict';

/**
 * The native window title (#676): Dock, window menu, Mission Control and the
 * app switcher show it. The renderer names the open workspace in
 * `document.title` (`snotra — Snotra Agent`); main adds the version, which the
 * title has carried since before the workspace was in it.
 *
 * @param {unknown} documentTitle
 * @param {string} [version]
 */
function windowTitle(documentTitle, version) {
  const base = typeof documentTitle === 'string' && documentTitle.trim() ? documentTitle.trim() : 'Snotra Agent';
  return version ? `${base} ${version}` : base;
}

module.exports = { windowTitle };
