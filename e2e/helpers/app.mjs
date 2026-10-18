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
//   * Temp folders come from `makeTempDir`, which removes them when the process
//     ends — also when a launch fails or the script dies halfway (#688).

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import electronBinary from 'electron';
import generatedFreshness from '../../scripts/generated-freshness.js';

const APP_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const tempDirs = new Set();

// How long a start may take before it counts as stalled (#707). Generous: a
// cold start on a CI runner takes a few seconds, never a minute.
const STARTUP_DEADLINE_MS = 90_000;

function withDeadline(promise, what, ms = STARTUP_DEADLINE_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * What a stalled start leaves to go on: main's output, the windows it has, and
 * Node's diagnostic report of the main process — its handles show what the
 * event loop is waiting on. If main does not even answer, that is the finding.
 */
async function describeStalledStart(app, mainOutput) {
  const lines = [`main output:\n${mainOutput.join('') || '(none)'}`];
  const state = await withDeadline(app.evaluate(({ BrowserWindow }) => {
    const report = process.report.getReport();
    return {
      windows: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
      homedir: process.env.SNOTRA_HOME_DIR || process.getBuiltinModule('node:os').homedir(),
      handles: report.libuv.filter((h) => h.is_active).map((h) => `${h.type}${h.filename ? ` ${h.filename}` : ''}${h.pid ? ` pid ${h.pid}` : ''}`),
      javascriptStack: report.javascriptStack?.message,
    };
  }), 'main process state', 10_000).catch((error) => `main did not answer: ${error.message}`);
  lines.push(`main state: ${typeof state === 'string' ? state : JSON.stringify(state, null, 1)}`);
  return lines.join('\n');
}

/** One home per profile, so that a restart with the same profile finds the same one. */
const testHomes = new Map();

async function testHomeFor(userDataDir) {
  const key = path.resolve(userDataDir);
  if (!testHomes.has(key)) testHomes.set(key, await makeTempDir('snotra-home-'));
  return testHomes.get(key);
}

/**
 * How long a quit may take before the helper reports it. The app holds a quit
 * for at most 5 s of pending writes (#681), so 20 s is far beyond any regular
 * end.
 */
const STALLED_QUIT_MS = 20000;

// `exit` also fires after an uncaught error, and node --test runs every file in
// a process of its own, so this is the end of one test file or one script.
// Only synchronous work is possible here. A folder an app that is still running
// keeps busy (Windows) is left behind rather than failing the run.
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort
    }
  }
});

/**
 * Creates a folder below the system temp folder and removes it when the
 * process ends. Profiles carry chat history and keys, workspaces whatever the
 * test wrote — neither should outlive the run, whether it passed or not.
 */
