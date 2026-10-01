'use strict';

/**
 * Writes a minimal `app.asar` synchronously (#569): one header, the files
 * one after another. Enough for the self-update to read `package.json` from a
 * package, and closed on return — `@electron/asar` resolves before Windows has
 * let go of the file, and a test that zips the package right after it then
 * fails with "access denied".
 *
 * @param {string} file
 * @param {Record<string, string>} entries  file name → content, top level only
 */
function writeMinimalAsar(file, entries) {
  const files = {};
  const blobs = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    files[name] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8');
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  // Header pickle: payload size, then the string with its length in front.
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(json.length, 4);
  padded.copy(header, 8);
  // Size pickle: payload size 4, then the length of the header pickle.
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  require('node:fs').writeFileSync(file, Buffer.concat([size, header, ...blobs]));
}

module.exports = { writeMinimalAsar };
