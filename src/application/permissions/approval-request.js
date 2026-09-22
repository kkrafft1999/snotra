/**
 * Baut aus einem validierten Plan die Freigabe-Anfrage für den Approval-Port
 * (Issue #66, Konzept §6). Texte sind Daten für die Karte; Pfade und
 * Vorschauen stammen aus demselben Plan, der später ausgeführt wird — nie
 * aus einer freien Beschreibung des Modells.
 */
'use strict';

const {
  TOOL_RISK_CLASSES,
  TOOL_PERMISSION_MODES,
  SESSION_GRANTABLE_CLASSES,
  TOOL_PERMISSION_MODE_LABEL_KEYS,
  TOOL_RISK_CLASS_LABEL_KEYS,
  normalizeRiskClasses,
} = require('../../shared/contracts/tool-permissions');
const { createMessage } = require('../../shared/contracts/message');

// Die Schluessel kommen aus den Contracts, damit Karte, Chat-Pille und
// Einstellungen (#67) denselben Wortlaut zeigen — gesprochen wird er dort, wo
// er auf dem Schirm steht (#290).
const MODE_KEYS = TOOL_PERMISSION_MODE_LABEL_KEYS;
const CLASS_KEYS = TOOL_RISK_CLASS_LABEL_KEYS;

function modeLabelKey(mode) {
  return MODE_KEYS[mode] || MODE_KEYS[TOOL_PERMISSION_MODES.SMART];
}

/**
 * Begründung für die Karte, als Liste von Katalogschluesseln (#290).
 * `checkpoint` ist 'access' (vor dem Handler) oder 'output' (Inhalt wurde
 * lokal als sensibel erkannt und zurueckgehalten).
 *
 * Die Begruendung entsteht im Hauptprozess und wird im Renderer gelesen, wo
 * die aktive Sprache lebt — also reist der Schluessel, nicht der Satz (#293).
 * Der Modusname ist selbst ein Schluessel und wird beim Anzeigen eingesetzt.
 */
function describeApprovalReason({ mode, askClasses, providerLabel, recovery, checkpoint = 'access' } = {}) {
  const classes = normalizeRiskClasses(askClasses) || [];
  const parts = [];
  if (mode === TOOL_PERMISSION_MODES.ASK_ALL) {
    parts.push(createMessage('approval.reason.askAll'));
  }
  if (classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
    parts.push(providerLabel
      ? createMessage(checkpoint === 'output'
        ? 'approval.reason.sensitiveOutput'
        : 'approval.reason.sensitiveAccess', { provider: providerLabel })
      : createMessage(checkpoint === 'output'
        ? 'approval.reason.sensitiveOutput.plain'
        : 'approval.reason.sensitiveAccess.plain'));
  }
  if (classes.includes(TOOL_RISK_CLASSES.DELETE)) {
    parts.push(createMessage('approval.reason.delete'));
  } else if (classes.includes(TOOL_RISK_CLASSES.WRITE) && mode !== TOOL_PERMISSION_MODES.ASK_ALL) {
    parts.push(createMessage('approval.reason.write', { modeKey: modeLabelKey(mode) }));
  }
  if (recovery === 'trash') {
    parts.push(createMessage('approval.reason.trash'));
  }
  if (classes.includes(TOOL_RISK_CLASSES.EXECUTE)) {
    parts.push(createMessage('approval.reason.execute'));
  }
  if (classes.includes(TOOL_RISK_CLASSES.EXTERNAL)) {
    parts.push(createMessage('approval.reason.external'));
  }
  if (parts.length === 0) {
    parts.push(createMessage('approval.reason.generic', { modeKey: modeLabelKey(mode) }));
  }
  return parts;
}

/**
 * Umfang einer Sitzungsfreigabe in Worten (Konzept §6) — als Schluessel mit
 * seinen Werten (#290). Die Klassen reisen als Schluesselliste mit, damit auch
 * „Ändern" in der Sprache steht, in der die Karte gerade gelesen wird.
 */
function describeSessionScope({ tool, targets, riskClasses } = {}) {
  const classKeys = (normalizeRiskClasses(riskClasses) || []).map((cls) => CLASS_KEYS[cls]).filter(Boolean);
  const paths = (Array.isArray(targets) ? targets : [])
    .map((target) => (typeof target === 'string' ? target : target?.path))
    .filter((p) => typeof p === 'string' && p);
  const effectKeys = classKeys.length > 0 ? classKeys : [CLASS_KEYS[TOOL_RISK_CLASSES.READ]];
  // Ohne Pfade ergäbe „auf genau ohne Dateiziel“ keinen Satz. Den Fall gibt es
  // bei `shell_execute` (#102) und beim Merken (#166): Dort hängt die Freigabe
  // am Tool, nicht an einem Ziel — und genau das soll dastehen.
  return paths.length === 0
    ? createMessage('approval.sessionScope.anyCall', { tool, effectKeys })
    : createMessage('approval.sessionScope.targets', { tool, paths: paths.join(', '), effectKeys });
}

/**
 * Freigabe-Anfrage aus Plan und Policy-Ergebnis. `sessionAllowed` ist nur
 * wahr, wenn alle abgefragten Klassen sitzungsweise freigebbar sind und der
 * Modus Freigaben überhaupt berücksichtigt (nicht `ask-all`).
 */
function buildApprovalRequest({
  tool,
  plan,
  askClasses,
  mode,
  providerKey,
  providerLabel,
  policyVersion,
  chatId,
  checkpoint = 'access',
} = {}) {
  const classes = normalizeRiskClasses(askClasses) || normalizeRiskClasses(plan?.riskClasses) || [];
  const sessionAllowed =
    mode !== TOOL_PERMISSION_MODES.ASK_ALL &&
    classes.length > 0 &&
    classes.every((cls) => SESSION_GRANTABLE_CLASSES.includes(cls));
  const targets = Array.isArray(plan?.targets) ? plan.targets : [];
  const request = {
    tool,
    riskClasses: classes,
    targets: targets.map((target) => ({
      path: target.path,
      kind: target.kind,
      exists: target.exists === true,
      sensitive: target.sensitive === true,
      sensitiveReason: target.sensitiveReason,
      version: target.version ?? null,
      recovery: target.recovery,
    })),
    reasonParts: describeApprovalReason({
      mode,
      askClasses: classes,
      providerLabel,
      recovery: plan?.recovery,
      checkpoint,
    }),
    mode,
    sessionAllowed,
    planKey: typeof plan?.planKey === 'string' ? plan.planKey : '',
    policyVersion: typeof policyVersion === 'string' ? policyVersion : '',
    checkpoint,
  };
  if (sessionAllowed) {
    request.sessionScope = describeSessionScope({ tool, targets, riskClasses: classes });
  }
  if (classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
    request.providerLabel = providerLabel || providerKey || '';
    request.providerKey = providerKey || '';
  }
  if (plan?.preview && typeof plan.preview.text === 'string') {
    request.preview = plan.preview;
  }
  if (typeof chatId === 'string' && chatId) request.chatId = chatId;
  return request;
}

module.exports = {
  MODE_KEYS,
  CLASS_KEYS,
  modeLabelKey,
  describeApprovalReason,
  describeSessionScope,
  buildApprovalRequest,
};
