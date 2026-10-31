'use strict';

/**
 * Snotra's own guess at a chat's kind of task (#1281, concept §4), for when
 * the model gave none: from the tools the chat used and the files they wrote.
 * It answers only when one signal clearly dominates and otherwise leaves the
 * chat unclassified rather than guess. *Planning*, *Organisation* and *Other*
 * are never estimated: no tool tells them apart.
 *
 * @typedef {import('../../shared/contracts/task-kind').TaskKindId} TaskKindId
 */

const WRITE_TOOLS = new Set(['edit_file', 'apply_patch', 'write_file_text']);
const RESEARCH_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'read_file_text',
  'read_file_lines',
  'search_in_files',
  'find_files',
  'list_directory',
  'list_directory_tree',
  'outline_file',
  'stat_path',
  'extract_document_text',
  'search_manual',
  'read_manual_page',
  'list_release_notes',
]);
const READ_TOOLS = new Set(['read_file_text', 'read_file_lines', 'extract_document_text']);

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|ps1|sql|html?|css|scss|vue|svelte|ya?ml|toml|ini|gradle|xml|lua|r|scala|dart)$/i;
const PROSE_FILE = /\.(?:md|markdown|txt|docx?|rtf|odt)$/i;
const TABULAR_FILE = /\.(?:csv|tsv|xlsx?|json)\b/i;
// What a build or test command looks like in the line a shell call left.
const BUILD_OR_TEST = /\b(?:npm|npx|pnpm|yarn|make|cargo|gradlew?|mvn|pytest|tsc|eslint|go\s+(?:build|test|vet)|dotnet|swift\s+(?:build|test)|xcodebuild|jest|vitest)\b/i;

/** How far ahead of the next one a kind has to be. */
const DOMINANCE = 2;

/**
 * @param {unknown} entry
 * @returns {{ tool: string, line: string, paths: string[] }}
 */
function traceStep(entry) {
  if (typeof entry === 'string') return { tool: '', line: entry, paths: [] };
  const fields = entry && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {};
  const changes = Array.isArray(fields.changes) ? fields.changes : [];
  return {
    tool: typeof fields.tool === 'string' ? fields.tool : '',
    line: typeof fields.line === 'string' ? fields.line : '',
    paths: changes
      .map((change) => (change && typeof change === 'object' ? /** @type {Record<string, unknown>} */ (change).relativePath : ''))
      .filter(/** @returns {path is string} */ (path) => typeof path === 'string' && path !== ''),
  };
}

/**
 * The kind the tools of a chat point to, or null when they point nowhere in
 * particular.
 *
 * @param {Array<{ role?: string, toolTrace?: unknown }>} messages  the stored chat's messages
 * @returns {TaskKindId|null}
 */
function estimateTaskKind(messages) {
  /** @type {Record<'coding' | 'data' | 'writing', number>} */
  const score = { coding: 0, data: 0, writing: 0 };
  let researchSteps = 0;
  let tabularReads = 0;
  let wroteSomething = false;
  let otherTools = false;

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.toolTrace)) continue;
    for (const entry of message.toolTrace) {
      const { tool, line, paths } = traceStep(entry);
      if (!tool) continue;
      if (WRITE_TOOLS.has(tool)) {
        wroteSomething = true;
        for (const path of paths) {
          if (CODE_FILE.test(path)) score.coding += 1;
          else if (PROSE_FILE.test(path)) score.writing += 1;
        }
      } else if (tool === 'shell_execute') {
        if (BUILD_OR_TEST.test(line)) score.coding += 1;
        else otherTools = true;
      } else if (tool === 'run_python') {
        score.data += 1;
      } else if (RESEARCH_TOOLS.has(tool)) {
        researchSteps += 1;
        if (READ_TOOLS.has(tool) && TABULAR_FILE.test(line)) tabularReads += 1;
      } else {
        otherTools = true;
      }
    }
  }

  // Reading tabular data counts for *Data* only while no code is written.
  if (score.coding === 0) score.data += tabularReads;
  const ranked = /** @type {Array<[TaskKindId, number]>} */ (Object.entries(score))
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) {
    const [first, second] = ranked;
    if (!second || first[1] >= DOMINANCE * second[1]) return first[0];
    return null;
  }
  // Nothing written, nothing run: only looked things up.
  if (researchSteps > 0 && !wroteSomething && !otherTools) return 'research';
  return null;
}

module.exports = { estimateTaskKind };
