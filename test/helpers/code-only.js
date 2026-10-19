'use strict';

// Shared by the source guards: what is left of a file once its comments and
// strings are gone (#1005, #983).

/**
 * The source without comments, and with every string, template and regular
 * expression emptied — what is left is code. Line breaks are kept, so a
 * position still maps to its line.
 */
function codeOnly(source) {
  let out = '';
  let i = 0;
  // Whether a `/` here starts a regular expression rather than a division.
  const regexAllowed = () => /(^|[=(,:;!&|?{}[\]]|\breturn)\s*$/.test(out);
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else if (c === '\'' || c === '"' || c === '`' || (c === '/' && regexAllowed())) {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      out += c + source.slice(i + 1, j).replace(/[^\n]/g, '') + c;
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

module.exports = { codeOnly };
