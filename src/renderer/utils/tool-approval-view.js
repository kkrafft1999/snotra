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
import { describeAllowanceOnCard } from './program-allowance-view.js';
import contracts from '../generated/contracts.js';
import { t, tMessage, tPlural } from '../i18n.js';

const {
  TOOL_PERMISSION_MODES,
  TOOL_RISK_CLASSES,
  APPROVAL_RESPONSES,
  PERMISSION_DENIAL_REASONS,
  PERMISSION_DENIED_MESSAGE_KEYS,
  TOOL_EXECUTION_STATUSES,
  POLICY_DECISIONS,
  PERMISSION_DECISION_SOURCES,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERSISTENT_ALLOW_CLASSES,
  TOOL_RISK_CLASS_ORDER,
  COMMAND_RULE_UNAVAILABLE_REASONS,
  isCommandRule,
  isToolApprovalRequestDto,
  normalizeRulePathPattern,
} = contracts;

/**
 * One key per mode (epic #277). Since the language switch the labels come from
 * the catalogue rather than from the contract — the contract remains the source
 * of the *values*, not of the words.
 */
const MODE_ORDER = Object.freeze([
  TOOL_PERMISSION_MODES.SMART,
  TOOL_PERMISSION_MODES.ASK_ALL,
  TOOL_PERMISSION_MODES.AUTO,
]);

const MODE_KEYS = Object.freeze({
  [TOOL_PERMISSION_MODES.SMART]: 'permissions.mode.smart',
  [TOOL_PERMISSION_MODES.ASK_ALL]: 'permissions.mode.askAll',
  [TOOL_PERMISSION_MODES.AUTO]: 'permissions.mode.auto',
});

const RISK_CLASS_KEYS = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: 'tools.riskClass.read',
  [TOOL_RISK_CLASSES.READ_SENSITIVE]: 'tools.riskClass.readSensitive',
  [TOOL_RISK_CLASSES.WRITE]: 'tools.riskClass.write',
  [TOOL_RISK_CLASSES.DELETE]: 'tools.riskClass.delete',
  [TOOL_RISK_CLASSES.EXECUTE]: 'tools.riskClass.execute',
  [TOOL_RISK_CLASSES.EXTERNAL]: 'tools.riskClass.external',
});

/**
 * Order and description of the modes for the chat pill and the settings
 * (concept §3). A function rather than a constant: the strings depend on the
 * language and must not freeze when the module loads.
 *
 * Given the permission state, "Auto" is marked unavailable where it cannot be
 * stored — no encrypted storage (#419) — unless it is the mode already set,
 * so that it can still be seen and left.
 */
export function toolModeOptions(state = null, current = state?.mode) {
  const autoBlocked = state?.encryptionAvailable === false && current !== TOOL_PERMISSION_MODES.AUTO;
  return MODE_ORDER.map((value) => {
    const unavailable = autoBlocked && value === TOOL_PERMISSION_MODES.AUTO;
    return {
      value,
      label: t(MODE_KEYS[value]),
      description: unavailable ? t('permissions.mode.auto.unavailable') : t(`${MODE_KEYS[value]}.desc`),
      unavailable,
    };
  });
}

/** Klassen, für die es keine Sitzungsfreigabe gibt (Konzept §6). */
const SINGLE_DECISION_CLASSES = Object.freeze([
  TOOL_RISK_CLASSES.DELETE,
  TOOL_RISK_CLASSES.EXECUTE,
  TOOL_RISK_CLASSES.EXTERNAL,
]);

export function modeLabel(mode) {
  return t(MODE_KEYS[mode] || MODE_KEYS[TOOL_PERMISSION_MODES.SMART]);
}

export function riskClassLabel(riskClass) {
  return RISK_CLASS_KEYS[riskClass] ? t(RISK_CLASS_KEYS[riskClass]) : String(riskClass ?? '');
}

/**
 * Key tables for the values the contract enumerates. Same shape as MODE_KEYS
 * above (#289): the contract stays the source of the *values*, the catalogue
 * the source of the words.
 */
const TARGET_KIND_KEYS = Object.freeze({
  file: 'approval.targetKind.file',
  directory: 'approval.targetKind.directory',
  tree: 'approval.targetKind.tree',
});

const PREVIEW_KIND_KEYS = Object.freeze({
  text: 'approval.previewKind.text',
  replace: 'approval.previewKind.replace',
  diff: 'approval.previewKind.diff',
  code: 'approval.previewKind.code',
  shell: 'approval.previewKind.shell',
  memory: 'approval.previewKind.memory',
  prompt: 'approval.previewKind.prompt',
});

/** Reach of a memory entry, in words (issue #166). */
const MEMORY_SCOPE_KEYS = Object.freeze({
  workspace: 'approval.memoryScope.workspace',
  user: 'approval.memoryScope.user',
});

function hasClass(classes, riskClass) {
  return Array.isArray(classes) && classes.includes(riskClass);
}

/**
 * Control, format and line-separator characters. A bidi control can reorder
 * what the card shows — `echo safe \u202E\u2066; echo x \u2069 \u2066#\u2069\u202C`
 * reads as if the second command were commented out, while the shell runs it
 * (CR-B13-01) — and a zero-width character makes two different paths look
 * alike.
 */
