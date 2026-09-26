'use strict';

/**
 * Reads a shell command line as one simple command, or says why it is not
 * one (#408).
 *
 * A program allowance hands extra rights to one program. The sandbox cannot
 * tell the processes of one run apart, so the allowance may only apply when
 * nothing else runs in it: no chain, no pipe, no redirection, no subshell, no
 * variable set in front of the program (`DYLD_INSERT_LIBRARIES=… prog` would
 * load foreign code into it), and nothing the shell has to expand first.
 *
 * Deliberately stricter than the shell: whatever it cannot read with
 * certainty counts as "more than the program". Quotes and backslashes are
 * understood, because arguments with spaces are common and harmless.
 *
 * @returns {{ok: true, words: {value: string, start: number, end: number}[]}
 *   | {ok: false, reason: 'empty'|'compound'|'expansion'}}
 *   `start`/`end` delimit a word in the original line, quotes included.
 */

/** Unquoted, these hand the run to something besides the program. */
const OPERATOR_CHARS = new Set([';', '&', '|', '<', '>', '(', ')', '\n', '\r']);
/** Unquoted or inside double quotes, the shell substitutes something here. */
const EXPANSION_CHARS = new Set(['$', '`']);
/** `NAME=value` in front of the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseSimpleCommand(line) {
  const text = typeof line === 'string' ? line : '';
  const words = [];
  let current = null;
  let i = 0;

  const startWord = (at) => {
    if (!current) current = { value: '', start: at, end: at, raw: '' };
  };
  const endWord = (at) => {
    if (!current) return;
    current.end = at;
    words.push(current);
    current = null;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      endWord(i);
      i += 1;
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) return { ok: false, reason: 'compound' };
    if (EXPANSION_CHARS.has(ch)) return { ok: false, reason: 'expansion' };
    // A comment could hide the rest of the line from the reader of the card.
    if (ch === '#' && !current) return { ok: false, reason: 'compound' };
    startWord(i);
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return { ok: false, reason: 'compound' };
      current.value += next;
      current.raw += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: 'compound' };
      current.value += text.slice(i + 1, close);
      current.raw += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= text.length) return { ok: false, reason: 'compound' };
        const c = text[j];
        if (c === '"') break;
        if (EXPANSION_CHARS.has(c)) return { ok: false, reason: 'expansion' };
        if (c === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) {
          if (text[j + 1] === '\n') return { ok: false, reason: 'compound' };
          value += text[j + 1];
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      current.value += value;
      current.raw += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    current.value += ch;
    current.raw += ch;
    i += 1;
  }
  endWord(text.length);

  if (words.length === 0) return { ok: false, reason: 'empty' };
  // Only the raw spelling tells an assignment from a quoted argument.
  if (ASSIGNMENT.test(words[0].raw)) return { ok: false, reason: 'compound' };
  return { ok: true, words: words.map(({ value, start, end }) => ({ value, start, end })) };
}

module.exports = { parseSimpleCommand };
