// Aufschlüsselung des Kontextfensters (Issue #174).
//
// Die Anbieter liefern nur eine Gesamtzahl. Hier wird geprueft, dass die
// geschaetzte Verteilung darauf aufgeht und dass die Anzeige „echt" und
// „geschaetzt" nicht verwechseln kann.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CONTEXT_PART_GROUPS,
  CONTEXT_CONTENT_KINDS,
  CHARS_PER_TOKEN_PROFILE_BY_PROVIDER,
  charsPerTokenProfile,
  estimateTokensFromChars,
  createContextBreakdown,
  normalizeContextBreakdown,
  groupContextParts,
} = require('../src/shared/contracts/context-breakdown');

function part(overrides) {
  return {
    id: 'x',
    group: CONTEXT_PART_GROUPS.SYSTEM,
    label: 'Teil',
    chars: 400,
    contentKind: CONTEXT_CONTENT_KINDS.PROSE,
    ...overrides,
  };
}

test('JSON-Schemas zaehlen dichter als Fliesstext', () => {
  // Der Kern von Issue #169: „1 Token ≈ 4 Zeichen" macht Tool-Schemas um
  // Faktor zwei zu billig. 1000 Zeichen Schema muessen deutlich mehr Tokens
  // ergeben als 1000 Zeichen Prosa.
  const prose = estimateTokensFromChars(1000, CONTEXT_CONTENT_KINDS.PROSE);
  const json = estimateTokensFromChars(1000, CONTEXT_CONTENT_KINDS.JSON);
  assert.equal(prose, 250);
  assert.ok(json > prose * 1.5, `${json} sollte deutlich ueber ${prose} liegen`);
  assert.equal(estimateTokensFromChars(0, CONTEXT_CONTENT_KINDS.PROSE), 0);
  // Etwas ist nie nichts: eine Zeile mit Inhalt faellt nicht auf 0 Tokens.
  assert.equal(estimateTokensFromChars(1, CONTEXT_CONTENT_KINDS.PROSE), 1);
});

test('die Zeilen summieren sich exakt auf die echte Zahl des Anbieters', () => {
  const breakdown = createContextBreakdown({
    parts: [
      part({ id: 'a', chars: 1234 }),
      part({ id: 'b', chars: 777, contentKind: CONTEXT_CONTENT_KINDS.JSON }),
      part({ id: 'c', chars: 51 }),
    ],
    promptTokens: 9999,
  });

  assert.equal(breakdown.scaled, true);
  assert.equal(breakdown.promptTokens, 9999);
  assert.equal(breakdown.total, 9999);
  const sum = breakdown.parts.reduce((acc, row) => acc + row.tokens, 0);
  assert.equal(sum, 9999, 'Rundungsrest muss beim groessten Posten landen');
  const shares = breakdown.parts.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
});

test('ohne Usage des Anbieters bleiben die rohen Schaetzungen stehen', () => {
  const breakdown = createContextBreakdown({
    parts: [part({ chars: 800 })],
    promptTokens: 0,
  });
  assert.equal(breakdown.scaled, false);
  assert.equal(breakdown.promptTokens, 0);
  assert.equal(breakdown.total, 200);
  assert.equal(breakdown.parts[0].tokens, 200);
});

test('leere Bausteine fallen raus, statt Nullzeilen zu erzeugen', () => {
  const breakdown = createContextBreakdown({
    parts: [part({ id: 'leer', chars: 0 }), part({ id: 'voll', chars: 100 })],
    promptTokens: 50,
  });
  assert.deepEqual(breakdown.parts.map((row) => row.id), ['voll']);
});

test('normalizeContextBreakdown weist unbrauchbare Eingaben ab', () => {
  for (const input of [null, undefined, 42, {}, { parts: [] }, { parts: [{ tokens: 0 }] }]) {
    assert.equal(normalizeContextBreakdown(input), null, JSON.stringify(input));
  }
  // `scaled` ohne echte Zahl waere eine Luege — die Normalisierung dreht es zurueck.
  const faked = normalizeContextBreakdown({
    scaled: true,
    promptTokens: 0,
    estimatedTokens: 10,
    parts: [{ id: 'a', group: 'system', label: 'A', tokens: 10, chars: 40 }],
  });
  assert.equal(faked.scaled, false);
  assert.equal(faked.total, 10);
  assert.equal(faked.parts[0].share, 1);
});

