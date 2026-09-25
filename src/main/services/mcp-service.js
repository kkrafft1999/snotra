'use strict';

/**
 * Verbindungsverwaltung für MCP-Server (Issue #106, Teil von #62).
 *
 * Hier steht, was die Protokollnachrichten bedeuten — `initialize`,
 * `tools/list`, `tools/call` — und wie aus mehreren Servern eine Liste von
 * Tools wird. Wie die Nachrichten über die Leitung gehen, weiß nur der
 * Transport; er kommt als `createTransport` herein und ist damit die Stelle,
 * an der später ein SDK den eigenen Client ablösen kann.
 *
 * Verbunden wird träge: erst wenn jemand Tools braucht, nicht beim App-Start.
 * Ein MCP-Server ist ein fremder Prozess, und keiner davon soll starten, weil
 * die App startet — sondern weil er gebraucht wird.
 *
 * Ein Server, der nicht startet oder mitten im Betrieb stirbt, ist ein
 * normaler Zustand, kein Ausnahmefall: seine Tools verschwinden aus dem
 * Katalog, die übrigen Server laufen weiter, und der Grund steht samt
 * stderr-Auszug im Status.
 */

const {
  MCP_CONNECTION_STATES,
  MCP_PROTOCOL_VERSION,
  MCP_LIMITS,
  MCP_TIMEOUTS,
  createMcpConnectionStatus,
  normalizeMcpToolCatalog,
  validateMcpServerConfig,
} = require('../../shared/contracts/mcp');
const { createMessage } = require('../../shared/contracts/message');
const { createStdioTransport } = require('./mcp-stdio-transport');

/** Fehlertext eines geworfenen Fehlers, ohne „[object Object]"-Überraschungen. */
function messageOf(error, fallback) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text || fallback;
}

/**
 * @param {Object} deps
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {(deps: Object) => Object} [deps.createTransport]
 * @param {() => Promise<string>} [deps.readShellPath] PATH aus dem Shell-Profil (Issue #111)
 * @param {{ name: string, version: string }} [deps.clientInfo]
 * @param {{ HANDSHAKE_MS: number, REQUEST_MS: number }} [deps.timeouts]
 *   Ueberschreibbar, weil der Verbindungstest im Settings-Dialog (#109) nicht
 *   zwanzig Sekunden auf einen toten Server warten soll.
 */
