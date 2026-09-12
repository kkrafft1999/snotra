'use strict';

/**
 * Parser für `SKILL.md` nach dem Agent-Skills-Format (agentskills.io):
 * YAML-Frontmatter zwischen zwei `---`-Zeilen, danach der Markdown-Body.
 *
 * Bewusst nur eine kleine YAML-Teilmenge statt einer Dependency: Skalare
 * (`key: wert`), einfache Block-Listen (`- eintrag`), Inline-Listen
 * (`[a, b]`) sowie mehrzeilige Werte — Block-Skalare (`>`/`|` samt
 * Einrückungs- und Chomping-Indikator) und Plain-Skalare mit eingerückten
 * Folgezeilen. Lange `description`-Felder werden praktisch immer so
 * geschrieben (Issue #112). Verschachtelte Maps (z. B. `metadata:` mit
 * Unterschlüsseln) werden als flaches Objekt eingelesen, damit ein
 * unbekannter Schlüssel den Scan nicht abbricht — ausgewertet werden ohnehin
 * nur `name` und `description`.
 */

const FRONTMATTER_FENCE = /^---[ \t]*\r?$|^---[ \t]*$/;
/** `>`/`|`, optional mit Einrückungs- (`2`) und Chomping-Indikator (`-`/`+`). */
const BLOCK_SCALAR_HEADER = /^([|>])(\d*)([-+]?)$/;

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function stripComment(value) {
  // Nur unquotierte Kommentare entfernen — `description: "a # b"` bleibt heil.
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const hashAt = trimmed.indexOf(' #');
  return hashAt === -1 ? trimmed : trimmed.slice(0, hashAt).trim();
}

function parseInlineList(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part))
    .filter((part) => part.length > 0);
}

function parseScalar(raw) {
  const value = stripComment(raw);
  if (value.startsWith('[') && value.endsWith(']')) return parseInlineList(value);
  return stripQuotes(value);
}

/** Einrückung in Spalten; Tabs sind vorher durch Leerzeichen ersetzt. */
function indentWidth(line) {
  return /^ */.exec(line)[0].length;
}

/**
 * Fügt die Zeilen eines Block-Skalars nach YAML-Regeln zusammen: `>` faltet
 * einfache Umbrüche zu Leerzeichen (stärker eingerückte Zeilen bleiben
 * ungefaltet), `|` behält jeden Umbruch; Leerzeilen werden in beiden Fällen zu
 * Umbrüchen. Das Chomping steuert das Ende: `-` ohne, `+` mit allen,
 * ohne Indikator mit genau einem abschließenden Umbruch.
 */
function joinBlockLines(contentLines, style, chomping) {
  let text = '';
  let started = false;
  let breaks = 0;
  let previousMoreIndented = false;

  for (const line of contentLines) {
    if (line === '') {
      if (started) breaks += 1;
      continue;
    }
    const moreIndented = line.startsWith(' ');
    if (!started) {
      text = line;
      started = true;
    } else if (style === '|') {
      text += '\n'.repeat(breaks + 1) + line;
    } else if (breaks > 0) {
      text += '\n'.repeat(breaks) + line;
    } else {
      text += (moreIndented || previousMoreIndented ? '\n' : ' ') + line;
    }
    previousMoreIndented = moreIndented;
    breaks = 0;
  }

  if (!started) return '';
  if (chomping === '-') return text;
  if (chomping === '+') return text + '\n'.repeat(breaks + 1);
  return `${text}\n`;
}

/**
 * Liest den eingerückten Block eines Block-Skalars ab `start`.
 *
 * @returns {{ value: string, next: number }} Wert und Index der ersten Zeile,
 *   die nicht mehr zum Block gehört.
 */
