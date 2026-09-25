'use strict';

const { createWorkspaceFileWrittenEvent } = require('../../shared/contracts/chat');
const {
  TOOL_RISK_CLASSES,
  PERMISSION_DENIAL_REASONS,
  createPermissionDeniedToolResult,
} = require('../../shared/contracts/tool-permissions');
const { formatToolDisplayLine } = require('../../shared/presentation/tool-display');
const { parseSkillPath } = require('../../shared/runtime/skill-path');
const { LOAD_SKILL_TOOL } = require('../../shared/contracts/skills');
const { createSensitivePathMatcher } = require('../../shared/runtime/sensitive-paths');
const { scanSensitiveContent, containsOwnSecret } = require('../../shared/runtime/sensitive-content');
const { createToolCallPlanner } = require('../tools/tool-call-planner');

/** Tools, deren Ausgabe Dateiinhalte enthalten kann und deshalb geprüft wird. */
const CONTENT_READ_TOOLS = new Set(['read_file_text', 'read_file_lines', 'outline_file', 'search_in_files']);
/** Tools mit breiter Auflistung: sensible Einträge werden ausgelassen statt erfragt. */
const BROAD_LISTING_TOOLS = new Set(['list_directory', 'list_directory_tree', 'find_files', 'search_in_files']);

/**
 * @param {object} toolRegistry
 * @param {object} [deps]
 * @param {object} [deps.fsService]  für Planung (Pfadauflösung) und Ausgabeprüfung
 * @param {object} [deps.fs]  fs/promises
 * @param {object} [deps.path]
 * @param {string[]} [deps.protectedRoots]  harte Grenzen (Snotra-eigener Speicher)
 * @param {(absPath: string) => Promise<void>} [deps.trashItem]  shell.trashItem für Wiederherstellungskopien
 * @param {() => Promise<string[]>} [deps.readOwnSecrets]  konfigurierte Provider-Schlüssel (nur zum Vergleich)
 * @param {() => {label?: string, login?: boolean}} [deps.describeShell]  erkannte Shell für die Freigabekarte (#102)
 * @param {() => Promise<object>} [deps.describeSandbox]  isolation state for the card (#329)
 * @param {number} [deps.maxScanBytes]
 */
function createWorkspaceToolAdapter(toolRegistry, deps = {}) {
  const {
    fsService = null,
    fs = null,
    path = null,
    protectedRoots = [],
    trashItem = null,
    readOwnSecrets = null,
    describeShell = null,
    describeSandbox = null,
    refreshDynamicTools = null,
  } = deps;
  const maxScanBytes = deps.maxScanBytes || 2 * 1024 * 1024;
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
    if (!CONTENT_READ_TOOLS.has(name)) return { sensitive: false, scannable: true };
    for (const target of plan.targets) {
      if (target.kind !== 'file' || !target.exists || !target.absPath) continue;
      let buf;
      try {
        const st = await fs.stat(target.absPath);
        if (st.size > maxScanBytes) return { sensitive: false, scannable: false };
        buf = await fs.readFile(target.absPath);
      } catch {
        continue;
      }
      const scan = scanSensitiveContent(buf.toString('utf8'), { maxChars: maxScanBytes * 2 });
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
    buildTraceEntry(toolName, args, extra = {}) {
      const entry = { tool: toolName, args, ...extra };
      // Liest das Tool aus einem Skill-Verzeichnis (Issue #61), merkt sich der
      // Eintrag den Skill-Namen — daraus wird im Chat die Skill-Kategorie.
      // `load_skill` trägt den Namen im Argument statt im Pfad (Issue #173).
      if (toolName === LOAD_SKILL_TOOL) {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (name) entry.skill = name;
      } else {
        const skill = parseSkillPath(args?.relative_path);
        if (skill) entry.skill = skill.name;
      }
      return entry;
    },
    formatDisplayLine(entry, phase, locale) {
      return formatToolDisplayLine(entry, phase, locale);
    },
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
        };
      }
      return planner.plan(definition, args, context);
    },
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
      const handlerContext = {
        ...context,
        sensitivity: BROAD_LISTING_TOOLS.has(name) ? buildSensitivity(context.sensitivePathPatterns || plan?.sensitivePathPatterns) : undefined,
        recovery:
          name === 'write_file_text'
            ? {
                trashItem: typeof trashItem === 'function' ? trashItem : null,
                // Ohne Papierkorb wurde der Aufruf als `delete` freigegeben —
                // dann darf ohne Kopie überschrieben werden.
                allowUnrecoverable: riskClasses.includes(TOOL_RISK_CLASSES.DELETE),
              }
            : undefined,
      };
      const output = await toolRegistry.execute(name, args, handlerContext);

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

      const progressEvents = collectProgressEvents(name, args, output);

      // Harte Grenze: eigene Provider-Schlüssel dürfen die App nie verlassen,
      // auch nicht über eine vom Nutzer freigegebene Datei (Konzept §5).
      if (typeof readOwnSecrets === 'function' && context.ownSecretsCheck !== false) {
        let secrets = [];
        try {
          secrets = await readOwnSecrets();
        } catch {
          secrets = [];
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
      if (CONTENT_READ_TOOLS.has(name) && !(parsed && parsed.error)) {
        const outputScan = scanSensitiveContent(output, { maxChars: maxScanBytes * 2 });
        if (outputScan.sensitive) sensitive = true;
        if (!sensitive && !BROAD_LISTING_TOOLS.has(name)) {
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
      if (sensitive) result.sensitive = true;
      return result;
    },
  };
}

/** Tools, die im Workspace schreiben und deren Ergebnis den Baum betrifft. */
const WRITING_TOOLS = new Set(['write_file_text', 'edit_file', 'apply_patch']);

/**
 * Welche Dateien hat der Aufruf geschrieben? Bis Issue #158 wurde nur
 * `write_file_text` gemeldet — `edit_file` und `apply_patch` liefen still
 * durch, und die Vorschau der offenen Datei zeigte weiter den alten Inhalt.
 *
 * Gefragt wird das Ergebnis, nicht die Argumente: `apply_patch` im
 * Diff-Modus kennt seine Pfade erst aus dem Patch, und ein Aufruf, der nichts
 * geschrieben hat, meldet so auch nichts.
 */
function writtenRelativePaths(toolName, args, parsed) {
  const paths = [];
  if (toolName === 'write_file_text') {
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

function collectProgressEvents(toolName, args, output) {
  const events = [];
  if (!WRITING_TOOLS.has(toolName)) return events;
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    return events;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.error) return events;
  for (const relativePath of new Set(writtenRelativePaths(toolName, args, parsed))) {
    events.push(createWorkspaceFileWrittenEvent(relativePath));
  }
  return events;
}

module.exports = {
  createWorkspaceToolAdapter,
  CONTENT_READ_TOOLS,
  BROAD_LISTING_TOOLS,
};
