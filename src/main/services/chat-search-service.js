'use strict';

/**
 * The model's look into earlier chats (#1315): `search_chats`, behind
 * `application/ports/chat-search-port.js`.
 *
 * The chats are the episodic memory (knowledge concept, *Episodes*), and they
 * are read here under three boundaries:
 *
 * - **The open workspace.** Only chats kept under the run's folder are
 *   searched; with no folder open, the chats without one. A chat of another
 *   folder — a customer project, say — does not exist for this search, the
 *   same boundary as for the folder's memory.
 * - **Not the asking chat.** Its own messages are in the prompt already.
 * - **Local chats stay local** (decision 13). A chat whose turns all ran on a
 *   model on this computer is found only from a turn that is local itself and
 *   from a chat that never went to the cloud. For any other turn such a chat is
 *   left out before anything is searched, and nothing in the answer counts what
 *   was left out — a count would itself tell the provider something.
 *
 * Keyword search: a chat is found when every word of the query occurs in its
 * title or its messages, case-insensitive. The answer carries excerpts with
 * title, date and the chat's reference; `read` gives more of one chat, within
 * a size limit. Everything goes back as JSON, as data: the adapter checks it
 * for secrets and the engine for injections like any other tool result.
 */

const { CHAT_LOCALITY } = require('./chat-history-normalization');

const LIMITS = Object.freeze({
  /** Chats in one answer, unless the model asks for fewer or more. */
  DEFAULT_RESULTS: 5,
  MAX_RESULTS: 10,
  /** Words of a query that count; a longer query finds nothing anyway. */
  MAX_WORDS: 8,
  /** Excerpts per chat, and how long each is. */
  EXCERPTS_PER_CHAT: 3,
  EXCERPT_CHARS: 280,
  /** What one `read` returns at most, and of one message. */
  READ_CHARS: 12_000,
  MESSAGE_CHARS: 6_000,
});

/** The answer for a chat that is not there for this search — whatever the reason. */
const NOT_FOUND = 'There is no earlier chat with this reference in this folder. Take `chat` from a search result.';

/**
 * @typedef {import('../ports/chat-history-store-port').ChatHistoryStorePort} ChatHistoryStorePort
 * @typedef {import('./chat-history-normalization').SessionMeta} SessionMeta
 * @typedef {import('../../application/ports/chat-search-port').ChatSearchScope} ChatSearchScope
 * @typedef {{ index: number, role: string, text: string }} ChatLine
 */

/**
 * The words of a query, lower case, without the punctuation around them.
 *
 * @param {unknown} query
 * @returns {string[]}
 */
function queryWords(query) {
  if (typeof query !== 'string') return [];
  const words = query
    .normalize('NFC')
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    .filter((word) => word.length > 0);
  return [...new Set(words)].slice(0, LIMITS.MAX_WORDS);
}

/**
 * The messages of a chat that carry text: what the user wrote and what the
 * model answered, numbered as `read` numbers them. Error messages and tool
 * steps are not part of it.
 *
 * @param {unknown} messages
 * @returns {ChatLine[]}
 */
function chatLines(messages) {
  if (!Array.isArray(messages)) return [];
  /** @type {ChatLine[]} */
  const lines = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { role, content, isError } = /** @type {Record<string, unknown>} */ (message);
    if ((role !== 'user' && role !== 'assistant') || isError === true) continue;
    if (typeof content !== 'string' || !content.trim()) continue;
    lines.push({ index: lines.length, role, text: content });
  }
  return lines;
}

/**
 * A piece of the text around the first word found in it.
 *
 * @param {string} text
 * @param {string} lower  the same text in lower case
 * @param {string[]} words
 */
