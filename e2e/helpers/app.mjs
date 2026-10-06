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
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import electronBinary from 'electron';

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
      homedir: process.getBuiltinModule('node:os').homedir(),
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
 * macOS looks for the login keychain below $HOME. In an empty home the app
 * would run without safeStorage, and that is a mode of its own (#419, #658),
 * not the one the tests are about. So the test home reaches the real keychain
 * folder, and only that: memory, instructions and skills stay its own.
 */
async function reachKeychain(home) {
  if (process.platform !== 'darwin') return;
  const link = path.join(home, 'Library', 'Keychains');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(path.join(homedir(), 'Library', 'Keychains'), link).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
}

/** Where safeStorage keeps its key: Chromium names the item "<app name> Safe Storage". */
export const KEYCHAIN_SERVICE = 'Snotra AI Safe Storage';

/**
 * How many keychain items hold the app's safeStorage key — on a CI runner
 * only, where the keychain belongs to the run; a developer's keychain is not
 * listed (#689). The item is created by the first start that finds none, so
 * more than one means two starts created it at once, and a later start may
 * read the other key than the one its data was written with.
 */
export async function keychainItemCount() {
  if (process.platform !== 'darwin' || !process.env.CI) return null;
  const listing = await new Promise((resolve) => {
    execFile('security', ['dump-keychain'], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
      (error, stdout) => resolve(error ? null : stdout));
  });
  if (listing === null) return null;
  const marker = `"svce"<blob>="${KEYCHAIN_SERVICE}"`;
  return listing.split('\n').filter((line) => line.includes(marker)).length;
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
 */
export async function poll(check, { timeoutMs = 15000, intervalMs = 150, what = 'Bedingung', explain = null } = {}) {
  const deadline = Date.now() + timeoutMs;
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
 * Startet die App und wartet, bis der Renderer steht. `wrapper` is an optional
 * executable to start instead of Electron — it must start Electron itself and
 * pass all arguments on (Playwright puts its own in front). Used to start the
 * app under a Seatbelt profile (#329). `env` adds variables for this launch.
 */
export async function launchApp({ userDataDir, wrapper = null, env: extraEnv = {}, home }) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  // --user-data-dir moves the profile, not the home folder, and main reads
  // global memory, instructions and skills below the home folder (#702). Every
  // start gets an empty one of its own unless the caller hands one over; only
  // a script that has to run a real program with its real login passes
  // `home: false` and keeps the real one.
  //
  // On Windows `os.homedir()` reads USERPROFILE, not HOME (#707). APPDATA and
  // LOCALAPPDATA keep pointing at the real folders.
  const isolateHome = home !== false;
  const homeDir = isolateHome ? (home ?? await testHomeFor(userDataDir)) : null;
  if (homeDir) {
    await reachKeychain(homeDir);
    env.HOME = homeDir;
    if (process.platform === 'win32') env.USERPROFILE = homeDir;
  }
  // The start-up update check would ask GitHub for real. Once a release newer
  // than the checkout is out, its dialog lands on top of the window and the
  // screenshots compare the dialog instead of the app (#407).
  env.SNOTRA_NO_UPDATE_CHECK = '1';

  const app = await withDeadline(_electron.launch({
    timeout: STARTUP_DEADLINE_MS,
    executablePath: wrapper || electronBinary,
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
      const first = await app.firstWindow({ timeout: STARTUP_DEADLINE_MS });
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
