'use strict';

const { createWorkspaceFileWrittenEvent, createWorkspaceFileReadEvent } = require('../../shared/contracts/chat');
const {
  TOOL_RISK_CLASSES,
  PERMISSION_DENIAL_REASONS,
  createPermissionDeniedToolResult,
} = require('../../shared/contracts/tool-permissions');
const { formatToolDisplayLine } = require('../../shared/presentation/tool-display');
const { TOOL_CATEGORIES } = require('../../shared/contracts/tool-categories');
const { normalizeToolPresentation } = require('../../shared/contracts/tool-presentation');
const { TOOL_CONTENT_SCANS, TOOL_FILE_EVENTS } = require('../tools/tool-descriptor');
const { parseSkillPath } = require('../../shared/runtime/skill-path');
const { LOAD_SKILL_TOOL, workspaceSkillOfPath } = require('../../shared/contracts/skills');
const { checkSkillDocument } = require('../../shared/runtime/skill-frontmatter');
const { APP_LOCALES, translate } = require('../../shared/i18n');
const { menuPath } = require('../../shared/i18n/ui-quotes');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { scanSensitiveContent, containsOwnSecret } = require('../../shared/runtime/sensitive-content');
const { createToolCallPlanner } = require('../tools/tool-call-planner');
const { measureArgumentConformance } = require('../tools/argument-conformance');
const { readRegularFile } = require('../services/read-regular-file');

/*
 * What this adapter does with a call — check its output, leave sensitive
 * entries out of a listing, report the files it read or wrote — is read from
 * the tool's descriptor (#1008): `contentScan`, `broadListing`, `fileEvents`,
 * `mayOverwrite`. See `src/main/tools/tool-descriptor.js`.
 */

/**
 * A tool definition as the adapter reads it; the registry's definitions carry
 * more (handler, schemas, descriptions) and the planner reads those.
 *
 * @typedef {{
 *   name: string,
 *   riskClass: string,
 *   additionalRiskClasses?: string[],
 *   requiresWorkspace?: boolean,
 *   skillPaths?: boolean,
 *   parameters?: object,
 *   category?: string,
 *   approval?: { verb?: string, warning?: string },
 *   display?: { key: string, target: string },
 *   contentScan?: string,
 *   broadListing?: boolean,
 *   fileEvents?: string,
 *   mayOverwrite?: boolean,
 * } & Record<string, any>} ToolDefinition
 *   with the descriptor fields this adapter reads (#1008, `tool-descriptor.js`)
 *
 * The registry (`workspace-tool-registry.js`), derived from its factory
 * (#1098). The adapter calls five members; the two guards
 * `typeof … === 'function'` below are for registry stubs in tests, which
 * implement less than this.
 *
 * @typedef {ReturnType<typeof import('../tools/workspace-tool-registry').createWorkspaceToolRegistry>} ToolRegistry
 *
 * @typedef {import('../tools/tool-call-planner').FsService} FsService
 * @typedef {import('../tools/tool-call-planner').OutsideAccess} OutsideAccess
 */

/**
 * @param {ToolRegistry} toolRegistry  workspace-tool-registry.js
 * @param {object} [deps]
 * @param {FsService} [deps.fsService]  für Planung (Pfadauflösung) und Ausgabeprüfung
 * @param {typeof import('fs/promises')} [deps.fs]
 * @param {typeof import('path')} [deps.path]
 * @param {string[]} [deps.protectedRoots]  harte Grenzen (Snotra-eigener Speicher)
 * @param {(absPath: string) => Promise<void>} [deps.trashItem]  shell.trashItem für Wiederherstellungskopien
 * @param {() => Promise<string[]>} [deps.readOwnSecrets]  konfigurierte Provider-Schlüssel (nur zum Vergleich)
 * @param {(() => {label?: string, login?: boolean}) | null} [deps.describeShell]  erkannte Shell für die Freigabekarte (#102)
 * @param {(() => Promise<{isolated: boolean, reason?: string, missing?: string[]}>) | null} [deps.describeSandbox]
 *   isolation state for the card (#329)
 * @param {((workspaceRoot: string) => Promise<boolean>) | null} [deps.isSandboxDisabled]  per-workspace opt-out (#357)
 * @param {import('../tools/tool-call-planner').ProgramAllowanceMatcher | null} [deps.matchProgramAllowance]  (#408)
 * @param {((workspaceRoot: string) => Promise<object[]>) | null} [deps.readProgramAllowances]  (#408)
 * @param {number} [deps.maxScanBytes]
 * @param {{ record: Function }} [deps.fileChangeRecorder]  keeps before/after of every write (#348)
 * @param {(options?: object) => Promise<void>} [deps.refreshDynamicTools]  the tools only known at run time (#107)
 * @param {OutsideAccess} [deps.outsideAccess]  what a card may open outside the open folder (#792)
 * @returns {import('../../application/ports/tool-port').ToolPort}
 */