function excerptOf(text, lower, words) {
  const positions = words.map((word) => lower.indexOf(word)).filter((at) => at >= 0);
  const first = positions.length > 0 ? Math.min(...positions) : 0;
  const flat = (/** @type {string} */ value) => value.replace(/\s+/g, ' ').trim();
  if (text.length <= LIMITS.EXCERPT_CHARS) return flat(text);
  let start = Math.max(0, first - Math.floor(LIMITS.EXCERPT_CHARS / 3));
  let end = Math.min(text.length, start + LIMITS.EXCERPT_CHARS);
  start = Math.max(0, end - LIMITS.EXCERPT_CHARS);
  // At a word boundary, not in the middle of a word.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > first) end = space;
  }
  return `${start > 0 ? '…' : ''}${flat(text.slice(start, end))}${end < text.length ? '…' : ''}`;
}

/** @param {SessionMeta} meta */
function titleOf(meta) {
  return meta.title || '(untitled)';
}

/** @param {SessionMeta} meta */
function dateOf(meta) {
  return Number.isFinite(meta.updatedAt) && meta.updatedAt > 0 ? new Date(meta.updatedAt).toISOString() : null;
}

/**
 * @param {object} deps
 * @param {Pick<ChatHistoryStorePort, 'listSessions' | 'getSessionMeta' | 'getSession' | 'normalizeWorkspaceRoot' | 'sessionMatchesWorkspace'>} deps.chatHistoryStore
 * @param {(presetId: string|null) => Promise<{ runsLocally: boolean }|null>} deps.describeModel
 *   where a chat's model runs, for a chat saved before #1315: such a chat counts
 *   as local when its current model is local
 * @param {{ warn?: (message: string) => void }|null} [deps.log]
 * @returns {import('../../application/ports/chat-search-port').ChatSearchPort}
 */
