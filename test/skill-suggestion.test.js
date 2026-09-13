const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSkillSuggester,
  SUGGESTION_THRESHOLD,
} = require('../src/shared/contracts/skill-suggestion');
const contracts = require('../src/shared/contracts');

/**
 * Ein Ausschnitt echter Skill-Beschreibungen (gekürzt). Erfundene Beispiele
 * taugen hier nicht: Das Verfahren lebt davon, wie sich die Beschreibungen
 * *untereinander* unterscheiden — darunter zwei bewusst nah verwandte
 * Confluence-Skills und zwei Konverter, die beide von Markdown reden.
 */
const KATALOG = [
  {
    name: 'meeting-protocol',
    description:
      'Erstellt und verteilt Teams-Meeting-Protokolle: Transkript laden, Markdown-Protokoll, '
      + 'Word-Export, Upload in den Meeting-Chat. Verwenden, wenn der User Meeting-Protokolle, '
      + 'Transkript-Aufbereitung oder Meeting-Zusammenfassungen anfordert.',
  },
  {
    name: 'teams-nachricht-senden',
    description:
      'Verschickt eine Textnachricht in Microsoft Teams an eine Person oder einen Gruppen-Chat. '
      + 'Verwenden, wenn der User eine Teams-Nachricht oder DM an eine Person senden möchte.',
  },
  {
    name: 'ms-todo-cli',
    description:
      'Erstellt, bearbeitet und verwaltet Aufgaben in Microsoft To-Do. Verwenden wenn der User '
      + 'Aufgaben erstellen, bearbeiten, löschen, erledigen oder nach Fälligkeit suchen möchte.',
  },
  {
    name: 'confluence-to-markdown',
    description:
      'Exportiert eine Confluence-Seite als lokale Markdown-Datei. Verwenden, wenn der User eine '
      + 'Confluence-Seite herunterladen, exportieren oder als Markdown speichern möchte.',
  },
  {
    name: 'confluence-comments-export',
    description:
      'Exportiert Kommentare einer Confluence-Seite als strukturierte Markdown-Datei mit '
      + 'Thread-Zuordnung. Verwenden wenn der User Confluence-Kommentare exportieren möchte.',
  },
  {
    name: 'md-2-pdf',
    description:
      'Konvertiert Markdown-Dateien in PDFs im doubleSlash Corporate Design. Verwenden, wenn der '
      + 'User ein PDF aus einer Markdown-Datei erstellen möchte.',
  },
  {
    name: 'md-to-docx',
    description:
      'Konvertiert Markdown-Dateien in formatierte Word-Dokumente. Verwenden, wenn der User ein '
      + 'Word-Dokument aus Markdown erzeugen oder eine .md-Datei als .docx exportieren möchte.',
  },
  {
    name: 'heimat-tagesverbuchung',
    description:
      'Heimat-Zeitbuchungen (Tagesverbuchung): Verfahren zum Verbuchen von Kalendertagen. '
      + 'Use whenever Konrad Zeiten in Heimat buchen will oder Kalendertage verbuchen lässt.',
  },
  {
    name: 'git-basics',
    description:
      'Git-Workflow fuer Nicht-Entwickler. Fuehrt durch Pull-Commit-Push auf main, loest '
      + 'Konflikte interaktiv. Verwenden, wenn der User Git-Operationen ausfuehren möchte.',
  },
];

const suggester = createSkillSuggester(KATALOG);
const namen = (text) => suggester.suggest(text).map((s) => s.name);

test('findet den passenden Skill zu einem ganzen Satz', () => {
  assert.equal(namen('Mach mir bitte ein Protokoll vom Teams-Meeting gestern')[0], 'meeting-protocol');
  assert.equal(namen('Schreib Michi eine Nachricht in Teams')[0], 'teams-nachricht-senden');
  assert.equal(namen('Leg eine Aufgabe in Microsoft To-Do an')[0], 'ms-todo-cli');
  assert.equal(namen('Verbuche meinen Dienstag in Heimat')[0], 'heimat-tagesverbuchung');
  assert.equal(namen('Wie committe ich meine Aenderungen?')[0], 'git-basics');
});

