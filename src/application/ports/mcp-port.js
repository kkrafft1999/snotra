/**
 * MCP-Port: Tools externer Server, ohne dass der Core Prozesse, Transporte
 * oder JSON-RPC kennt (Issue #106, Teil von #62).
 *
 * Nach dem Muster von skill-port.js schmal gehalten: auflisten, aufrufen,
 * Zustand beschreiben. Genau das ist auch die Naht, an der später ein
 * SDK-gestützter Adapter den eigenen stdio-Client ersetzen könnte, ohne dass
 * am Core eine Zeile anders wird — deshalb taucht hier nichts aus dem
 * Protokoll auf außer den Begriffen, die MCP dem Nutzer ohnehin zeigt.
 *
 * Die Anbindung an die Tool-Registry (Namensraum, Risikoklasse, Freigaben)
 * ist ausdrücklich nicht Teil dieses Ports, sondern die nächste Scheibe (#107).
 */

/**
 * @typedef {Object} McpToolDescriptor
 * @property {string} serverId — Kennung des Servers, von dem das Tool stammt
 * @property {string} name — Name wie vom Server gemeldet, ohne Namensraum
 * @property {string} title — Anzeigename, oft leer
 * @property {string} description
 * @property {Object} inputSchema — JSON Schema, unverändert vom Server
 */

/**
 * Ergebnis eines `tools/call`. Bleibt nah am Protokoll, weil #107 daraus das
 * Tool-Ergebnis für das Modell baut und dabei nichts erfinden soll.
 * @typedef {Object} McpToolResult
 * @property {Array<{ type: string, text?: string, [key: string]: unknown }>} content
 * @property {boolean} isError — der Server meldet einen fachlichen Fehler
 * @property {Object} [structuredContent]
 */

/**
 * @typedef {Object} McpConnectionStatus
 * @property {string} serverId
 * @property {string} label
 * @property {string} state — Wert aus MCP_CONNECTION_STATES
 * @property {number} toolCount
 * @property {string} serverName
 * @property {string} serverVersion
 * @property {string} protocolVersion
 * @property {string} error — leer, solange nichts schiefging
 * @property {string} stderr — Auszug der Serverausgabe, erklärt `error`
 */

/**
 * @typedef {Object} McpPort
 * @property {() => Promise<McpToolDescriptor[]>} listTools — Tools aller
 *   verbundenen Server; ein Server, der nicht startet, liefert keine Tools,
 *   lässt die übrigen aber unberührt
 * @property {(call: { serverId: string, name: string, args?: Object },
 *   options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<McpToolResult>} callTool
 * @property {() => McpConnectionStatus[]} describeConnections — synchron, weil
 *   die Statusanzeige nicht auf einen hängenden Server warten darf
 */

module.exports = {};