function createWorkspaceToolAdapter(toolRegistry, deps = {}) {
  const {
    // No `= null` on the two typed services: a `null` default would make the
    // local an `any` again, and the planner call below unchecked (#1098).
    fsService,
    fs = null,
    path = null,
    protectedRoots = [],
    trashItem = null,
    readOwnSecrets = null,
    describeShell = null,
    describeSandbox = null,
    isSandboxDisabled = null,
    matchProgramAllowance = null,
    readProgramAllowances = null,
    refreshDynamicTools = null,
    fileChangeRecorder = null,
    // What a card may open outside the open folder (#792, step 4).
    outsideAccess,
  } = deps;
  const maxScanBytes = deps.maxScanBytes || 2 * 1024 * 1024;
  /** The tool's definition, which is also its descriptor (#1008); null when unknown. */
  const definitionOf = (name) => (typeof toolRegistry.getDefinition === 'function' ? toolRegistry.getDefinition(name) : null);
  const planner =
    fsService && fs && path
      ? createToolCallPlanner({
          fsService,
          fs,
          path,
          protectedRoots,
          canTrash: typeof trashItem === 'function',
          describeShell,
          describeSandbox,
          isSandboxDisabled,
          matchProgramAllowance,
          readProgramAllowances,
          outsideAccess,
        })
      : null;

  function buildSensitivity(patterns) {
    const matcher = createSensitivePathMatcher({ userPatterns: patterns });
    return {
      isSensitivePath: (relPath) => matcher.isSensitivePath(relPath),
      isSensitiveLine: (text) => scanSensitiveContent(text, { maxChars: 20000 }).sensitive,
    };
  }

  async function scanTargetsForSensitiveContent(name, plan) {
    // Ganze Datei prüfen, nicht nur den Ausschnitt: Token-Muster dürfen
    // nicht durch Zeilen-/Byte-Fenster umgangen werden (Konzept §4).
    if (!fs || !plan || !Array.isArray(plan.targets)) return { sensitive: false, scannable: true };
    if (!definitionOf(name)?.contentScan) return { sensitive: false, scannable: true };
    for (const target of plan.targets) {
      if (target.kind !== 'file' || !target.exists || !target.absPath) continue;
      let read;
      try {
        // Never opens a pipe or device (#643); the tool itself refuses one.
        read = await readRegularFile(fs, target.absPath, { maxBytes: maxScanBytes });
      } catch {
        continue;
      }
      if (read.tooLarge) return { sensitive: false, scannable: false };
      if (!read.buffer) continue;
      const scan = scanSensitiveContent(read.buffer.toString('utf8'), { maxChars: maxScanBytes * 2 });
      if (!scan.scannable) return { sensitive: false, scannable: false };
      if (scan.sensitive) return { sensitive: true, scannable: true, findings: scan.findings };
    }
    return { sensitive: false, scannable: true };
  }

  return {
    /**
     * Vor jedem Lauf: Tools, die nicht fest verdrahtet sind, aktualisieren
     * (Issue #107 — die der MCP-Server). Bewusst hier und nicht in `getTools`,
     * weil das Auffrischen einen Kindprozess starten kann und `getTools`
     * synchron ist.
     *
     * Ein Fehler beim Auffrischen bleibt folgenlos: dann gibt es eben keine
     * oder die zuletzt bekannten MCP-Tools. Ein nicht erreichbarer Server darf
     * den Chat nicht anhalten.
     */
    async prepare() {
      if (typeof refreshDynamicTools !== 'function') return;
      try {
        await refreshDynamicTools();
      } catch {
        /* der Verbindungsstatus zeigt den Grund, der Chat laeuft weiter */
      }
    },
    getTools(options) {
      return toolRegistry.getTools(options);
    },
    buildSystemPrompt(options) {
      return toolRegistry.buildSystemPrompt(options);
    },
    // Braucht das Tool einen geoeffneten Projektordner? Unbekannte Tools gelten
    // als ordnergebunden — die Engine lehnt sie ohne Ordner ab (Issue #96).
    requiresWorkspace(name) {
      const definition = typeof toolRegistry.getDefinition === 'function' ? toolRegistry.getDefinition(name) : null;
      return definition ? definition.requiresWorkspace !== false : true;
    },
    // A stored switch-off never reaches the basic equipment (#195, #552).
    isSwitchedOff(name, disabledNames) {
      if (typeof toolRegistry.isSwitchedOff === 'function') return toolRegistry.isSwitchedOff(name, disabledNames);
      return Array.isArray(disabledNames) && disabledNames.includes(name);
    },
    // Takes `skill:<name>/…` paths, and so works without an open folder while
    // a skill is switched on (#429).
    supportsSkillPaths(name) {
      const definition = typeof toolRegistry.getDefinition === 'function' ? toolRegistry.getDefinition(name) : null;
      return definition ? definition.skillPaths === true : false;
    },
    buildTraceEntry(toolName, args, extra = {}) {
      const definition = definitionOf(toolName);
      /** @type {import('../../application/ports/tool-port').ToolTraceEntry} */
      const entry = { tool: toolName, args, ...extra };
      // The tool's own category, for the icon and the group in the log (#1008).
      // The skill is combined with it where the entry is shown: the engine may
      // learn it only from the plan (#427).
      entry.category = definition?.category || TOOL_CATEGORIES.OTHER;
      // Liest das Tool aus einem Skill-Verzeichnis (Issue #61), merkt sich der
      // Eintrag den Skill-Namen — daraus wird im Chat die Skill-Kategorie.
      // `load_skill` trägt den Namen im Argument statt im Pfad (Issue #173).
      if (toolName === LOAD_SKILL_TOOL) {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (name) entry.skill = name;
      } else {
        const skill = parseSkillPath(args?.relative_path);
        if (skill) entry.skill = skill.name;
        // A write into a skill of the open folder is a skill step too (#160);
        // the category turns it into "skill file written".
        const written = writesSkillFiles(definition) ? workspaceSkillOfPath(args?.relative_path) : null;
        if (written) entry.skill = written.name;
      }
      return entry;
    },
    // Counts schema violations the planner lets through (#187): unknown
    // properties, non-integers, mismatching array items. A measurement only —
    // the call runs or is refused exactly as before.
    measureArguments(name, args) {
      const definition = typeof toolRegistry.getDefinition === 'function' ? toolRegistry.getDefinition(name) : null;
      return definition ? measureArgumentConformance(definition, args) : null;
    },
    formatDisplayLine(entry, phase, locale) {
      return formatToolDisplayLine(entry, phase, locale, definitionOf(entry?.tool)?.display || null);
    },
    /**
     * @param {string} name
     * @param {import('../../application/ports/tool-port').ToolArguments} args
     * @param {Partial<import('../../application/ports/tool-port').ToolPlanContext>} [context]
     */
    async plan(name, args, context = {}) {
      const definition = typeof toolRegistry.getDefinition === 'function' ? toolRegistry.getDefinition(name) : null;
      if (!definition) {
        return { tool: name, error: `Unknown tool: ${name}`, reason: PERMISSION_DENIAL_REASONS.UNKNOWN_TOOL, unknownTool: true, riskClasses: [], targets: [] };
      }
      if (!planner) {
        // Ohne Dateisystem-Zugang (Tests mit Registry-Stubs) bleibt nur die
        // Mindestklasse; Ziele können nicht geprüft werden.
        return {
          tool: name,
          // Alle Mindestklassen, nicht nur die Grundklasse: ein MCP-Aufruf ist
          // `execute` *und* `external` (Issue #107). Auch dieser Notpfad darf
          // die Wirkung nicht kleiner aussehen lassen, als sie ist.
          riskClasses: [definition.riskClass, ...(definition.additionalRiskClasses || [])],
          targets: [],
          planKey: JSON.stringify([name, args]),
          presentation: normalizeToolPresentation(definition),
        };
      }
      return planner.plan(definition, args, context);
    },
    /**
     * @param {string} name
     * @param {import('../../application/ports/tool-port').ToolArguments} args
     * @param {Partial<import('../../application/ports/tool-port').ToolExecutionContext>} [context]
     */
    async execute(name, args, context = {}) {
      const plan = context.plan || null;
      if (planner && plan) {
        const check = await planner.verifyTargets(plan);
        if (!check.ok) {
          return {
            output: createPermissionDeniedToolResult({
              reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED,
              message: check.error,
            }),
            progressEvents: [],
            invalidated: true,
          };
        }
      }
      const riskClasses = Array.isArray(context.riskClasses) ? context.riskClasses : plan?.riskClasses || [];
      const definition = definitionOf(name);
      const contentScan = definition?.contentScan || null;
      // What the writing tools wrote, before and after (#348). Recorded only
      // once the call has come back without an error.
      const writes = [];
      // What the sandbox refused during a shell or Python run (#792).
      let sandboxBlocked = null;
      const handlerContext = {
        ...context,
        // What a card opened outside the open folder (#792, step 4), checked
        // again and turned into the roots fs-service resolves against.
        outsideRoots: planner ? await planner.outsideRoots(context.outsideGrants) : [],
        onWritten: writesFiles(definition) && fileChangeRecorder ? (written) => writes.push(written) : undefined,
        onSandboxBlocked: (summary) => { sandboxBlocked = summary; },
        sensitivity: definition?.broadListing === true ? buildSensitivity(context.sensitivePathPatterns || plan?.sensitivePathPatterns) : undefined,
        recovery:
          definition?.mayOverwrite === true
            ? {
                trashItem: typeof trashItem === 'function' ? trashItem : null,
                // Ohne Papierkorb wurde der Aufruf als `delete` freigegeben —
                // dann darf ohne Kopie überschrieben werden.
                allowUnrecoverable: riskClasses.includes(TOOL_RISK_CLASSES.DELETE),
              }
            : undefined,
      };
      let output = await toolRegistry.execute(name, args, handlerContext);

      /** @type {Record<string, any> | null} */
      let parsed = null;
      try {
        parsed = JSON.parse(output);
      } catch {
        parsed = null;
      }
      if (parsed && parsed.error && parsed.code === 'recovery_failed') {
        // Wiederherstellungskopie fehlgeschlagen: nicht geschrieben, Aufruf ist
        // jetzt `delete` und läuft erneut durch die Policy (Konzept §9).
        return { output, progressEvents: [], reclassify: [TOOL_RISK_CLASSES.DELETE] };
      }

      // A SKILL.md written into the open folder is checked the way the
      // catalog will check it, so the model learns about a broken skill now
      // and not the user, later, as a greyed-out row (#160).
      const skillChecks = await checkWrittenSkills(definition, args, parsed, context);
      if (skillChecks.length) {
        parsed = { ...parsed, skill_check: skillChecks.length === 1 ? skillChecks[0] : skillChecks };
        output = JSON.stringify(parsed);
      }

      const fileChanges = recordFileChanges(writes, parsed);
      const progressEvents = collectProgressEvents(definition, args, output, fileChanges);

      // Harte Grenze: eigene Provider-Schlüssel dürfen die App nie verlassen,
      // auch nicht über eine vom Nutzer freigegebene Datei (Konzept §5).
      // A list that cannot be read withholds the output as well: compared
      // against nothing, it would pass unchecked (#976).
      if (typeof readOwnSecrets === 'function' && context.ownSecretsCheck !== false) {
        /** @type {string[] | null} */
        let secrets = null;
        try {
          secrets = await readOwnSecrets();
        } catch {
          secrets = null;
        }
        if (!Array.isArray(secrets)) {
          return {
            output: createPermissionDeniedToolResult({ reason: PERMISSION_DENIAL_REASONS.OWN_SECRET_CHECK_FAILED }),
            progressEvents: [],
            hardLimit: { reason: PERMISSION_DENIAL_REASONS.OWN_SECRET_CHECK_FAILED },
          };
        }
        if (containsOwnSecret(output, secrets)) {
          return {
            output: createPermissionDeniedToolResult({ reason: PERMISSION_DENIAL_REASONS.OWN_SECRET }),
            progressEvents: [],
            hardLimit: { reason: PERMISSION_DENIAL_REASONS.OWN_SECRET },
          };
        }
      }

      // Zweite Prüfstelle (Konzept §4): Ausgabe und ganze Quelldatei prüfen.
      let sensitive = false;
      if (contentScan && !(parsed && parsed.error)) {
        const outputScan = scanSensitiveContent(output, { maxChars: maxScanBytes * 2 });
        if (outputScan.sensitive) sensitive = true;
        // The JSON escapes the quotes a key pattern looks for; the extracted
        // text is all there is to check for these tools, so check it unescaped.
        if (!sensitive && contentScan === TOOL_CONTENT_SCANS.DECODED && typeof parsed?.content === 'string') {
          if (scanSensitiveContent(parsed.content, { maxChars: maxScanBytes * 2 }).sensitive) sensitive = true;
        }
        if (!sensitive && contentScan === TOOL_CONTENT_SCANS.SOURCE) {
          const fileScan = await scanTargetsForSensitiveContent(name, plan);
          if (!fileScan.scannable) {
            return {
              output: JSON.stringify({
                error: 'File too large to check for sensitive content; output withheld.',
              }),
              progressEvents: [],
            };
          }
          if (fileScan.sensitive) sensitive = true;
        }
      }

      const result = { output, progressEvents };
      if (fileChanges.length) result.fileChanges = fileChanges;
      if (sandboxBlocked) result.sandboxBlocked = sandboxBlocked;
      if (sensitive) result.sensitive = true;
      return result;
    },
  };

  /**
   * The verdict on every `SKILL.md` a successful write left in the open
   * folder's skill source (`.agents/skills/<name>/SKILL.md`), in the words the
   * model reads: English, with the menu path in the user's language because
   * the model passes it on.
   */
  async function checkWrittenSkills(definition, args, parsed, context) {
    if (!writesFiles(definition) || !fs || !path || !parsed || parsed.error) return [];
    const root = typeof context.workspaceRoot === 'string' && context.workspaceRoot.trim()
      ? path.resolve(context.workspaceRoot)
      : null;
    if (!root) return [];
    const checks = [];
    for (const written of writtenRelativePaths(definition, args, parsed)) {
      if (parseSkillPath(written)) continue;
      const absPath = path.resolve(root, written);
      const rel = path.relative(root, absPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const skill = workspaceSkillOfPath(rel);
      if (!skill || skill.file !== SKILL_FILE) continue;
      let read;
      try {
        read = await readRegularFile(fs, absPath, { maxBytes: maxScanBytes });
      } catch {
        continue;
      }
      if (!read.buffer) continue;
      checks.push(describeSkillCheck(skill.name, checkSkillDocument(read.buffer.toString('utf8'), skill.name), context.locale));
    }
    return checks;
  }

  /** Hands the writes of a successful call to the recorder; their summaries. */
  function recordFileChanges(writes, parsed) {
    if (!writes.length || !fileChangeRecorder || !parsed || parsed.error) return [];
    const summaries = [];
    for (const written of writes) {
      try {
        summaries.push(fileChangeRecorder.record(written));
      } catch (err) {
        console.warn('Recording a file change failed:', err?.message ?? err);
      }
    }
    return summaries;
  }
}

/** The file that makes a folder a skill — mirrored from `skills-service.js`. */
const SKILL_FILE = 'SKILL.md';

/**
 * What the model is told about a skill it has just written (#160). A valid
 * one still has to be switched on by the user — folder skills start off — so
 * the note says where; an invalid one is skipped by the catalog until fixed.
 */
function describeSkillCheck(name, checked, locale) {
  if (checked.ok) {
    return {
      skill: name,
      valid: true,
      note: `Valid skill of this folder. Folder skills start switched off: the user turns it on under `
        + `"${menuPath(locale, 'settings.skills')}" — tell them, unless it is on already.`,
    };
  }
  return {
    skill: name,
    valid: false,
    problem: translate(APP_LOCALES.EN, checked.key, checked.params),
    note: 'Not a usable skill yet: the catalog skips it until SKILL.md is fixed. Fix it now.',
  };
}

/** Whether a tool writes files of the workspace, whose result the tree shows. */
function writesFiles(definition) {
  return definition?.fileEvents === TOOL_FILE_EVENTS.WRITE || definition?.fileEvents === TOOL_FILE_EVENTS.WRITE_ARGS;
}

/** The file tools a skill is written with (#160); an image stays an image. */
function writesSkillFiles(definition) {
  return writesFiles(definition) && definition.category === TOOL_CATEGORIES.WRITE;
}

/**
 * Welche Dateien hat der Aufruf geschrieben? Bis Issue #158 wurde nur
 * `write_file_text` gemeldet — `edit_file` und `apply_patch` liefen still
 * durch, und die Vorschau der offenen Datei zeigte weiter den alten Inhalt.
 *
 * Gefragt wird das Ergebnis, nicht die Argumente: `apply_patch` im
 * Diff-Modus kennt seine Pfade erst aus dem Patch, und ein Aufruf, der nichts
 * geschrieben hat, meldet so auch nichts.
 */
function writtenRelativePaths(definition, args, parsed) {
  const paths = [];
  if (definition?.fileEvents === TOOL_FILE_EVENTS.WRITE_ARGS) {
    // Der einzige Fall ohne Pfad im Ergebnis — er steht nur im Aufruf.
    const fromArgs = typeof args?.relative_path === 'string' ? args.relative_path.trim() : '';
    if (fromArgs) paths.push(fromArgs);
    return paths;
  }
  if (typeof parsed?.relative_path === 'string' && parsed.relative_path.trim()) {
    paths.push(parsed.relative_path.trim());
  }
  // apply_patch im Diff-Modus: ein Aufruf, mehrere Dateien.
  for (const entry of Array.isArray(parsed?.files) ? parsed.files : []) {
    const rel = typeof entry?.relative_path === 'string' ? entry.relative_path.trim() : '';
    if (rel) paths.push(rel);
  }
  return paths;
}

/**
 * The workspace path a reading tool read, or null. A `skill:` path lies
 * outside the open folder (#429) and has no row in the tree.
 */
function readRelativePath(args) {
  const rel = typeof args?.relative_path === 'string' ? args.relative_path.trim() : '';
  if (!rel || parseSkillPath(rel)) return null;
  return rel;
}

/**
 * The file events of a call (#158, #347). A read marks one file in the tree;
 * a search is not a read (its descriptor has no `fileEvents`), and what the
 * agent opens after it is marked anyway.
 */
function collectProgressEvents(definition, args, output, fileChanges = []) {
  const events = [];
  const reads = definition?.fileEvents === TOOL_FILE_EVENTS.READ;
  if (!writesFiles(definition) && !reads) return events;
  /** @type {Record<string, any> | null} */
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    return events;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.error) return events;
  if (reads) {
    const relativePath = readRelativePath(args);
    if (relativePath) events.push(createWorkspaceFileReadEvent(relativePath));
    return events;
  }
  for (const relativePath of new Set(writtenRelativePaths(definition, args, parsed))) {
    const change = fileChanges.find((entry) => entry.relativePath === relativePath) || null;
    events.push(createWorkspaceFileWrittenEvent(relativePath, change));
  }
  return events;
}

module.exports = {
  createWorkspaceToolAdapter,
};
