'use strict';

/**
 * Plant einen Tool-Aufruf vor der Ausführung (Issue #66, Konzept §2/§4/§5).
 *
 * Der Planer ist der „vertrauenswürdige Adapter“ aus dem Konzept: Er kennt
 * die Registry-Definition (Mindestklasse, Zielbeschreibung), löst alle Ziele
 * gegen Workspace bzw. Skill-Wurzeln auf (lexikalisch und über den realen
 * Pfad), prüft harte Grenzen (Snotra-eigener Speicher), erkennt sensible
 * Pfade und bestimmt die effektiven Risikoklassen. Aus demselben Plan
 * entstehen Vorschau, Freigabe-Karte und die spätere Versionsprüfung.
 *
 * Der Planer führt keinen Handler aus und liest keine Dateiinhalte für das
 * Modell. Für die Vorschau nutzt er nur die vom Modell gelieferten Argumente
 * (maskiert), nie den Bestand der Zieldatei.
 */

const {
  TOOL_RISK_CLASSES,
  PERMISSION_DENIAL_REASONS,
  normalizeRiskClasses,
  normalizeRememberableCommand,
  normalizeCommandCwd,
} = require('../../shared/contracts/tool-permissions');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { maskSensitiveContent } = require('../../shared/runtime/sensitive-content');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const { resolveRunDomains, normalizeDomains } = require('../../shared/runtime/sandbox-domains');
const { SANDBOX_REASONS } = require('../../shared/contracts/sandbox-reasons');
const { KNOWLEDGE_FILE_KINDS, workspaceKnowledgeKind, writtenRuleIsAlways } = require('../../shared/contracts/knowledge-files');
const { normalizeProgramAllowances } = require('../../shared/contracts/program-allowances');
const { APP_LOCALES, createTranslator } = require('../../shared/i18n');
const { isPathInside } = require('../../shared/runtime/path-inside');
const { TOOL_EXECUTION_KINDS, normalizeToolPresentation } = require('../../shared/contracts/tool-presentation');
const { TOOL_PREVIEW_KINDS } = require('./tool-descriptor');
const { outsideRootsFrom, OUTSIDE_WORKSPACE } = require('./outside-roots');

/**
 * How much of a preview reaches the card (#551). "Show in full" on the card
 * has to mean in full, so the limit sits where no real call ends up — a
 * program or a file of 200,000 characters is far beyond what a model writes
 * into one call. Up to #551 it was 4,000, and the card could only show the
 * beginning of what it asked to approve.
 */
const PREVIEW_MAX_CHARS = 200_000;
/** Program arguments on the card; more would not be read anyway. */
const PREVIEW_MAX_ARGV = 100;
/** The preview kinds of a tool that runs a process and reads standard input (#551). */
/**
 * Whether `resolveToolPath` refused. A function, not a check of `error` at
 * each caller: an empty message would not narrow the union.
 *
 * @param {ToolPathResolution} resolution
 * @returns {resolution is ToolPathRefused}
 */
function isRefused(resolution) {
  return 'error' in resolution && Boolean(resolution.error);
}

/** @type {Set<string | undefined>} */
const PROCESS_PREVIEWS = new Set([TOOL_PREVIEW_KINDS.CODE, TOOL_PREVIEW_KINDS.SHELL]);

const RECOVERY_TRASH = 'trash';

/**
 * The slice of a tool definition's JSON schema the argument check reads.
 * @typedef {{ properties?: Record<string, { type?: unknown, enum?: unknown[] }>, required?: string[] }} ArgumentSchema
 */

/**
 * One path a call touches, as the tool's `targets` names it.
 * @typedef {{ path?: unknown, kind?: string, access?: string, overwrite?: boolean }} TargetDescriptor
 */

/**
 * What the planner reads of a tool definition. The descriptor fields beside
 * these are checked by `tool-descriptor.js` when the tool registers.
 * @typedef {{
 *   name?: string,
 *   riskClass: string,
 *   additionalRiskClasses?: string[],
 *   parameters?: ArgumentSchema,
 *   execution?: string,
 *   preview?: string,
 *   pathlessWrite?: boolean,
 *   category?: string,
 *   approval?: { verb?: string, warning?: string },
 *   targets: (args: import('../../application/ports/tool-port').ToolArguments) => TargetDescriptor[] | { error: string },
 *   [field: string]: any,
 * }} PlannedTool
 */

/**
 * One replacement as the card shows it. The markers are words the user reads,
 * so they follow the interface language (#555), not the language the code
 * happened to be written in.
 *
 * @param {ReturnType<typeof createTranslator>} t
 * @param {{ replace_all?: unknown, old_string?: unknown, new_string?: unknown } | null | undefined} edit
 * @param {string} [heading]
 */
function replacementText(t, edit, heading = '') {
  const all = edit?.replace_all === true ? ` (${t('approval.preview.edit.all')})` : '';
  const head = heading ? `${heading}${all}\n--- ${t('approval.preview.edit.old')}` : `--- ${t('approval.preview.edit.old')}${all}`;
  return `${head}\n${String(edit?.old_string ?? '')}\n+++ ${t('approval.preview.edit.new')}\n${String(edit?.new_string ?? '')}`;
}

