// The remote channel's crypto under Electron, not just under Node (#1237).
//
// Electron ships BoringSSL instead of OpenSSL, and not every primitive Node
// offers survives the swap: `chacha20-poly1305` did not, so the app could
// neither seal nor open an envelope while every unit test, run under plain
// Node, stayed green. This runs the channel's vector test in the Electron the
// app ships with, so a primitive missing there fails the build instead of the
// first real phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('the channel seals and opens envelopes under the app\'s Electron', async () => {
  // Without NODE_TEST_CONTEXT, which this runner sets: the inner one would take itself for a subtest and run nothing.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const { code, output } = await new Promise((resolve) => {
    execFile(
      electronBinary,
      ['--test', 'test/remote-channel-protocol.test.js'],
      { cwd: APP_DIR, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, output: stdout + stderr }),
    );
  });
  assert.equal(code, 0, output);
  assert.match(output, /# fail 0|ℹ fail 0/, output);
});
