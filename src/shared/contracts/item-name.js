'use strict';

/**
 * Names for a new file, a new folder or a rename in the tree (#349).
 *
 * One rule for both sides: the renderer checks while the user types, main
 * checks again before it touches the disk — the renderer is no boundary.
 *
 * The rule is the strictest of the three platforms, on all three. A project
 * travels through git and shared drives; a name macOS accepts but Windows
 * cannot check out (`a:b.md`, `aux.txt`, `notes.`) breaks the folder for
 * whoever opens it there.
 *
 * Leading and trailing white space is dropped, as every file manager does;
 * the name that comes back is the one to use.
 */

// Windows refuses these in any name; `/` and `\` are separators everywhere.
const FORBIDDEN_CHARACTERS = /[<>:"|?*]/;
const SEPARATORS = /[/\\]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// Device names Windows reserves, with or without an extension: `con`, `nul.txt`.
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
// NAME_MAX on APFS, ext4 and NTFS (there in UTF-16 units, which is more).
const MAX_ITEM_NAME_BYTES = 255;

/**
 * Why a name is refused, as the code the renderer looks its words up by.
 * `exists` and the rest of ITEM_FAILURE_REASONS come from main, which knows
 * the disk.
 */
const ITEM_NAME_REASONS = Object.freeze({
  EMPTY: 'empty',
  DOTS: 'dots',
  SEPARATOR: 'separator',
  CONTROL: 'control',
  CHARACTER: 'character',
  TRAILING_DOT: 'trailing-dot',
  RESERVED: 'reserved',
  TOO_LONG: 'too-long',
});

/**
 * Why creating or renaming failed on disk. `refused` — outside the open
 * folder — and `missing`/`permission` share their codes with a read (#641).
 */
const ITEM_FAILURE_REASONS = Object.freeze({
  EXISTS: 'exists',
  PERMISSION: 'permission',
  MISSING: 'missing',
  REFUSED: 'refused',
  ROOT: 'root',
  NOT_FOLDER: 'not-folder',
  FAILED: 'failed',
});

function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * @param {unknown} raw  What the user typed.
 * @returns {{ ok: true, name: string } | { ok: false, reason: string, name: string, character?: string }}
 */
function validateItemName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  const refuse = (reason, extra = {}) => ({ ok: false, reason, name, ...extra });
  if (!name) return refuse(ITEM_NAME_REASONS.EMPTY);
  if (name === '.' || name === '..') return refuse(ITEM_NAME_REASONS.DOTS);
  if (SEPARATORS.test(name)) return refuse(ITEM_NAME_REASONS.SEPARATOR);
  if (CONTROL_CHARACTERS.test(name)) return refuse(ITEM_NAME_REASONS.CONTROL);
  const forbidden = name.match(FORBIDDEN_CHARACTERS);
  if (forbidden) return refuse(ITEM_NAME_REASONS.CHARACTER, { character: forbidden[0] });
  if (name.endsWith('.')) return refuse(ITEM_NAME_REASONS.TRAILING_DOT);
  if (RESERVED_NAMES.test(name)) return refuse(ITEM_NAME_REASONS.RESERVED);
  if (utf8Length(name) > MAX_ITEM_NAME_BYTES) return refuse(ITEM_NAME_REASONS.TOO_LONG);
  return { ok: true, name };
}

/**
 * Whether two names may be one entry on a file system that folds case or
 * Unicode normalization (APFS, NTFS): `Readme.md` and `README.md`, or `ü`
 * composed and decomposed.
 */
function namesFoldEqual(a, b) {
  return String(a).normalize('NFC').toLowerCase() === String(b).normalize('NFC').toLowerCase();
}

module.exports = {
  ITEM_NAME_REASONS,
  ITEM_FAILURE_REASONS,
  MAX_ITEM_NAME_BYTES,
  validateItemName,
  namesFoldEqual,
};
