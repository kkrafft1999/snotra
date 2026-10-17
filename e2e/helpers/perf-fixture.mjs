// The data the performance report measures against (#984): a chat history of
// 200 sessions and a workspace at the size limits the app is built for.
//
// Everything is generated from a fixed seed, so two runs measure the same
// bytes. The history is written in plain JSON; the app encrypts it on its
// first start, which is why the report starts it once before it measures.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Folders the workspace holds below `src/` — LIMITS.MAX_WATCHED_DIRECTORIES. */
export const WATCHED_FOLDERS = 2000;
/** Entries in `many/` — more than READ_DIRECTORY_MAX_ENTRIES (2000) lists. */
export const MANY_ENTRIES = 2100;

/** The marker the last answer of each named chat ends with. */
export const LONG_CHAT_END = 'perf-long-chat-end';
export const ACTIVE_CHAT_END = 'perf-active-chat-end';
export const STREAM_END = 'perf-stream-end';

// mulberry32: small, fast, and the same sequence on every platform.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'the folder report draft meeting notes budget plan review customer project summary chapter '
  + 'section table figure version change request answer question source quote numbers week month '
  + 'quarter result risk owner decision follow-up deadline estimate scope goal team proposal contract '
  + 'invoice offer timeline milestone feedback agenda minutes outline paragraph sentence term'
).split(' ');

function sentence(rand, words = 8 + Math.floor(rand() * 10)) {
  const text = Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function paragraph(rand, sentences = 3 + Math.floor(rand() * 3)) {
  return Array.from({ length: sentences }, () => sentence(rand)).join(' ');
}

/**
 * An answer the way a model writes one: a heading, prose, a list, and a code
 * block — work for the Markdown renderer and the syntax highlighting alike.
 * About 1.3 KB.
 */
function answer(rand, index) {
  return [
    `## ${sentence(rand, 3).slice(0, -1)} ${index}`,
    paragraph(rand),
    ['- ', '- ', '- '].map((bullet) => `${bullet}${sentence(rand, 6)}`).join('\n'),
    '```js',
    `function step${index}(items) {`,
    '  const seen = new Set();',
    '  for (const item of items) {',
    `    if (item.weight > ${Math.floor(rand() * 100)}) seen.add(item.name);`,
    '  }',
    '  return [...seen].sort();',
    '}',
    '```',
    paragraph(rand),
  ].join('\n\n');
}

function messages(rand, pairs, endMarker) {
  const out = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push({ role: 'user', content: sentence(rand) });
    out.push({ role: 'assistant', content: answer(rand, i) });
  }
  if (endMarker) out[out.length - 1].content += `\n\n${endMarker}`;
  return out;
}

/**
 * A workspace at the limits: `src/` with 2000 folders in 50 groups, one note
 * in each — the most the workspace watcher holds on Linux — and `many/` with
 * more files than one folder listing shows.
 */
export async function writeLargeWorkspace(workspace) {
  await writeFile(path.join(workspace, 'README.md'), '# Performance fixture\n', 'utf8');
  const groups = 50;
  const perGroup = WATCHED_FOLDERS / groups;
  const folders = [];
  for (let g = 0; g < groups; g += 1) {
    for (let f = 0; f < perGroup; f += 1) {
      folders.push(path.join(workspace, 'src', `group-${String(g).padStart(2, '0')}`, `folder-${String(f).padStart(2, '0')}`));
    }
  }
  for (let i = 0; i < folders.length; i += 200) {
    await Promise.all(folders.slice(i, i + 200).map(async (dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'notes.md'), '# Notes\n', 'utf8');
    }));
  }
  const many = path.join(workspace, 'many');
  await mkdir(many);
  const names = Array.from({ length: MANY_ENTRIES }, (_, i) => `entry-${String(i).padStart(5, '0')}.txt`);
  for (let i = 0; i < names.length; i += 500) {
    await Promise.all(names.slice(i, i + 500).map((name) => writeFile(path.join(many, name), '', 'utf8')));
  }
  return { many };
}

/**
 * 200 sessions in the workspace. The most recent one is open when the app
 * starts; the second one is the long chat of 200 messages a switch is
 * measured on. The rest carry 4 to 16 messages each. `workspace` must be the
 * real path: the store keys sessions by it.
 */
export async function writeSeededHistory(userDataDir, workspace, { sessions = 200, longChatMessages = 200 } = {}) {
  const rand = random(984);
  const now = Date.now();
  const rows = [];
  const activeId = 'perf-active-chat';
  const longId = 'perf-long-chat';
  rows.push({ id: activeId, workspaceRoot: workspace, title: 'Quarterly report outline', updatedAt: now - 60_000, messages: messages(rand, 6, ACTIVE_CHAT_END) });
  rows.push({ id: longId, workspaceRoot: workspace, title: 'Long project thread', updatedAt: now - 120_000, messages: messages(rand, longChatMessages / 2, LONG_CHAT_END) });
  for (let i = 2; i < sessions; i += 1) {
    rows.push({
      id: `perf-chat-${String(i).padStart(3, '0')}`,
      workspaceRoot: workspace,
      title: sentence(rand, 4).slice(0, -1),
      updatedAt: now - (i + 1) * 3_600_000,
      messages: messages(rand, 2 + Math.floor(rand() * 7)),
    });
  }
  const store = { version: 2, activeByWorkspace: { [workspace]: activeId }, sessions: rows };
  const json = JSON.stringify(store);
  await writeFile(path.join(userDataDir, 'chat-history.json'), json, 'utf8');
  return { activeId, longId, bytes: Buffer.byteLength(json) };
}

/** A streamed answer of about `bytes`, ending in STREAM_END. */
export function longAnswer(bytes) {
  const rand = random(998);
  const parts = [];
  let size = 0;
  for (let i = 0; size < bytes; i += 1) {
    const part = answer(rand, i);
    parts.push(part);
    size += part.length + 2;
  }
  return `${parts.join('\n\n')}\n\n${STREAM_END}`;
}
