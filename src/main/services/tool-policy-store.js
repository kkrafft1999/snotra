'use strict';

/**
 * Geschützter Policy-Speicher für Tool-Berechtigungen (Issue #66, Konzept §7).
 *
 * Modus, globale und Workspace-Regeln sowie sensible Pfadmuster liegen in
 * einer eigenen Datei `tool-policy.json` im userData-Ordner, getrennt von den
 * Klartext-UI-Einstellungen. Die Regeln sind nicht geheim, ihre Unversehrtheit
 * ist entscheidend: Die Datei trägt eine HMAC-SHA256-Signatur mit einem
 * Schlüssel, der über `safeStorage` verschlüsselt in `tool-policy.key` liegt.
 *
 * Fail-safe bei fehlender oder falscher Signatur: Modus `smart`, alle
 * Allow-Regeln verworfen, lesbare Deny-Regeln und Pfadmuster bleiben wirksam,
 * and a mode of `ask-all` stays as well (#419) — it only tightens, like a
 * deny rule, and without it a system without `safeStorage` could never leave
 * `smart`,
 * `integrity` meldet den Zustand an die Oberfläche. Ohne verfügbare
 * `safeStorage` sind Auto und dauerhafte Allow-Regeln nicht speicherbar.
 *
 * The per-workspace sandbox opt-out (#357) lives here too, as a list of
 * canonical workspace roots. It loosens protection like an allow rule does,
 * so it follows the same rules: it needs `safeStorage` to be stored, and a
 * failed signature drops it — every workspace is isolated again.
 *
 * Program allowances (#408) widen the sandbox for one program — the same
 * kind of loosening, so the same rules again. Since #1119 an allowance applies
 * in one workspace (`workspaceProgramAllowances`) or in every workspace
 * (`programAllowances`, the list every allowance was in before: a file
 * written before #1119 needs no rewrite, its allowances simply stay global).
 * Hosts can be kept open per workspace (#946) or in every workspace
 * (`globalHosts`), and new workspaces can start with the sandbox off
 * (`newWorkspaceSandboxOff`) — every one of them a loosening as well.
 *
 * The default mode per workspace (#413) is a map of canonical root → mode.
 * `smart` is the absence of an entry. `auto` loosens and follows the rules
 * above; `ask-all` tightens, so like a deny rule it survives a failed
 * signature.
 *
 * Every loosening needs a receipt from the user-confirmation port (#980):
 * the store refuses it otherwise, whoever calls. Taking something away needs
 * none. Which chats were confirmed into "Auto" is kept here as well, signed,
 * so that a chat coming back on screen gets "Auto" only when it had it
 * confirmed — not because its history file says so.
 */

const {
  TOOL_PERMISSION_MODES,
  DEFAULT_TOOL_PERMISSION_MODE,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  TOOL_POLICY_INTEGRITY,
  normalizeToolPermissionMode,
  normalizePermissionRule,
  normalizePermissionRules,
  normalizeSensitivePathPatterns,
  isCommandRule,
} = require('../../shared/contracts/tool-permissions');
const { createMessage } = require('../../shared/contracts/message');
const {
  CONFIRMATION_ACTIONS,
  NO_RECEIPTS,
  permissionRuleSubject,
  removedPatternsSubject,
  programAllowanceSubject,
  globalHostsSubject,
} = require('../../application/permissions/user-confirmation');
const {
  normalizeProgramAllowance,
  normalizeProgramAllowances,
  isNarrowing,
  PROGRAM_ALLOWANCE_LIMITS,
  combineProgramAllowances,
  combinationTooLarge,
} = require('../../shared/contracts/program-allowances');

const { readFileWithRetry } = require('./rename-with-retry');
const { writeFileAtomic } = require('./atomic-write');
const { grantedHosts } = require('./sandbox-violations');
const { KEY_ALWAYS_DURABLE } = require('./safe-storage-key-durability');

const POLICY_FILENAME = 'tool-policy.json';
const POLICY_KEY_FILENAME = 'tool-policy.key';
const POLICY_FILE_VERSION = 1;
const HMAC_KEY_BYTES = 32;
/** Hosts one workspace may keep open for its runs (#946). */
const MAX_WORKSPACE_HOSTS = 10;
/** Hosts kept open in every workspace (#1119). */
const MAX_GLOBAL_HOSTS = 10;
/**
 * Folders remembered as already there while new workspaces start without the
 * sandbox (#1119), the most recent last.
 */
const MAX_KNOWN_WORKSPACES = 1000;
/** Chats remembered as confirmed into "Auto" (#980) — as many as chat settings keep. */
const MAX_AUTO_CHATS = 500;

const INTEGRITY = TOOL_POLICY_INTEGRITY;

/**
 * What `keyToVerify` returns for a key that is not made yet (#1060): it matches
 * no signature, as a key made at that moment would not.
 */
const KEY_NOT_MADE_YET = Symbol('key not made yet');

/** Thrown by `loadKey` when the key file exists but cannot be read (#512). */
class PolicyKeyUnreadableError extends Error {
  constructor(cause) {
    super(`The key of the permission rules could not be read: ${cause?.message || cause}`);
    this.code = 'POLICY_KEY_UNREADABLE';
  }
}

function defaultPayload() {
  return {
    revision: 0,
    mode: DEFAULT_TOOL_PERMISSION_MODE,
    globalRules: [],
    workspaceRules: {},
    sensitivePathPatterns: [],
    unsandboxedWorkspaces: [],
    // Program allowances for every workspace (#408) — and, since #1119, per
    // workspace: root → entries.
    programAllowances: [],
    workspaceProgramAllowances: {},
    workspaceModes: {},
    workspaceHosts: {},
    globalHosts: [],
    // New workspaces start with the sandbox off (#1119); `knownWorkspaces` are
    // the folders that were there before, which keep their setting.
    newWorkspaceSandboxOff: false,
    knownWorkspaces: [],
    autoChats: [],
    legacyWriteMigrated: false,
    updatedAt: 0,
  };
}