export async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * Pollt, bis `check` etwas Wahres liefert. Ersatz fuer waitForSelector, das in
 * dieser Umgebung in den Timeout laeuft, obwohl das Element laengst da ist.
 *
 * `explain` is asked once the time is up, and what it returns goes into the
 * error. A check that only answers `false` or `null` cannot say which part of
 * its condition was missing — and a flake seen once in sixty CI runs leaves
 * nothing else to go on (#689, #703).
 *
 * The pause between looks grows: 20 ms, doubled up to 150 ms (#909). A
 * condition that holds almost at once is seen almost at once, and a long wait
 * costs no more looks than before. A check that acts — clicks, presses a key —
 * must be safe to repeat quickly; one that is not passes a fixed `intervalMs`.
 */
export async function poll(check, { timeoutMs = 15000, intervalMs = null, what = 'Bedingung', explain = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let pause = intervalMs ?? 20;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) {
      let message = `Zeitlimit beim Warten auf: ${what} (zuletzt: ${JSON.stringify(last)})`;
      if (explain) {
        const found = await Promise.resolve().then(explain)
          .catch((error) => `explain failed: ${error?.message ?? error}`);
        message += `\n${typeof found === 'string' ? found : JSON.stringify(found, null, 1)}`;
      }
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
    if (intervalMs == null) pause = Math.min(pause * 2, 150);
  }
}

/**
 * Every chat event the renderer received, one line each, and how many errors
 * its guarded handlers swallowed (src/renderer/utils/tool-log-debug.js). For a
 * tool log that stopped being drawn mid-run (#721): it tells an event that
 * never came from one that came and was turned away, with the reason why.
 */
export async function rendererToolEvents(page) {
  return page.evaluate(() => {
    const debug = window.__snotraToolLogDebug;
    if (!debug) return 'no debug buffer';
    const { errorCount, entries } = JSON.parse(debug.serialize());
    const t0 = entries[0]?.t ?? 0;
    const lines = entries.filter((e) => e.kind !== 'summary')
      .map((e) => `${e.seq} +${e.t - t0}ms ${e.kind} ${JSON.stringify(e.data)}`);
    return `${errorCount} handler errors\n${lines.join('\n')}`;
  }).catch((e) => String(e));
}

/**
 * The saved chats of the open folder, each with its messages, as main hands
 * them out — the saved state, not the one on screen. Since #985 the history
 * list carries no messages, so every chat is opened on its own.
 */
export function storedChats(page) {
  return page.evaluate(async () => {
    const api = window.electronAPI;
    const history = await api.getChatHistory();
    const chats = await Promise.all((history?.sessions || []).map((row) => api.getChatSession(row.id)));
    return chats.map((chat) => chat?.session).filter(Boolean);
  });
}

/**
 * What the composer shows right now: the text still in the input, whether the
 * send button is disabled or turned into a stop button, and the hint line.
 * `sendChatMessage` returns without a trace when a guard turns the send away
 * (a run in flight, a provider not configured yet, a disabled button), and the
 * input keeping its text is the only outward sign of that (#809).
 */
export function composerState(page) {
  return page.evaluate(() => ({
    input: document.getElementById('chat-input')?.value ?? null,
    sendDisabled: document.getElementById('btn-chat-send')?.disabled ?? null,
    running: document.getElementById('btn-chat-send')?.classList.contains('chat-send--stop') ?? null,
    hint: document.getElementById('chat-hint')?.classList.contains('hidden')
      ? null
      : document.getElementById('chat-hint')?.textContent ?? null,
  })).catch((error) => `composer state failed: ${error?.message ?? error}`);
}

/**
 * Waits until the open folder's chat is on screen. `launchApp` only waits for
 * the page, and the chat comes a round trip later: `showChatForWorkspace`
 * empties the composer and then draws the chat — its history or the greeting.
 * Text a test writes into the composer before that is wiped (#869). A send
 * waits for the chat by itself (#721); anything else that touches the composer
 * right after the start waits here first. Needs a folder: without one there is
 * no greeting to wait for.
 */
export async function waitForFolderChat(page, { explain = null } = {}) {
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages > .chat-msg')), {
    what: "the folder's chat on screen", explain,
  });
}

/**
 * Types `text` into the composer and sends it, and checks that the send took.
 * The input is emptied only once the message has passed every guard of
 * `sendChatMessage`, so text that is still there afterwards names a send that
 * was lost — instead of the test waiting a minute for a run that never started.
 * The two ways to fail say which part went missing: the button never became
 * enabled, or it was enabled and the click was dropped anyway. A send that
 * threw after taking the draft gives it back and records "send failed"
 * (#919); that record fails the wait as well, with the error, even if the
 * input happens to be empty when it is looked at.
 *
 * Waiting for the button also hides the case it guards against: a button that
 * is disabled although no run is going — the provider reads as not configured
 * — and comes back by itself. With `t`, that wait is reported as a diagnostic
 * with the composer and the evidence, so a pass does not swallow it (#809).
 */
