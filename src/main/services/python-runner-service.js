'use strict';

/**
 * Python-Ausfuehrung im Kindprozess (Issue #86).
 *
 * Nie im Main-Prozess: ein Skript mit Endlosschleife wuerde sonst die ganze
 * App anhalten — dieselbe Lehre wie aus #69. Deshalb eigener Prozess, hartes
 * Zeitlimit, Kill des Prozessbaums und Anbindung an den AbortSignal-Pfad,
 * damit „Stop" im Chat auch das Skript beendet.
 *
 * Isolation (#329): on macOS and Linux the interpreter runs under the sandbox
 * service — writes only in the workspace and the script's temp directory,
 * network only for the declared domains. Elsewhere the approval before every
 * run is the protection, and the result says the run was not isolated.
 *
 * Den PATH bringt der Dienst nicht selbst auf (Issue #111): eine aus dem
 * Finder gestartete App erbt nur den kargen PATH des Fensterservers und faende
 * hoechstens `/usr/bin/python3` statt des Homebrew- oder pyenv-Python aus dem
 * Terminal. Den echten PATH liest der Shell-Runner einmal beim Start aus dem
 * Profil; hierher kommt er als `readShellPath` herein — als Wert, nicht als
 * Abhaengigkeit auf den Shell-Dienst.
 */

const { PYTHON_EXECUTION_LIMITS } = require('../../application/ports/code-execution-port');
const { createChildRunner } = require('./child-run');
const { planSpawn } = require('./sandboxed-spawn');
const { createMessage } = require('../../shared/contracts/message');

/** Kandidaten in der Reihenfolge, in der wir sie ausprobieren. */
function interpreterCandidates(platform) {
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
    ];
  }
  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

function clampTimeout(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return PYTHON_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS;
  return Math.min(
    PYTHON_EXECUTION_LIMITS.MAX_TIMEOUT_MS,
    Math.max(PYTHON_EXECUTION_LIMITS.MIN_TIMEOUT_MS, Math.round(value)),
  );
}

function normalizeArgv(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    if (out.length >= PYTHON_EXECUTION_LIMITS.MAX_ARGV) break;
    if (typeof value !== 'string') continue;
    out.push(value.slice(0, PYTHON_EXECUTION_LIMITS.MAX_ARGV_CHARS));
  }
  return out;
}

/**
 * @param {Object} deps
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {typeof import('fs').promises} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {() => Promise<string>} [deps.readInterpreterOverride] eigener Pfad aus den Einstellungen
 * @param {() => Promise<string>} [deps.readShellPath] PATH aus dem Shell-Profil (Issue #111)
 * @param {string} [deps.platform]
 */
