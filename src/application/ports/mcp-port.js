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
 * The binding to the tool registry (namespace, risk class, approvals) is not
 * part of this port; it lives in `main/adapters/mcp-adapter.js` (#107).
 */

/**
 * @typedef {Object} McpToolDescriptor
 * @property {string} serverId — Kennung des Servers, von dem das Tool stammt
 * @property {string} name — Name wie vom Server gemeldet, ohne Namensraum
 * @property {string} title — Anzeigename, oft leer
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema — JSON Schema vom Server, bis auf die
 *   entfernten `title`-Annotationen unverändert (#185)
 * @property {{ destructiveHint: boolean }} annotations — nur, was die Einstufung verschärfen kann
 */

/**
 * Ergebnis eines `tools/call`. Bleibt nah am Protokoll, weil #107 daraus das
 * Tool-Ergebnis für das Modell baut und dabei nichts erfinden soll.
 * @typedef {Object} McpToolResult
 * @property {Array<{ type: string, text?: string, [key: string]: unknown }>} content
 * @property {boolean} isError — der Server meldet einen fachlichen Fehler
 * @property {unknown} [structuredContent]
 */

/**
 * Statuszeile einer Verbindung; the fields are described with the contract
 * (`shared/contracts/mcp.js`). `error` is empty as long as nothing went
 * wrong, and a catalogue message for the sentences Snotra says itself (#338).
 *
 * @typedef {import('../../shared/contracts/mcp').McpConnectionStatus} McpConnectionStatus
 */

/**
 * @typedef {Object} McpPort
 * @property {() => Promise<McpToolDescriptor[]>} listTools — Tools aller
 *   verbundenen Server; ein Server, der nicht startet, liefert keine Tools,
 *   lässt die übrigen aber unberührt
 * @property {(call: { serverId: string, name: string, args?: Record<string, unknown> },
 *   options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<McpToolResult>} callTool
 * @property {() => McpConnectionStatus[]} describeConnections — synchron, weil
 *   die Statusanzeige nicht auf einen hängenden Server warten darf
 */

module.exports = {};
