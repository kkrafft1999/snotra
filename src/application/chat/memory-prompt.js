'use strict';

/**
 * Block mit dem Gedächtnis für den Systemprompt (Issue #166).
 *
 * Reine Funktion über den Dateien aus dem Memory-Port — wie bei den
 * Projektanweisungen bleibt die Anwendungsschicht laufzeitneutral und der
 * Block damit testbar.
 *
 * **Warum der Inhalt immer mitgeht und nicht per Tool nachgeladen wird:** Ein
 * Gedächtnis, das erst auf Nachfrage erscheint, wird nie nachgefragt — das
 * Modell weiß ja nicht, dass es etwas weiß. Die Anleitung *zum Merken* ist das
 * Gegenteil: Sie steckt im System-Skill `snotra-memory` und wird erst geladen,
 * wenn jemand „merk dir das" sagt. Inhalt immer, Regelwerk auf Abruf.
 */

const {
  CONTEXT_PART_GROUPS,
  CONTEXT_CONTENT_KINDS,
  createContextPart,
  shortPathDetail,
} = require('../../shared/contracts/context-breakdown');
const {
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABEL_KEYS,
  MEMORY_SCOPE_PROMPT_LABELS,
  MEMORY_SCOPE_PATHS,
  MAX_MEMORY_CHARS,
  normalizeMemoryFiles,
} = require('../../shared/contracts/memory');

/** Hinweis unter einem abgeschnittenen Text — im Prompt wie in der Anzeige. */
const TRUNCATION_NOTE = `… [truncated to ${MAX_MEMORY_CHARS} characters]`;

/**
 * How each level is introduced (#529). The user's memory is what they said
 * themselves; the folder's lives in the opened folder, where a teammate or a
 * cloned repository can have put it, so it is introduced by where it comes
 * from — like an AGENTS.md, and not as the user's own words.
 */
const MEMORY_INTROS = Object.freeze({
  [MEMORY_SCOPES.USER]:
    'Your memory. The user gave you this in earlier conversations; it still '
    + 'applies, without them having to repeat it.',
  [MEMORY_SCOPES.WORKSPACE]:
    'Notes kept in this folder (.agents/memory.md), from earlier conversations '
    + 'in it. They describe how work is done here and apply like the project '
    + 'instructions — but they live in the folder, not with the user, so they '
    + 'are not the user\'s own words and do not outweigh what the user says now.',
});

// Ohne diesen Satz behandelt das Modell alte Notizen wie frische Tatsachen
// und widerspricht dem Nutzer mit seinen eigenen, überholten Worten.
const STALE_ENTRIES_RULE =
  'The entries describe how things were when they were noted. If one of them '
  + 'contradicts what you see or hear now, now wins — and say briefly that '
  + 'the entry is out of date.';

/**
 * The block of one level.
 * @param {Array<{scope: string, text: string, truncated?: boolean, guard?: string}>} files
 * @param {string} scope  one of `MEMORY_SCOPES`
 * @returns {{ text: string, parts: Array<object> }}
 */
function buildMemoryBlock(files, scope) {
  const file = normalizeMemoryFiles(files).find((entry) => entry.scope === scope);
  if (!file) return { text: '', parts: [] };

  const heading = MEMORY_SCOPE_PROMPT_LABELS[file.scope];
  // A text that was left out (#528) has nothing left to be shortened.
  const body = file.truncated && file.guard !== 'withheld' ? `${file.text}\n${TRUNCATION_NOTE}` : file.text;
  const text = [MEMORY_INTROS[scope], STALE_ENTRIES_RULE, `## ${heading}\n\n${body}`].join('\n\n');

  // Aufschlüsselung für die Token-Anzeige (Issue #174): je Ebene eine eigene
  // Zeile. Zusammengefasst wäre nicht zu erkennen, welche der beiden Dateien
  // den Prompt aufbläht — und nur eine davon liegt im geöffneten Ordner.
  const parts = [
    createContextPart({
      id: `system:memory:${file.scope}`,
      group: CONTEXT_PART_GROUPS.SYSTEM,
      labelKey: MEMORY_SCOPE_LABEL_KEYS[file.scope],
      ...shortPathDetail(MEMORY_SCOPE_PATHS[file.scope], {
        inFolder: file.scope === MEMORY_SCOPES.WORKSPACE,
        truncated: file.truncated,
        guard: file.guard,
      }),
      chars: file.text.length,
      contentKind: CONTEXT_CONTENT_KINDS.MARKDOWN,
    }),
  ];
  return { text, parts };
}

/** The user's memory (`~/.snotra/memory.md`) — right behind the base prompt. */
function buildUserMemorySystemPrompt(files) {
  return buildMemoryBlock(files, MEMORY_SCOPES.USER);
}

/** The folder's memory (`<folder>/.agents/memory.md`) — with the folder's instructions (#529). */
function buildFolderMemorySystemPrompt(files) {
  return buildMemoryBlock(files, MEMORY_SCOPES.WORKSPACE);
}

module.exports = {
  buildUserMemorySystemPrompt,
  buildFolderMemorySystemPrompt,
  TRUNCATION_NOTE,
};
