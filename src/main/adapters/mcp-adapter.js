'use strict';

/**
 * MCP-Tools in die Tool-Registry (Issue #107, Teil von #62).
 *
 * Der Adapter ist die Uebersetzungsschicht: aus den Tool-Beschreibungen
 * fremder Server werden Registry-Definitionen, aus einem Modell-Aufruf wird
 * ein `tools/call`. Alles, was danach kommt — Planung, Freigabe, Tool-Log —
 * ist dasselbe wie bei jedem eingebauten Tool; genau das ist der Zweck.
 *
 * Drei Dinge, die hier bewusst so und nicht anders sind:
 *
 *  1. **Namensraum.** Tools erreichen das Modell als
 *     `mcp__<server>__<tool>`. Ein fremdes `read_file` kann damit nie das
 *     eingebaute verdecken.
 *  2. **Risikoklassen.** Immer `execute` **und** `external`, die Annotations
 *     des Servers duerfen nur verschaerfen. Ein MCP-Tool ist fremder Code mit
 *     unbekannter Wirkung, und wer eingeschraenkt wird, soll nicht selbst
 *     bestimmen, wie streng.
 *  3. **Fehler sind Ergebnisse.** Ein toter oder nicht startbarer Server
 *     liefert eine Fehlermeldung als Tool-Ergebnis, keinen Wurf. Der Chat
 *     laeuft weiter, das Modell kann die Meldung lesen und darauf reagieren.
 */

const {
  fitsMcpToolNameLimit,
  mcpRiskClassesFor,
  parseQualifiedMcpToolName,
  qualifiedMcpToolName,
} = require('../../shared/contracts/mcp');

/** Obergrenze fuer das, was ein MCP-Tool ins Kontextfenster schreiben darf. */
const MAX_RESULT_CHARS = 100_000;

/**
 * Macht aus den Inhaltsbloecken einer MCP-Antwort Text fuer das Modell.
 * Nicht-Text (Bilder, eingebettete Ressourcen) wird benannt statt eingebettet:
 * Bild-Anhaenge aus Tool-Ergebnissen sind ein eigenes Thema (#84/#85), und ein
 * base64-Block im Tool-Ergebnis waere ein stiller Kontextfresser.
 */
