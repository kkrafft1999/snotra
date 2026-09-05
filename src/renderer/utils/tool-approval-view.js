/**
 * Freigabe-Oberfläche (Issue #67, Konzept §3/§6/§7): reine Text- und
 * Zustandslogik für die Bestätigungskarte im Chat, die Modus-Wahl, das
 * Audit in der Tool-Zeile und die Regelverwaltung. Bewusst ohne DOM, damit
 * sie mit `node:test` prüfbar ist; das Rendern übernehmen die Components.
 *
 * Der Renderer trifft hier keine Rechteentscheidung: Alles, was angezeigt
 * wird, stammt aus dem validierten DTO des Main-Prozesses. Diese Funktionen
 * übersetzen nur in Wortlaut und Anzeige-Zustände.
 */
import contracts from '../generated/contracts.js';

const {
  TOOL_PERMISSION_MODES,
  TOOL_PERMISSION_MODE_LABELS,
  TOOL_RISK_CLASSES,
  TOOL_RISK_CLASS_LABELS,
  APPROVAL_RESPONSES,
  PERMISSION_DENIAL_REASONS,
  PERMISSION_DENIED_MESSAGES,
  TOOL_EXECUTION_STATUSES,
  POLICY_DECISIONS,
  PERMISSION_DECISION_SOURCES,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERSISTENT_ALLOW_CLASSES,
  TOOL_RISK_CLASS_ORDER,
  isToolApprovalRequestDto,
  normalizeRulePathPattern,
} = contracts;

/** Reihenfolge und Beschreibung der Modi für Chat-Pille und Einstellungen (Konzept §3). */
export const TOOL_MODE_OPTIONS = Object.freeze([
  {
    value: TOOL_PERMISSION_MODES.SMART,
    label: TOOL_PERMISSION_MODE_LABELS[TOOL_PERMISSION_MODES.SMART],
    description: 'Lesen läuft ohne Rückfrage. Dateiänderungen und sensible Dateien fragen nach. Standard.',
  },
  {
    value: TOOL_PERMISSION_MODES.ASK_ALL,
    label: TOOL_PERMISSION_MODE_LABELS[TOOL_PERMISSION_MODES.ASK_ALL],
    description: 'Jeder Tool-Aufruf fragt nach, auch Lesen. Gemerkte Erlaubnisse gelten nicht.',
  },
  {
    value: TOOL_PERMISSION_MODES.AUTO,
    label: TOOL_PERMISSION_MODE_LABELS[TOOL_PERMISSION_MODES.AUTO],
    description: 'Keine Rückfragen zu Tool-Aufrufen. Workspace-Grenzen, Sperren und der Schutz der Snotra-Schlüssel bleiben. Bewusst zu aktivieren.',
  },
]);

/** Klassen, für die es keine Sitzungsfreigabe gibt (Konzept §6). */
const SINGLE_DECISION_CLASSES = Object.freeze([
  TOOL_RISK_CLASSES.DELETE,
  TOOL_RISK_CLASSES.EXECUTE,
  TOOL_RISK_CLASSES.EXTERNAL,
]);

export function modeLabel(mode) {
  return TOOL_PERMISSION_MODE_LABELS[mode] || TOOL_PERMISSION_MODE_LABELS[TOOL_PERMISSION_MODES.SMART];
}

export function riskClassLabel(riskClass) {
  return TOOL_RISK_CLASS_LABELS[riskClass] || String(riskClass ?? '');
}

const TARGET_KIND_LABELS = Object.freeze({
  file: 'Datei',
  directory: 'Ordner',
  tree: 'Ordnerbaum',
});

const PREVIEW_KIND_LABELS = Object.freeze({
  text: 'Neuer Inhalt',
  replace: 'Ersetzung (alt → neu)',
  diff: 'Patch',
});

function hasClass(classes, riskClass) {
  return Array.isArray(classes) && classes.includes(riskClass);
}

