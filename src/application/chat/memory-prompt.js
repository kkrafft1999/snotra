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
} = require('../../shared/contracts/context-breakdown');
const {
  MEMORY_SCOPE_LABELS,
  MEMORY_SCOPE_PATHS,
  MAX_MEMORY_CHARS,
  normalizeMemoryFiles,
} = require('../../shared/contracts/memory');

/** Hinweis unter einem abgeschnittenen Text — im Prompt wie in der Anzeige. */
const TRUNCATION_NOTE = `… [gekürzt auf ${MAX_MEMORY_CHARS} Zeichen]`;

/**
 * @param {Array<{scope: string, text: string, truncated?: boolean}>} files
 * @returns {{ text: string, parts: Array<object> }}
 */
function buildMemorySystemPrompt(files) {
  const usable = normalizeMemoryFiles(files);
  if (usable.length === 0) return { text: '', parts: [] };

  const intro = [
    'Dein Gedächtnis. Das hier hat der Nutzer dir in früheren Unterhaltungen '
      + 'mitgegeben; es gilt weiter, ohne dass er es wiederholen muss.',
  ];
  // Ohne diesen Satz behandelt das Modell alte Notizen wie frische Tatsachen
  // und widerspricht dem Nutzer mit seinen eigenen, überholten Worten.
  intro.push(
    'Die Einträge beschreiben den Stand, als sie notiert wurden. Widerspricht '
      + 'einer davon dem, was du jetzt siehst oder hörst, gilt das Jetzt — und '
      + 'sag kurz, dass der Eintrag überholt ist.'
  );

  const sections = usable.map((file) => {
    const heading = MEMORY_SCOPE_LABELS[file.scope];
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
      label: MEMORY_SCOPE_LABELS[file.scope],
      detail: file.truncated
        ? `${MEMORY_SCOPE_PATHS[file.scope]} · gekürzt`
        : MEMORY_SCOPE_PATHS[file.scope],
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