function renderContent(content) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'resource' && typeof block.resource?.text === 'string') {
      parts.push(block.resource.text);
      continue;
    }
    parts.push(`[Inhalt vom Typ „${String(block.type || 'unbekannt')}" wird nicht unterstützt]`);
  }
  const text = parts.join('\n');
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_RESULT_CHARS)}\n… [Ausgabe gekürzt]`, truncated: true };
}

/**
 * Beschreibung fuer das Modell. Der Server-Label steht vorn, damit das Modell
 * bei mehreren Servern erkennt, wen es da eigentlich fragt.
 *
 * Englisch wie alles im Modell-Kanal (#276) — der Text des Servers bleibt
 * dabei unangetastet, der ist nicht unserer. Die Fassung fuer den Bildschirm
 * entsteht getrennt davon aus `tools.mcp.*` (#291).
 */
/** Erster Satz eines Servertexts — mehr traegt die Zeile in der Liste nicht. */
function firstSentence(text) {
  return String(text ?? '').split(/(?<=[.!?])\s/)[0];
}

function describeTool(tool, serverLabel) {
  const own = tool.description || tool.title || '';
  const origin = `Via the MCP server "${serverLabel}".`;
  return own ? `${origin} ${own}` : `${origin} No description text from the server.`;
}

/**
 * @param {Object} deps
 * @param {Object} deps.mcpService — aus mcp-service.js (Issue #106)
 */
function createMcpAdapter({ mcpService } = {}) {
  // Namen, die wegen der 64-Zeichen-Grenze ausgelassen wurden. Der
  // Settings-Dialog (#109) kann sie spaeter anzeigen; still verschwinden
  // sollen sie nicht.
  let skipped = [];

  async function listTools() {
    if (!mcpService) return [];
    try {
      return await mcpService.listTools();
    } catch {
      // listTools faengt Serverfehler bereits ab; bleibt trotzdem etwas
      // uebrig, ist die richtige Antwort „keine Tools", nicht „kein Chat".
      return [];
    }
  }

  async function callTool(call, options) {
    return mcpService.callTool(call, options);
  }

  function describeConnections() {
    return mcpService ? mcpService.describeConnections() : [];
  }

  /** Was beim letzten Aufbau uebersprungen wurde und warum. */
  function describeSkippedTools() {
    return skipped.map((entry) => ({ ...entry }));
  }

  function toDefinition(tool) {
    const name = qualifiedMcpToolName(tool.serverId, tool.name);
    const status = describeConnections().find((s) => s.serverId === tool.serverId);
    const serverLabel = status?.label || tool.serverId;
    const [riskClass, ...additionalRiskClasses] = mcpRiskClassesFor(tool.annotations);
    const own = tool.description || tool.title || '';

    return {
      name,
      riskClass,
      additionalRiskClasses,
      // Ein MCP-Tool hat keinen Bezug zum geoeffneten Ordner — es ist auch
      // ohne einen nutzbar (wie die Websuche, Issue #96).
      requiresWorkspace: false,
      // Die Planung kann die Ziele eines fremden Tools nicht kennen. Das ist
      // kein Versehen, sondern der Grund fuer die harte Mindesteinstufung.
      targets: () => [],
      // Der Bildschirm bekommt den Rahmen aus dem Katalog, das Modell
      // denselben Rahmen auf Englisch (#291). Getrennt, weil `listCatalog()`
      // in der Sprache der Oberflaeche aufloest und die nie an das Modell darf.
      modelDescription: describeTool(tool, serverLabel),
      descriptionKey: own ? 'tools.mcp.desc' : 'tools.mcp.desc.empty',
      descriptionParams: { server: serverLabel, text: own },
      // Im Systemprompt stand nur der erste Satz — die Liste soll lesbar
      // bleiben; das gilt fuer die Kurzzeile unveraendert weiter.
      shortDescriptionKey: own ? 'tools.mcp.short' : 'tools.mcp.short.empty',
      shortDescriptionParams: { server: serverLabel, text: firstSentence(own) },
      parameters: tool.inputSchema,
      mcp: { serverId: tool.serverId, toolName: tool.name },
      handler: async (args, context = {}) => {
        const parsed = parseQualifiedMcpToolName(name);
        try {
          const result = await callTool(
            { serverId: parsed.serverId, name: parsed.name, args },
            { signal: context.abortSignal, timeoutMs: context.timeoutMs },
          );
          const { text, truncated } = renderContent(result.content);
          const out = { output: text };
          if (result.isError) out.error = 'Der MCP-Server meldet einen Fehler.';
          if (truncated) out.truncated = true;
          if (result.structuredContent !== undefined) out.structured = result.structuredContent;
          return JSON.stringify(out);
        } catch (e) {
          // Hierher kommen Startfehler, Abstuerze, Zeitlimit und Abbruch.
          // Alle werden zum Ergebnis, nicht zum Chat-Abbruch.
          return JSON.stringify({ error: e?.message || 'Der MCP-Aufruf ist fehlgeschlagen.' });
        }
      },
    };
  }

  /**
   * Baut die Registry-Definitionen aus dem aktuellen Katalog. Tools, deren
   * zusammengesetzter Name nicht in die Grenze der Berechtigungsregeln passt,
   * werden ausgelassen — lieber ein fehlendes Tool als eines, auf das eine
   * Deny-Regel nicht mehr zeigt.
   */
  async function buildToolDefinitions() {
    const tools = await listTools();
    const definitions = [];
    const left = [];
    for (const tool of tools) {
      const name = qualifiedMcpToolName(tool.serverId, tool.name);
      if (!fitsMcpToolNameLimit(name)) {
        left.push({ serverId: tool.serverId, name: tool.name, reason: 'Der Tool-Name ist zu lang.' });
        continue;
      }
      definitions.push(toDefinition(tool));
    }
    skipped = left;
    return definitions;
  }

  return {
    listTools,
    callTool,
    describeConnections,
    describeSkippedTools,
    buildToolDefinitions,
  };
}

module.exports = { createMcpAdapter, renderContent, MAX_RESULT_CHARS };
