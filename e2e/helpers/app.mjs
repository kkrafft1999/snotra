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
     * Where the time goes when the renderer stops drawing (#331). Four clocks
     * tick side by side: animation frames and a timer in the renderer, a timer
     * in main, and one here in the test process. Frames missing while the
     * renderer's timer ticks point at the compositor; all clocks stalling
     * together point at the machine. Also records changes of visibility and
     * focus. The returned function stops the clocks and summarises their gaps.
     */
    async probeFrames({ gapMs = 300 } = {}) {
      const probeScript = (gapMs) => {
        const probe = { gapMs, frames: [], timer: [], states: [] };
        globalThis.__frameProbe = probe;
        let last = { frames: Date.now(), timer: Date.now() };
        const tick = (series) => {
          const now = Date.now();
          if (now - last[series] >= probe.gapMs) probe[series].push([last[series], now - last[series]]);
          last[series] = now;
        };
        probe.stop = () => { probe.stopped = true; };
        const frame = () => { if (probe.stopped) return; tick('frames'); requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        const timer = setInterval(() => { if (probe.stopped) clearInterval(timer); else tick('timer'); }, 50);
        let state = '';
        const sampleState = () => {
          const next = `${document.visibilityState}${document.hasFocus() ? '+focus' : ''}`;
          if (next !== state) { probe.states.push([Date.now(), next]); state = next; }
        };
        sampleState();
        setInterval(sampleState, 250);
        return true;
      };
      await page.evaluate(probeScript, gapMs);

      await app.evaluate((_electron, gapMs) => {
        const probe = { gapMs, timer: [] };
        globalThis.__frameProbe = probe;
        let last = Date.now();
        probe.handle = setInterval(() => {
          const now = Date.now();
          if (now - last >= probe.gapMs) probe.timer.push([last, now - last]);
          last = now;
        }, 50);
        return true;
      }, gapMs);

      const testGaps = [];
      let testLast = Date.now();
      const testTimer = setInterval(() => {
        const now = Date.now();
        if (now - testLast >= gapMs) testGaps.push([testLast, now - testLast]);
        testLast = now;
      }, 50);

      return async (since) => {
        clearInterval(testTimer);
        const renderer = await page.evaluate(() => {
          const probe = globalThis.__frameProbe;
          probe?.stop();
          return probe ? { frames: probe.frames, timer: probe.timer, states: probe.states } : null;
        }).catch((err) => ({ unreadable: String(err) }));
        const main = await app.evaluate(() => {
          const probe = globalThis.__frameProbe;
          if (probe) clearInterval(probe.handle);
          return probe ? { timer: probe.timer } : null;
        }).catch((err) => ({ unreadable: String(err) }));
        // Gaps as [start, duration] with the start relative to `since`, so
        // they line up with the test's step log.
        const rel = (gaps) => (Array.isArray(gaps) ? gaps.map(([at, ms]) => [at - since, ms]) : gaps);
        const worst = (gaps) => (Array.isArray(gaps) && gaps.length ? Math.max(...gaps.map(([, ms]) => ms)) : 0);
        return {
          note: `gaps of ${gapMs} ms or more, as [start ms since app start, duration ms]`,
          worst: {
            rendererFrames: worst(renderer?.frames),
            rendererTimer: worst(renderer?.timer),
            mainTimer: worst(main?.timer),
            testTimer: worst(testGaps),
          },
          rendererFrames: rel(renderer?.frames),
          rendererTimer: rel(renderer?.timer),
          mainTimer: rel(main?.timer),
          testTimer: rel(testGaps),
          rendererStates: Array.isArray(renderer?.states)
            ? renderer.states.map(([at, state]) => [at - since, state])
            : renderer?.unreadable ?? null,
        };
      };
    },
    /**
     * The way of a chat event from main into the bubble (#331). Main records
     * every chat event it sends to the window — channel, chat, run, text size
     * or phase — and the renderer records what the last assistant bubble shows
     * and which chat is on screen, whenever either changes. Between the two it
     * shows whether streamed text is late leaving main or late being drawn.
     */
    async traceChatStream() {
      await app.evaluate(({ BrowserWindow }) => {
        const trace = { sent: [], counts: {} };
        globalThis.__chatStreamTrace = trace;
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send.bind(contents);
        contents.send = (channel, payload, ...rest) => {
          if (typeof channel === 'string' && channel.startsWith('chat:')) {
            const key = `${channel} ${payload?.runId ?? '-'}`;
            trace.counts[key] = (trace.counts[key] ?? 0) + 1;
            // The first few of each kind per run tell when it started; the
            // counts tell how much followed.
            if (trace.counts[key] <= 3) {
              trace.sent.push({
                at: Date.now(),
                channel,
                chatId: payload?.chatId ?? null,
                runId: payload?.runId ?? null,
                text: typeof payload?.text === 'string' ? payload.text.length : undefined,
                type: payload?.type ?? payload?.phase ?? undefined,
              });
            }
          }
          return send(channel, payload, ...rest);
        };
        return true;
      });
      await page.evaluate(() => {
        const trace = { shown: [] };
        globalThis.__chatStreamTrace = trace;
        let previous = '';
        setInterval(() => {
          const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
          const last = bubbles[bubbles.length - 1];
          const state = {
            bubbles: bubbles.length,
            text: (last?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
            streaming: !!last?.querySelector('.chat-md-streaming'),
            chatId: document.querySelector('.chat-history-row--current[data-chat-id]')?.dataset.chatId ?? null,
            stop: document.getElementById('btn-chat-send')?.classList.contains('chat-send--stop') ?? null,
          };
          const key = JSON.stringify(state);
          if (key !== previous && trace.shown.length < 300) {
            trace.shown.push({ at: Date.now(), ...state });
            previous = key;
          }
        }, 50);
        return true;
      });
      return async (since) => {
        const rel = (entries) => (Array.isArray(entries)
          ? entries.map(({ at, ...rest }) => ({ at: at - since, ...rest }))
          : entries);
        const main = await app.evaluate(() => globalThis.__chatStreamTrace ?? null)
          .catch((err) => ({ unreadable: String(err) }));
        const renderer = await page.evaluate(() => globalThis.__chatStreamTrace ?? null)
          .catch((err) => ({ unreadable: String(err) }));
        return {
          note: 'ms since app start',
          sent: rel(main?.sent) ?? main,
          counts: main?.counts ?? null,
          shown: rel(renderer?.shown) ?? renderer,
        };
      };
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
