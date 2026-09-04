/**
 * Kompakter Tool-Log (Issue #60): reine Text-/Zustandslogik für die
 * Einzeiler-Zeile über der aufklappbaren Schrittliste. Bewusst ohne DOM,
 * damit sie mit `node:test` prüfbar ist; das Rendern bleibt in ChatStream.js.
 *
 * Entscheidungen aus dem Issue: zugeklappt steht der letzte Schritt plus
 * „N weitere Schritte“; laufen mehrere Tools parallel, zeigt die Zeile den
 * ersten laufenden Schritt plus „+N“.
 */

/** Persistierte Alt-Sessions enthalten fertige Strings statt Objekte. */
export function toolLineText(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.line ?? entry?.summary ?? entry?.text ?? '';
}

export function formatMoreStepsLabel(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return '';
  return count === 1 ? '1 weiterer Schritt' : `${count} weitere Schritte`;
}

/**
 * Einzeiler aus der aktuellen Schrittliste ableiten.
 *
 * @param {Array<{ text: string, state: 'pending' | 'running' | 'done' }>} steps
 *   Schritte in Ausführungsreihenfolge (wie in der aufgeklappten Liste).
 * @returns {{ text: string, state: 'pending' | 'running' | 'done', extra: string,
 *   count: number, expandable: boolean }}
 *   `extra` ist der Zusatz hinter dem Text („+2“ bzw. „· 4 weitere Schritte“),
 *   `expandable` sagt, ob sich das Aufklappen lohnt (ab zwei Schritten).
 */
export function summarizeToolLog(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const count = list.length;
  const expandable = count >= 2;
  if (count === 0) return { text: '', state: 'done', extra: '', count, expandable };

  const active = list.filter((s) => s && s.state !== 'done');
  if (active.length > 0) {
    const first = active[0];
    return {
      text: first.text || '',
      state: first.state === 'pending' ? 'pending' : 'running',
      extra: active.length > 1 ? `+${active.length - 1}` : '',
      count,
      expandable,
    };
  }

  const last = list[count - 1];
  const more = formatMoreStepsLabel(count - 1);
  return {
    text: last?.text || '',
    state: 'done',
    extra: more ? `· ${more}` : '',
    count,
    expandable,
  };
}
