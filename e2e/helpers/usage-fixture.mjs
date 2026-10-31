// A history to look at the usage report with (#1258): chats in three folders
// and one without, five models — one without a known price, one on the
// user's own machine —, spending spread over the last six weeks, and one chat
// from before #1258 that carries a total without days.
//
// Written as the single `chat-history.json` of older releases: the app moves
// it into its folder on the first start, cost and days included. The days are
// counted back from `now`, so the presets always find something.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** USD per million tokens: input, output, cache read. */
const PRICES = {
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'claude-sonnet-4-5': [3, 15, 0.3],
};

const PROVIDERS = {
  'gpt-5': 'openai',
  'gpt-5-mini': 'openai',
  'claude-sonnet-4-5': 'anthropic',
  'qwen3:14b': 'ollama',
  'acme/reviewer-large': 'openai-compatible',
};

const pad = (n) => String(n).padStart(2, '0');

/** The local day `daysAgo` before `now`, as `YYYY-MM-DD`. */
export function dayBefore(now, daysAgo) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** One model's spending: `k` thousand input tokens, a tenth of that as output. */
function spend(model, k, rounds) {
  const input = k * 1000;
  const cacheRead = Math.round(input * 0.4);
  const output = Math.round(input * 0.1);
  const reasoning = model.startsWith('gpt-5') ? Math.round(output * 0.3) : 0;
  const tokens = { input: input - cacheRead, cacheRead, cacheWrite: 0, output, reasoning };
  const price = PRICES[model];
  const local = model === 'qwen3:14b';
  const usd = price
    ? { input: tokens.input * price[0] / 1e6, cacheRead: cacheRead * price[2] / 1e6, cacheWrite: 0, output: output * price[1] / 1e6 }
    : local ? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } : null;
  return {
    providerId: PROVIDERS[model],
    model,
    tokens,
    usd,
    priceSource: usd ? (local ? 'local' : 'table') : null,
    rounds,
    unpricedRounds: usd ? 0 : rounds,
  };
}

function sum(entries) {
  const byModel = new Map();
  for (const entry of entries) {
    const prev = byModel.get(entry.model);
    if (!prev) {
      byModel.set(entry.model, structuredClone(entry));
      continue;
    }
    for (const key of Object.keys(prev.tokens)) prev.tokens[key] += entry.tokens[key];
    if (prev.usd && entry.usd) for (const key of Object.keys(prev.usd)) prev.usd[key] += entry.usd[key];
    prev.rounds += entry.rounds;
    prev.unpricedRounds += entry.unpricedRounds;
  }
  return [...byModel.values()];
}

const TEXT = {
  en: {
    garden: [
      'Crop rotation for next year',
      'Sowing calendar as JSON',
      'Spacing of the radishes',
      'Garden Planner overview',
    ],
    website: ['Navigation for the new site', 'Accessibility check of the forms', 'Review of the contact page'],
    thesis: ['Literature list for chapter 3', 'Outline of the method chapter'],
    loose: ['Summarise the meeting notes'],
    folders: ['website-relaunch', 'thesis'],
  },
  de: {
    garden: [
      'Fruchtfolge fürs nächste Jahr',
      'Aussaatkalender als JSON',
      'Abstand der Radieschen',
      'Überblick Gartenplaner',
    ],
    website: ['Navigation der neuen Website', 'Barrierefreiheit der Formulare', 'Review der Kontaktseite'],
    thesis: ['Literaturliste für Kapitel 3', 'Gliederung des Methodenkapitels'],
    loose: ['Besprechungsnotizen zusammenfassen'],
    folders: ['website-relaunch', 'masterarbeit'],
  },
};

/** The names of the two further folders in this language. */
export function usageFolderNames(locale = 'en') {
  return TEXT[locale === 'de' ? 'de' : 'en'].folders;
}

/**
 * The chats: `[title index, folder, turns]`, each turn `[days ago, ...spending]`.
 * `legacy` keeps a total without days, last used `legacy` days ago. `kind` is
 * the chat's kind of task (#1283) as `[id, source]`; two chats have none.
 */
