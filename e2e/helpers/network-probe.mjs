// What an e2e run needs to see every outbound request of the app (#988).
//
// Two sources, because the app has two network stacks:
//
//   * Chromium's net log (`--log-net-log`) holds every request of the browser
//     side — the renderer, `net.fetch`, the preview session, dictionary
//     downloads — from the first moment of the process. It is a file, finished
//     when the app quits cleanly.
//   * network-probe-preload.cjs, loaded into main, holds what Node's sockets
//     and `fetch` do, and the spell checker's dictionary events.
//
// Neither needs a hook in the product code.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './app.mjs';

const PRELOAD = fileURLToPath(new URL('./network-probe-preload.cjs', import.meta.url));

/** Schemes that never leave the machine. */
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'blob:', 'about:', 'chrome:', 'devtools:', 'chrome-extension:', 'chrome-untrusted:']);

export function isLoopback(host) {
  const bare = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1'
    || /^127\./.test(bare) || /^::ffff:127\./.test(bare);
}

/**
 * The `launchApp` options that switch the probe on: the net log goes to a file
 * of its own, the preload goes into main.
 */
export async function networkProbeLaunchOptions() {
  const netLogFile = path.join(await makeTempDir('snotra-netlog-'), 'net-log.json');
  return {
    netLogFile,
    options: {
      args: [`--log-net-log=${netLogFile}`, '--net-log-capture-mode=Default'],
      mainPreload: PRELOAD,
    },
  };
}

/** What main recorded itself, until now. */
export function mainRecords(snotra) {
  return snotra.app.evaluate(() => globalThis.__snotraNetProbe ?? null);
}

/**
 * Every request the net log holds, as `{ url }` for a request job and
 * `{ address }` for a TCP connection attempt. The log is only complete after a
 * clean quit; a file cut off by a crash is closed by hand rather than lost.
 */
export async function readNetLog(file) {
  const text = await readFile(file, 'utf8');
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    log = JSON.parse(`${text.trimEnd().replace(/,$/, '')}]}`);
  }
  const types = log.constants?.logEventTypes ?? {};
  const requestJob = types.URL_REQUEST_START_JOB;
  const tcpConnect = types.TCP_CONNECT_ATTEMPT;
  if (requestJob === undefined || tcpConnect === undefined) {
    throw new Error('The net log does not name URL_REQUEST_START_JOB and TCP_CONNECT_ATTEMPT — Chromium changed its log format.');
  }
  const found = [];
  for (const event of log.events ?? []) {
    if (event.type === requestJob && event.params?.url) found.push({ url: String(event.params.url) });
    else if (event.type === tcpConnect && event.params?.address) found.push({ address: String(event.params.address) });
  }
  return found;
}

/** The part of a net log entry or probe record that leaves the machine, as one readable line each. */
export function outbound(records) {
  const lines = [];
  for (const record of records) {
    if (record.url !== undefined) {
      let url;
      try {
        url = new URL(record.url);
      } catch {
        lines.push(`request ${record.url}`);
        continue;
      }
      if (LOCAL_SCHEMES.has(url.protocol) || isLoopback(url.hostname)) continue;
      lines.push(`${record.kind ?? 'request'} ${record.url}`);
    } else if (record.address !== undefined) {
      const host = record.address.replace(/:\d+$/, '');
      if (!isLoopback(host)) lines.push(`connect ${record.address}`);
    } else if (record.kind === 'socket') {
      if (record.path === undefined && !isLoopback(record.host)) lines.push(`socket ${record.host}:${record.port}`);
    } else if (record.kind === 'spellcheck') {
      // Every dictionary event on Windows and Linux means Chromium fetched, or
      // is about to fetch, a dictionary from the web.
      if (record.event !== 'initialized') lines.push(`spellcheck dictionary ${record.event} (${record.language})`);
    }
  }
  return lines;
}
