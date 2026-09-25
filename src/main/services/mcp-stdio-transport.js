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
const { createMessage } = require('../../shared/contracts/message');

/** Fehler mit dem stderr-Auszug daran, damit der Aufrufer ihn nicht sucht. */
/**
 * A transport error is read on two channels (#338): a failed `tools/call`
 * hands `message` to the model, which reads English, while a failed start or
 * handshake ends up in the MCP status in Settings, which follows the interface
 * language. So each error carries both — the English sentence as `message`,
 * the catalogue message as `userMessage`.
 */
function transportError(message, stderr, userMessage) {
  const error = new Error(message);
  error.stderr = stderr || '';
  if (userMessage) error.userMessage = userMessage;
  return error;
}

/** Why the process ended, for both channels. */
function exitReasonOf(code, signal) {
  return signal
    ? { text: `signal ${signal}`, message: createMessage('mcp.transport.reason.signal', { signal }) }
    : { text: `exit code ${code}`, message: createMessage('mcp.transport.reason.code', { code }) };
}

/** A third-party error text, or "unknown error" in the channel's language. */
function detailOf(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text
    ? { text, message: text }
    : { text: 'unknown error', message: createMessage('mcp.transport.unknownError') };
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
  let exitReason = null;
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
    failPending(closing
      ? transportError(
        'The MCP server was stopped while the request was running.',
        text,
        createMessage('mcp.transport.stoppedDuringRequest'),
      )
      : transportError(
        `The MCP server “${config.label}” exited unexpectedly (${reason.text}).`,
        text,
        createMessage('mcp.transport.exited', { label: config.label, reason: reason.message }),
      ));
    for (const listener of exitListeners) {
      try {
        listener({ reason: reason.text, reasonMessage: reason.message, stderr: text, expected: closing });
      } catch { /* egal */ }
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
      const detail = detailOf(message.error);
      const code = Number.isFinite(message.error.code) ? message.error.code : null;
      entry.reject(transportError(
        `The MCP server reports: ${detail.text}${code === null ? '' : ` (code ${code})`}`,
        stderrText(),
        code === null
          ? createMessage('mcp.transport.serverError', { detail: detail.message })
          : createMessage('mcp.transport.serverErrorCode', { detail: detail.message, code }),
      ));
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
        `The MCP server “${config.label}” sent an oversized answer without a line break.`,
        stderrText(),
        createMessage('mcp.transport.oversized', { label: config.label }),
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
      const detail = detailOf(e);
      throw transportError(
        `The MCP server “${config.label}” could not be started: ${detail.text}`,
        '',
        createMessage('mcp.transport.startFailed', { label: config.label, detail: detail.message }),
      );
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    // EPIPE, wenn der Server stirbt, während wir schreiben — das meldet
    // bereits der Exit, hier würde es nur den Prozess mitreißen.
    child.stdin?.on('error', () => {});
    child.on('error', (e) => handleExit(detailOf(e)));
    child.on('close', (code, signal) => handleExit(exitReasonOf(code, signal)));

    // Ein Kommando, das es nicht gibt, meldet sich erst im nächsten Tick als
    // 'error'. Einen Tick warten, damit `start` selbst schon scheitert und
    // nicht erst der Handshake in einen Timeout läuft.
    await new Promise((resolve) => setImmediate(resolve));
    if (exited) {
      throw transportError(
        `The MCP server “${config.label}” could not be started (${exitReason.text}).`,
        stderrText(),
        createMessage('mcp.transport.startFailedReason', { label: config.label, reason: exitReason.message }),
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
        `The MCP server “${config.label}” is not connected.`,
        stderrText(),
        createMessage('mcp.transport.notConnected', { label: config.label }),
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(transportError('Request cancelled.', '', createMessage('mcp.transport.cancelled')));
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        reject(transportError('Request cancelled.', '', createMessage('mcp.transport.cancelled')));
      };
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cleanup();
        const seconds = Math.round(timeoutMs / 1000);
        reject(transportError(
          `The MCP server “${config.label}” did not answer “${method}” within ${seconds} s.`,
          stderrText(),
          createMessage('mcp.transport.timeout', { label: config.label, method, seconds }),
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
        const detail = detailOf(e);
        reject(transportError(
          `The request to “${config.label}” could not be written: ${detail.text}`,
          stderrText(),
          createMessage('mcp.transport.writeFailed', { label: config.label, detail: detail.message }),
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
      failPending(transportError(
        `The MCP server “${config.label}” is not connected.`,
        stderrText(),
        createMessage('mcp.transport.notConnected', { label: config.label }),
      ));
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

  /**
   * Sofort und synchron beenden — fuer das App-Ende (`will-quit`). Der
   * freundliche Weg ueber `close()` ist asynchron und kaeme dort zu spaet:
   * die Kindprozesse laufen in einer eigenen Prozessgruppe (`detached`) und
   * wuerden den Elternprozess sonst als Waisen ueberleben.
   */
  function kill() {
    closing = true;
    killTree();
  }

  return {
    start,
    request,
    notify,
    close,
    kill,
    stderrText,
    isAlive: () => Boolean(child) && !exited,
    onExit: (listener) => { exitListeners.add(listener); },
  };
}

module.exports = { createStdioTransport };
