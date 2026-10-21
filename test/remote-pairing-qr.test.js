'use strict';

// The pairing code as a QR code (#1110): main draws it, and what it draws
// reads back as the payload — checked with a decoder of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const jsQR = require('jsqr');

const { qrModules, withQrModules } = require('../src/main/remote/pairing-qr');
const { normalizeRemotePairingState } = require('../src/shared/contracts/remote/pairing-state');

const PAYLOAD = 'snotra-pair:v1/relay.snotra-ai.dev/0111EP9DZH4QPYT4HWWF';

/** Paints the modules with a quiet zone and reads the image back. */
function decode(modules, scale = 4, quiet = 4) {
  const side = (modules.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) => [...row].forEach((bit, x) => {
    if (bit !== '1') return;
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const at = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
        pixels[at] = 0; pixels[at + 1] = 0; pixels[at + 2] = 0;
      }
    }
  }));
  return jsQR(pixels, side, side)?.data ?? null;
}

test('the payload is drawn as a QR code that reads back as itself', () => {
  const modules = qrModules(PAYLOAD);
  assert.ok(modules.length >= 21 && modules.length <= 41, `version 1 to 6, got ${modules.length} modules`);
  assert.ok(modules.every((row) => row.length === modules.length && /^[01]+$/.test(row)));
  assert.equal(decode(modules), PAYLOAD);
});

test('the modules go to the window with a code, and pass the state contract', () => {
  const state = withQrModules(normalizeRemotePairingState({
    state: 'code', code: { display: '0111-EP9D-ZH4Q-PYT4-HWWF', qr: PAYLOAD, expiresAt: 1_700_000_000_000 },
  }));
  assert.equal(decode(normalizeRemotePairingState(state).code.modules), PAYLOAD);
  const empty = normalizeRemotePairingState({ state: 'empty' });
  assert.equal(withQrModules(empty), empty, 'no code, nothing to draw');
  assert.equal(qrModules(''), null);
});
