'use strict';

/**
 * The release list of the remote front ends (#1194; docs/remote/remote-interface.md
 * §7.5): which workspaces the paired phone may see, and the id each known
 * folder goes by there.
 *
 * One file in the user data folder, `remote-release.json`, holds a single
 * `safeStorage` ciphertext, as the pairing's does: a process that can write
 * the folder still cannot open a workspace to the phone without the key.
 * Without real encryption (#1012) nothing is kept and nothing is open.
 *
 * Opening a workspace is a loosening and takes a receipt of the
 * user-confirmation port (#980) for the action `remote-workspace` and that
 * root; closing one takes none. A folder keeps its id when it is closed and
 * opened again, so that a phone that knew it finds it under the same id.
 */

const nodeCrypto = require('node:crypto');
const { CONFIRMATION_ACTIONS } = require('../../application/permissions/user-confirmation');
const { isRecord } = require('../../shared/runtime/is-record');

/** @typedef {import('../../application/ports/remote-release-port').RemoteRelease} RemoteRelease */

const FILE_NAME = 'remote-release.json';
const FILE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** More folders than anyone opens; a file that claims more is not this one's. */
const MAX_FOLDERS = 1000;

/**
 * @typedef {{ ids: Map<string, string>, released: string[] }} StoredReleases
 *   `ids` root → workspaceId for every folder ever opened; `released` the roots open now
 */

const KEY_ALWAYS_DURABLE = Object.freeze({ whenDurable: () => Promise.resolve() });

const empty = () => /** @type {StoredReleases} */ ({ ids: new Map(), released: [] });

/**
 * @param {unknown} raw
 * @param {(root: unknown) => string|null} normalizeRoot
 * @returns {StoredReleases}
 */
function parse(raw, normalizeRoot) {
  if (!isRecord(raw) || !isRecord(raw.ids) || !Array.isArray(raw.released)) throw new TypeError('format');
  const out = empty();
  for (const [root, id] of Object.entries(raw.ids).slice(0, MAX_FOLDERS)) {
    const normal = normalizeRoot(root);
    if (normal && typeof id === 'string' && ID_PATTERN.test(id)) out.ids.set(normal, id);
  }
  for (const root of raw.released.slice(0, MAX_FOLDERS)) {
    const normal = normalizeRoot(root);
    if (normal && out.ids.has(normal) && !out.released.includes(normal)) out.released.push(normal);
  }
  return out;
}

/**
 * @param {{
 *   safeStorage: { isEncryptionAvailable: () => boolean, encryptString: (text: string) => Buffer,
 *     decryptString: (data: Buffer) => string } | null,
 *   safeStorageKey?: { whenDurable: () => Promise<unknown> },
 *   receipts?: { redeem: (receipt: unknown, action: string, subject?: string) => boolean },
 *   normalizeRoot: (root: unknown) => string|null,
 *   fs: typeof import('fs/promises'),
 *   path: typeof import('path'),
 *   dir: string,
 *   writeFileAtomic: (fs: any, file: string, data: string, options?: { mode?: number }) => Promise<void>,
 *   newId?: () => string,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `normalizeRoot` the chat history's, so that a release and a chat name a folder alike;
 *   without `receipts` nothing is ever opened
 * @returns {import('../../application/ports/remote-release-port').RemoteReleasePort}
 */
function createRemoteReleaseStore({
  safeStorage,
  safeStorageKey = KEY_ALWAYS_DURABLE,
  receipts = { redeem: () => false },
  normalizeRoot,
  fs,
  path,
  dir,
  writeFileAtomic,
  newId = () => nodeCrypto.randomBytes(16).toString('base64url'),
  log = console,
}) {
  const file = path.join(dir, FILE_NAME);
  /** @type {StoredReleases | null} */
  let cache = null;
  /** @type {Promise<StoredReleases> | null} */
  let reading = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {Set<() => void>} */
  const listeners = new Set();

  function isAvailable() {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable() === true;
    } catch {
      // A store that cannot say whether it encrypts does not.
      return false;
    }
  }

  async function load() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn(`[remote] ${FILE_NAME} could not be read (${error?.code || 'error'}); no workspace is open to the phone.`);
      return empty();
    }
    try {
      const outer = JSON.parse(text);
      if (outer?.version !== FILE_VERSION || typeof outer.data !== 'string') throw new TypeError('format');
      if (!safeStorage || !isAvailable()) throw new TypeError('encryption unavailable');
      return parse(JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64'))), normalizeRoot);
    } catch (error) {
      log.warn(`[remote] ${FILE_NAME} could not be opened (${error?.name || 'error'}); no workspace is open to the phone.`);
      return empty();
    }
  }

  async function read() {
    if (cache) return cache;
    reading ??= load().then((data) => {
      cache = data;
      return data;
    });
    return reading;
  }

  /** @param {StoredReleases} next */
  async function write(next) {
    if (!safeStorage || !isAvailable()) throw new Error('remote release: encryption is not available');
    // Ciphertext reaches the disk only once its key does (#1060).
    await safeStorageKey.whenDurable();
    const plain = JSON.stringify({ ids: Object.fromEntries(next.ids), released: next.released });
    const data = safeStorage.encryptString(plain).toString('base64');
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(fs, file, `${JSON.stringify({ version: FILE_VERSION, data })}\n`, { mode: 0o600 });
    cache = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.warn(`[remote] a listener of the release list failed (${error?.name || 'error'})`);
      }
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serially(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {
      // The caller gets the failure through `run`; the queue only keeps the order.
    });
    return run;
  }

  return {
    isAvailable,
    async list() {
      if (!isAvailable()) return [];
      const data = await read();
      return data.released.map((root) => ({ workspaceId: /** @type {string} */ (data.ids.get(root)), root }));
    },
    release: (rawRoot, confirmation) => serially(async () => {
      const root = normalizeRoot(rawRoot);
      if (!root) return { ok: false, reason: 'invalid' };
      if (!isAvailable()) return { ok: false, reason: 'unavailable' };
      // The receipt is spent whether or not the folder was open already.
      if (receipts.redeem(confirmation, CONFIRMATION_ACTIONS.REMOTE_WORKSPACE, root) !== true) return { ok: false, reason: 'unconfirmed' };
      const data = await read();
      const ids = new Map(data.ids);
      let workspaceId = ids.get(root);
      if (!workspaceId) {
        const taken = new Set(ids.values());
        do workspaceId = newId(); while (taken.has(workspaceId));
        ids.set(root, workspaceId);
      }
      if (!data.released.includes(root) || ids.size !== data.ids.size) {
        await write({ ids, released: data.released.includes(root) ? data.released : [...data.released, root] });
      }
      return { ok: true, release: { workspaceId, root } };
    }),
    withdraw: (rawRoot) => serially(async () => {
      const root = normalizeRoot(rawRoot);
      if (!root || !isAvailable()) return;
      const data = await read();
      if (!data.released.includes(root)) return;
      await write({ ids: data.ids, released: data.released.filter((r) => r !== root) });
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createRemoteReleaseStore, FILE_NAME };
