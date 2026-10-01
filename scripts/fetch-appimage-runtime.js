#!/usr/bin/env node
'use strict';

/**
 * Puts the AppImage runtime where the AppImage maker expects it, checked
 * against a pinned SHA-256 (#573).
 *
 * The runtime is the small loader at the front of every AppImage — it runs
 * before anything of Snotra does. The maker used to download it by URL at
 * build time, without a checksum, so a replaced asset in the upstream release
 * would have ended up in every AppImage we ship. Now the maker gets a local
 * file (`config.forge` › AppImage maker › `runtime` in package.json), and this
 * script only writes that file once its hash matches.
 *
 * Moving to a newer runtime: change URL and SHA-256 together. GitHub lists the
 * digest next to each release asset (`gh api
 * repos/AppImage/type2-runtime/releases/tags/<tag>`).
 *
 * Runs as part of `npm run make:linux`. Usage: `node scripts/fetch-appimage-runtime.js`
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const RUNTIME = Object.freeze({
  url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  // Must match `runtime` of the AppImage maker in package.json.
  target: path.join('out', 'appimage-runtime', 'runtime-x86_64'),
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** True when `file` exists and hashes to the pinned value. */
function isVerified(file, expected = RUNTIME.sha256) {
  try {
    return sha256(fs.readFileSync(file)) === expected;
  } catch {
    return false;
  }
}

async function main() {
  const target = path.join(ROOT, RUNTIME.target);
  if (isVerified(target)) {
    console.log(`AppImage runtime already in place: ${RUNTIME.target}`);
    return;
  }
  const res = await fetch(RUNTIME.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`AppImage runtime: HTTP ${res.status} from ${RUNTIME.url}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = sha256(data);
  if (actual !== RUNTIME.sha256) {
    throw new Error(`AppImage runtime: SHA-256 ${actual} does not match the pinned ${RUNTIME.sha256}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { mode: 0o755 });
  console.log(`AppImage runtime verified and written to ${RUNTIME.target}`);
}

module.exports = { RUNTIME, isVerified, sha256 };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
