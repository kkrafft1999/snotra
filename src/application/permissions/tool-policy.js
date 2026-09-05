/**
 * Reine Policy für Tool-Aufrufe (Issue #66, Konzept §3).
 *
 * Deterministisch und regelbasiert, ohne LLM-Bewertung und ohne
 * Laufzeitabhängigkeiten. Eingaben sind bereits validierte Daten (Klassen,
 * Ziele, Regeln, Modus); die Ausgabe ist `allow | ask | deny` mit Quelle,
 * Grund und Regel-ID für das Audit.
 *
 * Verbindliche Reihenfolge:
 *  1. harte Grenze / unbekanntes Tool / deaktiviertes Tool → deny
 *  2. passende Deny-Regel (global oder Workspace) → deny
 *  3. Modus `ask-all` → ask (auch bei Lesetools, ignoriert Freigaben)
 *  4. Modus `auto` → allow
 *  5. Modus `smart` → gültige Sitzungsfreigabe oder deckende Allow-Regel → allow,
 *     sonst Grundmatrix
 */
'use strict';

const {
  TOOL_RISK_CLASSES,
  TOOL_RISK_CLASS_ORDER,
  TOOL_PERMISSION_MODES,
  POLICY_DECISIONS,
  PERMISSION_DECISION_SOURCES,
  PERMISSION_DENIAL_REASONS,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERSISTENT_ALLOW_CLASSES,
  normalizeToolPermissionMode,
  normalizeRiskClasses,
} = require('../../shared/contracts/tool-permissions');
const { matchesPathPattern } = require('../../shared/runtime/path-pattern');

/** Grundmatrix ohne gemerkte Entscheidungen (Konzept §3). */
const POLICY_MATRIX = Object.freeze({
  [TOOL_PERMISSION_MODES.SMART]: Object.freeze({
    [TOOL_RISK_CLASSES.READ]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.READ_SENSITIVE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.WRITE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.DELETE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.EXECUTE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.EXTERNAL]: POLICY_DECISIONS.ASK,
  }),
  [TOOL_PERMISSION_MODES.ASK_ALL]: Object.freeze({
    [TOOL_RISK_CLASSES.READ]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.READ_SENSITIVE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.WRITE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.DELETE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.EXECUTE]: POLICY_DECISIONS.ASK,
    [TOOL_RISK_CLASSES.EXTERNAL]: POLICY_DECISIONS.ASK,
  }),
  [TOOL_PERMISSION_MODES.AUTO]: Object.freeze({
    [TOOL_RISK_CLASSES.READ]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.READ_SENSITIVE]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.WRITE]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.DELETE]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.EXECUTE]: POLICY_DECISIONS.ALLOW,
    [TOOL_RISK_CLASSES.EXTERNAL]: POLICY_DECISIONS.ALLOW,
  }),
});

/** Matrixzelle für genau eine Klasse. */
function matrixDecision(mode, riskClass) {
  const row = POLICY_MATRIX[normalizeToolPermissionMode(mode)];
  return row[riskClass] || POLICY_DECISIONS.ASK;
}

/**
 * Matrixentscheidung für mehrere Wirkungen: jede Teilwirkung muss erlaubt
 * sein, sonst wird gefragt (Konzept §2).
 */
function matrixDecisionForClasses(mode, riskClasses) {
  const classes = normalizeRiskClasses(riskClasses);
  if (!classes || classes.length === 0) return POLICY_DECISIONS.ASK;
  return classes.every((cls) => matrixDecision(mode, cls) === POLICY_DECISIONS.ALLOW)
    ? POLICY_DECISIONS.ALLOW
    : POLICY_DECISIONS.ASK;
}

/** Klassen, für die im Modus gefragt würde — Grundlage der Karte. */
function classesRequiringAsk(mode, riskClasses) {
  const classes = normalizeRiskClasses(riskClasses) || [];
  return classes.filter((cls) => matrixDecision(mode, cls) !== POLICY_DECISIONS.ALLOW);
}

/**
 * Globale Regeln plus Workspace-Regeln der kanonischen Wurzel. Gleichnamige
 * Ordner an anderer Stelle teilen keine Regeln (Konzept §7).
 */
function selectRulesForRoot(rules, root) {
  if (!Array.isArray(rules)) return [];
  return rules.filter(
    (rule) =>
      rule &&
      (rule.scope === PERMISSION_RULE_SCOPES.GLOBAL ||
        (rule.scope === PERMISSION_RULE_SCOPES.WORKSPACE && typeof root === 'string' && rule.root === root))
  );
}

function targetPaths(targets) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => (typeof target === 'string' ? target : target?.path))
    .filter((p) => typeof p === 'string');
}

function ruleNamesCall(rule, toolName, riskClasses) {
  if (rule.tool) return rule.tool === toolName;
  return riskClasses.includes(rule.riskClass);
}

/**
 * Eine Sperre greift, wenn Tool oder Klasse passen und mindestens ein Ziel
 * dem Pfadmuster entspricht. Ohne Ziele (z. B. debug_wait) greift nur ein
 * Muster für „alles“.
 */
function denyRuleMatches(rule, { toolName, riskClasses, paths }) {
  if (!ruleNamesCall(rule, toolName, riskClasses)) return false;
  if (paths.length === 0) return rule.pathPattern === '**';
  return paths.some((p) => matchesPathPattern(rule.pathPattern, p));
}

