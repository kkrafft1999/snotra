#!/usr/bin/env node
'use strict';

/**
 * Paired comparison of two runs over the same tasks (#186).
 *
 *   node bench/tool-accuracy/compare.js <run-a.jsonl> <run-b.jsonl> [--verbose]
 *
 * For an A/A pair the flip rate is the noise floor; an A/B difference only
 * means something where it clearly exceeds it.
 */

const { comparePaired, formatComparison, formatSummary, readRun, summarise } = require('./report');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length !== 2) {
  console.error('Usage: node bench/tool-accuracy/compare.js <run-a.jsonl> <run-b.jsonl> [--verbose]');
  process.exit(2);
}

const a = readRun(files[0]);
const b = readRun(files[1]);
if (a.meta.taskSet !== b.meta.taskSet) {
  console.warn(`Warning: the runs used different task sets (${a.meta.taskSet} vs ${b.meta.taskSet}).\n`);
}
console.log(formatSummary(a.meta, summarise(a.records)));
console.log();
console.log(formatSummary(b.meta, summarise(b.records)));
console.log();
console.log(formatComparison(a.meta, b.meta, comparePaired(a.records, b.records), { verbose }));
