'use strict';

/**
 * Turns run files into numbers (#186): one summary per run, and a paired
 * comparison of two runs over the same tasks.
 */

const fs = require('node:fs');

function readRun(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const [meta, ...records] = lines;
  if (meta?.type !== 'meta') throw new Error(`${file}: first line is not the run header`);
  return { meta, records };
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const rate = (flags) => (flags.length ? flags.filter(Boolean).length / flags.length : null);
const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)} %`);
const num = (value, digits = 1) => (value === null ? '—' : value.toFixed(digits));

function summarise(records) {
  const positives = records.filter((r) => r.kind === 'positive');
  const negatives = records.filter((r) => r.kind === 'negative');
  const choicePositives = positives.filter((r) => r.score.toolChoice);
  return {
    runs: records.length,
    positives: positives.length,
    negatives: negatives.length,
    correct: rate(records.map((r) => r.score.correct)),
    toolChoicePositive: rate(positives.map((r) => r.score.toolChoice)),
    // Arguments only where the tool was right — otherwise a wrong tool counts twice.
    paramsGivenChoice: rate(choicePositives.map((r) => r.score.params && r.score.files !== false)),
    negativeClean: rate(negatives.map((r) => r.score.correct)),
    unexpectedWrites: records.filter((r) => r.score.unexpectedWrite).length,
    aborted: records.filter((r) => r.aborted).length,
    rounds: mean(records.map((r) => r.rounds)),
    toolCalls: mean(records.map((r) => r.calls.length)),
    toolErrors: mean(records.map((r) => r.toolErrors ?? 0)),
    promptTokens: mean(records.map((r) => r.tokens.prompt)),
    firstRoundPromptTokens: mean(records.map((r) => r.tokens.firstRoundPrompt).filter((v) => v !== null)),
    cachedTokens: mean(records.map((r) => r.tokens.cached)),
    schemaViolations: records.reduce((n, r) => n + r.schemaViolations, 0),
  };
}

function formatSummary(meta, summary) {
  return [
    `${meta.label} — arm ${meta.arm}, ${meta.model} · ${meta.effort}, ${summary.runs} runs ` +
      `(${summary.positives} positive, ${summary.negatives} negative)`,
    `  correct overall          ${pct(summary.correct)}`,
    `  right tool (positives)   ${pct(summary.toolChoicePositive)}`,
    `  right arguments | tool   ${pct(summary.paramsGivenChoice)}`,
    `  negatives clean          ${pct(summary.negativeClean)}`,
    `  unexpected writes        ${summary.unexpectedWrites}`,
    `  aborted                  ${summary.aborted}`,
    `  rounds per task          ${num(summary.rounds, 2)}`,
    `  tool calls per task      ${num(summary.toolCalls, 2)}`,
    `  failed calls per task    ${num(summary.toolErrors, 2)}`,
    `  prompt tokens per task   ${num(summary.promptTokens, 0)} (first round ${num(summary.firstRoundPromptTokens, 0)}, cached ${num(summary.cachedTokens, 0)})`,
    `  schema violations        ${summary.schemaViolations}`,
  ].join('\n');
}

/** Two-sided exact McNemar test on the discordant pairs. */
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let coefficient = 1; // C(n, 0)
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    tail += coefficient;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

function pairUp(a, b) {
  const key = (r) => `${r.id}#${r.rep}`;
  const byKey = new Map(b.map((r) => [key(r), r]));
  return a.filter((r) => byKey.has(key(r))).map((r) => [r, byKey.get(key(r))]);
}

function comparePaired(recordsA, recordsB) {
  const pairs = pairUp(recordsA, recordsB);
  const metric = (name, pick, filter = () => true) => {
    const kept = pairs.filter(([x]) => filter(x));
    let onlyA = 0;
    let onlyB = 0;
    const flipped = [];
    for (const [x, y] of kept) {
      const va = pick(x);
      const vb = pick(y);
      if (va && !vb) onlyA += 1;
      if (!va && vb) onlyB += 1;
      if (va !== vb) flipped.push({ id: x.id, a: va, b: vb });
    }
    return {
      name,
      n: kept.length,
      rateA: rate(kept.map(([x]) => pick(x))),
      rateB: rate(kept.map(([, y]) => pick(y))),
      onlyA,
      onlyB,
      flipRate: kept.length ? flipped.length / kept.length : null,
      p: mcnemarExact(onlyA, onlyB),
      flipped,
    };
  };
  const paired = (pick) => mean(pairs.map(([x, y]) => pick(y) - pick(x)));
  return {
    pairs: pairs.length,
    binary: [
      metric('correct overall', (r) => r.score.correct),
      metric('right tool (positives)', (r) => r.score.toolChoice, (r) => r.kind === 'positive'),
      metric('fully correct (positives)', (r) => r.score.correct, (r) => r.kind === 'positive'),
      metric('negatives clean', (r) => r.score.correct, (r) => r.kind === 'negative'),
      metric('probed tasks correct', (r) => r.score.correct, (r) => Boolean(r.probes)),
      metric('no unexpected write', (r) => !r.score.unexpectedWrite),
      metric('not aborted', (r) => !r.aborted),
    ],
    roundsDelta: paired((r) => r.rounds),
    toolErrorsDelta: paired((r) => r.toolErrors ?? 0),
    promptTokensDelta: paired((r) => r.tokens.prompt),
    firstRoundPromptDelta: paired((r) => r.tokens.firstRoundPrompt ?? 0),
  };
}

function formatComparison(metaA, metaB, comparison, { verbose = false } = {}) {
  const lines = [
    `A = ${metaA.label} (${metaA.arm}), B = ${metaB.label} (${metaB.arm}), ${comparison.pairs} pairs`,
    '',
    '  metric                       n     A        B        A only  B only  flips    p (McNemar)',
  ];
  for (const m of comparison.binary) {
    lines.push(
      `  ${m.name.padEnd(28)} ${String(m.n).padStart(4)}  ${pct(m.rateA).padStart(7)}  ${pct(m.rateB).padStart(7)}` +
        `  ${String(m.onlyA).padStart(6)}  ${String(m.onlyB).padStart(6)}  ${pct(m.flipRate).padStart(7)}  ${m.p.toFixed(3)}`
    );
  }
  lines.push(
    '',
    `  rounds per task, B − A          ${num(comparison.roundsDelta, 2)}`,
    `  failed calls per task, B − A    ${num(comparison.toolErrorsDelta, 2)}`,
    `  prompt tokens per task, B − A   ${num(comparison.promptTokensDelta, 0)}`,
    `  first-round prompt, B − A       ${num(comparison.firstRoundPromptDelta, 0)}`
  );
  if (verbose) {
    const flips = comparison.binary[0].flipped;
    if (flips.length) {
      lines.push('', '  tasks that flipped (correct overall):');
      for (const f of flips) lines.push(`    ${f.id.padEnd(32)} A ${f.a ? 'ok' : 'FAIL'}  B ${f.b ? 'ok' : 'FAIL'}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  comparePaired,
  formatComparison,
  formatSummary,
  mcnemarExact,
  readRun,
  summarise,
};
