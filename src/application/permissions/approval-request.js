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
  normalizeRiskClasses,
} = require('../../shared/contracts/tool-permissions');

const MODE_LABELS = Object.freeze({
  [TOOL_PERMISSION_MODES.SMART]: 'Intelligent',
  [TOOL_PERMISSION_MODES.ASK_ALL]: 'Immer fragen',
  [TOOL_PERMISSION_MODES.AUTO]: 'Auto',
});

const CLASS_LABELS = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: 'Lesen',
  [TOOL_RISK_CLASSES.READ_SENSITIVE]: 'Sensible Daten lesen',
  [TOOL_RISK_CLASSES.WRITE]: 'Ändern',
  [TOOL_RISK_CLASSES.DELETE]: 'Überschreiben ohne Rückweg',
  [TOOL_RISK_CLASSES.EXECUTE]: 'Ausführen',
  [TOOL_RISK_CLASSES.EXTERNAL]: 'Externer Dienst',
});

function modeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS[TOOL_PERMISSION_MODES.SMART];
}

/**
 * Begründung für die Karte. `checkpoint` ist 'access' (vor dem Handler) oder
 * 'output' (Inhalt wurde lokal als sensibel erkannt und zurückgehalten).
 */
function describeApprovalReason({ mode, askClasses, providerLabel, recovery, checkpoint = 'access' } = {}) {
  const classes = normalizeRiskClasses(askClasses) || [];
  const parts = [];
  if (mode === TOOL_PERMISSION_MODES.ASK_ALL) {
    parts.push('Der Modus „Immer fragen“ fragt bei jedem Tool-Aufruf.');
  }
  if (classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
    const provider = providerLabel || 'den gewählten Provider';
    parts.push(
      checkpoint === 'output'
        ? `Der gelesene Inhalt enthält offenbar Zugangsdaten und wurde zurückgehalten. Nach Freigabe wird er an ${provider} übermittelt.`
        : `Diese Datei kann Zugangsdaten enthalten. Der freigegebene Inhalt wird an ${provider} übermittelt.`
    );
  }
  if (classes.includes(TOOL_RISK_CLASSES.DELETE)) {
    parts.push(
      'Die bestehende Datei wird vollständig überschrieben, ohne dass eine Wiederherstellungskopie angelegt werden konnte.'
    );
  } else if (classes.includes(TOOL_RISK_CLASSES.WRITE) && mode !== TOOL_PERMISSION_MODES.ASK_ALL) {
    parts.push(`Im Modus „${modeLabel(mode)}“ benötigen Dateiänderungen eine Freigabe.`);
  }
  if (recovery === 'trash') {
    parts.push('Die bisherige Fassung wird vorher als Kopie in den Papierkorb gelegt.');
  }
  if (classes.includes(TOOL_RISK_CLASSES.EXECUTE)) {
    parts.push('Das Tool führt ein Programm aus.');
  }
  if (classes.includes(TOOL_RISK_CLASSES.EXTERNAL)) {
    parts.push('Das Tool sendet Daten an einen externen Dienst.');
  }
  if (parts.length === 0) {
    parts.push(`Im Modus „${modeLabel(mode)}“ benötigt dieser Aufruf eine Freigabe.`);
  }
  return parts.join(' ');
}

/** Umfang einer Sitzungsfreigabe in Worten (Konzept §6). */
function describeSessionScope({ tool, targets, riskClasses } = {}) {
  const classes = (normalizeRiskClasses(riskClasses) || []).map((cls) => CLASS_LABELS[cls] || cls);
  const paths = (Array.isArray(targets) ? targets : [])
    .map((target) => (typeof target === 'string' ? target : target?.path))
    .filter((p) => typeof p === 'string' && p);
  const targetText = paths.length > 0 ? paths.join(', ') : 'ohne Dateiziel';
  return `Gilt in dieser Sitzung für ${tool} auf genau ${targetText} (${classes.join(', ') || 'Lesen'}).`;
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
    reason: describeApprovalReason({
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
    request.sessionScopeLabel = describeSessionScope({ tool, targets, riskClasses: classes });
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
  MODE_LABELS,
  CLASS_LABELS,
  modeLabel,
  describeApprovalReason,
  describeSessionScope,
  buildApprovalRequest,
};
