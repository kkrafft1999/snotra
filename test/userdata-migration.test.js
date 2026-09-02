const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  createUserDataMigration,
  MIGRATION_MARKER_FILENAME,
  MIGRATED_FILENAMES,
} = require('../src/main/services/userdata-migration');

function makeLog() {
  const entries = [];
  return {
    entries,
    info: (m) => entries.push({ level: 'info', m }),
    warn: (m) => entries.push({ level: 'warn', m }),
  };
}

async function makeDirs(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-migration-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceDir = path.join(base, 'Weyouze Anything');
  const targetDir = path.join(base, 'Snotra AI');
  return { base, sourceDir, targetDir };
}

async function seedFullSource(sourceDir) {
  await fs.mkdir(path.join(sourceDir, 'Cache'), { recursive: true });
  for (const name of MIGRATED_FILENAMES) {
    await fs.writeFile(path.join(sourceDir, name), JSON.stringify({ file: name, payload: 'x'.repeat(64) }), 'utf8');
  }
  await fs.writeFile(path.join(sourceDir, 'llm-config.json.tmp-abc'), '{"tmp":true}', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'Preferences'), '{"chromium":true}', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'Cache', 'data_0'), 'cache', 'utf8');
}

async function listing(dir) {
  const names = await fs.readdir(dir);
  return names.sort();
}

test('first start copies the allowlisted files byte-identically and leaves the source untouched', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await seedFullSource(sourceDir);
  const before = await listing(sourceDir);
  const log = makeLog();

  const result = await createUserDataMigration({ fs, path, log }).migrateLegacyUserData({
    sourceDir,
    targetDir,
    meta: { appVersion: '1.1.0', platform: 'test' },
  });

  assert.equal(result.status, 'copied');
  assert.deepEqual([...result.copied].sort(), [...MIGRATED_FILENAMES].sort());
  assert.deepEqual(result.errors, []);
  for (const name of MIGRATED_FILENAMES) {
    const a = await fs.readFile(path.join(sourceDir, name));
    const b = await fs.readFile(path.join(targetDir, name));
    assert.ok(a.equals(b), `${name} byte-identisch`);
  }
  const targetNames = await listing(targetDir);
  assert.ok(!targetNames.includes('llm-config.json.tmp-abc'), 'tmp-Datei nicht kopiert');
  assert.ok(!targetNames.includes('Preferences'), 'Chromium-Preferences nicht kopiert');
  assert.ok(!targetNames.includes('Cache'), 'Cache nicht kopiert');
  assert.ok(targetNames.includes(MIGRATION_MARKER_FILENAME), 'Marker geschrieben');
  assert.deepEqual(await listing(sourceDir), before, 'Quelle unveraendert');

  const marker = JSON.parse(await fs.readFile(path.join(targetDir, MIGRATION_MARKER_FILENAME), 'utf8'));
  assert.equal(marker.version, 1);
  assert.equal(marker.status, 'copied');
  assert.equal(marker.sourceDir, sourceDir);
  assert.equal(marker.targetDir, targetDir);
  assert.deepEqual([...marker.copied].sort(), [...MIGRATED_FILENAMES].sort());
  assert.equal(marker.meta.appVersion, '1.1.0');
  assert.equal(log.entries.filter((e) => e.level === 'info').length, 1);
});

test('second start is a no-op because of the marker', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await seedFullSource(sourceDir);
  const migration = createUserDataMigration({ fs, path, log: makeLog() });
  await migration.migrateLegacyUserData({ sourceDir, targetDir });

  let copyCalls = 0;
  const spyFs = { ...fs, copyFile: async (...args) => { copyCalls += 1; return fs.copyFile(...args); } };
  const result = await createUserDataMigration({ fs: spyFs, path, log: makeLog() })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'skipped-marker');
  assert.equal(copyCalls, 0);
});

test('a populated target is never touched, but gets a marker', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await seedFullSource(sourceDir);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, 'llm-config.json'), '{"version":3,"mine":true}', 'utf8');

  const result = await createUserDataMigration({ fs, path, log: makeLog() })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'skipped-target-populated');
  assert.deepEqual(result.copied, []);
  assert.equal(await fs.readFile(path.join(targetDir, 'llm-config.json'), 'utf8'), '{"version":3,"mine":true}');
  assert.deepEqual(await listing(targetDir), ['llm-config.json', MIGRATION_MARKER_FILENAME]);
});

test('missing source is a silent no-op without marker', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  const log = makeLog();

  const result = await createUserDataMigration({ fs, path, log })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'skipped-no-source');
  assert.equal(await fs.stat(targetDir).catch(() => null), null, 'Ziel wird nicht angelegt');
  assert.deepEqual(log.entries, []);
});

test('identical source and target directories are skipped', async (t) => {
  const { sourceDir } = await makeDirs(t);
  await seedFullSource(sourceDir);

  const result = await createUserDataMigration({ fs, path, log: makeLog() })
    .migrateLegacyUserData({ sourceDir, targetDir: path.join(sourceDir, '.', '') });

  assert.equal(result.status, 'skipped-same-dir');
  assert.ok(!(await listing(sourceDir)).includes(MIGRATION_MARKER_FILENAME));
});

test('a partial source copies exactly the files that exist', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'ui-preferences.json'), '{"theme":"dark"}', 'utf8');
  await fs.writeFile(path.join(sourceDir, 'folder-history.json'), '[]', 'utf8');

  const result = await createUserDataMigration({ fs, path, log: makeLog() })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'copied');
  assert.deepEqual([...result.copied].sort(), ['folder-history.json', 'ui-preferences.json']);
  assert.deepEqual(await listing(targetDir), ['folder-history.json', MIGRATION_MARKER_FILENAME, 'ui-preferences.json']);
});

test('a failing copy of one file is recorded and does not stop the others', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await seedFullSource(sourceDir);
  const log = makeLog();
  const failingFs = {
    ...fs,
    copyFile: async (src, dst, flags) => {
      if (src.endsWith('folder-history.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.copyFile(src, dst, flags);
    },
  };

  const result = await createUserDataMigration({ fs: failingFs, path, log })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'copied');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'folder-history.json');
  assert.equal(result.copied.length, MIGRATED_FILENAMES.length - 1);
  assert.ok(log.entries.some((e) => e.level === 'warn' && /folder-history\.json/.test(e.m)));
  const marker = JSON.parse(await fs.readFile(path.join(targetDir, MIGRATION_MARKER_FILENAME), 'utf8'));
  assert.equal(marker.errors.length, 1);
});

test('an unexpected error resolves with status failed and never rejects', async (t) => {
  const { sourceDir, targetDir } = await makeDirs(t);
  await seedFullSource(sourceDir);
  const log = makeLog();
  const brokenFs = {
    ...fs,
    mkdir: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
  };

  const result = await createUserDataMigration({ fs: brokenFs, path, log })
    .migrateLegacyUserData({ sourceDir, targetDir });

  assert.equal(result.status, 'failed');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /permission denied/);
  assert.ok(log.entries.some((e) => e.level === 'warn'));
});
