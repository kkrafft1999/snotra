'use strict';

/**
 * The smallest ZIP reader that opens an Office document (#42).
 *
 * DOCX, XLSX and PPTX are ZIP archives of XML files. Reading their text needs
 * the central directory and `inflateRaw`, nothing else — so the archive is
 * read here with Node's own zlib instead of a package that brings a dozen
 * dependencies for the 2 % of it this would use.
 *
 * What it does not do, on purpose: ZIP64 (an Office document beyond 4 GB is
 * not one a model reads), encrypted entries (password-protected Office files
 * are not ZIPs at all, see `document-text.js`), and any method other than
 * stored and deflate — the two every Office application writes.
 */

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
/** The end record sits in the last 22 bytes plus a comment of at most 64 KB. */
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

class ZipFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

function findEndOfCentralDirectory(buf) {
  const stop = Math.max(0, buf.length - EOCD_SEARCH_BYTES);
  for (let at = buf.length - EOCD_MIN_BYTES; at >= stop; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/**
 * Opens `buf` as a ZIP archive. `maxEntryBytes` bounds what one entry may
 * inflate to and `maxTotalBytes` what all reads together may — the guard
 * against an archive that is small on disk and enormous once unpacked.
 */
function openZip(buf, { maxEntryBytes, maxTotalBytes }) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN_BYTES) throw new ZipFormatError('Not a ZIP archive.');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new ZipFormatError('Not a ZIP archive, or a damaged one.');
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) {
    throw new ZipFormatError('ZIP64 archives are not supported.');
  }
  if (dirOffset + dirSize > eocd) throw new ZipFormatError('Damaged ZIP archive.');

  const entries = new Map();
  let at = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('Damaged ZIP archive.');
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    // Office writes names without a leading slash; normalise anyway, the
    // look-up below should not depend on how the writer spelled them.
    entries.set(name.replace(/^\/+/, ''), { flags, method, compressedSize, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  let inflatedTotal = 0;

  function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 0x1) throw new ZipFormatError('Encrypted ZIP entries are not supported.');
    const local = entry.localOffset;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new ZipFormatError('Damaged ZIP archive.');
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipFormatError('Damaged ZIP archive.');
    const remaining = maxTotalBytes - inflatedTotal;
    const limit = Math.min(maxEntryBytes, remaining);
    if (entry.size > limit) throw new ZipFormatError('The document unpacks to more than the limit allows.');
    let data;
    if (entry.method === METHOD_STORED) {
      data = buf.subarray(start, end);
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        // The declared size can lie; the output limit is what holds.
        data = zlib.inflateRawSync(buf.subarray(start, end), { maxOutputLength: Math.max(1, limit) });
      } catch (error) {
        if (error && error.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipFormatError('The document unpacks to more than the limit allows.');
        }
        throw new ZipFormatError('Damaged ZIP archive.');
      }
    } else {
      throw new ZipFormatError(`Unsupported ZIP compression method ${entry.method}.`);
    }
    inflatedTotal += data.length;
    return data;
  }

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    /** The entry as UTF-8 text without a byte order mark, or null when it is missing. */
    readText(name) {
      const data = readEntry(name);
      return data === null ? null : data.toString('utf8').replace(/^﻿/, '');
    },
  };
}

module.exports = { openZip, ZipFormatError };
