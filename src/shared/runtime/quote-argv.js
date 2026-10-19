'use strict';

/**
 * POSIX single-quoting, so an argv survives the trip through `sh -c`.
 *
 * @param {unknown[]} argv
 */
function quoteArgv(argv) {
  return argv
    .map((arg) => {
      const value = String(arg);
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

module.exports = { quoteArgv };