/** Titel der Karte (Konzept §6): Änderung, Ausführung, externer Zugriff oder Dateizugriff. */
export function approvalCardTitle(riskClasses) {
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.EXECUTE)) return 'Ausführung bestätigen';
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.EXTERNAL)) return 'Externen Zugriff bestätigen';
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.WRITE) || hasClass(riskClasses, TOOL_RISK_CLASSES.DELETE)) {
    return 'Änderung bestätigen';
  }
  return 'Dateizugriff bestätigen';
}

/**
 * Kopfzeile „Snotra möchte ‹Ziel› ‹Verb› (‹Tool›).“ – als Teile, damit die
 * Component Pfad und Tool-Name als Code rendern kann.
 */
export function approvalHeadline(dto) {
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  const targets = Array.isArray(dto?.targets) ? dto.targets : [];
  let verb = 'lesen';
  if (hasClass(classes, TOOL_RISK_CLASSES.EXTERNAL)) verb = 'an einen externen Dienst senden';
  else if (hasClass(classes, TOOL_RISK_CLASSES.EXECUTE)) verb = 'ausführen';
  else if (hasClass(classes, TOOL_RISK_CLASSES.DELETE)) verb = 'ohne Rückweg überschreiben';
  else if (hasClass(classes, TOOL_RISK_CLASSES.WRITE)) {
    verb = targets.length > 0 && targets.every((t) => t.exists !== true) ? 'anlegen' : 'ändern';
  }
  let targetLabel = '';
  if (targets.length === 1) targetLabel = targets[0].path || '';
  else if (targets.length > 1) targetLabel = `${targets.length} Ziele`;
  return {
    targetLabel,
    verb,
    tool: typeof dto?.tool === 'string' ? dto.tool : '',
    text: targetLabel
      ? `Snotra möchte ${targetLabel} ${verb} (${dto?.tool || 'Tool'}).`
      : `Snotra möchte ${verb} (${dto?.tool || 'Tool'}).`,
  };
}

function describeTarget(target) {
  const out = {
    path: typeof target?.path === 'string' ? target.path : '',
    kindLabel: TARGET_KIND_LABELS[target?.kind] || TARGET_KIND_LABELS.file,
    exists: target?.exists === true,
    sensitive: target?.sensitive === true,
    notes: [],
  };
  if (out.sensitive) {
    out.notes.push(target.sensitiveReason ? `sensibel (${target.sensitiveReason})` : 'sensibel');
  }
  if (typeof target?.version === 'string' && target.version) {
    out.version = target.version;
    out.notes.push(`Stand ${target.version}`);
  }
  if (target?.kind === 'file' && !out.exists) out.notes.push('neu');
  if (target?.recovery === 'trash') out.notes.push('Kopie in den Papierkorb');
  return out;
}

/** Hinweis, warum „Für diese Sitzung erlauben“ (nicht) angeboten wird (Konzept §6). */
export function sessionActionHint(dto) {
  if (dto?.sessionAllowed === true) return '';
  if (dto?.mode === TOOL_PERMISSION_MODES.ASK_ALL) return 'Dieser Modus fragt bei jedem Aufruf.';
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  const single = classes.filter((cls) => SINGLE_DECISION_CLASSES.includes(cls));
  if (single.length > 0) {
    return `Für „${single.map(riskClassLabel).join('“, „')}“ ist nur eine Einzelentscheidung möglich.`;
  }
  return 'Für diesen Aufruf ist nur eine Einzelentscheidung möglich.';
}

/** Warnung beim Überschreiben (Konzept §6): mit oder ohne Rückweg. */
export function overwriteWarning(dto) {
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  const targets = Array.isArray(dto?.targets) ? dto.targets : [];
  const existing = targets.filter((t) => t.exists === true && (t.kind === 'file' || !t.kind));
  if (hasClass(classes, TOOL_RISK_CLASSES.DELETE)) {
    return 'Die bestehende Datei wird vollständig überschrieben – ohne Wiederherstellungskopie. Das lässt sich nicht rückgängig machen.';
  }
  if (dto?.tool === 'write_file_text' && existing.length > 0) {
    return existing.some((t) => t.recovery === 'trash')
      ? 'Die bestehende Datei wird vollständig überschrieben. Die bisherige Fassung landet vorher als Kopie im Papierkorb.'
      : 'Die bestehende Datei wird vollständig überschrieben.';
  }
  return '';
}

