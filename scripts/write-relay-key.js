#!/usr/bin/env node
'use strict';

/**
 * Writes the relay's web API key into the build (#1193): from the
 * environment variable `SNOTRA_RELAY_API_KEY` — in the release pipeline the
 * GitHub secret of that name, locally a line in `.env` — into
 * `src/main/remote/relay-key.generated.json`, which git ignores and the
 * package takes along. `src/main/remote/relay-endpoint.js` reads it.
 *
 *   node scripts/write-relay-key.js            writes the key if there is one
 *   node scripts/write-relay-key.js --require  fails without one (release builds)
 *
 * The key is not secret — every shipped app carries it — it is only kept out
 * of the repository. Never printed: the log says whether there was one.
 */

const fs = require('node:fs');
const path = require('node:path');

const { API_KEY } = require('../src/main/remote/relay-endpoint');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'main', 'remote', 'relay-key.generated.json');
const VARIABLE = 'SNOTRA_RELAY_API_KEY';

/**
 * The key from the environment, or from a `KEY=value` line in `.env`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 */
function findKey(env = process.env, root = ROOT) {
  const fromEnv = typeof env[VARIABLE] === 'string' ? env[VARIABLE].trim() : '';
  if (fromEnv) return fromEnv;
  let dotenv = '';
  try {
    dotenv = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    // No .env: a local build without the relay.
    return '';
  }
  const line = dotenv.split(/\r?\n/).find((l) => l.trim().startsWith(`${VARIABLE}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * @param {{ require?: boolean, env?: NodeJS.ProcessEnv, root?: string, target?: string, log?: (line: string) => void }} [options]
 * @returns {boolean} whether a key was written
 */
function writeRelayKey({ require: required = false, env = process.env, root = ROOT, target = TARGET, log = console.log } = {}) {
  const key = findKey(env, root);
  if (!key) {
    if (required) throw new Error(`${VARIABLE} is not set: a release build without it could not pair a phone.`);
    log(`[relay-key] no ${VARIABLE}: this build has no relay`);
    return false;
  }
  if (!API_KEY.test(key)) throw new Error(`${VARIABLE} does not look like a Google API key.`);
  fs.writeFileSync(target, `${JSON.stringify({ apiKey: key })}\n`, 'utf8');
  log('[relay-key] written');
  return true;
}

if (require.main === module) {
  try {
    writeRelayKey({ require: process.argv.includes('--require') });
  } catch (error) {
    console.error(`[relay-key] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { writeRelayKey, findKey, VARIABLE };
