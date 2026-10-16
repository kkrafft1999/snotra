'use strict';

const { NOTICE_KINDS, normalizeNotice } = require('../../shared/contracts/notices');

/**
 * The notices of this start (#1001, the notice channel of #978).
 *
 * Stores are read before the window exists, so a notice is kept here until
 * the renderer asks for the list, and pushed to every listener as it comes.
 * One notice per id: posting the same id again replaces it and shows it
 * again, even after it was dismissed — it is news once more. A notice whose
 * cause is gone is withdrawn, so the window does not keep a stale warning.
 *
 * Listeners get `{ type: 'posted', notice }` or `{ type: 'withdrawn', id }`.
 */
function createAppNotices({ log = console } = {}) {
  const notices = new Map();
  const listeners = new Set();

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log?.warn?.(`[notices] a listener failed: ${error?.message || error}`);
      }
    }
  }

  function post(input) {
    const notice = normalizeNotice(input);
    if (!notice) {
      log?.warn?.('[notices] dropped a notice that does not fit the contract');
      return null;
    }
    notices.delete(notice.id);
    notices.set(notice.id, notice);
    emit({ type: 'posted', notice });
    return notice;
  }

  function withdraw(id) {
    if (!notices.delete(id)) return false;
    emit({ type: 'withdrawn', id });
    return true;
  }

  function list() {
    return [...notices.values()];
  }

  /** The user closed it: gone for this start, nothing to tell the window. */
  function dismiss(id) {
    return notices.delete(id);
  }

  function get(id) {
    return notices.get(id) || null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { post, withdraw, list, dismiss, get, subscribe };
}

/**
 * Turns what the storage service reports about a store's file (#1001) into
 * a notice: one per file, the set-aside naming its copy, the unsaved file
 * naming itself. A file that is saved again takes its warning back; a
 * set-aside stays, because the copy is still there to be found.
 */
function postStoreFileEvent(notices, event) {
  if (!event || typeof event !== 'object') return;
  const id = `store:${event.file}`;
  const base = { id, store: event.store, file: event.file };
  if (event.type === 'set-aside') {
    notices.post({ ...base, kind: NOTICE_KINDS.STORE_SET_ASIDE, location: event.keptAs });
  } else if (event.type === 'not-saved') {
    notices.post({ ...base, kind: NOTICE_KINDS.STORE_NOT_SAVED, location: event.path });
  } else if (event.type === 'saved-again') {
    if (notices.get(id)?.kind === NOTICE_KINDS.STORE_NOT_SAVED) notices.withdraw(id);
  }
}

module.exports = { createAppNotices, postStoreFileEvent };