/**
 * Vollständiges Anzeige-Modell der Karte aus dem DTO. Liefert null für
 * ungültige DTOs – dann wird nichts angezeigt und nichts beantwortet.
 */
export function buildApprovalCardView(dto) {
  if (!isToolApprovalRequestDto(dto)) return null;
  const classes = dto.riskClasses.filter((cls) => TOOL_RISK_CLASS_ORDER.includes(cls));
  const targets = dto.targets.map(describeTarget);
  const sensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE) || targets.some((t) => t.sensitive);
  const view = {
    requestId: dto.requestId,
    tool: dto.tool,
    mode: dto.mode,
    modeLabel: modeLabel(dto.mode),
    title: approvalCardTitle(classes),
    headline: approvalHeadline(dto),
    classes: classes.map((value) => ({ value, label: riskClassLabel(value) })),
    classText: classes.map(riskClassLabel).join(', ') || riskClassLabel(TOOL_RISK_CLASSES.READ),
    targets,
    reason: typeof dto.reason === 'string' ? dto.reason : '',
    sensitive,
    providerLabel: typeof dto.providerLabel === 'string' ? dto.providerLabel : '',
    warning: overwriteWarning(dto),
    preview: null,
    actions: {
      once: { response: APPROVAL_RESPONSES.ALLOW_ONCE, label: 'Einmal erlauben', enabled: true },
      session: {
        response: APPROVAL_RESPONSES.ALLOW_SESSION,
        label: 'Für diese Sitzung erlauben',
        enabled: dto.sessionAllowed === true,
        hint: sessionActionHint(dto),
      },
      deny: { response: APPROVAL_RESPONSES.DENY, label: 'Ablehnen', enabled: true },
    },
    scopeNote: '',
  };
  if (dto.sessionAllowed === true) {
    const parts = [];
    if (typeof dto.sessionScopeLabel === 'string' && dto.sessionScopeLabel) parts.push(dto.sessionScopeLabel);
    if (classes.includes(TOOL_RISK_CLASSES.WRITE)) {
      parts.push('Weitere Änderungen an genau diesen Zielen laufen dann ohne Rückfrage.');
    }
    if (classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
      parts.push('Gilt nur für diesen Dateistand und den gewählten Provider.');
    }
    view.scopeNote = parts.join(' ');
  }
  if (dto.preview && typeof dto.preview.text === 'string') {
    const kind = PREVIEW_KIND_LABELS[dto.preview.kind] ? dto.preview.kind : 'text';
    const notes = [];
    if (dto.preview.truncated === true) notes.push('gekürzt');
    if (dto.preview.masked === true) notes.push('Geheimnisse maskiert');
    view.preview = {
      kind,
      kindLabel: PREVIEW_KIND_LABELS[kind],
      text: dto.preview.text,
      truncated: dto.preview.truncated === true,
      masked: dto.preview.masked === true,
      summary: notes.length > 0 ? `Vorschau: ${PREVIEW_KIND_LABELS[kind]} (${notes.join(', ')})` : `Vorschau: ${PREVIEW_KIND_LABELS[kind]}`,
      truncatedNote: dto.preview.truncated === true
        ? 'Der Kern überträgt nur den Anfang der Vorschau. Ausgeführt wird der vollständige, geprüfte Plan.'
        : '',
      maskedNote: dto.preview.masked === true
        ? 'Erkannte Zugangsdaten sind in der Vorschau maskiert und bleiben es auch aufgeklappt.'
        : '',
    };
  }
  return view;
}

