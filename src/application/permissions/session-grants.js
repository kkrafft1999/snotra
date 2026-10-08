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

function pathsKey(targets) {
  const paths = (Array.isArray(targets) ? targets : [])
    .map((target) => (typeof target === 'string' ? target : target?.path))
    .filter((p) => typeof p === 'string');
  return [...new Set(paths)].sort().join('\n');
}

function versionsKey(targets) {
  const versions = (Array.isArray(targets) ? targets : [])
    .map((target) => (target && typeof target === 'object' ? `${target.path}@${target.version ?? ''}` : ''))
    .filter(Boolean);
  return versions.sort().join('\n');
}

/** Klassen, die eine Sitzungsfreigabe überhaupt tragen darf. */
function sessionGrantableClasses(riskClasses) {
  const classes = normalizeRiskClasses(riskClasses);
  if (!classes) return null;
  if (classes.some((cls) => !SESSION_GRANTABLE_CLASSES.includes(cls))) return null;
  return classes;
}

function createSessionGrants({ nextId = defaultIdFactory(), now = () => Date.now() } = {}) {
  /** @type {Array<object>} */
  let grants = [];
  const listeners = new Set();

  /** Replaces the list and tells the listeners, but only when it changed. */
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
   */
  function grant({ scopeKey, tool, targets, riskClasses, providerKey = null, chatId = null, scope = null, sandbox = null } = {}) {
    const classes = sessionGrantableClasses(riskClasses);
    if (!classes || typeof tool !== 'string' || !tool || typeof scopeKey !== 'string') return null;
    // A folder or path a sandbox card opened for the session (#792). It does
    // not allow a tool call; the shell and Python runs of the chat get it.
    const sandboxGrant = sandbox && (sandbox.kind === 'write' || sandbox.kind === 'read')
      && typeof sandbox.path === 'string' && sandbox.path
      ? { kind: sandbox.kind, path: sandbox.path }
      : null;
    const sensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE);
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

  /** Sucht eine passende, gültige Freigabe für einen konkreten Aufruf. */
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

  function clearScope(scopeKey) {
    replace(grants.filter((entry) => entry.scopeKey !== scopeKey));
  }

  /** Drops the approvals of one chat — its mode changed, or it was deleted (#320). */
  function clearChat(chatId) {
    const key = typeof chatId === 'string' && chatId ? chatId : null;
    replace(grants.filter((entry) => entry.chatId !== key));
  }

  /**
   * Keeps only the approvals of the given chats: the visible one and those
   * still running in the background (#320). Everything else is a chat the
   * user has left, and leaving a chat ends its approvals (concept §7).
   */
  function retainChats(chatIds) {
    const keep = new Set(chatIds);
    replace(grants.filter((entry) => keep.has(entry.chatId)));
  }

  /**
   * Drops one approval by its id (#447). Revoking only tightens; an id that is
   * unknown or already gone changes nothing. Returns whether one was dropped.
   */
  function revoke(id) {
    if (typeof id !== 'string' || !id) return false;
    const next = grants.filter((entry) => entry.id !== id);
    if (next.length === grants.length) return false;
    replace(next);
    return true;
  }

  /** What may be shown of each approval, oldest first (#447). */
  function list() {
    return grants.map((entry) => ({
      id: entry.id,
      chatId: entry.chatId,
      tool: entry.tool,
      classes: [...entry.classes],
      scope: entry.scope,
      grantedAt: entry.grantedAt,
    }));
  }

  function count() {
    return grants.length;
  }

  /**
   * What sandbox cards opened for the rest of a session (#792): the folders
   * a run may write in and the protected paths it may read, for every shell
   * and Python run under this scope.
   */
  function sandboxPaths(scopeKey) {
    const writePaths = new Set();
    const readPaths = new Set();
    for (const entry of grants) {
      if (!entry.sandbox || entry.scopeKey !== scopeKey) continue;
      (entry.sandbox.kind === 'read' ? readPaths : writePaths).add(entry.sandbox.path);
    }
    return { writePaths: [...writePaths], readPaths: [...readPaths] };
  }

  /** Called whenever the set of approvals changes; returns the unsubscribe. */
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