/**
 * What the approval card shows of a call, by the preview kind the tool's
 * descriptor names (#1008). Null for a tool without one.
 *
 * @param {string|undefined} previewKind
 * @param {import('../../application/ports/tool-port').ToolArguments} args
 * @param {{ locale?: string, isolation?: object|null, shellLabel?: string, shellLogin?: boolean, cwd?: string }} [options]
 * @returns {import('../../application/ports/tool-port').ToolPlan['preview'] | null}
 */
function buildPreview(previewKind, args, options = {}) {
  if (!previewKind) return null;
  const t = createTranslator(options.locale);
  let kind = previewKind;
  let text = '';
  /** @type {Record<string, unknown> | null} */
  let extra = null;
  if (previewKind === TOOL_PREVIEW_KINDS.TEXT) {
    text = typeof args?.content === 'string' ? args.content : '';
  } else if (previewKind === TOOL_PREVIEW_KINDS.REPLACE) {
    text = replacementText(t, args);
  } else if (previewKind === TOOL_PREVIEW_KINDS.DIFF) {
    if (typeof args?.patch === 'string') {
      text = args.patch;
    } else if (Array.isArray(args?.edits)) {
      text = args.edits
        .map((edit, index) => replacementText(t, edit, `# ${t('approval.preview.edit.step', { n: index + 1 })}`))
        .join('\n\n');
    }
  } else if (previewKind === TOOL_PREVIEW_KINDS.CODE) {
    // Ohne den Quelltext waere die Freigabe eine Blankounterschrift (Issue #86).
    text = typeof args?.code === 'string' ? args.code : '';
    if (options.isolation) extra = { isolation: options.isolation };
  } else if (previewKind === TOOL_PREVIEW_KINDS.SHELL) {
    // The command alone is not what runs: `sh` with a script on stdin is a
    // program the card would never show (#551). Input and arguments follow
    // below, as blocks of their own.
    // Der Nutzer soll sehen, *was* laeuft und *womit* (Issue #102): Befehl,
    // erkannte Shell und Arbeitsordner gehoeren zusammen auf die Karte.
    text = typeof args?.command === 'string' ? args.command : '';
    extra = {
      shell: typeof options.shellLabel === 'string' ? options.shellLabel : '',
      shellLogin: options.shellLogin === true,
      cwd: typeof options.cwd === 'string' ? options.cwd : '',
      ...(options.isolation ? { isolation: options.isolation } : {}),
    };
  } else if (previewKind === TOOL_PREVIEW_KINDS.PROMPT) {
    // What goes out is the prompt, and the prompt is what is paid for (#85).
    text = typeof args?.prompt === 'string' ? args.prompt : '';
  } else if (previewKind === TOOL_PREVIEW_KINDS.MEMORY) {
    // Der Nutzer entscheidet hier ueber einen Satz, der ab jetzt in *jeder*
    // Anfrage steht (Issue #166). Ohne den Satz und die Reichweite waere die
    // Freigabe eine Blankounterschrift — und ein Pfad steht nicht zur
    // Verfuegung, weil das Tool keinen bildet.
    text = typeof args?.text === 'string' ? args.text : '';
    extra = { memoryScope: args?.scope === 'user' ? 'user' : 'workspace' };
  } else {
    return null;
  }
  const main = previewText(text);
  /** @type {NonNullable<import('../../application/ports/tool-port').ToolPlan['preview']>} */
  const preview = {
    kind,
    text: main.text,
    truncated: main.truncated,
    masked: main.masked,
    ...(extra || {}),
  };
  // What a process reads besides its source (#551): standard input for both
  // execution tools, the arguments for Python. Masked and limited like the
  // text above, and counted in the same two flags.
  if (PROCESS_PREVIEWS.has(previewKind) && typeof args?.stdin === 'string' && args.stdin.length > 0) {
    const stdin = previewText(args.stdin);
    preview.stdin = stdin.text;
    preview.truncated ||= stdin.truncated;
    preview.masked ||= stdin.masked;
  }
  if (previewKind === TOOL_PREVIEW_KINDS.CODE && Array.isArray(args?.argv) && args.argv.length > 0) {
    const entries = args.argv.map((entry) => previewText(String(entry ?? '')));
    preview.argv = entries.slice(0, PREVIEW_MAX_ARGV).map((entry) => entry.text);
    preview.truncated ||= entries.length > PREVIEW_MAX_ARGV || entries.some((entry) => entry.truncated);
    preview.masked ||= entries.some((entry) => entry.masked);
  }
  return preview;
}

/**
 * @param {string} raw
 */
function previewText(raw) {
  const masked = maskSensitiveContent(raw);
  const truncated = masked.length > PREVIEW_MAX_CHARS;
  return {
    // A bare ellipsis, no word: the card says in the reader's language that
    // the preview is shortened (summary and note), so the text needs no
    // language of its own (#353).
    text: truncated ? `${masked.slice(0, PREVIEW_MAX_CHARS)}\n…` : masked,
    truncated,
    masked: masked !== raw,
  };
}

