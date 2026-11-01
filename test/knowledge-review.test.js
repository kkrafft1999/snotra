// Hints for memory and rules (#1279): the review Settings › Knowledge shows,
// one heuristic at a time and in every language Snotra has a catalogue for.

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewKnowledge, REVIEW_HINTS, wordOverlap, wordsOf, similarTopicNames } = require('../src/application/chat/knowledge-review');
const { LOCALES } = require('../src/shared/i18n/locales');

const NOW = new Date('2026-10-31T12:00:00Z');

/** @param {string[]} lines */
const memoryFile = (lines, scope = 'workspace') => ({ scope, key: `memory:${scope}`, text: `${lines.map((line) => `- ${line}`).join('\n')}\n` });
/** @param {string} name @param {string[]} lines */
const ruleFile = (name, lines, extra = {}) => ({
  level: 'workspace', source: 'workspace', name, key: `workspace:/ws#${name}`, body: `${lines.map((line) => `- ${line}`).join('\n')}\n`, ...extra,
});
/** @param {Parameters<typeof reviewKnowledge>[0]} input */
const review = (input) => reviewKnowledge({ now: NOW, ...input });
/** @param {any[]} hints @param {string} id */
const of = (hints, id) => hints.filter((hint) => hint.id === id);

// Every language with a catalogue brings its own samples — a third catalogue
// without word lists fails here instead of passing quietly.
const SAMPLES = {
  en: {
    rule: ['Whenever you write a commit message, use English.', 'Releases must go through a pull request.'],
    procedure: ['To release: first bump the version, then tag it, then push the tag.'],
    episode: ['Today we fixed the login bug.', 'We merged the sandbox fix.', 'Next step: the release notes.'],
    plain: ['Tests run with npm test.', 'We moved to pnpm because npm was slow.', 'We decided to use pnpm.'],
    same: ['The app is built with Electron and Node 24.', 'The app is built with Electron and Node 24!'],
  },
  de: {
    rule: ['Immer wenn du eine Commit-Message schreibst, auf Englisch.', 'Releases müssen über einen Pull Request gehen.'],
    procedure: ['Für ein Release: zuerst die Version erhöhen, dann taggen, dann den Tag pushen.'],
    episode: ['Heute haben wir den Login-Fehler behoben.', 'Wir haben den Sandbox-Fix gemergt.', 'Nächster Schritt: die Release Notes.'],
    plain: ['Die Tests laufen mit npm test.', 'Wir haben pnpm installiert, weil npm zu langsam war.', 'Wir haben uns für pnpm entschieden.'],
    same: ['Die App ist mit Electron und Node 24 gebaut.', 'Die App ist mit Electron und Node 24 gebaut!'],
  },
};

test('every language with a catalogue has samples for the word lists', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...LOCALES].sort());
});

for (const [language, samples] of Object.entries(SAMPLES)) {
  test(`${language}: a fact reads like a rule`, () => {
    for (const text of samples.rule) {
      assert.deepEqual(of(review({ memory: [memoryFile([text])] }), REVIEW_HINTS.FACT_LOOKS_LIKE_RULE).length, 1, text);
    }
  });

  test(`${language}: a fact reads like a procedure`, () => {
    for (const text of samples.procedure) {
      const hints = review({ memory: [memoryFile([text])] });
      assert.equal(of(hints, REVIEW_HINTS.FACT_LOOKS_LIKE_PROCEDURE).length, 1, text);
      assert.equal(of(hints, REVIEW_HINTS.FACT_LOOKS_LIKE_RULE).length, 0, 'a procedure is not also a rule');
    }
  });

  test(`${language}: memory and rules entries read like an episode`, () => {
    for (const text of samples.episode) {
      assert.equal(of(review({ memory: [memoryFile([text])] }), REVIEW_HINTS.LOOKS_LIKE_EPISODE).length, 1, `memory: ${text}`);
      assert.equal(of(review({ rules: [ruleFile('notes', [text])] }), REVIEW_HINTS.LOOKS_LIKE_EPISODE).length, 1, `rule: ${text}`);
    }
  });

  test(`${language}: a plain fact, a reason and a decision earn nothing`, () => {
    for (const text of samples.plain) assert.deepEqual(review({ memory: [memoryFile([text])] }), [], text);
  });

  test(`${language}: nearly the same within a file`, () => {
    const hints = of(review({ memory: [memoryFile(samples.same)] }), REVIEW_HINTS.NEARLY_THE_SAME);
    assert.equal(hints.length, 2, 'both entries are marked');
    assert.equal(hints[0].key, hints[1].key, 'under one key');
  });
}

