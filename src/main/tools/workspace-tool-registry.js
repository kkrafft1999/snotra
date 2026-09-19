const { resolveDebugWaitMs } = require('../../shared/contracts/debug-wait');
const { sleepAbortable } = require('../../shared/runtime/abort');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const { formatSkillPath } = require('../../shared/runtime/skill-path');
const { LOAD_SKILL_TOOL } = require('../../shared/contracts/skills');
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
  // Zur Laufzeit wechselnde Tools — heute die der MCP-Server (Issue #107).
  // Getrennt von den eingebauten, weil sie bei jeder Katalog-Aktualisierung
  // komplett ersetzt werden: ein abgeschalteter Server soll seine Tools
  // vollstaendig verlieren, nicht nur bis zum naechsten Neustart behalten.
  let dynamic = new Map();

  /**
   * Prueft und ergaenzt eine Tool-Definition.
   *
   * Drei Beschreibungsfelder mit je eigenem Leser — wer eines aendert, sollte
   * wissen, wen er trifft (Issue #181):
   *  - `description` (Pflicht): Volltext fuer Einstellungen › Tools, aufklappbar.
   *    Ohne `modelDescription` geht er zugleich als Schema-Text an das Modell.
   *  - `modelDescription` (optional): Schema-Text ausschliesslich fuer das
   *    Modell. Gesetzt schlaegt er `description` in `getTools()`, sonst nichts.
   *  - `promptDescription` (optional): Kurzzeile fuer die Tool-Liste im
   *    System-Prompt und fuer die zugeklappte Zeile in den Einstellungen.
   */
  function normalizeDefinition(definition) {
    const { name, description, modelDescription, parameters, handler, riskClass, additionalRiskClasses } = definition || {};
    if (!name || typeof description !== 'string' || !parameters || typeof handler !== 'function') {
      throw new TypeError('Tool benötigt name, description, parameters und handler.');
    }
    // Ein Feld vom falschen Typ faellt sonst erst beim Anbieter auf — und dort
    // als unverstaendlicher Schema-Fehler statt als Tippfehler hier.
    if (modelDescription != null && typeof modelDescription !== 'string') {
      throw new TypeError(`Tool ${name}: modelDescription muss ein String sein.`);
    }
    // Jedes Tool trägt eine validierte Mindestklasse (Konzept §2). Es gibt
    // keinen impliziten read-Default: ohne Klasse keine Registrierung.
    if (!isToolRiskClass(riskClass)) {
      throw new TypeError(`Tool ${name} benötigt eine gültige riskClass.`);
    }
    // `internal` versteckt vor Nutzer *und* Modell, `essential` nur vor dem
    // Nutzer — beides zusammen ergibt keinen Sinn und waere ein Tippfehler,
    // der sich erst als fehlendes Tool im Prompt zeigt.
    if (definition.internal === true && definition.essential === true) {
      throw new TypeError(`Tool ${name}: internal und essential schliessen sich aus.`);
    }
    // Weitere Mindestklassen fuer Tools, deren Wirkung sich nicht in einer
    // einzigen erschoepft (Issue #107: MCP ist zugleich `execute` und
    // `external`). Nur ergaenzend — die Grundklasse bleibt.
    const extra = Array.isArray(additionalRiskClasses) ? additionalRiskClasses : [];
    for (const cls of extra) {
      if (!isToolRiskClass(cls)) {
        throw new TypeError(`Tool ${name} hat eine ungültige zusätzliche riskClass: ${cls}.`);
      }
    }
    return {
      ...definition,
      riskClass,
      additionalRiskClasses: extra,
      // Standard true: die Datei-Tools haben ohne Ordner keinen Bezugspunkt.
      // Tools ohne Ordnerbezug (Websuche) setzen false und werden dem Modell
      // auch ohne geoeffneten Projektordner angeboten (Issue #96).
      requiresWorkspace: definition.requiresWorkspace !== false,
      // Standard false: nur `load_skill` haengt daran, dass ueberhaupt ein
      // Skill eingeschaltet ist (Issue #173).
      requiresSkills: definition.requiresSkills === true,
      // Standard false: Grundausstattung, die der Nutzer nicht abwaehlen kann
      // und in Einstellungen › Tools deshalb auch nicht sieht (Issue #195).
      essential: definition.essential === true,
      // Was dieses Tool beim Durchlaufen ueberspringt (Issue #182): `hidden` =
      // Eintraege mit Punkt-Praefix, `ignored` = Muster aus der .gitignore des
      // Projektroots. Steht einmal im Konventionsblock statt in jeder
      // Beschreibung — und wird von dort aus den sichtbaren Tools gebaut,
      // damit der Satz nicht behauptet, was ein abgewaehltes Tool tut.
      skips: Array.isArray(definition.skips) ? definition.skips : [],
      targets: typeof definition.targets === 'function' ? definition.targets : () => [],
      isAvailable:
        typeof definition.isAvailable === 'function' ? definition.isAvailable : () => true,
    };
  }

  function register(definition) {
    const normalized = normalizeDefinition(definition);
    if (definitions.has(normalized.name)) {
      throw new Error(`Tool bereits registriert: ${normalized.name}`);
    }
    definitions.set(normalized.name, normalized);
  }

  /**
   * Ersetzt die dynamischen Tools vollstaendig. Ein Name, den es schon fest
   * gibt, wird uebergangen — der Namensraum (`mcp__…`) schliesst das zwar aus,
   * aber ein eingebautes Tool darf nie von aussen ueberschrieben werden.
   */
  function setDynamicDefinitions(list) {
    const next = new Map();
    for (const definition of Array.isArray(list) ? list : []) {
      const normalized = normalizeDefinition(definition);
      if (definitions.has(normalized.name) || next.has(normalized.name)) continue;
      next.set(normalized.name, normalized);
    }
    dynamic = next;
  }

  /** Eingebaute und dynamische Tools in einer Liste, eingebaute zuerst. */
  function allDefinitions() {
    return [...definitions.values(), ...dynamic.values()];
  }

  // Sichtbarkeit hängt nur an den Tool-Häkchen (disabledNames) bzw. einer
  // expliziten Allowlist. Ob ein Aufruf laufen darf, entscheidet pro Aufruf
  // die Policy in der Engine (Issue #66) — nicht mehr ein globaler Schreibschalter.
  //
  // Was der Nutzer in den Einstellungen nicht sieht, bekommt auch das Modell
  // nicht (Issue #180): Ein internes Tool waere sonst ein Schema, das in jeder
  // Runde Tokens kostet und das niemand abwaehlen kann, weil es in der
  // Tool-Liste gar nicht auftaucht. Nur die Sichtbarkeit — `getDefinition` und
  // `execute` bleiben offen, die UI-Tests loesen `debug_wait` weiterhin aus.
  //
  // Die Grundausstattung (`essential`, Issue #195) ist die Gegenrichtung: sie
  // steht ebenfalls nicht in der Tool-Liste, geht aber immer an das Modell.
  // Diese Tools sind keine Wahl des Nutzers, sondern der Zugang zu etwas, das
  // er an anderer Stelle schon eingeschaltet hat — `load_skill` ist der
  // einzige Weg zur Anleitung eines eingeschalteten Skills, `list_directory`
  // der einzige Weg in einen geoeffneten Ordner. Abgewaehlt kosteten sie kein
  // Schema mehr, dafuer aber ein Vielfaches an anderer Stelle: ohne
  // `load_skill` liegt jede Skill-Anleitung wieder voll im Prompt
  // (chat-engine.js), ohne `list_directory` raet das Modell Pfade und liest
  // sich durch Fehlschlaege. Ein altes Haekchen aus den Einstellungen bleibt
  // gespeichert, wirkt hier aber nicht mehr — wird ein Tool spaeter wieder
  // abwaehlbar, gilt es unveraendert weiter.
  function getAvailableDefinitions({
    allowedNames,
    disabledNames,
    workspaceOpen = true,
    skillNames = null,
  } = {}) {
    // Kein `skillNames` heisst „nicht gesagt" und nicht „keine" — sonst waeren
    // alle Aufrufer ohne Skill-Kontext (Tests, Katalog) ploetzlich skilllos.
    const skillsAvailable = skillNames === null || (Array.isArray(skillNames) && skillNames.length > 0);
    const allowed = toAllowedNameSet(allowedNames);
    const disabled = toDisabledNameSet(disabledNames);
    return allDefinitions().filter(
      (definition) =>
        definition.internal !== true &&
        (!allowed || allowed.has(definition.name)) &&
        // Die Haekchen des Nutzers gelten nicht fuer die Grundausstattung; eine
        // programmatische Allowlist (Tests, kuenftige Modi) schon — sie ist
        // keine Einstellung, sondern eine Zusicherung des Aufrufers.
        (!disabled || !disabled.has(definition.name) || definition.essential === true) &&
        // Ohne Ordner bleiben nur die Tools ohne Ordnerbezug uebrig (Issue #96).
        (workspaceOpen !== false || definition.requiresWorkspace === false) &&
        // Ohne eingeschalteten Skill hat `load_skill` nichts zu laden und
        // kostet nur ein Schema in jeder Anfrage (Issue #173).
        (skillsAvailable || definition.requiresSkills !== true) &&
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
   * Interne Tools (`internal: true`, z. B. debug_wait) tauchen weder hier noch
   * in den Schemas fuer das Modell auf (Issue #180) — ausfuehrbar bleiben sie.
   * Die Grundausstattung (`essential: true`) fehlt hier ebenfalls, aber aus dem
   * umgekehrten Grund: Sie geht immer an das Modell, also gibt es nichts zu
   * entscheiden, und eine Zeile ohne Wahl waere nur ein taubes Haekchen (#195).
   */
  function listCatalog() {
    return allDefinitions()
      .filter((definition) => definition.internal !== true && definition.essential !== true)
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        shortDescription: definition.promptDescription || definition.description,
        riskClass: definition.riskClass,
      }));
  }

  /**
   * Schemas fuer den Anbieter.
   *
   * Die Beschreibung hat zwei Leser mit gegensaetzlichen Interessen (Issue
   * #181): Das Modell bekommt sie in jeder Runde und zahlt sie in Tokens, der
   * Nutzer klappt sie in Einstellungen › Tools auf und will es genau wissen.
   * `modelDescription` trennt beide — gesetzt geht sie an das Modell, sonst
   * bleibt es bei `description`. Getrimmt geprueft, damit ein versehentlich
   * leer gelassenes Feld nicht stillschweigend eine leere Beschreibung
   * hinausschickt.
   */
  function getTools(options = {}) {
    return getAvailableDefinitions(options).map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.modelDescription?.trim() || definition.description,
        // Ein Tool darf sein Schema je Anfrage schaerfen (Issue #173:
        // `load_skill` traegt die eingeschalteten Skills als enum).
        parameters:
          typeof definition.parametersFor === 'function'
            ? definition.parametersFor(options)
            : definition.parameters,
      },
    }));
  }

  /** Namen einer Liste als Aufzaehlung: „a, b und c". */
  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
  }

  /**
   * Konventionsblock fuer den System-Prompt (Issue #182).
   *
   * Hier stand bis #182 eine Prosa-Liste aller Tool-Namen, die ausschliesslich
   * wiederholte, was ohnehin als Schema im `tools`-Feld der Anfrage steht.
   * Alle fuenf Provider uebergeben die Tools nativ; keiner haengt an der
   * Prosa-Fassung. Gemessen am 2026-09-18 (o200k, 14 sichtbare Tools):
   * 2.191 → 867 Zeichen, 541 → 191 Token, also rund 350 Token je Runde.
   *
   * Was bleibt, ist das, was fuer die Tools **als Gruppe** gilt und nirgendwo
   * sonst steht. Zwei Bedingungen dafuer:
   *
   *  1. Der Block ist **nie leer**, sobald ein Tool sichtbar ist. Sein
   *     Rueckgabewert ist fuer die Engine zugleich das Signal „es gibt Tools":
   *     `buildNoWorkspaceSystemPrompt` liefert bei leerem Block gar nichts
   *     mehr — samt `TOOL_RESULTS_ARE_DATA_RULE`. Ein leerer Block waere also
   *     kein Sparen, sondern ein Sicherheitsverlust. Deshalb die
   *     unbedingte erste Zeile.
   *  2. Der Block ist **beschreibend, nicht pauschal**. `include_hidden` gibt
   *     es nur an drei Tools, `.gitignore` gilt nur fuer die rekursiven. Ein
   *     Satz wie „alle Tools ueberspringen versteckte Dateien" waere falsch —
   *     und damit schlimmer als die Doppelung, die er ersetzt. Die Saetze
   *     werden deshalb aus den tatsaechlich sichtbaren Tools gebaut und
   *     nennen sie beim Namen; ein abgewaehltes Tool taucht nicht auf.
   */
  function buildSystemPrompt(options = {}) {
    const available = getAvailableDefinitions(options);
    if (available.length === 0) return '';

    const parts = ['Deine Tools stehen mit vollständigem Schema im tools-Feld dieser Anfrage.'];

    // Ohne Datei-Tools waeren Pfad- und Groessenregel sinnlos — ohne geoeffneten
    // Ordner stehen nur die Tools ohne Ordnerbezug zur Verfuegung (Issue #96).
    if (available.some((definition) => definition.requiresWorkspace !== false)) {
      parts.push(
        'Pfade der Datei-Tools sind immer relativ zum Ordnerroot ' +
          '("" oder "." für die Wurzel, "src/index.js" für eine Datei); ' +
          'sie verarbeiten Dateien bis 2 MB und melden darüber einen Fehler.'
      );
    }

    // Aus den sichtbaren Tools gebaut statt fest verdrahtet (Bedingung 2).
    const skipsHidden = available.filter((definition) => definition.skips.includes('hidden'));
    const skipsIgnored = available.filter((definition) => definition.skips.includes('ignored'));
    if (skipsHidden.length > 0) {
      let sentence = `${joinNames(skipsHidden.map((d) => d.name))} überspringen versteckte Einträge (Punkt-Präfix)`;
      if (skipsIgnored.length > 0) {
        sentence +=
          `, ${joinNames(skipsIgnored.map((d) => d.name))} zusätzlich alles, was die .gitignore ` +
          'des Projektroots ausschließt; .git bleibt immer außen vor';
      }
      parts.push(
        // Ohne diesen Hinweis ist ein leeres Ergebnis nicht von „gibt es
        // nicht" zu unterscheiden — eine stille Falschantwort ohne
        // Selbstkorrektur, die teuerste Fehlerklasse (Issue #183).
        `${sentence}. Ein leeres Ergebnis kann deshalb heißen, dass es Treffer gibt, ` +
          'sie aber übersprungen wurden.'
      );
    }
    if (available.some((definition) => definition.parameters?.properties?.include_hidden)) {
      parts.push('Wo ein Tool den Parameter include_hidden hat, nimmt true die versteckten Einträge hinzu.');
    }

    if (available.some((definition) => definition.riskClass === TOOL_RISK_CLASSES.WRITE)) {
      parts.push(
        'Nutze Schreib-Tools zurückhaltend: nur wenn der Nutzer ausdrücklich eine Änderung ' +
          'oder neue Datei wünscht, und fasse danach kurz zusammen, was du geschrieben hast.'
      );
    }
    return parts.join('\n');
  }

  /** Definition eines Tools (für Planer und Adapter); null bei unbekanntem Namen. */
  function getDefinition(name) {
    return definitions.get(name) || dynamic.get(name) || null;
  }

  async function execute(name, args, context = {}) {
    const definition = getDefinition(name);
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
    setDynamicDefinitions,
    getTools,
    buildSystemPrompt,
    listCatalog,
    getDefinition,
    execute,
  };
}

