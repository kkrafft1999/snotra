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
} = require('../../shared/contracts/tool-permissions');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { maskSensitiveContent } = require('../../shared/runtime/sensitive-content');
const { parseSkillPath } = require('../../shared/runtime/skill-path');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const { resolveNetworkDomains } = require('../../shared/runtime/sandbox-domains');

const PREVIEW_MAX_CHARS = 4000;
const RECOVERY_TRASH = 'trash';

function buildPreview(toolName, args, options = {}) {
  let kind = 'text';
  let text = '';
  let extra = null;
  if (toolName === 'write_file_text') {
    text = typeof args?.content === 'string' ? args.content : '';
  } else if (toolName === 'edit_file') {
    kind = 'replace';
    const all = args?.replace_all === true ? ' (alle Vorkommen)' : '';
    text = `--- alt${all}\n${String(args?.old_string ?? '')}\n+++ neu\n${String(args?.new_string ?? '')}`;
  } else if (toolName === 'apply_patch') {
    kind = 'diff';
    if (typeof args?.patch === 'string') {
      text = args.patch;
    } else if (Array.isArray(args?.edits)) {
      text = args.edits
        .map((edit, index) => {
          const all = edit?.replace_all === true ? ' (alle Vorkommen)' : '';
          return `# Schritt ${index + 1}${all}\n--- alt\n${String(edit?.old_string ?? '')}\n+++ neu\n${String(edit?.new_string ?? '')}`;
        })
        .join('\n\n');
    }
  } else if (toolName === 'run_python') {
    // Ohne den Quelltext waere die Freigabe eine Blankounterschrift (Issue #86).
    kind = 'code';
    text = typeof args?.code === 'string' ? args.code : '';
    if (options.isolation) extra = { isolation: options.isolation };
  } else if (toolName === 'shell_execute') {
    // Der Nutzer soll sehen, *was* laeuft und *womit* (Issue #102): Befehl,
    // erkannte Shell und Arbeitsordner gehoeren zusammen auf die Karte.
    kind = 'shell';
    text = typeof args?.command === 'string' ? args.command : '';
    extra = {
      shell: typeof options.shellLabel === 'string' ? options.shellLabel : '',
      shellLogin: options.shellLogin === true,
      cwd: typeof options.cwd === 'string' ? options.cwd : '',
      ...(options.isolation ? { isolation: options.isolation } : {}),
    };
  } else if (toolName === 'remember') {
    // Der Nutzer entscheidet hier ueber einen Satz, der ab jetzt in *jeder*
    // Anfrage steht (Issue #166). Ohne den Satz und die Reichweite waere die
    // Freigabe eine Blankounterschrift — und ein Pfad steht nicht zur
    // Verfuegung, weil das Tool keinen bildet.
    kind = 'memory';
    text = typeof args?.text === 'string' ? args.text : '';
    extra = { memoryScope: args?.scope === 'user' ? 'user' : 'workspace' };
  } else {
    return null;
  }
  const masked = maskSensitiveContent(text);
  const truncated = masked.length > PREVIEW_MAX_CHARS;
  return {
    kind,
    text: truncated ? `${masked.slice(0, PREVIEW_MAX_CHARS)}\n… [gekürzt]` : masked,
    truncated,
    masked: masked !== text,
    ...(extra || {}),
  };
}

/**
 * Minimale Argumentprüfung gegen das JSON-Schema der Definition: Pflichtfelder
 * müssen vorhanden sein und den deklarierten Grundtyp haben. Ungültige
 * Argumente werden blockiert, nicht „irgendwie“ ausgeführt.
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
  }
  return null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * @param {object} deps
 * @param {object} deps.fsService  liefert resolveToolPath und listApplyPatchTargets
 * @param {object} deps.fs  fs/promises
 * @param {object} deps.path
 * @param {string[]} [deps.protectedRoots]  absolute Ordner, die für Tools hart gesperrt sind (userData)
 * @param {boolean} [deps.canTrash]  ob eine Wiederherstellungskopie in den Papierkorb möglich ist
 * @param {() => {label?: string, login?: boolean}} [deps.describeShell]  erkannte Shell für die Vorschau (#102)
 * @param {() => Promise<{isolated: boolean, reason?: string, missing?: string[]}>} [deps.describeSandbox]
 *   isolation state for the card of the execution tools (#329)
 */