test('a rule stored as a rule earns no "reads like a rule"', () => {
  assert.deepEqual(review({ rules: [ruleFile('commit', ['Whenever you write a commit message, use English.'])] }), []);
});

test('word overlap is measured against the longer entry and ignores case and punctuation', () => {
  assert.equal(wordOverlap(wordsOf('Answer in German.'), wordsOf('answer in german')), 1);
  assert.equal(wordOverlap(wordsOf('Answer in German.'), wordsOf('Always answer in German.')), 0.75);
  assert.equal(wordOverlap(wordsOf('Antworte auf Deutsch.'), wordsOf('Antworte immer auf Deutsch, bitte.')), 0.6);
  assert.equal(wordOverlap([], wordsOf('x')), 0);
});

test('nearly the same: in another rules file, and between memory and rules of a level', () => {
  const text = 'Commit messages are written in English.';
  const across = of(review({ rules: [ruleFile('commit-messages', [text]), ruleFile('language', [`${text}`.toLowerCase()])] }), REVIEW_HINTS.NEARLY_THE_SAME);
  assert.deepEqual(across.map((hint) => [hint.at.name, hint.with.name]), [['commit-messages', 'language'], ['language', 'commit-messages']]);

  const mixed = of(review({ memory: [memoryFile([text])], rules: [ruleFile('git', [text])] }), REVIEW_HINTS.NEARLY_THE_SAME);
  assert.deepEqual(mixed.map((hint) => [hint.at.kind, hint.with.kind]), [['memory', 'rule'], ['rule', 'memory']]);
  assert.equal(mixed.some((hint) => hint.alsoGlobal), false);
});

test('nearly the same across levels: only the folder\'s entry is marked, "also kept globally"', () => {
  const text = 'Answer in German.';
  const hints = of(review({ memory: [memoryFile([text], 'workspace'), memoryFile([text], 'user')] }), REVIEW_HINTS.NEARLY_THE_SAME);
  assert.equal(hints.length, 1);
  assert.deepEqual([hints[0].at.scope, hints[0].with.scope, hints[0].alsoGlobal], ['workspace', 'user', true]);
});

test('below 80 % overlap is not nearly the same', () => {
  assert.deepEqual(review({ memory: [memoryFile(['Answer in German.', 'Always answer in German.'])] })
    .filter((hint) => hint.id === REVIEW_HINTS.NEARLY_THE_SAME), []);
});

test('similar topic names: plural, hyphen and one letter — not digits, not across levels', () => {
  assert.equal(similarTopicNames('commit', 'commits'), true);
  assert.equal(similarTopicNames('commit-message', 'commit-messages'), true);
  assert.equal(similarTopicNames('git-workflow', 'gitworkflow'), true);
  assert.equal(similarTopicNames('regel', 'regeln'), true);
  assert.equal(similarTopicNames('api-v1', 'api-v2'), false);
  assert.equal(similarTopicNames('rust', 'rest'), false, 'short names need more than one letter');
  assert.equal(similarTopicNames('deploy', 'testing'), false);

  const hints = of(review({ rules: [ruleFile('commit', ['a']), ruleFile('commits', ['b']), ruleFile('deploy', ['c'])] }), REVIEW_HINTS.SIMILAR_TOPIC_NAMES);
  assert.deepEqual(hints.map((hint) => [hint.at.name, hint.with.name]), [['commit', 'commits'], ['commits', 'commit']]);
  const levels = of(review({ rules: [ruleFile('commit', ['a']), ruleFile('commits', ['b'], { level: 'user', source: 'user-snotra' })] }), REVIEW_HINTS.SIMILAR_TOPIC_NAMES);
  assert.deepEqual(levels, []);
  const shadow = of(review({ rules: [ruleFile('commit', ['a']), ruleFile('commits', ['b'], { shadowed: true })] }), REVIEW_HINTS.SIMILAR_TOPIC_NAMES);
  assert.deepEqual(shadow, []);
});

