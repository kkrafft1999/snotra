'use strict';

/**
 * Memory-Port (Issue #166): liest und schreibt die beiden `memory.md`-Dateien.
 *
 * **Pfade entstehen ausschließlich hier.** Das `remember`-Tool bekommt vom
 * Modell nur die Ebene (`workspace` | `user`) und den Text, nie einen Pfad —
 * deshalb weicht das Schreiben nach `~/.snotra/` die Workspace-Grenze der
 * Datei-Tools nicht auf: Es gibt nichts, wohin das Modell zeigen könnte.
 *
 * Gelesen wird wie bei den Projektanweisungen **ohne Cache und ohne Watcher**
 * (siehe `project-instructions-adapter.js`): zwei `readFile` je Anfrage kosten
 * gegen einen Modellaufruf nichts, und eine von Hand geänderte Datei wirkt ab
 * der nächsten Nachricht.
 *
 * Geschrieben wird **seriell je Datei**. Zwei Chatfenster im selben Ordner
 * dürfen sich nicht gegenseitig überschreiben — und genau das täten sie beim
 * Lesen-Ändern-Schreiben ohne Reihenfolge.
 */

const {
  MEMORY_FILE,
  MEMORY_SCOPES,
  MEMORY_SCOPE_ORDER,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  MEMORY_ORIGINS,
  isMemoryScope,
  appendMemoryEntry,
  removeMemoryEntryLine,
  formatMemoryDate,
} = require('../../shared/contracts/memory');
const { fillUiQuotes } = require('../../shared/i18n/ui-quotes');

