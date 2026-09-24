// Treiber fuer die echte Electron-App im Smoke-Test (Issue #78).
//
// Was hier steht, ist die Summe der Fallstricke aus frueheren Handlaeufen — sie
// kosten ohne diese Notizen jedes Mal dieselbe halbe Stunde:
//
//   * `--user-data-dir` isoliert die Einstellungen. Ohne das laeuft der Test
//     gegen die echte Installation des Nutzers.
//   * `ELECTRON_RUN_AS_NODE` muss aus dem Env raus, sonst startet Electron als
//     Node und es gibt nie ein Fenster.
//   * Playwrights eigenes Warten (`waitForSelector`, Locator-Assertions) haengt:
//     sein Polling haengt an Renderer-Timern, und die werden im Hintergrund
//     gedrosselt. Deshalb die Startflags gegen das Throttling **und** selbst
//     pollen (siehe `poll`).
//   * Die Preload-Bruecke heisst `window.electronAPI`, nicht `window.api`.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import electronBinary from 'electron';

const APP_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Pollt, bis `check` etwas Wahres liefert. Ersatz fuer waitForSelector, das in
 * dieser Umgebung in den Timeout laeuft, obwohl das Element laengst da ist.
 */
export async function poll(check, { timeoutMs = 15000, intervalMs = 150, what = 'Bedingung' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`Zeitlimit beim Warten auf: ${what} (zuletzt: ${JSON.stringify(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Legt ein frisches userData-Verzeichnis an: geoeffneter Ordner, ein Preset auf
 * den Fake-Modellserver, Standardeinstellungen. Damit startet die App fertig
 * eingerichtet — der native Ordnerdialog und der Einstellungsdialog muessen im
 * Test nicht bedient werden.
 */
export async function prepareUserData(userDataDir, { workspace, modelBaseUrl }) {
  await mkdir(userDataDir, { recursive: true });
  const write = (name, data) =>
    writeFile(path.join(userDataDir, name), JSON.stringify(data), 'utf8');

  const presetId = randomUUID();
  await write('last-folder.json', { path: workspace });
  await write('folder-history.json', { paths: [workspace] });
  await write('llm-config.json', {
    version: 3,
    activeProvider: 'mlx-lm',
    activePresetId: presetId,
    presets: [{ id: presetId, providerId: 'mlx-lm', model: 'fake-model', reasoningEffort: null, menuVisible: true }],
    providers: { 'mlx-lm': { baseUrl: modelBaseUrl, model: 'fake-model' } },
  });
  await write('ui-preferences.json', { appLocale: 'de' });
}

/** Startet die App und wartet, bis der Renderer steht. */
export async function launchApp({ userDataDir }) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath: electronBinary,
    args: [
      APP_DIR,
      `--user-data-dir=${userDataDir}`,
      // Ohne diese drei drosselt Chromium die Timer des Fensters, sobald es
      // nicht im Vordergrund ist — und dann steht der Renderer still.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // The Linux runner has no GPU and ends up compositing in software anyway,
      // but only after trying GL first — and until then the window draws no
      // frame, for seconds, sometimes for a whole run (#331). Streamed chat
      // text only reaches the DOM in a frame. Going to software from the start
      // skips the attempt. macOS and Windows keep their GPU path.
      ...(process.platform === 'linux' ? ['--disable-gpu'] : []),
    ],
    env,
  });

  const page = await app.firstWindow();
  await poll(() => page.evaluate(() => !!document.getElementById('tree-container')), {
    what: 'geladener Renderer',
  });

  return {
    app,
    page,
    /**
     * Ersetzt shell.openExternal im Main-Prozess: Ein Klick auf einen Link soll
     * im Test keinen echten Browser oeffnen. `app.evaluate` geht erst nach
     * firstWindow(), sonst laeuft firstWindow() selbst in den Timeout.
     */
    async captureExternalLinks() {
      await app.evaluate(({ shell }) => {
        globalThis.__openedLinks = [];
        shell.openExternal = async (url) => { globalThis.__openedLinks.push(url); };
      });
      return () => app.evaluate(() => globalThis.__openedLinks ?? []);
    },
    /**
     * Main's view of a chat abort, for #327: did `chat:abort` arrive, and did
     * the abort reach the provider's `fetch` — its signal, its response, its
     * body stream? Needs no hook in the app: a second `ipcMain` listener sits
     * next to the real one, and the global `fetch` is wrapped, which the
     * providers look up on every call. Only requests whose body contains
     * `marker` are traced; everything else passes through untouched.
     */
    async traceChatAbort(marker) {
      await app.evaluate(({ ipcMain }, marker) => {
        const trace = { ipc: [], fetches: [] };
        globalThis.__chatAbortTrace = trace;
        ipcMain.on('chat:abort', (_event, payload) => {
          trace.ipc.push({ at: Date.now(), chatId: payload?.chatId ?? null });
        });
        const original = globalThis.fetch;
        globalThis.fetch = async (input, init = {}) => {
          const body = typeof init?.body === 'string' ? init.body : '';
          if (!body.includes(marker)) return original(input, init);
          const entry = {
            startedAt: Date.now(),
            hasSignal: !!init.signal,
            signalAbortedAt: null,
            signalReason: null,
            respondedAt: null,
            fetchError: null,
            chunksRead: 0,
            streamErrorAt: null,
            streamError: null,
            streamDoneAt: null,
            readerCancelledAt: null,
            readerCancelSettledAt: null,
            readerCancelError: null,
          };
          trace.fetches.push(entry);
          init.signal?.addEventListener('abort', () => {
            entry.signalAbortedAt = Date.now();
            entry.signalReason = String(init.signal.reason?.message ?? init.signal.reason);
          }, { once: true });
          let res;
          try {
            res = await original(input, init);
          } catch (err) {
            entry.fetchError = `${err?.name}: ${err?.message}`;
            throw err;
          }
          entry.respondedAt = Date.now();
          // Observe the provider's own reader instead of tee'ing the body: a
          // tee only cancels its source once both branches cancel, so a second
          // reader would itself keep the socket open — the very thing traced.
          if (res.body) {
            const getReader = res.body.getReader.bind(res.body);
            res.body.getReader = (...args) => {
              const reader = getReader(...args);
              const read = reader.read.bind(reader);
              const cancel = reader.cancel.bind(reader);
              reader.read = async () => {
                try {
                  const result = await read();
                  if (result.done) entry.streamDoneAt ??= Date.now();
                  else entry.chunksRead += 1;
                  return result;
                } catch (err) {
                  entry.streamErrorAt ??= Date.now();
                  entry.streamError ??= `${err?.name}: ${err?.message}`;
                  throw err;
                }
              };
              reader.cancel = (reason) => {
                entry.readerCancelledAt ??= Date.now();
                return cancel(reason).then(
                  () => { entry.readerCancelSettledAt ??= Date.now(); },
                  (err) => { entry.readerCancelError ??= `${err?.name}: ${err?.message}`; throw err; },
                );
              };
              return reader;
            };
          }
          return res;
        };
      }, marker);
      return () => app.evaluate(() => globalThis.__chatAbortTrace ?? null);
    },
    async stop() {
      await app.close();
    },
  };
}
