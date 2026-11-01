'use strict';

/**
 * The chat history: one file per chat and an index, held in memory (#985).
 *
 * Until #985 the history was a single file, `chat-history.json`, and every
 * list, save, delete and pointer change read, decrypted and parsed all of it —
 * up to 200 chats with every message — while every save stringified and
 * encrypted all of it again, on the main thread (AR-10). Now it is a folder:
 *
 *   chat-history/
 *     index.json    what the list needs of each chat (folder, title, time,
 *                   message count, cost, the chat's own settings) and which
 *                   chat each folder opens with
 *     <hash>.json   one chat with its messages; the name is a hash of its id
 *
 * Each file is encrypted with safeStorage as the single file was, and written
 * as plain JSON where encrypted storage is missing, as before. The index is
 * read once and then answered from memory. A chat's file is read when the chat
 * is opened, and the last few stay in memory. A save writes that chat's file
 * and the index, nothing else.
 *
 * **The index is written behind.** Memory is the current state; the index
 * follows it with one write in flight at a time, and whatever changes while
 * one is running goes into the next. A burst of changes — a save, then the
 * folder's pointer — costs two writes at most, and every caller still learns
 * whether the write that carried its change went through. The quit waits for
 * it (`pendingWork`, #679). A chat's own file is written before its save
 * returns, so a failed save still reaches the chat's banner (#977).
 *
 * **The index is a cache of the chats' files, not their only record.** On
 * load it is checked against the folder: an entry whose file is gone is
 * dropped, and a file without an entry — a save whose index write never
 * landed, or every chat when the index itself is lost — is read and taken in.
 *
 * **The rules for files that cannot be read stay as they were** (#473, #557,
 * #561, #566, #658): a file that is there but cannot be read now is left as it
 * is and nothing is written over it; one that cannot be understood is moved
 * aside, every byte kept, before anything takes its path; when that move
 * fails, nothing is written; one written by a newer release is moved aside
 * rather than rewritten; an encrypted one without encrypted storage is left
 * for a later start. A store that cannot be loaded shows an empty history and
 * refuses every write with `CHAT_HISTORY_UNREADABLE`, and the next access
 * tries again.
 *
 * **Migration** from the single file runs on the first load: its chats are
 * written as files, read back and compared, then the index is written, and
 * only then is the old file removed. Anything that fails on the way leaves
 * the old file where it was, and the next start begins again. The index notes
 * a digest of the file it took in, so a copy that outlives its removal (a
 * Windows lock) is not taken in a second time — that would bring back chats
 * deleted since. One with a different digest is merged: an older release run
 * after the update writes a single file again, and its chats are not lost.
 */

const { createHash } = require('crypto');
const { readFileWithRetry, renameWithRetry, unlinkWithRetry } = require('./rename-with-retry');
const { CHAT_SESSION_NOTICE_STORE } = require('../../shared/contracts/notices');
const {
  normalizeSessionForStore,
  normalizeSessionMetaForStore,
  sessionMetaFromSession,
  sessionFromMeta,
} = require('./chat-history-normalization');

/**
 * @typedef {import('./chat-history-normalization').StoredSession} StoredSession
 * @typedef {import('./chat-history-normalization').SessionMeta} SessionMeta
 *
 * An index entry; `plain` marks a chat whose file went to the disk unencrypted.
 * @typedef {SessionMeta & { plain?: true }} IndexedMeta
 *
 * A parsed file: its shape is checked field by field by whoever reads it.
 * @typedef {Record<string, any>} JsonObject
 *
 * What is loaded: the index entries by id, the folder pointers, the digest of
 * the single file taken in, and whether the index itself is plain. `failed`
 * is a store that could not be loaded.
 * @typedef {Object} HistoryState
 * @property {boolean} failed
 * @property {Map<string, IndexedMeta>} metas
 * @property {Record<string, string>} activeByWorkspace
 * @property {string|null} legacyImport
 * @property {boolean} plainIndex
 *
 * A file as read: its status, and what it held when that could be understood.
 * @typedef {{ status: 'missing', encrypted?: undefined }
 *   | { status: 'failed', error: unknown, encrypted?: undefined }
 *   | { status: 'unavailable' | 'undecryptable', raw: string, encrypted: true }
 *   | { status: 'not-understood', raw: string, encrypted?: boolean }
 *   | { status: 'ok', data: JsonObject, raw: string, encrypted: boolean }} EnvelopeRead
 */

const LEGACY_FILENAME = 'chat-history.json';
const LEGACY_VERSION = 2;

/**
 * Error code of every change to a history that could not be read (#473), and
 * of a save of a chat whose file could not be read. The file is there and may
 * be fine, so it is not overwritten.
 */
const CHAT_HISTORY_UNREADABLE = 'CHAT_HISTORY_UNREADABLE';

const STORE_DIRNAME = 'chat-history';
const INDEX_FILENAME = 'index.json';
const STORE_VERSION = 3;
const HISTORY_NOTICE_STORE = 'chatHistory';

