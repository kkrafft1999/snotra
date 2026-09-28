/**
 * Which directory entries the folder panel and the `@` menu list (#436).
 *
 * A hidden entry is one whose name starts with a dot — the convention on
 * macOS and Linux, and the one developer tools follow on Windows as well. The
 * Windows "hidden" attribute is not read: Node has no API for it, and the
 * files Explorer typically hides that way are on the list below.
 *
 * Some entries stay out even when hidden files are shown. They are system
 * noise nobody browses, and `.git` is also left alone by the workspace
 * watcher, so a tree drawn inside it would go stale. The comparison ignores
 * case, since Windows and a default macOS volume do too.
 *
 * What the model lists through its own tools follows its own rules
 * (`readWorkspaceEntries` in fs-service.js); this module is only about what the
 * user sees.
 */
'use strict';

const ALWAYS_HIDDEN_ENTRY_NAMES = Object.freeze(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

const alwaysHiddenLower = new Set(ALWAYS_HIDDEN_ENTRY_NAMES.map((name) => name.toLowerCase()));

function isHiddenEntryName(name) {
  return typeof name === 'string' && name.startsWith('.');
}

function isAlwaysHiddenEntryName(name) {
  return typeof name === 'string' && alwaysHiddenLower.has(name.toLowerCase());
}

/** Whether an entry of that name is listed, with hidden files shown or not. */
function isListedEntryName(name, { showHidden = false } = {}) {
  if (isAlwaysHiddenEntryName(name)) return false;
  return showHidden === true || !isHiddenEntryName(name);
}

module.exports = {
  ALWAYS_HIDDEN_ENTRY_NAMES,
  isHiddenEntryName,
  isAlwaysHiddenEntryName,
  isListedEntryName,
};
