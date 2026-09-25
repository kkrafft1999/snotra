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
 * @param {Array<{scope: string, text: string, truncated?: boolean}>} files
 * @returns {{ text: string, parts: Array<object> }}
 */
function buildMemorySystemPrompt(files) {
  const usable = normalizeMemoryFiles(files);
  if (usable.length === 0) return { text: '', parts: [] };

  const intro = [
    'Your memory. The user gave you this in earlier conversations; it still '
      + 'applies, without them having to repeat it.',
  ];
  // Ohne diesen Satz behandelt das Modell alte Notizen wie frische Tatsachen
  // und widerspricht dem Nutzer mit seinen eigenen, überholten Worten.
  intro.push(
    'The entries describe how things were when they were noted. If one of them '
      + 'contradicts what you see or hear now, now wins — and say briefly that '
      + 'the entry is out of date.'
  );

  const sections = usable.map((file) => {
    const heading = MEMORY_SCOPE_PROMPT_LABELS[file.scope];
    const body = file.truncated ? `${file.text}\n${TRUNCATION_NOTE}` : file.text;
    return `## ${heading}\n\n${body}`;
  });

  // Aufschlüsselung für die Token-Anzeige (Issue #174): je Ebene eine eigene
  // Zeile. Zusammengefasst wäre nicht zu erkennen, welche der beiden Dateien
  // den Prompt aufbläht — und nur eine davon liegt im geöffneten Ordner.
  const parts = usable.map((file) =>
    createContextPart({
      id: `system:memory:${file.scope}`,
      group: CONTEXT_PART_GROUPS.SYSTEM,
      labelKey: MEMORY_SCOPE_LABEL_KEYS[file.scope],
      ...shortPathDetail(MEMORY_SCOPE_PATHS[file.scope], {
        inFolder: file.scope === MEMORY_SCOPES.WORKSPACE,
        truncated: file.truncated,
      }),
      chars: file.text.length,
      contentKind: CONTEXT_CONTENT_KINDS.MARKDOWN,
    })
  );

  return { text: [...intro, ...sections].join('\n\n'), parts };
}

module.exports = {
  buildMemorySystemPrompt,
  TRUNCATION_NOTE,
};
