const { resolveDebugWaitMs } = require('../../shared/contracts/debug-wait');
const { sleepAbortable } = require('../../shared/runtime/abort');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const {
  TOOL_RISK_CLASSES,
  PERMISSION_DENIAL_REASONS,
  isToolRiskClass,
  createPermissionDeniedToolResult,
} = require('../../shared/contracts/tool-permissions');

function toAllowedNameSet(allowedNames) {
  if (allowedNames == null) return null;
  return new Set(allowedNames);
}

function toDisabledNameSet(disabledNames) {
  if (!Array.isArray(disabledNames) || disabledNames.length === 0) return null;
  return new Set(disabledNames);
}

function createToolRegistry(initialDefinitions = []) {
  const definitions = new Map();

  function register(definition) {
    const { name, description, parameters, handler, riskClass } = definition || {};
    if (!name || typeof description !== 'string' || !parameters || typeof handler !== 'function') {
      throw new TypeError('Tool benötigt name, description, parameters und handler.');
    }
    // Jedes Tool trägt eine validierte Mindestklasse (Konzept §2). Es gibt
    // keinen impliziten read-Default: ohne Klasse keine Registrierung.
    if (!isToolRiskClass(riskClass)) {
      throw new TypeError(`Tool ${name} benötigt eine gültige riskClass.`);
    }
    if (definitions.has(name)) {
      throw new Error(`Tool bereits registriert: ${name}`);
    }
    definitions.set(name, {
      ...definition,
      riskClass,
      // Standard true: die Datei-Tools haben ohne Ordner keinen Bezugspunkt.
      // Tools ohne Ordnerbezug (Websuche) setzen false und werden dem Modell
      // auch ohne geoeffneten Projektordner angeboten (Issue #96).
      requiresWorkspace: definition.requiresWorkspace !== false,
      targets: typeof definition.targets === 'function' ? definition.targets : () => [],
      isAvailable:
        typeof definition.isAvailable === 'function' ? definition.isAvailable : () => true,
    });
  }

  // Sichtbarkeit hängt nur an den Tool-Häkchen (disabledNames) bzw. einer
  // expliziten Allowlist. Ob ein Aufruf laufen darf, entscheidet pro Aufruf
  // die Policy in der Engine (Issue #66) — nicht mehr ein globaler Schreibschalter.
  function getAvailableDefinitions({ allowedNames, disabledNames, workspaceOpen = true } = {}) {
    const allowed = toAllowedNameSet(allowedNames);
    const disabled = toDisabledNameSet(disabledNames);
    return [...definitions.values()].filter(
      (definition) =>
        (!allowed || allowed.has(definition.name)) &&
        (!disabled || !disabled.has(definition.name)) &&
        // Ohne Ordner bleiben nur die Tools ohne Ordnerbezug uebrig (Issue #96).
        (workspaceOpen !== false || definition.requiresWorkspace === false) &&
        // Tools, die eine Konfiguration brauchen (Issue #63: Schluessel fuer
        // die Websuche), werden dem Modell ohne sie gar nicht erst gezeigt —
        // besser als ein Aufruf, der zur Laufzeit scheitert.
        definition.isAvailable() === true
    );
  }

  /**
   * Katalog für die Einstellungen (Issue #98). Liefert neben der vollen
   * `description` die kurze `promptDescription` als `shortDescription`: die
   * Liste zeigt den Kurztext, den Volltext klappt der Nutzer bei Bedarf auf.
   * Interne Tools (`internal: true`, z. B. debug_wait) bleiben dem Modell
   * erhalten, tauchen in den Einstellungen aber nicht auf.
   */
  function listCatalog() {
    return [...definitions.values()]
      .filter((definition) => definition.internal !== true)
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        shortDescription: definition.promptDescription || definition.description,
        riskClass: definition.riskClass,
      }));
  }

  function getTools(options = {}) {
    return getAvailableDefinitions(options).map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      },
    }));
  }

  function buildSystemPrompt(options = {}) {
    const available = getAvailableDefinitions(options);
    if (available.length === 0) return '';

    const toolLines = available.map(
      (definition) =>
        `- ${definition.name}: ${definition.promptDescription || definition.description}`
    );
    let prompt = `Du hast folgende Tools zur Verfügung:\n${toolLines.join('\n')}`;
    // Ohne Datei-Tools waere der Pfad-Hinweis sinnlos — ohne geoeffneten Ordner
    // stehen nur die Tools ohne Ordnerbezug in der Liste (Issue #96).
    if (available.some((definition) => definition.requiresWorkspace !== false)) {
      prompt +=
        `\nNutze für Datei-Tools nur relative Pfade zum Ordnerroot ` +
        `(z. B. "" oder "." für die Wurzel, "src/index.js" für eine Datei).`;
    }

    if (available.some((definition) => definition.riskClass === TOOL_RISK_CLASSES.WRITE)) {
      prompt +=
        ` Nutze Schreib-Tools zurückhaltend: nur wenn der Nutzer ausdrücklich eine Änderung oder neue Datei wünscht, ` +
        `und fasse danach kurz zusammen, was du geschrieben hast.`;
    }
    return prompt;
  }

  /** Definition eines Tools (für Planer und Adapter); null bei unbekanntem Namen. */
  function getDefinition(name) {
    return definitions.get(name) || null;
  }

  async function execute(name, args, context = {}) {
    const definition = definitions.get(name);
    if (!definition) {
      return JSON.stringify({ error: `Unbekanntes Tool: ${name}` });
    }
    // Defense in depth (Issue #66): kein Handler ohne vorherige Freigabe durch
    // die Policy. Die Engine setzt approved erst nach allow/Nutzerfreigabe.
    if (context.approved !== true) {
      return createPermissionDeniedToolResult({ reason: PERMISSION_DENIAL_REASONS.NOT_APPROVED });
    }
    const allowed = toAllowedNameSet(context.allowedNames);
    if (allowed && !allowed.has(name)) {
      return JSON.stringify({ error: `Tool ist nicht freigeschaltet: ${name}` });
    }
    const disabled = toDisabledNameSet(context.disabledNames);
    if (disabled && disabled.has(name)) {
      return JSON.stringify({
        error: `Tool ist deaktiviert: ${name}. Aktivierbar unter Einstellungen › Tools.`,
      });
    }
    if (definition.isAvailable() !== true) {
      return JSON.stringify({
        error: `Tool ist nicht eingerichtet: ${name}. Siehe Einstellungen › Tools.`,
      });
    }
    return definition.handler(args || {}, context);
  }

  initialDefinitions.forEach(register);

  return {
    register,
    getTools,
    buildSystemPrompt,
    listCatalog,
    getDefinition,
    execute,
  };
}

