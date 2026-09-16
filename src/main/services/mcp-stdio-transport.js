'use strict';

/**
 * JSON-RPC 2.0 über stdin/stdout eines MCP-Kindprozesses (Issue #106).
 *
 * Diese Datei kennt das Protokoll *nicht* — sie kennt nur Nachrichten: Zeilen
 * rein, Zeilen raus, Antworten über die Request-`id` zuordnen. Was
 * `initialize` oder `tools/call` bedeuten, steht im mcp-service. Genau diese
 * Trennung ist die Wechselstelle: Ein SDK-gestützter Transport müsste nur
 * `start`, `request`, `notify` und `close` in derselben Form anbieten, der
 * Dienst darüber bliebe unverändert (Entscheidung zu #106).
 *
 * Das Framing ist zeilenbasiert, so schreibt es der stdio-Transport von MCP
 * vor: eine Nachricht je Zeile, keine eingebetteten Zeilenumbrüche. Unter
 * Windows kommen die Zeilen mit CRLF an, deshalb wird das „\r" abgeschnitten
 * statt in JSON.parse zu laufen.
 *
 * Kindprozess-Muster wie in python-runner-service.js: eigene Prozessgruppe,
 * Kill des ganzen Baums. Ein MCP-Server startet gern selbst noch Kinder
 * (`npx` → `node`), und die sollen beim App-Ende nicht weiterlaufen.
 */

const { MCP_LIMITS, MCP_TIMEOUTS } = require('../../shared/contracts/mcp');
const { createOutputSink } = require('./child-output-sink');

/** Fehler mit dem stderr-Auszug daran, damit der Aufrufer ihn nicht sucht. */
function transportError(message, stderr) {
  const error = new Error(message);
  error.stderr = stderr || '';
  return error;
}

/**
 * @param {Object} deps
 * @param {import('../../shared/contracts/mcp').McpServerConfig} deps.config
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {NodeJS.ProcessEnv} [deps.baseEnv] — Umgebung samt aufgeräumtem PATH
 * @param {string} [deps.platform]
 */