function createMemoryAdapter({
  fs,
  path,
  os,
  maxChars = MAX_MEMORY_CHARS,
  /**
   * Ob Snotra ungefragt merken darf — aus den Einstellungen, bei **jedem**
   * Aufruf frisch gelesen. Ein Schalter, der erst nach einem Neustart wirkt,
   * wäre bei diesem Thema keiner. Ohne die Funktion gilt alles als erlaubt;
   * die Grenze setzt dann nur die Freigabe.
   */
  isSelfMemoryAllowed = null,
  /**
   * Die Oberflaechensprache — fuer die Einstellungsseiten, die diese Meldungen
   * zitieren (#294). Wie der Schalter darueber bei jedem Aufruf frisch gelesen,
   * damit ein Sprachwechsel sofort gilt.
   */
  getLocale = null,
}) {
  if (!fs || !path) throw new TypeError('createMemoryAdapter benötigt fs und path.');

  /** Laufende Schreibvorgänge je Datei — der Lock ist eine Promise-Kette. */
  const queues = new Map();

  function homeDir() {
    let home;
    try {
      home = os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
    return typeof home === 'string' && home.trim() ? path.resolve(home) : null;
  }

  /** Absoluter Pfad einer Ebene, oder null, wenn es sie gerade nicht gibt. */
  function fileFor(scope, workspaceRoot) {
    if (scope === MEMORY_SCOPES.WORKSPACE) {
      const root =
        typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
      // Ohne geöffneten Ordner gibt es kein Projekt-Gedächtnis — kein Fehler,
      // nur nichts zu tun.
      return root ? path.join(root, '.agents', MEMORY_FILE) : null;
    }
    const home = homeDir();
    return home ? path.join(home, '.snotra', MEMORY_FILE) : null;
  }

  async function readFileOrNull(file) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return typeof raw === 'string' ? raw : null;
    } catch {
      // Fehlend, unlesbar, ein Verzeichnis statt einer Datei: alles derselbe
      // Normalfall. Ein Gedächtnis, das es nicht gibt, ist kein Fehler.
      return null;
    }
  }

  /** Vorgänge auf derselben Datei laufen nacheinander. */
  function serialize(file, task) {
    const previous = queues.get(file) || Promise.resolve();
    // `catch` vor dem Anhängen: Ein gescheiterter Vorgang darf die Kette nicht
    // vergiften, sonst schlägt jeder spätere Schreibversuch mit fremdem Fehler fehl.
    const next = previous.catch(() => {}).then(task);
    queues.set(
      file,
      next.catch(() => {})
    );
    return next;
  }

  async function writeFileAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  }

  return {
    /** Beide Ebenen in Lesereihenfolge; leere und fehlende fallen weg. */
    async load({ workspaceRoot = null } = {}) {
      const targets = MEMORY_SCOPE_ORDER.map((scope) => ({
        scope,
        file: fileFor(scope, workspaceRoot),
      })).filter((target) => Boolean(target.file));
      const results = await Promise.all(
        targets.map(async ({ scope, file }) => {
          const raw = await readFileOrNull(file);
          if (!raw || !raw.trim()) return null;
          const truncated = raw.length > maxChars;
          return {
            scope,
            file,
            text: truncated ? raw.slice(0, maxChars) : raw,
            truncated,
          };
        })
      );
      return results.filter(Boolean);
    },

    /**
     * Einen Eintrag anhängen. Liefert den gespeicherten Text und den Pfad —
     * beides geht ins Tool-Ergebnis, damit im Chat steht, **wohin** gemerkt
     * wurde und nicht nur, dass gemerkt wurde.
     */
    async remember({ scope, workspaceRoot = null, text, origin } = {}) {
      if (!isMemoryScope(scope)) throw new TypeError(`Unknown memory scope: ${scope}`);
      const body = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
      if (!body) throw new TypeError('An empty entry cannot be remembered.');
      if (body.length > MAX_MEMORY_ENTRY_CHARS) {
        throw new RangeError(
          `An entry may be at most ${MAX_MEMORY_ENTRY_CHARS} characters (here: ${body.length}).`
        );
      }
      // Vor allem anderen: Der Nutzer kann selbstständiges Merken abschalten.
      // Geprüft wird hier und nicht im Tool — ein Tool ist eine Schnittstelle,
      // und eine Regel, die nur dort steht, gilt nur für den, der sie benutzt.
      if (origin === MEMORY_ORIGINS.SELF && typeof isSelfMemoryAllowed === 'function') {
        if ((await isSelfMemoryAllowed()) === false) {
          throw new Error(fillUiQuotes(
            typeof getLocale === 'function' ? getLocale() : null,
            'Unprompted remembering is switched off ("{menu:settings.memory}"). '
              + 'Only what the user explicitly asks for is remembered.'
          ));
        }
      }
      const file = fileFor(scope, workspaceRoot);
      if (!file) {
        throw new Error(
          scope === MEMORY_SCOPES.WORKSPACE
            ? 'Without an open folder there is no project memory.'
            : 'The user directory could not be determined.'
        );
      }
      return serialize(file, async () => {
        const current = (await readFileOrNull(file)) || '';
        const next = appendMemoryEntry(current, {
          scope,
          text: body,
          origin,
          date: formatMemoryDate(new Date()),
        });
        if (next.length > maxChars) {
          throw new RangeError(fillUiQuotes(
            typeof getLocale === 'function' ? getLocale() : null,
            `The ${scope === MEMORY_SCOPES.USER ? 'global' : 'project'} memory is full `
              + `(${maxChars} characters). The user can delete entries under "{menu:settings.memory}".`
          ));
        }
        await writeFileAtomic(file, next);
        return { scope, file, text: body };
      });
    },

    /** Eine Eintragszeile entfernen (Einstellungen › Gedächtnis › Vergessen). */
    async forget({ scope, workspaceRoot = null, line } = {}) {
      if (!isMemoryScope(scope)) throw new TypeError(`Unbekannte Gedächtnis-Ebene: ${scope}`);
      const file = fileFor(scope, workspaceRoot);
      if (!file) return { removed: false };
      return serialize(file, async () => {
        const current = await readFileOrNull(file);
        if (current === null) return { removed: false };
        const { text, removed } = removeMemoryEntryLine(current, line);
        if (!removed) return { removed: false };
        await writeFileAtomic(file, text);
        return { removed: true, scope, file };
      });
    },

    /** Den ganzen Text einer Ebene ersetzen — für die Bearbeitung von Hand. */
    async replace({ scope, workspaceRoot = null, text } = {}) {
      if (!isMemoryScope(scope)) throw new TypeError(`Unbekannte Gedächtnis-Ebene: ${scope}`);
      const file = fileFor(scope, workspaceRoot);
      if (!file) throw new Error('Für diese Ebene gibt es gerade keinen Speicherort.');
      const next = typeof text === 'string' ? text : '';
      if (next.length > maxChars) {
        throw new RangeError(`Höchstens ${maxChars} Zeichen je Ebene.`);
      }
      return serialize(file, async () => {
        await writeFileAtomic(file, next);
        return { scope, file };
      });
    },

    /** Pfade zur Anzeige in den Einstellungen — ohne zu lesen. */
    paths({ workspaceRoot = null } = {}) {
      return MEMORY_SCOPE_ORDER.reduce((acc, scope) => {
        acc[scope] = fileFor(scope, workspaceRoot);
        return acc;
      }, {});
    },
  };
}

module.exports = { createMemoryAdapter };