/**
 * Suffixes of what is moved aside: one that could not be decrypted or parsed,
 * and one written by a newer release (#566).
 */
const SET_ASIDE = Object.freeze({
  UNDECRYPTABLE: 'undecryptable',
  UNREADABLE: 'unreadable',
});

const SESSION_FILE_RE = /^[0-9a-f]{32}\.json$/;
const SET_ASIDE_SESSION_RE = /^[0-9a-f]{32}\.json\.(?:undecryptable|unreadable)-/;

/** Chats whose file stays in memory once read: the one on screen and a few running behind it. */
const DEFAULT_CACHED_SESSIONS = 8;
/** Files written or read side by side while the single file is taken apart. */
const MIGRATION_BATCH = 16;

/** @type {Readonly<{ OK: 'ok', MISSING: 'missing', FAILED: 'failed', UNAVAILABLE: 'unavailable', UNDECRYPTABLE: 'undecryptable', NOT_UNDERSTOOD: 'not-understood' }>} */
const READ = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  /** There, but reading it failed (#473). */
  FAILED: 'failed',
  /** Encrypted, without encrypted storage in this run (#658). */
  UNAVAILABLE: 'unavailable',
  UNDECRYPTABLE: 'undecryptable',
  NOT_UNDERSTOOD: 'not-understood',
});

/**
 * @param {string} id
 */
function sessionFileName(id) {
  return `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`;
}

/**
 * @param {string} raw
 */
function digestOf(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * @param {string} raw
 * @returns {any}  the parsed file, or undefined when it is not JSON
 */
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} data
 * @returns {data is JsonObject}
 */
function isJsonObject(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data);
}

/**
 * @param {unknown} version
 * @param {number} known
 */
function isNewer(version, known) {
  return typeof version === 'number' && Number.isFinite(version) && version > known;
}

function unreadableError() {
  return Object.assign(
    new Error('The chat history could not be read; it is not overwritten with an empty one.'),
    { code: CHAT_HISTORY_UNREADABLE },
  );
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T) => Promise<unknown>} fn
 */
function inBatches(items, size, fn) {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    chain = chain.then(() => Promise.all(batch.map(fn)));
  }
  return chain;
}

/**
 * The single file as releases before #985 wrote it. A broken envelope
 * (`payload` that is not a string) or a `sessions` that is no list is not
 * taken for an empty history.
 *
 * @param {JsonObject} data
 */
function isLegacyShape(data) {
  if ('payload' in data || 'encrypted' in data) return false;
  return !('sessions' in data) || Array.isArray(data.sessions);
}

/**
 * @param {{ updatedAt: number }} a
 * @param {{ updatedAt: number }} b
 */
function newestFirst(a, b) {
  return b.updatedAt - a.updatedAt;
}

/**
 * @param {object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {Pick<import('../../application/ports/secret-store-port').SecretStorePort, 'isEncryptionAvailable'>} deps.secretStore
 * @param {Pick<import('../../shared/contracts/safe-storage-key').SafeStorageKeyDurability, 'whenDurable' | 'wouldWait'>} deps.safeStorageKey
 * @param {() => string} deps.userDataPath
 * @param {(file: string, data: object) => Promise<void>} deps.writeJsonAtomic the storage's queued atomic write
 * @param {(plain: string) => Promise<string|null>} deps.encryptForDisk
 * @param {(b64: string) => string|null} deps.decryptIfPossible
 * @param {(type: 'set-aside' | 'not-saved' | 'saved-again', file: string, keptAs: string|null, store: string) => void} [deps.reportStoreFile]
 * @param {(raw: unknown) => string|null} deps.normalizeWorkspaceRoot
 * @param {string} deps.noWorkspaceKey the folder pointer's key for chats without a folder
 * @param {number} deps.maxChatSessionsPerFolder the chats a folder keeps, not counting those marked *Keep* (#1320)
 * @param {{ warn?: (message: string) => void, info?: (message: string) => void }|null} [deps.log]
 * @param {string} [deps.platform]
 * @param {number} [deps.cachedSessions]
 */