function createWorkspaceToolRegistry({
  fsService,
  webSearch = null,
  pythonRunner = null,
  urlFetch = null,
  shellRunner = null,
}) {
  return createToolRegistry([
    {
      name: 'list_directory',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Listet Dateien und Unterordner in einem Verzeichnis relativ zum geöffneten Projektordner (ohne versteckte Einträge, die mit . beginnen).',
      promptDescription: 'Listet Dateien und Unterordner im Projektordner auf.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description:
              'Relativer Pfad zum Ordner; leerer String oder "." für das Projektroot.',
          },
        },
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runListDirectoryTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: 'read_file_text',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'read' }],
      description:
        'Liest den Textinhalt einer Datei als UTF-8 (nur innerhalb des Projektordners). ' +
        'Maximale Dateigröße: 2 MB — größere Dateien liefern einen Fehler.',
      promptDescription: 'Liest Textdateien innerhalb des Projektordners.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Relativer Pfad zur Datei, z. B. "package.json" oder "src/app.js".',
          },
          max_characters: {
            type: 'integer',
            description:
              'Maximale Zeichenanzahl des zurückgegebenen Texts (Standard 32000, Obergrenze 200000).',
          },
        },
        required: ['relative_path'],
      },
      handler: (args, { workspaceRoot, skillRoots }) =>
        fsService.runReadFileTextTool(args, workspaceRoot, { skillRoots }),
    },
    {
      name: 'read_file_lines',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'read' }],
      description:
        'Liest gezielt einen Ausschnitt einer Textdatei (UTF-8, nur innerhalb des Projektordners): ' +
        'entweder einen Zeilenbereich (start_line/end_line, 1-basiert, inklusiv) oder einen Byte-Bereich (start_byte/length). ' +
        'Im Zeilenmodus ist jeder Zeile ihre Zeilennummer plus Tabulator vorangestellt — passend zu Treffern aus search_in_files. ' +
        'Token-sparsamer als read_file_text, wenn nur ein Teil der Datei gebraucht wird. Maximale Dateigröße: 2 MB.',
      promptDescription:
        'Liest gezielt Zeilen- oder Byte-Ausschnitte aus Textdateien des Projektordners (Zeilen nummeriert).',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Relativer Pfad zur Datei, z. B. "src/app.js".',
          },
          start_line: {
            type: 'integer',
            description:
              'Erste Zeile des Ausschnitts (1-basiert, Standard 1). Nicht mit start_byte/length kombinierbar.',
          },
          end_line: {
            type: 'integer',
            description:
              'Letzte Zeile (inklusiv; Standard start_line + 199, maximal 1000 Zeilen pro Aufruf).',
          },
          start_byte: {
            type: 'integer',
            description:
              'Byte-Offset (0-basiert), ab dem gelesen wird. Nicht mit start_line/end_line kombinierbar.',
          },
          length: {
            type: 'integer',
            description: 'Anzahl Bytes ab start_byte (Standard 16000, Obergrenze 32000).',
          },
        },
        required: ['relative_path'],
      },
      handler: (args, { workspaceRoot, skillRoots }) =>
        fsService.runReadFileLinesTool(args, workspaceRoot, { skillRoots }),
    },
    {
      name: 'search_in_files',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Durchsucht Textdateien im Projektordner rekursiv nach einem Suchtext oder regulären Ausdruck ' +
        'und liefert nur Trefferzeilen mit Zeilennummer und Kontext zurück — statt ganzer Dateien. ' +
        'Überspringt versteckte Einträge, Muster aus der .gitignore des Projektroots sowie binäre und zu große Dateien. ' +
        'Jede Zeile wird nur bis 10.000 Zeichen geprüft; reguläre Ausdrücke laufen mit einem Zeitbudget von 5 s pro Suche.',
      promptDescription:
        'Sucht Text oder Regex in Dateien des Projektordners und liefert Datei, Zeile und Kontext der Treffer.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Suchtext; bei is_regex=true ein regulärer Ausdruck in JavaScript-Syntax (höchstens 256 Zeichen, ' +
              'keine verschachtelten unbegrenzten Wiederholungen wie "(a+)+" — solche Muster werden abgelehnt).',
          },
          is_regex: {
            type: 'boolean',
            description:
              'true, um query als regulären Ausdruck zu interpretieren (Standard false = wörtliche Suche).',
          },
          relative_path: {
            type: 'string',
            description:
              'Startordner (oder einzelne Datei) relativ zum Projektroot; leer oder "." für das gesamte Projekt.',
          },
          context_lines: {
            type: 'integer',
            description:
              'Anzahl Kontextzeilen vor und nach jeder Trefferzeile (Standard 2, Maximum 10).',
          },
          max_results: {
            type: 'integer',
            description: 'Maximale Anzahl Treffer (Standard 50, Obergrenze 200).',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'true, um Groß-/Kleinschreibung zu beachten (Standard false).',
          },
          include: {
            type: 'string',
            description:
              'Optionales Glob-Muster (gitignore-Syntax); nur passende Dateien werden durchsucht, z. B. "*.js" oder "src/**/*.md".',
          },
          exclude: {
            type: 'string',
            description:
              'Optionales Glob-Muster (gitignore-Syntax); passende Dateien und Ordner werden übersprungen, z. B. "dist" oder "*.min.js".',
          },
          include_hidden: {
            type: 'boolean',
            description:
              'true, um auch versteckte Einträge (Punkt-Präfix) zu durchsuchen (Standard false; .git bleibt immer ausgenommen).',
          },
        },
        required: ['query'],
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runSearchInFilesTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: 'find_files',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Findet Dateien und Ordner im Projektordner rekursiv per Glob-Muster und liefert nur die Pfade zurück — ' +
        'ein Aufruf statt vieler list_directory-Runden. Muster in gitignore-Syntax (*, ?, **); ' +
        'Muster mit / sind am Projektroot verankert, ein abschließendes / findet nur Ordner. ' +
        'Überspringt versteckte Einträge, Muster aus der .gitignore des Projektroots sowie .git.',
      promptDescription:
        'Findet Datei- und Ordnerpfade im Projektordner per Glob-Muster (z. B. "**/*.js").',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob-Muster (gitignore-Syntax), z. B. "*.md", "src/**/*.js" oder "components/"; ' +
              'wird gegen den Pfad relativ zum Projektroot geprüft.',
          },
          relative_path: {
            type: 'string',
            description:
              'Startordner relativ zum Projektroot; leer oder "." für das gesamte Projekt.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximale Anzahl gefundener Pfade (Standard 100, Obergrenze 500).',
          },
          include_hidden: {
            type: 'boolean',
            description:
              'true, um auch versteckte Einträge (Punkt-Präfix) zu finden (Standard false; .git bleibt immer ausgenommen).',
          },
        },
        required: ['pattern'],
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runFindFilesTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: 'stat_path',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path, kind: 'any', access: 'read' }],
      description:
        'Liefert Metadaten zu einem Pfad im Projektordner, ohne die Datei zu lesen: ' +
        'Existenz, Typ (Datei/Ordner), Größe in Bytes, Änderungszeitpunkt (ISO 8601) und ' +
        'auf Wunsch die Zeilenzahl. Token-sparsam, um vor dem Lesen zu entscheiden, ' +
        'ob und wie gelesen werden sollte — z. B. bei großen Dateien read_file_lines statt read_file_text.',
      promptDescription:
        'Liefert Metadaten (Existenz, Typ, Größe, Änderungszeit, optional Zeilenzahl) zu Pfaden im Projektordner, ohne Dateiinhalt.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description:
              'Relativer Pfad zu Datei oder Ordner, z. B. "src/app.js"; "." für das Projektroot.',
          },
          include_line_count: {
            type: 'boolean',
            description:
              'true, um bei Textdateien zusätzlich die Zeilenzahl zu liefern (Standard false).',
          },
        },
        required: ['relative_path'],
      },
      handler: (args, { workspaceRoot, skillRoots }) =>
        fsService.runStatPathTool(args, workspaceRoot, { skillRoots }),
    },
    {
      name: 'outline_file',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'read' }],
      description:
        'Liefert die Gliederung einer Datei im Projektordner mit Zeilennummern, ohne den Inhalt zu lesen: ' +
        'bei Markdown die Überschriften (Ebene 1–6), bei Code Funktions-, Methoden-, Klassen- und Typ-Signaturen ' +
        '(Ebene aus der Einrückung, generische Heuristik). Token-sparsame Landkarte, um danach mit read_file_lines ' +
        'gezielt nur den passenden Abschnitt zu lesen. Mit max_depth lassen sich tiefe Ebenen ausblenden.',
      promptDescription:
        'Liefert die Gliederung einer Datei (Markdown-Überschriften bzw. Funktions-/Klassensignaturen) mit Zeilennummern, ohne den Volltext.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Relativer Pfad zur Datei, z. B. "docs/konzept.md" oder "src/app.js".',
          },
          max_depth: {
            type: 'integer',
            description:
              'Nur Einträge bis zu dieser Ebene liefern (1 = nur oberste Ebene). Standard: alle Ebenen.',
          },
          max_entries: {
            type: 'integer',
            description:
              'Maximale Anzahl Einträge (Standard 200, höchstens 1000); darüber wird truncated=true gemeldet.',
          },
        },
        required: ['relative_path'],
      },
      handler: (args, { workspaceRoot, skillRoots }) =>
        fsService.runOutlineFileTool(args, workspaceRoot, { skillRoots }),
    },
    {
      name: 'list_directory_tree',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Liefert einen kompakten rekursiven Ordnerbaum des Projektordners in einem Aufruf statt vieler ' +
        'list_directory-Runden. Text-Baum mit Einrückung; Ordner enden auf "/". "[+N]" hinter einem Ordner ' +
        'heißt: N direkte Einträge sind nicht angezeigt (max_depth oder max_entries erreicht). Breitensuche, ' +
        'damit bei knappem Budget zuerst die oberen Ebenen vollständig sind. Überspringt versteckte Einträge, ' +
        'Muster aus der .gitignore des Projektroots sowie .git; folgt keinen Symlinks.',
      promptDescription:
        'Liefert einen kompakten rekursiven Ordnerbaum des Projektordners (Tiefe und Umfang begrenzbar) in einem Aufruf.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description:
              'Startordner relativ zum Projektroot; leer oder "." für das gesamte Projekt.',
          },
          max_depth: {
            type: 'integer',
            description:
              'Maximale Tiefe (1 = nur direkte Einträge; Standard 3, Obergrenze 10). Tiefere Ordner erscheinen mit [+N].',
          },
          max_entries: {
            type: 'integer',
            description:
              'Maximale Anzahl angezeigter Einträge insgesamt (Standard 200, Obergrenze 1000); darüber truncated=true.',
          },
          include_hidden: {
            type: 'boolean',
            description:
              'true, um auch versteckte Einträge (Punkt-Präfix) zu zeigen (Standard false; .git bleibt immer ausgenommen).',
          },
        },
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runListDirectoryTreeTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: 'debug_wait',
      riskClass: TOOL_RISK_CLASSES.READ,
      // Nur für UI-Tests: dem Modell weiterhin angeboten, in den
      // Einstellungen aber ausgeblendet (Issue #98).
      internal: true,
      targets: () => [],
      description:
        'Nur zum UI-Test: wartet eine konfigurierbare Zeit und liefert danach OK zurück. Kein Dateizugriff.',
      promptDescription: 'Wartet ausschließlich für UI-Tests eine kurze Zeit.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: {
            type: 'number',
            description:
              'Wartezeit in Sekunden (Standard 5, Minimum 0,5, Maximum 20).',
          },
        },
      },
      async handler(args, { abortSignal }) {
        const ms = resolveDebugWaitMs(args);
        await sleepAbortable(ms, abortSignal);
        return JSON.stringify({ ok: true, waited_ms: ms, waited_seconds: ms / 1000 });
      },
    },
    {
      name: 'write_file_text',
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'write', overwrite: true }],
      description:
        'Erstellt oder überschreibt eine Textdatei (UTF-8) innerhalb des geöffneten Projektordners. ' +
        'Fehlende Zwischenordner werden automatisch angelegt. Überschreibt vorhandenen Inhalt vollständig. ' +
        'Maximale Inhaltsgröße: 2 MB.',
      promptDescription: 'Erstellt oder überschreibt Textdateien im Projektordner.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Relativer Pfad zur Zieldatei, z. B. "src/notes.md" oder "docs/neu.md".',
          },
          content: {
            type: 'string',
            description: 'Vollständiger neuer Textinhalt der Datei.',
          },
        },
        required: ['relative_path', 'content'],
      },
      riskClass: TOOL_RISK_CLASSES.WRITE,
      handler: (args, { workspaceRoot, recovery }) =>
        fsService.runWriteFileTextTool(args, workspaceRoot, { recovery }),
    },
    {
      name: 'edit_file',
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'write' }],
      description:
        'Ersetzt in einer Textdatei (UTF-8, nur innerhalb des Projektordners) gezielt eine Textstelle: ' +
        'old_string wird durch new_string ersetzt, ohne die Datei komplett neu zu schreiben. ' +
        'old_string muss exakt und eindeutig vorkommen — inklusive Einrückung und Zeilenumbrüchen; ' +
        'bei mehreren Treffern mehr Kontext angeben oder replace_all=true setzen. Maximale Dateigröße: 2 MB.',
      promptDescription:
        'Ersetzt gezielt Textstellen in Dateien des Projektordners (old_string → new_string), ohne die ganze Datei neu zu schreiben.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Relativer Pfad zur Datei, z. B. "src/app.js".',
          },
          old_string: {
            type: 'string',
            description:
              'Exakter zu ersetzender Text; muss eindeutig in der Datei vorkommen — bei Bedarf umgebende Zeilen mit aufnehmen.',
          },
          new_string: {
            type: 'string',
            description: 'Neuer Text; ein leerer String löscht die Textstelle.',
          },
          replace_all: {
            type: 'boolean',
            description:
              'true, um alle Vorkommen zu ersetzen (Standard false = genau ein eindeutiger Treffer erforderlich).',
          },
        },
        required: ['relative_path', 'old_string', 'new_string'],
      },
      riskClass: TOOL_RISK_CLASSES.WRITE,
      handler: (args, { workspaceRoot }) =>
        fsService.runEditFileTool(args, workspaceRoot),
    },
    {
      name: 'apply_patch',
      targets: (args) =>
        fsService.listApplyPatchTargets(args).map((p) => ({ path: p, kind: 'file', access: 'write' })),
      description:
        'Ändert bestehende Textdateien (UTF-8, nur innerhalb des Projektordners) mit mehreren ' +
        'zusammenhängenden Änderungen in einem Aufruf — entweder als Liste von Ersetzungen ' +
        '(edits, alle in derselben Datei, in dieser Reihenfolge angewendet) oder als unified diff ' +
        '(patch, auch über mehrere Dateien hinweg). Alles oder nichts: schlägt ein Schritt bzw. ein ' +
        'Hunk fehl, bleibt jede betroffene Datei unverändert. Jede Datei wird für sich atomar ' +
        'ersetzt (nie halb geschrieben); über mehrere Dateien hinweg gilt das nicht — scheitert ' +
        'ein Schreibvorgang, werden bereits geschriebene Dateien zurückgesetzt. Für eine einzelne Ersetzung ist ' +
        'edit_file einfacher. Dateien anlegen (write_file_text), löschen oder umbenennen kann ' +
        'apply_patch nicht. Maximale Dateigröße: 2 MB.',
      promptDescription:
        'Wendet mehrere zusammenhängende Änderungen (edits-Liste oder unified diff) atomar auf Dateien des Projektordners an.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description:
              'Relativer Pfad zur Datei, z. B. "src/app.js". Im edits-Modus erforderlich; ' +
              'im patch-Modus überflüssig, weil die Pfade in den "+++"-Kopfzeilen des Diffs stehen.',
          },
          edits: {
            type: 'array',
            description:
              'Ersetzungen in relative_path, der Reihe nach angewendet (höchstens 50). ' +
              'Jeder Schritt sieht das Ergebnis der vorherigen. Nicht mit patch kombinierbar.',
            items: {
              type: 'object',
              properties: {
                old_string: {
                  type: 'string',
                  description:
                    'Exakter zu ersetzender Text; muss zum Zeitpunkt dieses Schritts eindeutig ' +
                    'vorkommen — bei Bedarf umgebende Zeilen mit aufnehmen.',
                },
                new_string: {
                  type: 'string',
                  description: 'Neuer Text; ein leerer String löscht die Textstelle.',
                },
                replace_all: {
                  type: 'boolean',
                  description:
                    'true, um in diesem Schritt alle Vorkommen zu ersetzen ' +
                    '(Standard false = genau ein eindeutiger Treffer erforderlich).',
                },
              },
              required: ['old_string', 'new_string'],
            },
          },
          patch: {
            type: 'string',
            description:
              'Unified diff als Text: je Datei "--- alt" und "+++ neu" (a//b/-Präfixe erlaubt), ' +
              'darunter Hunks "@@ -alteZeile,anzahl +neueZeile,anzahl @@" mit Rumpfzeilen, die mit ' +
              '" " (unverändert), "-" (entfernt) oder "+" (neu) beginnen. Die Zeilennummern dürfen ' +
              'leicht verschoben sein, der Kontext muss exakt passen. Nicht mit edits kombinierbar.',
          },
        },
      },
      riskClass: TOOL_RISK_CLASSES.WRITE,
      handler: (args, { workspaceRoot }) =>
        fsService.runApplyPatchTool(args, workspaceRoot),
    },
    {
      name: 'run_python',
      // Hoechste Stufe im Berechtigungskonzept: ausgefuehrter Code umgeht die
      // Workspace-Grenze grundsaetzlich, weil nicht Snotra die Dateizugriffe
      // macht, sondern der Interpreter. `execute` ist weder sitzungs- noch
      // dauerhaft freigebbar (Konzept §6/§7) — es wird jedes Mal gefragt, und
      // die Freigabe-Karte zeigt den vollstaendigen Quelltext.
      riskClass: TOOL_RISK_CLASSES.EXECUTE,
      targets: () => [],
      isAvailable: () => pythonRunner?.isAvailable() === true,
      description:
        'Führt ein Python-3-Programm aus und gibt Standardausgabe, Fehlerausgabe und Exit-Code zurück. '
        + 'Arbeitsverzeichnis ist der geöffnete Projektordner, „open(\'daten.csv\')“ funktioniert also direkt. '
        + 'Nutze das Tool, statt zu rechnen oder zu raten: Auswertungen über Dateien, Umrechnungen, '
        + 'Datenumformung, das Prüfen von regulären Ausdrücken oder Datenformaten. '
        + 'Jeder Aufruf ist ein frisches Skript — es gibt keinen Zustand zwischen zwei Aufrufen, '
        + 'und nur die Standardbibliothek ist garantiert vorhanden. Kein „pip install“.',
      promptDescription:
        'Führt Python-3-Code aus und liefert Ausgabe und Exit-Code zurück. '
        + 'Zum Rechnen und Prüfen benutzen, statt Ergebnisse selbst zu schätzen.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Das vollständige Programm. Ergebnisse mit print() ausgeben — der Rückgabewert '
              + 'des letzten Ausdrucks wird nicht angezeigt.',
          },
          stdin: {
            type: 'string',
            description: 'Optionale Eingabe, die dem Programm auf der Standardeingabe zur Verfügung steht.',
          },
          argv: {
            type: 'array',
            description: 'Optionale Argumente; im Programm über sys.argv[1:] erreichbar.',
            items: { type: 'string' },
          },
          timeout_ms: {
            type: 'integer',
            description: 'Zeitlimit in Millisekunden (Standard 10000, Obergrenze 120000).',
          },
        },
        required: ['code'],
      },
      handler: async (args, { workspaceRoot, abortSignal } = {}) => {
        if (!pythonRunner) {
          return JSON.stringify({ error: 'Python-Ausführung ist in dieser Installation nicht verfügbar.' });
        }
        const result = await pythonRunner.run({
          code: args?.code,
          stdin: args?.stdin,
          argv: args?.argv,
          timeoutMs: args?.timeout_ms,
          cwd: workspaceRoot || undefined,
          abortSignal,
        });
        if (result?.error) return JSON.stringify({ error: result.error });
        const out = {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
        };
        if (result.timedOut) {
          out.timed_out = true;
          out.note = 'Das Programm wurde nach Ablauf des Zeitlimits beendet.';
        }
        if (result.aborted) {
          out.aborted = true;
          out.note = 'Das Programm wurde abgebrochen.';
        }
        if (result.truncated) out.truncated = true;
        return JSON.stringify(out);
      },
    },
    {
      name: 'shell_execute',
      // Wie run_python die hoechste Stufe — und die weitreichendere: ein
      // Shell-Befehl kann alles, was der angemeldete Nutzer kann, und kennt
      // keine Workspace-Grenze. `execute` ist weder sitzungs- noch dauerhaft
      // freigebbar (Konzept §6/§7); die Karte zeigt Befehl, Shell und
      // Arbeitsordner (Issue #102).
      riskClass: TOOL_RISK_CLASSES.EXECUTE,
      targets: () => [],
      isAvailable: () => shellRunner?.isAvailable() === true,
      description:
        'Führt einen Befehl in der Shell des Betriebssystems aus (macOS/Linux in der Login-Shell des '
        + 'Nutzers, Windows in PowerShell bzw. cmd.exe) und gibt Standardausgabe, Fehlerausgabe und '
        + 'Exit-Code zurück. Damit ist alles erreichbar, was der Nutzer im Terminal tun würde: '
        + '„git status“, „npm run build“, „docker ps“, ein installiertes CLI-Werkzeug. '
        + 'Arbeitsverzeichnis ist der geöffnete Projektordner oder ein Unterordner davon. '
        + 'Ein Befehl pro Aufruf und kein Zustand zwischen zwei Aufrufen: ein „cd“ wirkt nur innerhalb '
        + 'desselben Befehls (verkette stattdessen mit && oder setze cwd). '
        + 'Nicht interaktiv — es gibt kein Terminal, auf eine Eingabeaufforderung zu warten läuft ins '
        + 'Zeitlimit; nutze nicht-interaktive Schalter und gib Eingaben über stdin mit. '
        + 'Hintergrundprozesse und Server, die über das Ende des Aufrufs hinaus laufen sollen, sind nicht '
        + 'möglich. Rekursives Zwangslöschen, Datenträgeroperationen und das Umschreiben der Git-Historie '
        + 'sind gesperrt. Jeder Lauf braucht die Freigabe des Nutzers.',
      promptDescription:
        'Führt einen Befehl in der Shell des Betriebssystems aus (git, npm, installierte CLI-Werkzeuge) '
        + 'und liefert Ausgabe und Exit-Code zurück.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Die vollständige Befehlszeile, so wie sie im Terminal stünde, z. B. "git status --short". '
              + 'Mehrere Schritte mit && verketten.',
          },
          cwd: {
            type: 'string',
            description:
              'Optionaler Unterordner des Projektordners als Arbeitsverzeichnis, relativ angegeben '
              + '(z. B. "frontend"). Ohne Angabe läuft der Befehl im Projektordner.',
          },
          stdin: {
            type: 'string',
            description: 'Optionale Eingabe, die dem Befehl auf der Standardeingabe zur Verfügung steht.',
          },
          timeout_ms: {
            type: 'integer',
            description: 'Zeitlimit in Millisekunden (Standard 30000, Obergrenze 300000).',
          },
        },
        required: ['command'],
      },
      handler: async (args, { workspaceRoot, abortSignal } = {}) => {
        if (!shellRunner) {
          return JSON.stringify({ error: 'Shell-Ausführung ist in dieser Installation nicht verfügbar.' });
        }
        // Doppelt geprueft: der Planer lehnt gesperrte Wirkungen schon vor der
        // Freigabekarte ab, hier faengt es jeden Weg ohne Planer ab.
        const guard = checkShellCommand(args?.command);
        if (guard.blocked) return JSON.stringify({ error: guard.reason, blocked: true });
        const relativeCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
        const resolved = await fsService.resolveToolPath(workspaceRoot, relativeCwd);
        if (resolved.error) return JSON.stringify({ error: resolved.error });
        const result = await shellRunner.run({
          command: args?.command,
          stdin: args?.stdin,
          timeoutMs: args?.timeout_ms,
          cwd: resolved.absPath,
          abortSignal,
        });
        if (result?.error) {
          return JSON.stringify(result.blocked ? { error: result.error, blocked: true } : { error: result.error });
        }
        const out = {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          // Womit der Befehl lief, gehoert ins Ergebnis: das Modell soll
          // Syntaxfehler der falschen Shell zuordnen koennen (Issue #102).
          shell: result.shell,
          cwd: relativeCwd || '.',
        };
        if (result.timedOut) {
          out.timed_out = true;
          out.note = 'Der Befehl wurde nach Ablauf des Zeitlimits beendet.';
        }
        if (result.aborted) {
          out.aborted = true;
          out.note = 'Der Befehl wurde abgebrochen.';
        }
        if (result.truncated) out.truncated = true;
        return JSON.stringify(out);
      },
    },
    {
      name: 'web_search',
      // Erstes Tool, das den Rechner verlaesst: Klasse 'external'. Damit fragt
      // die Policy im Modus „Intelligent" vor jeder Suche nach (Issue #66) —
      // die Suchanfrage selbst ist der Inhalt, der nach draussen geht.
      riskClass: TOOL_RISK_CLASSES.EXTERNAL,
      // Eine Internetsuche hat keinen Bezugspunkt im Dateisystem (Issue #96).
      requiresWorkspace: false,
      targets: () => [],
      isAvailable: () => webSearch?.isConfigured() === true,
      description:
        'Sucht im Internet und liefert eine kompakte Trefferliste (Titel, URL, kurzer Auszug, ggf. Datum) — '
        + 'keine ganzen Seiten. Nutze das Tool für alles, was aktueller ist als dein Wissensstand oder was du '
        + 'belegen sollst: Versionen, Preise, Nachrichten, Fehlermeldungen, Normen. Die Suchanfrage verlässt '
        + 'den Rechner und geht an einen externen Suchdienst.',
      promptDescription:
        'Sucht im Internet und liefert Titel, URL und einen kurzen Auszug je Treffer. '
        + 'Zum Lesen einer Seite im Volltext ist es nicht gedacht.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Suchanfrage in natürlicher Sprache oder als Stichworte (höchstens 400 Zeichen).',
          },
          max_results: {
            type: 'integer',
            description: 'Maximale Anzahl Treffer (Standard 5, Obergrenze 10).',
          },
          language: {
            type: 'string',
            description:
              'Optionaler Sprachhinweis für die Suche, z. B. "de" oder "en". Ohne Angabe entscheidet der Suchdienst.',
          },
        },
        required: ['query'],
      },
      handler: async (args, { abortSignal } = {}) => {
        if (!webSearch) {
          return JSON.stringify({ error: 'Websuche ist in dieser Installation nicht verfügbar.' });
        }
        const result = await webSearch.search({
          query: args?.query,
          maxResults: args?.max_results,
          language: args?.language,
          abortSignal,
        });
        if (!result?.ok) {
          return JSON.stringify({ error: result?.error || 'Die Suche ist fehlgeschlagen.' });
        }
        // Keine Treffer ist ein gueltiges Ergebnis, kein Fehler — das Modell
        // soll die Anfrage umformulieren duerfen, statt abzubrechen.
        const out = { query: result.query, count: result.results.length, results: result.results };
        if (result.answer) out.answer = result.answer;
        return JSON.stringify(out);
      },
    },
    {
      name: 'fetch_url',
      // Wie web_search eine Klasse 'external': der Abruf verlaesst den Rechner,
      // und der gelesene Text kommt von einem Fremden (Issue #95).
      riskClass: TOOL_RISK_CLASSES.EXTERNAL,
      // Eine Webadresse hat keinen Bezugspunkt im Dateisystem (Issue #96).
      requiresWorkspace: false,
      targets: () => [],
      isAvailable: () => urlFetch !== null,
      description:
        'Ruft genau eine http(s)-Adresse ab und liefert den lesbaren Text der Seite als Markdown-nahen '
        + 'Fliesstext, gekürzt auf die gewünschte Länge. Gedacht als Ergänzung zu web_search: dort die '
        + 'Adresse finden, hier die Seite am Stück lesen. Lokale und private Adressen werden abgelehnt, '
        + 'ebenso alles, was kein Text ist (PDF, Bilder, Downloads). Der Abruf verlässt den Rechner.',
      promptDescription:
        'Liest eine Webseite als Text. Für Inhalte, die über den kurzen Auszug aus web_search hinausgehen.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Vollständige http- oder https-Adresse, z. B. "https://example.org/changelog".',
          },
          max_characters: {
            type: 'integer',
            description:
              'Maximale Zeichenanzahl des zurückgegebenen Texts (Standard 20000, Obergrenze 100000).',
          },
        },
        required: ['url'],
      },
      handler: async (args, { abortSignal } = {}) => {
        if (!urlFetch) {
          return JSON.stringify({ error: 'Der Seitenabruf ist in dieser Installation nicht verfügbar.' });
        }
        const result = await urlFetch.fetchUrl({
          url: args?.url,
          maxCharacters: args?.max_characters,
          abortSignal,
        });
        if (!result?.ok) {
          return JSON.stringify({ error: result?.error || 'Die Seite konnte nicht gelesen werden.' });
        }
        const out = { url: result.url, text: result.text };
        if (result.title) out.title = result.title;
        if (result.truncated) out.truncated = true;
        return JSON.stringify(out);
      },
    },
  ]);
}

module.exports = {
  createToolRegistry,
  createWorkspaceToolRegistry,
};
