// A profile given with --user-data-dir stays as it was handed over (#688).
//
// The one-time migration copies the folder of the old app name, below the real
// `appData`, into userData. Every test run isolates the app with
// --user-data-dir, but `appData` stays the real one — so on a machine that
// still has the old folder, an empty test profile used to receive that
// machine's chat history and keys.
//
// To check that for real the old folder has to exist. Only Linux lets the test
// move `appData` (via XDG_CONFIG_HOME), so there it plants a fake one with a
// sentinel. macOS and Windows offer no such switch; on a developer machine that
// still has the real old folder, that folder is the fixture — only ever looked
// at, never written to, and its content is never printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LEGACY_APP_NAME } from '../src/main/app-identity.js';
import {
  MIGRATION_MARKER_FILENAME,
  MIGRATED_FILENAMES,
} from '../src/main/services/userdata-migration.js';
import { launchApp, makeTempDir } from './helpers/app.mjs';

const SENTINEL = 'legacy-data-that-must-stay-put-688';

const exists = (p) => stat(p).then(() => true, () => false);

test('an explicit --user-data-dir is not filled from the legacy folder', { timeout: 120000 }, async (t) => {
  const userDataDir = await makeTempDir('snotra-legacy-userdata-');
  const env = {};
  let fakeAppData = null;
  if (process.platform === 'linux') {
    fakeAppData = await makeTempDir('snotra-legacy-appdata-');
    const legacyDir = path.join(fakeAppData, LEGACY_APP_NAME);
    await mkdir(legacyDir);
    for (const name of MIGRATED_FILENAMES) {
      await writeFile(path.join(legacyDir, name), JSON.stringify({ sentinel: SENTINEL }), 'utf8');
    }
    env.XDG_CONFIG_HOME = fakeAppData;
  }

  const snotra = await launchApp({ userDataDir, env });
  t.after(() => snotra.stop().catch(() => {}));

  // The migration runs before the window is created, so once the renderer
  // stands, it has decided.
  const appData = await snotra.app.evaluate(({ app }) => app.getPath('appData'));
  if (fakeAppData) {
    assert.equal(appData, fakeAppData, 'XDG_CONFIG_HOME did not move appData — the check below would prove nothing');
  } else {
    const legacyPresent = await exists(path.join(appData, LEGACY_APP_NAME));
    t.diagnostic(legacyPresent
      ? 'the real legacy folder on this machine is the fixture'
      : 'no legacy folder on this machine — only the marker is checked');
  }

  assert.equal(await exists(path.join(userDataDir, MIGRATION_MARKER_FILENAME)), false,
    'the legacy migration ran against a profile given with --user-data-dir');

  // Names only: on a developer machine a leak would be private data.
  const leaked = [];
  for (const name of MIGRATED_FILENAMES) {
    const content = await readFile(path.join(userDataDir, name), 'utf8').catch(() => '');
    if (content.includes(SENTINEL)) leaked.push(name);
  }
  assert.deepEqual(leaked, [], 'files of the legacy folder ended up in the test profile');
});
