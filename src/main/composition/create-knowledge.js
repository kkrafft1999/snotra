'use strict';

/**
 * The adapters of the knowledge concept (#1275, #1276, #1278, #1319) in one
 * place: what is read into the prompt (AGENTS.md, rules files), what writes
 * knowledge (`remember`), the snapshots around a command, and the journal of
 * the agent's changes behind *Settings › Knowledge*. No cache, no watcher: a
 * changed file applies with the next message.
 */

const { createProjectInstructionsAdapter } = require('../adapters/project-instructions-adapter');
const { createRulesAdapter } = require('../adapters/rules-adapter');
const { createKnowledgeFilesAdapter } = require('../adapters/knowledge-files-adapter');
const { createKnowledgeWriterAdapter } = require('../adapters/knowledge-writer-adapter');
const { createKnowledgeJournal } = require('../services/knowledge-journal');

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {string} deps.userDataPath
 * @param {import('../../application/ports/memory-port').MemoryPort} deps.memory
 * @param {() => string|undefined} deps.getLocale
 * @param {() => Promise<boolean>} deps.isSelfMemoryAllowed
 */
function createKnowledge({ fs, path, os, userDataPath, memory, getLocale, isSelfMemoryAllowed }) {
  const journal = createKnowledgeJournal({
    fs,
    path,
    file: path.join(userDataPath, 'knowledge-journal.json'),
    homeDir: os.homedir(),
  });
  return {
    journal,
    projectInstructions: createProjectInstructionsAdapter({ fs, path, os }),
    rules: createRulesAdapter({ fs, path, os }),
    knowledgeFiles: createKnowledgeFilesAdapter({ fs, path, homeDir: os.homedir(), journal }),
    knowledgeWriter: createKnowledgeWriterAdapter({ fs, path, os, memory, getLocale, isSelfMemoryAllowed, journal }),
  };
}

module.exports = { createKnowledge };
