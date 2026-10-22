// TEMPORARY diagnostics for #1190 — not to be merged.
'use strict';

const t0 = Date.now();
const log = (line) => process.stderr.write(`[diag +${Date.now() - t0}ms] ${line}\n`);

globalThis.__diag = log;
const cp = require('child_process');
for (const name of ['spawn', 'execFile', 'exec']) {
  const original = cp[name];
  cp[name] = function wrapped(...args) {
    const started = Date.now();
    const what = `${name} ${String(args[0]).slice(0, 80)} ${Array.isArray(args[1]) ? JSON.stringify(args[1]).slice(0, 160) : ''}`;
    log(`start ${what}`);
    const child = original.apply(this, args);
    child.once('exit', (code) => log(`exit ${code} after ${Date.now() - started}ms: ${what}`));
    child.once('error', (e) => log(`error ${e.code} after ${Date.now() - started}ms: ${what}`));
    return child;
  };
}
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = cp[name];
  cp[name] = function wrapped(...args) {
    const started = Date.now();
    try { return original.apply(this, args); } finally {
      log(`${name} ${String(args[0]).slice(0, 80)} took ${Date.now() - started}ms`);
    }
  };
}

const { ipcMain } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const started = Date.now();
  log(`ipc> ${channel}`);
  try { return await listener(...args); } finally {
    log(`ipc< ${channel} ${Date.now() - started}ms`);
  }
});

const http = require('http');
const request = http.request;
http.request = function wrapped(...args) {
  const target = typeof args[0] === 'string' ? args[0] : `${args[0]?.host ?? args[0]?.hostname}:${args[0]?.port}${args[0]?.path ?? ''}`;
  log(`http.request ${target}`);
  return request.apply(this, args);
};
const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = async (input, init) => {
    const started = Date.now();
    const url = typeof input === 'string' ? input : input?.url;
    log(`fetch> ${url}`);
    try { return await originalFetch(input, init); } finally { log(`fetch< ${url} ${Date.now() - started}ms`); }
  };
}