function readBlockScalar(lines, start, keyIndent, header) {
  const [, style, explicitIndent, chomping] = header;
  let blockIndent = explicitIndent ? keyIndent + Number(explicitIndent) : -1;
  const content = [];
  let index = start;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    // Leerzeilen beenden den Block nicht; ob sie zählen, entscheidet erst das
    // Chomping am Ende.
    if (line.trim() === '') {
      content.push('');
      continue;
    }
    const indent = indentWidth(line);
    if (indent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = indent;
    if (indent < blockIndent) break;
    content.push(line.slice(blockIndent));
  }

  return { value: joinBlockLines(content, style, chomping), next: index };
}

function splitFrontmatter(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  let index = 0;
  // Führende Leerzeilen und ein BOM tolerieren.
  if (lines.length > 0) lines[0] = lines[0].replace(/^\ufeff/, '');
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index >= lines.length || !FRONTMATTER_FENCE.test(lines[index])) return null;

  const start = index + 1;
  let end = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (FRONTMATTER_FENCE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  return {
    frontmatterLines: lines.slice(start, end),
    body: lines.slice(end + 1).join('\n'),
  };
}

function parseFrontmatterLines(rawLines) {
  const lines = rawLines.map((rawLine) => rawLine.replace(/\t/g, '  '));
  const data = {};
  let currentKey = null;
  let currentList = null;
  // Schlüssel eines Plain-Skalars, dessen Wert in Folgezeilen weitergeht.
  let plainKey = null;
  let plainIndent = 0;

  const flushList = () => {
    if (currentKey && currentList) data[currentKey] = currentList;
    currentKey = null;
    currentList = null;
  };

  // Verschachtelte Schlüssel (eingerückt) landen bewusst flach im Objekt;
  // sie werden nicht ausgewertet, sollen den Parser aber nicht stören und
  // dürfen einen gleichnamigen Schlüssel der obersten Ebene nicht überschreiben.
  const assign = (key, indented, value) => {
    if (!indented || data[key] === undefined) data[key] = value;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      plainKey = null;
      continue;
    }

    const listMatch = /^-\s+(.*)$/.exec(trimmed);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(stripComment(listMatch[1])));
      plainKey = null;
      continue;
    }

    const pairMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!pairMatch) {
      // Folgezeile eines mehrzeiligen Plain-Skalars: eingerückter Text, der
      // weder Paar noch Listeneintrag ist. Alles andere wird wie bisher
      // überlesen, statt den Scan abzubrechen.
      if (plainKey !== null && !listMatch && indentWidth(line) > plainIndent) {
        data[plainKey] = `${data[plainKey]} ${stripComment(trimmed)}`.trim();
      }
      continue;
    }

    const indent = indentWidth(line);
    const indented = indent > 0;
    const key = pairMatch[1];
    const rest = pairMatch[2];
    plainKey = null;

    const blockHeader = BLOCK_SCALAR_HEADER.exec(stripComment(rest));
    if (blockHeader) {
      flushList();
      const block = readBlockScalar(lines, index + 1, indent, blockHeader);
      assign(key, indented, block.value);
      index = block.next - 1;
      continue;
    }

    if (rest === '') {
      // Entweder Beginn einer Block-Liste oder einer verschachtelten Map.
      flushList();
      currentKey = indented ? null : key;
      currentList = indented ? null : [];
      continue;
    }

    flushList();
    const value = parseScalar(rest);
    assign(key, indented, value);
    if (typeof value === 'string' && data[key] === value) {
      plainKey = key;
      plainIndent = indent;
    }
  }

  flushList();
  return data;
}

/**
 * @param {string} text — Rohinhalt einer `SKILL.md`
 * @returns {{ frontmatter: Record<string, unknown>, body: string } | null}
 *   `null`, wenn kein abgeschlossenes Frontmatter vorhanden ist.
 */
function parseSkillDocument(text) {
  const split = splitFrontmatter(text);
  if (!split) return null;
  return {
    frontmatter: parseFrontmatterLines(split.frontmatterLines),
    body: split.body.replace(/^\n+/, '').trimEnd(),
  };
}

module.exports = {
  parseSkillDocument,
};
