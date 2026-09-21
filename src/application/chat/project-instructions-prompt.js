'use strict';

/**
 * Block mit den Projektanweisungen für den Systemprompt (Issue #212).
 *
 * Reine Funktion über den Dateien aus dem Project-Instructions-Port — die
 * Anwendungsschicht bleibt laufzeitneutral und der Block damit testbar.
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
} = require('../../shared/contracts/context-breakdown');
const {
  PROJECT_INSTRUCTION_SOURCE_LABELS,
  PROJECT_INSTRUCTION_SOURCE_PATHS,
  MAX_PROJECT_INSTRUCTION_CHARS,
  normalizeProjectInstructionFiles,
} = require('../../shared/contracts/project-instructions');

/** Hinweis unter einem abgeschnittenen Text — im Prompt wie in der Anzeige. */
const TRUNCATION_NOTE = `… [gekürzt auf ${MAX_PROJECT_INSTRUCTION_CHARS} Zeichen]`;

/**
 * @param {Array<{source: string, text: string, truncated?: boolean}>} files
 * @returns {{ text: string, parts: Array<object> }}
 */
function buildProjectInstructionsSystemPrompt(files) {
  const usable = normalizeProjectInstructionFiles(files);
  if (usable.length === 0) return { text: '', parts: [] };

  const intro = [
    'Projektanweisungen aus AGENTS.md. Sie gelten für diese Unterhaltung '
      + 'zusätzlich zu allem Übrigen in diesem Prompt und beschreiben, wie in '
      + 'diesem Projekt gearbeitet wird.',
  ];
  // Die Reihenfolge ist die Aussage: Ohne diesen Satz müsste das Modell raten,
  // welche der Dateien gilt, wenn zwei sich widersprechen.
  if (usable.length > 1) {
    intro.push(
      'Mehrere Dateien stehen hier untereinander, von allgemein nach speziell. '
        + 'Widersprechen sie sich, gilt die weiter unten stehende.'
    );
  }

  const sections = usable.map((file) => {
    const heading = PROJECT_INSTRUCTION_SOURCE_LABELS[file.source];
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
      label: PROJECT_INSTRUCTION_SOURCE_LABELS[file.source],
      detail: file.truncated
        ? `${PROJECT_INSTRUCTION_SOURCE_PATHS[file.source]} · gekürzt`
        : PROJECT_INSTRUCTION_SOURCE_PATHS[file.source],
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
