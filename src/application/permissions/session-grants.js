/**
 * Sitzungsfreigaben (Issue #66, Konzept §7): „Für diese Sitzung erlauben“.
 *
 * Liegen ausschließlich im Speicher. Eine Freigabe gilt für denselben
 * Geltungsbereich (Chat, Workspace, Modus, Regelstand, aktive Skills — vom
 * Aufrufer als `scopeKey` zusammengefasst), dasselbe Tool, exakt dieselbe
 * Zielmenge und höchstens die freigegebenen Klassen. Sensible Lesefreigaben
 * binden zusätzlich Dateiversion und Provider-Endpunkt.
 *
 * Since #447 an approval also keeps what a person needs to recognise it — the
 * card's sentence on the session scope, the chat and the time it was granted —
 * so that it can be listed and revoked one by one. `list()` hands out only
 * that; the scope key, the file version and the provider key stay in here.
 */
'use strict';

const {
  TOOL_RISK_CLASSES,
  SESSION_GRANTABLE_CLASSES,
  normalizeRiskClasses,
} = require('../../shared/contracts/tool-permissions');
const { isMessage } = require('../../shared/contracts/message');

/**
 * What a sandbox card can open for a session (#792): for the shell and
 * Python runs a folder to write in, a path to read, a host to connect to;
 * for the file tools a file or folder outside the open folder, to read or to
 * write in (step 4).
 */
const SANDBOX_GRANT_KINDS = Object.freeze(['write', 'read', 'network', 'outsideRead', 'outsideWrite']);

/**
 * @typedef {'write'|'read'|'network'|'outsideRead'|'outsideWrite'} SandboxGrantKind
 * @typedef {import('../../shared/contracts/tool-permissions').ToolRiskClass} ToolRiskClass
 * @typedef {import('../../shared/contracts/message').Message} Message
 */

/**
 * @param {unknown} value
 * @returns {value is SandboxGrantKind}
 */
function isSandboxGrantKind(value) {
  return SANDBOX_GRANT_KINDS.includes(value);
}

/** @param {SessionGrantRequest['targets']} targets */
function pathsKey(targets) {
  const paths = (Array.isArray(targets) ? targets : [])
    .map((target) => (typeof target === 'string' ? target : target?.path))
    .filter((p) => typeof p === 'string');
  return [...new Set(paths)].sort().join('\n');
}

/** @param {SessionGrantRequest['targets']} targets */
function versionsKey(targets) {
  const versions = (Array.isArray(targets) ? targets : [])
    .map((target) => (target && typeof target === 'object' ? `${target.path}@${target.version ?? ''}` : ''))
    .filter(Boolean);
  return versions.sort().join('\n');
}

/**
 * Klassen, die eine Sitzungsfreigabe überhaupt tragen darf.
 * @param {unknown} riskClasses
 * @returns {ToolRiskClass[]|null}
 */
function sessionGrantableClasses(riskClasses) {
  const classes = normalizeRiskClasses(riskClasses);
  if (!classes) return null;
  if (classes.some((cls) => !SESSION_GRANTABLE_CLASSES.includes(cls))) return null;
  return classes;
}

/**
 * One approval as it is kept in here. `list()` hands out only the fields a
 * person needs to recognise it.
 *
 * @typedef {Object} SessionGrant
 * @property {string} id
 * @property {string} scopeKey
 * @property {string|null} chatId
 * @property {string} tool
 * @property {string} targetKey
 * @property {ToolRiskClass[]} classes
 * @property {string|null} versionKey   sensitive reads only
 * @property {string|null} providerKey  sensitive reads only
 * @property {Message|null} scope       the card's sentence, a message object
 * @property {{ kind: SandboxGrantKind, path: string, file?: boolean }} [sandbox]
 * @property {number} grantedAt
 */

/**
 * What identifies a call for `grant` and `find`.
 *
 * @typedef {Object} SessionGrantRequest
 * @property {string} [scopeKey]
 * @property {string} [tool]
 * @property {Array<string|{ path: string, version?: string|null }>} [targets]
 * @property {string[]} [riskClasses]
 * @property {string|null} [providerKey]
 * @property {string|null} [chatId]  `grant` only
 * @property {unknown} [scope]   `grant` only; kept when it is a message object
 * @property {{ kind: string, path: string, file?: boolean }|null} [sandbox]  `grant` only
 */

/**
 * What `list()` hands out of an approval.
 * @typedef {ReturnType<ReturnType<typeof createSessionGrants>['list']>[number]} SessionGrantView
 */

/**
 * @param {{ nextId?: () => string, now?: () => number }} [options]
 */