/**
 * Ergebnis einer Karte in Worten (Konzept §6): Entscheidung, Verfall oder
 * Abbruch – getrennt vom Ausführungserfolg, den die Tool-Zeile zeigt.
 */
export function describeApprovalOutcome({ response, invalidated, reason, aborted } = {}) {
  if (aborted === true) {
    return { status: 'cancelled', label: 'Lauf abgebrochen', detail: 'Der Aufruf wurde nicht ausgeführt.' };
  }
  if (invalidated === true) {
    const detail = PERMISSION_DENIED_MESSAGES[reason] || PERMISSION_DENIED_MESSAGES[PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED];
    return { status: 'invalidated', label: 'Anfrage verfallen', detail: `${detail} Der Lauf ist beendet.` };
  }
  if (response === APPROVAL_RESPONSES.DENY) {
    return {
      status: 'denied',
      label: 'Abgelehnt',
      detail: `Das Modell erhält: „${PERMISSION_DENIED_MESSAGES[PERMISSION_DENIAL_REASONS.USER_DENIED]}“.`,
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_SESSION) {
    return {
      status: 'allowed',
      label: 'Für diese Sitzung erlaubt',
      detail: 'Gilt für genau dieses Tool und diese Ziele, bis Chat, Workspace, Modus oder Regeln wechseln. Ob der Aufruf gelang, zeigt die Tool-Zeile.',
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_ONCE) {
    return { status: 'allowed', label: 'Einmal erlaubt', detail: 'Ob der Aufruf gelang, zeigt die Tool-Zeile.' };
  }
  return { status: 'invalidated', label: 'Anfrage verfallen', detail: 'Der Lauf ist beendet.' };
}

const DECISION_LABELS = Object.freeze({
  [POLICY_DECISIONS.ALLOW]: 'Erlaubt',
  [POLICY_DECISIONS.ASK]: 'Rückfrage',
  [POLICY_DECISIONS.DENY]: 'Abgelehnt',
});

const SOURCE_LABELS = Object.freeze({
  [PERMISSION_DECISION_SOURCES.AUTO]: 'Modus Auto',
  [PERMISSION_DECISION_SOURCES.ALLOW_ONCE]: 'einmal erlaubt',
  [PERMISSION_DECISION_SOURCES.ALLOW_SESSION]: 'Sitzungsfreigabe',
  [PERMISSION_DECISION_SOURCES.ALLOW_RULE]: 'Erlaubnis-Regel',
  [PERMISSION_DECISION_SOURCES.DENY]: 'abgelehnt',
});

const STATUS_LABELS = Object.freeze({
  [TOOL_EXECUTION_STATUSES.AWAITING_APPROVAL]: 'wartet auf Freigabe',
  [TOOL_EXECUTION_STATUSES.EXECUTED]: 'ausgeführt',
  [TOOL_EXECUTION_STATUSES.FAILED]: 'fehlgeschlagen',
  [TOOL_EXECUTION_STATUSES.DENIED]: 'nicht ausgeführt',
  [TOOL_EXECUTION_STATUSES.CANCELLED]: 'abgebrochen',
});

/**
 * Bereinigtes Audit einer Tool-Zeile (Konzept §9) als Tooltip-Text:
 * Entscheidung, Quelle, Klasse, Ausführungsstatus, Grund. Leer, wenn der
 * Eintrag (Alt-Session) kein Audit trägt.
 */
export function describePermissionAudit(permission) {
  if (!permission || typeof permission !== 'object') return '';
  const parts = [];
  const decision = DECISION_LABELS[permission.decision];
  if (decision) {
    const source = SOURCE_LABELS[permission.source];
    parts.push(`Entscheidung: ${decision}${source && permission.source !== PERMISSION_DECISION_SOURCES.DENY ? ` (${source})` : ''}`);
  }
  if (Array.isArray(permission.riskClasses) && permission.riskClasses.length > 0) {
    parts.push(`Klasse: ${permission.riskClasses.map(riskClassLabel).join(', ')}`);
  }
  if (STATUS_LABELS[permission.status]) parts.push(`Status: ${STATUS_LABELS[permission.status]}`);
  if (permission.reason && PERMISSION_DENIED_MESSAGES[permission.reason]) {
    parts.push(`Grund: ${PERMISSION_DENIED_MESSAGES[permission.reason]}`);
  }
  if (permission.ruleId) parts.push(`Regel: ${permission.ruleId}`);
  if (permission.mode) parts.push(`Modus: ${modeLabel(permission.mode)}`);
  if (permission.sensitive === true) parts.push('Sensibler Inhalt zurückgehalten');
  return parts.join(' · ');
}

/** Kurzform des Audits für die Tool-Zeile (data-Attribut / Screenreader). */
export function permissionStatusKey(permission) {
  if (!permission || typeof permission !== 'object') return '';
  if (permission.status === TOOL_EXECUTION_STATUSES.AWAITING_APPROVAL) return 'awaiting';
  if (permission.status === TOOL_EXECUTION_STATUSES.DENIED || permission.decision === POLICY_DECISIONS.DENY) return 'denied';
  if (permission.status === TOOL_EXECUTION_STATUSES.FAILED) return 'failed';
  if (permission.status === TOOL_EXECUTION_STATUSES.CANCELLED) return 'cancelled';
  return 'allowed';
}

// ── Regelverwaltung (Konzept §7) ─────────────────────────────────────────────

export const RULE_EFFECT_OPTIONS = Object.freeze([
  { value: PERMISSION_RULE_EFFECTS.DENY, label: 'Sperren', description: 'Der Aufruf wird in jedem Modus blockiert. Sperren gewinnen immer.' },
  { value: PERMISSION_RULE_EFFECTS.ALLOW, label: 'Erlauben', description: 'Keine Rückfrage im Modus „Intelligent“. Nur für Lesen und Ändern; verlangt eine Bestätigung im Systemdialog.' },
]);

export const RULE_SCOPE_OPTIONS = Object.freeze([
  { value: PERMISSION_RULE_SCOPES.WORKSPACE, label: 'Dieser Workspace' },
  { value: PERMISSION_RULE_SCOPES.GLOBAL, label: 'Alle Workspaces' },
]);

/** Klassen, die als Regelgegenstand wählbar sind – bei Erlauben nur read/write. */
export function ruleClassOptions(effect) {
  const classes = effect === PERMISSION_RULE_EFFECTS.ALLOW ? PERSISTENT_ALLOW_CLASSES : TOOL_RISK_CLASS_ORDER;
  return classes.map((value) => ({ value, label: riskClassLabel(value) }));
}

export function describeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const effectLabel = rule.effect === PERMISSION_RULE_EFFECTS.ALLOW ? 'Erlaubnis' : 'Sperre';
  const subject = rule.tool ? `Tool ${rule.tool}` : `Klasse ${riskClassLabel(rule.riskClass)}`;
  const pattern = rule.pathPattern || '**';
  const scopeLabel = rule.scope === PERMISSION_RULE_SCOPES.GLOBAL ? 'Alle Workspaces' : 'Dieser Workspace';
  return {
    id: rule.id,
    effect: rule.effect,
    effectLabel,
    subject,
    pattern,
    patternLabel: pattern === '**' ? 'alle Pfade' : pattern,
    scopeLabel,
    text: `${effectLabel}: ${subject} auf ${pattern === '**' ? 'alle Pfade' : pattern} (${scopeLabel})`,
  };
}

/**
 * Prüft einen Regel-Entwurf aus dem Formular und formt ihn zur IPC-Regel.
 * Der Main validiert erneut; diese Prüfung liefert nur verständliche
 * Fehlermeldungen, bevor der Systemdialog erscheint.
 */
export function validateRuleDraft({ effect, scope, subjectType, tool, riskClass, pathPattern, hasWorkspace } = {}) {
  if (effect !== PERMISSION_RULE_EFFECTS.ALLOW && effect !== PERMISSION_RULE_EFFECTS.DENY) {
    return { ok: false, error: 'Wirkung wählen (Sperren oder Erlauben).' };
  }
  const ruleScope = scope === PERMISSION_RULE_SCOPES.GLOBAL ? PERMISSION_RULE_SCOPES.GLOBAL : PERMISSION_RULE_SCOPES.WORKSPACE;
  if (ruleScope === PERMISSION_RULE_SCOPES.WORKSPACE && hasWorkspace !== true) {
    return { ok: false, error: 'Kein Workspace geöffnet – wähle „Alle Workspaces“ oder öffne einen Ordner.' };
  }
  const rule = { effect, scope: ruleScope };
  if (subjectType === 'tool') {
    const name = typeof tool === 'string' ? tool.trim() : '';
    if (!name) return { ok: false, error: 'Tool wählen.' };
    rule.tool = name;
  } else {
    if (!TOOL_RISK_CLASS_ORDER.includes(riskClass)) return { ok: false, error: 'Klasse wählen.' };
    if (effect === PERMISSION_RULE_EFFECTS.ALLOW && !PERSISTENT_ALLOW_CLASSES.includes(riskClass)) {
      return { ok: false, error: 'Dauerhafte Erlaubnisse gibt es nur für „Lesen“ und „Ändern“.' };
    }
    rule.riskClass = riskClass;
  }
  const pattern = normalizeRulePathPattern(pathPattern);
  if (pattern === null) return { ok: false, error: 'Pfadmuster darf kein „..“ enthalten.' };
  rule.pathPattern = pattern;
  return { ok: true, rule };
}

/** Prüft ein sensibles Pfadmuster aus dem Formular (Konzept §4). */
export function validateSensitivePattern(raw, existing = []) {
  const pattern = normalizeRulePathPattern(raw);
  if (pattern === null) return { ok: false, error: 'Muster darf kein „..“ enthalten.' };
  if (!pattern || pattern === '**') return { ok: false, error: 'Ein Muster für alle Pfade ist nicht sinnvoll – nenne Ordner oder Dateinamen, z. B. „personal/**“.' };
  if (Array.isArray(existing) && existing.includes(pattern)) return { ok: false, error: 'Dieses Muster gibt es schon.' };
  return { ok: true, pattern };
}

/** Sichtbarer Umfang der Reset-Aktionen (Konzept §7). */
export const RESET_ACTIONS = Object.freeze([
  {
    key: 'session',
    label: 'Sitzungsfreigaben löschen',
    description: 'Vergisst alle „Für diese Sitzung erlauben“-Entscheidungen. Regeln und Modus bleiben.',
  },
  {
    key: 'workspace',
    label: 'Workspace-Regeln zurücksetzen',
    description: 'Löscht Sperren und Erlaubnisse, die nur für den geöffneten Workspace gelten. Globale Regeln, Muster und Modus bleiben.',
  },
  {
    key: 'all',
    label: 'Alle Berechtigungen zurücksetzen',
    description: 'Löscht alle Regeln, eigene sensible Pfadmuster und Sitzungsfreigaben und stellt den Modus „Intelligent“ wieder her.',
    confirm: true,
  },
]);

export function integrityWarning(integrity) {
  if (integrity === 'invalid') {
    return 'Die Berechtigungsdatei war beschädigt oder verändert. Snotra läuft im Modus „Intelligent“; Erlaubnisse wurden verworfen, Sperren bleiben wirksam.';
  }
  if (integrity === 'unsigned') {
    return 'Verschlüsselter Speicher ist nicht verfügbar. Modus „Auto“ und dauerhafte Erlaubnisse lassen sich deshalb nicht speichern.';
  }
  return '';
}

export const LEGACY_WRITE_MIGRATION_HINT =
  'Dateiänderungen fragen jetzt nach deiner Freigabe. Den Modus kannst du jederzeit im Chat ändern.';
