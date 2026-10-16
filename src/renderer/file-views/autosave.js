// Autosave for the text editor of the file preview (#863).
//
// DOM-free: it knows the editor only as `getText()` and the disk only as
// `write(text, { baseHash, force })`, so that it can be tested without a
// node and does not change when CodeMirror replaces the textarea (#864).
//
// The *base* is the text on disk the editor's text was last in step with:
// what it started from, or what it saved last. A write sends the base's
// SHA-256 along, and main refuses to overwrite a file that no longer has it
// (`conflict`). Nothing is overwritten silently in either direction: a change
// on disk while the user has unsaved text is a conflict as well, and only the
// user resolves it — keep mine, or take the version on disk.
//
// States, reported through `onState({ status, reason, conflict })`:
//   idle     nothing typed since the editor opened or took the disk version
//   pending  typed; a save is due once the typing pauses (AUTOSAVE_DELAY_MS)
//   saving   a write is under way
//   saved    the text on disk is the editor's text
//   failed   the last write failed — `reason` says why; typing tries again
//   conflict the disk and the editor went apart — `conflict` is 'changed' or
//            'deleted'; nothing is saved until the user chooses

export const AUTOSAVE_DELAY_MS = 1000;

export const SAVE_STATES = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  SAVING: 'saving',
  SAVED: 'saved',
  FAILED: 'failed',
  CONFLICT: 'conflict',
});

/** SHA-256 of the text's UTF-8 bytes, as hex — what main compares with. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createAutosave({
  base,
  getText,
  write,
  onState = () => {},
  hash = sha256Hex,
  delay = AUTOSAVE_DELAY_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let baseText = base;
  let state = { status: SAVE_STATES.IDLE, reason: null, conflict: null };
  let timer = null;
  // The write under way, and the text it carries.
  let inFlight = null;
  let inFlightText = null;
  let disposed = false;

  function setState(next) {
    state = { status: next.status, reason: next.reason ?? null, conflict: next.conflict ?? null };
    if (!disposed) onState({ ...state });
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delay);
  }

  /** Does the editor hold text that is not on disk? */
  function isDirty() {
    return getText() !== baseText;
  }

  async function runWrite({ force = false } = {}) {
    const text = getText();
    if (!force && text === baseText) {
      if (state.status === SAVE_STATES.PENDING) setState({ status: SAVE_STATES.SAVED });
      return true;
    }
    setState({ status: SAVE_STATES.SAVING });
    inFlightText = text;
    let result;
    try {
      result = await write(text, { baseHash: await hash(baseText), force });
    } catch (err) {
      result = { error: err?.message ?? String(err), reason: 'failed' };
    } finally {
      inFlightText = null;
    }
    if (disposed) return false;
    if (result?.ok) {
      baseText = text;
      if (getText() !== text) {
        // Typed on while it was saving: that is the next save.
        setState({ status: SAVE_STATES.PENDING });
        schedule();
      } else {
        setState({ status: SAVE_STATES.SAVED });
      }
      return true;
    }
    if (result?.conflict) {
      setState({ status: SAVE_STATES.CONFLICT, conflict: result.conflict });
      return false;
    }
    setState({ status: SAVE_STATES.FAILED, reason: result?.reason || 'failed' });
    return false;
  }

  /**
   * Saves now, if there is anything to save. Resolves to true when the disk
   * holds the editor's text afterwards; false on a failure or a conflict,
   * which stay on show.
   */
  async function flush({ force = false } = {}) {
    cancelTimer();
    while (inFlight) await inFlight;
    if (disposed) return false;
    if (state.status === SAVE_STATES.CONFLICT && !force) return false;
    inFlight = runWrite({ force });
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    get state() {
      return { ...state };
    },
    isDirty,
    /** The user typed. */
    changed() {
      if (state.status === SAVE_STATES.CONFLICT) return;
      if (state.status !== SAVE_STATES.SAVING) setState({ status: SAVE_STATES.PENDING });
      schedule();
    },
    flush,
    /**
     * The file on disk now reads `content`. Answers what the editor should
     * do: 'ignore' (it is this editor's own text), 'replace' (nothing of the
     * user's is lost by taking it) or 'conflict' (now on show).
     */
    external(content) {
      if (content === baseText || content === inFlightText || content === getText()) {
        if (content === getText() && content !== baseText && !inFlightText) {
          baseText = content;
          cancelTimer();
          setState({ status: SAVE_STATES.SAVED });
        }
        return 'ignore';
      }
      if (inFlight) {
        // The write itself compares with the disk; its answer decides.
        return 'ignore';
      }
      if (!isDirty() && state.status !== SAVE_STATES.CONFLICT) {
        baseText = content;
        return 'replace';
      }
      cancelTimer();
      setState({ status: SAVE_STATES.CONFLICT, conflict: 'changed' });
      return 'conflict';
    },
    /** Keep the editor's text: written over whatever is on disk. */
    keepMine() {
      return flush({ force: true });
    },
    /**
     * The editor now shows `content`, the text on disk — the user took the
     * version on disk, or discarded their changes.
     */
    adopt(content) {
      cancelTimer();
      baseText = content;
      setState({ status: SAVE_STATES.IDLE });
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
