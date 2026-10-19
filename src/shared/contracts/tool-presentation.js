/**
 * How a tool presents itself to the user (#1008, AR-33).
 *
 * What a tool is — its schema, risk class, preview, display line and
 * category — is decided once, in its descriptor: the registry definition in
 * `src/application/tools/`. The renderer never looks a tool up by its name. It gets
 * the few facts it has to show as fields of the payloads it already receives:
 *
 *  - `category` on every tool trace entry and tool line (icon and grouping),
 *  - `presentation` on the approval card (headline verb and warning),
 *  - `externalService` on the rows of the security page,
 *  - `tool` on the state of the execution switches.
 *
 * A second front end reads the same fields and needs no table of tool names.
 */
'use strict';

const { isToolCategory, TOOL_CATEGORIES } = require('./tool-categories');

/**
 * The verb an approval card puts in its headline when the risk class alone
 * would say it wrong: an image is generated, not "sent to an external
 * service" (#85), and a command runs in a named shell (#102).
 */
const TOOL_APPROVAL_VERBS = Object.freeze({
  IMAGE: 'image',
  SHELL: 'shell',
});

/**
 * The warning an approval card carries for the tool (concept §6):
 *  - `shell`: a command crosses the workspace boundary unless it is isolated,
 *  - `python`: a program does too, said only when a sandbox was expected,
 *  - `overwrite`: an existing file is replaced as a whole.
 */
const TOOL_APPROVAL_WARNINGS = Object.freeze({
  SHELL: 'shell',
  PYTHON: 'python',
  OVERWRITE: 'overwrite',
});

/** The outside service a tool talks to, as the Security page names it (#448). */
const TOOL_EXTERNAL_SERVICES = Object.freeze({
  WEB_SEARCH: 'web-search',
  FETCH_URL: 'fetch-url',
  IMAGE_GENERATION: 'image-generation',
});

/**
 * What kind of process an execution tool starts (#329). Decides the sandbox,
 * the suggested domains and which warning the card carries; read in main only.
 */
const TOOL_EXECUTION_KINDS = Object.freeze({
  SHELL: 'shell',
  PYTHON: 'python',
});

/** @type {Set<unknown>} */
const VERBS = new Set(Object.values(TOOL_APPROVAL_VERBS));
/** @type {Set<unknown>} */
const WARNINGS = new Set(Object.values(TOOL_APPROVAL_WARNINGS));
/** @type {Set<unknown>} */
const EXTERNAL_SERVICES = new Set(Object.values(TOOL_EXTERNAL_SERVICES));

/** @param {unknown} value */
function isToolApprovalVerb(value) {
  return VERBS.has(value);
}

/** @param {unknown} value */
function isToolApprovalWarning(value) {
  return WARNINGS.has(value);
}

/** @param {unknown} value */
function isToolExternalService(value) {
  return EXTERNAL_SERVICES.has(value);
}

/**
 * @typedef {{ category: string, verb?: string, warning?: string }} ToolPresentation
 * @typedef {{
 *   category?: string,
 *   verb?: string,
 *   warning?: string,
 *   approval?: { verb?: string, warning?: string },
 * }} ToolPresentationInput
 */

/**
 * The presentation of a tool as it travels to the renderer, from a
 * descriptor (verb and warning under `approval`) or from a presentation made
 * before (flat). Unknown values are dropped rather than passed on; the
 * category falls back to `other`, so a card for a tool without a descriptor
 * (an MCP tool) still has one.
 *
 * @param {ToolPresentationInput|null|undefined} raw
 * @returns {ToolPresentation}
 */
function normalizeToolPresentation(raw) {
  /** @type {ToolPresentation} */
  const out = { category: isToolCategory(raw?.category) ? raw.category : TOOL_CATEGORIES.OTHER };
  const nested = raw?.approval && typeof raw.approval === 'object' ? raw.approval : null;
  const verb = nested ? nested.verb : raw?.verb;
  const warning = nested ? nested.warning : raw?.warning;
  if (isToolApprovalVerb(verb)) out.verb = verb;
  if (isToolApprovalWarning(warning)) out.warning = warning;
  return out;
}

module.exports = {
  TOOL_APPROVAL_VERBS,
  TOOL_APPROVAL_WARNINGS,
  TOOL_EXTERNAL_SERVICES,
  TOOL_EXECUTION_KINDS,
  isToolApprovalVerb,
  isToolApprovalWarning,
  isToolExternalService,
  normalizeToolPresentation,
};
