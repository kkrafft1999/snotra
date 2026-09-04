/**
 * Kompakter Tool-Log (Issue #60): reine Text-/Zustandslogik für die
 * Einzeiler-Zeile über der aufklappbaren Schrittliste. Bewusst ohne DOM,
 * damit sie mit `node:test` prüfbar ist; das Rendern bleibt in ChatStream.js.
 *
 * Entscheidungen aus dem Issue:
 * - Läuft ein Tool, zeigt die Zeile diesen Schritt; laufen mehrere parallel,
 *   den ersten plus „+N“.
 * - Wartet das Modell zwischen zwei Runden, übernimmt dieselbe Zeile
 *   „Modell denkt nach …“, damit über dem Tool-Log keine eigene Phasen-Zeile
 *   mehr ein- und ausblendet.
 * - Ist alles erledigt, werden die Schritte nach Art gruppiert
 *   („4 Dateien gelesen · 2 Suchen“). Schritte ohne bekannte Art — Sessions,
 *   die vor #60 gespeichert wurden — fallen auf „‹letzter Schritt› ·
 *   N weitere Schritte“ zurück.
 */

export const THINKING_LABEL = 'Modell denkt nach …';

/** Höchstens so viele Gruppen stehen in der Zeile, der Rest wird gezählt. */
const MAX_SUMMARY_GROUPS = 3;

/**
 * Gruppen-Beschriftungen je Kategorie, als [Singular, Plural] mit „%d“ für die
 * Anzahl. Die Schlüssel sind die Werte aus TOOL_CATEGORIES
 * (`src/shared/contracts/tool-categories.js`) — hier bewusst als Strings, damit
 * dieses Modul ohne Contract-Bundle testbar bleibt.
 */
const GROUP_LABELS = {
  read: ['%d Datei gelesen', '%d Dateien gelesen'],
  search: ['%d Suche', '%d Suchen'],
  list: ['%d Ordner aufgelistet', '%d Ordner aufgelistet'],
  check: ['%d Pfad geprüft', '%d Pfade geprüft'],
  write: ['%d Datei geschrieben', '%d Dateien geschrieben'],
  wait: ['%d Pause', '%d Pausen'],
  other: ['%d Tool-Schritt', '%d Tool-Schritte'],
};

/** Persistierte Alt-Sessions enthalten fertige Strings statt Objekte. */
export function toolLineText(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.line ?? entry?.summary ?? entry?.text ?? '';
}

export function formatStepCountLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return '';
  return count === 1 ? '1 Schritt' : `${count} Schritte`;
}

export function formatMoreStepsLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return '';
  return count === 1 ? '1 weiterer Schritt' : `${count} weitere Schritte`;
}

export function formatGroupLabel(category, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return '';
  const forms = GROUP_LABELS[category] || GROUP_LABELS.other;
  return (count === 1 ? forms[0] : forms[1]).replace('%d', String(count));
}

/**
 * Schritte nach Kategorie zählen, in der Reihenfolge des ersten Auftretens
 * (wie ausgeführt) — nicht nach Häufigkeit, damit die Zeile bei gleichem
 * Ablauf gleich aussieht.
 *
 * @returns {Array<{ category: string, count: number }>}
 */
export function groupToolSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const order = [];
  const counts = new Map();
  for (const step of list) {
    const category = step?.category || 'other';
    if (!counts.has(category)) order.push(category);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return order.map((category) => ({ category, count: counts.get(category) }));
}

function hasKnownCategory(steps) {
  return steps.some((s) => s?.category && s.category !== 'other');
}

/** Gruppierte Zusammenfassung: bis zu drei Gruppen, der Rest wird gezählt. */
function summarizeGroups(steps) {
  const groups = groupToolSteps(steps);
  const shown = groups.slice(0, MAX_SUMMARY_GROUPS);
  const rest = groups
    .slice(MAX_SUMMARY_GROUPS)
    .reduce((sum, group) => sum + group.count, 0);
  const more = formatMoreStepsLabel(rest);
  return {
    text: shown.map((g) => formatGroupLabel(g.category, g.count)).join(' · '),
    extra: more ? `· ${more}` : '',
    category: shown[0]?.category || null,
  };
}

/**
 * Einzeiler aus der aktuellen Schrittliste ableiten.
 *
 * @param {Array<{ text: string, state: 'pending' | 'running' | 'done',
 *   category?: string }>} steps
 *   Schritte in Ausführungsreihenfolge (wie in der aufgeklappten Liste).
 * @param {{ thinking?: boolean }} [options]
 *   `thinking`: Das Modell wartet auf die nächste Runde (kein Tool läuft).
 *   Dann zeigt die Zeile „Modell denkt nach …“ statt der Zusammenfassung;
 *   ein laufender Schritt hat weiterhin Vorrang.
 * @returns {{ text: string, state: 'pending' | 'running' | 'done', extra: string,
 *   category: string | null, count: number, expandable: boolean }}
 *   `extra` ist der Zusatz hinter dem Text („+2“, „· 4 weitere Schritte“ bzw.
 *   „· 5 Schritte“ beim Nachdenken), `category` bestimmt das Symbol,
 *   `expandable` sagt, ob sich das Aufklappen lohnt (ab zwei Schritten; beim
 *   Nachdenken ab einem, weil die Zeile dann keinen Schritt zeigt).
 */
export function summarizeToolLog(steps, { thinking = false } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const count = list.length;
  const expandable = count >= 2;
  if (count === 0) {
    return { text: '', state: 'done', extra: '', category: null, count, expandable };
  }

  const active = list.filter((s) => s && s.state !== 'done');
  if (active.length > 0) {
    const first = active[0];
    return {
      text: first.text || '',
      state: first.state === 'pending' ? 'pending' : 'running',
      extra: active.length > 1 ? `+${active.length - 1}` : '',
      category: first.category || null,
      count,
      expandable,
    };
  }

  if (thinking) {
    return {
      text: THINKING_LABEL,
      state: 'running',
      extra: `· ${formatStepCountLabel(count)}`,
      category: null,
      count,
      expandable: true,
    };
  }

  // Alt-Sessions kennen die Tool-Art nicht: letzter Schritt plus Rest-Zähler.
  if (!hasKnownCategory(list)) {
    const last = list[count - 1];
    const more = formatMoreStepsLabel(count - 1);
    return {
      text: last?.text || '',
      state: 'done',
      extra: more ? `· ${more}` : '',
      category: null,
      count,
      expandable,
    };
  }

  const grouped = summarizeGroups(list);
  return { ...grouped, state: 'done', count, expandable };
}