function chatKey(chatId) {
  return typeof chatId === 'string' && chatId && chatId.length <= 200 ? chatId : null;
}

/** Chat ids, each once, the most recent last (#980). */
function normalizeAutoChats(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const id = chatKey(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(-MAX_AUTO_CHATS);
}

function withAutoChat(list, chatId) {
  return [...list.filter((id) => id !== chatId), chatId].slice(-MAX_AUTO_CHATS);
}

/**
 * Root → the hosts a connection card opened for that workspace (#946), in
 * the form the card offered them: `host:port` or `*.domain`. Anything a card
 * could not have offered is dropped, and so is a root without hosts.
 */
function normalizeWorkspaceHosts(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root) continue;
    const hosts = grantedHosts(raw).slice(0, MAX_WORKSPACE_HOSTS);
    if (hosts.length > 0) out[root] = hosts;
  }
  return out;
}

/** Root → the program allowances of that workspace (#1119); a root without any is dropped. */
function normalizeWorkspaceProgramAllowances(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root) continue;
    const entries = normalizeProgramAllowances(raw);
    if (entries.length > 0) out[root] = entries;
  }
  return out;
}

/** Root → `ask-all` | `auto`; `smart` and unknown values are no entry (#413). */
function normalizeWorkspaceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root || typeof raw !== 'string') continue;
    const mode = normalizeToolPermissionMode(raw);
    if (mode !== raw || mode === DEFAULT_TOOL_PERMISSION_MODE) continue;
    out[root] = mode;
  }
  return out;
}

