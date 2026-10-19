// The tool descriptor (#1008, AR-33): everything the app knows about a
// built-in tool sits on its registry definition, and the renderer reads DTO
// fields instead of tool names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createWorkspaceToolRegistry, createToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { assertCompleteDescriptor, descriptorProblems } = require('../src/application/tools/tool-descriptor');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { normalizeSessionForLoad, sanitizeChatMessagesForStore } = require('../src/main/services/chat-history-normalization');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
const { normalizeToolPresentation, TOOL_APPROVAL_VERBS, TOOL_APPROVAL_WARNINGS } = require('../src/shared/contracts/tool-presentation');
const { TOOL_CATEGORIES, toolCategoryForEntry } = require('../src/shared/contracts/tool-categories');
const { lineKeysOf } = require('../src/shared/presentation/tool-display');
const { MESSAGES } = require('../src/shared/i18n');

const definitions = () => createWorkspaceToolRegistry({ fsService: {} }).listDefinitions();

test('every built-in tool carries a complete descriptor', () => {
  const all = definitions();
  assert.ok(all.length >= 23, `the built-in tools are all there (${all.length})`);
  const incomplete = all
    .map((definition) => ({ name: definition.name, problems: descriptorProblems(definition) }))
    .filter((entry) => entry.problems.length > 0);
  assert.deepEqual(incomplete, [], 'a tool without a complete descriptor');
  // Its line exists in both languages, so the log never shows a raw key.
  for (const definition of all) {
    for (const key of lineKeysOf(definition.display)) {
      assert.ok(MESSAGES.en[key] && MESSAGES.de[key], `${definition.name}: ${key}`);
    }
  }
});

test('a tool that lacks a descriptor field does not register', () => {
  const [template] = definitions();
  for (const field of ['category', 'configGroup', 'display']) {
    const broken = { ...template };
    delete broken[field];
    assert.throws(() => assertCompleteDescriptor(broken), new RegExp(`incomplete descriptor \\(${field}\\)`), field);
  }
  assert.throws(() => assertCompleteDescriptor({ ...template, display: { key: 'tools.line.x', target: 'nonsense' } }), /display/);
  assert.throws(() => assertCompleteDescriptor({ ...template, approval: { verb: 'delete-everything' } }), /approval/);
  assert.throws(() => assertCompleteDescriptor({ ...template, preview: 'html' }), /preview/);
  assert.throws(() => assertCompleteDescriptor({ ...template, execution: 'ruby' }), /execution/);
  // The generic registry stays open for MCP tools: they get the defaults.
  const registry = createToolRegistry([{
    name: 'mcp__srv__x', description: 'x', parameters: { type: 'object' }, handler: async () => '', riskClass: 'read',
  }]);
  assert.equal(registry.getDefinition('mcp__srv__x').category, TOOL_CATEGORIES.OTHER);
});

/**
 * The renderer names no tool (#1008): what a card, a line or a page shows of
 * a tool comes as a DTO field. A tool's name in a string literal anywhere in
 * `src/renderer` is a second place that knows about that tool.
 */
test('no tool name is written into the renderer', () => {
  const names = definitions().map((definition) => definition.name);
  const pattern = new RegExp(`(['"\`])(${names.join('|')})\\1`, 'g');
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Generated bundles of the shared layer and third-party code are not the renderer's own.
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor' && entry.name !== 'generated') walk(full);
      } else if (/\.(m?js)$/.test(entry.name)) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, index) => {
          for (const match of line.matchAll(pattern)) {
            hits.push(`${path.relative(root, full)}:${index + 1} ${match[0]}`);
          }
        });
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], 'a tool name in the renderer — send it as a DTO field from the descriptor instead');
});

