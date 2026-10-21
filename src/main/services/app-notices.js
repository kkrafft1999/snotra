'use strict';

const { NOTICE_KINDS, REMOTE_WORKSPACE_SWITCHED_NOTICE_ID, normalizeNotice } = require('../../shared/contracts/notices');

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
 *
 * @typedef {NonNullable<ReturnType<typeof normalizeNotice>>} Notice
 * @typedef {{ type: 'posted', notice: Notice }|{ type: 'withdrawn', id: string }} NoticeEvent
 *
 * @param {object} [options]
 * @param {{ warn?: (message: string) => void }|null} [options.log]
 */
function createAppNotices({ log = console } = {}) {
  /** @type {Map<string, Notice>} */
  const notices = new Map();
  /** @type {Set<(event: NoticeEvent) => void>} */
  const listeners = new Set();

  /** @param {NoticeEvent} event */
  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log?.warn?.(`[notices] a listener failed: ${error?.message || error}`);
      }
    }
  }

  /** @param {unknown} input  A notice as the contract describes it; anything that does not fit is dropped. */
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

  /** @param {string} id */
  function withdraw(id) {
    if (!notices.delete(id)) return false;
    emit({ type: 'withdrawn', id });
    return true;
  }

  function list() {
    return [...notices.values()];
  }

  /** The user closed it: gone for this start, nothing to tell the window. */
  /** @param {string} id */
  function dismiss(id) {
    return notices.delete(id);
  }

  /** @param {string} id */
  function get(id) {
    return notices.get(id) || null;
  }

  /** @param {(event: NoticeEvent) => void} listener */
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
 *
 * @param {Pick<ReturnType<typeof createAppNotices>, 'post' | 'get' | 'withdraw'>} notices
 * @param {{ type: string, store: string, file: string, path?: string, keptAs?: string|null }|null|undefined} event
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

/**
 * The phone opened another folder at the desktop (#1194): whoever sits there
 * sees why the tree and the chat changed. One notice — a second switch
 * replaces it — with the folder's name only.
 *
 * @param {{ post: (input: unknown) => unknown }} notices
 * @param {string} folder
 */
function postRemoteWorkspaceSwitch(notices, folder) {
  notices.post({ id: REMOTE_WORKSPACE_SWITCHED_NOTICE_ID, kind: NOTICE_KINDS.REMOTE_WORKSPACE_SWITCHED, folder });
}

module.exports = { createAppNotices, postStoreFileEvent, postRemoteWorkspaceSwitch };