export async function sendChat(page, text, { explain = null, t = null } = {}) {
  const failures = (afterSeq) => page.evaluate((seq) => {
    const debug = window.__snotraToolLogDebug;
    return debug ? debug.snapshot().filter((e) => e.seq > seq && (e.kind === 'send failed' || e.kind === 'uncaught'))
      .map((e) => ({ kind: e.kind, ...e.data })) : [];
  }, afterSeq).catch(() => []);
  const lastSeq = () => page.evaluate(() => window.__snotraToolLogDebug?.snapshot().at(-1)?.seq ?? 0).catch(() => 0);
  let baseline = await lastSeq();
  const state = async () => JSON.stringify({ composer: await composerState(page), rendererErrors: await failures(baseline) });
  const evidence = async () => (explain ? await Promise.resolve().then(explain).catch((e) => `explain failed: ${e?.message ?? e}`) : '');
  const withEvidence = async (error) => {
    const extra = await evidence();
    throw new Error(`${error.message}\n${await state()}${extra ? `\n${extra}` : ''}`);
  };
  const before = await composerState(page);
  if (t && before?.sendDisabled === true && before.running === false) {
    const extra = await evidence();
    t.diagnostic(`send button disabled with no run going before "${text}": ${JSON.stringify(before)}${extra ? `\n${extra}` : ''}`);
  }
  await poll(() => page.evaluate(() => {
    const button = document.getElementById('btn-chat-send');
    return Boolean(button) && !button.disabled && !button.classList.contains('chat-send--stop');
  }), { what: `send button ready for "${text}"`, timeoutMs: 10000 }).catch(withEvidence);
  baseline = await lastSeq();
  await page.evaluate((value) => {
    const input = document.getElementById('chat-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
  await poll(async () => {
    if ((await failures(baseline)).some((e) => e.kind === 'send failed')) {
      throw new Error(`send failed ("${text}"): it threw after taking the draft`);
    }
    return page.evaluate(() => document.getElementById('chat-input').value === '');
  }, { what: `send taken ("${text}": the input is emptied)`, timeoutMs: 10000 }).catch(withEvidence);
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
    version: 6,
    activeProvider: 'openai-compatible',
    activePresetId: presetId,
    presets: [{
      id: presetId,
      providerId: 'openai-compatible',
      model: 'fake-model',
      menuVisible: true,
      connection: {
        displayName: 'Fake model',
        baseUrl: modelBaseUrl,
        apiStyle: 'chat',
        sendTools: true,
        supportsImages: false,
        insecureTls: false,
      },
    }],
    providers: {},
  });
  await write('ui-preferences.json', { appLocale: 'de' });
}

/**
 * The column widths every Playwright start opens with, unless the profile
 * already remembers its own. The app's defaults (chat 320 px, sidebar 280 px)
 * are made for a first start on a small screen; in tests, smoke scripts and the
 * screenshots for the manual and the blog they left a narrow chat beside a
 * wide, mostly empty preview. At 1280 px the preview keeps enough room for its
 * header to stay on one line.
 */
export const TEST_LAYOUT = Object.freeze({ chatPanelWidth: 440, sidebarWidth: 240 });

/**
 * Writes `layout` into the profile's ui-preferences.json, next to whatever the
 * caller put there. A width the caller set itself wins.
 */
async function seedLayout(userDataDir, layout) {
  const file = path.join(userDataDir, 'ui-preferences.json');
  let prefs = {};
  try {
    prefs = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const missing = Object.entries(layout).filter(([key]) => typeof prefs[key] !== 'number');
  if (missing.length === 0) return;
  await mkdir(userDataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ ...prefs, ...Object.fromEntries(missing) }), 'utf8');
}

/**
 * Startet die App und wartet, bis der Renderer steht. `wrapper` is an optional
 * executable to start instead of Electron — it must start Electron itself and
 * pass all arguments on (Playwright puts its own in front). Used to start the
 * app under a Seatbelt profile (#329). `env` adds variables for this launch,
 * `args` adds Chromium switches (the manual's screenshots fix the scale factor).
 * `layout` holds the starting column widths (see TEST_LAYOUT); `null` leaves
 * the app's own defaults, for a test that measures them. `mainPreload` is a
 * CommonJS file loaded into the main process before the app's own code
 * (`electron -r`); NODE_OPTIONS cannot do that, Playwright removes it (#988).
 */