/**
 * Minimale Argumentprüfung gegen das JSON-Schema der Definition: Pflichtfelder
 * müssen vorhanden sein und den deklarierten Grundtyp haben. Ungültige
 * Argumente werden blockiert, nicht „irgendwie“ ausgeführt.
 *
 * A value outside its `enum` is refused too (#553): the handlers read it as
 * one of the allowed values otherwise — `remember` took any origin for
 * "requested" — and the message names the values, so the model corrects
 * itself in one round.
 *
 * @param {{ parameters?: ArgumentSchema }} definition
 * @param {import('../../application/ports/tool-port').ToolArguments | null | undefined} args
 * @returns {string | null}  what is wrong with the arguments, or null
 */
function validateArguments(definition, args) {
  const schema = definition.parameters || {};
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be an object.';
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return `Argument "${key}" is required.`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    const expected = spec.type;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected === 'string' && actual !== 'string') return `Argument "${key}" must be a string.`;
    if ((expected === 'integer' || expected === 'number') && actual !== 'number') {
      return `Argument "${key}" must be a number.`;
    }
    if (expected === 'boolean' && actual !== 'boolean') return `Argument "${key}" must be true or false.`;
    if (expected === 'array' && actual !== 'array') return `Argument "${key}" must be an array.`;
    if (expected === 'object' && actual !== 'object') return `Argument "${key}" must be an object.`;
    if (Array.isArray(spec.enum) && spec.enum.length > 0 && !spec.enum.includes(value)) {
      return `Argument "${key}" must be one of ${spec.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`;
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(Reflect.get(value, key))}`).join(',')}}`;
}

/**
 * What the planner asks of the file system service (#982): resolving a tool
 * path against its root, and the real path of what exists of it. On the
 * desktop `src/main/services/fs-service.js` is it; `tsc` checks it against
 * this where the tool adapter hands it in.
 * @typedef {{ access?: 'read' | 'write', skillRoots?: Array<{ name: string, dir: string }>,
 *   outsideRoots?: Array<{ root: string, only: string | null, access: 'read' | 'write' }> }} ToolPathOptions
 * @typedef {{ error: string, code?: string, absPath?: string, root?: undefined, prefix?: undefined,
 *     skillName?: undefined, outside?: undefined }
 *   | { error?: undefined, absPath: string, root: string, prefix: string, skillName: string | null,
 *     outside?: true }} ToolPathResolution
 * @typedef {Object} FsService
 * @property {(workspaceRoot: string | null | undefined, relativePath: unknown, options?: ToolPathOptions) => Promise<ToolPathResolution>} resolveToolPath
 * @property {(absPath: string) => Promise<string>} resolveExistingRealPath
 *
 * A tool path resolved against its root, or refused (#792): see `resolveToolPath`.
 * @typedef {Extract<ToolPathResolution, { error: string }>} ToolPathRefused
 * @typedef {Exclude<ToolPathResolution, ToolPathRefused>} ToolPathResolved
 *
 * What a card may open outside the open folder (#792); on the desktop
 * `src/main/services/outside-access.js`.
 * @typedef {{ path: string, file: boolean, access: 'read' | 'write' }} OutsideOffer
 * @typedef {Object} OutsideAccess
 * @property {(target: { absPath: string, isDirectory: boolean, access: 'read' | 'write' }) => Promise<OutsideOffer[]>} offer
 * @property {(grant: { path?: unknown, access?: unknown } | null | undefined, options?: { exact?: boolean }) => Promise<boolean>} isAllowed
 *
 * What a program allowance match says (#408): the allowance a shell command
 * gets, or why it does not.
 * @typedef {{ allowance: { path: string, program: string, writePaths?: string[], trustd?: boolean,
 *     credentials?: Array<{ name: string, id: string }>, [field: string]: any },
 *     command: string, entry: object, skipped?: undefined }
 *   | { skipped: { program: string, reason: string }, allowance?: undefined, command?: undefined, entry?: undefined }} ProgramAllowanceMatch
 * @typedef {(request: { command: string, cwd: string, workspaceRoot: string }) => Promise<ProgramAllowanceMatch | null>} ProgramAllowanceMatcher
 */

/**
 * @param {object} deps
 * @param {FsService} deps.fsService  liefert resolveToolPath und resolveExistingRealPath
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string[]} [deps.protectedRoots]  absolute Ordner, die für Tools hart gesperrt sind (userData)
 * @param {boolean} [deps.canTrash]  ob eine Wiederherstellungskopie in den Papierkorb möglich ist
 * @param {(() => {label?: string, login?: boolean}) | null} [deps.describeShell]  erkannte Shell für die Vorschau (#102)
 * @param {(() => Promise<{isolated: boolean, reason?: string, missing?: string[]}>) | null} [deps.describeSandbox]
 *   isolation state for the card of the execution tools (#329)
 * @param {((workspaceRoot: string) => Promise<boolean>) | null} [deps.isSandboxDisabled]
 *   whether the user switched the sandbox off for this workspace (#357)
 * @param {ProgramAllowanceMatcher | null} [deps.matchProgramAllowance]
 *   the program allowance a shell command gets, or why it does not (#408)
 * @param {((workspaceRoot: string | null) => Promise<object[]>) | null} [deps.readProgramAllowances]
 *   the allowances that apply in a workspace (#1119), to notice a change
 *   between plan and run (#408)
 * @param {OutsideAccess} [deps.outsideAccess]  what a card may open outside the open folder (#792)
 */
