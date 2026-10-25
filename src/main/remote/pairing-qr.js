'use strict';

/**
 * The pairing code as a QR code (#1110): main draws it, the window only
 * paints its modules. Byte mode, error correction M — the payload is about
 * fifty characters (`snotra-pair:v1/<relay host>/<twenty symbols>`,
 * docs/remote/remote-protocol.md §4), which makes version 3 or 4: large modules a
 * phone's camera reads from a distance.
 */

const qrcode = require('qrcode-generator');

/**
 * The modules row by row, `1` for dark; null when the text cannot be encoded.
 * @param {string} text
 * @returns {string[] | null}
 */
function qrModules(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const size = qr.getModuleCount();
    const rows = [];
    for (let row = 0; row < size; row += 1) {
      let line = '';
      for (let col = 0; col < size; col += 1) line += qr.isDark(row, col) ? '1' : '0';
      rows.push(line);
    }
    return rows;
  } catch (error) {
    // Too long for a QR code, which the protocol's payload never is: the key alone still pairs.
    console.warn(`[remote] the pairing code could not be drawn (${error?.name || 'error'})`);
    return null;
  }
}

/**
 * The state as it goes to the window, with the QR code's modules beside the
 * payload while a code is shown.
 * @template {{ code: { qr: string } | null }} T
 * @param {T} state
 * @returns {T}
 */
function withQrModules(state) {
  if (!state?.code) return state;
  const modules = qrModules(state.code.qr);
  return modules ? { ...state, code: { ...state.code, modules } } : state;
}

module.exports = { qrModules, withQrModules };