test('noted a while ago: dated entries older than 180 days, undated ones never', () => {
  const hints = of(review({
    memory: [memoryFile(['2026-04-30 — Old fact.', '2026-05-04 — Recent enough fact.', 'Undated fact.'])],
    rules: [ruleFile('deploy', ['2025-01-01 — Never on Fridays.', 'Undated hand-written rule.'])],
  }), REVIEW_HINTS.NOTED_A_WHILE_AGO);
  assert.deepEqual(hints.map((hint) => [hint.at.kind, hint.at.text, hint.date]), [
    ['memory', 'Old fact.', '2026-04-30'],
    ['rule', 'Never on Fridays.', '2025-01-01'],
  ]);
});

test('close to the limit: memory at 80 % of 8,000, a rules file at 80 % of its limit, a level\'s always budget used up', () => {
  const full = { scope: 'user', key: 'memory:user', text: `- ${'x'.repeat(6400)}\n` };
  const memoryHints = of(review({ memory: [full] }), REVIEW_HINTS.CLOSE_TO_LIMIT);
  assert.deepEqual(memoryHints.map((hint) => [hint.at.kind, hint.dismissible]), [['memoryFile', false]]);
  assert.ok(memoryHints[0].share >= 0.8);
  assert.deepEqual(of(review({ memory: [{ ...full, text: '- short\n' }] }), REVIEW_HINTS.CLOSE_TO_LIMIT), []);

  const long = ruleFile('long', ['y'.repeat(16_000)]);
  assert.deepEqual(of(review({ rules: [long] }), REVIEW_HINTS.CLOSE_TO_LIMIT).map((hint) => hint.at.kind), ['ruleFile']);

  const always = (name, on = true) => ruleFile(name, ['z'.repeat(4100)], { always: true, on });
  const budget = of(review({ rules: [always('a'), always('b')] }), REVIEW_HINTS.CLOSE_TO_LIMIT);
  assert.deepEqual(budget.map((hint) => [hint.at.kind, hint.at.level, hint.budgetUsedUp]), [['rulesLevel', 'workspace', true]]);
  assert.deepEqual(of(review({ rules: [always('a'), always('b', false)] }), REVIEW_HINTS.CLOSE_TO_LIMIT), [], 'a file switched off does not count');
});

test('a dismissed hint stays dismissed for its entry, and comes back when the entry\'s words change', () => {
  const file = memoryFile(['Today we fixed the login bug.']);
  const [hint] = review({ memory: [file] });
  assert.deepEqual(review({ memory: [file], dismissed: [hint.key] }), []);
  assert.deepEqual(review({ memory: [memoryFile(['Moved down a line.', 'Today we fixed the login bug.'])], dismissed: [hint.key] })
    .filter((other) => other.id === REVIEW_HINTS.LOOKS_LIKE_EPISODE), [], 'the key does not depend on the line');
  assert.equal(review({ memory: [memoryFile(['Today we fixed the logout bug.'])], dismissed: [hint.key] }).length, 1);

  const pair = review({ memory: [memoryFile(['Answer in German.', 'answer in german'])] });
  assert.deepEqual(review({ memory: [memoryFile(['Answer in German.', 'answer in german'])], dismissed: [pair[0].key] }), [],
    'dismissing nearly the same on one entry dismisses it on both');

  const full = { scope: 'user', key: 'memory:user', text: `- ${'x'.repeat(6400)}\n` };
  const [limit] = review({ memory: [full] });
  assert.equal(review({ memory: [full], dismissed: [limit.key] }).length, 1, 'close to the limit is a state, not dismissible');
});

test('the same words in another folder are another entry', () => {
  const [a] = review({ memory: [{ ...memoryFile(['Today we fixed it.']), key: 'memory:workspace:/a' }] });
  const [b] = review({ memory: [{ ...memoryFile(['Today we fixed it.']), key: 'memory:workspace:/b' }] });
  assert.notEqual(a.key, b.key);
});

test('no files, no hints', () => {
  assert.deepEqual(reviewKnowledge(), []);
});