function createStdioTransport({ config, spawn, baseEnv = process.env, platform = process.platform }) {
  const stderr = createOutputSink(MCP_LIMITS.STDERR_MAX_BYTES);
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout, cleanup: Function }>} */
  const pending = new Map();
  let child = null;
  let nextId = 1;
  let buffer = '';
  // Warum der Prozess weg ist — unterscheidet „wir haben zugemacht" von
  // „er ist gestorben", was im Fehlertext einen Unterschied macht.
  let closing = false;
  let exited = false;
  let exitReason = '';
  const exitListeners = new Set();

  function stderrText() {
    return stderr.text();
  }

  /** Alle offenen Anfragen scheitern lassen — nie hängen bleiben. */
  function failPending(error) {
    const open = [...pending.values()];
    pending.clear();
    for (const entry of open) {
      entry.cleanup();
      entry.reject(error);
    }
  }

  function killTree() {
    if (!child || exited) return;
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

  function handleExit(reason) {
    if (exited) return;
    exited = true;
    exitReason = reason;
    const text = stderrText();
    failPending(transportError(
      closing
        ? 'Der MCP-Server wurde beendet, während die Anfrage lief.'
        : `Der MCP-Server „${config.label}" hat sich unerwartet beendet (${reason}).`,
      text,
    ));
    for (const listener of exitListeners) {
      try { listener({ reason, stderr: text, expected: closing }); } catch { /* egal */ }
    }
    exitListeners.clear();
  }

  /** Eine eingegangene Zeile zuordnen. Unbekanntes wird still verworfen. */
  function handleMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Ein Server, der Text auf stdout schreibt, ist kaputt — aber kein
      // Grund, die Verbindung zu kappen. Die Zeile landet nur nirgends.
      return;
    }
    if (!message || typeof message !== 'object') return;
    // Benachrichtigungen und Server-Anfragen (z. B. sampling) haben keine
    // Antwort bei uns; wir bedienen im MVP nur die Client→Server-Richtung.
    if (message.id === undefined || message.id === null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.cleanup();
    if (message.error) {
      const detail = typeof message.error.message === 'string' ? message.error.message : 'Unbekannter Fehler.';
      const code = Number.isFinite(message.error.code) ? ` (Code ${message.error.code})` : '';
      entry.reject(transportError(`Der MCP-Server meldet: ${detail}${code}`, stderrText()));
      return;
    }
    entry.resolve(message.result === undefined ? {} : message.result);
  }

  function onStdout(chunk) {
    buffer += String(chunk);
    if (buffer.length > MCP_LIMITS.MAX_MESSAGE_BYTES) {
      // Kein Zeilenumbruch in Sicht: der Server hält sich nicht ans Framing.
      // Lieber abbrechen als unbegrenzt puffern.
      buffer = '';
      failPending(transportError(
        `Der MCP-Server „${config.label}" schickt eine übergroße Antwort ohne Zeilenende.`,
        stderrText(),
      ));
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleMessage(line);
      newline = buffer.indexOf('\n');
    }
  }

  /** Startet den Prozess. Wirft mit Klartext, wenn das Kommando fehlt. */
  async function start() {
    if (child) return;
    const env = { ...baseEnv, ...config.env };
    try {
      child = spawn(config.command, config.args, {
        cwd: config.cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        // Eigene Prozessgruppe, damit killTree auch Enkel erwischt.
        detached: platform !== 'win32',
      });
    } catch (e) {
      child = null;
      throw transportError(
        `Der MCP-Server „${config.label}" konnte nicht gestartet werden: ${e?.message || 'unbekannter Fehler'}`,
        '',
      );
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    // EPIPE, wenn der Server stirbt, während wir schreiben — das meldet
    // bereits der Exit, hier würde es nur den Prozess mitreißen.
    child.stdin?.on('error', () => {});
    child.on('error', (e) => handleExit(e?.message || 'Startfehler'));
    child.on('close', (code, signal) => handleExit(signal ? `Signal ${signal}` : `Code ${code}`));

    // Ein Kommando, das es nicht gibt, meldet sich erst im nächsten Tick als
    // 'error'. Einen Tick warten, damit `start` selbst schon scheitert und
    // nicht erst der Handshake in einen Timeout läuft.
    await new Promise((resolve) => setImmediate(resolve));
    if (exited) {
      throw transportError(
        `Der MCP-Server „${config.label}" konnte nicht gestartet werden (${exitReason}).`,
        stderrText(),
      );
    }
  }

  /**
   * Eine Anfrage mit Antwort. Zeitlimit und AbortSignal beenden das Warten,
   * nicht den Server — ein abgebrochener `tools/call` lässt die Verbindung
   * stehen, damit der nächste Aufruf nicht neu starten muss.
   */
  function request(method, params, { timeoutMs = MCP_TIMEOUTS.REQUEST_MS, signal } = {}) {
    if (!child || exited) {
      return Promise.reject(transportError(
        `Der MCP-Server „${config.label}" ist nicht verbunden.`,
        stderrText(),
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(transportError('Anfrage abgebrochen.', ''));
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        reject(transportError('Anfrage abgebrochen.', ''));
      };
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        reject(transportError(
          `Der MCP-Server „${config.label}" hat auf „${method}" nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet.`,
          stderrText(),
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        pending.delete(id);
        cleanup();
        reject(transportError(
          `Die Anfrage an „${config.label}" konnte nicht geschrieben werden: ${e?.message || 'unbekannter Fehler'}`,
          stderrText(),
        ));
      }
    });
  }

  /** Benachrichtigung ohne Antwort (`notifications/initialized`). */
  function notify(method, params) {
    if (!child || exited) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch { /* der Exit meldet sich ohnehin */ }
  }

  /**
   * Erst freundlich (stdin schließen), dann hart. Ohne die harte Stufe bliebe
   * ein Server, der auf EOF nicht reagiert, als Waise zurück.
   */
  function close() {
    closing = true;
    if (!child || exited) {
      failPending(transportError('Der MCP-Server ist nicht verbunden.', stderrText()));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        killTree();
        // Auch wenn der Kill nichts mehr bewirkt: nicht ewig hier stehen.
        setTimeout(done, 200).unref?.();
      }, MCP_TIMEOUTS.SHUTDOWN_MS);
      exitListeners.add(done);
      try { child.stdin?.end(); } catch { /* schon zu */ }
    });
  }

  return {
    start,
    request,
    notify,
    close,
    stderrText,
    isAlive: () => Boolean(child) && !exited,
    onExit: (listener) => { exitListeners.add(listener); },
  };
}

module.exports = { createStdioTransport };