/**
 * Die eingebauten Tools.
 *
 * Zu den Beschreibungsfeldern siehe `normalizeDefinition`. Seit #183 stehen
 * die Konventionen, die fuer mehrere Tools zugleich gelten — Pfade, versteckte
 * Eintraege, .gitignore, die 2-MB-Grenze — einmal im Konventionsblock des
 * System-Prompts statt an rund 30 Stellen in den Schemas. Grenzen sagt das
 * Schema selbst (`default`, `maximum`, `maxItems`, `maxLength`) statt einer
 * Prosa-Klammer daneben. Gemessen am 2026-09-18 (o200k, 16 Tools):
 * 16.900 → 15.421 Zeichen, 4.062 → 3.696 Token, rund 366 Token je Runde.
 *
 * Seit #184 gilt fuer die `modelDescription` der teuersten Schemata die
 * Leitregel: **Name und Typ tragen die Bedeutung, die Beschreibung nur noch
 * das, was daraus nicht folgt.** Gestrichen ist, wofuer ein zweiter Traeger
 * existiert — allen voran die Fehlermeldungen von `fs-service.js`, die ihre
 * eigene Grammatik woertlich zurueckgeben. Der Preis ist dann hoechstens eine
 * zusaetzliche Runde, nicht eine falsche Antwort. Was ohne zweiten Traeger
 * still falsch antworten wuerde, bleibt stehen: der gitignore-Hinweis im
 * Konventionsblock und der Ersparnis-Satz an `read_file_lines`. Gemessen am
 * 2026-09-18 (o200k, 16 Tools): 15.421 → 13.935 Zeichen,
 * 3.696 → 3.326 Token, rund 370 Token je Runde.
 *
 * Der Volltext in `description` bleibt dabei unangetastet — er ist der
 * Aufklapptext in Einstellungen › Tools und die einzige Stelle, an der ein
 * Nutzer erfaehrt, was ein Tool wirklich tut. Er ist deshalb laenger als die
 * `modelDescription` daneben und laenger als die `promptDescription`, die in
 * den Einstellungen als Kurzzeile darueber steht — beides gehoert nach einer
 * Kuerzung einmal angesehen.
 */
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
      // Grundausstattung (Issue #195): Ohne einen Blick in den Ordner raet das
      // Modell Pfade — das kostet mehr Runden und mehr Tokens als das Schema.
      essential: true,
      skips: ['hidden'],
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Listet Dateien und Unterordner in einem Verzeichnis relativ zum geöffneten Projektordner (ohne versteckte Einträge, die mit . beginnen).',
      modelDescription: 'Listet Dateien und Unterordner eines Verzeichnisses auf.',
      promptDescription: 'Listet Dateien und Unterordner im Projektordner auf.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            // Ordner-Startpunkt, kein Dateipfad: ein Datei-Beispiel waere hier
            // irrefuehrender als gar keins (Issue #183).
            description: 'Startordner; leer oder "." = ganzes Projekt.',
          },
        },
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runListDirectoryTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: LOAD_SKILL_TOOL,
      riskClass: TOOL_RISK_CLASSES.READ,
      // Ein Skill-Verzeichnis liegt nicht im Projektordner — die Anleitung
      // eines eingeschalteten Skills ist auch ohne geöffneten Ordner lesbar
      // (Issue #173). Ohne eingeschalteten Skill gibt es nichts zu laden,
      // dann bleibt das Tool weg.
      requiresWorkspace: false,
      requiresSkills: true,
      // Grundausstattung (Issue #195): der einzige Weg zur Anleitung eines
      // eingeschalteten Skills. Abgewaehlt liegt jede Anleitung wieder voll im
      // Prompt (chat-engine.js) — Sparen am Schema, Zahlen am Body.
      essential: true,
      // Über denselben „skill:“-Pfad wie jede andere Skill-Datei: so gelten
      // Wurzel-Auflösung, Ausbruchsprüfung und Freigabekarte unverändert, und
      // im Verlauf steht „Skill <name>“ statt eines nackten Dateipfads (#61).
      targets: (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) return { error: 'name ist erforderlich.' };
        return [{ path: formatSkillPath(name, 'SKILL.md'), kind: 'file', access: 'read' }];
      },
      description:
        'Lädt die vollständige Anleitung eines eingeschalteten Skills. Im Prompt steht je Skill nur '
        + 'eine kurze Beschreibung — passt sie zu dem, was ansteht, hole dir hiermit die Anleitung, '
        + 'bevor du mit der Aufgabe beginnst, und richte dich danach. Rate nicht, was in einer '
        + 'Anleitung stehen könnte.',
      promptDescription: 'Lädt die Anleitung eines eingeschalteten Skills nach.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name des Skills, genau wie in der Liste der eingeschalteten Skills.',
          },
        },
        required: ['name'],
      },
      // Die eingeschalteten Skills stehen je Anfrage als `enum` im Schema.
      // Gemessen mit llama3.1:8b und 18 Skills (Issue #173): ohne enum erfindet
      // das Modell Namen („notizen", „Teams-Nachricht") und laedt nichts; mit
      // enum waehlt es ausschliesslich echte Namen. Die Pruefung selbst haengt
      // nicht daran — `runLoadSkillTool` loest den Namen ohnehin gegen die
      // eingeschalteten Skills auf, und `parameters` bleibt als Grundschema
      // ohne Anfragezustand stehen, damit die Argumentpruefung stabil bleibt.
      parametersFor: ({ skillNames } = {}) => {
        const names = Array.isArray(skillNames) ? skillNames.filter((n) => typeof n === 'string' && n) : [];
        return {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name des Skills, genau wie in der Liste der eingeschalteten Skills.',
              ...(names.length > 0 ? { enum: names } : {}),
            },
          },
          required: ['name'],
        };
      },
      handler: (args, { workspaceRoot, skillRoots }) =>
        fsService.runLoadSkillTool(args, workspaceRoot, { skillRoots }),
    },
    {
      name: 'read_file_text',
      riskClass: TOOL_RISK_CLASSES.READ,
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'read' }],
      description:
        'Liest den Textinhalt einer Datei als UTF-8 (nur innerhalb des Projektordners). ' +
        'Maximale Dateigröße: 2 MB — größere Dateien liefern einen Fehler.',
      modelDescription: 'Liest den Textinhalt einer Datei als UTF-8.',
      promptDescription: 'Liest Textdateien innerhalb des Projektordners.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Dateipfad, z. B. "src/app.js".',
          },
          max_characters: {
            type: 'integer',
            default: 32000,
            maximum: 200000,
            description: 'Maximale Zeichenanzahl des zurückgegebenen Texts.',
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
      // Der Satz zur Token-Ersparnis bleibt ausdruecklich stehen (Issue #184):
      // er kostet 9 Token, eine unnoetige Volllesung dieser Datei kostet ueber
      // 10.000. Der Verweis auf search_in_files faellt weg — das Zeilenformat
      // steht in der Antwort selbst.
      modelDescription:
        'Liest einen Ausschnitt einer Textdatei: entweder einen Zeilenbereich (start_line/end_line, ' +
        '1-basiert, inklusiv) oder einen Byte-Bereich (start_byte/length). Im Zeilenmodus steht vor ' +
        'jeder Zeile ihre Nummer und ein Tabulator. Token-sparsamer als read_file_text, wenn nur ein ' +
        'Teil gebraucht wird.',
      promptDescription:
        'Liest gezielt Zeilen- oder Byte-Ausschnitte aus Textdateien des Projektordners (Zeilen nummeriert).',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Dateipfad, z. B. "src/app.js".',
          },
          start_line: {
            type: 'integer',
            default: 1,
            description: 'Erste Zeile (1-basiert).',
          },
          end_line: {
            type: 'integer',
            // Der Standard haengt an start_line und laesst sich nicht als
            // `default` ausdruecken — bleibt deshalb Prosa (Issue #183).
            description: 'Letzte Zeile, inklusiv (Standard start_line + 199, höchstens 1000 je Aufruf).',
          },
          start_byte: {
            type: 'integer',
            // Der Byte-Modus ist ein echter zweiter Modus, kein Beiwerk
            // (fs-service.js:1083-1114) — er bleibt im Parametersatz, und die
            // Unvereinbarkeit steht hier einmal statt an beiden Modi (#184).
            description: 'Byte-Offset (0-basiert); zweiter Modus, nicht mit start_line/end_line kombinierbar.',
          },
          length: {
            type: 'integer',
            default: 16000,
            maximum: 32000,
            description: 'Anzahl Bytes ab start_byte.',
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
      skips: ['hidden', 'ignored'],
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Durchsucht Textdateien im Projektordner rekursiv nach einem Suchtext oder regulären Ausdruck ' +
        'und liefert nur Trefferzeilen mit Zeilennummer und Kontext zurück — statt ganzer Dateien. ' +
        'Überspringt versteckte Einträge, Muster aus der .gitignore des Projektroots sowie binäre und zu große Dateien. ' +
        'Jede Zeile wird nur bis 10.000 Zeichen geprüft; reguläre Ausdrücke laufen mit einem Zeitbudget von 5 s pro Suche.',
      // Ohne die Randbedingungen (binaer, zu gross, 10.000 Zeichen je Zeile,
      // 5-s-Zeitbudget): Sie aendern die Wahl des Tools nicht, und wo sie
      // greifen, meldet sich die Suche selbst — das Zeitbudget als Fehler,
      // die Ueberspringer ueber den Hinweis im Konventionsblock (#184).
      modelDescription:
        'Durchsucht Textdateien rekursiv nach einem Suchtext oder regulären Ausdruck und liefert nur ' +
        'Trefferzeilen mit Zeilennummer und Kontext zurück — statt ganzer Dateien.',
      promptDescription:
        'Sucht Text oder Regex in Dateien des Projektordners und liefert Datei, Zeile und Kontext der Treffer.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            // Kein `maxLength: 256` (Issue #183): Die Grenze gilt nur fuer
            // regulaere Ausdruecke (`validateRegexPattern`), nicht fuer die
            // woertliche Suche. Als Schema-Keyword wuerde sie lange
            // Suchtexte verbieten, die tatsaechlich erlaubt sind.
            type: 'string',
            // Laengen- und Komplexitaetsgrenze stehen woertlich in den
            // Fehlermeldungen von `validateRegexPattern`
            // (search-line-matcher.js:55/113) — ein abgelehntes Muster kostet
            // eine Runde, der Vorabtext kostet jede Runde (#184).
            description: 'Suchtext; bei is_regex=true ein regulärer Ausdruck in JavaScript-Syntax.',
          },
          is_regex: {
            type: 'boolean',
            default: false,
            description: 'true, um query als regulären Ausdruck zu lesen (sonst wörtliche Suche).',
          },
          relative_path: {
            type: 'string',
            description: 'Startordner oder einzelne Datei; leer oder "." = ganzes Projekt.',
          },
          context_lines: {
            type: 'integer',
            default: 2,
            maximum: 10,
            description: 'Kontextzeilen vor und nach jeder Trefferzeile.',
          },
          max_results: {
            type: 'integer',
            default: 50,
            maximum: 200,
            description: 'Maximale Anzahl Treffer.',
          },
          case_sensitive: {
            type: 'boolean',
            default: false,
            description: 'true, um Groß-/Kleinschreibung zu beachten.',
          },
          include: {
            type: 'string',
            description: 'Glob-Muster (gitignore-Syntax); nur passende Dateien durchsuchen, z. B. "*.js" oder "src/**/*.md".',
          },
          exclude: {
            type: 'string',
            description: 'Glob-Muster (gitignore-Syntax); passende Dateien und Ordner überspringen, z. B. "dist" oder "*.min.js".',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true, um versteckte Einträge mitzudurchsuchen.',
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
      skips: ['hidden', 'ignored'],
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Findet Dateien und Ordner im Projektordner rekursiv per Glob-Muster und liefert nur die Pfade zurück — ' +
        'ein Aufruf statt vieler list_directory-Runden. Muster in gitignore-Syntax (*, ?, **); ' +
        'Muster mit / sind am Projektroot verankert, ein abschließendes / findet nur Ordner. ' +
        'Überspringt versteckte Einträge, Muster aus der .gitignore des Projektroots sowie .git.',
      // Die Muster-Syntax stand doppelt — hier und am Parameter `pattern`,
      // der sie ohnehin tragen muss. Sie bleibt dort, die Beschreibung sagt
      // nur noch, wofuer man das Tool nimmt (#184).
      modelDescription:
        'Findet Dateien und Ordner rekursiv per Glob-Muster und liefert nur die Pfade zurück — ' +
        'ein Aufruf statt vieler list_directory-Runden.',
      promptDescription:
        'Findet Datei- und Ordnerpfade im Projektordner per Glob-Muster (z. B. "**/*.js").',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob-Muster in gitignore-Syntax (*, ?, **), z. B. "*.md", "src/**/*.js" oder ' +
              '"components/" (nur Ordner); Muster mit / sind am Projektroot verankert.',
          },
          relative_path: {
            type: 'string',
            description: 'Startordner; leer oder "." = ganzes Projekt.',
          },
          max_results: {
            type: 'integer',
            default: 100,
            maximum: 500,
            description: 'Maximale Anzahl gefundener Pfade.',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true, um versteckte Einträge mitzufinden.',
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
      modelDescription:
        'Liefert Metadaten zu einem Pfad, ohne die Datei zu lesen: Existenz, Typ (Datei/Ordner), ' +
        'Größe in Bytes, Änderungszeitpunkt (ISO 8601) und auf Wunsch die Zeilenzahl. Token-sparsam, ' +
        'um vor dem Lesen zu entscheiden, ob und wie gelesen werden sollte — z. B. bei großen Dateien ' +
        'read_file_lines statt read_file_text.',
      promptDescription:
        'Liefert Metadaten (Existenz, Typ, Größe, Änderungszeit, optional Zeilenzahl) zu Pfaden im Projektordner, ohne Dateiinhalt.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Pfad zu Datei oder Ordner; "." = Projektroot.',
          },
          include_line_count: {
            type: 'boolean',
            default: false,
            description: 'true, um bei Textdateien zusätzlich die Zeilenzahl zu liefern.',
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
      modelDescription:
        'Liefert die Gliederung einer Datei mit Zeilennummern, ohne den Inhalt zu lesen: bei Markdown ' +
        'die Überschriften (Ebene 1–6), bei Code Funktions-, Methoden-, Klassen- und Typ-Signaturen ' +
        '(Ebene aus der Einrückung, generische Heuristik). Token-sparsame Landkarte, um danach mit ' +
        'read_file_lines gezielt nur den passenden Abschnitt zu lesen.',
      promptDescription:
        'Liefert die Gliederung einer Datei (Markdown-Überschriften bzw. Funktions-/Klassensignaturen) mit Zeilennummern, ohne den Volltext.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Dateipfad, z. B. "docs/konzept.md".',
          },
          max_depth: {
            type: 'integer',
            // Standard ist „alle Ebenen" und damit keine Zahl — bleibt Prosa.
            description: 'Nur Einträge bis zu dieser Ebene (1 = nur oberste). Standard: alle Ebenen.',
          },
          max_entries: {
            type: 'integer',
            default: 200,
            maximum: 1000,
            description: 'Maximale Anzahl Einträge; darüber wird truncated=true gemeldet.',
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
      skips: ['hidden', 'ignored'],
      targets: (args) => [{ path: args.relative_path ?? '', kind: 'tree', access: 'read' }],
      description:
        'Liefert einen kompakten rekursiven Ordnerbaum des Projektordners in einem Aufruf statt vieler ' +
        'list_directory-Runden. Text-Baum mit Einrückung; Ordner enden auf "/". "[+N]" hinter einem Ordner ' +
        'heißt: N direkte Einträge sind nicht angezeigt (max_depth oder max_entries erreicht). Breitensuche, ' +
        'damit bei knappem Budget zuerst die oberen Ebenen vollständig sind. Überspringt versteckte Einträge, ' +
        'Muster aus der .gitignore des Projektroots sowie .git; folgt keinen Symlinks.',
      // Ohne die Erklaerung der Breitensuche, ohne "folgt keinen Symlinks" und
      // ohne die Beschreibung des Baumformats — Einrueckung und "/" liest man
      // an der Antwort ab. "[+N]" bleibt: es ist das einzige Zeichen dafuer,
      // dass der Baum unvollstaendig ist (#184).
      modelDescription:
        'Liefert einen kompakten rekursiven Ordnerbaum in einem Aufruf statt vieler ' +
        'list_directory-Runden. "[+N]" hinter einem Ordner heißt: N direkte Einträge sind nicht ' +
        'angezeigt (max_depth oder max_entries erreicht).',
      promptDescription:
        'Liefert einen kompakten rekursiven Ordnerbaum des Projektordners (Tiefe und Umfang begrenzbar) in einem Aufruf.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Startordner; leer oder "." = ganzes Projekt.',
          },
          max_depth: {
            type: 'integer',
            default: 3,
            maximum: 10,
            description: 'Maximale Tiefe (1 = nur direkte Einträge). Tiefere Ordner erscheinen mit [+N].',
          },
          max_entries: {
            type: 'integer',
            default: 200,
            maximum: 1000,
            description: 'Maximale Anzahl angezeigter Einträge; darüber truncated=true.',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true, um versteckte Einträge mitzuzeigen.',
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
      modelDescription:
        'Erstellt oder überschreibt eine Textdatei (UTF-8). Fehlende Zwischenordner werden ' +
        'automatisch angelegt. Überschreibt vorhandenen Inhalt vollständig.',
      promptDescription: 'Erstellt oder überschreibt Textdateien im Projektordner.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Pfad zur Zieldatei, z. B. "docs/neu.md".',
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
      // Die Eindeutigkeitsregel samt "inklusive Einrueckung und
      // Zeilenumbruechen" steht woertlich in den beiden Fehlermeldungen
      // (fs-service.js:1288/1293) und am Parameter `old_string` — sie muss
      // nicht zusaetzlich in jeder Runde mitgeschickt werden (#184).
      modelDescription:
        'Ersetzt in einer Textdatei gezielt eine Textstelle: old_string wird durch new_string ersetzt, ' +
        'ohne die Datei komplett neu zu schreiben.',
      promptDescription:
        'Ersetzt gezielt Textstellen in Dateien des Projektordners (old_string → new_string), ohne die ganze Datei neu zu schreiben.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Dateipfad, z. B. "src/app.js".',
          },
          old_string: {
            type: 'string',
            description: 'Exakter zu ersetzender Text; muss eindeutig in der Datei vorkommen.',
          },
          new_string: {
            type: 'string',
            description: 'Neuer Text; ein leerer String löscht die Textstelle.',
          },
          replace_all: {
            type: 'boolean',
            default: false,
            description: 'true, um alle Vorkommen zu ersetzen (sonst muss der Treffer eindeutig sein).',
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
      // Ohne die Atomaritaets- und Rollback-Prosa (Issue #184): Sie aendert
      // die Wahl des Tools nicht und nicht die Form des Aufrufs. Was das
      // Modell dabei verliert, bekommt es im Fehlerfall zurueck — die Datei
      // ist dann unveraendert, und die Meldung sagt, welcher Schritt bzw.
      // Hunk gescheitert ist. Der Preis ist hoechstens eine zusaetzliche
      // Runde, nicht eine falsche Antwort.
      //
      // Stehen bleibt, was das Modell *vorher* wissen muss: die zwei Modi,
      // der Verweis auf edit_file und die drei Dinge, die apply_patch nicht
      // kann — sonst baut es einen Patch, den der Parser grundsaetzlich
      // ablehnt (fs-service.js:657/661).
      modelDescription:
        'Ändert bestehende Textdateien mit mehreren zusammenhängenden Änderungen in einem Aufruf — ' +
        'entweder als Liste von Ersetzungen (edits, alle in derselben Datei) oder als unified diff ' +
        '(patch, auch über mehrere Dateien hinweg). Für eine einzelne Ersetzung ist edit_file ' +
        'einfacher. Dateien anlegen (write_file_text), löschen oder umbenennen kann apply_patch nicht.',
      promptDescription:
        'Wendet mehrere zusammenhängende Änderungen (edits-Liste oder unified diff) atomar auf Dateien des Projektordners an.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Dateipfad, z. B. "src/app.js". Nur im edits-Modus; im patch-Modus stehen die Pfade im Diff.',
          },
          edits: {
            type: 'array',
            maxItems: 50,
            description:
              'Ersetzungen in relative_path, der Reihe nach angewendet — jeder Schritt sieht das ' +
              'Ergebnis der vorherigen. Nicht mit patch kombinierbar.',
            items: {
              type: 'object',
              properties: {
                old_string: {
                  type: 'string',
                  description: 'Exakter zu ersetzender Text; muss zum Zeitpunkt dieses Schritts eindeutig vorkommen.',
                },
                new_string: {
                  type: 'string',
                  description: 'Neuer Text; ein leerer String löscht die Textstelle.',
                },
                replace_all: {
                  type: 'boolean',
                  default: false,
                  description: 'true, um in diesem Schritt alle Vorkommen zu ersetzen.',
                },
              },
              required: ['old_string', 'new_string'],
            },
          },
          patch: {
            type: 'string',
            // Ohne die ausbuchstabierte Diff-Grammatik: Der Parser gibt sie im
            // Fehlerfall woertlich zurueck — Hunk-Kopf (fs-service.js:540),
            // Rumpfzeilen (:588), Dateikopf (:638/:696). Die Toleranz bei den
            // Zeilennummern bleibt, weil sie kein Fehler meldet: ohne sie
            // liest das Modell Dateien neu, die es nicht neu lesen muss (#184).
            description:
              'Unified diff als Text: je Datei "--- alt"/"+++ neu", darunter "@@ …"-Hunks. Die ' +
              'Zeilennummern dürfen leicht verschoben sein, der Kontext muss exakt passen. ' +
              'Nicht mit edits kombinierbar.',
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
            default: 10000,
            maximum: 120000,
            description: 'Zeitlimit in Millisekunden.',
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
              'Optionaler Unterordner als Arbeitsverzeichnis (z. B. "frontend"). '
              + 'Ohne Angabe läuft der Befehl im Projektordner.',
          },
          stdin: {
            type: 'string',
            description: 'Optionale Eingabe, die dem Befehl auf der Standardeingabe zur Verfügung steht.',
          },
          timeout_ms: {
            type: 'integer',
            default: 30000,
            maximum: 300000,
            description: 'Zeitlimit in Millisekunden.',
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
            maxLength: 400,
            description: 'Suchanfrage in natürlicher Sprache oder als Stichworte.',
          },
          max_results: {
            type: 'integer',
            default: 5,
            maximum: 10,
            description: 'Maximale Anzahl Treffer.',
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
            default: 20000,
            maximum: 100000,
            description: 'Maximale Zeichenanzahl des zurückgegebenen Texts.',
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