/** Canonical roots only, each once; anything else is not a workspace (#357). */
function normalizeWorkspaceRoots(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

function sameCommandRule(a, b) {
  return (
    isCommandRule(a) &&
    isCommandRule(b) &&
    a.root === b.root &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.networkDomains.join('\n') === b.networkDomains.join('\n')
  );
}

function createToolPolicyStore({
  app,
  safeStorage,
  /** When ciphertext may reach the disk (#1060); without it, at once. */
  safeStorageKey = KEY_ALWAYS_DURABLE,
  fs,
  path,
  crypto,
  uiPrefsPath = null,
  log = console,
  now = () => Date.now(),
  /** Redeems the receipts of the user-confirmation port (#980); without it, no loosening. */
  confirmationReceipts = NO_RECEIPTS,
}) {
  let keyPromise = null;
  let writeChain = Promise.resolve();

  function policyPath() {
    return path.join(app.getPath('userData'), POLICY_FILENAME);
  }

  function keyPath() {
    return path.join(app.getPath('userData'), POLICY_KEY_FILENAME);
  }

  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  /**
   * Lädt (oder erzeugt) den HMAC-Schlüssel; null ohne safeStorage.
   *
   * Only a key that was read and turns out unusable counts as lost and is
   * replaced (concept §7). A key file that exists but cannot be read — a
   * Windows lock, a permission — throws instead (#512): replacing it would
   * void the signature for good and drop every loosening with it. A failure
   * is not cached, so the next call tries again.
   */
  async function loadKey() {
    if (!encryptionAvailable()) return null;
    if (!keyPromise) {
      const pending = readOrCreateKey();
      keyPromise = pending;
      pending.then(
        (key) => { if (!key && keyPromise === pending) keyPromise = null; },
        () => { if (keyPromise === pending) keyPromise = null; }
      );
    }
    return keyPromise;
  }

  async function readOrCreateKey() {
    const stored = await readStoredKey();
    if (stored) return stored;
    // The new key is stored encrypted. On a fresh Windows profile that waits
    // until the key behind safeStorage is on disk itself (#1060): a crash in
    // between would leave a key file nothing can decrypt, and every policy
    // signed with it would fail its check on the next start.
    await safeStorageKey.whenDurable();
    const key = crypto.randomBytes(HMAC_KEY_BYTES);
    try {
      const encrypted = safeStorage.encryptString(key.toString('hex')).toString('base64');
      await fs.mkdir(path.dirname(keyPath()), { recursive: true });
      // Temp + rename (#1013): a key cut off halfway would leave a policy
      // that can never be verified again.
      await writeFileAtomic(fs, keyPath(), encrypted, { mode: 0o600 });
    } catch (error) {
      log?.warn?.(`[tool-policy] Schlüssel konnte nicht gespeichert werden: ${error?.message || error}`);
      return null;
    }
    return key;
  }

  /**
   * The stored key; null when there is none or it does not decrypt. A key file
   * that is there but cannot be read throws (#512).
   */
  async function readStoredKey() {
    let raw;
    try {
      raw = await readFileWithRetry(fs, keyPath());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new PolicyKeyUnreadableError(error);
      return null;
    }
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(raw.trim(), 'base64'));
      const key = Buffer.from(decrypted, 'hex');
      if (key.length === HMAC_KEY_BYTES) return key;
    } catch {
      /* unusable: the caller makes a new one */
    }
    return null;
  }

  /**
   * The key a stored signature is checked with. Only a stored key can match
   * it; a new one never would. So while making one would have to wait for the
   * key behind safeStorage (#1060), the check does not: it fails as it would
   * with the new key, and the next change makes the key.
   */
  async function keyToVerify() {
    if (!encryptionAvailable() || !safeStorageKey.wouldWait()) return loadKey();
    return (await readStoredKey()) || KEY_NOT_MADE_YET;
  }

  function serializePayload(payload) {
    return JSON.stringify(payload);
  }

  function sign(key, serialized) {
    return crypto.createHmac('sha256', key).update(serialized).digest('hex');
  }

  function signaturesEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  function normalizePayload(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const out = defaultPayload();
    out.revision = Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
    out.mode = normalizeToolPermissionMode(data.mode);
    out.globalRules = normalizePermissionRules(data.globalRules).filter(
      (rule) => rule.scope === PERMISSION_RULE_SCOPES.GLOBAL
    );
    out.workspaceRules = {};
    if (data.workspaceRules && typeof data.workspaceRules === 'object') {
      for (const [root, rules] of Object.entries(data.workspaceRules)) {
        if (typeof root !== 'string' || !root) continue;
        const normalized = normalizePermissionRules(rules).filter(
          (rule) => rule.scope === PERMISSION_RULE_SCOPES.WORKSPACE && rule.root === root
        );
        if (normalized.length > 0) out.workspaceRules[root] = normalized;
      }
    }
    out.sensitivePathPatterns = normalizeSensitivePathPatterns(data.sensitivePathPatterns);
    out.unsandboxedWorkspaces = normalizeWorkspaceRoots(data.unsandboxedWorkspaces);
    out.programAllowances = normalizeProgramAllowances(data.programAllowances);
    out.workspaceProgramAllowances = normalizeWorkspaceProgramAllowances(data.workspaceProgramAllowances);
    out.workspaceModes = normalizeWorkspaceModes(data.workspaceModes);
    out.workspaceHosts = normalizeWorkspaceHosts(data.workspaceHosts);
    out.globalHosts = grantedHosts(data.globalHosts).slice(0, MAX_GLOBAL_HOSTS);
    out.newWorkspaceSandboxOff = data.newWorkspaceSandboxOff === true;
    out.knownWorkspaces = normalizeWorkspaceRoots(data.knownWorkspaces).slice(-MAX_KNOWN_WORKSPACES);
    out.autoChats = normalizeAutoChats(data.autoChats);
    out.legacyWriteMigrated = data.legacyWriteMigrated === true;
    out.updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
    return out;
  }

  /**
   * Fail-safe: only what tightens survives a failed check — blocks, patterns,
   * and "Always ask" as the mode (#419) or as a workspace default (#413).
   */
  function failSafe(payload) {
    const out = normalizePayload(payload);
    if (out.mode !== TOOL_PERMISSION_MODES.ASK_ALL) out.mode = DEFAULT_TOOL_PERMISSION_MODE;
    out.globalRules = out.globalRules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY);
    for (const root of Object.keys(out.workspaceRules)) {
      out.workspaceRules[root] = out.workspaceRules[root].filter(
        (rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY
      );
      if (out.workspaceRules[root].length === 0) delete out.workspaceRules[root];
    }
    // A switched-off sandbox is a loosening like an allow rule (#357), and so
    // is a program allowance (#408).
    out.unsandboxedWorkspaces = [];
    out.programAllowances = [];
    out.workspaceProgramAllowances = {};
    // So is a host kept open for a workspace (#946) or for every one, the
    // sandbox off for new workspaces (#1119), and a chat's confirmed "Auto"
    // (#980).
    out.workspaceHosts = {};
    out.globalHosts = [];
    out.newWorkspaceSandboxOff = false;
    out.knownWorkspaces = [];
    out.autoChats = [];
    // "Auto" as a workspace default goes with them; "Always ask" only tightens
    // and stays, like a deny rule (#413).
    for (const [root, mode] of Object.entries(out.workspaceModes)) {
      if (mode !== TOOL_PERMISSION_MODES.ASK_ALL) delete out.workspaceModes[root];
    }
    return out;
  }

  async function detectLegacyWrite() {
    if (!uiPrefsPath) return false;
    try {
      const raw = await fs.readFile(uiPrefsPath, 'utf8');
      const data = JSON.parse(raw);
      return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'allowWorkspaceWrite');
    } catch {
      return false;
    }
  }

  /**
   * Liest die Datei und prüft die Signatur. Liefert `{ payload, integrity }`;
   * bei `invalid`/`unsigned` ist payload bereits die Fail-safe-Fassung.
   */
  async function loadFromDisk() {
    let raw;
    try {
      raw = await readFileWithRetry(fs, policyPath());
    } catch (error) {
      if (error && error.code === 'ENOENT') return { payload: null, integrity: INTEGRITY.MISSING };
      // There but unreadable (#512): not the fail-safe of a broken file. The
      // payload grants nothing, and `update` refuses to write over it.
      log?.warn?.(`[tool-policy] Policy-Datei nicht lesbar: ${error?.message || error}`);
      return { payload: failSafe(null), integrity: INTEGRITY.UNREADABLE };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { payload: failSafe(null), integrity: INTEGRITY.INVALID };
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== POLICY_FILE_VERSION || !parsed.payload) {
      return { payload: failSafe(parsed?.payload), integrity: INTEGRITY.INVALID };
    }
    let key;
    try {
      key = await keyToVerify();
    } catch (error) {
      log?.warn?.(`[tool-policy] ${error?.message || error}`);
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.UNREADABLE };
    }
    if (!key) {
      // Ohne Schlüssel lässt sich nichts verifizieren: Fail-safe, aber Sperren
      // und Muster bleiben wirksam.
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.UNSIGNED };
    }
    if (typeof parsed.signature !== 'string' || !parsed.signature) {
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.UNSIGNED };
    }
    const expected = key === KEY_NOT_MADE_YET ? null : sign(key, serializePayload(parsed.payload));
    if (!signaturesEqual(expected, parsed.signature)) {
      log?.warn?.('[tool-policy] Signatur der Policy-Datei ungültig; Fail-safe aktiv.');
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.INVALID };
    }
    return { payload: normalizePayload(parsed.payload), integrity: INTEGRITY.OK };
  }

  async function writeToDisk(payload) {
    const target = policyPath();
    const key = await loadKey();
    const serialized = serializePayload(payload);
    const file = { version: POLICY_FILE_VERSION, payload, signature: key ? sign(key, serialized) : null };
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Reads of the same file run all the time (every state refresh), and on
    // Windows one of them can hold the target for a moment — the rename retries.
    await writeFileAtomic(fs, target, JSON.stringify(file), { mode: 0o600 });
  }

  function policyVersionOf(payload, integrity) {
    return `${payload.revision}:${integrity}`;
  }

  function allRules(payload) {
    const out = [...payload.globalRules];
    for (const rules of Object.values(payload.workspaceRules)) out.push(...rules);
    return out;
  }

  function snapshot(payload, integrity) {
    return {
      mode: payload.mode,
      rules: allRules(payload),
      globalRules: payload.globalRules,
      workspaceRules: payload.workspaceRules,
      sensitivePathPatterns: payload.sensitivePathPatterns,
      unsandboxedWorkspaces: payload.unsandboxedWorkspaces,
      programAllowances: payload.programAllowances,
      workspaceProgramAllowances: payload.workspaceProgramAllowances,
      workspaceModes: payload.workspaceModes,
      workspaceHosts: payload.workspaceHosts,
      globalHosts: payload.globalHosts,
      newWorkspaceSandboxOff: payload.newWorkspaceSandboxOff,
      policyVersion: policyVersionOf(payload, integrity),
      integrity,
      encryptionAvailable: encryptionAvailable(),
      legacyWriteMigrated: payload.legacyWriteMigrated,
      revision: payload.revision,
    };
  }

  /** Aktueller Stand; legt beim ersten Aufruf eine Standard-Policy an. */
  async function read() {
    const loaded = await loadFromDisk();
    if (loaded.integrity === INTEGRITY.MISSING) {
      const payload = defaultPayload();
      payload.legacyWriteMigrated = await detectLegacyWrite();
      payload.updatedAt = now();
      // The defaults need no file yet. While the key that signs it would wait
      // for the key behind safeStorage (#1060), a later read or the first
      // change makes the file, rather than every read in the meantime waiting.
      if (encryptionAvailable() && safeStorageKey.wouldWait()) return snapshot(payload, INTEGRITY.OK);
      try {
        await writeToDisk(payload);
      } catch (error) {
        log?.warn?.(`[tool-policy] Policy konnte nicht angelegt werden: ${error?.message || error}`);
      }
      const key = await loadKey().catch(() => null);
      return snapshot(payload, key ? INTEGRITY.OK : INTEGRITY.UNSIGNED);
    }
    return snapshot(loaded.payload, loaded.integrity);
  }

  /**
   * Serialisierte Änderung: liest den (fail-safe geprüften) Stand, wendet den
   * Updater an, erhöht die Revision und schreibt signiert zurück.
   */
  function update(updater) {
    const task = writeChain.then(async () => {
      const loaded = await loadFromDisk();
      // Nothing is written over a file that could not be read (#512): its
      // blocks would be gone for good, under a fresh signature.
      if (loaded.integrity === INTEGRITY.UNREADABLE) {
        return { ok: false, error: createMessage('permissions.error.policyUnreadable'), ...snapshot(loaded.payload, loaded.integrity) };
      }
      const base = loaded.integrity === INTEGRITY.MISSING ? defaultPayload() : loaded.payload;
      const draft = normalizePayload(JSON.parse(JSON.stringify(base)));
      const result = await updater(draft, { encryptionAvailable: encryptionAvailable(), integrity: loaded.integrity });
      if (result && result.error) return { ok: false, error: result.error, ...snapshot(base, loaded.integrity) };
      // Nothing to change after all: no new revision, nothing written.
      if (result && result.unchanged) return { ok: true, unchanged: true, ...snapshot(base, loaded.integrity) };
      const next = normalizePayload(draft);
      next.revision = base.revision + 1;
      next.updatedAt = now();
      await writeToDisk(next);
      const key = await loadKey().catch(() => null);
      return { ok: true, ...snapshot(next, key ? INTEGRITY.OK : INTEGRITY.UNSIGNED) };
    });
    writeChain = task.catch(() => {});
    return task;
  }

  /**
   * Whether a loosening was confirmed by a person at the machine (#980). The
   * receipt is spent either way.
   */
  function confirmedBy(confirmation, action, subject) {
    return confirmationReceipts.redeem(confirmation, action, subject) === true;
  }

  function notConfirmed() {
    return { error: createMessage('permissions.error.notConfirmed') };
  }

  /**
   * The mode the user picks for the chat on screen (#211). "Auto" needs a
   * receipt bound to that chat (#980), and the chat is remembered as
   * confirmed; any other mode forgets it again.
   */
  async function setMode(rawMode, { confirmation = null, chatId = null } = {}) {
    const mode = normalizeToolPermissionMode(rawMode);
    const chat = chatKey(chatId);
    return update((draft, { encryptionAvailable: enc }) => {
      if (mode === TOOL_PERMISSION_MODES.AUTO) {
        if (!enc) return { error: createMessage('permissions.error.autoNeedsEncryption') };
        if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.MODE_AUTO, chat || '')) return notConfirmed();
        if (chat) draft.autoChats = withAutoChat(draft.autoChats, chat);
      } else if (chat) {
        draft.autoChats = draft.autoChats.filter((id) => id !== chat);
      }
      draft.mode = mode;
      return null;
    });
  }

  /**
   * The mode of a chat coming on screen (#211), applied without a prompt.
   * "Auto" only where it was confirmed before, both signed in this file: for
   * this chat, or as the default of the workspace on screen (#413) — a chat
   * that got "Auto" from that default is remembered as confirmed.
   */
  async function restoreMode(rawMode, { chatId = null, workspaceRoot = null } = {}) {
    const mode = normalizeToolPermissionMode(rawMode);
    const chat = chatKey(chatId);
    return update((draft, { encryptionAvailable: enc }) => {
      if (mode === TOOL_PERMISSION_MODES.AUTO) {
        if (!enc) return { error: createMessage('permissions.error.autoNeedsEncryption') };
        const byChat = !!chat && draft.autoChats.includes(chat);
        const byWorkspace = typeof workspaceRoot === 'string' && !!workspaceRoot
          && draft.workspaceModes[workspaceRoot] === TOOL_PERMISSION_MODES.AUTO;
        if (!byChat && !byWorkspace) return notConfirmed();
        if (chat && !byChat) draft.autoChats = withAutoChat(draft.autoChats, chat);
      }
      draft.mode = mode;
      return null;
    });
  }

  /** Result carries `ruleId`: the new rule's, or that of the command rule it repeats (#121). */
  async function addRule(rawRule, { confirmation = null } = {}) {
    let ruleId = null;
    const result = await update((draft, { encryptionAvailable: enc }) => {
      const id = typeof rawRule?.id === 'string' && rawRule.id.trim() ? rawRule.id.trim() : crypto.randomUUID();
      const rule = normalizePermissionRule({ ...rawRule, id, createdAt: now() });
      if (!rule) return { error: createMessage('permissions.error.invalidRule') };
      if (rule.effect === PERMISSION_RULE_EFFECTS.ALLOW && !enc) {
        return { error: createMessage('permissions.error.allowNeedsEncryption') };
      }
      if (rule.effect === PERMISSION_RULE_EFFECTS.ALLOW
        && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.ALLOW_RULE, permissionRuleSubject(rule))) {
        return notConfirmed();
      }
      if (allRules(draft).some((existing) => existing.id === rule.id)) {
        return { error: createMessage('permissions.error.ruleIdTaken') };
      }
      // Two cards for the same command, both answered with "always", make one
      // rule, not two identical rows in the settings.
      const same = isCommandRule(rule)
        ? (draft.workspaceRules[rule.root] || []).find((existing) => sameCommandRule(existing, rule))
        : null;
      if (same) {
        ruleId = same.id;
        return null;
      }
      ruleId = rule.id;
      if (rule.scope === PERMISSION_RULE_SCOPES.GLOBAL) {
        draft.globalRules.push(rule);
      } else {
        draft.workspaceRules[rule.root] = [...(draft.workspaceRules[rule.root] || []), rule];
      }
      return null;
    });
    return result.ok ? { ...result, ruleId } : result;
  }

  /** Taking a block away needs a receipt for that rule (#980); an allow rule goes freely. */
  async function removeRule(ruleId, { confirmation = null } = {}) {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    return update((draft) => {
      if (!id) return { error: createMessage('permissions.error.ruleIdMissing') };
      const target = allRules(draft).find((rule) => rule.id === id);
      if (target?.effect === PERMISSION_RULE_EFFECTS.DENY
        && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.REMOVE_BLOCK, id)) {
        return notConfirmed();
      }
      let removed = false;
      const before = draft.globalRules.length;
      draft.globalRules = draft.globalRules.filter((rule) => rule.id !== id);
      removed = draft.globalRules.length !== before;
      for (const root of Object.keys(draft.workspaceRules)) {
        const list = draft.workspaceRules[root];
        const filtered = list.filter((rule) => rule.id !== id);
        if (filtered.length !== list.length) removed = true;
        if (filtered.length === 0) delete draft.workspaceRules[root];
        else draft.workspaceRules[root] = filtered;
      }
      return removed ? null : { error: createMessage('permissions.error.ruleNotFound') };
    });
  }

  /** Effekt einer Regel (für die native Bestätigung beim Löschen von Sperren). */
  async function findRule(ruleId) {
    const state = await read();
    return state.rules.find((rule) => rule.id === ruleId) || null;
  }

  /** Adding patterns tightens; dropping one needs a receipt for exactly those dropped (#514, #980). */
  async function setSensitivePathPatterns(rawPatterns, { confirmation = null } = {}) {
    return update((draft) => {
      const next = normalizeSensitivePathPatterns(rawPatterns);
      const removed = draft.sensitivePathPatterns.filter((pattern) => !next.includes(pattern));
      if (removed.length > 0
        && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.REMOVE_SENSITIVE_PATTERNS, removedPatternsSubject(removed))) {
        return notConfirmed();
      }
      draft.sensitivePathPatterns = next;
      return null;
    });
  }

  /**
   * Switches the sandbox of the execution tools off or back on for one
   * workspace (#357). Off needs `safeStorage`, like every other loosening,
   * and a receipt for that root (#980).
   */
  async function setWorkspaceSandbox(root, enabled, { confirmation = null } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      if (typeof root !== 'string' || !root) return { error: createMessage('permissions.error.noWorkspace') };
      const others = draft.unsandboxedWorkspaces.filter((entry) => entry !== root);
      if (enabled === true) {
        draft.unsandboxedWorkspaces = others;
        rememberWorkspace(draft, root);
        return null;
      }
      if (!enc) return { error: createMessage('permissions.error.sandboxOffNeedsEncryption') };
      if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.SANDBOX_OFF, root)) return notConfirmed();
      draft.unsandboxedWorkspaces = [...others, root];
      rememberWorkspace(draft, root);
      return null;
    });
  }

  /** Whether the sandbox is switched off for this workspace (#357). */
  async function isWorkspaceSandboxDisabled(root) {
    if (typeof root !== 'string' || !root) return false;
    const state = await read();
    return state.unsandboxedWorkspaces.includes(root);
  }

  /**
   * The mode new chats in one workspace start with (#413). `smart` removes the
   * entry. `auto` needs `safeStorage`, like every other loosening, and a
   * receipt for that root unless it is the default already (#980).
   */
  async function setWorkspaceMode(root, rawMode, { confirmation = null } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      if (typeof root !== 'string' || !root) return { error: createMessage('permissions.error.noWorkspace') };
      const mode = normalizeToolPermissionMode(rawMode);
      if (mode !== rawMode) return { error: createMessage('permissions.error.unknownMode') };
      if (mode === DEFAULT_TOOL_PERMISSION_MODE) {
        delete draft.workspaceModes[root];
        return null;
      }
      if (mode === TOOL_PERMISSION_MODES.AUTO && !enc) {
        return { error: createMessage('permissions.error.autoNeedsEncryption') };
      }
      if (mode === TOOL_PERMISSION_MODES.AUTO && draft.workspaceModes[root] !== TOOL_PERMISSION_MODES.AUTO
        && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.WORKSPACE_AUTO, root)) {
        return notConfirmed();
      }
      draft.workspaceModes[root] = mode;
      return null;
    });
  }

  /** The default mode of one workspace; `smart` when it has none (#413). */
  async function readWorkspaceMode(root) {
    if (typeof root !== 'string' || !root) return DEFAULT_TOOL_PERMISSION_MODE;
    const state = await read();
    return state.workspaceModes[root] || DEFAULT_TOOL_PERMISSION_MODE;
  }

  /** The allowances of one scope (#1119): a workspace's own, or those for every workspace (null). */
  function allowanceList(draft, root) {
    return root ? draft.workspaceProgramAllowances[root] || [] : draft.programAllowances;
  }

  function setAllowanceList(draft, root, list) {
    if (!root) draft.programAllowances = list;
    else if (list.length > 0) draft.workspaceProgramAllowances[root] = list;
    else delete draft.workspaceProgramAllowances[root];
  }

  /**
   * Stores a program allowance (#408) for one workspace (`root`) or for every
   * workspace (`root` null, #1119), replacing the entry of the same program
   * in that scope or — when the dialog changed the program or the scope — the
   * one it was opened for (`replacePath` in `replaceRoot`). Widening needs
   * `safeStorage` and a receipt for the program in its scope (#980); only
   * taking rights away works without — and moving an allowance from every
   * workspace to one of them takes rights away, the other way round does not.
   */
  async function setProgramAllowance(rawEntry, { root = null, replacePath = null, replaceRoot = root, confirmation = null } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      const entry = normalizeProgramAllowance(rawEntry);
      if (!entry) return { error: createMessage('permissions.allowance.error.invalid') };
      if (root !== null && (typeof root !== 'string' || !root)) return { error: createMessage('permissions.error.noWorkspace') };
      const fromRoot = replacePath && typeof replaceRoot === 'string' && replaceRoot ? replaceRoot : (replacePath ? null : root);
      let previous = replacePath ? allowanceList(draft, fromRoot).find((other) => other.path === replacePath) || null : null;
      let previousRoot = previous ? fromRoot : root;
      if (!previous) previous = allowanceList(draft, root).find((other) => other.path === entry.path) || null;
      if (!previous) previousRoot = root;
      const narrowing = !!previous && isNarrowing(previous, entry) && (previousRoot === root || previousRoot === null);
      if (!enc && !narrowing) {
        return { error: createMessage('permissions.allowance.error.needsEncryption') };
      }
      if (!narrowing && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE, programAllowanceSubject(entry.path, root))) {
        return notConfirmed();
      }
      const inPlace = !!previous && previousRoot === root;
      // Another entry for the same program in this scope gives way to this one.
      const kept = allowanceList(draft, root).filter((other) => other === previous || other.path !== entry.path);
      if (!inPlace && kept.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES) {
        return { error: createMessage('permissions.allowance.error.tooMany', { max: PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES }) };
      }
      // Added up with the allowance of the other scope (#1119), it must stay
      // one allowance's worth: a run never gets more, so it must not be cut.
      const partners = root
        ? [draft.programAllowances.find((other) => other.path === entry.path && other !== previous)]
        : Object.values(draft.workspaceProgramAllowances).map((list) => list.find((other) => other.path === entry.path && other !== previous));
      if (partners.some((other) => combinationTooLarge(entry, other))) {
        return {
          error: createMessage('permissions.allowance.error.combinedTooLarge', {
            maxDomains: PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS,
            maxFolders: PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS,
          }),
        };
      }
      if (previous && !inPlace) {
        setAllowanceList(draft, previousRoot, allowanceList(draft, previousRoot).filter((other) => other !== previous));
      }
      // An edited entry keeps its place in the list; a new one goes last.
      setAllowanceList(draft, root, inPlace ? kept.map((other) => (other === previous ? entry : other)) : [...kept, entry]);
      return null;
    });
  }

  /** Takes a program allowance away (#408) — a tightening, never refused. `root` null: every workspace. */
  async function removeProgramAllowance(programPath, { root = null } = {}) {
    return update((draft) => {
      setAllowanceList(draft, root || null, allowanceList(draft, root || null).filter((entry) => entry.path !== programPath));
      return null;
    });
  }

  /**
   * The allowances a run in `root` gets: those for every workspace and the
   * workspace's own, added up per program (#1119). Without a root only the
   * global ones. A store that cannot be read has none (#408).
   */
  async function readProgramAllowances(root = null) {
    const state = await read();
    const own = typeof root === 'string' && root ? state.workspaceProgramAllowances?.[root] : [];
    return combineProgramAllowances(state.programAllowances, own);
  }

  /**
   * Keeps hosts open for every run in one workspace (#946) — what a
   * connection card offered, confirmed by the user for that root (#980). A
   * loosening, so it needs `safeStorage`. Hosts already kept are no error.
   */
  async function addWorkspaceHosts(root, rawHosts, { confirmation = null } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      if (typeof root !== 'string' || !root) return { error: createMessage('permissions.error.noWorkspace') };
      const hosts = grantedHosts(rawHosts);
      if (hosts.length === 0) return { error: createMessage('permissions.workspaceHosts.error.invalid') };
      if (!enc) return { error: createMessage('permissions.workspaceHosts.error.needsEncryption') };
      if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, root)) return notConfirmed();
      const kept = draft.workspaceHosts[root] || [];
      const next = [...kept, ...hosts.filter((host) => !kept.includes(host))];
      if (next.length > MAX_WORKSPACE_HOSTS) {
        return { error: createMessage('permissions.workspaceHosts.error.tooMany', { max: MAX_WORKSPACE_HOSTS }) };
      }
      draft.workspaceHosts[root] = next;
      return null;
    });
  }

  /** Closes one host of a workspace again (#946) — a tightening, never refused. */
  async function removeWorkspaceHost(root, host) {
    return update((draft) => {
      if (typeof root !== 'string' || !root) return { error: createMessage('permissions.error.noWorkspace') };
      const next = (draft.workspaceHosts[root] || []).filter((entry) => entry !== host);
      if (next.length > 0) draft.workspaceHosts[root] = next;
      else delete draft.workspaceHosts[root];
      return null;
    });
  }

  /**
   * Keeps hosts open for every run in every workspace (#1119). Only the
   * settings offer it, never a connection card, and only the forms a card
   * would offer: `host:port` or one level of `*.` above a host, never a
   * shared domain. A loosening: `safeStorage` and a receipt for exactly these
   * hosts.
   */
  async function addGlobalHosts(rawHosts, { confirmation = null } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      const hosts = grantedHosts(rawHosts);
      if (hosts.length === 0) return { error: createMessage('permissions.workspaceHosts.error.invalid') };
      if (!enc) return { error: createMessage('permissions.workspaceHosts.error.needsEncryption') };
      if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.GLOBAL_HOSTS, globalHostsSubject(hosts))) return notConfirmed();
      const next = [...draft.globalHosts, ...hosts.filter((host) => !draft.globalHosts.includes(host))];
      if (next.length > MAX_GLOBAL_HOSTS) {
        return { error: createMessage('permissions.globalHosts.error.tooMany', { max: MAX_GLOBAL_HOSTS }) };
      }
      draft.globalHosts = next;
      return null;
    });
  }

  /** Closes a host kept open everywhere (#1119) — a tightening, never refused. */
  async function removeGlobalHost(host) {
    return update((draft) => {
      draft.globalHosts = draft.globalHosts.filter((entry) => entry !== host);
      return null;
    });
  }

  /** Every root the policy holds anything for. */
  function rootsWithSettings(draft) {
    return [
      ...draft.unsandboxedWorkspaces,
      ...Object.keys(draft.workspaceRules),
      ...Object.keys(draft.workspaceModes),
      ...Object.keys(draft.workspaceHosts),
      ...Object.keys(draft.workspaceProgramAllowances),
    ];
  }

  /**
   * While new workspaces start without the sandbox (#1119), a folder whose
   * sandbox setting was decided — by hand or by that default — is known, so
   * it is not taken for a new one again.
   */
  function rememberWorkspace(draft, root) {
    if (draft.newWorkspaceSandboxOff !== true || typeof root !== 'string' || !root) return;
    draft.knownWorkspaces = [...draft.knownWorkspaces.filter((entry) => entry !== root), root].slice(-MAX_KNOWN_WORKSPACES);
  }

  function isKnownWorkspace(payload, root) {
    return payload.knownWorkspaces.includes(root) || rootsWithSettings(payload).includes(root);
  }

  /**
   * Whether folders opened for the first time start with the sandbox on
   * (#1119). Off is a loosening: `safeStorage` and a receipt. Every folder
   * there is at that moment — `knownRoots`, the folders Snotra has opened,
   * and every folder the policy holds something for — keeps its setting.
   * On again forgets that list; folders that started without the sandbox in
   * the meantime keep their setting too.
   */
  async function setNewWorkspaceSandbox(enabled, { confirmation = null, knownRoots = [] } = {}) {
    return update((draft, { encryptionAvailable: enc }) => {
      if (enabled === true) {
        if (!draft.newWorkspaceSandboxOff) return { unchanged: true };
        draft.newWorkspaceSandboxOff = false;
        draft.knownWorkspaces = [];
        return null;
      }
      if (draft.newWorkspaceSandboxOff) return { unchanged: true };
      if (!enc) return { error: createMessage('permissions.error.sandboxOffNeedsEncryption') };
      if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.NEW_WORKSPACE_SANDBOX_OFF, '')) return notConfirmed();
      draft.newWorkspaceSandboxOff = true;
      draft.knownWorkspaces = normalizeWorkspaceRoots([
        ...(Array.isArray(knownRoots) ? knownRoots : []),
        ...rootsWithSettings(draft),
      ]).slice(-MAX_KNOWN_WORKSPACES);
      return null;
    });
  }

  /**
   * A folder was opened (#1119). While new workspaces start without the
   * sandbox, a folder not known yet gets its sandbox switched off — written
   * out, so it shows in the settings and keeps that setting when the default
   * changes again. The default itself was confirmed and is signed; without
   * `safeStorage` the folder simply stays isolated. Nothing is written for a
   * folder that is known, or while the default is on.
   */
  async function noteWorkspaceOpened(root) {
    if (typeof root !== 'string' || !root) return { ok: true, changed: false };
    const loaded = await loadFromDisk();
    if (!loaded.payload || loaded.payload.newWorkspaceSandboxOff !== true || isKnownWorkspace(loaded.payload, root)) {
      return { ok: true, changed: false };
    }
    const result = await update((draft, { encryptionAvailable: enc }) => {
      if (draft.newWorkspaceSandboxOff !== true || isKnownWorkspace(draft, root) || !enc) return { unchanged: true };
      draft.unsandboxedWorkspaces = [...draft.unsandboxedWorkspaces.filter((entry) => entry !== root), root];
      rememberWorkspace(draft, root);
      return null;
    });
    return { ...result, changed: result.ok === true && result.unchanged !== true };
  }

  /**
   * "Reset sandbox for this workspace" (#1119): the sandbox back on, its own
   * programs and hosts gone. What applies in every workspace stays. Only
   * takes rights away.
   */
  async function resetWorkspaceSandbox(root) {
    return update((draft) => {
      if (typeof root !== 'string' || !root) return { error: createMessage('permissions.error.noWorkspace') };
      draft.unsandboxedWorkspaces = draft.unsandboxedWorkspaces.filter((entry) => entry !== root);
      delete draft.workspaceProgramAllowances[root];
      delete draft.workspaceHosts[root];
      rememberWorkspace(draft, root);
      return null;
    });
  }

  /**
   * "Reset the sandbox everywhere" (#1119): on in every workspace and in new
   * ones, every program and host allowance gone, the global ones included.
   * Only takes rights away, so it needs no receipt; the settings ask anyway,
   * because it is broad.
   */
  async function resetSandboxEverywhere() {
    return update((draft) => {
      draft.unsandboxedWorkspaces = [];
      draft.programAllowances = [];
      draft.workspaceProgramAllowances = {};
      draft.workspaceHosts = {};
      draft.globalHosts = [];
      draft.newWorkspaceSandboxOff = false;
      draft.knownWorkspaces = [];
      return null;
    });
  }

  // "Reset workspace rules" is the workspace's whole policy: the sandbox
  // opt-out (#357), the default mode (#413), the hosts kept open (#946) and
  // its own program allowances (#1119) go with the rules. When blocks or "Always ask" go too, that is a loosening
  // and needs a receipt for the root (#514, #980).
  async function resetWorkspaceRules(root, { confirmation = null } = {}) {
    return update((draft) => {
      if (typeof root === 'string' && root) {
        const losesProtection = (draft.workspaceRules[root] || []).some((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY)
          || draft.workspaceModes[root] === TOOL_PERMISSION_MODES.ASK_ALL;
        if (losesProtection && !confirmedBy(confirmation, CONFIRMATION_ACTIONS.RESET_WORKSPACE, root)) return notConfirmed();
        delete draft.workspaceRules[root];
        draft.unsandboxedWorkspaces = draft.unsandboxedWorkspaces.filter((entry) => entry !== root);
        delete draft.workspaceModes[root];
        delete draft.workspaceHosts[root];
        delete draft.workspaceProgramAllowances[root];
        rememberWorkspace(draft, root);
      }
      return null;
    });
  }

  /** The widest action: always asked, so always a receipt (#514, #980). */
  async function resetAll({ confirmation = null } = {}) {
    return update((draft) => {
      if (!confirmedBy(confirmation, CONFIRMATION_ACTIONS.RESET_ALL, '')) return notConfirmed();
      const fresh = defaultPayload();
      draft.mode = fresh.mode;
      draft.globalRules = [];
      draft.workspaceRules = {};
      draft.sensitivePathPatterns = [];
      draft.unsandboxedWorkspaces = [];
      draft.programAllowances = [];
      draft.workspaceProgramAllowances = {};
      draft.workspaceModes = {};
      draft.workspaceHosts = {};
      draft.globalHosts = [];
      draft.newWorkspaceSandboxOff = false;
      draft.knownWorkspaces = [];
      draft.autoChats = [];
      draft.legacyWriteMigrated = false;
      return null;
    });
  }

  async function clearLegacyMigrationNotice() {
    return update((draft) => {
      draft.legacyWriteMigrated = false;
      return null;
    });
  }

  return {
    INTEGRITY,
    getPolicyPath: policyPath,
    getKeyPath: keyPath,
    read,
    setMode,
    restoreMode,
    addRule,
    removeRule,
    findRule,
    setSensitivePathPatterns,
    setWorkspaceSandbox,
    isWorkspaceSandboxDisabled,
    setWorkspaceMode,
    readWorkspaceMode,
    setProgramAllowance,
    removeProgramAllowance,
    readProgramAllowances,
    addWorkspaceHosts,
    removeWorkspaceHost,
    addGlobalHosts,
    removeGlobalHost,
    setNewWorkspaceSandbox,
    noteWorkspaceOpened,
    resetWorkspaceSandbox,
    resetSandboxEverywhere,
    resetWorkspaceRules,
    resetAll,
    clearLegacyMigrationNotice,
  };
}

module.exports = {
  createToolPolicyStore,
  POLICY_FILENAME,
  POLICY_KEY_FILENAME,
  POLICY_FILE_VERSION,
  INTEGRITY,
  MAX_WORKSPACE_HOSTS,
  MAX_GLOBAL_HOSTS,
  MAX_AUTO_CHATS,
};
