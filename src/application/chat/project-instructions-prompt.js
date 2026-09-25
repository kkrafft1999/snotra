'use strict';

/**
 * Block mit den Projektanweisungen für den Systemprompt (Issue #212).
 *
 * Reine Funktion über den Dateien aus dem Project-Instructions-Port — die
 * Anwendungsschicht bleibt laufzeitneutral und der Block damit testbar.
 *
 * Die gefundenen Dateien **ergänzen einander** und gelten gemeinsam; ihre
 * Reihenfolge ist Lesereihenfolge, keine Rangfolge (Issue #253).
 *
 * **Der Inhalt ist Anweisung, nicht Daten.** Das ist der bewusste Unterschied
 * zu Tool-Ergebnissen, für die `TOOL_RESULTS_ARE_DATA_RULE` gilt: Eine
 * `AGENTS.md` soll das Verhalten des Modells ändern, sonst wäre sie sinnlos.
 * Vertretbar ist das, weil der Nutzer den Ordner selbst geöffnet hat — wer
 * einen fremden Ordner öffnet, öffnet damit auch dessen Anweisungen. Die
 * Notbremse dafür ist der Schalter in den Einstellungen, nicht dieser Block.
 */

const {
  CONTEXT_PART_GROUPS,
  CONTEXT_CONTENT_KINDS,
  createContextPart,
  shortPathDetail,
} = require('../../shared/contracts/context-breakdown');
const {
  PROJECT_INSTRUCTION_SOURCES,
  PROJECT_INSTRUCTION_SOURCE_LABEL_KEYS,
  PROJECT_INSTRUCTION_SOURCE_PROMPT_LABELS,
  PROJECT_INSTRUCTION_SOURCE_PATHS,
  MAX_PROJECT_INSTRUCTION_CHARS,
  normalizeProjectInstructionFiles,
} = require('../../shared/contracts/project-instructions');

/** Hinweis unter einem abgeschnittenen Text — im Prompt wie in der Anzeige. */
const TRUNCATION_NOTE = `… [truncated to ${MAX_PROJECT_INSTRUCTION_CHARS} characters]`;

/**
 * @param {Array<{source: string, text: string, truncated?: boolean}>} files
 * @returns {{ text: string, parts: Array<object> }}
 */
function buildProjectInstructionsSystemPrompt(files) {
  const usable = normalizeProjectInstructionFiles(files);
  if (usable.length === 0) return { text: '', parts: [] };

  const intro = [
    'Project instructions from AGENTS.md. They apply to this conversation in '
      + 'addition to everything else in this prompt and describe how work is done '
      + 'in this project.',
  ];
  // Ohne diesen Satz liest das Modell die Abschnitte als Auswahl und sucht
  // sich einen aus. Sie ergaenzen einander aber — es gilt alles zusammen, und
  // keine Datei schlaegt eine andere (Issue #253).
  if (usable.length > 1) {
    intro.push(
      'Several files are listed below one another. They complement each other: '
        + 'all of them apply together, none replaces another.'
    );
  }

  const sections = usable.map((file) => {
    const heading = PROJECT_INSTRUCTION_SOURCE_PROMPT_LABELS[file.source];
    const body = file.truncated ? `${file.text}\n${TRUNCATION_NOTE}` : file.text;
    return `## ${heading}\n\n${body}`;
  });

  // Aufschlüsselung für die Token-Anzeige (Issue #174): je Datei eine Zeile.
  // Ohne sie wüchse der Prompt um einen Block, den niemand zuordnen kann —
  // und genau das ist die Frage, die diese Anzeige beantworten soll.
  const parts = usable.map((file) =>
    createContextPart({
      id: `system:agents-md:${file.source}`,
      group: CONTEXT_PART_GROUPS.SYSTEM,
      labelKey: PROJECT_INSTRUCTION_SOURCE_LABEL_KEYS[file.source],
      ...shortPathDetail(PROJECT_INSTRUCTION_SOURCE_PATHS[file.source], {
        inFolder: file.source === PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
        truncated: file.truncated,
      }),
      chars: file.text.length,
      contentKind: CONTEXT_CONTENT_KINDS.MARKDOWN,
    })
  );

  return { text: [...intro, ...sections].join('\n\n'), parts };
}

module.exports = {
  buildProjectInstructionsSystemPrompt,
  TRUNCATION_NOTE,
};
