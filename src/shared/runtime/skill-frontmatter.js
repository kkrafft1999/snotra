'use strict';

/**
 * Parser für `SKILL.md` nach dem Agent-Skills-Format (agentskills.io):
 * YAML-Frontmatter zwischen zwei `---`-Zeilen, danach der Markdown-Body.
 *
 * Bewusst nur eine kleine YAML-Teilmenge statt einer Dependency: Skalare
 * (`key: wert`), einfache Block-Listen (`- eintrag`) und Inline-Listen
 * (`[a, b]`). Verschachtelte Maps (z. B. `metadata:` mit Unterschlüsseln)
 * werden als flaches Objekt eingelesen, damit ein unbekannter Schlüssel den
 * Scan nicht abbricht — ausgewertet werden ohnehin nur `name` und
 * `description`.
 */

const FRONTMATTER_FENCE = /^---[ \t]*\r?$|^---[ \t]*$/;

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

function splitFrontmatter(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  let index = 0;
  // Führende Leerzeilen und ein BOM tolerieren.
  if (lines.length > 0) lines[0] = lines[0].replace(/^﻿/, '');
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

function parseFrontmatterLines(lines) {
  const data = {};
  let currentKey = null;
  let currentList = null;

  const flushList = () => {
    if (currentKey && currentList) data[currentKey] = currentList;
    currentKey = null;
    currentList = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const listMatch = /^-\s+(.*)$/.exec(trimmed);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(stripComment(listMatch[1])));
      continue;
    }

    const pairMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!pairMatch) continue;

    const indented = /^\s/.test(line);
    const key = pairMatch[1];
    const rest = pairMatch[2];

    if (rest === '') {
      // Entweder Beginn einer Block-Liste oder einer verschachtelten Map.
      flushList();
      currentKey = indented ? null : key;
      currentList = indented ? null : [];
      continue;
    }

    flushList();
    // Verschachtelte Schlüssel (eingerückt) landen bewusst flach im Objekt;
    // sie werden nicht ausgewertet, sollen den Parser aber nicht stören.
    if (!indented || data[key] === undefined) data[key] = parseScalar(rest);
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
