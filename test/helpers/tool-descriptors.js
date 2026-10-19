'use strict';

/**
 * The descriptors of the built-in tools, for tests (#1008).
 *
 * What a tool's line says, which category it has and what the adapter does
 * with its output all come from its registry definition. A test that stubs the
 * registry spreads `descriptorOf(name)` into its stub, and a test of the line
 * formatter passes the tool's `display` — the same values the app uses, not a
 * copy that could drift from them.
 */

const { createWorkspaceToolRegistry } = require('../../src/main/tools/workspace-tool-registry');
const { formatToolDisplayLine, summarizeToolCall } = require('../../src/shared/presentation/tool-display');

const DESCRIPTOR_FIELDS = Object.freeze([
  'category', 'configGroup', 'display', 'preview', 'approval', 'execution', 'externalService',
  'setupPage', 'contentScan', 'broadListing', 'fileEvents', 'mayOverwrite',
]);

let registry = null;
function builtIn() {
  registry ||= createWorkspaceToolRegistry({ fsService: {} });
  return registry;
}

/** The descriptor fields of a built-in tool; throws for a name that is none. */
function descriptorOf(name) {
  const definition = builtIn().getDefinition(name);
  if (!definition) throw new Error(`No built-in tool named ${name}`);
  const out = {};
  for (const field of DESCRIPTOR_FIELDS) {
    if (definition[field] !== undefined) out[field] = definition[field];
  }
  return out;
}

/** The line descriptor of a tool, or null when it is no built-in one (MCP, unknown). */
function displayOf(name) {
  return builtIn().getDefinition(name)?.display || null;
}

/** `formatToolDisplayLine` as the adapter calls it: with the tool's own display. */
function formatLine(entry, phase, locale) {
  return formatToolDisplayLine(entry, phase, locale, typeof entry === 'object' ? displayOf(entry?.tool) : null);
}

/** `summarizeToolCall` with the tool's own display. */
function summarize(name, args, phase, locale) {
  return summarizeToolCall(name, args, phase, locale, displayOf(name));
}

/**
 * A registry stub that knows the built-in descriptors: `getDefinition` answers
 * with the tool's descriptor (and its risk class) unless the stub has its own.
 */
function withDescriptors(stub = {}) {
  return {
    getDefinition(name) {
      const definition = builtIn().getDefinition(name);
      return definition ? { name, riskClass: definition.riskClass, ...descriptorOf(name) } : null;
    },
    ...stub,
  };
}

module.exports = { descriptorOf, displayOf, formatLine, summarize, withDescriptors };
