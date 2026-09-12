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
  } else if (toolName === 'shell_execute') {
    // Der Nutzer soll sehen, *was* laeuft und *womit* (Issue #102): Befehl,
    // erkannte Shell und Arbeitsordner gehoeren zusammen auf die Karte.
    kind = 'shell';
    text = typeof args?.command === 'string' ? args.command : '';
    extra = {
      shell: typeof options.shellLabel === 'string' ? options.shellLabel : '',
      shellLogin: options.shellLogin === true,
      cwd: typeof options.cwd === 'string' ? options.cwd : '',
    };
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
    return 'Argumente müssen ein Objekt sein.';
  }
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return `Argument „${key}“ ist erforderlich.`;
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    const expected = spec.type;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected === 'string' && actual !== 'string') return `Argument „${key}“ muss Text sein.`;
    if ((expected === 'integer' || expected === 'number') && actual !== 'number') {
      return `Argument „${key}“ muss eine Zahl sein.`;
    }
    if (expected === 'boolean' && actual !== 'boolean') return `Argument „${key}“ muss true/false sein.`;
    if (expected === 'array' && actual !== 'array') return `Argument „${key}“ muss eine Liste sein.`;
    if (expected === 'object' && actual !== 'object') return `Argument „${key}“ muss ein Objekt sein.`;
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
 */
function createToolCallPlanner({
  fsService,
  fs,
  path,
  protectedRoots = [],
  canTrash = false,
  describeShell = null,
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
      return { tool: toolName, error: `Unbekanntes Tool: ${toolName}`, reason: PERMISSION_DENIAL_REASONS.UNKNOWN_TOOL, unknownTool: true, riskClasses: [], targets: [] };
    }
    const baseClass = definition.riskClass;
    const argumentError = validateArguments(definition, args);
    if (argumentError) {
      return { tool: toolName, error: argumentError, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [baseClass], targets: [] };
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
        return { tool: toolName, error: guard.reason, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [baseClass], targets: [] };
      }
      const rawCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
      const resolvedCwd = await fsService.resolveToolPath(workspaceRoot, rawCwd);
      if (resolvedCwd.error) {
        return { tool: toolName, error: resolvedCwd.error, reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [baseClass], targets: [] };
      }
      shellCwd = resolvedCwd.absPath;
    }

    let descriptors;
    try {
      descriptors = definition.targets(args || {}) || [];
    } catch (error) {
      return { tool: toolName, error: error?.message || 'Ziele nicht bestimmbar.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [baseClass], targets: [] };
    }
    if (descriptors && descriptors.error) {
      return { tool: toolName, error: descriptors.error, reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [baseClass], targets: [] };
    }
    const isWriteTool = baseClass === TOOL_RISK_CLASSES.WRITE || baseClass === TOOL_RISK_CLASSES.DELETE;
    if (isWriteTool && descriptors.length === 0) {
      return { tool: toolName, error: 'Kein Zielpfad angegeben.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [baseClass], targets: [] };
    }

    const classes = new Set([baseClass]);
    for (const cls of context.forcedClasses || []) classes.add(cls);
    const targets = [];
    let hardLimit = null;
    let recovery;

    for (const descriptor of descriptors) {
      const rawPath = typeof descriptor.path === 'string' ? descriptor.path : '';
      const access = descriptor.access === 'write' ? 'write' : 'read';
      if (access === 'write' && parseSkillPath(rawPath)) {
        // Skill-Wurzeln sind in jedem Modus schreibgeschützt (Konzept §5).
        return { tool: toolName, error: 'Skill-Verzeichnisse sind schreibgeschützt.', reason: PERMISSION_DENIAL_REASONS.HARD_LIMIT, riskClasses: [...classes], targets: [] };
      }
      if (rawPath.trim() === '' && descriptor.kind !== 'tree') {
        return { tool: toolName, error: 'relative_path ist erforderlich.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...classes], targets: [] };
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
        return { tool: toolName, error: error?.message || 'Pfad nicht prüfbar.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [...classes], targets: [] };
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
      return { tool: toolName, error: 'Ungültige Risikoklasse.', reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses: [], targets: [] };
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
    });
    if (preview) result.preview = preview;
    return result;
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
        return { ok: false, error: error?.message || 'Ziel nicht prüfbar.' };
      }
      if (stat.exists !== target.exists || stat.version !== target.version) {
        return { ok: false, error: `Ziel „${target.path}“ hat sich seit der Freigabe geändert.` };
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
