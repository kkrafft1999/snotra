#!/usr/bin/env node
/**
 * Renews the price snapshot that ships with the app (#949):
 * src/main/data/model-prices.json.
 *
 *   node scripts/update-model-prices.js            # fetch from LiteLLM
 *   node scripts/update-model-prices.js file.json  # use a file downloaded before
 *
 * The snapshot keeps only the chat models of the providers Snotra talks to,
 * five prices each (contracts/cost.js, trimLiteLlmPrices). Run it before a
 * release when prices have moved; the diff shows what changed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { LITELLM_PRICES_URL, trimLiteLlmPrices } = require('../src/shared/contracts/cost');

const target = path.join(__dirname, '..', 'src', 'main', 'data', 'model-prices.json');

async function readSource(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(LITELLM_PRICES_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${LITELLM_PRICES_URL}`);
  return res.json();
}

async function main() {
  const trimmed = trimLiteLlmPrices(await readSource(process.argv[2]));
  if (!trimmed) throw new Error('The source does not look like LiteLLM\'s price table.');
  const sorted = Object.fromEntries(Object.entries(trimmed.models).sort(([a], [b]) => a.localeCompare(b)));
  const snapshot = {
    source: LITELLM_PRICES_URL,
    license: 'MIT, (c) 2023 Berri AI — see model-prices-LICENSE.txt',
    date: new Date().toISOString().slice(0, 10),
    models: sorted,
  };
  fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`${Object.keys(sorted).length} models → ${path.relative(process.cwd(), target)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
