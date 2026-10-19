#!/usr/bin/env node
/**
 * Holds a relay of the mobile remote to docs/remote-protocol.md part 1 (#1135):
 * the desktop through the bridge's own Firebase adapter
 * (src/main/remote/firebase-relay-adapter.js), the phone through the
 * reference phone (./reference-phone.js), both against the relay named in the
 * arguments or the environment — and nothing else. It knows no path of
 * snotra-promotion; that repository's CI runs it against the Firebase emulator
 * with its relay, at the commit it pins (snotra-promotion#165). Here it runs
 * against ./relay-stand-in.js in `npm test`.
 *
 * Usage, exit codes and the configuration: ./README.md.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createFirebaseRelayAdapter } = require('../../src/main/remote/firebase-relay-adapter.js');
const { RemoteRelayError } = require('../../src/main/remote/relay-error.js');
const protocol = require('../../src/main/remote/pairing-protocol.js');
const { createReferencePhone, createKeys, RelayAnswer } = require('./reference-phone.js');

/** How long the desktop's stream may take to show a change. */
const DEFAULT_WAIT_MS = 10_000;

export const EXIT = Object.freeze({ PASSED: 0, FAILED: 1, USAGE: 2 });

/** The configuration: argument, environment variable, whether it is required. */
export const SETTINGS = Object.freeze([
  { key: 'relayUrl', flag: '--relay-url', env: 'SNOTRA_RELAY_URL', required: true },
  { key: 'databaseUrl', flag: '--database-url', env: 'SNOTRA_RELAY_DATABASE_URL', required: true },
  { key: 'apiKey', flag: '--api-key', env: 'SNOTRA_RELAY_API_KEY', required: true },
  { key: 'appCheckToken', flag: '--app-check-token', env: 'SNOTRA_RELAY_APP_CHECK_TOKEN', required: true },
  { key: 'identityToolkitUrl', flag: '--identity-toolkit-url', env: 'SNOTRA_RELAY_IDENTITY_TOOLKIT_URL', required: false },
  { key: 'relayHost', flag: '--relay-host', env: 'SNOTRA_RELAY_HOST', required: false },
  { key: 'waitMs', flag: '--wait-ms', env: 'SNOTRA_RELAY_WAIT_MS', required: false },
]);

/** A step the relay did not pass; the message says what the spec wanted and what came. */
export class ConformanceError extends Error {
  /**
   * @param {string} step
   * @param {string} message
   */
  constructor(step, message) {
    super(`${step}: ${message}`);
    this.name = 'ConformanceError';
    this.step = step;
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ config?: Record<string, string>, missing: string[], unknown: string[] }}
 */
export function readConfig(argv, env) {
  /** @type {Record<string, string>} */
  const config = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const setting = SETTINGS.find((s) => s.flag === flag);
    if (!setting) {
      unknown.push(argv[i]);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value !== undefined) config[setting.key] = value;
  }
  for (const setting of SETTINGS) {
    if (config[setting.key] === undefined && env[setting.env]) config[setting.key] = /** @type {string} */ (env[setting.env]);
  }
  const missing = SETTINGS.filter((s) => s.required && !config[s.key]).map((s) => `${s.flag} / ${s.env}`);
  return { config, missing, unknown };
}

/** The desktop's keys and signer, as the bridge keeps them. */
function desktopIdentity() {
  const keys = createKeys();
  return { keys: keys.bundle, sign: keys.sign };
}

/**
 * The records the desktop's stream delivers, and a way to wait for one.
 *
 * @param {import('../../src/application/ports/remote-relay-port').RemoteRelayPort} adapter
 * @param {string} channelId
 * @param {number} waitMs
 */
