'use strict';

// The release list of the remote front ends (#1194): a workspace opens to the
// phone only with a receipt of the user-confirmation port, keeps its id, and
// nothing of it is readable on disk without the key behind safeStorage.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createRemoteReleaseStore, FILE_NAME } = require('../src/main/remote/release-store-adapter');
const { CONFIRMATION_ACTIONS, createConfirmationReceipts } = require('../src/application/permissions/user-confirmation');
const { writeFileAtomic } = require('../src/main/services/atomic-write');
const { removeTempDir } = require('./helpers/temp-dir');

const ROOT = path.resolve('/projects/alpha');
const OTHER = path.resolve('/projects/beta');

/** Reversible, and not readable as the plain text: enough to see that only ciphertext reaches the disk. */
function fakeSafeStorage({ available = true } = {}) {
  return {
    available,
    isEncryptionAvailable() { return this.available; },
    encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join(''), 'utf8'),
    decryptString: (data) => Buffer.from(data.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8'),
  };
}

/** Receipts the test hands out, each redeemable once for its action and subject. */
function fakeReceipts() {
  const open = new Map();
  const redeemed = [];
  return {
    issue(action, subject) {
      const receipt = { action, subject };
      open.set(receipt, { action, subject });
      return receipt;
    },
    redeem(receipt, action, subject) {
      redeemed.push({ action, subject });
      const held = open.get(receipt);
      if (!held || held.action !== action || held.subject !== subject) return false;
      open.delete(receipt);
      return true;
    },
    redeemed,
  };
}

async function setup(t, { safeStorage = fakeSafeStorage(), receipts = fakeReceipts() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-release-'));
  t.after(() => removeTempDir(dir));
  const warnings = [];
  const make = () => createRemoteReleaseStore({
    safeStorage,
    receipts,
    normalizeRoot: (root) => (typeof root === 'string' && root.trim() ? path.resolve(root) : null),
    fs,
    path,
    dir,
    writeFileAtomic,
    log: { warn: (line) => warnings.push(String(line)) },
  });
  return { dir, store: make(), make, receipts, safeStorage, warnings };
}

const confirmed = (receipts, root) => receipts.issue(CONFIRMATION_ACTIONS.REMOTE_WORKSPACE, root);

test('a workspace opens only with a receipt for that action and that root', async (t) => {
  const { store, receipts } = await setup(t);
  assert.deepEqual(await store.release(ROOT, null), { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(await store.release(ROOT, receipts.issue(CONFIRMATION_ACTIONS.REMOTE_PAIRING, ROOT)), { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(await store.release(ROOT, confirmed(receipts, OTHER)), { ok: false, reason: 'unconfirmed' });
  assert.deepEqual(await store.list(), []);

  const opened = await store.release(ROOT, confirmed(receipts, ROOT));
  assert.equal(opened.ok, true);
  assert.equal(opened.release.root, ROOT);
  assert.match(opened.release.workspaceId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(await store.list(), [opened.release]);

  const receipt = confirmed(receipts, OTHER);
  await store.release(OTHER, receipt);
  assert.deepEqual(await store.release(OTHER, receipt), { ok: false, reason: 'unconfirmed' }, 'a receipt is spent once');
});

test('a folder keeps its id when it is closed and opened again, and across a restart', async (t) => {
  const { store, make, receipts } = await setup(t);
  const first = await store.release(ROOT, confirmed(receipts, ROOT));
  await store.release(OTHER, confirmed(receipts, OTHER));
  await store.withdraw(ROOT);
  assert.deepEqual((await store.list()).map((r) => r.root), [OTHER]);
  const again = await store.release(ROOT, confirmed(receipts, ROOT));
  assert.equal(again.release.workspaceId, first.release.workspaceId);

  const restarted = make();
  assert.deepEqual(await restarted.list(), await store.list());
});

test('withdrawing needs no receipt, and listeners hear of every change', async (t) => {
  const { store, receipts } = await setup(t);
  let told = 0;
  store.subscribe(() => { told += 1; });
  await store.release(ROOT, confirmed(receipts, ROOT));
  await store.withdraw(ROOT);
  await store.withdraw(ROOT);
  assert.equal(told, 2, 'a withdraw that changes nothing writes nothing');
  assert.deepEqual(await store.list(), []);
});

test('on disk is only ciphertext: neither a root nor an id is readable', async (t) => {
  const { store, dir, receipts } = await setup(t);
  const { release } = await store.release(ROOT, confirmed(receipts, ROOT));
  const text = await fs.readFile(path.join(dir, FILE_NAME), 'utf8');
  assert.ok(!text.includes('alpha'));
  assert.ok(!text.includes(release.workspaceId));
  assert.equal(JSON.parse(text).version, 1);
});

test('without real encryption nothing is kept and nothing is open', async (t) => {
  const safeStorage = fakeSafeStorage({ available: false });
  const { store, receipts, dir } = await setup(t, { safeStorage });
  assert.equal(store.isAvailable(), false);
  assert.deepEqual(await store.release(ROOT, confirmed(receipts, ROOT)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(receipts.redeemed, [], 'the receipt is not spent on a store that cannot keep it');
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(path.join(dir, FILE_NAME)), { code: 'ENOENT' });
});

test('a file that cannot be opened counts as nothing released', async (t) => {
  const { make, dir, warnings } = await setup(t);
  await fs.writeFile(path.join(dir, FILE_NAME), JSON.stringify({ version: 1, data: 'not ciphertext' }));
  assert.deepEqual(await make().list(), []);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(dir));
});

test('a root that is no folder name is refused before a receipt is spent', async (t) => {
  const { store, receipts } = await setup(t);
  assert.deepEqual(await store.release('   ', confirmed(receipts, '   ')), { ok: false, reason: 'invalid' });
  assert.deepEqual(receipts.redeemed, []);
});

test('with the app\'s own registry: only a receipt it issued for that root opens the workspace', async (t) => {
  const registry = createConfirmationReceipts();
  const { store } = await setup(t, { receipts: { redeem: registry.redeem } });
  const forged = { action: CONFIRMATION_ACTIONS.REMOTE_WORKSPACE, subject: ROOT };
  assert.deepEqual(await store.release(ROOT, forged), { ok: false, reason: 'unconfirmed' }, 'a copy of a receipt redeems nothing');
  const issued = registry.issue({ action: CONFIRMATION_ACTIONS.REMOTE_WORKSPACE, subject: ROOT });
  assert.equal((await store.release(ROOT, issued)).ok, true);
});