export async function launchApp({
  userDataDir, wrapper = null, env: extraEnv = {}, home, args: extraArgs = [], layout = TEST_LAYOUT,
  mainPreload = null,
}) {
  // A single file run with `node --test` skips the pretest sync (#919).
  generatedFreshness.assertGeneratedFresh();
  if (layout !== null) await seedLayout(userDataDir, layout);
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  // --user-data-dir moves the profile, not the home folder, and main reads
  // global memory, instructions and skills below the home folder (#702). Every
  // start gets an empty one of its own unless the caller hands one over; only
  // a script that has to run a real program with its real login passes
  // `home: false` and keeps the real one.
  //
  // Main asks SNOTRA_HOME_DIR first (src/main/services/home-dir.js). HOME moves
  // as well on macOS and Linux, so that programs the app starts see the test
  // home too. Not on Windows: there os.homedir() reads USERPROFILE, and with
  // that moved Electron never came up — every launch stalled (#707).
  const isolateHome = home !== false;
  const homeDir = isolateHome ? (home ?? await testHomeFor(userDataDir)) : null;
  if (homeDir) {
    env.SNOTRA_HOME_DIR = homeDir;
    if (process.platform !== 'win32') env.HOME = homeDir;
  }
  // The start-up update check would ask GitHub for real. Once a release newer
  // than the checkout is out, its dialog lands on top of the window and the
  // screenshots compare the dialog instead of the app (#407).
  env.SNOTRA_NO_UPDATE_CHECK = '1';

  const app = await withDeadline(_electron.launch({
    timeout: STARTUP_DEADLINE_MS,
    executablePath: wrapper || electronBinary,
    args: [
      ...(mainPreload ? ['-r', mainPreload] : []),
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
      // safeStorage takes a fixed test key instead of the login keychain's, so
      // no run asks macOS for access and none reaches the installed app's key
      // (#885). Not left to Playwright, which sets the switch from inside the
      // app, after safeStorage has read the command line. Ignored elsewhere.
      '--use-mock-keychain',
      ...extraArgs,
    ],
    env,
  }), 'Electron launch');

  // What main printed, kept for a failing test to show (#689). The CI log
  // otherwise has nothing of it — not the [storage] or [quit] warnings that
  // would say why a restart came back without its data.
  const mainOutput = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (chunk) => mainOutput.push(String(chunk)));
  }

  // A start that stalls used to sit out the whole test timeout without a word
  // (#707): `page.evaluate` has no deadline of its own. Now it fails here and
  // says what main printed and what it was waiting on.
  let page;
  try {
    page = await withDeadline((async () => {
      // The app window, not the first page: a profile from before #1012 first
      // gets a window-less page that carries its localStorage over.
      let first = await app.firstWindow({ timeout: STARTUP_DEADLINE_MS });
      while (!/\/index\.html(?:[?#]|$)/.test(first.url())) {
        const next = app.windows().find((candidate) => /\/index\.html(?:[?#]|$)/.test(candidate.url()));
        first = next ?? await app.waitForEvent('window', { timeout: STARTUP_DEADLINE_MS });
      }
      await poll(() => first.evaluate(() => !!document.getElementById('tree-container')), {
        what: 'geladener Renderer',
      });
      return first;
    })(), 'first window with a loaded renderer');
  } catch (error) {
    const report = await describeStalledStart(app, mainOutput);
    app.process()?.kill();
    error.message += `\n${report}`;
    throw error;
  }

  return {
    app,
    page,
    /** The home folder the app sees, or null when it is the real one. */
    home: homeDir,
    /** Everything main wrote to stdout and stderr so far. */
    mainOutput: () => mainOutput.join(''),
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
      // `app.close()` has no time limit of its own. A quit that never ends
      // used to surface only as the test's 180 s timeout, with nothing to say
      // where main was stuck (#689) — this reports it while it still hangs.
      const startedAt = Date.now();
      const watchdog = setTimeout(() => {
        void reportStalledQuit(app, mainOutput, startedAt);
      }, STALLED_QUIT_MS);
      try {
        await app.close();
      } finally {
        clearTimeout(watchdog);
      }
    },
  };
}

/**
 * Writes what is known about a quit that does not end to stderr: whether main
 * is still alive, what it printed, and on macOS a stack sample of main, which
 * shows a thread blocked in the keychain or in a write at a glance.
 */
async function reportStalledQuit(app, mainOutput, startedAt) {
  const pid = app.process().pid;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // gone
  }
  const lines = [
    `[e2e] The app (pid ${pid}) has not quit after ${Math.round((Date.now() - startedAt) / 1000)} s; main is ${alive ? 'still running' : 'gone'}.`,
    `[e2e] main output so far:\n${mainOutput.join('') || '(none)'}`,
  ];
  if (alive && process.platform === 'darwin') lines.push(`[e2e] stack sample of main:\n${await sampleProcess(pid)}`);
  console.error(lines.join('\n'));
}

/** `sample` ships with macOS; two seconds are enough to see where a thread waits. */
async function sampleProcess(pid) {
  const file = path.join(await makeTempDir('snotra-sample-'), 'main.txt');
  try {
    await new Promise((resolve, reject) => {
      execFile('sample', [String(pid), '2', '-mayDie', '-file', file], { timeout: 15000 },
        (error) => (error ? reject(error) : resolve()));
    });
    const text = await readFile(file, 'utf8');
    // The call graph of the main thread comes first; the rest is binary images.
    const start = text.indexOf('Call graph:');
    return text.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 12000);
  } catch (error) {
    return `(sample failed: ${error.message})`;
  }
}