function plan() {
  return [
    { group: 'garden', title: 0, kind: ['planning', 'model'], turns: [[1, spend('gpt-5', 260, 6)], [3, spend('gpt-5', 180, 4)]] },
    { group: 'garden', title: 1, kind: ['coding', 'model'], turns: [[6, spend('gpt-5', 220, 5), spend('claude-sonnet-4-5', 90, 2)], [9, spend('claude-sonnet-4-5', 120, 3)]] },
    { group: 'garden', title: 2, kind: ['research', 'estimate'], turns: [[12, spend('gpt-5-mini', 150, 3)]] },
    { group: 'garden', title: 3, legacy: 20, turns: [[0, spend('gpt-5', 140, 3)]] },
    { group: 'website', title: 0, kind: ['coding', 'model'], turns: [[2, spend('claude-sonnet-4-5', 160, 4)], [4, spend('claude-sonnet-4-5', 110, 3)], [5, spend('gpt-5-mini', 60, 2)]] },
    { group: 'website', title: 1, kind: ['coding', 'user'], turns: [[8, spend('gpt-5', 190, 4)]] },
    { group: 'website', title: 2, kind: ['coding', 'model'], turns: [[3, spend('acme/reviewer-large', 70, 2)]] },
    { group: 'thesis', title: 0, kind: ['writing', 'model'], turns: [[15, spend('gpt-5-mini', 210, 5)], [16, spend('gpt-5-mini', 90, 2)]] },
    { group: 'thesis', title: 1, kind: ['research', 'model'], turns: [[3, spend('qwen3:14b', 120, 4)], [10, spend('qwen3:14b', 80, 3)]] },
    { group: 'loose', title: 0, kind: ['writing', 'model'], turns: [[11, spend('gpt-5-mini', 40, 1)]] },
    // Outside 30 days: only "All time" and "Last month" may find it.
    { group: 'garden', title: 2, id: 'usage-old-spacing', turns: [[38, spend('gpt-5', 120, 3)]] },
  ];
}

const message = (role, content) => ({ role, content });

/**
 * Writes the history. `folders` are the real paths of the three folders, the
 * main one (the demo project) first.
 *
 * @returns {{ chats: Array<{ id: string, title: string, workspaceRoot: string|null }> }}
 */
export async function writeUsageHistory(userDataDir, { folders, locale = 'en', now = Date.now() }) {
  const text = TEXT[locale === 'de' ? 'de' : 'en'];
  const roots = { garden: folders[0], website: folders[1], thesis: folders[2], loose: null };
  const sessions = [];
  plan().forEach((chat, index) => {
    const title = text[chat.group][chat.title];
    const id = chat.id || `usage-chat-${pad(index)}`;
    const entries = chat.turns.flatMap(([, ...models]) => models);
    const cost = {
      version: 1,
      models: sum(entries),
      priceTable: { date: dayBefore(now, 10), origin: 'bundled' },
    };
    const newest = Math.min(...chat.turns.map(([ago]) => ago));
    let updatedAt = new Date(`${dayBefore(now, newest)}T12:00:00`).getTime();
    if (chat.legacy) {
      // Saved before #1258: a total, no days, last used `legacy` days ago.
      updatedAt = new Date(`${dayBefore(now, chat.legacy)}T12:00:00`).getTime();
    } else {
      cost.days = chat.turns.flatMap(([ago, ...models]) => models.map((entry) => ({ date: dayBefore(now, ago), ...entry })));
    }
    sessions.push({
      id,
      workspaceRoot: roots[chat.group],
      title,
      updatedAt,
      messages: [message('user', title), message('assistant', '…')],
      cost,
      ...(chat.kind ? { taskKind: { id: chat.kind[0], source: chat.kind[1], at: new Date(updatedAt).toISOString() } } : {}),
    });
  });
  const store = { version: 2, activeByWorkspace: {}, sessions };
  await writeFile(path.join(userDataDir, 'chat-history.json'), JSON.stringify(store), 'utf8');
  return { chats: sessions.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })) };
}