function createChatHistoryStore({
  fs,
  path,
  secretStore,
  safeStorageKey,
  userDataPath,
  writeJsonAtomic,
  encryptForDisk,
  decryptIfPossible,
  reportStoreFile = () => {},
  normalizeWorkspaceRoot,
  noWorkspaceKey,
  maxChatSessionsPerFolder,
  log = console,
  platform = process.platform,
  cachedSessions = DEFAULT_CACHED_SESSIONS,
}) {
  const legacyPath = () => path.join(userDataPath(), LEGACY_FILENAME);
  const storeDir = () => path.join(userDataPath(), STORE_DIRNAME);
  const indexPath = () => path.join(storeDir(), INDEX_FILENAME);
  const sessionPath = (/** @type {string} */ id) => path.join(storeDir(), sessionFileName(id));

  /** @type {HistoryState|null} */
  let state = null;
  /** @type {Promise<HistoryState>|null} */
  let loading = null;
  /**
   * id → the chat's file as last read or written (store form; never changed in place).
   *
   * @type {Map<string, StoredSession>}
   */
  const cache = new Map();
  /**
   * id → a counter bumped by every save and delete, so a read that took longer does not undo one.
   *
   * @type {Map<string, number>}
   */
  const revisions = new Map();
  /** Names of chat files that are there but could not be read in this run (#473): nothing is written over them. */
  /** @type {Set<string>} */
  const blocked = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Promise<void>|null} */
  let indexWrite = null;
  let indexDirty = false;
  /** @type {HistoryState|null} */
  let indexState = null;
  /** @type {Array<{ resolve: () => void, reject: (error: unknown) => void }>} */
  let indexWaiters = [];
  /** @type {Promise<void>|null} */
  let encryption = null;

  /** @returns {HistoryState} */
  function emptyState() {
    return { failed: false, metas: new Map(), activeByWorkspace: {}, legacyImport: null, plainIndex: false };
  }

  /** @returns {HistoryState} */
  function failedState() {
    return { ...emptyState(), failed: true };
  }

  /**
   * @param {import('./chat-history-normalization').SessionRowInput|null|undefined} row
   */
  function normalizeSession(row) {
    return normalizeSessionForStore(row, { normalizeWorkspaceRoot });
  }

  /**
   * Changes run one after the other, apart from the caller's lock: nothing here waits for that lock.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  }

  /**
   * @param {string} id
   */
  function bump(id) {
    const next = (revisions.get(id) || 0) + 1;
    revisions.set(id, next);
    return next;
  }

  /**
   * @param {string} id
   * @param {StoredSession} session
   */
  function remember(id, session) {
    cache.delete(id);
    cache.set(id, session);
    while (cache.size > cachedSessions) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /**
   * @param {HistoryState} s
   * @param {string} id
   */
  function forget(s, id) {
    bump(id);
    cache.delete(id);
    s.metas.delete(id);
    for (const [key, value] of Object.entries(s.activeByWorkspace)) {
      if (value === id) delete s.activeByWorkspace[key];
    }
  }

  /**
   * @param {HistoryState} s
   */
  function sortedMetas(s) {
    return [...s.metas.values()].sort(newestFirst);
  }

  /**
   * @param {IndexedMeta} meta
   * @returns {SessionMeta}
   */
  function publicMeta(meta) {
    const { plain: _plain, ...rest } = meta;
    return rest;
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /**
   * @param {string} filePath
   * @returns {Promise<EnvelopeRead>}
   */
  async function readEnvelope(filePath) {
    let raw;
    try {
      raw = await readFileWithRetry(fs, filePath, { platform });
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: READ.MISSING };
      return { status: READ.FAILED, error };
    }
    let data = parseJson(raw);
    if (!isJsonObject(data)) return { status: READ.NOT_UNDERSTOOD, raw };
    if (data.encrypted !== true || typeof data.payload !== 'string') {
      return { status: READ.OK, data, raw, encrypted: false };
    }
    // Without encrypted storage the key is out of reach for this run, not
    // wrong (#658) — a refusing keychain, a broken signature as in #657.
    if (!secretStore.isEncryptionAvailable()) return { status: READ.UNAVAILABLE, raw, encrypted: true };
    const plain = decryptIfPossible(data.payload);
    if (!plain) return { status: READ.UNDECRYPTABLE, raw, encrypted: true };
    data = parseJson(plain);
    if (!isJsonObject(data)) return { status: READ.NOT_UNDERSTOOD, raw, encrypted: true };
    return { status: READ.OK, data, raw, encrypted: true };
  }

  /**
   * Writes a file encrypted wherever encrypted storage is there, and resolves
   * to whether it was. Ciphertext waits for its key to be on the disk
   * (#1060); `plainWhileKeyPending` writes plain instead — only for content
   * that was plain to begin with, so the load does not wait for the key.
   *
   * @param {string} filePath
   * @param {object} data
   * @param {{ plainWhileKeyPending?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function writeEnvelope(filePath, data, { plainWhileKeyPending = false } = {}) {
    const encrypt = secretStore.isEncryptionAvailable() && !(plainWhileKeyPending && safeStorageKey.wouldWait());
    if (encrypt) {
      const payload = await encryptForDisk(JSON.stringify(data));
      if (payload) {
        await writeJsonAtomic(filePath, { encrypted: true, payload });
        return true;
      }
    }
    await writeJsonAtomic(filePath, data);
    return false;
  }

  /**
   * Moves a file — or the whole folder — out of the way, every byte kept
   * (#557). False when it is still where it was (#561). Reported with
   * `store` unless that is `null`: an index moved aside loses no chat.
   *
   * @param {string} source
   * @param {string} suffix
   * @param {string|null} store
   */
  async function setAside(source, suffix, store) {
    const target = `${source}.${suffix}-${stamp()}`;
    try {
      await renameWithRetry(fs, source, target, { platform });
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      log?.warn?.(`[chat-history] ${path.basename(source)} could not be read and could not be moved aside, left it as it is: ${error?.message || error}`);
      return false;
    }
    log?.warn?.(`[chat-history] ${path.basename(source)} could not be read; kept it as ${target}`);
    if (store) reportStoreFile('set-aside', source, target, store);
    return true;
  }

  /**
   * @param {string} filePath
   */
  async function removeFile(filePath) {
    try {
      await unlinkWithRetry(fs, filePath, { platform });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function listStoreDir() {
    try {
      return await fs.readdir(storeDir());
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      log?.warn?.(`[chat-history] Could not list ${storeDir()}: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * A chat file's content in store form; `'newer'` for one from a newer release.
   *
   * @param {JsonObject} data
   * @returns {StoredSession|'newer'|null}
   */
  function sessionFromFile(data) {
    if (isNewer(data.version, STORE_VERSION)) return 'newer';
    return normalizeSession(data.session);
  }

  /**
   * @param {StoredSession} session
   * @param {{ plainWhileKeyPending?: boolean }} [options]
   */
  async function writeSessionFile(session, options) {
    return writeEnvelope(sessionPath(session.id), { version: STORE_VERSION, session }, options);
  }

  // ── The index ─────────────────────────────────────────────────────────────

  /**
   * @param {HistoryState} s
   */
  function indexData(s) {
    /** @type {{ version: number, activeByWorkspace: Record<string, string>, sessions: IndexedMeta[], legacyImport?: string }} */
    const data = {
      version: STORE_VERSION,
      activeByWorkspace: { ...s.activeByWorkspace },
      sessions: sortedMetas(s),
    };
    if (s.legacyImport) data.legacyImport = s.legacyImport;
    return data;
  }

  /**
   * @param {HistoryState} next
   * @param {JsonObject} data
   */
  function applyIndex(next, data) {
    if (!Array.isArray(data.sessions)) return false;
    for (const raw of data.sessions) {
      /** @type {IndexedMeta|null} */
      const meta = normalizeSessionMetaForStore(raw, { normalizeWorkspaceRoot });
      if (!meta) continue;
      if (raw.plain === true) meta.plain = true;
      next.metas.set(meta.id, meta);
    }
    if (isJsonObject(data.activeByWorkspace)) {
      for (const [key, value] of Object.entries(data.activeByWorkspace)) {
        if (key && typeof value === 'string' && value) next.activeByWorkspace[key] = value;
      }
    }
    if (typeof data.legacyImport === 'string') next.legacyImport = data.legacyImport;
    return true;
  }

  /**
   * Writes the index behind the state in memory; resolves once a write that carries this change is on the disk.
   *
   * @param {HistoryState} s
   * @returns {Promise<void>}
   */
  function persistIndex(s) {
    indexState = s;
    indexDirty = true;
    /** @type {Promise<void>} */
    const done = new Promise((resolve, reject) => indexWaiters.push({ resolve, reject }));
    if (!indexWrite) indexWrite = runIndexWrites();
    return done;
  }

  async function runIndexWrites() {
    try {
      while (indexDirty) {
        indexDirty = false;
        const waiters = indexWaiters;
        indexWaiters = [];
        const s = indexState;
        if (!s) {
          for (const waiter of waiters) waiter.reject(new Error('The index has no state to write.'));
          break;
        }
        try {
          s.plainIndex = !(await writeEnvelope(indexPath(), indexData(s)));
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      // In the same turn as the last check: a change made after it starts a new writer.
      indexWrite = null;
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  function loaded() {
    if (state && !state.failed) return Promise.resolve(state);
    if (!loading) {
      loading = load()
        .catch((error) => {
          log?.warn?.(`[chat-history] The history could not be loaded, nothing is written to it: ${error?.message || error}`);
          return failedState();
        })
        .then((next) => {
          state = next;
          loading = null;
          if (!next.failed) scheduleEncryption(next);
          return next;
        });
    }
    return loading;
  }

  async function loadedForWrite() {
    const s = await loaded();
    if (s.failed) {
      log?.warn?.('[chat-history] The history file could not be read; this save is skipped rather than written over it.');
      throw unreadableError();
    }
    return s;
  }

  /**
   * @returns {Promise<HistoryState>}
   */
  async function load() {
    let next = emptyState();
    const index = await readEnvelope(indexPath());
    if (index.status === READ.FAILED || index.status === READ.UNAVAILABLE) return failedState();
    let indexBroken = false;
    let indexChanged = false;
    if (index.status === READ.OK && isNewer(index.data.version, STORE_VERSION)) {
      // Written by a newer release (#566): the folder goes aside as a whole,
      // for that release to find again.
      if (!(await setAside(storeDir(), SET_ASIDE.UNREADABLE, HISTORY_NOTICE_STORE))) return failedState();
    } else if (index.status === READ.OK) {
      indexBroken = !applyIndex(next, index.data);
      next.plainIndex = !index.encrypted;
    } else if (index.status !== READ.MISSING) {
      indexBroken = true;
    }

    let reconciled = await reconcile(next);
    if (!reconciled) {
      // Without a listing a lost index cannot be rebuilt, nor the folder judged.
      if (indexBroken) return failedState();
      reconciled = { changed: false, readable: 0, undecryptable: [] };
    }
    indexChanged = reconciled.changed;

    if (indexBroken) {
      // Nothing in the folder opens with this key: a key that changed, not a
      // file that broke. The folder goes aside as one, as the single file did.
      const keyChanged = reconciled.readable === 0
        && (reconciled.undecryptable.length > 0 || index.status === READ.UNDECRYPTABLE);
      if (keyChanged) {
        if (!(await setAside(storeDir(), SET_ASIDE.UNDECRYPTABLE, HISTORY_NOTICE_STORE))) return failedState();
        next = emptyState();
        reconciled.undecryptable = [];
      } else if (!(await setAside(indexPath(), SET_ASIDE.UNDECRYPTABLE, null))) {
        return failedState();
      }
      indexChanged = true;
    }
    for (const name of reconciled.undecryptable) {
      if (!(await setAside(path.join(storeDir(), name), SET_ASIDE.UNDECRYPTABLE, CHAT_SESSION_NOTICE_STORE))) blocked.add(name);
    }

    const legacy = await readEnvelope(legacyPath());
    let legacyTakenIn = false;
    switch (legacy.status) {
      case READ.MISSING:
        break;
      case READ.FAILED:
      case READ.UNAVAILABLE:
        // There, and maybe fine — but not readable now (#473, #658).
        return failedState();
      case READ.UNDECRYPTABLE:
      case READ.NOT_UNDERSTOOD:
        if (!(await setAside(legacyPath(), SET_ASIDE.UNDECRYPTABLE, HISTORY_NOTICE_STORE))) return failedState();
        break;
      default: {
        if (isNewer(legacy.data.version, LEGACY_VERSION)) {
          if (!(await setAside(legacyPath(), SET_ASIDE.UNREADABLE, HISTORY_NOTICE_STORE))) return failedState();
          break;
        }
        // Read as "no chats", such a file would be removed below.
        if (!isLegacyShape(legacy.data)) {
          if (!(await setAside(legacyPath(), SET_ASIDE.UNDECRYPTABLE, HISTORY_NOTICE_STORE))) return failedState();
          break;
        }
        const digest = digestOf(legacy.raw);
        if (digest !== next.legacyImport) {
          await takeInLegacy(next, legacy.data, { plain: !legacy.encrypted });
          next.legacyImport = digest;
          indexChanged = true;
        }
        legacyTakenIn = true;
      }
    }

    if (indexChanged) {
      const plainSources = !index.encrypted && !legacy.encrypted;
      try {
        next.plainIndex = !(await writeEnvelope(indexPath(), indexData(next), { plainWhileKeyPending: plainSources }));
      } catch (error) {
        // Without the index on the disk the single file is still the record;
        // removing it now could bring deleted chats back on the next start.
        if (legacyTakenIn) throw error;
        log?.warn?.(`[chat-history] Could not write the index, the next change tries again: ${error?.message || error}`);
      }
    }
    if (legacyTakenIn) {
      try {
        await removeFile(legacyPath());
      } catch (error) {
        log?.warn?.(`[chat-history] Could not remove ${LEGACY_FILENAME} after taking it in; the next start tries again: ${error?.message || error}`);
      }
    }
    return next;
  }

  /**
   * Checks the index against the folder: what it changed, how many chats it
   * could read, and the files that could not be decrypted or understood.
   * `null` when the folder cannot be listed.
   *
   * @param {HistoryState} next
   * @returns {Promise<{ changed: boolean, readable: number, undecryptable: string[] }|null>}
   */
  async function reconcile(next) {
    /** @type {{ changed: boolean, readable: number, undecryptable: string[] }} */
    const result = { changed: false, readable: 0, undecryptable: [] };
    const names = await listStoreDir();
    if (!names) return null;
    const unindexed = new Set(names.filter((name) => SESSION_FILE_RE.test(name)));
    for (const id of [...next.metas.keys()]) {
      const name = sessionFileName(id);
      if (unindexed.delete(name)) {
        result.readable += 1;
        continue;
      }
      // Removed by hand, or a delete whose index write never landed.
      next.metas.delete(id);
      result.changed = true;
    }
    for (const name of unindexed) {
      const read = await readEnvelope(path.join(storeDir(), name));
      if (read.status === READ.MISSING) continue;
      if (read.status === READ.FAILED || read.status === READ.UNAVAILABLE) {
        // Its id is not known until it is read; keep its name off-limits.
        blocked.add(name);
        continue;
      }
      if (read.status === READ.UNDECRYPTABLE) {
        result.undecryptable.push(name);
        continue;
      }
      const session = read.status === READ.OK ? sessionFromFile(read.data) : null;
      if (session === 'newer') {
        if (!(await setAside(path.join(storeDir(), name), SET_ASIDE.UNREADABLE, CHAT_SESSION_NOTICE_STORE))) blocked.add(name);
        result.readable += 1;
        continue;
      }
      if (!session || sessionFileName(session.id) !== name) {
        result.undecryptable.push(name);
        continue;
      }
      /** @type {IndexedMeta} */
      const meta = sessionMetaFromSession(session);
      if (!read.encrypted) meta.plain = true;
      next.metas.set(session.id, meta);
      blocked.delete(name);
      result.readable += 1;
      result.changed = true;
    }
    return result;
  }

  /**
   * Takes the chats of the single file of releases before #985 into the
   * folder: written, read back, compared. A chat the folder already has is
   * only replaced by a newer one. Throws when anything does not hold, and the
   * file then stays where it is.
   *
   * @param {HistoryState} next
   * @param {JsonObject} data
   * @param {{ plain: boolean }} options
   */
  async function takeInLegacy(next, data, { plain }) {
    /** @type {Map<string, StoredSession>} */
    const incoming = new Map();
    for (const row of Array.isArray(data.sessions) ? data.sessions : []) {
      const session = normalizeSession(row);
      if (!session) continue;
      const seen = incoming.get(session.id) || next.metas.get(session.id);
      if (seen && !(session.updatedAt > seen.updatedAt)) continue;
      incoming.set(session.id, session);
    }
    const sessions = [...incoming.values()];
    // A chat file that is there but could not be read is not written over
    // (#473), and the single file must then stay as its only copy.
    if (sessions.some((session) => blocked.has(sessionFileName(session.id)))) {
      throw new Error(`a chat in ${LEGACY_FILENAME} has a file that cannot be read now`);
    }
    /** @type {Map<string, boolean>} */
    const encrypted = new Map();
    await inBatches(sessions, MIGRATION_BATCH, async (session) => {
      encrypted.set(session.id, await writeSessionFile(session, { plainWhileKeyPending: plain }));
    });
    await inBatches(sessions, MIGRATION_BATCH, async (session) => {
      const read = await readEnvelope(sessionPath(session.id));
      const back = read.status === READ.OK ? sessionFromFile(read.data) : null;
      if (!back || back === 'newer' || back.id !== session.id || back.messages.length !== session.messages.length) {
        throw new Error(`chat ${session.id} did not read back as it was written`);
      }
    });
    for (const session of sessions) {
      /** @type {IndexedMeta} */
      const meta = sessionMetaFromSession(session);
      if (!encrypted.get(session.id)) meta.plain = true;
      next.metas.set(session.id, meta);
      cache.delete(session.id);
    }
    // The single file's pointers are the newer word: it is either the whole
    // history, or one an older release wrote after this one.
    if (isJsonObject(data.activeByWorkspace)) {
      for (const [key, value] of Object.entries(data.activeByWorkspace)) {
        if (key && typeof value === 'string' && value) next.activeByWorkspace[key] = value;
      }
    } else if (typeof data.activeChatId === 'string' && data.activeChatId) {
      next.activeByWorkspace[noWorkspaceKey] = data.activeChatId;
    }
    if (sessions.length > 0) log?.info?.(`[chat-history] Took ${sessions.length} chat(s) from ${LEGACY_FILENAME} into ${STORE_DIRNAME}/.`);
  }

  /**
   * Plain files get encrypted once encrypted storage is there and its key is
   * on the disk (#1060) — in the background, one chat at a time between the
   * other changes, never holding up the load.
   *
   * @param {HistoryState} s
   */
  function scheduleEncryption(s) {
    if (!secretStore.isEncryptionAvailable()) return;
    const plainIds = [...s.metas.values()].filter((meta) => meta.plain).map((meta) => meta.id);
    if (plainIds.length === 0 && !s.plainIndex) return;
    const run = safeStorageKey.whenDurable().then(async () => {
      for (const id of plainIds) await serial(() => encryptPlainSession(s, id)).catch(() => {});
      if (state === s) await persistIndex(s).catch(() => {});
    });
    const tracked = run.finally(() => {
      if (encryption === tracked) encryption = null;
    });
    encryption = tracked;
  }

  /**
   * @param {HistoryState} s
   * @param {string} id
   */
  async function encryptPlainSession(s, id) {
    if (state !== s || !s.metas.get(id)?.plain) return;
    const read = await readEnvelope(sessionPath(id));
    const session = read.status === READ.OK && !read.encrypted ? sessionFromFile(read.data) : null;
    if (!session || session === 'newer' || !s.metas.get(id)?.plain) return;
    if (!(await writeSessionFile(session))) return;
    const current = s.metas.get(id);
    if (!current) return;
    const { plain: _plain, ...meta } = current;
    s.metas.set(id, meta);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** Newest first, every folder; without messages. */
  async function listSessions() {
    const s = await loaded();
    return sortedMetas(s).map(publicMeta);
  }

  /**
   * @param {string} id
   * @returns {Promise<SessionMeta|null>}
   */
  async function getSessionMeta(id) {
    if (typeof id !== 'string') return null;
    const s = await loaded();
    const meta = s.metas.get(id);
    return meta ? publicMeta(meta) : null;
  }

  /**
   * @param {string} bucketKey
   */
  async function getActiveChatId(bucketKey) {
    const s = await loaded();
    return s.activeByWorkspace[bucketKey] || null;
  }

  /**
   * The whole chat in store form, or `null`: not in the history, or its file
   * cannot be read (it is then moved aside, or left alone and kept from being
   * written over).
   *
   * @param {string} id
   * @returns {Promise<StoredSession|null>}
   */
  async function getSession(id) {
    if (typeof id !== 'string') return null;
    const s = await loaded();
    if (!s.metas.has(id)) return null;
    const file = await sessionFile(s, id);
    const meta = s.metas.get(id);
    return file && meta ? sessionFromMeta(meta, file.messages) : null;
  }

  /**
   * @param {HistoryState} s
   * @param {string} id
   * @returns {Promise<StoredSession|null>}
   */
  async function sessionFile(s, id) {
    const hit = cache.get(id);
    if (hit) {
      remember(id, hit);
      return hit;
    }
    const revision = revisions.get(id) || 0;
    const name = sessionFileName(id);
    const read = await readEnvelope(sessionPath(id));
    // Saved or deleted while it was read: what is there now counts.
    if ((revisions.get(id) || 0) !== revision) return s.metas.has(id) ? sessionFile(s, id) : null;
    if (read.status === READ.FAILED || read.status === READ.UNAVAILABLE) {
      blocked.add(name);
      return null;
    }
    if (read.status === READ.MISSING) {
      await serial(async () => {
        if ((revisions.get(id) || 0) !== revision || state !== s || !s.metas.has(id)) return;
        log?.warn?.(`[chat-history] The file of chat ${id} is gone; it is dropped from the history.`);
        forget(s, id);
        await persistIndex(s);
      }).catch(() => {});
      return null;
    }
    const session = read.status === READ.OK ? sessionFromFile(read.data) : null;
    if (session && session !== 'newer' && session.id === id) {
      blocked.delete(name);
      remember(id, session);
      return session;
    }
    const suffix = session === 'newer' ? SET_ASIDE.UNREADABLE : SET_ASIDE.UNDECRYPTABLE;
    await serial(async () => {
      if ((revisions.get(id) || 0) !== revision || state !== s || !s.metas.has(id)) return;
      if (!(await setAside(sessionPath(id), suffix, CHAT_SESSION_NOTICE_STORE))) {
        blocked.add(name);
        return;
      }
      forget(s, id);
      await persistIndex(s);
    }).catch(() => {});
    return null;
  }

  // ── Changing ──────────────────────────────────────────────────────────────

  /**
   * Saves a chat in store form: its file — unless it is what is there
   * already — and its index entry. The chats of its folder beyond
   * `maxChatSessionsPerFolder` go, oldest first (#1320); their ids come back
   * so that their images can go as well.
   *
   * @param {StoredSession} session
   * @returns {Promise<{ droppedIds: string[] }>}
   */
  function saveSession(session) {
    return serial(async () => {
      const s = await loadedForWrite();
      const id = session.id;
      if (blocked.has(sessionFileName(id))) throw unreadableError();
      const previous = cache.get(id);
      let plain = s.metas.get(id)?.plain === true;
      if (!previous || !s.metas.has(id) || JSON.stringify(previous) !== JSON.stringify(session)) {
        bump(id);
        plain = !(await writeSessionFile(session));
      }
      remember(id, session);
      /** @type {IndexedMeta} */
      const meta = sessionMetaFromSession(session);
      if (plain) meta.plain = true;
      s.metas.set(id, meta);
      const droppedIds = await dropBeyondLimit(s, meta.workspaceRoot);
      return { droppedIds, written: persistIndex(s) };
    }).then(async ({ droppedIds, written }) => {
      // Outside the queue: the next change goes into memory while this one's
      // index write is on its way, and both share the following write.
      await written;
      return { droppedIds };
    });
  }

  /**
   * The limit holds per folder (#1320): what happens in other folders never
   * pushes this folder's chats out, and chats without a folder are a bucket
   * of their own. A chat marked *Keep* is never dropped and does not count.
   * Only the saved chat's folder is looked at — the others did not grow.
   *
   * @param {HistoryState} s
   * @param {string|null} workspaceRoot
   * @returns {Promise<string[]>}
   */
  async function dropBeyondLimit(s, workspaceRoot) {
    const bucket = workspaceRoot || noWorkspaceKey;
    const counted = sortedMetas(s).filter((meta) => meta.keep !== true && (meta.workspaceRoot || noWorkspaceKey) === bucket);
    if (counted.length <= maxChatSessionsPerFolder) return [];
    const dropped = counted.slice(maxChatSessionsPerFolder).map((meta) => meta.id);
    for (const id of dropped) {
      try {
        await removeFile(sessionPath(id));
      } catch (error) {
        // Taken in again by the next load, and dropped again by the next save.
        log?.warn?.(`[chat-history] Could not remove the file of chat ${id}: ${error?.message || error}`);
      }
      forget(s, id);
    }
    return dropped;
  }

  /**
   * Changes a chat's own settings — in the index alone, unless `withFile`
   * asks for the chat's file to follow (#1320): a change that must survive
   * the loss of the index — *Keep*, the folder it was moved to — is written
   * to both, the file first. A file that cannot be read now is left as it is;
   * the change then lives in the index, as every other setting does. False
   * when the chat is not there.
   *
   * @param {string} id
   * @param {Record<string, unknown>} patch
   * @param {{ withFile?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  function patchSession(id, patch, { withFile = false } = {}) {
    return serial(async () => {
      const s = await loaded();
      const meta = s.metas.get(id);
      if (!meta || s.failed) return null;
      /** @type {Record<string, unknown>} */
      const changed = { ...meta };
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) delete changed[key];
        else changed[key] = value;
      }
      /** @type {IndexedMeta|null} */
      const next = normalizeSessionMetaForStore(changed, { normalizeWorkspaceRoot });
      if (!next) return null;
      if (meta.plain) next.plain = true;
      if (withFile) await rewriteSessionFile(id, next);
      s.metas.set(id, next);
      return { written: persistIndex(s) };
    }).then(async (result) => {
      if (!result) return false;
      await result.written;
      return true;
    });
  }

  /**
   * Writes a chat's file again with what its index entry says now, the
   * messages as they are. Runs inside the queue, so it reads the file itself
   * rather than through `sessionFile`, whose clean-up queues behind it.
   *
   * @param {string} id
   * @param {IndexedMeta} meta  the entry as it is about to be; `plain` follows the write
   */
  async function rewriteSessionFile(id, meta) {
    if (blocked.has(sessionFileName(id))) return;
    let file = cache.get(id);
    if (!file) {
      const read = await readEnvelope(sessionPath(id));
      const session = read.status === READ.OK ? sessionFromFile(read.data) : null;
      if (!session || session === 'newer' || session.id !== id) return;
      file = session;
    }
    const session = sessionFromMeta(meta, file.messages);
    bump(id);
    const plain = !(await writeSessionFile(session));
    remember(id, session);
    if (plain) meta.plain = true;
    else delete meta.plain;
  }

  /**
   * The file goes first: a chat whose file stays must stay in the list, and a delete that fails says so (#582).
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  function deleteSession(id) {
    return serial(async () => {
      const s = await loadedForWrite();
      const known = s.metas.has(id) || Object.values(s.activeByWorkspace).includes(id);
      bump(id);
      await removeFile(sessionPath(id));
      blocked.delete(sessionFileName(id));
      forget(s, id);
      return { written: known ? persistIndex(s) : null };
    }).then(async ({ written }) => {
      await written;
    });
  }

  /**
   * Which chat a folder opens with. A pointer that stays as it was is not
   * written: on a fresh Windows profile every encrypted write waits for the
   * key (#1060), and a new chat — which clears a pointer that is not there —
   * would wait with it before its mode is applied (#564).
   *
   * @param {string} bucketKey
   * @param {string|null} id
   * @returns {Promise<boolean>}
   */
  function setActiveChatId(bucketKey, id) {
    return serial(async () => {
      const s = await loaded();
      const wanted = typeof id === 'string' && id ? id : undefined;
      if (s.activeByWorkspace[bucketKey] === wanted) return null;
      if (s.failed) throw unreadableError();
      if (wanted) s.activeByWorkspace[bucketKey] = wanted;
      else delete s.activeByWorkspace[bucketKey];
      return { written: persistIndex(s) };
    }).then(async (result) => {
      if (!result) return false;
      await result.written;
      return true;
    });
  }

  /**
   * Is a history moved aside still lying next to the live one (#565)? Its
   * chats are not in the store, but their images may still be wanted — the
   * copy is kept so that it can be recovered, images included. An index moved
   * aside does not count: its chats are all still there.
   */
  async function hasSetAsideChatHistory() {
    const prefixes = Object.values(SET_ASIDE).flatMap((suffix) => [
      `${LEGACY_FILENAME}.${suffix}-`,
      `${STORE_DIRNAME}.${suffix}-`,
    ]);
    let names;
    try {
      names = await fs.readdir(userDataPath());
    } catch {
      // Not listable: assume there is one, so nothing is swept on a guess.
      return true;
    }
    if (names.some((name) => prefixes.some((prefix) => name.startsWith(prefix)))) return true;
    try {
      return (await fs.readdir(storeDir())).some((name) => SET_ASIDE_SESSION_RE.test(name));
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }

  /** What the quit waits for (#679): the load, queued changes, the index write, plain files being encrypted. */
  function pendingWork() {
    return [loading, queue, indexWrite, encryption].filter((work) => work !== null);
  }

  return {
    listSessions,
    getSessionMeta,
    getSession,
    getActiveChatId,
    saveSession,
    patchSession,
    deleteSession,
    setActiveChatId,
    hasSetAsideChatHistory,
    pendingWork,
    storeDir,
  };
}

module.exports = {
  createChatHistoryStore,
  CHAT_HISTORY_DIRNAME: STORE_DIRNAME,
  CHAT_HISTORY_LEGACY_FILENAME: LEGACY_FILENAME,
  CHAT_HISTORY_UNREADABLE,
  chatSessionFileName: sessionFileName,
};