test('Gruppen kommen in fester Folge, teuerste Zeile zuerst', () => {
  const breakdown = createContextBreakdown({
    parts: [
      part({ id: 'verlauf', group: CONTEXT_PART_GROUPS.HISTORY, chars: 100 }),
      part({ id: 'klein', group: CONTEXT_PART_GROUPS.SKILLS, chars: 100, skillName: 'klein' }),
      part({ id: 'gross', group: CONTEXT_PART_GROUPS.SKILLS, chars: 4000, skillName: 'gross' }),
      part({ id: 'system', group: CONTEXT_PART_GROUPS.SYSTEM, chars: 200 }),
    ],
    promptTokens: 1100,
  });

  const groups = groupContextParts(breakdown);
  assert.deepEqual(groups.map((g) => g.group), ['system', 'skills', 'history']);
  assert.deepEqual(groups[1].parts.map((row) => row.id), ['gross', 'klein']);
  assert.equal(groups[1].tokens, groups[1].parts[0].tokens + groups[1].parts[1].tokens);
  // Gruppen ohne Zeilen tauchen nicht auf.
  assert.ok(!groups.some((g) => g.group === 'tools'));
});

test('keine Zeile verschwindet, wenn der Anbieter eine winzige Zahl meldet', () => {
  // Ein lokaler Server meldete im Handlauf 11 Prompt-Tokens fuer einen Prompt
  // mit acht Bausteinen. Ohne Untergrenze runden sieben davon auf 0 und
  // fallen aus der Liste — samt der Skills, wegen derer man hinsieht.
  const parts = Array.from({ length: 8 }, (_, i) =>
    part({ id: `p${i}`, chars: i === 0 ? 40000 : 200 })
  );
  const breakdown = createContextBreakdown({ parts, promptTokens: 11 });

  assert.equal(breakdown.parts.length, 8);
  assert.ok(breakdown.parts.every((row) => row.tokens >= 1));
  assert.equal(breakdown.parts.reduce((sum, row) => sum + row.tokens, 0), 11);
});

/* ── Teiler je Anbieter (Issue #178) ───────────────────────────────────────── */

// Messung vom 2026-09-18 (gpt-tokenizer, o200k_base) ueber alle eingebauten
// Tool-Schemas dieses Repos. Die Zahl ist die Messlatte: Das o200k-Profil muss
// sie auf ~10 % genau treffen, sonst zeigt die Aufschluesselung wieder eine
// Tool-Zeile, an der man sich nicht orientieren kann.
const O200K_TOOL_SCHEMA_CHARS = 17210;
const O200K_TOOL_SCHEMA_TOKENS = 4154;

test('gleiche Zeichenzahl, je nach Anbieter eine andere Schaetzung (#178)', () => {
  const chars = O200K_TOOL_SCHEMA_CHARS;
  const lokal = estimateTokensFromChars(chars, CONTEXT_CONTENT_KINDS.JSON, 'mlx-lm');
  const openai = estimateTokensFromChars(chars, CONTEXT_CONTENT_KINDS.JSON, 'openai');

  assert.ok(lokal > openai * 1.5, `${lokal} (lokal) muss deutlich ueber ${openai} (OpenAI) liegen`);
  // Ohne Anbieter bleibt es beim konservativen Standardprofil — genau das, was
  // alle Aufrufer ohne Anbieter-Kontext (Tests, Altlasten) erwarten duerfen.
  assert.equal(estimateTokensFromChars(chars, CONTEXT_CONTENT_KINDS.JSON), lokal);
  // Anthropic und Google haben bewusst kein eigenes Profil: ungemessen faellt
  // ein Anbieter auf das konservativere zurueck, statt auf eine erfundene Zahl.
  assert.equal(CHARS_PER_TOKEN_PROFILE_BY_PROVIDER.anthropic, undefined);
  assert.equal(
    estimateTokensFromChars(chars, CONTEXT_CONTENT_KINDS.JSON, 'anthropic'),
    lokal
  );
  assert.deepEqual(charsPerTokenProfile('google'), charsPerTokenProfile('ollama'));
});

