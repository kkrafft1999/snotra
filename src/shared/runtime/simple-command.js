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
 * `start`/`end` delimit a word in the original line, quotes included.
 *
 * With `{ redirections: true }` (#1379) the line may end in redirections of
 * the program's output: `>`/`>>` of descriptor 1 or 2 into a file, and the
 * duplications `2>&1`, `1>&2`, `>&2`. They run nothing besides the program —
 * the shell opens the file before it starts it — and come back apart from
 * the words. Whether a file target is acceptable is the caller's to judge.
 * Everything else stays "more than the program": input redirection, `&>`,
 * `>|`, other descriptors, a redirection in front of the program, a word
 * after the first redirection, and a target the shell would still expand
 * (`~`, globs, braces).
 *
 * @typedef {{ fd: 1|2, append: boolean, target: string, start: number, end: number }
 *   | { fd: 1|2, dup: 1|2, start: number, end: number }} Redirection
 * @typedef {{ ok: true, words: Array<{ value: string, start: number, end: number }>, redirections?: Redirection[] }
 *   | { ok: false, reason: 'empty'|'compound'|'expansion' }} SimpleCommand
 */

/** Unquoted, these hand the run to something besides the program. */
const OPERATOR_CHARS = new Set([';', '&', '|', '<', '>', '(', ')', '\n', '\r']);
/** Unquoted or inside double quotes, the shell substitutes something here. */
const EXPANSION_CHARS = new Set(['$', '`']);
/** `NAME=value` in front of the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** In a redirection target the shell would still expand these (bash does, even in a redirection). */
const TARGET_EXPANSION = /[~*?[\]{}]/;
/** A word after a redirection, a redirection without a program, an unreadable target. */
const COMPOUND = Object.freeze({ ok: false, reason: 'compound' });

/**
 * @param {unknown} line
 * @param {{ redirections?: boolean }} [options]
 * @returns {SimpleCommand}
 */
function parseSimpleCommand(line, { redirections: withRedirections = false } = {}) {
  const text = typeof line === 'string' ? line : '';
  /** @type {Array<{ value: string, start: number, end: number, raw: string }>} */
  const words = [];
  /** @type {Redirection[]} */
  const redirections = [];
  /** @type {{ value: string, start: number, end: number, raw: string }|null} */
  let current = null;
  /** A `>` read, its target word not yet. @type {{ fd: 1|2, append: boolean, start: number }|null} */
  let pending = null;
  let i = 0;

  /** @param {number} at */
  const startWord = (at) => {
    if (!current) current = { value: '', start: at, end: at, raw: '' };
    return current;
  };
  /**
   * Closes the word in progress: an argument, or the target of a pending
   * redirection. False when the line stops being one simple command.
   *
   * @param {number} at
   */
  const endWord = (at) => {
    if (!current) return true;
    const word = current;
    word.end = at;
    current = null;
    if (pending) {
      if (!word.value || TARGET_EXPANSION.test(word.value)) return false;
      redirections.push({ fd: pending.fd, append: pending.append, target: word.value, start: pending.start, end: at });
      pending = null;
      return true;
    }
    if (redirections.length > 0) return false;
    words.push(word);
    return true;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      if (!endWord(i)) return COMPOUND;
      i += 1;
      continue;
    }
    if (ch === '>' && withRedirections && !pending) {
      // `2>`, `1>`: digits right before the operator name the descriptor.
      // Set by startWord, which the checker cannot see from here.
      const open = /** @type {{ value: string, start: number, end: number, raw: string }|null} */ (current);
      /** @type {1|2} */
      let fd = 1;
      let start = i;
      if (open && (open.raw === '1' || open.raw === '2')) {
        fd = open.raw === '2' ? 2 : 1;
        start = open.start;
        current = null;
      } else if (open && /^[0-9]+$/.test(open.raw)) {
        return COMPOUND;
      } else if (!endWord(i)) {
        return COMPOUND;
      }
      if (words.length === 0) return COMPOUND;
      let j = i + 1;
      const append = text[j] === '>';
      if (append) j += 1;
      if (text[j] === '&') {
        const dup = text[j + 1];
        const after = text[j + 2];
        if (append || (dup !== '1' && dup !== '2') || (after !== undefined && after !== ' ' && after !== '\t')) return COMPOUND;
        redirections.push({ fd, dup: dup === '2' ? 2 : 1, start, end: j + 2 });
        i = j + 2;
        continue;
      }
      pending = { fd, append, start };
      i = j;
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) return { ok: false, reason: 'compound' };
    if (EXPANSION_CHARS.has(ch)) return { ok: false, reason: 'expansion' };
    // A comment could hide the rest of the line from the reader of the card.
    if (ch === '#' && !current) return { ok: false, reason: 'compound' };
    const word = startWord(i);
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return { ok: false, reason: 'compound' };
      word.value += next;
      word.raw += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: 'compound' };
      word.value += text.slice(i + 1, close);
      word.raw += text.slice(i, close + 1);
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
      word.value += value;
      word.raw += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    word.value += ch;
    word.raw += ch;
    i += 1;
  }
  if (!endWord(text.length) || pending) return COMPOUND;

  if (words.length === 0) return { ok: false, reason: 'empty' };
  // Only the raw spelling tells an assignment from a quoted argument.
  if (ASSIGNMENT.test(words[0].raw)) return { ok: false, reason: 'compound' };
  const plain = words.map(({ value, start, end }) => ({ value, start, end }));
  return withRedirections ? { ok: true, words: plain, redirections } : { ok: true, words: plain };
}

module.exports = { parseSimpleCommand };