function createSessionGrants({ nextId = defaultIdFactory(), now = () => Date.now() } = {}) {
  /** @type {SessionGrant[]} */
  let grants = [];
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /**
   * Replaces the list and tells the listeners, but only when it changed.
   * @param {SessionGrant[]} next
   */
  function replace(next) {
    const changed = next.length !== grants.length;
    grants = next;
    if (changed) notify();
  }

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  /**
   * Legt eine Freigabe an. Liefert null, wenn die Klassen nicht sitzungsweise
   * freigebbar sind (delete/execute/external nur einmalig, Konzept §6).
   *
   * @param {SessionGrantRequest} [request]
   * @returns {SessionGrant|null}
   */
  function grant({ scopeKey, tool, targets, riskClasses, providerKey = null, chatId = null, scope = null, sandbox = null } = {}) {
    // A folder, path or host a sandbox card opened for the session (#792). It
    // does not allow a tool call; the shell and Python runs of the chat get
    // it. That is why a connection may be kept for the session here although
    // `external` never is for a call.
    const sandboxGrant = sandbox && isSandboxGrantKind(sandbox.kind)
      && typeof sandbox.path === 'string' && sandbox.path
      ? { kind: sandbox.kind, path: sandbox.path, ...(sandbox.file === true ? { file: true } : {}) }
      : null;
    const classes = sandboxGrant ? normalizeRiskClasses(riskClasses) : sessionGrantableClasses(riskClasses);
    if (!classes || typeof tool !== 'string' || !tool || typeof scopeKey !== 'string') return null;
    const sensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE);
    /** @type {SessionGrant} */
    const entry = {
      id: nextId(),
      scopeKey,
      // The chat is part of `scopeKey` already; it is kept on its own so that
      // one chat's approvals can be dropped without touching another's (#320).
      chatId: typeof chatId === 'string' && chatId ? chatId : null,
      tool,
      targetKey: pathsKey(targets),
      classes,
      versionKey: sensitive ? versionsKey(targets) : null,
      providerKey: sensitive ? providerKey ?? null : null,
      // For display only (#447): the card's sentence, a message object.
      scope: isMessage(scope) ? scope : null,
      ...(sandboxGrant ? { sandbox: sandboxGrant } : {}),
      grantedAt: now(),
    };
    grants.push(entry);
    notify();
    return entry;
  }

  /**
   * Sucht eine passende, gültige Freigabe für einen konkreten Aufruf.
   *
   * @param {SessionGrantRequest} [request]
   * @returns {SessionGrant|null}
   */
  function find({ scopeKey, tool, targets, riskClasses, providerKey = null } = {}) {
    const classes = normalizeRiskClasses(riskClasses);
    if (!classes || classes.length === 0) return null;
    const targetKey = pathsKey(targets);
    const wantsSensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE);
    for (const entry of grants) {
      if (entry.sandbox) continue;
      if (entry.scopeKey !== scopeKey || entry.tool !== tool || entry.targetKey !== targetKey) continue;
      if (!classes.every((cls) => entry.classes.includes(cls))) continue;
      if (wantsSensitive) {
        if (entry.versionKey !== versionsKey(targets)) continue;
        if ((entry.providerKey ?? null) !== (providerKey ?? null)) continue;
      }
      return entry;
    }
    return null;
  }

  function clear() {
    replace([]);
  }

  /** @param {string} scopeKey */
  function clearScope(scopeKey) {
    replace(grants.filter((entry) => entry.scopeKey !== scopeKey));
  }

  /**
   * Drops the approvals of one chat — its mode changed, or it was deleted (#320).
   * @param {unknown} chatId
   */
  function clearChat(chatId) {
    const key = typeof chatId === 'string' && chatId ? chatId : null;
    replace(grants.filter((entry) => entry.chatId !== key));
  }

  /**
   * Keeps only the approvals of the given chats: the visible one and those
   * still running in the background (#320). Everything else is a chat the
   * user has left, and leaving a chat ends its approvals (concept §7).
   *
   * @param {Iterable<string|null>} chatIds
   */
  function retainChats(chatIds) {
    const keep = new Set(chatIds);
    replace(grants.filter((entry) => keep.has(entry.chatId)));
  }

  /**
   * Drops one approval by its id (#447). Revoking only tightens; an id that is
   * unknown or already gone changes nothing. Returns whether one was dropped.
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  function revoke(id) {
    if (typeof id !== 'string' || !id) return false;
    const next = grants.filter((entry) => entry.id !== id);
    if (next.length === grants.length) return false;
    replace(next);
    return true;
  }

  /**
   * What may be shown of each approval, oldest first (#447). For one a
   * sandbox card gave, its kind — folder, path or host — so Tools › Security
   * can list it with the workspace (#1119).
   */
  function list() {
    return grants.map((entry) => ({
      id: entry.id,
      chatId: entry.chatId,
      tool: entry.tool,
      classes: [...entry.classes],
      scope: entry.scope,
      ...(entry.sandbox ? { sandbox: entry.sandbox.kind } : {}),
      grantedAt: entry.grantedAt,
    }));
  }

  function count() {
    return grants.length;
  }

  /**
   * What sandbox cards opened for the rest of a session (#792): the folders
   * a run may write in, the protected paths it may read and the hosts it may
   * connect to, for every shell and Python run under this scope — and, for
   * the file tools, what they may use outside the open folder (`outside`).
   *
   * @param {string} scopeKey
   */
  function sandboxPaths(scopeKey) {
    /** @type {Record<'write'|'read'|'network', Set<string>>} */
    const sets = { write: new Set(), read: new Set(), network: new Set() };
    /** @type {Array<{ path: string, file: boolean, access: 'read'|'write' }>} */
    const outside = [];
    for (const entry of grants) {
      if (!entry.sandbox || entry.scopeKey !== scopeKey) continue;
      const { kind, path, file } = entry.sandbox;
      if (kind === 'outsideRead' || kind === 'outsideWrite') {
        outside.push({ path, file: file === true, access: kind === 'outsideWrite' ? 'write' : 'read' });
        continue;
      }
      sets[kind]?.add(path);
    }
    return { writePaths: [...sets.write], readPaths: [...sets.read], hosts: [...sets.network], outside };
  }

  /**
   * Called whenever the set of approvals changes; returns the unsubscribe.
   * @param {() => void} listener
   */
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { grant, find, clear, clearScope, clearChat, retainChats, revoke, list, count, onChange, sandboxPaths };
}

function defaultIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `grant-${counter}`;
  };
}

module.exports = {
  createSessionGrants,
  sessionGrantableClasses,
};
