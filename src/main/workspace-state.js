const path = require('path');

/** @type {string | null} */
let activeWorkspaceRoot = null;

/**
 * @param {unknown} folderPath
 */
function setActiveWorkspaceRoot(folderPath) {
  const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
  activeWorkspaceRoot = raw ? path.resolve(raw) : null;
}

function getActiveWorkspaceRoot() {
  return activeWorkspaceRoot;
}

module.exports = {
  setActiveWorkspaceRoot,
  getActiveWorkspaceRoot,
};