test('the adapter writes the descriptor\'s category on every trace entry', () => {
  const registry = createWorkspaceToolRegistry({ fsService: {} });
  const adapter = createWorkspaceToolAdapter(registry);
  assert.equal(adapter.buildTraceEntry('read_file_text', { relative_path: 'a.js' }).category, TOOL_CATEGORIES.READ);
  assert.equal(adapter.buildTraceEntry('generate_image', { relative_path: 'a.png' }).category, TOOL_CATEGORIES.IMAGE);
  assert.equal(adapter.buildTraceEntry('mcp__srv__x', {}).category, TOOL_CATEGORIES.OTHER);
  // The skill is combined where the entry is shown: the engine may learn it later (#427).
  const write = adapter.buildTraceEntry('edit_file', { relative_path: '.agents/skills/notes/SKILL.md' });
  assert.equal(write.category, TOOL_CATEGORIES.WRITE);
  assert.equal(toolCategoryForEntry(write), TOOL_CATEGORIES.SKILL_WRITE);
  assert.equal(adapter.formatDisplayLine({ tool: 'shell_execute', args: { command: 'ls' } }, 'start', 'en'), 'Running command “ls” …');
});

test('a chat stored before the descriptor gets its categories on the way out', () => {
  const registry = createWorkspaceToolRegistry({ fsService: {} });
  const toolCategoryOf = (name) => registry.getDefinition(name)?.category || null;
  const session = {
    id: 'c1',
    workspaceRoot: '/ws',
    title: 't',
    updatedAt: 1,
    messages: [{
      role: 'assistant',
      content: 'done',
      toolTrace: [
        { line: 'File a.js read', tool: 'read_file_text' },
        { line: 'Image a.png generated', tool: 'generate_image' },
        { line: 'srv · x run', tool: 'mcp__srv__x' },
        { line: 'File b read', tool: 'read_file_text', category: 'list' },
        'Older than #60',
      ],
    }],
  };
  const [message] = normalizeSessionForLoad(session, { toolCategoryOf }).messages;
  assert.deepEqual(message.toolTrace.map((entry) => entry.category), ['read', 'image', undefined, 'list', undefined]);
  // Stored as it came: a category that was written stays, none is invented.
  const [stored] = sanitizeChatMessagesForStore(session.messages);
  assert.deepEqual(stored.toolTrace.map((entry) => entry.category), [undefined, undefined, undefined, 'list', undefined]);
});

test('the approval card gets verb and warning from the descriptor, nothing else', () => {
  const descriptorOf = (name) => createWorkspaceToolRegistry({ fsService: {} }).getDefinition(name);
  assert.deepEqual(normalizeToolPresentation(descriptorOf('shell_execute')), {
    category: 'exec', verb: TOOL_APPROVAL_VERBS.SHELL, warning: TOOL_APPROVAL_WARNINGS.SHELL,
  });
  assert.deepEqual(normalizeToolPresentation(descriptorOf('generate_image')), { category: 'image', verb: TOOL_APPROVAL_VERBS.IMAGE });
  assert.deepEqual(normalizeToolPresentation(descriptorOf('write_file_text')), { category: 'write', warning: TOOL_APPROVAL_WARNINGS.OVERWRITE });
  assert.deepEqual(normalizeToolPresentation(descriptorOf('read_file_text')), { category: 'read' });

  const dto = createToolApprovalRequestDto({
    requestId: 'r', tool: 'x', riskClasses: ['execute'], targets: [],
    presentation: { category: 'exec', verb: 'shell', warning: 'rm-rf', handler: () => {} },
  });
  assert.deepEqual(dto.presentation, { category: 'exec', verb: 'shell' }, 'unknown values are dropped');
  assert.equal('presentation' in createToolApprovalRequestDto({ requestId: 'r', tool: 'x' }), false);
});

test('settings and security read their tool facts from the descriptor', () => {
  const registry = createWorkspaceToolRegistry({ fsService: {} });
  const execution = Object.fromEntries(registry.listCatalog({ locale: 'en' }).map((tool) => [tool.name, tool.execution]));
  assert.equal(execution.shell_execute, 'shell');
  assert.equal(execution.run_python, 'python');
  assert.equal(execution.read_file_text, undefined);
  const external = Object.fromEntries(registry.listRiskCatalog({ locale: 'en' }).map((tool) => [tool.name, tool.externalService]));
  assert.equal(external.web_search, 'web-search');
  assert.equal(external.fetch_url, 'fetch-url');
  assert.equal(external.generate_image, 'image-generation');
  assert.equal(external.read_file_text, null);
  const groups = Object.fromEntries(registry.describeOffers().map((tool) => [tool.name, tool.group]));
  assert.equal(groups.web_search, 'web');
  assert.equal(groups.search_manual, 'read');
  assert.equal(groups.generate_image, 'image');
});
