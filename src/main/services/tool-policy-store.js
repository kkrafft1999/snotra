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
 * `integrity` meldet den Zustand an die Oberfläche. Ohne verfügbare
 * `safeStorage` sind Auto und dauerhafte Allow-Regeln nicht speicherbar.
 */

const {
  TOOL_PERMISSION_MODES,
  DEFAULT_TOOL_PERMISSION_MODE,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  normalizeToolPermissionMode,
  normalizePermissionRule,
  normalizePermissionRules,
  normalizeSensitivePathPatterns,
} = require('../../shared/contracts/tool-permissions');

const POLICY_FILENAME = 'tool-policy.json';
const POLICY_KEY_FILENAME = 'tool-policy.key';
const POLICY_FILE_VERSION = 1;
const HMAC_KEY_BYTES = 32;

const INTEGRITY = Object.freeze({
  OK: 'ok',
  UNSIGNED: 'unsigned',
  INVALID: 'invalid',
  MISSING: 'missing',
});

function defaultPayload() {
  return {
    revision: 0,
    mode: DEFAULT_TOOL_PERMISSION_MODE,
    globalRules: [],
    workspaceRules: {},
    sensitivePathPatterns: [],
    legacyWriteMigrated: false,
    updatedAt: 0,
  };
}

function createToolPolicyStore({ app, safeStorage, fs, path, crypto, uiPrefsPath = null, log = console, now = () => Date.now() }) {
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

  /** Lädt (oder erzeugt) den HMAC-Schlüssel; null ohne safeStorage. */
  async function loadKey() {
    if (!encryptionAvailable()) return null;
    if (!keyPromise) {
      keyPromise = (async () => {
        try {
          const raw = await fs.readFile(keyPath(), 'utf8');
          const decrypted = safeStorage.decryptString(Buffer.from(raw.trim(), 'base64'));
          const key = Buffer.from(decrypted, 'hex');
          if (key.length === HMAC_KEY_BYTES) return key;
        } catch {
          /* neu erzeugen */
        }
        const key = crypto.randomBytes(HMAC_KEY_BYTES);
        try {
          const encrypted = safeStorage.encryptString(key.toString('hex')).toString('base64');
          await fs.mkdir(path.dirname(keyPath()), { recursive: true });
          await fs.writeFile(keyPath(), encrypted, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
          log?.warn?.(`[tool-policy] Schlüssel konnte nicht gespeichert werden: ${error?.message || error}`);
          return null;
        }
        return key;
      })();
    }
    return keyPromise;
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
    out.legacyWriteMigrated = data.legacyWriteMigrated === true;
    out.updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
    return out;
  }

  /** Fail-safe: nur Sperren und Muster überleben eine gescheiterte Prüfung. */
  function failSafe(payload) {
    const out = normalizePayload(payload);
    out.mode = DEFAULT_TOOL_PERMISSION_MODE;
    out.globalRules = out.globalRules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY);
    for (const root of Object.keys(out.workspaceRules)) {
      out.workspaceRules[root] = out.workspaceRules[root].filter(
        (rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY
      );
      if (out.workspaceRules[root].length === 0) delete out.workspaceRules[root];
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
      raw = await fs.readFile(policyPath(), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { payload: null, integrity: INTEGRITY.MISSING };
      return { payload: failSafe(null), integrity: INTEGRITY.INVALID };
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
    const key = await loadKey();
    if (!key) {
      // Ohne Schlüssel lässt sich nichts verifizieren: Fail-safe, aber Sperren
      // und Muster bleiben wirksam.
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.UNSIGNED };
    }
    if (typeof parsed.signature !== 'string' || !parsed.signature) {
      return { payload: failSafe(parsed.payload), integrity: INTEGRITY.UNSIGNED };
    }
    const expected = sign(key, serializePayload(parsed.payload));
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
    const tmp = `${target}.tmp-${crypto.randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
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
      try {
        await writeToDisk(payload);
      } catch (error) {
        log?.warn?.(`[tool-policy] Policy konnte nicht angelegt werden: ${error?.message || error}`);
      }
      const key = await loadKey();
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
      const base = loaded.integrity === INTEGRITY.MISSING ? defaultPayload() : loaded.payload;
      const draft = normalizePayload(JSON.parse(JSON.stringify(base)));
      const result = await updater(draft, { encryptionAvailable: encryptionAvailable(), integrity: loaded.integrity });
      if (result && result.error) return { ok: false, error: result.error, ...snapshot(base, loaded.integrity) };
      const next = normalizePayload(draft);
      next.revision = base.revision + 1;
      next.updatedAt = now();
      await writeToDisk(next);
      const key = await loadKey();
      return { ok: true, ...snapshot(next, key ? INTEGRITY.OK : INTEGRITY.UNSIGNED) };
    });
    writeChain = task.catch(() => {});
    return task;
  }

  async function setMode(rawMode) {
    const mode = normalizeToolPermissionMode(rawMode);
    return update((draft, { encryptionAvailable: enc }) => {
      if (mode === TOOL_PERMISSION_MODES.AUTO && !enc) {
        return { error: 'Auto ist ohne verschlüsselten Speicher nicht aktivierbar.' };
      }
      draft.mode = mode;
      return null;
    });
  }

  async function addRule(rawRule) {
    return update((draft, { encryptionAvailable: enc }) => {
      const id = typeof rawRule?.id === 'string' && rawRule.id.trim() ? rawRule.id.trim() : crypto.randomUUID();
      const rule = normalizePermissionRule({ ...rawRule, id, createdAt: now() });
      if (!rule) return { error: 'Ungültige Regel.' };
      if (rule.effect === PERMISSION_RULE_EFFECTS.ALLOW && !enc) {
        return { error: 'Dauerhafte Erlaubnisse sind ohne verschlüsselten Speicher nicht speicherbar.' };
      }
      if (allRules(draft).some((existing) => existing.id === rule.id)) {
        return { error: 'Regel-ID bereits vergeben.' };
      }
      if (rule.scope === PERMISSION_RULE_SCOPES.GLOBAL) {
        draft.globalRules.push(rule);
      } else {
        draft.workspaceRules[rule.root] = [...(draft.workspaceRules[rule.root] || []), rule];
      }
      return null;
    });
  }

  async function removeRule(ruleId) {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    return update((draft) => {
      if (!id) return { error: 'Regel-ID fehlt.' };
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
      return removed ? null : { error: 'Regel nicht gefunden.' };
    });
  }

  /** Effekt einer Regel (für die native Bestätigung beim Löschen von Sperren). */
  async function findRule(ruleId) {
    const state = await read();
    return state.rules.find((rule) => rule.id === ruleId) || null;
  }

  async function setSensitivePathPatterns(rawPatterns) {
    return update((draft) => {
      draft.sensitivePathPatterns = normalizeSensitivePathPatterns(rawPatterns);
      return null;
    });
  }

  async function resetWorkspaceRules(root) {
    return update((draft) => {
      if (typeof root === 'string' && root) delete draft.workspaceRules[root];
      return null;
    });
  }

  async function resetAll() {
    return update((draft) => {
      const fresh = defaultPayload();
      draft.mode = fresh.mode;
      draft.globalRules = [];
      draft.workspaceRules = {};
      draft.sensitivePathPatterns = [];
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
    addRule,
    removeRule,
    findRule,
    setSensitivePathPatterns,
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
};