function createToolCallPlanner({
  fsService,
  fs,
  path,
  protectedRoots = [],
  canTrash = false,
  describeShell = null,
  describeSandbox = null,
  isSandboxDisabled = null,
  matchProgramAllowance = null,
  readProgramAllowances = null,
  outsideAccess,
}) {
  const protectedReal = new Set();
  let protectedResolved = false;

  async function resolveProtectedRoots() {
    if (protectedResolved) return;
    protectedResolved = true;
    for (const root of protectedRoots) {
      if (typeof root !== 'string' || !root.trim()) continue;
      const resolved = path.resolve(root);
      protectedReal.add(resolved);
      try {
        protectedReal.add(await fs.realpath(resolved));
      } catch {
        /* Ordner existiert (noch) nicht — lexikalisch reicht */
      }
    }
  }

  /**
   * @param {string} root
   * @param {string} candidate
   */
  function containsPath(root, candidate) {
    return isPathInside(path, root, candidate);
  }

  /**
   * @param {string} absPath
   */
  function isProtected(absPath) {
    for (const root of protectedReal) {
      if (containsPath(root, absPath)) return true;
    }
    return false;
  }

  /**
   * @param {string} absPath
   */
  async function statTarget(absPath) {
    try {
      const st = await fs.stat(absPath);
      return {
        exists: true,
        isDirectory: st.isDirectory(),
        version: `${st.size}:${Math.round(st.mtimeMs)}`,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists: false, isDirectory: false, version: null };
      throw error;
    }
  }

  /**
   * The grants outside the open folder a call may use (#792, step 4): those
   * the engine passed — from a card for this call or for the session — that
   * may still be opened, as the roots fs-service resolves against.
   *
   * @param {import('../../application/ports/tool-port').OutsideGrant[] | undefined} grants
   */
  async function usableOutsideRoots(grants) {
    if (!outsideAccess || !Array.isArray(grants) || grants.length === 0) return [];
    /** @type {import('../../application/ports/tool-port').OutsideGrant[]} */
    const usable = [];
    for (const grant of grants) {
      if (await outsideAccess.isAllowed(grant, { exact: true })) usable.push(grant);
    }
    return outsideRootsFrom(usable, path);
  }

  /**
   * A target outside the open folder no card has opened yet (#792, step 4),
   * with what a card may offer for it — or null when nothing may be offered.
   *
   * @param {{ rawPath: string, absPath: string, access: 'read' | 'write', descriptor: TargetDescriptor, matcher: ReturnType<typeof createSensitivePathMatcher> }} target
   * @returns {Promise<import('../../application/ports/tool-port').ToolPlanTarget | null>}
   */
  async function outsideTarget({ rawPath, absPath, access, descriptor, matcher }) {
    if (!outsideAccess) return null;
    let stat;
    try {
      stat = await statTarget(absPath);
    } catch {
      return null;
    }
    const isDirectory = stat.exists ? stat.isDirectory : descriptor.kind === 'tree';
    const offers = await outsideAccess.offer({ absPath, isDirectory, access });
    if (offers.length === 0) return null;
    let realAbs = absPath;
    try {
      realAbs = await fsService.resolveExistingRealPath(absPath);
    } catch {
      /* the lexical path, then */
    }
    if (isProtected(absPath) || isProtected(realAbs)) return null;
    const hit = [rawPath, absPath, realAbs].map((p) => matcher.classifyPath(p)).find((h) => h.sensitive);
    return {
      path: rawPath.trim(),
      // Absolute, so that no rule of the open folder reads it as one of its paths.
      rulePaths: [...new Set([absPath, realAbs].map((p) => p.split(path.sep).join('/')))],
      kind: descriptor.kind === 'tree' ? 'tree' : isDirectory ? 'directory' : 'file',
      access,
      exists: stat.exists,
      version: stat.version,
      sensitive: !!hit,
      ...(hit ? { sensitiveReason: hit.pattern } : {}),
      absPath,
      skillName: null,
      outside: { offers },
    };
  }

  /**
   * @param {PlannedTool | null | undefined} definition
   * @param {import('../../application/ports/tool-port').ToolArguments} args
   * @param {Partial<import('../../application/ports/tool-port').ToolPlanContext>} [context]
   * @returns {Promise<import('../../application/ports/tool-port').ToolPlan>}
   */
  async function plan(definition, args, context = {}) {
    const toolName = definition?.name || 'tool';
    if (!definition) {
      return { tool: toolName, error: `Unknown tool: ${toolName}`, reason: PERMISSION_DENIAL_REASONS.UNKNOWN_TOOL, unknownTool: true, riskClasses: [], targets: [] };
    }
    const baseClass = definition.riskClass;
    // Mindestklassen der Definition: Grundklasse plus ergaenzende. Ein Tool
    // kann mehrere Wirkungen zugleich haben — ein MCP-Aufruf ist `execute`
    // *und* `external` (Issue #107), und beide muessen auch auf den
    // Fehlerpfaden in der Karte stehen, sonst zeigt sie zu wenig.
    const baseClasses = [baseClass, ...(definition.additionalRiskClasses || [])];
    const argumentError = validateArguments(definition, args);
    if (argumentError) {
      return { tool: toolName, error: argumentError, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }

    const workspaceRoot = typeof context.workspaceRoot === 'string' ? context.workspaceRoot : '';
    const skillRoots = Array.isArray(context.skillRoots) ? context.skillRoots : [];
    const outsideRoots = await usableOutsideRoots(context.outsideGrants);
    const matcher = createSensitivePathMatcher({ userPatterns: context.sensitivePathPatterns });
    await resolveProtectedRoots();

    // shell_execute (Issue #102): gesperrte Wirkungen und ein Arbeitsordner
    // ausserhalb des Projektordners werden abgelehnt, bevor ueberhaupt eine
    // Freigabekarte erscheint — der Nutzer soll nichts bestaetigen muessen,
    // was ohnehin nicht laufen darf.
    let shellCwd = '';
    /** @type {import('../../application/ports/tool-port').ToolPlan['shellCommand'] | null} */
    let shellCommand = null;
    if (definition.execution === TOOL_EXECUTION_KINDS.SHELL) {
      const guard = checkShellCommand(args?.command);
      if (guard.blocked) {
        return { tool: toolName, error: guard.reason, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...baseClasses], targets: [] };
      }
      const rawCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
      // The workspace only: a skill folder is not a place to run in (#548).
      const resolvedCwd = await fsService.resolveToolPath(workspaceRoot, rawCwd);
      if (isRefused(resolvedCwd)) {
        return { tool: toolName, error: resolvedCwd.error, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...baseClasses], targets: [] };
      }
      shellCwd = resolvedCwd.absPath;
      // The call in the form a remembered command is compared in (#121): the
      // working folder relative to the root, whatever spelling the model used.
      // `command` is null for a command that cannot be remembered at all.
      const relativeCwd = workspaceRoot
        ? path.relative(workspaceRoot, resolvedCwd.absPath).split(path.sep).join('/')
        : rawCwd;
      // A folder that has no rule form cannot be remembered either — never
      // read as the root.
      const ruleCwd = normalizeCommandCwd(relativeCwd);
      shellCommand = {
        command: ruleCwd === null ? null : normalizeRememberableCommand(args?.command),
        cwd: ruleCwd ?? '',
        networkDomains: [...normalizeDomains(args?.network_domains)].sort(),
        stdin: typeof args?.stdin === 'string' && args.stdin.length > 0,
      };
    }

    let descriptors;
    try {
      descriptors = definition.targets(args || {}) || [];
    } catch (error) {
      return { tool: toolName, error: error?.message || 'Could not determine the targets.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }
    if (descriptors && !Array.isArray(descriptors) && descriptors.error) {
      return { tool: toolName, error: descriptors.error, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }
    const isWriteTool = baseClass === TOOL_RISK_CLASSES.WRITE || baseClass === TOOL_RISK_CLASSES.DELETE;
    // Ein Schreib-Tool ohne Ziel waere eines, das an der Pfadpruefung vorbei
    // schreibt — deshalb die Ablehnung. Ausgenommen sind Tools, die gar keinen
    // Pfad aus den Argumenten bilden: Beim Gedaechtnis (#166) waehlt das Modell
    // nur die Ebene, und wohin die zeigt, entscheidet allein der Memory-Port.
    // Da gibt es nichts zu pruefen, weil es nichts zu beeinflussen gibt.
    const descriptorList = Array.isArray(descriptors) ? descriptors : [];
    if (isWriteTool && descriptorList.length === 0 && definition.pathlessWrite !== true) {
      return { tool: toolName, error: 'No target path given.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }

    const classes = new Set(baseClasses);
    for (const cls of context.forcedClasses || []) classes.add(cls);
    /** @type {import('../../application/ports/tool-port').ToolPlanTarget[]} */
    const targets = [];
    /** @type {{ reason: string } | null} */
    let hardLimit = null;
    /** @type {string | undefined} */
    let recovery;

    /**
     * @param {import('../../application/ports/tool-port').ToolPlanTarget} target
     * @param {TargetDescriptor} descriptor
     */
    function applyOverwrite(target, descriptor) {
      if (descriptor.overwrite !== true || !target.exists || target.kind !== 'file') return;
      // Vollständiges Überschreiben: nur mit Wiederherstellungskopie
      // gewöhnliches `write`, sonst `delete` (Konzept §9).
      if (canTrash && !(context.forcedClasses || []).includes(TOOL_RISK_CLASSES.DELETE)) {
        target.recovery = RECOVERY_TRASH;
        recovery = RECOVERY_TRASH;
      } else {
        classes.delete(TOOL_RISK_CLASSES.WRITE);
        classes.add(TOOL_RISK_CLASSES.DELETE);
      }
    }

    for (const descriptor of descriptorList) {
      const rawPath = typeof descriptor.path === 'string' ? descriptor.path : '';
      const access = descriptor.access === 'write' ? 'write' : 'read';
      if (rawPath.trim() === '' && descriptor.kind !== 'tree') {
        return { tool: toolName, error: 'relative_path is required.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...classes], targets: [] };
      }
      // Skill folders are read-only in every mode (concept §5, #548): a write
      // there — as `skill:` path, as an absolute path into the folder of a
      // switched-on skill, or as any path into a global skill folder the open
      // folder contains (#650) — fails here as a hard limit and names the
      // place a skill's data belongs to.
      const resolved = await fsService.resolveToolPath(workspaceRoot, rawPath, { skillRoots, outsideRoots, access });
      if (isRefused(resolved) && resolved.code === OUTSIDE_WORKSPACE && resolved.absPath) {
        // Outside the open folder (#792, step 4): a card may offer it, in
        // every mode. What it may not offer stays a hard limit, and says so.
        const outside = await outsideTarget({ rawPath, absPath: resolved.absPath, access, descriptor, matcher });
        if (!outside && !outsideAccess) {
          return { tool: toolName, error: resolved.error, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...classes], targets: [] };
        }
        if (!outside) {
          return {
            tool: toolName,
            error: `${resolved.error} This location cannot be opened for the file tools: the home folder as a whole, `
              + 'the root of a disk, Snotra\'s own storage, the global skill folders, and for writing places that hold '
              + 'credentials or shell start-up files stay closed.',
            reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT,
            riskClasses: [...classes],
            targets: [],
          };
        }
        if (outside.sensitive) classes.add(TOOL_RISK_CLASSES.READ_SENSITIVE);
        applyOverwrite(outside, descriptor);
        targets.push(outside);
        continue;
      }
      if (isRefused(resolved)) {
        // Ausbruch aus der Wurzel oder unbekannter Skill: harte Grenze, kein
        // „ask“. Fehlender Arbeitsordner ebenso.
        return { tool: toolName, error: resolved.error, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...classes], targets: [] };
      }
      let stat;
      try {
        stat = await statTarget(resolved.absPath);
      } catch (error) {
        return { tool: toolName, error: error?.message || 'Could not check the path.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...classes], targets: [] };
      }
      // Realer Pfad für Sensitivität und Schutzordner: Symlinks können auf
      // Snotra-eigene Dateien oder sensible Orte zeigen.
      let realAbs = resolved.absPath;
      try {
        realAbs = await fsService.resolveExistingRealPath(resolved.absPath);
      } catch {
        /* lexikalischer Pfad reicht dann */
      }
      if (isProtected(resolved.absPath) || isProtected(realAbs)) {
        hardLimit = { reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT };
      }
      const logicalRel = rawPath;
      const realRel = path.relative(resolved.root, realAbs).split(path.sep).join('/');
      const logicalHit = matcher.classifyPath(logicalRel);
      const realHit = matcher.classifyPath(`${resolved.prefix || ''}${realRel}`);
      const sensitive = logicalHit.sensitive || realHit.sensitive;
      // What a rule is matched against (#511): the place the call touches,
      // root-relative — resolved lexically and as its real path — never the
      // spelling the model chose, which may run through `..`, be absolute or
      // take a symlink.
      // The real path is taken relative to the real root, so a root that is
      // itself reached through a symlink (`/var` → `/private/var`) does not
      // turn every real path into one outside it.
      const lexicalRel = path.relative(resolved.root, resolved.absPath).split(path.sep).join('/');
      let realRoot = resolved.root;
      try {
        realRoot = await fsService.resolveExistingRealPath(resolved.root);
      } catch {
        /* the lexical root, then */
      }
      const realRuleRel = path.relative(realRoot, realAbs).split(path.sep).join('/');
      const rulePaths = [...new Set([lexicalRel, realRuleRel].map((rel) => `${resolved.prefix || ''}${rel}`))];
      /** @type {import('../../application/ports/tool-port').ToolPlanTarget} */
      const target = {
        path: rawPath.trim() === '' ? '.' : rawPath.trim(),
        rulePaths,
        kind: descriptor.kind === 'tree' ? 'tree' : stat.isDirectory ? 'directory' : 'file',
        access,
        exists: stat.exists,
        version: stat.version,
        sensitive,
        absPath: resolved.absPath,
        root: resolved.root,
        skillName: resolved.skillName || null,
        // Opened on a card (#792): the log and the card say "outside".
        ...(resolved.outside ? { outsideGranted: true } : {}),
      };
      // The target in the skill's own spelling (#427): an absolute path into
      // a skill folder shows up in the log like a `skill:` path.
      if (resolved.skillName) {
        const rel = path.relative(resolved.root, resolved.absPath).split(path.sep).join('/');
        target.skillPath = `${resolved.prefix || ''}${rel}`.replace(/\/$/, '');
      }
      if (sensitive) {
        target.sensitiveReason = (logicalHit.sensitive ? logicalHit : realHit).pattern;
        classes.add(TOOL_RISK_CLASSES.READ_SENSITIVE);
      }
      // A knowledge file of the open folder (#1319): Snotra embeds it into
      // every later conversation, so a write asks in every mode. Judged by
      // where the call lands, lexically and by its real path.
      if (access === 'write' && !resolved.prefix) {
        const knowledge = workspaceKnowledgeKind(lexicalRel) || workspaceKnowledgeKind(realRuleRel);
        if (knowledge) {
          target.knowledge = knowledge;
          if (knowledge === KNOWLEDGE_FILE_KINDS.RULES && writtenRuleIsAlways(args?.content)) target.knowledgeAlways = true;
        }
      }
      applyOverwrite(target, descriptor);
      targets.push(target);
    }

    const riskClasses = normalizeRiskClasses([...classes]);
    if (!riskClasses) {
      return { tool: toolName, error: 'Invalid risk class.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [], targets: [] };
    }

    // A switched-off sandbox is part of what was approved (#357): the key
    // changes with it, so flipping the switch between card and run is caught
    // by the re-plan after the approval.
    const sandboxDisabled = await readSandboxDisabled(definition.execution, workspaceRoot);
    // So is a program allowance (#408): the card names it, and the run gets
    // exactly the rights the card named or none.
    const allowance = await readProgramAllowance(definition.execution, args, shellCwd, sandboxDisabled, workspaceRoot);
    const planKey = stableStringify({
      tool: toolName,
      args,
      root: workspaceRoot,
      classes: riskClasses,
      targets: targets.map((target) => [target.path, target.absPath, target.version, target.rulePaths]),
      ...(sandboxDisabled ? { sandbox: 'off' } : {}),
      ...(allowance?.allowance ? { allowance: allowance.allowance } : {}),
    });

    /** @type {import('../../application/ports/tool-port').ToolPlan} */
    const result = { tool: toolName, riskClasses, targets, planKey };
    // What the card says about the tool comes from its descriptor (#1008):
    // the renderer reads these fields and never the tool's name.
    result.presentation = normalizeToolPresentation(definition);
    // Targets outside the open folder no card has opened yet (#792, step 4).
    if (targets.some((target) => target.outside)) result.outside = true;
    // A write to a knowledge file: a card in every mode, no stored allowance (#1319).
    if (targets.some((target) => target.knowledge)) result.knowledge = true;
    if (recovery) result.recovery = recovery;
    if (hardLimit) result.hardLimit = hardLimit;
    if (definition.execution) {
      result.sandbox = { disabled: sandboxDisabled, root: workspaceRoot };
      if (allowance?.allowance) {
        result.sandbox.allowance = {
          ...allowance.allowance,
          command: allowance.command,
          entryKey: stableStringify(allowance.entry),
        };
      } else if (allowance?.skipped) {
        result.sandbox.allowanceSkipped = allowance.skipped;
      }
    }
    if (shellCommand) result.shellCommand = shellCommand;
    // Isolation first: its detection waits for the shell detection (#111), so
    // the shell read afterwards is the detected one, not a startup placeholder.
    const isolation = await describeIsolation(definition.execution, args, sandboxDisabled, allowance);
    const shell = typeof describeShell === 'function' ? describeShell() : null;
    const preview = buildPreview(definition.preview, args, {
      locale: context.locale,
      cwd: shellCwd,
      shellLabel: shell?.label || '',
      shellLogin: shell?.login === true,
      isolation,
    });
    // A program runs only when the card could show all of it (#551): an
    // approval of the first 200,000 characters is not one of the program.
    if (preview?.truncated && definition.execution) {
      return {
        tool: toolName,
        error: `The ${definition.execution === TOOL_EXECUTION_KINDS.PYTHON ? 'program' : 'command'} and its input are longer than the approval `
          + `card can show (${PREVIEW_MAX_CHARS.toLocaleString(APP_LOCALES.EN)} characters each). Write it to a file `
          + 'first, or split it.',
        reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS,
        riskClasses: [...riskClasses],
        targets: [],
      };
    }
    if (preview) result.preview = preview;
    return result;
  }

  /**
   * Whether the run would be isolated and which domains it may reach (#329).
   * Asked at plan time so that the card tells the truth: detection runs once
   * per app start and is awaited here, never guessed.
   */
  /**
   * @param {ProgramAllowanceMatch | null} [allowance]
   *
   * @param {string | undefined} execution
   * @param {import('../../application/ports/tool-port').ToolArguments} args
   * @param {boolean} [sandboxDisabled]
   */
  async function describeIsolation(execution, args, sandboxDisabled = false, allowance = null) {
    if (!execution) return null;
    // The user's choice comes before the detection: a run the user took out
    // of the sandbox says so, whatever the sandbox could do (#357).
    if (sandboxDisabled) return { isolated: false, reason: SANDBOX_REASONS.WORKSPACE, missing: [] };
    if (typeof describeSandbox !== 'function') return null;
    const sandbox = await describeSandbox();
    if (sandbox?.isolated === true) {
      const granted = allowance?.allowance || null;
      /** @type {{ isolated: boolean, domains: string[], allowance?: object, allowanceSkipped?: object }} */
      const isolation = { isolated: true, domains: resolveRunDomains(execution, args, granted) };
      if (granted) {
        isolation.allowance = {
          program: granted.program,
          path: granted.path,
          writePaths: granted.writePaths,
          trustd: granted.trustd === true,
          // The variables the run gets (#1262) — their names, for the card.
          credentials: (Array.isArray(granted.credentials) ? granted.credentials : []).map((credential) => credential.name),
        };
      } else if (allowance?.skipped) {
        isolation.allowanceSkipped = allowance.skipped;
      }
      return isolation;
    }
    return {
      isolated: false,
      reason: typeof sandbox?.reason === 'string' ? sandbox.reason : '',
      missing: Array.isArray(sandbox?.missing) ? sandbox.missing : [],
    };
  }

  /**
   * The program allowance of a shell command (#408), or why the one naming
   * its program does not apply. None without a sandbox to widen, and none
   * when anything goes wrong on the way: a failed check never grants.
   */
  /**
   * @returns {Promise<ProgramAllowanceMatch | null>}
   *
   * @param {string | undefined} execution
   * @param {import('../../application/ports/tool-port').ToolArguments} args
   * @param {string} cwd
   * @param {boolean} sandboxDisabled
   * @param {string} workspaceRoot
   */
  async function readProgramAllowance(execution, args, cwd, sandboxDisabled, workspaceRoot) {
    if (execution !== TOOL_EXECUTION_KINDS.SHELL || sandboxDisabled || typeof matchProgramAllowance !== 'function') return null;
    try {
      return (await matchProgramAllowance({ command: args?.command, cwd, workspaceRoot })) || null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the sandbox is switched off for this workspace (#357). Only the
   * execution tools have one; a store that cannot be read keeps it on.
   *
   * @param {string | undefined} execution
   * @param {string} workspaceRoot
   */
  async function readSandboxDisabled(execution, workspaceRoot) {
    if (!execution || typeof isSandboxDisabled !== 'function' || !workspaceRoot) return false;
    try {
      return (await isSandboxDisabled(workspaceRoot)) === true;
    } catch {
      return false;
    }
  }

  /**
   * Prüft unmittelbar vor der Ausführung, ob die Ziele noch dem Plan
   * entsprechen (Größe/Änderungszeit). Ein Austausch während der Freigabe
   * macht diese ungültig (Konzept §5/§6).
   *
   * The same holds for the sandbox switch (#357): in "Auto" no card sits
   * between plan and run, so this is the last place a change is noticed.
   *
   * @param {import('../../application/ports/tool-port').ToolPlan | null | undefined} planned
   */
  async function verifyTargets(planned) {
    if (planned?.sandbox && typeof planned.sandbox === 'object') {
      const now = await readSandboxDisabled(planned.tool, planned.sandbox.root);
      if (now !== (planned.sandbox.disabled === true)) {
        return { ok: false, error: 'The sandbox setting of this workspace changed after the call was planned.' };
      }
      if (planned.sandbox.allowance && !(await allowanceUnchanged(planned.sandbox.allowance, planned.sandbox.root))) {
        return { ok: false, error: 'The program allowance for this command changed after the call was planned.' };
      }
    }
    if (!planned || !Array.isArray(planned.targets)) return { ok: true };
    for (const target of planned.targets) {
      if (target.kind === 'tree' || !target.absPath) continue;
      let stat;
      try {
        stat = await statTarget(target.absPath);
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not check the target.' };
      }
      if (stat.exists !== target.exists || stat.version !== target.version) {
        return { ok: false, error: `Target "${target.path}" has changed since it was approved.` };
      }
    }
    return { ok: true };
  }

  /**
   * The entry an approved allowance came from is still the same (#408) — in
   * the workspace it was planned for, global and own added up (#1119).
   *
   * @param {NonNullable<NonNullable<import('../../application/ports/tool-port').ToolPlan['sandbox']>['allowance']>} granted
   * @param {string} workspaceRoot
   */
  async function allowanceUnchanged(granted, workspaceRoot) {
    if (typeof readProgramAllowances !== 'function') return false;
    let entries;
    try {
      entries = normalizeProgramAllowances(await readProgramAllowances(workspaceRoot || null));
    } catch {
      return false;
    }
    const entry = entries.find((candidate) => candidate.path === granted.path);
    return !!entry && stableStringify(entry) === granted.entryKey;
  }

  return { plan, verifyTargets, validateArguments, buildPreview, outsideRoots: usableOutsideRoots };
}


module.exports = {
  createToolCallPlanner,
  validateArguments,
  buildPreview,
  PREVIEW_MAX_CHARS,
  stableStringify,
  RECOVERY_TRASH,
};