const INVISIBLE_PATTERN = /\r\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const JOINERS = new Set(['\u200c', '\u200d']);

function isNonAscii(code) {
  return Number.isFinite(code) && code > 0x7f;
}

/**
 * A text from the model as the card shows it: every invisible character as
 * `⟨U+202E⟩` where it sits, so that what is read is what runs. Tab, line feed
 * and a CRLF line ending are ordinary text (#244). A joiner between two
 * non-ASCII characters belongs to an emoji sequence or to a script that needs
 * it, and stays.
 */
export function revealInvisible(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', count: 0 };
  let count = 0;
  const out = text.replace(INVISIBLE_PATTERN, (match, offset, whole) => {
    if (match === '\r\n' || match === '\n' || match === '\t') return match;
    if (JOINERS.has(match) && isNonAscii(whole.charCodeAt(offset - 1)) && isNonAscii(whole.charCodeAt(offset + 1))) {
      return match;
    }
    count += 1;
    return `⟨U+${match.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: out, count };
}

/** Only the text of `revealInvisible`, where the count is taken elsewhere. */
function revealed(text) {
  return revealInvisible(text).text;
}

/** Title of the card (concept §6): change, execution, external access or file access. */
export function approvalCardTitle(riskClasses) {
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.EXECUTE)) return t('approval.title.execute');
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.EXTERNAL)) return t('approval.title.external');
  if (hasClass(riskClasses, TOOL_RISK_CLASSES.WRITE) || hasClass(riskClasses, TOOL_RISK_CLASSES.DELETE)) {
    return t('approval.title.change');
  }
  return t('approval.title.read');
}

/**
 * A shell command has no file target; the headline names the shell it would
 * run in instead (issue #102) — "Snotra wants to run a command in zsh" rather
 * than an empty "run".
 */
function shellVerb(dto) {
  const shell = typeof dto?.preview?.shell === 'string' ? dto.preview.shell.trim() : '';
  return shell ? t('approval.verb.shell', { shell }) : t('approval.verb.shell.plain');
}

/**
 * Headline "Snotra wants to ‹verb› ‹target› (‹tool›)." — and in German the
 * target comes before the verb. So the whole sentence lives in the catalogue,
 * once per language, and the parts are filled in (#290).
 *
 * `template` is the same sentence with `{target}` and `{tool}` left standing,
 * so that the component can render those two as code without knowing where in
 * the sentence they belong.
 */
export function approvalHeadline(dto) {
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  const targets = Array.isArray(dto?.targets) ? dto.targets : [];
  let verb = t('approval.verb.read');
  // The image tool sends a prompt and writes a file; "send to an external
  // service assets/header.png" would read as if the file left (#85). What it
  // does to the file says it better — unless replacing it has no way back.
  if (dto?.tool === 'generate_image' && !hasClass(classes, TOOL_RISK_CLASSES.DELETE)) {
    verb = targets.some((entry) => entry.exists === true)
      ? t('approval.verb.generateImage.replace')
      : t('approval.verb.generateImage');
  } else if (hasClass(classes, TOOL_RISK_CLASSES.EXTERNAL)) verb = t('approval.verb.external');
  else if (dto?.tool === 'shell_execute') verb = shellVerb(dto);
  else if (hasClass(classes, TOOL_RISK_CLASSES.EXECUTE)) verb = t('approval.verb.execute');
  else if (hasClass(classes, TOOL_RISK_CLASSES.DELETE)) verb = t('approval.verb.delete');
  else if (hasClass(classes, TOOL_RISK_CLASSES.WRITE)) {
    verb = targets.length > 0 && targets.every((entry) => entry.exists !== true)
      ? t('approval.verb.create')
      : t('approval.verb.change');
  }
  let targetLabel = '';
  if (targets.length === 1) targetLabel = targetPathLabel(targets[0]);
  else if (targets.length > 1) targetLabel = t('approval.targets.count', { count: targets.length });
  // An MCP tool is named by its server, so its name is not ours either.
  const tool = typeof dto?.tool === 'string' ? revealed(dto.tool) : '';
  // A placeholder without a value stays standing — that is what carries the
  // two slots through to the component untouched.
  const template = targetLabel
    ? t('approval.headline.withTarget', { verb })
    : t('approval.headline.plain', { verb });
  const text = targetLabel
    ? t('approval.headline.withTarget', { verb, target: targetLabel, tool: tool || t('tools.line.generic.fallbackName') })
    : t('approval.headline.plain', { verb, tool: tool || t('tools.line.generic.fallbackName') });
  return { targetLabel, verb, tool, template, text };
}

/**
 * The path of a target as the card shows it: a file in a skill folder in the
 * tools' own spelling (`skill:<name>/…`), even when the model gave its
 * absolute path (#427). Invisible characters are shown (CR-B13-01).
 */
function targetPathLabel(target) {
  if (typeof target?.skillPath === 'string' && target.skillPath) return revealed(target.skillPath);
  return typeof target?.path === 'string' ? revealed(target.path) : '';
}

function describeTarget(target) {
  const out = {
    path: targetPathLabel(target),
    kindLabel: t(TARGET_KIND_KEYS[target?.kind] || TARGET_KIND_KEYS.file),
    exists: target?.exists === true,
    sensitive: target?.sensitive === true,
    notes: [],
  };
  if (out.sensitive) {
    out.notes.push(target.sensitiveReason
      ? t('approval.note.sensitiveReason', { reason: target.sensitiveReason })
      : t('approval.note.sensitive'));
  }
  // The version token (size and mtime) binds the approval to the file the
  // model saw; it stays on the view but is no note — nobody can read it, and
  // the session scope already says it applies to this file version (#811).
  if (typeof target?.version === 'string' && target.version) out.version = target.version;
  if (target?.kind === 'file' && !out.exists) out.notes.push(t('approval.note.new'));
  if (target?.recovery === 'trash') out.notes.push(t('approval.note.trash'));
  // A file in a skill folder names its skill (#427); only reading reaches
  // one (#548).
  if (typeof target?.skillName === 'string' && target.skillName) {
    out.skillName = target.skillName;
    out.notes.push(t('approval.note.skill', { name: target.skillName }));
  }
  return out;
}

/** Why "allow for this session" is (not) offered (concept §6). */
export function sessionActionHint(dto) {
  if (dto?.sessionAllowed === true) return '';
  if (dto?.mode === TOOL_PERMISSION_MODES.ASK_ALL) return t('approval.sessionHint.askAll');
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  const single = classes.filter((cls) => SINGLE_DECISION_CLASSES.includes(cls));
  if (single.length > 0) {
    return t('approval.sessionHint.classes', {
      classes: single.map(riskClassLabel).join(t('approval.sessionHint.classSeparator')),
    });
  }
  return t('approval.sessionHint.single');
}

const ALWAYS_UNAVAILABLE_KEYS = Object.freeze({
  [COMMAND_RULE_UNAVAILABLE_REASONS.ASK_ALL]: 'approval.alwaysHint.askAll',
  [COMMAND_RULE_UNAVAILABLE_REASONS.NOT_SIMPLE]: 'approval.alwaysHint.notSimple',
  [COMMAND_RULE_UNAVAILABLE_REASONS.STDIN]: 'approval.alwaysHint.stdin',
  [COMMAND_RULE_UNAVAILABLE_REASONS.NO_ENCRYPTION]: 'approval.alwaysHint.noEncryption',
  [COMMAND_RULE_UNAVAILABLE_REASONS.NO_WORKSPACE]: 'approval.alwaysHint.noWorkspace',
  [COMMAND_RULE_UNAVAILABLE_REASONS.CLASSES]: 'approval.alwaysHint.classes',
});

/**
 * Whether the card is one that can remember its command (#121) — a
 * `shell_execute` card before the run. It then offers "always allow" where
 * other cards offer "for this session", which a command never gets.
 */
export function offersAlways(dto) {
  return dto?.alwaysAllowed === true || typeof dto?.alwaysUnavailableReason === 'string';
}

/**
 * What "always allow" means on this card, or why it is not offered (#121).
 * Offered, the hint says what exactly is remembered and where it is undone;
 * that is the whole difference to "allow once", so it stands on the card.
 */
export function alwaysActionHint(dto) {
  if (dto?.alwaysAllowed === true) {
    return t('approval.alwaysHint.allowed', { page: t('settings.nav.security') });
  }
  const key = ALWAYS_UNAVAILABLE_KEYS[dto?.alwaysUnavailableReason];
  return key ? t(key) : '';
}

const ISOLATION_REASON_KEYS = Object.freeze({
  platform: 'approval.isolation.reason.platform',
  dependencies: 'approval.isolation.reason.dependencies',
  'self-test': 'approval.isolation.reason.selfTest',
  start: 'approval.isolation.reason.start',
  workspace: 'approval.isolation.reason.workspace',
});

/**
 * Isolation of an execution tool as the card shows it (#329): a pill next to
 * the title — "Isolated", or "Not isolated" in amber (#396) — plus, when
 * isolated, the domains the run may reach and a one-line note on what stays
 * closed. Null when the card carries no isolation state at all (no sandbox
 * wired).
 *
 * `switchedOff` marks the user's own opt-out for the workspace (#357): the
 * card then offers the way back to the setting.
 */
export function describeIsolation(isolation, { homeDir = '' } = {}) {
  if (!isolation || typeof isolation !== 'object') return null;
  if (isolation.isolated === true) {
    const domains = (Array.isArray(isolation.domains) ? isolation.domains : [])
      .filter((entry) => typeof entry === 'string' && entry);
    return {
      isolated: true,
      badge: t('approval.isolation.badge.on'),
      domains,
      networkNone: domains.length > 0 ? '' : t('approval.isolation.network.none'),
      note: t('approval.isolation.note'),
      // A program allowance (#408): what it adds, or why it stays off.
      allowance: describeAllowanceOnCard(isolation, { homeDir }),
    };
  }
  const missing = (Array.isArray(isolation.missing) ? isolation.missing : [])
    .filter((entry) => typeof entry === 'string' && entry);
  const key = ISOLATION_REASON_KEYS[isolation.reason] || ISOLATION_REASON_KEYS.start;
  const switchedOff = isolation.reason === 'workspace';
  return {
    isolated: false,
    badge: t('approval.isolation.badge.off'),
    domains: [],
    reason: t(key, { packages: missing.length > 0 ? missing.join(', ') : 'bubblewrap, socat, ripgrep' }),
    switchedOff,
    settingsLabel: switchedOff ? t('approval.isolation.settings') : '',
  };
}

/**
 * Why the "Auto" pill warns (#357, #396), or '' when it does not: in "Auto",
 * an execution tool is offered and would run without sandbox — switched off
 * for the workspace, or not available on this system.
 */
export function describeAutoIsolationWarning(state) {
  if (state?.mode !== TOOL_PERMISSION_MODES.AUTO) return '';
  const isolation = state?.executionIsolation;
  if (!isolation || isolation.unisolated !== true) return '';
  const tools = (Array.isArray(isolation.tools) ? isolation.tools : [])
    .filter((entry) => entry === 'shell_execute' || entry === 'run_python');
  if (tools.length === 0) return '';
  return t(isolation.reason === 'workspace' ? 'chat.toolMode.unisolated.workspace' : 'chat.toolMode.unisolated.system', {
    tools: tools.join(t('chat.toolMode.unisolated.and')),
  });
}

/**
 * Display model of the mode pill and the notice on top of its menu (#396).
 * The warning is never carried by colour alone: the label says "not
 * isolated", the menu says why and offers the way to the setting — except on
 * Windows, where there is no sandbox to switch on.
 */
export function describeModePill(state) {
  const mode = MODE_KEYS[state?.mode] ? state.mode : TOOL_PERMISSION_MODES.SMART;
  const name = modeLabel(mode);
  const warning = describeAutoIsolationWarning(state);
  if (!warning) return { mode, label: name, unisolated: false, heading: '', warning: '', settingsLabel: '' };
  return {
    mode,
    label: t('chat.toolMode.unisolated.label', { mode: name }),
    unisolated: true,
    heading: t('approval.isolation.badge.off'),
    warning,
    settingsLabel: state.executionIsolation.reason === 'platform' ? '' : t('approval.isolation.settings'),
  };
}

/** The folder name of a workspace root, as the folder panel shows it (#413). */
export function workspaceFolderName(root) {
  if (typeof root !== 'string' || !root) return '';
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || root;
}

// Stands in for the folder name while the sentence is translated, so the
// name can be set apart without the catalogue knowing about markup.
const FOLDER_MARK = '\u0001';

function splitAtFolder(text, folder) {
  const at = text.indexOf(FOLDER_MARK);
  if (at === -1) return { before: text, folder: '', after: '' };
  return { before: text.slice(0, at), folder, after: text.slice(at + FOLDER_MARK.length).split(FOLDER_MARK).join(folder) };
}

/**
 * The workspace default in the mode pill's menu (#413): the tag on the option
 * that is the default, and the checkbox that makes the chat's mode the
 * default — or, ticked, takes it back to "Smart". The checkbox always speaks
 * about the mode the chat has now; its label names that mode.
 *
 * Hidden without a workspace, and when there is nothing to remember: the chat
 * runs at "Smart" and the workspace has no default of its own.
 */
export function describeWorkspaceDefault(state) {
  const SMART = TOOL_PERMISSION_MODES.SMART;
  const mode = MODE_KEYS[state?.mode] ? state.mode : SMART;
  const workspaceMode = MODE_KEYS[state?.workspaceMode] ? state.workspaceMode : SMART;
  const root = typeof state?.workspaceRoot === 'string' ? state.workspaceRoot : '';
  const view = {
    visible: false,
    folder: '',
    tagMode: null,
    tag: '',
    isDefault: false,
    checked: false,
    disabled: false,
    label: { before: '', folder: '', after: '' },
    hint: '',
    targetMode: SMART,
  };
  if (!root) return view;
  const folder = workspaceFolderName(root);
  view.folder = folder;
  if (workspaceMode !== SMART) {
    view.tagMode = workspaceMode;
    view.tag = t('chat.toolMode.defaultTag', { folder });
    view.isDefault = mode === workspaceMode;
  }
  if (mode === SMART && workspaceMode === SMART) return view;
  view.visible = true;
  view.checked = mode === workspaceMode;
  view.targetMode = view.checked ? SMART : mode;
  view.label = splitAtFolder(t('chat.toolMode.remember.label', { mode: modeLabel(mode), folder: FOLDER_MARK }), folder);
  if (view.checked) {
    view.hint = t('chat.toolMode.remember.hint.checked', { mode: modeLabel(SMART) });
  } else if (mode === TOOL_PERMISSION_MODES.AUTO && state?.encryptionAvailable === false) {
    view.disabled = true;
    view.hint = t('chat.toolMode.remember.hint.needsEncryption');
  } else if (workspaceMode !== SMART) {
    view.hint = t('chat.toolMode.remember.hint.current', { mode: modeLabel(workspaceMode) });
  } else {
    view.hint = t(mode === TOOL_PERMISSION_MODES.AUTO ? 'chat.toolMode.remember.hint.auto' : 'chat.toolMode.remember.hint.other');
  }
  return view;
}

/** Warning when overwriting (concept §6): with or without a way back. */
export function overwriteWarning(dto) {
  const classes = Array.isArray(dto?.riskClasses) ? dto.riskClasses : [];
  if (dto?.tool === 'shell_execute' || dto?.tool === 'run_python') {
    const isolation = dto?.preview?.isolation;
    // Isolated: the boundary exists, and the pill and the note say so (#329).
    if (isolation?.isolated === true) return '';
    // No workspace boundary: that belongs on the card, not only in the
    // settings (issue #102) — and if a sandbox was expected, why it is
    // missing (#329).
    const base = t(dto.tool === 'shell_execute' ? 'approval.warning.shell' : 'approval.warning.python');
    if (isolation && isolation.isolated === false) return `${describeIsolation(isolation).reason} ${base}`;
    return dto.tool === 'shell_execute' ? base : '';
  }
  const targets = Array.isArray(dto?.targets) ? dto.targets : [];
  const existing = targets.filter((entry) => entry.exists === true && (entry.kind === 'file' || !entry.kind));
  if (hasClass(classes, TOOL_RISK_CLASSES.DELETE)) return t('approval.warning.delete');
  if (dto?.tool === 'write_file_text' && existing.length > 0) {
    return existing.some((entry) => entry.recovery === 'trash')
      ? t('approval.warning.overwriteTrash')
      : t('approval.warning.overwrite');
  }
  return '';
}

/**
 * Complete display model of the card from the DTO. Returns null for invalid
 * DTOs — then nothing is shown and nothing is answered.
 */
export function buildApprovalCardView(dto, { homeDir = '' } = {}) {
  if (!isToolApprovalRequestDto(dto)) return null;
  // Every text the model chose, revealed and counted once (CR-B13-01); the
  // headline and the session scope repeat them and are revealed uncounted.
  let invisible = 0;
  const reveal = (text) => {
    const result = revealInvisible(text);
    invisible += result.count;
    return result.text;
  };
  const classes = dto.riskClasses.filter((cls) => TOOL_RISK_CLASS_ORDER.includes(cls));
  const targets = dto.targets.map(describeTarget);
  for (const target of dto.targets) reveal(target?.skillPath || target?.path);
  reveal(dto.tool);
  const sensitive = classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE) || targets.some((entry) => entry.sensitive);
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
    // The reason arrives as a list of descriptors (#290); a producer that has
    // not been converted still hands over a finished sentence, and `tMessage`
    // lets that through.
    reason: Array.isArray(dto.reasonParts) && dto.reasonParts.length > 0
      ? dto.reasonParts.map(tMessage).filter(Boolean).join(' ')
      : tMessage(dto.reason),
    sensitive,
    providerLabel: typeof dto.providerLabel === 'string' ? dto.providerLabel : '',
    warning: overwriteWarning(dto),
    shellLabel: '',
    memoryScopeLabel: '',
    cwdLabel: '',
    isolation: describeIsolation(dto.preview?.isolation, { homeDir }),
    invisibleWarning: '',
    preview: null,
    actions: {
      once: { response: APPROVAL_RESPONSES.ALLOW_ONCE, label: t('approval.action.once'), enabled: true },
      session: {
        response: APPROVAL_RESPONSES.ALLOW_SESSION,
        label: t('approval.action.session'),
        enabled: dto.sessionAllowed === true,
        hint: sessionActionHint(dto),
      },
      always: {
        response: APPROVAL_RESPONSES.ALLOW_ALWAYS,
        label: t('approval.action.always'),
        enabled: dto.alwaysAllowed === true,
        hint: alwaysActionHint(dto),
      },
      deny: { response: APPROVAL_RESPONSES.DENY, label: t('approval.action.deny'), enabled: true },
    },
    // The three buttons of the card, in order. A command card has "always"
    // in the middle instead of "for this session" (#121).
    actionOrder: offersAlways(dto) ? ['once', 'always', 'deny'] : ['once', 'session', 'deny'],
    scopeNote: '',
  };
  if (dto.sessionAllowed === true) {
    const parts = [];
    const scope = tMessage(dto.sessionScope || dto.sessionScopeLabel);
    if (scope) parts.push(scope);
    if (classes.includes(TOOL_RISK_CLASSES.WRITE)) {
      // Without a file target the allowance belongs to the tool, not to a
      // target — "to exactly these targets" would contradict the sentence
      // before it (#166).
      parts.push(
        Array.isArray(dto.targets) && dto.targets.length > 0
          ? t('approval.scope.targets')
          : t('approval.scope.calls')
      );
    }
    if (classes.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) parts.push(t('approval.scope.sensitive'));
    view.scopeNote = revealed(parts.join(' '));
  }
  if (view.isolation?.domains?.length > 0) view.isolation.domains = view.isolation.domains.map(reveal);
  if (dto.preview && typeof dto.preview.text === 'string') {
    const kind = PREVIEW_KIND_KEYS[dto.preview.kind] ? dto.preview.kind : 'text';
    const kindLabel = t(PREVIEW_KIND_KEYS[kind]);
    const notes = [];
    if (dto.preview.truncated === true) notes.push(t('approval.preview.truncated'));
    if (dto.preview.masked === true) notes.push(t('approval.preview.masked'));
    view.preview = {
      kind,
      kindLabel,
      text: reveal(dto.preview.text),
      truncated: dto.preview.truncated === true,
      masked: dto.preview.masked === true,
      summary: notes.length > 0
        ? t('approval.preview.summaryNotes', { kind: kindLabel, notes: notes.join(', ') })
        : t('approval.preview.summary', { kind: kindLabel }),
      truncatedNote: dto.preview.truncated === true ? t('approval.preview.truncatedNote') : '',
      maskedNote: dto.preview.masked === true ? t('approval.preview.maskedNote') : '',
      // What a process reads besides its source, each in a block of its own
      // below it (#551) — without them "sh" on the card could be any script.
      blocks: [],
    };
    if (typeof dto.preview.stdin === 'string' && dto.preview.stdin) {
      view.preview.blocks.push({ id: 'stdin', label: t('approval.preview.stdin'), text: reveal(dto.preview.stdin) });
    }
    if (Array.isArray(dto.preview.argv) && dto.preview.argv.length > 0) {
      // One argument per line, quoted: a space or a line break inside one
      // stays visible as such.
      const text = dto.preview.argv.map((entry) => JSON.stringify(String(entry))).join('\n');
      view.preview.blocks.push({ id: 'argv', label: t('approval.preview.argv'), text: reveal(text) });
    }
    // For a shell command both belong visibly on the card rather than in the
    // preview: what it runs with, and where (issue #102).
    if (typeof dto.preview.shell === 'string' && dto.preview.shell) {
      view.shellLabel = dto.preview.shellLogin === true
        ? t('approval.shell.login', { shell: dto.preview.shell })
        : dto.preview.shell;
    }
    if (typeof dto.preview.cwd === 'string' && dto.preview.cwd) view.cwdLabel = reveal(dto.preview.cwd);
    // When remembering, the reach belongs on the card: "project" or "global"
    // is the whole difference being decided here.
    if (MEMORY_SCOPE_KEYS[dto.preview.memoryScope]) {
      view.memoryScopeLabel = t(MEMORY_SCOPE_KEYS[dto.preview.memoryScope]);
    }
  }
  if (invisible > 0) view.invisibleWarning = tPlural('approval.warning.invisible', invisible);
  return view;
}

/**
 * Outcome of a card in words (concept §6): decision, expiry or cancellation —
 * separate from the execution result, which the tool line shows.
 */
export function describeApprovalOutcome({ response, invalidated, reason, aborted } = {}) {
  if (aborted === true) {
    return {
      status: 'cancelled',
      label: t('approval.outcome.cancelled.label'),
      detail: t('approval.outcome.cancelled.detail'),
    };
  }
  if (invalidated === true) {
    const message = t(PERMISSION_DENIED_MESSAGE_KEYS[reason]
      || PERMISSION_DENIED_MESSAGE_KEYS[PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED]);
    return {
      status: 'invalidated',
      label: t('approval.outcome.invalidated.label'),
      detail: t('approval.outcome.invalidated.detail', { reason: message }),
    };
  }
  if (response === APPROVAL_RESPONSES.DENY) {
    return {
      status: 'denied',
      label: t('approval.outcome.denied.label'),
      detail: t('approval.outcome.denied.detail', {
        message: t(PERMISSION_DENIED_MESSAGE_KEYS[PERMISSION_DENIAL_REASONS.USER_DENIED]),
      }),
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_ALWAYS) {
    return {
      status: 'allowed',
      label: t('approval.outcome.always.label'),
      detail: t('approval.outcome.always.detail', {
        mode: modeLabel(TOOL_PERMISSION_MODES.SMART),
        page: t('settings.nav.security'),
      }),
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_SESSION) {
    return {
      status: 'allowed',
      label: t('approval.outcome.session.label'),
      detail: t('approval.outcome.session.detail'),
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_ONCE) {
    return {
      status: 'allowed',
      label: t('approval.outcome.once.label'),
      detail: t('approval.outcome.once.detail'),
    };
  }
  return {
    status: 'invalidated',
    label: t('approval.outcome.invalidated.label'),
    detail: t('approval.outcome.invalidated.detailPlain'),
  };
}

const DECISION_KEYS = Object.freeze({
  [POLICY_DECISIONS.ALLOW]: 'approval.decision.allow',
  [POLICY_DECISIONS.ASK]: 'approval.decision.ask',
  [POLICY_DECISIONS.DENY]: 'approval.decision.deny',
});

const SOURCE_KEYS = Object.freeze({
  [PERMISSION_DECISION_SOURCES.AUTO]: 'approval.source.auto',
  [PERMISSION_DECISION_SOURCES.ALLOW_ONCE]: 'approval.source.allowOnce',
  [PERMISSION_DECISION_SOURCES.ALLOW_SESSION]: 'approval.source.allowSession',
  [PERMISSION_DECISION_SOURCES.ALLOW_RULE]: 'approval.source.allowRule',
  [PERMISSION_DECISION_SOURCES.DENY]: 'approval.source.deny',
});

const STATUS_KEYS = Object.freeze({
  [TOOL_EXECUTION_STATUSES.AWAITING_APPROVAL]: 'approval.status.awaiting',
  [TOOL_EXECUTION_STATUSES.EXECUTED]: 'approval.status.executed',
  [TOOL_EXECUTION_STATUSES.FAILED]: 'approval.status.failed',
  [TOOL_EXECUTION_STATUSES.DENIED]: 'approval.status.denied',
  [TOOL_EXECUTION_STATUSES.CANCELLED]: 'approval.status.cancelled',
});

/**
 * Cleaned audit of a tool line (concept §9) as tooltip text: decision, source,
 * class, execution status, reason. Empty when the entry (an older session)
 * carries no audit.
 */
export function describePermissionAudit(permission) {
  if (!permission || typeof permission !== 'object') return '';
  const parts = [];
  const decisionKey = DECISION_KEYS[permission.decision];
  if (decisionKey) {
    const decision = t(decisionKey);
    const sourceKey = SOURCE_KEYS[permission.source];
    parts.push(sourceKey && permission.source !== PERMISSION_DECISION_SOURCES.DENY
      ? t('approval.audit.decisionSource', { decision, source: t(sourceKey) })
      : t('approval.audit.decision', { decision }));
  }
  if (Array.isArray(permission.riskClasses) && permission.riskClasses.length > 0) {
    parts.push(t('approval.audit.class', { classes: permission.riskClasses.map(riskClassLabel).join(', ') }));
  }
  if (STATUS_KEYS[permission.status]) {
    parts.push(t('approval.audit.status', { status: t(STATUS_KEYS[permission.status]) }));
  }
  if (permission.reason && PERMISSION_DENIED_MESSAGE_KEYS[permission.reason]) {
    parts.push(t('approval.audit.reason', { reason: t(PERMISSION_DENIED_MESSAGE_KEYS[permission.reason]) }));
  }
  if (permission.ruleId) parts.push(t('approval.audit.rule', { rule: permission.ruleId }));
  if (permission.mode) parts.push(t('approval.audit.mode', { mode: modeLabel(permission.mode) }));
  if (permission.sensitive === true) parts.push(t('approval.audit.sensitive'));
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

export function ruleEffectOptions() {
  return [
    { value: PERMISSION_RULE_EFFECTS.DENY, label: t('permissions.rule.effect.deny'), description: t('permissions.rule.effect.deny.desc') },
    { value: PERMISSION_RULE_EFFECTS.ALLOW, label: t('permissions.rule.effect.allow'), description: t('permissions.rule.effect.allow.desc') },
  ];
}

export function ruleScopeOptions() {
  return [
    { value: PERMISSION_RULE_SCOPES.WORKSPACE, label: t('permissions.rule.scope.workspace') },
    { value: PERMISSION_RULE_SCOPES.GLOBAL, label: t('permissions.rule.scope.global') },
  ];
}

/** Klassen, die als Regelgegenstand wählbar sind – bei Erlauben nur read/write. */
export function ruleClassOptions(effect) {
  const classes = effect === PERMISSION_RULE_EFFECTS.ALLOW ? PERSISTENT_ALLOW_CLASSES : TOOL_RISK_CLASS_ORDER;
  return classes.map((value) => ({ value, label: riskClassLabel(value) }));
}

/**
 * A remembered command (#121) reads as what it is: the command line, and —
 * when not the project folder itself — the folder it runs in and the domains
 * it may reach. Path pattern and class mean nothing for it.
 */
function describeCommandRule(rule, effectLabel) {
  const scopeLabel = t('permissions.rule.scope.workspace');
  // The command came from the model once; it reads here as it did on the card.
  const command = revealed(rule.command);
  const parts = [rule.cwd
    ? t('permissions.rule.subject.commandIn', { cwd: revealed(rule.cwd) })
    : t('permissions.rule.subject.command')];
  if (Array.isArray(rule.networkDomains) && rule.networkDomains.length > 0) {
    parts.push(t('permissions.rule.subject.commandNetwork', { domains: rule.networkDomains.join(', ') }));
  }
  const subject = parts.join(t('permissions.rule.subject.separator'));
  return {
    id: rule.id,
    effect: rule.effect,
    effectLabel,
    subject,
    pattern: command,
    patternLabel: command,
    scopeLabel,
    command: true,
    text: t('permissions.rule.text.command', { effect: effectLabel, subject, command, scope: scopeLabel }),
  };
}

export function describeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const effectLabel = t(rule.effect === PERMISSION_RULE_EFFECTS.ALLOW
    ? 'permissions.rule.label.allow'
    : 'permissions.rule.label.deny');
  if (isCommandRule(rule)) return describeCommandRule(rule, effectLabel);
  const subject = rule.tool
    ? t('permissions.rule.subject.tool', { tool: rule.tool })
    : t('permissions.rule.subject.class', { label: riskClassLabel(rule.riskClass) });
  const pattern = rule.pathPattern || '**';
  const scopeLabel = t(rule.scope === PERMISSION_RULE_SCOPES.GLOBAL
    ? 'permissions.rule.scope.global'
    : 'permissions.rule.scope.workspace');
  const patternLabel = pattern === '**' ? t('permissions.rule.allPaths') : pattern;
  return {
    id: rule.id,
    effect: rule.effect,
    effectLabel,
    subject,
    pattern,
    patternLabel,
    scopeLabel,
    text: t('permissions.rule.text', { effect: effectLabel, subject, pattern: patternLabel, scope: scopeLabel }),
  };
}

/**
 * Prüft einen Regel-Entwurf aus dem Formular und formt ihn zur IPC-Regel.
 * Der Main validiert erneut; diese Prüfung liefert nur verständliche
 * Fehlermeldungen, bevor der Systemdialog erscheint.
 */
export function validateRuleDraft({ effect, scope, subjectType, tool, riskClass, pathPattern, hasWorkspace } = {}) {
  if (effect !== PERMISSION_RULE_EFFECTS.ALLOW && effect !== PERMISSION_RULE_EFFECTS.DENY) {
    return { ok: false, error: t('permissions.rule.error.effect') };
  }
  const ruleScope = scope === PERMISSION_RULE_SCOPES.GLOBAL ? PERMISSION_RULE_SCOPES.GLOBAL : PERMISSION_RULE_SCOPES.WORKSPACE;
  if (ruleScope === PERMISSION_RULE_SCOPES.WORKSPACE && hasWorkspace !== true) {
    return { ok: false, error: t('permissions.rule.error.noWorkspace') };
  }
  const rule = { effect, scope: ruleScope };
  if (subjectType === 'tool') {
    const name = typeof tool === 'string' ? tool.trim() : '';
    if (!name) return { ok: false, error: t('permissions.rule.error.tool') };
    rule.tool = name;
  } else {
    if (!TOOL_RISK_CLASS_ORDER.includes(riskClass)) return { ok: false, error: t('permissions.rule.error.class') };
    if (effect === PERMISSION_RULE_EFFECTS.ALLOW && !PERSISTENT_ALLOW_CLASSES.includes(riskClass)) {
      return { ok: false, error: t('permissions.rule.error.allowClass') };
    }
    rule.riskClass = riskClass;
  }
  const pattern = normalizeRulePathPattern(pathPattern);
  if (pattern === null) return { ok: false, error: t('permissions.rule.error.pattern') };
  rule.pathPattern = pattern;
  return { ok: true, rule };
}

/** Prüft ein sensibles Pfadmuster aus dem Formular (Konzept §4). */
export function validateSensitivePattern(raw, existing = []) {
  const pattern = normalizeRulePathPattern(raw);
  if (pattern === null) return { ok: false, error: t('permissions.sensitive.error.pattern') };
  if (!pattern || pattern === '**') return { ok: false, error: t('permissions.sensitive.error.tooBroad') };
  if (Array.isArray(existing) && existing.includes(pattern)) return { ok: false, error: t('permissions.sensitive.error.duplicate') };
  return { ok: true, pattern };
}

/**
 * The session approvals grouped by chat for the settings (#447): the chat on
 * screen first, then the chats still running in the background, each group
 * oldest approval first. `formatTime` turns the timestamp into a clock time.
 */
export function sessionGrantGroups(grants, { formatTime = (ms) => new Date(ms).toLocaleTimeString() } = {}) {
  const groups = new Map();
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant || typeof grant.id !== 'string' || !grant.id) continue;
    const key = grant.chatId || '';
    if (!groups.has(key)) {
      const title = typeof grant.chatTitle === 'string' && grant.chatTitle ? grant.chatTitle : t('chat.title.new');
      groups.set(key, {
        chatId: grant.chatId || null,
        current: grant.current === true,
        label: t(grant.current === true ? 'settings.grants.group.current' : 'settings.grants.group.background', { title }),
        items: [],
      });
    }
    const classes = (Array.isArray(grant.classes) ? grant.classes : []).map(riskClassLabel).join(', ');
    // The card's sentence names the classes already; only without it does the
    // second line have to.
    // The card's sentence carries the paths it named, revealed as on the card.
    const sentence = revealed(tMessage(grant.scope));
    const text = sentence || t('settings.grants.fallback', { tool: revealed(grant.tool || '') });
    const time = Number.isFinite(grant.grantedAt) ? formatTime(grant.grantedAt) : '';
    let meta = classes;
    if (time) meta = sentence ? t('settings.grants.time', { time }) : t('settings.grants.meta', { classes, time });
    groups.get(key).items.push({ id: grant.id, text, meta });
  }
  return [...groups.values()].sort((a, b) => Number(b.current) - Number(a.current));
}

/** Sichtbarer Umfang der Reset-Aktionen (Konzept §7). */
export function resetActions() {
  return [
    { key: 'workspace', label: t('permissions.reset.workspace'), description: t('permissions.reset.workspace.desc') },
    { key: 'all', label: t('permissions.reset.all'), description: t('permissions.reset.all.desc'), confirm: true },
  ];
}

export function integrityWarning(integrity) {
  if (integrity === 'invalid') return t('permissions.integrity.invalid');
  if (integrity === 'unsigned') return t('permissions.integrity.unsigned');
  if (integrity === 'unreadable') return t('permissions.integrity.unreadable');
  return '';
}

export function legacyWriteMigrationHint() {
  return t('permissions.legacyWriteHint');
}
