// Records what main reaches out to, from the first line of main on (#988).
//
// Loaded into the Electron main process with `electron -r <this>` (`launchApp`'s `mainPreload`)
// (see network-probe.mjs), so it runs before the app's own code and needs no
// hook in the product. It watches the two ways main can talk to the network
// that Chromium's net log does not see:
//
//   * Node's own sockets — `fetch` from undici, `http`, `https`, every library
//     built on `net`. One patch on `net.Socket.prototype.connect` catches all
//     of them, and `fetch` is wrapped on top for the URL.
//   * The spell checker. Its dictionary download is made by the browser
//     process, and it does not pass `webRequest`; the only trace it leaves is
//     the session's `spellcheck-dictionary-*` events.
//
// Chromium's own requests — the renderer, `net.fetch`, `session.fetch`, the
// preview session — are read from the net log, not here.
//
// The records live in `globalThis.__snotraNetProbe`; the test reads them
// through `app.evaluate`.

'use strict';

const net = require('node:net');

const records = [];
globalThis.__snotraNetProbe = records;

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function probedConnect(...args) {
  // `net.connect` hands over its already normalized arguments, `[options, callback]`.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    records.push(first.path
      ? { kind: 'socket', path: String(first.path) }
      : { kind: 'socket', host: String(first.host ?? 'localhost'), port: Number(first.port) });
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    records.push({ kind: 'socket', host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) });
  } else if (typeof first === 'string') {
    records.push({ kind: 'socket', path: first });
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function probedFetch(input, init) {
  records.push({ kind: 'fetch', url: String(input?.url ?? input) });
  return originalFetch.call(this, input, init);
};

try {
  const { app } = require('electron');
  const watch = (session) => {
    for (const name of ['download-begin', 'download-success', 'download-failure', 'initialized']) {
      session.on(`spellcheck-dictionary-${name}`, (_event, languageCode) => {
        records.push({ kind: 'spellcheck', event: name, language: String(languageCode) });
      });
    }
  };
  // Every session, the preview's included, and the default one before it exists.
  app.on('session-created', watch);
} catch {
  // Not in the main process of Electron: the socket and fetch hooks above are
  // all there is to do.
}
