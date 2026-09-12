'use strict';

/**
 * Python-Ausfuehrung im Kindprozess (Issue #86).
 *
 * Nie im Main-Prozess: ein Skript mit Endlosschleife wuerde sonst die ganze
 * App anhalten — dieselbe Lehre wie aus #69. Deshalb eigener Prozess, hartes
 * Zeitlimit, Kill des Prozessbaums und Anbindung an den AbortSignal-Pfad,
 * damit „Stop" im Chat auch das Skript beendet.
 *
 * Erste Stufe bewusst ohne harte Isolation (eigener Nutzer, sandbox-exec,
 * Container, WASM-Python): der Schutz liegt hier in der Freigabe vor jedem
 * Lauf, nicht in einer Sandbox. Das steht so auch in README und Issue.
 */

const { PYTHON_EXECUTION_LIMITS } = require('../../application/ports/code-execution-port');
const { createOutputSink } = require('./child-output-sink');

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
 * @param {string} [deps.platform]
 */
function createPythonRunnerService({
  spawn,
  fs,
  path,
  os,
  readInterpreterOverride = async () => '',
  platform = process.platform,
  randomId = () => Math.random().toString(36).slice(2),
}) {
  // Ergebnis der letzten Erkennung. Synchron abrufbar, weil die Tool-Liste
  // ohne Warten gebaut wird; fortgeschrieben beim Start und beim Speichern
  // der Einstellungen.
  let detected = { found: false, error: 'Noch nicht geprüft.' };

  function probe(command, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, [...args, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, error: e?.message || 'Start fehlgeschlagen.' });
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* schon weg */ }
        resolve({ ok: false, error: 'Zeitüberschreitung bei der Versionsabfrage.' });
      }, 5_000);
      child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.on('data', (c) => { out += String(c); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || 'Interpreter nicht gefunden.' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const version = out.trim().split('\n')[0] || '';
        if (code === 0 && /python\s*3/i.test(version)) {
          resolve({ ok: true, version });
        } else {
          resolve({ ok: false, error: version || `Beendet mit Code ${code}.` });
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
    const override = String((await readInterpreterOverride()) || '').trim();
    if (override) {
      const result = await probe(override, []);
      detected = result.ok
        ? { found: true, command: override, args: [], version: result.version, source: 'override' }
        : { found: false, command: override, error: result.error, source: 'override' };
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
        };
        return detected;
      }
    }
    detected = {
      found: false,
      error:
        platform === 'win32'
          ? 'Kein Python 3 gefunden (weder „py -3“ noch „python“).'
          : 'Kein Python 3 gefunden (weder „python3“ noch „python“).',
      source: 'auto',
    };
    return detected;
  }

  /** Prozessbaum beenden — ein Skript kann selbst Kinder gestartet haben. */
  function killTree(child) {
    if (!child || child.killed) return;
    try {
      if (platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch { /* schon weg */ }
    }
  }

  async function run({ code, stdin, argv, timeoutMs, cwd, abortSignal } = {}) {
    if (!detected.found) {
      return { error: detected.error || 'Kein Python-Interpreter gefunden.' };
    }
    const source = typeof code === 'string' ? code : '';
    if (!source.trim()) return { error: 'Es wurde kein Python-Code übergeben.' };
    if (source.length > PYTHON_EXECUTION_LIMITS.MAX_CODE_CHARS) {
      return { error: `Der Code ist länger als ${PYTHON_EXECUTION_LIMITS.MAX_CODE_CHARS} Zeichen.` };
    }

    // Das Skript liegt im Temp-Verzeichnis, nicht im Projekt — der Ordner des
    // Nutzers soll durch einen Tool-Aufruf keine Dateien bekommen.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-py-'));
    const scriptPath = path.join(dir, `script-${randomId()}.py`);
    await fs.writeFile(scriptPath, source, 'utf8');

    const limit = clampTimeout(timeoutMs);
    const startedAt = Date.now();
    const stdout = createOutputSink(PYTHON_EXECUTION_LIMITS.MAX_OUTPUT_BYTES);
    const stderr = createOutputSink(PYTHON_EXECUTION_LIMITS.MAX_OUTPUT_BYTES);

    try {
      return await new Promise((resolve) => {
        let child;
        try {
          child = spawn(
            detected.command,
            // -B: keine .pyc-Dateien neben dem Skript. -u: ungepuffert, sonst
            // geht die Ausgabe eines abgebrochenen Laufs verloren.
            [...(detected.args || []), '-B', '-u', scriptPath, ...normalizeArgv(argv)],
            {
              cwd: cwd || os.homedir(),
              stdio: ['pipe', 'pipe', 'pipe'],
              // Eigene Prozessgruppe, damit killTree auch Enkelprozesse erwischt.
              detached: platform !== 'win32',
              env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            },
          );
        } catch (e) {
          resolve({ error: e?.message || 'Python konnte nicht gestartet werden.' });
          return;
        }

        let timedOut = false;
        let aborted = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, limit);

        const onAbort = () => {
          aborted = true;
          killTree(child);
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.stdout?.on('data', (chunk) => stdout.push(chunk));
        child.stderr?.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (e) => finish({ error: e?.message || 'Python konnte nicht gestartet werden.' }));
        child.on('close', (exitCode) => {
          finish({
            stdout: stdout.text(),
            stderr: stderr.text(),
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            timedOut,
            aborted,
            truncated: stdout.truncated || stderr.truncated,
            durationMs: Date.now() - startedAt,
          });
        });

        if (typeof stdin === 'string' && stdin) {
          child.stdin?.end(stdin.slice(0, PYTHON_EXECUTION_LIMITS.MAX_STDIN_CHARS));
        } else {
          child.stdin?.end();
        }
        if (abortSignal?.aborted) onAbort();
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    detect,
    describe: () => ({ ...detected }),
    isAvailable: () => detected.found === true,
    run,
  };
}

module.exports = { createPythonRunnerService, interpreterCandidates, clampTimeout };