/**
 * Allow-Regeln decken einen Aufruf nur vollständig: jede Klasse muss durch
 * eine Regel erlaubt sein, die alle Ziele einschließt, und die Klassen müssen
 * dauerhaft erlaubbar sein (read/write, Konzept §7).
 */
function allowRulesCover(rules, { toolName, riskClasses, paths }) {
  if (riskClasses.some((cls) => !PERSISTENT_ALLOW_CLASSES.includes(cls))) return null;
  const allowRules = rules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.ALLOW);
  if (allowRules.length === 0) return null;
  const matched = [];
  for (const cls of riskClasses) {
    const covering = allowRules.find(
      (rule) =>
        (rule.tool ? rule.tool === toolName : rule.riskClass === cls) &&
        (paths.length === 0
          ? rule.pathPattern === '**'
          : paths.every((p) => matchesPathPattern(rule.pathPattern, p)))
    );
    if (!covering) return null;
    if (!matched.includes(covering.id)) matched.push(covering.id);
  }
  return matched;
}

/**
 * @param {object} input
 * @param {string} input.mode
 * @param {string} input.toolName
 * @param {string[]} input.riskClasses  effektive Klassen des Aufrufs
 * @param {Array<{path: string}>} [input.targets]
 * @param {string|null} [input.root]  kanonische Workspace-Wurzel
 * @param {Array} [input.rules]  normalisierte Regeln (global + alle Workspaces)
 * @param {object|null} [input.sessionGrant]  passende, noch gültige Sitzungsfreigabe
 * @param {boolean} [input.toolDisabled]
 * @param {boolean} [input.unknownTool]
 * @param {{ reason?: string }|null} [input.hardLimit]
 */
function decideToolPolicy(input = {}) {
  const mode = normalizeToolPermissionMode(input.mode);
  const toolName = typeof input.toolName === 'string' ? input.toolName : '';
  const riskClasses = normalizeRiskClasses(input.riskClasses);

  if (input.unknownTool || !toolName) {
    return { decision: POLICY_DECISIONS.DENY, source: PERMISSION_DECISION_SOURCES.DENY, reason: PERMISSION_DENIAL_REASONS.UNKNOWN_TOOL, mode };
  }
  if (input.hardLimit) {
    return {
      decision: POLICY_DECISIONS.DENY,
      source: PERMISSION_DECISION_SOURCES.DENY,
      reason: input.hardLimit.reason || PERMISSION_DENIAL_REASONS.HARD_LIMIT,
      mode,
    };
  }
  if (input.toolDisabled) {
    return { decision: POLICY_DECISIONS.DENY, source: PERMISSION_DECISION_SOURCES.DENY, reason: PERMISSION_DENIAL_REASONS.TOOL_DISABLED, mode };
  }
  // Fehlende oder ungültige Klasse: blockieren, kein impliziter read-Default.
  if (!riskClasses || riskClasses.length === 0) {
    return { decision: POLICY_DECISIONS.DENY, source: PERMISSION_DECISION_SOURCES.DENY, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, mode };
  }

  const paths = targetPaths(input.targets);
  const rules = selectRulesForRoot(input.rules, input.root ?? null);
  const call = { toolName, riskClasses, paths };

  const deny = rules.find((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY && denyRuleMatches(rule, call));
  if (deny) {
    return {
      decision: POLICY_DECISIONS.DENY,
      source: PERMISSION_DECISION_SOURCES.DENY,
      reason: PERMISSION_DENIAL_REASONS.POLICY_DENIED,
      ruleId: deny.id,
      mode,
    };
  }

  if (mode === TOOL_PERMISSION_MODES.ASK_ALL) {
    return { decision: POLICY_DECISIONS.ASK, mode, askClasses: [...riskClasses] };
  }
  if (mode === TOOL_PERMISSION_MODES.AUTO) {
    return { decision: POLICY_DECISIONS.ALLOW, source: PERMISSION_DECISION_SOURCES.AUTO, mode };
  }

  if (input.sessionGrant) {
    return {
      decision: POLICY_DECISIONS.ALLOW,
      source: PERMISSION_DECISION_SOURCES.ALLOW_SESSION,
      grantId: input.sessionGrant.id,
      mode,
    };
  }
  const covering = allowRulesCover(rules, call);
  if (covering) {
    return {
      decision: POLICY_DECISIONS.ALLOW,
      source: PERMISSION_DECISION_SOURCES.ALLOW_RULE,
      ruleId: covering[0],
      ruleIds: covering,
      mode,
    };
  }

  const matrix = matrixDecisionForClasses(mode, riskClasses);
  if (matrix === POLICY_DECISIONS.ALLOW) {
    return { decision: POLICY_DECISIONS.ALLOW, source: PERMISSION_DECISION_SOURCES.AUTO, mode };
  }
  return { decision: POLICY_DECISIONS.ASK, mode, askClasses: classesRequiringAsk(mode, riskClasses) };
}

module.exports = {
  POLICY_MATRIX,
  TOOL_RISK_CLASS_ORDER,
  matrixDecision,
  matrixDecisionForClasses,
  classesRequiringAsk,
  selectRulesForRoot,
  decideToolPolicy,
};
