'use strict';

/**
 * Width and height of a PNG, JPEG or WebP image, read from its head (#85).
 *
 * The image tool reports the size of what it wrote, and the service's word
 * for it is not taken on trust: a model asked for 1536x1024 may get something
 * else back. Only the formats the tool writes are understood; anything else
 * gives null, and the result simply goes without dimensions.
 */

function readUInt24LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
}

function pngDimensions(buf) {
  // Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4).
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Start-of-frame markers that carry the size; C4, C8 and CC are not frames. */
function isStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(buf) {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (offset + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: readUInt24LE(buf, 24) + 1, height: readUInt24LE(buf, 27) + 1 };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    // Frame tag (3) and start code (3) precede the 14-bit sizes.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * @param {Buffer} buf
 * @param {string} mime  image/png, image/jpeg or image/webp
 * @returns {{ width: number, height: number } | null}
 */
function imageDimensions(buf, mime) {
  if (!Buffer.isBuffer(buf)) return null;
  let size = null;
  try {
    if (mime === 'image/png') size = pngDimensions(buf);
    else if (mime === 'image/jpeg') size = jpegDimensions(buf);
    else if (mime === 'image/webp') size = webpDimensions(buf);
  } catch {
    size = null;
  }
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  return size;
}

module.exports = { imageDimensions };
