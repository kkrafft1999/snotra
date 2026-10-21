'use strict';

/**
 * The tool descriptor (#1008, AR-33).
 *
 * Everything the app knows about one built-in tool sits on its registry
 * definition — in `workspace-tool-registry.js`, or in a module of its own
 * such as `generate-image-tool.js`. The registry, the planner, the ToolPort
 * adapter and the tool lines read it from there; the renderer gets what it
 * shows as DTO fields (`src/shared/contracts/tool-presentation.js`). Adding a
 * tool means writing one definition, not touching every file that names one.
 *
 * Besides name, texts, `parameters`, `handler` and `riskClass` (checked by the
 * registry itself), a built-in definition carries:
 *
 * | Field | Required | Read by | Meaning |
 * | --- | --- | --- | --- |
 * | `category` | yes | adapter → trace entry → renderer | icon and grouping in the tool log (`TOOL_CATEGORIES`) |
 * | `configGroup` | yes | registry → configuration view | the group in the composer indicator (`CONFIG_TOOL_GROUPS`) |
 * | `display` | yes | adapter → `tool-display.js` | the line in the chat: `{ key, target }` (`TOOL_LINE_TARGETS`) |
 * | `preview` | no | planner | what the approval card shows of the call (`TOOL_PREVIEW_KINDS`) |
 * | `approval` | no | planner → approval DTO → renderer | `{ verb, warning }` for the card's headline and warning |
 * | `execution` | no | planner, registry | the process it starts (`TOOL_EXECUTION_KINDS`): sandbox, domains |
 * | `externalService` | no | registry → Security page | the outside service it talks to (`TOOL_EXTERNAL_SERVICES`) |
 * | `setupPage` | no | registry | where an unconfigured tool is set up: `tools` or (default) `security` |
 * | `contentScan` | no | adapter | how its output is checked for sensitive content (`TOOL_CONTENT_SCANS`) |
 * | `broadListing` | no | adapter | lists many entries: sensitive ones are left out rather than asked about |
 * | `fileEvents` | no | adapter | which file it reports to the tree and the change list (`TOOL_FILE_EVENTS`) |
 *
 * `assertCompleteDescriptor` holds a built-in definition to this; a tool that
 * misses a field does not register. MCP tools are described by their server
 * and get the defaults (`other`, a line naming server and tool).
 */

/**
 * A tool definition as a bag of fields: each one is checked here before it is
 * trusted, so the values stay `any` until `descriptorProblems` has looked.
 * @typedef {{ name?: string, [field: string]: any }} ToolDefinitionFields
 */

const { isToolCategory } = require('../../shared/contracts/tool-categories');
const { isConfigToolGroup } = require('../../shared/contracts/chat-configuration');
const {
  TOOL_EXECUTION_KINDS,
  isToolApprovalVerb,
  isToolApprovalWarning,
  isToolExternalService,
} = require('../../shared/contracts/tool-presentation');
const { isToolLineDisplay } = require('../../shared/presentation/tool-display');

/** What the approval card shows of a call; the planner builds one per kind. */
const TOOL_PREVIEW_KINDS = Object.freeze({
  /** The whole new content of a file. */
  TEXT: 'text',
  /** One replacement, old and new. */
  REPLACE: 'replace',
  /** A patch, or a list of replacements. */
  DIFF: 'diff',
  /** A program, its input and arguments. */
  CODE: 'code',
  /** A command, its shell, working folder and input. */
  SHELL: 'shell',
  /** A prompt that goes out and is paid for (#85). */
  PROMPT: 'prompt',
  /** A sentence that goes along with every request from now on (#166). */
  MEMORY: 'memory',
});

/** How the adapter checks what a reading tool returns (concept §4). */
const TOOL_CONTENT_SCANS = Object.freeze({
  /** The output, and the whole source file behind it. */
  SOURCE: 'source',
  /** The output only: it spans many files. */
  OUTPUT: 'output',
  /** The output and the decoded text — the source is compressed or binary (#42). */
  DECODED: 'decoded',
});

/** Which file a call reports to the tree and the change list (#158, #347). */
const TOOL_FILE_EVENTS = Object.freeze({
  /** One file of the workspace read, from `relative_path`. */
  READ: 'read',
  /** Files written, as the result names them. */
  WRITE: 'write',
  /** One file written, as the call names it — the result does not. */
  WRITE_ARGS: 'write-args',
});

/** @type {Set<unknown>} */
const SETUP_PAGES = new Set(['tools', 'security']);

const isOneOf = (/** @type {Record<string, unknown>} */ table) => (/** @type {unknown} */ value) =>
  Object.values(table).includes(value);
const OPTIONAL_FIELDS = Object.freeze({
  preview: isOneOf(TOOL_PREVIEW_KINDS),
  execution: isOneOf(TOOL_EXECUTION_KINDS),
  externalService: isToolExternalService,
  setupPage: (/** @type {unknown} */ value) => SETUP_PAGES.has(value),
  contentScan: isOneOf(TOOL_CONTENT_SCANS),
  broadListing: (/** @type {unknown} */ value) => value === true,
  fileEvents: isOneOf(TOOL_FILE_EVENTS),
});

/**
 * What is missing or wrong in a built-in tool's descriptor, as a list of
 * field names; empty when it is complete.
 *
 * @param {ToolDefinitionFields | null | undefined} definition
 */
function descriptorProblems(definition) {
  /** @type {string[]} */
  const problems = [];
  // Set on purpose, `other` included: the configuration tools have no
  // category of their own in the log (#773).
  if (!isToolCategory(definition?.category)) problems.push('category');
  if (!isConfigToolGroup(definition?.configGroup)) problems.push('configGroup');
  if (!isToolLineDisplay(definition?.display)) problems.push('display');
  const approval = definition?.approval;
  if (approval !== undefined) {
    const valid = approval && typeof approval === 'object'
      && (approval.verb === undefined || isToolApprovalVerb(approval.verb))
      && (approval.warning === undefined || isToolApprovalWarning(approval.warning));
    if (!valid) problems.push('approval');
  }
  for (const [field, isValid] of Object.entries(OPTIONAL_FIELDS)) {
    if (definition?.[field] !== undefined && !isValid(definition[field])) problems.push(field);
  }
  return problems;
}

/**
 * Throws unless a built-in tool's descriptor is complete (#1008).
 *
 * @template {ToolDefinitionFields} T
 * @param {T} definition
 * @returns {T}
 */
function assertCompleteDescriptor(definition) {
  const problems = descriptorProblems(definition);
  if (problems.length > 0) {
    throw new TypeError(`Tool ${definition?.name || '?'}: incomplete descriptor (${problems.join(', ')}).`);
  }
  return definition;
}

module.exports = {
  TOOL_PREVIEW_KINDS,
  TOOL_CONTENT_SCANS,
  TOOL_FILE_EVENTS,
  descriptorProblems,
  assertCompleteDescriptor,
};
