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
  function grant({ scopeKey, tool, targets, riskClasses, providerKey = null } = {}) {
    const classes = sessionGrantableClasses(riskClasses);
    if (!classes || typeof tool !== 'string' || !tool || typeof scopeKey !== 'string') return null;
    const sensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE);
    const entry = {
      id: nextId(),
      scopeKey,
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

  function count() {
    return grants.length;
  }

  return { grant, find, clear, clearScope, count };
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
