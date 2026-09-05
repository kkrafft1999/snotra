const { resolveDebugWaitMs } = require('../../shared/contracts/debug-wait');
const { sleepAbortable } = require('../../shared/runtime/abort');
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
      targets: typeof definition.targets === 'function' ? definition.targets : () => [],
    });
  }

  // Sichtbarkeit hängt nur an den Tool-Häkchen (disabledNames) bzw. einer
  // expliziten Allowlist. Ob ein Aufruf laufen darf, entscheidet pro Aufruf
  // die Policy in der Engine (Issue #66) — nicht mehr ein globaler Schreibschalter.
  function getAvailableDefinitions({ allowedNames, disabledNames } = {}) {
    const allowed = toAllowedNameSet(allowedNames);
    const disabled = toDisabledNameSet(disabledNames);
    return [...definitions.values()].filter(
      (definition) =>
        (!allowed || allowed.has(definition.name)) &&
        (!disabled || !disabled.has(definition.name))
    );
  }

  function listCatalog() {
    return [...definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
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
    let prompt =
      `Du hast folgende Tools zur Verfügung:\n${toolLines.join('\n')}\n` +
      `Nutze für Datei-Tools nur relative Pfade zum Ordnerroot ` +
      `(z. B. "" oder "." für die Wurzel, "src/index.js" für eine Datei).`;

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

function createWorkspaceToolRegistry({ fsService }) {
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
        'Hunk fehl, bleibt jede betroffene Datei unverändert. Für eine einzelne Ersetzung ist ' +
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
  ]);
}

module.exports = {
  createToolRegistry,
  createWorkspaceToolRegistry,
};