test('eine Server-URL auf diesem Rechner sticht das ID-Profil (#193)', () => {
  const lokal = charsPerTokenProfile('mlx-lm');
  // Der generische Anbieter hat kein eigenes ID-Profil; entfernt bleibt es beim
  // konservativen Standard, lokal gilt das gemessene local-Profil.
  assert.deepEqual(charsPerTokenProfile('openai-compatible'), lokal);
  assert.deepEqual(
    charsPerTokenProfile('openai-compatible', { baseUrl: 'http://localhost:1234/v1' }),
    lokal
  );
  // Auch ein fest verdrahteter Anbieter, den jemand auf localhost zeigen
  // laesst, spricht dann mit einem lokal geladenen Modell.
  assert.notDeepEqual(charsPerTokenProfile('openai'), lokal);
  assert.deepEqual(charsPerTokenProfile('openai', { baseUrl: 'http://127.0.0.1:8080/v1' }), lokal);
});

test('die OpenAI-Schaetzung trifft die Tokenizer-Messung auf 10 % (#178)', () => {
  const geschaetzt = estimateTokensFromChars(
    O200K_TOOL_SCHEMA_CHARS,
    CONTEXT_CONTENT_KINDS.JSON,
    'openai'
  );
  const abweichung = Math.abs(geschaetzt - O200K_TOOL_SCHEMA_TOKENS) / O200K_TOOL_SCHEMA_TOKENS;
  assert.ok(abweichung <= 0.1, `${geschaetzt} statt ${O200K_TOOL_SCHEMA_TOKENS} (${abweichung})`);

  // Der alte globale Teiler 2,3 lag um rund 80 % daneben — das ist der Fehler,
  // den Issue #178 behebt; er darf nicht unbemerkt zurueckkommen.
  const alt = estimateTokensFromChars(
    O200K_TOOL_SCHEMA_CHARS,
    CONTEXT_CONTENT_KINDS.JSON,
    'mlx-lm'
  );
  assert.ok(alt / O200K_TOOL_SCHEMA_TOKENS > 1.5);
});

test('das Anbieter-Profil verschiebt Gewichte, nicht die Gesamtzahl (#178)', () => {
  const parts = [
    part({
      id: 'tools',
      group: CONTEXT_PART_GROUPS.TOOLS,
      chars: 17210,
      contentKind: CONTEXT_CONTENT_KINDS.JSON,
    }),
    part({
      id: 'verlauf',
      group: CONTEXT_PART_GROUPS.HISTORY,
      chars: 17210,
      contentKind: CONTEXT_CONTENT_KINDS.PROSE,
    }),
  ];
  const toolTokens = (breakdown) => breakdown.parts.find((row) => row.id === 'tools').tokens;

  const lokal = createContextBreakdown({ parts, promptTokens: 10000, providerId: 'mlx-lm' });
  const openai = createContextBreakdown({ parts, promptTokens: 10000, providerId: 'openai' });

  // Skaliert wird weiterhin auf 100 % der echten Zahl — beide Male.
  for (const breakdown of [lokal, openai]) {
    assert.equal(breakdown.scaled, true);
    assert.equal(breakdown.total, 10000);
    assert.equal(
      breakdown.parts.reduce((sum, row) => sum + row.tokens, 0),
      10000
    );
  }

  // Bei OpenAI wiegen gleich viele Zeichen JSON und Prosa fast gleich schwer,
  // beim lokalen Profil dominiert das JSON — genau der Unterschied, der die
  // Anzeige bisher in die Irre gefuehrt hat.
  assert.ok(toolTokens(lokal) > toolTokens(openai));
  assert.ok(Math.abs(toolTokens(openai) - 5000) < 250, `${toolTokens(openai)}`);
  assert.ok(toolTokens(lokal) > 6000, `${toolTokens(lokal)}`);
});