function createChatSearchService({ chatHistoryStore, describeModel, log = console }) {
  /**
   * Whether a chat is local (decision 13). A chat with a marker says so; one
   * from before #1315 goes by its current model. A model that cannot be
   * resolved counts as local: wrongly hidden is the cheaper mistake.
   *
   * @param {SessionMeta} meta
   * @param {Map<string, Promise<boolean>>} byModel  one look per model entry and search
   */
  function isLocalChat(meta, byModel) {
    if (meta.locality === CHAT_LOCALITY.CLOUD) return Promise.resolve(false);
    if (meta.locality === CHAT_LOCALITY.LOCAL) return Promise.resolve(true);
    const presetId = typeof meta.modelPresetId === 'string' && meta.modelPresetId ? meta.modelPresetId : null;
    const key = presetId ?? '';
    let known = byModel.get(key);
    if (!known) {
      known = describeModel(presetId)
        .then((model) => (model ? model.runsLocally === true : true))
        .catch((error) => {
          log?.warn?.(`[chat-search] the model of a chat could not be resolved: ${error?.message || error}`);
          return true;
        });
      byModel.set(key, known);
    }
    return known;
  }

  /**
   * The chats this request may see: the folder's, not the asking one, and the
   * local ones only for a local asker. Newest first.
   *
   * @param {ChatSearchScope} scope
   * @returns {Promise<SessionMeta[]>}
   */
  async function visibleChats({ workspaceRoot, chatId, runsLocally }) {
    const root = chatHistoryStore.normalizeWorkspaceRoot(workspaceRoot);
    const all = /** @type {SessionMeta[]} */ (await chatHistoryStore.listSessions());
    const inFolder = all.filter((meta) => meta.id !== chatId && chatHistoryStore.sessionMatchesWorkspace(meta, root));
    // A local turn in a chat that went to the cloud before is not a local
    // chat: what it finds would leave with the next cloud turn.
    const asker = chatId ? all.find((meta) => meta.id === chatId) : null;
    const askerIsLocal = runsLocally === true && asker?.locality !== CHAT_LOCALITY.CLOUD;
    if (askerIsLocal) return inFolder;
    /** @type {Map<string, Promise<boolean>>} */
    const byModel = new Map();
    const local = await Promise.all(inFolder.map((meta) => isLocalChat(meta, byModel)));
    return inFolder.filter((_meta, i) => !local[i]);
  }

  /** @type {import('../../application/ports/chat-search-port').ChatSearchPort['search']} */
  async function search({ query, limit, ...scope }) {
    const words = queryWords(query);
    if (words.length === 0) return { error: 'Give one or more words to search for in `query`.' };
    const max = Number.isInteger(limit) && /** @type {number} */ (limit) > 0
      ? Math.min(/** @type {number} */ (limit), LIMITS.MAX_RESULTS)
      : LIMITS.DEFAULT_RESULTS;
    const scopeName = scope.workspaceRoot ? 'this folder' : 'the chats without a folder';
    const results = [];
    let more = false;
    for (const meta of await visibleChats(scope)) {
      const session = await chatHistoryStore.getSession(meta.id);
      if (!session) continue;
      const lines = chatLines(session.messages);
      const title = titleOf(meta);
      const haystack = [title, ...lines.map((line) => line.text)].join('\n').toLocaleLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      if (results.length === max) {
        more = true;
        break;
      }
      const hits = lines
        .map((line) => {
          const lower = line.text.toLocaleLowerCase();
          return { line, lower, found: words.filter((word) => lower.includes(word)).length };
        })
        .filter((hit) => hit.found > 0)
        .sort((a, b) => b.found - a.found || a.line.index - b.line.index)
        .slice(0, LIMITS.EXCERPTS_PER_CHAT)
        .sort((a, b) => a.line.index - b.line.index);
      results.push({
        chat: meta.id,
        title,
        date: dateOf(meta),
        messages: lines.length,
        excerpts: hits.map(({ line, lower }) => ({
          message: line.index,
          role: line.role,
          text: excerptOf(line.text, lower, words),
        })),
      });
    }
    if (results.length === 0) {
      return { results, note: `No earlier chat in ${scopeName} contains every word. Try fewer or other words.` };
    }
    return {
      results,
      ...(more ? { more: true } : {}),
      note: `Earlier chats in ${scopeName}, newest first. Read more of one with \`chat\` and \`from\`.`,
    };
  }

  /** @type {import('../../application/ports/chat-search-port').ChatSearchPort['read']} */
  async function read({ chat, from, ...scope }) {
    const id = typeof chat === 'string' ? chat.trim() : '';
    // A chat of another folder, the asking one, or a local one hidden from
    // this turn gets the same answer as one that does not exist.
    const meta = id ? (await visibleChats(scope)).find((candidate) => candidate.id === id) : null;
    const session = meta ? await chatHistoryStore.getSession(meta.id) : null;
    if (!meta || !session) return { error: NOT_FOUND };
    const lines = chatLines(session.messages);
    const start = Number.isInteger(from) && /** @type {number} */ (from) > 0 ? /** @type {number} */ (from) : 0;
    /** @type {Array<ChatLine & { cut?: true }>} */
    const out = [];
    let room = LIMITS.READ_CHARS;
    let next = null;
    for (const line of lines.slice(start)) {
      const allowed = Math.min(LIMITS.MESSAGE_CHARS, room);
      if (out.length > 0 && allowed < Math.min(line.text.length, 200)) {
        next = line.index;
        break;
      }
      if (line.text.length > allowed) {
        out.push({ ...line, text: `${line.text.slice(0, allowed)}…`, cut: true });
      } else {
        out.push(line);
      }
      room -= Math.min(line.text.length, allowed);
      if (room <= 0) {
        next = line.index + 1 < lines.length ? line.index + 1 : null;
        break;
      }
    }
    return {
      chat: meta.id,
      title: titleOf(meta),
      date: dateOf(meta),
      total: lines.length,
      messages: out,
      next,
    };
  }

  return { search, read };
}

module.exports = { createChatSearchService, queryWords, CHAT_SEARCH_LIMITS: LIMITS };
