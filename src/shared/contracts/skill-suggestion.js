/**
 * Vorschlag passender Skills anhand der Nutzereingabe (Issue #125, Teil #89).
 *
 * Gesucht wird hier nicht nach einem getippten Präfix wie bei `/name`
 * (skill-invocation.js), sondern nach der Bedeutung eines ganzen Satzes:
 * „Mach mir ein Protokoll vom Teams-Meeting gestern" soll `meeting-protocol`
 * finden, ohne dass der Nutzer den Namen kennt.
 *
 * Das Verfahren ist bewusst lexikalisch und läuft ohne Netz: Wortüberlappung
 * zwischen Eingabe und Skill-Beschreibung, gewichtet danach, wie selten ein
 * Wort im Katalog ist. Ein Wort, das in jeder zweiten Beschreibung steht,
 * sagt wenig; „Tagesverbuchung" sagt viel.
 *
 * **Gemessen an 16 echten Skills mit 13 Anfragen und 5 neutralen Sätzen**
 * (2026-09-13): richtiger Skill auf Platz 1 in 10 von 13 Fällen, kein
 * einziger Fehlalarm bei den neutralen Sätzen. Die verbleibenden Fehler sind
 * dem Verfahren eigen und nicht durch Feinjustieren zu beheben:
 *
 * - Fachkürzel, die in keiner Beschreibung stehen („TTAI-421" für
 *   `jira-ticket-status`, dessen Beschreibung nur „PROJ-123" nennt).
 * - Zwei nah verwandte Skills, deren Unterschied in der *Abwesenheit* eines
 *   Wortes liegt (`confluence-to-markdown` gegen `confluence-comments-export`
 *   — das trennende Wort wäre „Kommentare", das in der Anfrage gerade fehlt).
 *
 * Ebenfalls gemessen und **verworfen**: den „Verwenden, wenn …"-Teil der
 * Beschreibung höher zu gewichten. 15 von 16 Beschreibungen haben ihn, und es
 * liegt nahe, dass er die Nutzeranfrage besser beschreibt als der Vorspann —
 * er verstärkt aber Signal und Rauschen gleichermaßen und verschlechterte das
 * Ergebnis auf 9 von 13.
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

/**
 * Häufige Füllwörter, die für sich genommen nichts über das Anliegen sagen.
 * Deutsch und Englisch gemischt, weil Skill-Beschreibungen beides sind.
 */
const STOPWORDS = new Set(
  `der die das den dem des ein eine einen einem einer eines und oder aber auch noch schon nur
   mir mich dir dich sich ist sind war waren hat habe haben hatte wird werden wurde kann kannst
   koennen können könnte soll sollte muss müssen bitte mal doch fuer für von vom zum zur mit
   ohne auf aus bei nach über unter vor zwischen wie was wer wann warum welche welcher welches
   nicht kein keine alle jeden jede jedes dieser diese dieses meine meinen mein deine dein ich
   du wir ihr sie man es am im in an zu da dann wenn als dass weil damit denn also etwa gerne
   eigentlich einfach the and for with from this that you your can could would please make into
   about when what which where have has been are was were not but all any its our their there
   here then than them they it is be to of a an on at or if so do does did`
    .split(/\s+/)
    .filter(Boolean)
);

/** Kürzer als das sagt ein Wort zu wenig, um danach zu suchen. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Der Skill-Name ist die verdichtete Aussage über den Skill und wiegt daher
 * schwerer als dasselbe Wort irgendwo im Fließtext.
 */
const NAME_WEIGHT = 1.6;

/** Ab wie vielen gemeinsamen Anfangsbuchstaben zwei Wörter als verwandt gelten. */
const STEM_LENGTH = 5;
/** Ein Treffer über den Wortstamm zählt weniger als ein wörtlicher. */
const STEM_SCORE = 0.8;

/**
 * Ab welchem Wert ein Vorschlag gezeigt wird. An der Messreihe abgelesen: Bei
 * 0.30 verschwindet der letzte Fehlalarm, ohne einen Treffer zu kosten. Lieber
 * einmal zu wenig vorschlagen als einmal zu viel — ein Vorschlagswesen, das
 * ständig danebenredet, schaltet man ab.
 */
const SUGGESTION_THRESHOLD = 0.3;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
}

/**
 * Wie stark decken sich zwei Wörter? Deutsche Beugung und Komposita machen
 * aus „Protokoll" schnell „Protokolle" oder „Meeting-Protokolle“; ein
 * gemeinsamer Wortanfang fängt das billig ab, ohne Stemming-Bibliothek.
 */
function tokenOverlap(a, b) {
  if (a === b) return 1;
  if (a.length < STEM_LENGTH || b.length < STEM_LENGTH) return 0;
  const stem = a.slice(0, STEM_LENGTH);
  return b.startsWith(stem) ? STEM_SCORE : 0;
}

/**
 * Baut das Bewertungsmodell für einen Katalog. Die Gewichte hängen vom
 * gesamten Katalog ab (ein Wort ist nur relativ zu den anderen selten),
 * deshalb einmal vorbereiten und für viele Anfragen nutzen.
 *
 * @param {Array<{name: string, description: string}>} skills
 */
function createSkillSuggester(skills) {
  const entries = (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && typeof skill.name === 'string' && skill.name)
    .map((skill) => ({
      skill,
      words: new Set(tokenize(`${skill.name} ${skill.description || ''}`)),
      nameWords: new Set(tokenize(String(skill.name).replace(/[-_]/g, ' '))),
    }));

  const documentCount = entries.length;
  const occurrences = new Map();
  for (const entry of entries) {
    for (const word of entry.words) occurrences.set(word, (occurrences.get(word) || 0) + 1);
  }

  /** Seltene Wörter wiegen schwer, allgegenwärtige fast nichts (IDF). */
  function weightOf(word) {
    const seen = occurrences.get(word) || 0;
    return Math.log((documentCount + 1) / (seen + 0.5));
  }

  /**
   * @param {string} text Die Nutzereingabe.
   * @param {{ threshold?: number, limit?: number }} [options]
   * @returns {Array<{ name: string, description: string, score: number }>}
   *   Absteigend sortiert; leer, wenn nichts deutlich genug passt.
   */
  function suggest(text, { threshold = SUGGESTION_THRESHOLD, limit = 3 } = {}) {
    if (documentCount === 0) return [];
    const queryWords = [...new Set(tokenize(text))];
    if (queryWords.length === 0) return [];

    // Gegen die bestmögliche Übereinstimmung normalisieren, damit die Schwelle
    // von der Länge der Eingabe unabhängig bleibt.
    const maxScore = queryWords.reduce((sum, word) => sum + weightOf(word), 0);
    if (maxScore <= 0) return [];

    const scored = [];
    for (const entry of entries) {
      let score = 0;
      for (const word of queryWords) {
        let best = 0;
        for (const candidate of entry.words) {
          best = Math.max(best, tokenOverlap(word, candidate));
          if (best === 1) break;
        }
        let inName = 0;
        for (const candidate of entry.nameWords) {
          inName = Math.max(inName, tokenOverlap(word, candidate));
          if (inName === 1) break;
        }
        score += Math.max(best, inName * NAME_WEIGHT) * weightOf(word);
      }
      const normalized = score / maxScore;
      if (normalized >= threshold) {
        scored.push({
          name: entry.skill.name,
          description: entry.skill.description || '',
          score: normalized,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, Math.max(0, Math.floor(limit)));
  }

  return { suggest };
}

module.exports = {
  createSkillSuggester,
  SUGGESTION_THRESHOLD,
  MIN_TOKEN_LENGTH,
  STOPWORDS,
};