function createPythonRunnerService({
  spawn,
  fs,
  path,
  os,
  readInterpreterOverride = async () => '',
  readShellPath = async () => '',
  platform = process.platform,
  env = process.env,
  randomId = () => Math.random().toString(36).slice(2),
  // Sandbox service (#329); without it runs are not isolated.
  sandbox = null,
}) {
  // Ergebnis der letzten Erkennung. Synchron abrufbar, weil die Tool-Liste
  // ohne Warten gebaut wird; fortgeschrieben beim Start und beim Speichern
  // der Einstellungen.
  // `error` is the detail Settings shows next to "No Python 3 found": a
  // catalogue message, or the quoted output of the probe (#338). The model
  // never reads it — `run()` has its own English sentence.
  let detected = { found: false, error: createMessage('runner.error.notChecked') };
  // PATH aus dem Shell-Profil, bei der Erkennung ermittelt. Leer heisst:
  // nichts zu reparieren (Windows) oder keine Shell gefunden.
  let shellPath = '';

  /**
   * Umgebung fuer Suche und Lauf. Der Profil-PATH gilt fuer beides: sonst
   * faende die Suche zwar den richtigen Interpreter, ein `subprocess.run`
   * im Skript aber weiterhin nicht die Werkzeuge aus dem Terminal.
   */
  function childEnv(extra = {}) {
    return { ...env, ...(shellPath ? { PATH: shellPath } : {}), ...extra };
  }

  function probe(command, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, [...args, '--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv(),
          windowsHide: true,
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || createMessage('runner.error.startFailed') });
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* schon weg */ }
        resolve({ ok: false, error: createMessage('runner.error.probeTimeout') });
      }, 5_000);
      child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.on('data', (c) => { out += String(c); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || createMessage('runner.error.notFound') });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const version = out.trim().split('\n')[0] || '';
        if (code === 0 && /python\s*3/i.test(version)) {
          resolve({ ok: true, version });
        } else {
          resolve({ ok: false, error: version || createMessage('runner.error.exitCode', { code }) });
        }
      });
    });
  }

  /**
   * Sucht einen Interpreter: erst der in den Einstellungen hinterlegte Pfad,
   * sonst die Kandidaten der Plattform. Ein hinterlegter Pfad, der nicht
   * funktioniert, faellt bewusst NICHT still auf python3 zurueck — sonst liefe
   * das Skript im falschen venv.
   */
  async function detect() {
    // Vor der Suche, nicht waehrenddessen: die Kandidaten sind blosse
    // Programmnamen, ueber den PATH entscheidet sich also, welcher Python
    // ueberhaupt gefunden wird (Issue #111).
    shellPath = String((await readShellPath()) || '').trim();
    const override = String((await readInterpreterOverride()) || '').trim();
    if (override) {
      const result = await probe(override, []);
      detected = result.ok
        ? { found: true, command: override, args: [], version: result.version, source: 'override', pathSource: pathSource() }
        : { found: false, command: override, error: result.error, source: 'override', pathSource: pathSource() };
      return detected;
    }
    for (const candidate of interpreterCandidates(platform)) {
      const result = await probe(candidate.command, candidate.args);
      if (result.ok) {
        detected = {
          found: true,
          command: candidate.command,
          args: candidate.args,
          version: result.version,
          source: 'auto',
          pathSource: pathSource(),
        };
        return detected;
      }
    }
    detected = {
      found: false,
      error: createMessage('runner.error.tried', {
        candidates: platform === 'win32' ? 'py -3, python' : 'python3, python',
      }),
      source: 'auto',
      pathSource: pathSource(),
    };
    return detected;
  }

  /** Woher der PATH der Suche stammt — fuer den Status in den Einstellungen. */
  function pathSource() {
    return shellPath ? 'login-shell' : 'inherited';
  }

  // Time limit, "Stop", output cap and the process tree (CR-B03-01).
  const children = createChildRunner({ spawn, platform });

  async function run({ code, stdin, argv, timeoutMs, cwd, workspaceRoot, networkDomains, sandboxDisabled = false, abortSignal } = {}) {
    if (!detected.found) {
      return { error: 'No Python 3 interpreter is available.' };
    }
    const source = typeof code === 'string' ? code : '';
    if (!source.trim()) return { error: 'No Python code was given.' };
    if (source.length > PYTHON_EXECUTION_LIMITS.MAX_CODE_CHARS) {
      return { error: `The code is longer than ${PYTHON_EXECUTION_LIMITS.MAX_CODE_CHARS} characters.` };
    }

    // Das Skript liegt im Temp-Verzeichnis, nicht im Projekt — der Ordner des
    // Nutzers soll durch einen Tool-Aufruf keine Dateien bekommen.
    let dir = '';
    let scriptPath;
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-py-'));
      scriptPath = path.join(dir, `script-${randomId()}.py`);
      await fs.writeFile(scriptPath, source, 'utf8');
    } catch (e) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return { error: `The script could not be written to a temp file: ${e?.message || e}` };
    }

    const limit = clampTimeout(timeoutMs);
    const startedAt = Date.now();

    // Isolation (#329): the script's temp directory doubles as the run's own
    // writable place next to the workspace.
    let target;
    try {
      target = await planSpawn({
        sandbox,
        // Switched off for this workspace by the user (#357).
        disabled: sandboxDisabled === true,
        // -B: keine .pyc-Dateien neben dem Skript. -u: ungepuffert, sonst
        // geht die Ausgabe eines abgebrochenen Laufs verloren.
        argv: [detected.command, ...(detected.args || []), '-B', '-u', scriptPath, ...normalizeArgv(argv)],
        workspaceRoot,
        runTmp: dir,
        domains: networkDomains,
        commandId: `python-${randomId()}`,
        commandText: `python ${path.basename(scriptPath)}`,
        abortSignal,
      });
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (e?.name === 'AbortError') {
        return {
          stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true,
          truncated: false, durationMs: Date.now() - startedAt,
        };
      }
      return { error: e?.message || 'The sandbox could not be prepared.' };
    }

    try {
      const outcome = await children.run({
        command: target.command,
        args: target.args,
        cwd: cwd || os.homedir(),
        env: { ...childEnv({ PYTHONIOENCODING: 'utf-8' }), ...target.env },
        stdin,
        maxStdinChars: PYTHON_EXECUTION_LIMITS.MAX_STDIN_CHARS,
        maxOutputBytes: PYTHON_EXECUTION_LIMITS.MAX_OUTPUT_BYTES,
        timeoutMs: limit,
        abortSignal,
        startError: 'Python could not be started.',
      });
      if (outcome.error) return outcome;
      // What the sandbox refused (#792): as a list for the chat's tool row,
      // and in stderr for the model (#329). Looked up before annotating.
      const blocked = await target.blocked?.({ failed: outcome.exitCode !== 0 && !outcome.aborted });
      const result = {
        ...outcome,
        stderr: target.annotate(outcome.stderr),
        durationMs: Date.now() - startedAt,
      };
      if (target.isolation) result.isolation = target.isolation;
      if (blocked) result.sandboxBlocked = blocked;
      return result;
    } finally {
      target.release();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** For the app quitting (#506): ends every script still running. */
  function disposeSync() {
    children.disposeSync();
  }

  return {
    detect,
    describe: () => ({ ...detected }),
    isAvailable: () => detected.found === true,
    run,
    disposeSync,
  };
}

module.exports = { createPythonRunnerService, interpreterCandidates, clampTimeout };