function createToolCallPlanner({
  fsService,
  fs,
  path,
  protectedRoots = [],
  canTrash = false,
  describeShell = null,
  describeSandbox = null,
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

  function containsPath(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function isProtected(absPath) {
    for (const root of protectedReal) {
      if (containsPath(root, absPath)) return true;
    }
    return false;
  }

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
    const matcher = createSensitivePathMatcher({ userPatterns: context.sensitivePathPatterns });
    await resolveProtectedRoots();

    // shell_execute (Issue #102): gesperrte Wirkungen und ein Arbeitsordner
    // ausserhalb des Projektordners werden abgelehnt, bevor ueberhaupt eine
    // Freigabekarte erscheint — der Nutzer soll nichts bestaetigen muessen,
    // was ohnehin nicht laufen darf.
    let shellCwd = '';
    if (toolName === 'shell_execute') {
      const guard = checkShellCommand(args?.command);
      if (guard.blocked) {
        return { tool: toolName, error: guard.reason, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...baseClasses], targets: [] };
      }
      const rawCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
      const resolvedCwd = await fsService.resolveToolPath(workspaceRoot, rawCwd);
      if (resolvedCwd.error) {
        return { tool: toolName, error: resolvedCwd.error, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...baseClasses], targets: [] };
      }
      shellCwd = resolvedCwd.absPath;
    }

    let descriptors;
    try {
      descriptors = definition.targets(args || {}) || [];
    } catch (error) {
      return { tool: toolName, error: error?.message || 'Could not determine the targets.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }
    if (descriptors && descriptors.error) {
      return { tool: toolName, error: descriptors.error, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }
    const isWriteTool = baseClass === TOOL_RISK_CLASSES.WRITE || baseClass === TOOL_RISK_CLASSES.DELETE;
    // Ein Schreib-Tool ohne Ziel waere eines, das an der Pfadpruefung vorbei
    // schreibt — deshalb die Ablehnung. Ausgenommen sind Tools, die gar keinen
    // Pfad aus den Argumenten bilden: Beim Gedaechtnis (#166) waehlt das Modell
    // nur die Ebene, und wohin die zeigt, entscheidet allein der Memory-Port.
    // Da gibt es nichts zu pruefen, weil es nichts zu beeinflussen gibt.
    if (isWriteTool && descriptors.length === 0 && definition.pathlessWrite !== true) {
      return { tool: toolName, error: 'No target path given.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...baseClasses], targets: [] };
    }

    const classes = new Set(baseClasses);
    for (const cls of context.forcedClasses || []) classes.add(cls);
    const targets = [];
    let hardLimit = null;
    let recovery;

    for (const descriptor of descriptors) {
      const rawPath = typeof descriptor.path === 'string' ? descriptor.path : '';
      const access = descriptor.access === 'write' ? 'write' : 'read';
      if (access === 'write' && parseSkillPath(rawPath)) {
        // Skill-Wurzeln sind in jedem Modus schreibgeschützt (Konzept §5).
        return { tool: toolName, error: 'Skill folders are read-only.', reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...classes], targets: [] };
      }
      if (rawPath.trim() === '' && descriptor.kind !== 'tree') {
        return { tool: toolName, error: 'relative_path is required.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...classes], targets: [] };
      }
      const resolved = await fsService.resolveToolPath(
        workspaceRoot,
        rawPath,
        access === 'read' ? { skillRoots } : {}
      );
      if (resolved.error) {
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
      const target = {
        path: rawPath.trim() === '' ? '.' : rawPath.trim(),
        kind: descriptor.kind === 'tree' ? 'tree' : stat.isDirectory ? 'directory' : 'file',
        access,
        exists: stat.exists,
        version: stat.version,
        sensitive,
        absPath: resolved.absPath,
        root: resolved.root,
        skillName: resolved.skillName || null,
      };
      if (sensitive) {
        target.sensitiveReason = (logicalHit.sensitive ? logicalHit : realHit).pattern;
        classes.add(TOOL_RISK_CLASSES.READ_SENSITIVE);
      }
      if (descriptor.overwrite === true && stat.exists && !stat.isDirectory) {
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
      targets.push(target);
    }

    const riskClasses = normalizeRiskClasses([...classes]);
    if (!riskClasses) {
      return { tool: toolName, error: 'Invalid risk class.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [], targets: [] };
    }

    const planKey = stableStringify({
      tool: toolName,
      args,
      root: workspaceRoot,
      classes: riskClasses,
      targets: targets.map((target) => [target.path, target.absPath, target.version]),
    });

    const result = { tool: toolName, riskClasses, targets, planKey };
    if (recovery) result.recovery = recovery;
    if (hardLimit) result.hardLimit = hardLimit;
    const shell = typeof describeShell === 'function' ? describeShell() : null;
    const preview = buildPreview(toolName, args, {
      cwd: shellCwd,
      shellLabel: shell?.label || '',
      shellLogin: shell?.login === true,
      isolation: await describeIsolation(toolName, args),
    });
    if (preview) result.preview = preview;
    return result;
  }

  /**
   * Whether the run would be isolated and which domains it may reach (#329).
   * Asked at plan time so that the card tells the truth: detection runs once
   * per app start and is awaited here, never guessed.
   */
  async function describeIsolation(toolName, args) {
    if (toolName !== 'shell_execute' && toolName !== 'run_python') return null;
    if (typeof describeSandbox !== 'function') return null;
    const sandbox = await describeSandbox();
    if (sandbox?.isolated === true) {
      return { isolated: true, domains: resolveNetworkDomains(toolName, args) };
    }
    return {
      isolated: false,
      reason: typeof sandbox?.reason === 'string' ? sandbox.reason : '',
      missing: Array.isArray(sandbox?.missing) ? sandbox.missing : [],
    };
  }

  /**
   * Prüft unmittelbar vor der Ausführung, ob die Ziele noch dem Plan
   * entsprechen (Größe/Änderungszeit). Ein Austausch während der Freigabe
   * macht diese ungültig (Konzept §5/§6).
   */
  async function verifyTargets(planned) {
    if (!planned || !Array.isArray(planned.targets)) return { ok: true };
    for (const target of planned.targets) {
      if (target.kind === 'tree') continue;
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

  return { plan, verifyTargets, validateArguments, buildPreview };
}

module.exports = {
  createToolCallPlanner,
  validateArguments,
  buildPreview,
  stableStringify,
  RECOVERY_TRASH,
};
