const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const { formatSkillPath } = require('../../shared/runtime/skill-path');
const { LOAD_SKILL_TOOL } = require('../../shared/contracts/skills');
const { MEMORY_ORIGINS, MAX_MEMORY_ENTRY_CHARS } = require('../../shared/contracts/memory');
const { createTranslator } = require('../../shared/i18n');
const { fillUiQuotes } = require('../../shared/i18n/ui-quotes');
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
   * Zwei Leser, drei Texte — wer einen aendert, sollte wissen, wen er trifft
   * (Issue #181, seit #291 zweisprachig):
   *  - **Volltext** fuer Einstellungen › Tools, aufklappbar. Die eingebauten
   *    Tools tragen ihn als Katalogschluessel (`descriptionKey`, aufgeloest in
   *    `listCatalog()`); ein MCP-Tool hat statt dessen einen fertigen
   *    `description`-String, weil sein Text vom Server kommt.
   *  - **Kurzzeile** fuer die zugeklappte Zeile in den Einstellungen:
   *    `shortDescriptionKey` bzw. `promptDescription`. Der alte Name stammt aus
   *    einer Zeit, in der sie auch im System-Prompt stand; heute liest sie nur
   *    `listCatalog()`.
   *  - `modelDescription`: Schema-Text ausschliesslich fuer das Modell,
   *    englisch (#276). Gesetzt schlaegt er `description` in `getTools()` —
   *    und ohne festen `description`-String ist er Pflicht, sonst ginge an das
   *    Modell gar nichts mehr.
   */
  function normalizeDefinition(definition) {
    const {
      name, description, descriptionKey, modelDescription,
      parameters, handler, riskClass, additionalRiskClasses,
    } = definition || {};
    const hasText = typeof description === 'string';
    const hasKey = typeof descriptionKey === 'string' && descriptionKey !== '';
    if (!name || (!hasText && !hasKey) || !parameters || typeof handler !== 'function') {
      throw new TypeError('Tool benötigt name, description bzw. descriptionKey, parameters und handler.');
    }
    // Ohne festen Text traegt allein `modelDescription` den Modell-Kanal: der
    // Katalogschluessel loest in die Sprache der Oberflaeche auf und darf dort
    // nie landen (#276/#291).
    if (!hasText && !(typeof modelDescription === 'string' && modelDescription.trim())) {
      throw new TypeError(`Tool ${name}: ohne description braucht es eine modelDescription.`);
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
      // Standard false: ein Schreib-Tool ohne Ziel wird abgelehnt, weil es an
      // der Pfadpruefung vorbei schriebe. `true` sagt, dass dieses Tool
      // ueberhaupt keinen Pfad aus Argumenten bildet — heute nur `remember`,
      // dessen Ziele allein im Memory-Port entstehen (Issue #166).
      pathlessWrite: definition.pathlessWrite === true,
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
  // Grundsatz seit Issue #180: Was der Nutzer in den Einstellungen nicht
  // sieht, bekommt auch das Modell nicht — sonst kostet ein Schema in jeder
  // Runde Tokens, und niemand kann es abwaehlen, weil es in der Tool-Liste
  // gar nicht auftaucht. Das Gegenstueck dazu (`internal`: vor beiden
  // versteckt, nur fuer Tests ausfuehrbar) ist mit #203 entfallen, nachdem
  // sein einziger Traeger `debug_wait` weg war (#197).
  //
  // Die Grundausstattung (`essential`, Issue #195) ist die ausdrueckliche
  // Ausnahme vom Grundsatz: sie steht nicht in der Tool-Liste, geht aber
  // immer an das Modell.
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
   * Katalog für die Einstellungen (Issue #98). Liefert neben dem Volltext den
   * Kurztext als `shortDescription`: die Liste zeigt den Kurztext, den
   * Volltext klappt der Nutzer bei Bedarf auf.
   *
   * Seit #291 ist das der einzige Ort, an dem die beiden Texte entstehen — die
   * eingebauten Tools tragen Katalogschluessel, die hier in die uebergebene
   * Sprache aufgeloest werden. Ohne `locale` gilt die Voreinstellung des
   * Katalogs; der Renderer holt die Liste bei jedem Sprachwechsel neu.
   *
   * Die Grundausstattung (`essential: true`) fehlt hier: Sie geht immer an das
   * Modell, also gibt es nichts zu entscheiden, und eine Zeile ohne Wahl waere
   * nur ein taubes Haekchen (#195). Sonst gilt Katalog = Schemas (#180).
   */
  function listCatalog({ locale } = {}) {
    const t = createTranslator(locale);
    return allDefinitions()
      .filter((definition) => definition.essential !== true)
      .map((definition) => {
        const description = definition.descriptionKey
          ? t(definition.descriptionKey, definition.descriptionParams)
          : definition.description;
        const shortDescription = definition.shortDescriptionKey
          ? t(definition.shortDescriptionKey, definition.shortDescriptionParams)
          : definition.promptDescription || description;
        return {
          name: definition.name,
          description,
          shortDescription,
          riskClass: definition.riskClass,
        };
      });
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
        // `description` ist hier der feste String eines MCP-Tools; die
        // eingebauten haben statt dessen einen Katalogschluessel, der niemals
        // an das Modell geht — deshalb verlangt `normalizeDefinition` dort
        // eine `modelDescription` (#291).
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
  // Verbindet mit „and": die Namen stehen im Konventionsblock, und der geht an
  // das Modell, nicht auf den Bildschirm (Issue #276).
  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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

    const parts = ['Your tools are listed with their full schema in the tools field of this request.'];

    // Ohne Datei-Tools waeren Pfad- und Groessenregel sinnlos — ohne geoeffneten
    // Ordner stehen nur die Tools ohne Ordnerbezug zur Verfuegung (Issue #96).
    if (available.some((definition) => definition.requiresWorkspace !== false)) {
      parts.push(
        'Paths for the file tools are always relative to the folder root ' +
          '("" or "." for the root, "src/index.js" for a file); ' +
          'they handle files up to 2 MB and report an error beyond that.'
      );
    }

    // Aus den sichtbaren Tools gebaut statt fest verdrahtet (Bedingung 2).
    const skipsHidden = available.filter((definition) => definition.skips.includes('hidden'));
    const skipsIgnored = available.filter((definition) => definition.skips.includes('ignored'));
    if (skipsHidden.length > 0) {
      let sentence = `${joinNames(skipsHidden.map((d) => d.name))} skip hidden entries (dot prefix)`;
      if (skipsIgnored.length > 0) {
        sentence +=
          `, ${joinNames(skipsIgnored.map((d) => d.name))} additionally skip everything excluded by ` +
          'the .gitignore of the project root; .git is always left out';
      }
      parts.push(
        // Ohne diesen Hinweis ist ein leeres Ergebnis nicht von „gibt es
        // nicht" zu unterscheiden — eine stille Falschantwort ohne
        // Selbstkorrektur, die teuerste Fehlerklasse (Issue #183).
        `${sentence}. An empty result can therefore mean that there are matches ` +
          'but they were skipped.'
      );
    }
    if (available.some((definition) => definition.parameters?.properties?.include_hidden)) {
      parts.push('Where a tool has the include_hidden parameter, true adds the hidden entries.');
    }

    // Hier stand bis #268 ein Vorbehalt gegen Schreib-Tools („nutze sie
    // zurueckhaltend"). Er hat das Gegenteil bewirkt: Manche Modelle haben
    // daraufhin gar nicht mehr geschrieben, auch auf ausdrueckliche Bitte
    // nicht — eine Bremse fuer gefragte statt fuer ungefragte Schreibvorgaenge.
    // Vor ungewollten Schreibvorgaengen schuetzt ohnehin nicht der Prompt,
    // sondern die Freigabe je Aufruf (Konzept §6/§7) — Code, den das Modell
    // nicht umdeuten kann. Kein Ersatzsatz: jede Formulierung mit demselben
    // Beigeschmack traegt dasselbe Risiko.
    return parts.join('\n');
  }

  /** Definition eines Tools (für Planer und Adapter); null bei unbekanntem Namen. */
  function getDefinition(name) {
    return definitions.get(name) || dynamic.get(name) || null;
  }

  async function execute(name, args, context = {}) {
    const definition = getDefinition(name);
    if (!definition) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    // Defense in depth (Issue #66): kein Handler ohne vorherige Freigabe durch
    // die Policy. Die Engine setzt approved erst nach allow/Nutzerfreigabe.
    if (context.approved !== true) {
      return createPermissionDeniedToolResult({ reason: PERMISSION_DENIAL_REASONS.NOT_APPROVED });
    }
    const allowed = toAllowedNameSet(context.allowedNames);
    if (allowed && !allowed.has(name)) {
      return JSON.stringify({ error: `Tool is not enabled: ${name}` });
    }
    const disabled = toDisabledNameSet(context.disabledNames);
    if (disabled && disabled.has(name)) {
      return JSON.stringify({
        // English sentence, quoted page in the interface language (#294/#276).
        error: fillUiQuotes(context.locale, `Tool is switched off: ${name}. The user can enable it under "{menu:settings.tools}".`),
      });
    }
    if (definition.isAvailable() !== true) {
      return JSON.stringify({
        error: fillUiQuotes(context.locale, `Tool is not configured: ${name}. See "{menu:settings.tools}".`),
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
 * Der Volltext bleibt dabei unangetastet — er ist der Aufklapptext in
 * Einstellungen › Tools und die einzige Stelle, an der ein Nutzer erfaehrt,
 * was ein Tool wirklich tut. Er ist deshalb laenger als die
 * `modelDescription` daneben und laenger als die Kurzzeile, die in den
 * Einstellungen darueber steht — beides gehoert nach einer Kuerzung einmal
 * angesehen. Seit #291 stehen beide zweisprachig im Katalog
 * (`tools.desc.<name>`, `tools.short.<name>`); hier bleiben nur die
 * Schluessel.
 */
function createWorkspaceToolRegistry({
  fsService,
  webSearch = null,
  pythonRunner = null,
  urlFetch = null,
  shellRunner = null,
  memory = null,
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
      descriptionKey: 'tools.desc.list_directory',
      modelDescription: 'Lists the files and subfolders of a directory.',
      shortDescriptionKey: 'tools.short.list_directory',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            // Ordner-Startpunkt, kein Dateipfad: ein Datei-Beispiel waere hier
            // irrefuehrender als gar keins (Issue #183).
            description: 'Starting folder; empty or "." = the whole project.',
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
      descriptionKey: 'tools.desc.load_skill',
      modelDescription:
        'Loads the full instructions of a skill that is switched on. The prompt carries only a '
        + 'short description per skill — if it matches what is at hand, fetch the instructions '
        + 'with this tool before you start on the task, and then follow them. Do not guess what '
        + 'a set of instructions might say.',
      shortDescriptionKey: 'tools.short.load_skill',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the skill, exactly as in the list of skills that are switched on.',
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
              description: 'Name of the skill, exactly as in the list of skills that are switched on.',
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
      descriptionKey: 'tools.desc.read_file_text',
      modelDescription: 'Reads the text content of a file as UTF-8.',
      shortDescriptionKey: 'tools.short.read_file_text',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'File path, e.g. "src/app.js".',
          },
          max_characters: {
            type: 'integer',
            default: 32000,
            maximum: 200000,
            description: 'Maximum number of characters in the returned text.',
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
      descriptionKey: 'tools.desc.read_file_lines',
      // Der Satz zur Token-Ersparnis bleibt ausdruecklich stehen (Issue #184):
      // er kostet 9 Token, eine unnoetige Volllesung dieser Datei kostet ueber
      // 10.000. Der Verweis auf search_in_files faellt weg — das Zeilenformat
      // steht in der Antwort selbst.
      modelDescription:
        'Reads a slice of a text file: either a line range (start_line/end_line, 1-based, ' +
        'inclusive) or a byte range (start_byte/length). In line mode each line is prefixed with ' +
        'its number and a tab. Cheaper in tokens than read_file_text when only part of the file ' +
        'is needed.',
      shortDescriptionKey: 'tools.short.read_file_lines',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'File path, e.g. "src/app.js".',
          },
          start_line: {
            type: 'integer',
            default: 1,
            description: 'First line (1-based).',
          },
          end_line: {
            type: 'integer',
            // Der Standard haengt an start_line und laesst sich nicht als
            // `default` ausdruecken — bleibt deshalb Prosa (Issue #183).
            description: 'Last line, inclusive (default start_line + 199, at most 1000 per call).',
          },
          start_byte: {
            type: 'integer',
            // Der Byte-Modus ist ein echter zweiter Modus, kein Beiwerk
            // (fs-service.js:1083-1114) — er bleibt im Parametersatz, und die
            // Unvereinbarkeit steht hier einmal statt an beiden Modi (#184).
            description: 'Byte offset (0-based); the second mode, cannot be combined with start_line/end_line.',
          },
          length: {
            type: 'integer',
            default: 16000,
            maximum: 32000,
            description: 'Number of bytes from start_byte.',
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
      descriptionKey: 'tools.desc.search_in_files',
      // Ohne die Randbedingungen (binaer, zu gross, 10.000 Zeichen je Zeile,
      // 5-s-Zeitbudget): Sie aendern die Wahl des Tools nicht, und wo sie
      // greifen, meldet sich die Suche selbst — das Zeitbudget als Fehler,
      // die Ueberspringer ueber den Hinweis im Konventionsblock (#184).
      modelDescription:
        'Searches text files recursively for a string or regular expression and returns only ' +
        'the matching lines with line number and context — instead of whole files.',
      shortDescriptionKey: 'tools.short.search_in_files',
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
            description: 'Search string; with is_regex=true a regular expression in JavaScript syntax.',
          },
          is_regex: {
            type: 'boolean',
            default: false,
            description: 'true to read query as a regular expression (otherwise a literal search).',
          },
          relative_path: {
            type: 'string',
            description: 'Starting folder or a single file; empty or "." = the whole project.',
          },
          context_lines: {
            type: 'integer',
            default: 2,
            maximum: 10,
            description: 'Context lines before and after each matching line.',
          },
          max_results: {
            type: 'integer',
            default: 50,
            maximum: 200,
            description: 'Maximum number of hits.',
          },
          case_sensitive: {
            type: 'boolean',
            default: false,
            description: 'true to match case.',
          },
          include: {
            type: 'string',
            description: 'Glob pattern (gitignore syntax); search matching files only, e.g. "*.js" or "src/**/*.md".',
          },
          exclude: {
            type: 'string',
            description: 'Glob pattern (gitignore syntax); skip matching files and folders, e.g. "dist" or "*.min.js".',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true to include hidden entries in the search.',
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
      descriptionKey: 'tools.desc.find_files',
      // Die Muster-Syntax stand doppelt — hier und am Parameter `pattern`,
      // der sie ohnehin tragen muss. Sie bleibt dort, die Beschreibung sagt
      // nur noch, wofuer man das Tool nimmt (#184).
      modelDescription:
        'Finds files and folders recursively by glob pattern and returns the paths only — ' +
        'one call instead of many list_directory rounds.',
      shortDescriptionKey: 'tools.short.find_files',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob pattern in gitignore syntax (*, ?, **), e.g. "*.md", "src/**/*.js" or ' +
              '"components/" (folders only); patterns containing / are anchored at the project root.',
          },
          relative_path: {
            type: 'string',
            description: 'Starting folder; empty or "." = the whole project.',
          },
          max_results: {
            type: 'integer',
            default: 100,
            maximum: 500,
            description: 'Maximum number of paths returned.',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true to include hidden entries in the results.',
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
      descriptionKey: 'tools.desc.stat_path',
      modelDescription:
        'Returns metadata about a path without reading the file: existence, type (file/folder), ' +
        'size in bytes, modification time (ISO 8601) and, on request, the line count. Cheap in ' +
        'tokens for deciding whether and how to read before reading — e.g. read_file_lines instead ' +
        'of read_file_text for large files.',
      shortDescriptionKey: 'tools.short.stat_path',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path to a file or folder; "." = the project root.',
          },
          include_line_count: {
            type: 'boolean',
            default: false,
            description: 'true to additionally return the line count for text files.',
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
      descriptionKey: 'tools.desc.outline_file',
      modelDescription:
        'Returns the outline of a file with line numbers without reading its content: for ' +
        'Markdown the headings (levels 1-6), for code the function, method, class and type ' +
        'signatures (level derived from indentation, generic heuristic). A cheap map for then ' +
        'reading just the relevant section with read_file_lines.',
      shortDescriptionKey: 'tools.short.outline_file',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'File path, e.g. "docs/concept.md".',
          },
          max_depth: {
            type: 'integer',
            // Standard ist „alle Ebenen" und damit keine Zahl — bleibt Prosa.
            description: 'Entries up to this level only (1 = top level only). Default: all levels.',
          },
          max_entries: {
            type: 'integer',
            default: 200,
            maximum: 1000,
            description: 'Maximum number of entries; beyond that truncated=true is reported.',
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
      descriptionKey: 'tools.desc.list_directory_tree',
      // Ohne die Erklaerung der Breitensuche, ohne "folgt keinen Symlinks" und
      // ohne die Beschreibung des Baumformats — Einrueckung und "/" liest man
      // an der Antwort ab. "[+N]" bleibt: es ist das einzige Zeichen dafuer,
      // dass der Baum unvollstaendig ist (#184).
      modelDescription:
        'Returns a compact recursive folder tree in one call instead of many list_directory ' +
        'rounds. "[+N]" after a folder means: N direct entries are not shown (max_depth or ' +
        'max_entries reached).',
      shortDescriptionKey: 'tools.short.list_directory_tree',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Starting folder; empty or "." = the whole project.',
          },
          max_depth: {
            type: 'integer',
            default: 3,
            maximum: 10,
            description: 'Maximum depth (1 = direct entries only). Deeper folders appear with [+N].',
          },
          max_entries: {
            type: 'integer',
            default: 200,
            maximum: 1000,
            description: 'Maximum number of entries shown; beyond that truncated=true.',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description: 'true to show hidden entries as well.',
          },
        },
      },
      handler: (args, { workspaceRoot, skillRoots, sensitivity }) =>
        fsService.runListDirectoryTreeTool(args, workspaceRoot, { skillRoots, sensitivity }),
    },
    {
      name: 'write_file_text',
      targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'write', overwrite: true }],
      descriptionKey: 'tools.desc.write_file_text',
      modelDescription:
        'Creates or overwrites a text file (UTF-8). Missing intermediate folders are created ' +
        'automatically. Replaces any existing content entirely.',
      shortDescriptionKey: 'tools.short.write_file_text',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path to the target file, e.g. "docs/new.md".',
          },
          content: {
            type: 'string',
            description: 'The complete new text content of the file.',
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
      descriptionKey: 'tools.desc.edit_file',
      // Die Eindeutigkeitsregel samt "inklusive Einrueckung und
      // Zeilenumbruechen" steht woertlich in den beiden Fehlermeldungen
      // (fs-service.js:1288/1293) und am Parameter `old_string` — sie muss
      // nicht zusaetzlich in jeder Runde mitgeschickt werden (#184).
      modelDescription:
        'Replaces one specific passage in a text file: old_string is replaced by new_string, ' +
        'without rewriting the whole file.',
      shortDescriptionKey: 'tools.short.edit_file',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'File path, e.g. "src/app.js".',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to replace; must occur exactly once in the file.',
          },
          new_string: {
            type: 'string',
            description: 'The new text; an empty string deletes the passage.',
          },
          replace_all: {
            type: 'boolean',
            default: false,
            description: 'true to replace every occurrence (otherwise the match must be unique).',
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
      descriptionKey: 'tools.desc.apply_patch',
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
        'Changes existing text files with several related edits in one call — either as a list ' +
        'of replacements (edits, all in the same file) or as a unified diff (patch, across several ' +
        'files). For a single replacement edit_file is simpler. apply_patch cannot create files ' +
        '(use write_file_text), delete them or rename them.',
      shortDescriptionKey: 'tools.short.apply_patch',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'File path, e.g. "src/app.js". Only in edits mode; in patch mode the paths are in the diff.',
          },
          edits: {
            type: 'array',
            maxItems: 50,
            description:
              'Replacements in relative_path, applied in order — each step sees the result of the ' +
              'previous one. Cannot be combined with patch.',
            items: {
              type: 'object',
              properties: {
                old_string: {
                  type: 'string',
                  description: 'The exact text to replace; must be unique at the time this step runs.',
                },
                new_string: {
                  type: 'string',
                  description: 'The new text; an empty string deletes the passage.',
                },
                replace_all: {
                  type: 'boolean',
                  default: false,
                  description: 'true to replace every occurrence in this step.',
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
              'Unified diff as text: per file "--- old"/"+++ new", followed by "@@ …" hunks. The line ' +
              'numbers may be slightly off, the context must match exactly. Cannot be combined ' +
              'with edits.',
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
      descriptionKey: 'tools.desc.run_python',
      modelDescription:
        'Runs a Python 3 program and returns stdout, stderr and the exit code. The working '
        + 'directory is the open project folder, so open(\'data.csv\') works directly. Use this '
        + 'tool instead of calculating or guessing: analysing files, conversions, reshaping data, '
        + 'checking regular expressions or data formats. Every call is a fresh script — there is '
        + 'no state between two calls, and only the standard library is guaranteed to be present. '
        + 'No pip install.',
      shortDescriptionKey: 'tools.short.run_python',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'The complete program. Print results with print() — the return value of the last '
              + 'expression is not shown.',
          },
          stdin: {
            type: 'string',
            description: 'Optional input made available to the program on standard input.',
          },
          argv: {
            type: 'array',
            description: 'Optional arguments; available to the program via sys.argv[1:].',
            items: { type: 'string' },
          },
          timeout_ms: {
            type: 'integer',
            default: 10000,
            maximum: 120000,
            description: 'Time limit in milliseconds.',
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
      descriptionKey: 'tools.desc.shell_execute',
      modelDescription:
        'Runs a command in the operating system shell (macOS/Linux in the user\'s login shell, '
        + 'Windows in PowerShell or cmd.exe) and returns stdout, stderr and the exit code. That '
        + 'covers everything the user would do in a terminal: git status, npm run build, docker ps, '
        + 'an installed CLI tool. The working directory is the open project folder or a subfolder '
        + 'of it. One command per call and no state between two calls: a cd only takes effect '
        + 'within the same command (chain with && instead, or set cwd). Not interactive — there is '
        + 'no terminal, so waiting on a prompt runs into the time limit; use non-interactive flags '
        + 'and pass input via stdin. Background processes and servers meant to outlive the call are '
        + 'not possible. Recursive force-deletes, disk operations and rewriting git history are '
        + 'blocked. Every run needs the user\'s approval.',
      shortDescriptionKey: 'tools.short.shell_execute',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The complete command line exactly as it would be typed in a terminal, e.g. '
              + '"git status --short". Chain several steps with &&.',
          },
          cwd: {
            type: 'string',
            description:
              'Optional subfolder to use as the working directory (e.g. "frontend"). '
              + 'Without it the command runs in the project folder.',
          },
          stdin: {
            type: 'string',
            description: 'Optional input made available to the command on standard input.',
          },
          timeout_ms: {
            type: 'integer',
            default: 30000,
            maximum: 300000,
            description: 'Time limit in milliseconds.',
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
      descriptionKey: 'tools.desc.web_search',
      modelDescription:
        'Searches the web and returns a compact list of hits (title, URL, short excerpt, date '
        + 'where available) — not whole pages. Use it for anything more recent than your knowledge '
        + 'cut-off or anything you are asked to back up: versions, prices, news, error messages, '
        + 'standards. The query leaves the machine and goes to an external search service.',
      shortDescriptionKey: 'tools.short.web_search',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: 400,
            description: 'Search query in natural language or as keywords.',
          },
          max_results: {
            type: 'integer',
            default: 5,
            maximum: 10,
            description: 'Maximum number of hits.',
          },
          language: {
            type: 'string',
            description:
              'Optional language hint for the search, e.g. "de" or "en". Without it the search service decides.',
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
      descriptionKey: 'tools.desc.fetch_url',
      modelDescription:
        'Fetches exactly one http(s) address and returns the readable text of the page as '
        + 'Markdown-like prose, truncated to the requested length. Meant as a companion to '
        + 'web_search: find the address there, read the page in one piece here. Local and private '
        + 'addresses are rejected, as is anything that is not text (PDF, images, downloads). The '
        + 'request leaves the machine.',
      shortDescriptionKey: 'tools.short.fetch_url',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Complete http or https address, e.g. "https://example.org/changelog".',
          },
          max_characters: {
            type: 'integer',
            default: 20000,
            maximum: 100000,
            description: 'Maximum number of characters in the returned text.',
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
    {
      name: 'remember',
      // Schreibt eine Datei, also `write` — trotz kleiner Datenmenge. Die
      // Klasse entscheidet die Rueckfrage, und ein Gedaechtniseintrag geht mit
      // jeder kuenftigen Anfrage zum Anbieter: Das soll niemand uebersehen.
      riskClass: TOOL_RISK_CLASSES.WRITE,
      // Die globale Ebene braucht keinen geoeffneten Ordner. Fehlt er, lehnt
      // der Handler nur `scope: "workspace"` ab (Issue #166).
      requiresWorkspace: false,
      // Das Modell benennt keinen Pfad — es waehlt eine Ebene, und wohin die
      // zeigt, entscheidet allein der Memory-Port. Deshalb gibt es hier nichts
      // zu pruefen, was der Pfad-Freigabe vorzulegen waere; `pathlessWrite`
      // nimmt das Tool von der Regel aus, dass ein Schreib-Tool ohne Ziel
      // abgelehnt wird (tool-call-planner.js).
      targets: () => [],
      pathlessWrite: true,
      isAvailable: () => memory !== null,
      descriptionKey: 'tools.desc.remember',
      modelDescription:
        'Remembers a statement permanently (level "workspace" = this folder only, "user" = '
        + 'everywhere). From the next message on, the entry is part of every system prompt. Only '
        + 'lasting facts, never passwords or keys. Load the skill "snotra-memory" before first use.',
      shortDescriptionKey: 'tools.short.remember',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['workspace', 'user'],
            description:
              'Scope: "workspace" for anything that applies to the open folder only (build '
              + 'commands, project conventions, work in progress); "user" for anything that '
              + 'applies regardless of the project (forms of address, language, preferred '
              + 'tools). When in doubt "workspace" — the narrower scope does less damage.',
          },
          text: {
            type: 'string',
            maxLength: MAX_MEMORY_ENTRY_CHARS,
            description:
              'The statement to remember, understandable on its own and without reference to this '
              + 'conversation. So "tests run with npm test" rather than "as just discussed". One '
              + 'thought per call.',
          },
          origin: {
            type: 'string',
            enum: ['requested', 'self'],
            description:
              'Truthfully: "requested" when the user explicitly asked for it, otherwise "self". '
              + 'The user can switch off unprompted remembering — "self" entries are then '
              + 'rejected, and a wrongly declared entry subverts that setting.',
          },
        },
        required: ['scope', 'text', 'origin'],
      },
      handler: async (args, { workspaceRoot } = {}) => {
        if (!memory) {
          return JSON.stringify({ error: 'Memory is not available in this installation.' });
        }
        try {
          const saved = await memory.remember({
            scope: args?.scope,
            text: args?.text,
            origin: args?.origin === 'self' ? MEMORY_ORIGINS.SELF : MEMORY_ORIGINS.REQUESTED,
            workspaceRoot,
          });
          // Der Pfad geht mit zurueck, damit im Chat steht, *wohin* gemerkt
          // wurde — „gemerkt" allein laesst offen, ob es den Ordner oder alle
          // Ordner betrifft, und genau das ist der Unterschied.
          return JSON.stringify({
            ok: true,
            scope: saved.scope,
            file: saved.file,
            remembered: saved.text,
          });
        } catch (error) {
          return JSON.stringify({ error: error?.message || 'The entry could not be saved.' });
        }
      },
    },
  ]);
}

module.exports = {
  createToolRegistry,
  createWorkspaceToolRegistry,
};
