'use strict';

/**
 * The tool handler of `extract_document_text` (#42): the path through the
 * same checks as every other read tool (`fsService.resolveToolPath`), the
 * bytes through `readRegularFile`, the arguments into a request — and the
 * extraction itself to the extractor, which runs it in a worker.
 */

const { readRegularFile, NOT_A_REGULAR_FILE_ERROR } = require('./read-regular-file');

/** 50 MB, as for the PDF view (#346): a scanned contract of a few hundred pages stays below it. */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * @typedef {{ skillRoots?: Array<{ name: string, dir: string }>,
 *   outsideRoots?: Array<{ root: string, only: string|null, access: 'read'|'write' }>,
 *   abortSignal?: AbortSignal }} DocumentTextToolOptions
 */

/**
 * @param {object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {{ resolveToolPath: (workspaceRoot: string|null|undefined, relativePath: string,
 *   options: DocumentTextToolOptions) => Promise<{ absPath?: string, error?: string }> }} deps.fsService
 * @param {ReturnType<typeof import('./document-text-worker').createDocumentTextExtractor>} deps.extractor
 * @param {number} [deps.maxBytes]
 */
function createDocumentTextService({ fs, fsService, extractor, maxBytes = MAX_DOCUMENT_BYTES }) {
  /**
   * @param {import('../../application/ports/tool-port').ToolArguments} args
   * @param {string|null|undefined} workspaceRoot
   * @param {DocumentTextToolOptions} [options]
   * @returns {Promise<string>}
   */
  async function runExtractDocumentTextTool(args, workspaceRoot, options = {}) {
    const rel = typeof args?.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) return JSON.stringify({ error: 'relative_path is required.' });
    const startCharacter = args.start_character;
    if (startCharacter !== undefined && startCharacter !== null
      && (!Number.isInteger(startCharacter) || startCharacter < 0)) {
      return JSON.stringify({ error: 'start_character must be a whole number from 0.' });
    }

    const { absPath, error } = await fsService.resolveToolPath(workspaceRoot, rel, {
      skillRoots: options.skillRoots,
      outsideRoots: options.outsideRoots,
    });
    if (error || !absPath) return JSON.stringify({ error });
    let read;
    try {
      read = await readRegularFile(fs, absPath, { maxBytes });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    if (read.notFile) {
      return JSON.stringify({ error: read.stats.isDirectory() ? 'Path is a folder, not a file.' : NOT_A_REGULAR_FILE_ERROR });
    }
    if (read.tooLarge) {
      return JSON.stringify({ error: `File too large (>${maxBytes} bytes) to extract its text.` });
    }
    // `readRegularFile` answers a buffer or one of the two flags; nothing else gets here.
    if (!read.buffer) return JSON.stringify({ error: NOT_A_REGULAR_FILE_ERROR });

    const result = await extractor.extract(read.buffer, {
      pages: typeof args.pages === 'number' ? String(args.pages) : args.pages,
      sheet: args.sheet,
      range: args.range,
      startCharacter: startCharacter ?? 0,
      maxCharacters: args.max_characters,
    }, { abortSignal: options.abortSignal });
    if (result?.error) return JSON.stringify({ error: result.error });
    return JSON.stringify({ relative_path: rel, size_bytes: read.stats.size, ...result });
  }

  return { runExtractDocumentTextTool };
}

module.exports = { createDocumentTextService, MAX_DOCUMENT_BYTES };
