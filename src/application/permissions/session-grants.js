/**
 * Sitzungsfreigaben (Issue #66, Konzept §7): „Für diese Sitzung erlauben“.
 *
 * Liegen ausschließlich im Speicher. Eine Freigabe gilt für denselben
 * Geltungsbereich (Chat, Workspace, Modus, Regelstand, aktive Skills — vom
 * Aufrufer als `scopeKey` zusammengefasst), dasselbe Tool, exakt dieselbe
 * Zielmenge und höchstens die freigegebenen Klassen. Sensible Lesefreigaben
 * binden zusätzlich Dateiversion und Provider-Endpunkt.
 */
'use strict';

const {
  TOOL_RISK_CLASSES,
  SESSION_GRANTABLE_CLASSES,
  normalizeRiskClasses,
} = require('../../shared/contracts/tool-permissions');

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

function createSessionGrants({ nextId = defaultIdFactory() } = {}) {
  /** @type {Array<object>} */
  let grants = [];

  /**
   * Legt eine Freigabe an. Liefert null, wenn die Klassen nicht sitzungsweise
   * freigebbar sind (delete/execute/external nur einmalig, Konzept §6).
   */
  function grant({ scopeKey, tool, targets, riskClasses, providerKey = null, chatId = null } = {}) {
    const classes = sessionGrantableClasses(riskClasses);
    if (!classes || typeof tool !== 'string' || !tool || typeof scopeKey !== 'string') return null;
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
    };
    grants.push(entry);
    return entry;
  }

  /** Sucht eine passende, gültige Freigabe für einen konkreten Aufruf. */
  function find({ scopeKey, tool, targets, riskClasses, providerKey = null } = {}) {
    const classes = normalizeRiskClasses(riskClasses);
    if (!classes || classes.length === 0) return null;
    const targetKey = pathsKey(targets);
    const wantsSensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE);
    for (const entry of grants) {
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
    grants = [];
  }

  function clearScope(scopeKey) {
    grants = grants.filter((entry) => entry.scopeKey !== scopeKey);
  }

  /** Drops the approvals of one chat — its mode changed, or it was deleted (#320). */
  function clearChat(chatId) {
    const key = typeof chatId === 'string' && chatId ? chatId : null;
    grants = grants.filter((entry) => entry.chatId !== key);
  }

  /**
   * Keeps only the approvals of the given chats: the visible one and those
   * still running in the background (#320). Everything else is a chat the
   * user has left, and leaving a chat ends its approvals (concept §7).
   */
  function retainChats(chatIds) {
    const keep = new Set(chatIds);
    grants = grants.filter((entry) => keep.has(entry.chatId));
  }

  function count() {
    return grants.length;
  }

  return { grant, find, clear, clearScope, clearChat, retainChats, count };
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