function follow(adapter, channelId, waitMs) {
  /** @type {Array<object|null>} */
  const records = [];
  /** @type {Error|null} */
  let failure = null;
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const wake = () => { for (const waiter of waiters) waiter(); };
  const handle = adapter.watchChannel(channelId, {
    onRecord: (record) => { records.push(record); wake(); },
    onError: (error) => { failure = error; wake(); },
  });
  return {
    close: handle.close,
    /**
     * @param {(record: any) => boolean} predicate
     * @param {string} step
     * @param {string} what
     */
    until(predicate, step, what) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = records.find((record) => predicate(record));
          if (found !== undefined) {
            done();
            resolve(found);
          } else if (failure) {
            done();
            reject(new ConformanceError(step, `the desktop's stream of meta ended with ${failure.message} before it showed ${what}`));
          }
        };
        const timer = setTimeout(() => {
          done();
          const last = records.length ? JSON.stringify(records.at(-1)) : 'nothing';
          reject(new ConformanceError(step, `the desktop's stream of meta did not show ${what} within ${waitMs} ms; last record: ${last}`));
        }, waitMs);
        const done = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

/**
 * Runs every scenario against the relay; resolves with the steps passed, or
 * rejects with a ConformanceError for the first that failed.
 *
 * @param {Record<string, string>} config
 * @param {{ log?: (line: string) => void, fetchImpl?: typeof fetch }} [options]
 */
export async function runConformance(config, { log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const waitMs = Number(config.waitMs) > 0 ? Number(config.waitMs) : DEFAULT_WAIT_MS;
  const endpoint = {
    relayHost: config.relayHost || new URL(config.relayUrl).host,
    relayUrl: config.relayUrl.replace(/\/+$/, ''),
    databaseUrl: config.databaseUrl,
    apiKey: config.apiKey,
    ...(config.identityToolkitUrl ? { identityToolkitUrl: config.identityToolkitUrl.replace(/\/+$/, '') } : {}),
  };
  const phoneConfig = {
    relayUrl: endpoint.relayUrl,
    databaseUrl: endpoint.databaseUrl,
    apiKey: endpoint.apiKey,
    identityToolkitUrl: endpoint.identityToolkitUrl,
    appCheckToken: config.appCheckToken,
    fetchImpl,
  };
  /** @type {string[]} */
  const passed = [];
  /** @type {Array<() => void>} */
  const cleanup = [];

  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  async function step(name, body) {
    let result;
    try {
      result = await body();
    } catch (error) {
      if (error instanceof ConformanceError) throw error;
      if (error instanceof RelayAnswer || error instanceof RemoteRelayError) throw new ConformanceError(name, error.message);
      throw new ConformanceError(name, error instanceof Error ? error.message : String(error));
    }
    passed.push(name);
    log(`ok    ${name}`);
    return result;
  }

  /**
   * A call that the spec says the relay refuses with `status`.
   * @param {string} name
   * @param {number} status
   * @param {() => Promise<unknown>} call
   */
  async function refusal(name, status, call) {
    await step(name, async () => {
      try {
        await call();
      } catch (error) {
        const got = error instanceof RelayAnswer || error instanceof RemoteRelayError ? error.status : undefined;
        if (got === status) return;
        throw new ConformanceError(name, `expected HTTP ${status}, got ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new ConformanceError(name, `expected HTTP ${status}, the relay accepted it`);
    });
  }

  /**
   * A database read the rules must refuse.
   * @param {string} name
   * @param {() => Promise<{ status: number, value: unknown }>} read
   */
  async function denied(name, read) {
    await step(name, async () => {
      const { status } = await read();
      if (status !== 401 && status !== 403) throw new ConformanceError(name, `expected the database to refuse (HTTP 401 or 403), got HTTP ${status}`);
    });
  }

  /** @param {string} name @param {() => Promise<{ status: number, value: unknown }>} read */
  async function allowed(name, read) {
    return step(name, async () => {
      const { status, value } = await read();
      if (status !== 200) throw new ConformanceError(name, `expected the database to allow the read, got HTTP ${status}`);
      return value;
    });
  }

  /** @param {boolean} condition @param {string} message */
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  function newDesktop() {
    const adapter = createFirebaseRelayAdapter({ endpoint, fetchImpl });
    cleanup.push(() => adapter.close());
    return adapter;
  }

  /**
   * The desktop opens a pairing and follows it; answers what the phone types.
   * @param {string} scenario
   */
  async function open(scenario) {
    const desktop = newDesktop();
    const identity = desktopIdentity();
    const opened = await step(`${scenario}: the desktop opens a pairing (§5.2, §5.3)`, async () => {
      const result = await desktop.openPairing({ desktopKeys: identity.keys, sign: identity.sign });
      expect(result.expiresAt > Date.now(), `expiresAt ${result.expiresAt} is already past`);
      return result;
    });
    const stream = follow(desktop, opened.channelId, waitMs);
    cleanup.push(stream.close);
    await stream.until((r) => r?.status === 'open', `${scenario}: the desktop's stream shows the channel open (§5.10)`, 'status "open"');
    passed.push(`${scenario}: the desktop's stream shows the channel open (§5.10)`);
    const code = protocol.makeCode(opened.pairingId, protocol.drawSecret());
    return { desktop, identity, opened, stream, code, typedKey: protocol.displayCode(code) };
  }

  /**
   * The phone looks the pairing up and claims it; the desktop checks MAC_P.
   * @param {string} scenario
   * @param {Awaited<ReturnType<typeof open>>} pairing
   * @param {ReturnType<typeof createReferencePhone>} [phone]
   * @param {{ lookedUp?: boolean }} [options]  the phone has looked the pairing up already
   */
  async function claim(scenario, pairing, phone = createReferencePhone(phoneConfig), { lookedUp = false } = {}) {
    if (!lookedUp) await step(`${scenario}: the phone looks the pairing up (§5.4)`, async () => {
      const found = await phone.lookup(pairing.typedKey);
      expect(found.channelId === pairing.opened.channelId, 'the lookup names another channel');
      expect(found.desktopKeys.sign === pairing.identity.keys.sign && found.desktopKeys.agree === pairing.identity.keys.agree,
        'the lookup carries other keys than the desktop opened with');
    });
    await step(`${scenario}: the phone claims the pairing (§5.5)`, () => phone.claim());
    const record = await pairing.stream.until((r) => r?.status === 'pending',
      `${scenario}: the desktop's stream shows the claim (§5.10)`, 'status "pending"');
    await step(`${scenario}: the desktop's stream shows the claim (§5.10)`, async () => {
      expect(record.phoneKeys?.sign === phone.keys.sign && record.phoneKeys?.agree === phone.keys.agree,
        'phoneKeys in meta are not the keys the phone claimed with');
      expect(protocol.verifyPhoneMac({
        code: pairing.code, channelId: pairing.opened.channelId, desktopKeys: pairing.identity.keys, phoneKeys: record.phoneKeys, macP: record.macP,
      }), 'MAC_P in meta does not verify against the code (§6)');
    });
    return { phone, record };
  }

  /**
   * The desktop allows: MAC_D to the relay, `paired` in its stream.
   * @param {string} scenario
   * @param {Awaited<ReturnType<typeof open>>} pairing
   * @param {{ keys: { sign: string, agree: string } }} phone
   */
  async function confirm(scenario, pairing, phone) {
    const macD = protocol.toB64u(protocol.desktopMac({
      code: pairing.code, channelId: pairing.opened.channelId, desktopKeys: pairing.identity.keys, phoneKeys: phone.keys,
    }));
    await step(`${scenario}: the desktop confirms (§5.6)`, () => pairing.desktop.confirmPairing(pairing.opened.channelId, macD));
    await pairing.stream.until((r) => r?.status === 'paired', `${scenario}: the desktop's stream shows the channel paired`, 'status "paired"');
    passed.push(`${scenario}: the desktop's stream shows the channel paired`);
    return macD;
  }

  try {
    // ---------------------------------------------------------------- pair, confirm, remove
    {
      const s = 'pair';
      const pairing = await open(s);
      const phone = createReferencePhone(phoneConfig);
      const rival = createReferencePhone(phoneConfig);

      await refusal(`${s}: a look-up without App Check is refused (§5.1)`, 401, () => phone.lookup(pairing.typedKey, { appCheck: false }));
      await step(`${s}: a second phone looks the same pairing up first`, () => rival.lookup(pairing.typedKey));
      await step(`${s}: the phone looks the pairing up (§5.4)`, () => phone.lookup(pairing.typedKey));
      const stranger = createKeys();
      await refusal(`${s}: a claim whose proof does not verify is refused (§5.5)`, 403, () => phone.claim({ sign: stranger.sign }));
      const { record } = await claim(s, pairing, phone, { lookedUp: true });
      await refusal(`${s}: a second claim is refused (§5.5)`, 404, () => rival.claim({ expect: 200 }));
      await refusal(`${s}: a claimed pairing is no longer found (§5.4)`, 404, () => rival.lookup(pairing.typedKey));

      await step(`${s}: both sides show the same safety phrase (§7)`, async () => {
        const desktopWords = protocol.phrase(pairing.identity.keys, record.phoneKeys).join(' ');
        expect(desktopWords === phone.words().join(' '), `the desktop shows "${desktopWords}", the phone "${phone.words().join(' ')}"`);
      });
      await denied(`${s}: before paired the phone cannot read its inbox (§5.10)`, () => phone.read('to-phone'));
      await denied(`${s}: before paired the phone cannot read the desktop's handshake (§5.10)`, () => phone.read('handshake/desktop'));
      await denied(`${s}: the phone never reads the channel node (§5.10)`, () => phone.read());
      await allowed(`${s}: the phone reads meta while pending (§5.10)`, () => phone.read('meta'));
      await refusal(`${s}: the phone gets no token before paired (§5.9)`, 403, () => phone.refreshToken({ expect: 200 }));
      await refusal(`${s}: the phone may not confirm (§5.6)`, 403, () => phone.confirmAsPhone({ expect: 204 }));

      await confirm(s, pairing, phone);
      await refusal(`${s}: confirming twice is refused (§5.6)`, 409, () => pairing.desktop.confirmPairing(pairing.opened.channelId, protocol.toB64u(Buffer.alloc(32))));

      const meta = await allowed(`${s}: the phone reads meta once paired (§5.10)`, () => phone.read('meta'));
      await step(`${s}: MAC_D in meta verifies on the phone (§6)`, async () => {
        expect(phone.acceptsPairing(meta), `meta is ${JSON.stringify({ status: meta?.status, macD: meta?.macD ? 'present' : 'missing' })}, and MAC_D does not verify`);
      });
      await allowed(`${s}: once paired the phone reads its inbox (§5.10)`, () => phone.read('to-phone'));
      await denied(`${s}: the phone never reads the desktop's inbox (§5.10)`, () => phone.read('to-desktop'));
      await denied(`${s}: once paired the phone still cannot read the channel node (§5.10)`, () => phone.read());
      await step(`${s}: the phone gets a fresh token once paired (§5.9)`, () => phone.refreshToken());
      await allowed(`${s}: the fresh token reads meta (§5.10)`, () => phone.read('meta'));

      await step(`${s}: a restarted desktop removes the phone with a token of its own (§5.8, §5.9)`, async () => {
        await newDesktop().deleteChannel(pairing.opened.channelId, { sign: pairing.identity.sign });
      });
      await pairing.stream.until((r) => r === null, `${s}: the desktop's stream sees meta vanish (§5.8)`, 'meta gone');
      passed.push(`${s}: the desktop's stream sees meta vanish (§5.8)`);
      await refusal(`${s}: a deleted channel gives no token (§5.8)`, 404, () => phone.refreshToken());
    }

    // ---------------------------------------------------------------- cancel
    {
      const s = 'cancel';
      const pairing = await open(s);
      await step(`${s}: the desktop cancels (§5.7)`, () => pairing.desktop.cancelPairing(pairing.opened.channelId, pairing.opened.pairingId));
      const phone = createReferencePhone(phoneConfig);
      await refusal(`${s}: a cancelled pairing is not found (§5.4)`, 404, () => phone.lookup(pairing.typedKey));
    }

    // ---------------------------------------------------------------- the phone disconnects
    {
      const s = 'disconnect';
      const pairing = await open(s);
      const { phone } = await claim(s, pairing);
      await confirm(s, pairing, phone);
      await step(`${s}: the phone deletes the channel (§5.8)`, () => phone.disconnect());
      await pairing.stream.until((r) => r === null, `${s}: the desktop's stream sees meta vanish (§5.8)`, 'meta gone');
      passed.push(`${s}: the desktop's stream sees meta vanish (§5.8)`);
      await refusal(`${s}: deleting it again finds nothing (§5.8)`, 404, () => phone.disconnect({ expect: 204 }));
    }

    // ---------------------------------------------------------------- the common rules
    {
      const s = 'rules';
      const phone = createReferencePhone(phoneConfig);
      const identity = desktopIdentity();
      const opening = async (/** @type {string} */ challenge) => {
        const proof = identity.sign(protocol.openMessage(challenge, identity.keys));
        return phone.call('POST', '/pairings', { body: { challenge, desktopKeys: identity.keys, proof: protocol.toB64u(proof) }, expect: 201 });
      };
      const challenge = await step(`${s}: a challenge opens one pairing (§5.2)`, async () => {
        const text = await phone.challenge();
        await opening(text);
        return text;
      });
      await refusal(`${s}: the same challenge is refused the second time (§5.2)`, 403, () => opening(challenge));
      await refusal(`${s}: a body over 4 KiB is refused (§5.1)`, 413, () => phone.call('POST', '/pairings', {
        rawBody: JSON.stringify({ padding: 'x'.repeat(5000) }), expect: 201,
      }));
      await refusal(`${s}: an unknown pairing id is not found (§5.4)`, 404, () => phone.lookup(protocol.displayCode(protocol.makeCode('ZZZZ', protocol.drawSecret()))));
    }
  } finally {
    for (const close of cleanup.reverse()) close();
  }
  return passed;
}

function usage() {
  const lines = SETTINGS.map((s) => `  ${s.flag.padEnd(24)} ${s.env.padEnd(36)} ${s.required ? 'required' : 'optional'}`);
  return ['usage: node e2e/remote/relay-conformance.mjs [--flag value | --flag=value]…', '', ...lines].join('\n');
}

/**
 * The command line: the configuration in, one line per step out, the exit code at the end.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const { config, missing, unknown } = readConfig(argv, env);
  if (unknown.length || missing.length) {
    if (unknown.length) console.error(`unknown argument: ${unknown.join(' ')}`);
    if (missing.length) console.error(`missing: ${missing.join(', ')}`);
    console.error(usage());
    return EXIT.USAGE;
  }
  const started = Date.now();
  try {
    const passed = await runConformance(/** @type {Record<string, string>} */ (config), { log: (line) => console.log(line) });
    console.log(`\nThe relay conforms to docs/remote-protocol.md part 1: ${passed.length} steps in ${Date.now() - started} ms.`);
    return EXIT.PASSED;
  } catch (error) {
    console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.FAILED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