function createMcpService({
  spawn,
  createTransport = createStdioTransport,
  readShellPath = async () => '',
  clientInfo = { name: 'Snotra AI', version: '0.0.0' },
  timeouts = MCP_TIMEOUTS,
  /**
   * Wird nach jeder geglueckten Verbindung mit dem Tool-Katalog gerufen, damit
   * die Oberflaeche ihn auch bei stehendem Server zeigen kann (#170). Fehler
   * hier duerfen keine Verbindung kosten — es ist nur ein Merkzettel.
   */
  rememberTools = async () => {},
  env = process.env,
  platform = process.platform,
} = {}) {
  const limits = { ...MCP_TIMEOUTS, ...timeouts };
  /**
   * @typedef {Object} Connection
   * @property {Object} config
   * @property {Object|null} transport
   * @property {string} state
   * @property {Array} tools
   * @property {string} error
   * @property {Promise|null} starting — verhindert doppeltes Hochfahren
   */
  /** @type {Map<string, Connection>} */
  const connections = new Map();
  let shellPath = null;

  function blank(config) {
    return {
      config,
      transport: null,
      state: MCP_CONNECTION_STATES.IDLE,
      tools: [],
      // Two channels (#338): `error` is what Settings shows — a catalogue
      // message, or a third-party text quoted as it is — and `modelError` the
      // English sentence a failed `callTool` hands to the model.
      error: '',
      modelError: '',
      stderr: '',
      serverName: '',
      serverVersion: '',
      protocolVersion: '',
      starting: null,
    };
  }

  /**
   * Umgebung für die Kindprozesse. Der PATH einer aus dem Finder gestarteten
   * App findet weder `npx` noch `uvx` (Issue #111) — genau die Kommandos, mit
   * denen MCP-Server üblicherweise eingetragen werden. Deshalb wird der PATH
   * aus dem Login-Profil einmal gelesen und dann wiederverwendet.
   */
  async function baseEnv() {
    if (shellPath === null) {
      shellPath = String((await readShellPath().catch(() => '')) || '').trim();
    }
    return shellPath ? { ...env, PATH: shellPath } : { ...env };
  }

  /**
   * Übernimmt die Serverliste. Server, die verschwinden oder sich ändern,
   * werden geschlossen — sonst liefe die alte Konfiguration weiter, während
   * der Nutzer die neue vor sich sieht.
   *
   * @returns {{ ok: boolean, servers: Object[],
   *   errors: Array<{ id: string, errors: Array<{key: string, params?: object}> }> }}
   */
  function setServers(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const servers = [];
    const errors = [];
    const seen = new Set();

    for (const raw of list) {
      const { ok, value, errors: problems } = validateMcpServerConfig(raw);
      if (!ok) {
        errors.push({ id: typeof raw?.id === 'string' ? raw.id : '', errors: problems });
        continue;
      }
      if (seen.has(value.id)) {
        errors.push({ id: value.id, errors: [createMessage('mcp.error.idDuplicate', { id: value.id })] });
        continue;
      }
      seen.add(value.id);
      servers.push(value);
    }

    const closed = [];
    for (const [id, connection] of connections) {
      const next = servers.find((server) => server.id === id);
      if (!next || JSON.stringify(next) !== JSON.stringify(connection.config)) {
        closed.push(disconnect(id));
      }
    }
    // Abgeräumt wird im Hintergrund: der Aufrufer wartet auf eine
    // Konfigurationsänderung, nicht auf das Sterben alter Prozesse.
    Promise.allSettled(closed).catch(() => {});

    for (const server of servers) {
      if (!connections.has(server.id)) connections.set(server.id, blank(server));
      else connections.get(server.id).config = server;
    }
    for (const id of [...connections.keys()]) {
      if (!seen.has(id)) connections.delete(id);
    }

    return { ok: errors.length === 0, servers, errors };
  }

  /** Holt den Tool-Katalog, über `nextCursor` hinweg. */
  async function fetchTools(transport, serverId) {
    const tools = [];
    let cursor;
    // Schleifengrenze statt `while (cursor)`: ein Server, der immer denselben
    // Cursor zurückgibt, soll uns nicht endlos beschäftigen.
    for (let page = 0; page < 20; page += 1) {
      const result = await transport.request('tools/list', cursor ? { cursor } : {}, {
        timeoutMs: limits.REQUEST_MS,
      });
      tools.push(...normalizeMcpToolCatalog(result?.tools, serverId));
      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : '';
      if (!next || next === cursor || tools.length >= MCP_LIMITS.MAX_TOOLS) break;
      cursor = next;
    }
    return tools.slice(0, MCP_LIMITS.MAX_TOOLS);
  }

  /** Fehlerzustand festhalten und den Prozess loswerden. */
  function markFailed(connection, error) {
    connection.state = MCP_CONNECTION_STATES.FAILED;
    connection.error = error?.userMessage || messageOf(error, '') || createMessage('mcp.connection.unreachable');
    connection.modelError = messageOf(error, 'The MCP server is not reachable.');
    connection.stderr = typeof error?.stderr === 'string' ? error.stderr : connection.transport?.stderrText?.() || '';
    connection.tools = [];
    const transport = connection.transport;
    connection.transport = null;
    transport?.close?.().catch(() => {});
  }

  async function handshake(connection) {
    const transport = createTransport({
      config: connection.config,
      spawn,
      baseEnv: await baseEnv(),
      platform,
    });
    connection.transport = transport;

    // Stirbt der Server später von selbst, darf sein Katalog nicht stehen
    // bleiben — sonst bietet das Modell Tools an, die niemand mehr ausführt.
    transport.onExit(({ reason, reasonMessage, stderr, expected }) => {
      if (connection.transport !== transport) return;
      connection.transport = null;
      connection.tools = [];
      if (expected) {
        connection.state = MCP_CONNECTION_STATES.STOPPED;
        return;
      }
      connection.state = MCP_CONNECTION_STATES.FAILED;
      connection.error = createMessage('mcp.transport.exited', {
        label: connection.config.label,
        reason: reasonMessage || reason,
      });
      connection.modelError = `The MCP server “${connection.config.label}” exited unexpectedly (${reason}).`;
      connection.stderr = stderr || '';
    });

    await transport.start();
    const result = await transport.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientInfo.name, version: clientInfo.version },
      },
      { timeoutMs: limits.HANDSHAKE_MS },
    );

    // Der Server bestimmt die Version, auf die man sich einigt. Wir
    // protokollieren sie nur — ablehnen würde im MVP mehr kaputtmachen als
    // helfen, solange wir ohnehin nur `tools` benutzen.
    connection.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : '';
    connection.serverName = String(result?.serverInfo?.name || '');
    connection.serverVersion = String(result?.serverInfo?.version || '');

    transport.notify('notifications/initialized', {});

    if (!result?.capabilities || typeof result.capabilities !== 'object' || !result.capabilities.tools) {
      // Kein Fehler, aber auch nichts zu holen: ein Server ohne `tools` ist
      // für uns leer, statt in einem scheiternden tools/list zu enden.
      connection.tools = [];
      connection.state = MCP_CONNECTION_STATES.READY;
      connection.error = '';
      connection.modelError = '';
      return;
    }

    connection.tools = await fetchTools(transport, connection.config.id);
    connection.state = MCP_CONNECTION_STATES.READY;
    connection.error = '';
    connection.modelError = '';
    connection.stderr = '';

    try {
      await rememberTools(connection.config.id, connection.tools.map((tool) => tool.name));
    } catch {
      // Der Katalog ist Komfort, kein Vertrag: schlaegt das Schreiben fehl,
      // laeuft die Verbindung trotzdem.
    }
  }

  /**
   * Stellt sicher, dass ein Server verbunden ist. Mehrfache Aufrufe teilen
   * sich denselben Startvorgang; ein gescheiterter Start wird nicht von
   * allein wiederholt — sonst stürbe bei jedem Tool-Aufruf ein Prozess neu.
   */
  function ensureConnected(id) {
    const connection = connections.get(id);
    if (!connection) return Promise.resolve(null);
    if (connection.state === MCP_CONNECTION_STATES.READY && connection.transport?.isAlive()) {
      return Promise.resolve(connection);
    }
    if (connection.starting) return connection.starting;
    if (connection.state === MCP_CONNECTION_STATES.FAILED) return Promise.resolve(connection);
    if (!connection.config.enabled) return Promise.resolve(connection);

    connection.state = MCP_CONNECTION_STATES.STARTING;
    connection.error = '';
    connection.modelError = '';
    connection.starting = handshake(connection)
      .catch((error) => markFailed(connection, error))
      .then(() => {
        connection.starting = null;
        return connection;
      });
    return connection.starting;
  }

  /** Verbindet einen Server neu, auch nach einem Fehlschlag. */
  async function connect(id) {
    const connection = connections.get(id);
    if (!connection) return null;
    if (connection.starting) await connection.starting;
    if (connection.transport) await disconnect(id);
    connection.state = MCP_CONNECTION_STATES.IDLE;
    connection.error = '';
    connection.modelError = '';
    await ensureConnected(id);
    return describeOne(id);
  }

  async function disconnect(id) {
    const connection = connections.get(id);
    if (!connection) return;
    const transport = connection.transport;
    connection.transport = null;
    connection.tools = [];
    connection.state = MCP_CONNECTION_STATES.STOPPED;
    if (transport) await transport.close().catch(() => {});
  }

  /** Tools aller eingeschalteten Server; ein kaputter Server bremst die anderen nicht. */
  async function listTools() {
    await Promise.allSettled(
      [...connections.keys()].map((id) => (connections.get(id).config.enabled ? ensureConnected(id) : null)),
    );
    const out = [];
    for (const connection of connections.values()) {
      if (connection.state !== MCP_CONNECTION_STATES.READY) continue;
      const disabled = new Set(connection.config.disabledTools);
      for (const tool of connection.tools) {
        if (!disabled.has(tool.name)) out.push(tool);
      }
    }
    return out;
  }

  /**
   * Ruft ein Tool auf. Ein fachlicher Fehler des Servers (`isError`) ist ein
   * Ergebnis, kein Wurf — das Modell soll ihn lesen können. Geworfen wird
   * nur, was den Aufruf gar nicht erst zustande kommen lässt.
   */
  async function callTool({ serverId, name, args } = {}, { signal, timeoutMs = limits.REQUEST_MS } = {}) {
    const connection = connections.get(serverId);
    // Only the model reads these: they end up in the tool result (#338).
    if (!connection) throw new Error(`Unknown MCP server “${serverId}”.`);
    if (!connection.config.enabled) throw new Error(`The MCP server “${connection.config.label}” is switched off.`);
    if (connection.config.disabledTools.includes(name)) {
      throw new Error(`The tool “${name}” is deselected for “${connection.config.label}”.`);
    }

    await ensureConnected(serverId);
    if (connection.state !== MCP_CONNECTION_STATES.READY || !connection.transport) {
      throw new Error(connection.modelError || `The MCP server “${connection.config.label}” is not connected.`);
    }

    const result = await connection.transport.request(
      'tools/call',
      { name, arguments: args && typeof args === 'object' ? args : {} },
      { timeoutMs, signal },
    );
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
      ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  function describeOne(id) {
    const connection = connections.get(id);
    if (!connection) return null;
    return createMcpConnectionStatus({
      serverId: connection.config.id,
      label: connection.config.label,
      state: connection.state,
      toolCount: connection.tools.length,
      toolNames: connection.tools.map((tool) => tool.name),
      serverName: connection.serverName,
      serverVersion: connection.serverVersion,
      protocolVersion: connection.protocolVersion,
      error: connection.error,
      stderr: connection.stderr,
    });
  }

  function describeConnections() {
    return [...connections.keys()].map((id) => describeOne(id));
  }

  /**
   * Beim App-Ende: alle Prozesse weg. Wird bewusst über alle Server parallel
   * gefahren und wartet auf jeden — ein zurückbleibender MCP-Server hielte
   * sonst ein Terminal oder eine Netzverbindung offen.
   */
  async function shutdown() {
    await Promise.allSettled([...connections.keys()].map((id) => disconnect(id)));
  }

  /**
   * Synchrones Gegenstueck zu `shutdown()` fuer das App-Ende: `will-quit`
   * wartet auf nichts, und ein `detached` gestarteter Kindprozess wuerde die
   * App sonst ueberleben. Hier wird deshalb sofort hart beendet.
   */
  function disposeSync() {
    for (const connection of connections.values()) {
      const transport = connection.transport;
      connection.transport = null;
      connection.tools = [];
      connection.state = MCP_CONNECTION_STATES.STOPPED;
      transport?.kill?.();
    }
  }

  return {
    setServers,
    listTools,
    callTool,
    connect,
    disconnect,
    describeConnections,
    describeConnection: describeOne,
    shutdown,
    disposeSync,
  };
}

module.exports = { createMcpService };