test('trennt die beiden Markdown-Konverter am Zielformat', () => {
  assert.equal(namen('Erzeug ein PDF aus dem Markdown')[0], 'md-2-pdf');
  assert.equal(namen('Mach aus der Markdown-Datei ein Word-Dokument')[0], 'md-to-docx');
});

test('schweigt bei Anfragen, zu denen kein Skill passt', () => {
  // Der wichtigere Teil: Ein Vorschlagswesen, das ständig danebenredet,
  // schaltet man ab. Lieber einmal zu wenig als einmal zu viel.
  assert.deepEqual(namen('Warum ist der Himmel blau?'), []);
  assert.deepEqual(namen('Erklaer mir den Unterschied zwischen let und const'), []);
  assert.deepEqual(namen('Refaktoriere diese Funktion, sie ist zu lang'), []);
  assert.deepEqual(namen('Danke, das passt so'), []);
  assert.deepEqual(namen('Wie spaet ist es in Tokio?'), []);
});

test('reine Füllwörter ergeben keinen Vorschlag', () => {
  assert.deepEqual(namen(''), []);
  assert.deepEqual(namen('   '), []);
  assert.deepEqual(namen('und der die das'), []);
  assert.deepEqual(namen(null), []);
});

test('erkennt gebeugte Formen und Komposita über den Wortstamm', () => {
  // „Protokolle" und „Meeting-Protokoll" sollen dasselbe finden wie
  // „Protokoll" — ohne Stemming-Bibliothek, über den gemeinsamen Wortanfang.
  assert.equal(namen('Ich brauche die Protokolle der Meetings')[0], 'meeting-protocol');
  assert.equal(namen('Konvertiere das nach Markdown aus Confluence')[0].startsWith('confluence'), true);
});

test('die Bewertung hängt nicht an der Länge der Eingabe', () => {
  // Derselbe Kern, einmal knapp und einmal in einen Satz verpackt: Beide
  // müssen über die Schwelle kommen, sonst wäre sie nur für Telegrammstil
  // brauchbar.
  assert.equal(namen('Teams-Protokoll')[0], 'meeting-protocol');
  assert.equal(
    namen('Kannst du mir bitte irgendwann heute noch ein Protokoll von dem Teams-Meeting machen')[0],
    'meeting-protocol'
  );
});

test('liefert absteigend sortiert, begrenzt und mit Bewertung', () => {
  const treffer = suggester.suggest('Confluence-Seite exportieren', { limit: 2 });
  assert.ok(treffer.length <= 2);
  assert.ok(treffer.every((s) => s.score >= SUGGESTION_THRESHOLD));
  for (let i = 1; i < treffer.length; i += 1) {
    assert.ok(treffer[i - 1].score >= treffer[i].score, 'absteigend');
  }
  assert.equal(typeof treffer[0].description, 'string');
});

test('eine höhere Schwelle schweigt öfter, eine niedrigere seltener', () => {
  const streng = suggester.suggest('Protokoll vom Meeting', { threshold: 0.9 });
  const locker = suggester.suggest('Protokoll vom Meeting', { threshold: 0.1, limit: 10 });
  assert.ok(locker.length >= streng.length);
});

test('ein leerer Katalog schlägt nichts vor, statt zu stolpern', () => {
  assert.deepEqual(createSkillSuggester([]).suggest('Protokoll vom Meeting'), []);
  assert.deepEqual(createSkillSuggester(null).suggest('Protokoll'), []);
  // Unbrauchbare Einträge fliegen raus, der Rest bleibt nutzbar.
  const gemischt = createSkillSuggester([null, { name: '' }, KATALOG[0]]);
  assert.deepEqual(gemischt.suggest('Protokoll vom Teams-Meeting').map((s) => s.name), [
    'meeting-protocol',
  ]);
});

test('das Contract-Aggregat reicht den Vorschlag an den Renderer durch', () => {
  assert.equal(typeof contracts.createSkillSuggester, 'function');
  assert.equal(contracts.SUGGESTION_THRESHOLD, SUGGESTION_THRESHOLD);
});
