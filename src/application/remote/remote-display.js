'use strict';

/**
 * What a remote front end is shown of a chat (#1194;
 * docs/remote-interface.md §8.1 `DisplayMessage`, §8.2): what the desktop
 * shows, not what it stores — the text, the tool lines as the desktop worded
 * them (decided 2026-10-20: in the desktop's language, since the history
 * keeps no arguments to word them again), images as placeholders. No tool
 * arguments, schemas, results, sandbox details or reasoning of stored turns.
 */

const { isRecord } = require('../../shared/runtime/is-record');

/** The `progress` types a remote hears of; `chat-saved` and `chat-named` stay with the window. */
const PROGRESS_TYPES = new Set(['phase', 'reasoning', 'workspace', 'permission', 'run-end']);
const MESSAGE_ID = /^m(0|[1-9]\d{0,8})$/;

/** @param {number} index */
const messageId = (index) => `m${index}`;

/**
 * The index a `messageId` names, or null.
 * @param {unknown} id
 */
function messageIndex(id) {
  return typeof id === 'string' && MESSAGE_ID.test(id) ? Number(id.slice(1)) : null;
}

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '');

/**
 * A file change as a line shows it: no id, nothing of its content.
 * @param {unknown} change
 */
function changeOf(change) {
  if (!isRecord(change) || typeof change.relativePath !== 'string') return null;
  return {
    relativePath: change.relativePath,
    status: text(change.status),
    added: Number.isInteger(change.added) ? change.added : 0,
    removed: Number.isInteger(change.removed) ? change.removed : 0,
  };
}

/** @param {unknown} changes */
function changesOf(changes) {
  if (!Array.isArray(changes)) return undefined;
  const out = changes.map(changeOf).filter((c) => c !== null);
  return out.length ? out : undefined;
}

/**
 * A permission audit as the line shows it: who decided and how.
 * @param {unknown} permission
 */
function permissionOf(permission) {
  if (!isRecord(permission)) return undefined;
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of ['decision', 'source', 'response']) if (typeof permission[key] === 'string') out[key] = permission[key];
  return Object.keys(out).length ? out : undefined;
}

/**
 * A stored tool step as a line.
 * @param {unknown} entry
 */
function toolLineOf(entry) {
  if (typeof entry === 'string') return entry ? { line: entry, tool: null, status: 'done' } : null;
  if (!isRecord(entry) || typeof entry.line !== 'string' || !entry.line) return null;
  return { line: entry.line, tool: typeof entry.tool === 'string' ? entry.tool : null, status: 'done' };
}

/**
 * One stored message as the remote shows it.
 * @param {Record<string, unknown>} message  as the window loads it
 * @param {number} index  its place in the chat, which names it
 */
function displayMessage(message, index) {
  /** @type {Record<string, unknown>} */
  const out = { messageId: messageId(index), role: message.role === 'user' ? 'user' : 'assistant', text: text(message.content) };
  const lines = Array.isArray(message.toolTrace) ? message.toolTrace.map(toolLineOf).filter((l) => l !== null) : [];
  if (lines.length) out.toolLines = lines;
  if (Array.isArray(message.attachments) && message.attachments.length) {
    out.attachments = message.attachments.map((attachment) => ({
      kind: 'image',
      placeholder: true,
      ...(isRecord(attachment) && typeof attachment.name === 'string' && attachment.name ? { name: attachment.name } : {}),
    }));
  }
  if (message.interrupted === true) out.interrupted = true;
  return out;
}

/**
 * A page of a chat's messages: up to `limit` before index `end`, newest last,
 * and the id to ask `chat.more` with when there are older ones.
 *
 * @param {Array<Record<string, unknown>>} messages
 * @param {number} end
 * @param {number} limit
 */
function messagePage(messages, end, limit) {
  const stop = Math.min(end, messages.length);
  const start = Math.max(0, stop - limit);
  const page = messages.slice(start, stop).map((message, i) => displayMessage(message, start + i));
  return start > 0 ? { messages: page, before: messageId(start) } : { messages: page };
}

/**
 * A `tool-line` event of a running turn: the line and what it says of the
 * call, never its arguments or schema.
 * @param {Record<string, unknown>} payload
 */
function toolLineEvent(payload) {
  /** @type {Record<string, unknown>} */
  const out = { phase: text(payload.phase), line: text(payload.line) };
  if (Number.isInteger(payload.callIndex)) out.callIndex = payload.callIndex;
  if (typeof payload.tool === 'string') out.tool = payload.tool;
  const permission = permissionOf(payload.permission);
  if (permission) out.permission = permission;
  const changes = changesOf(payload.changes);
  if (changes) out.changes = changes;
  return out;
}

/**
 * A `progress` event of a running turn, each type with its own fields; null
 * for a type the remote does not hear of.
 * @param {Record<string, unknown>} payload
 */
function progressEvent(payload) {
  const type = text(payload.type);
  if (!PROGRESS_TYPES.has(type)) return null;
  switch (type) {
    case 'phase': return { type, phase: text(payload.phase) };
    case 'reasoning': return { type, text: text(payload.text) };
    case 'workspace': {
      /** @type {Record<string, unknown>} */
      const out = { type, event: text(payload.event), relativePath: text(payload.relativePath) };
      const change = changeOf(payload.change);
      if (change) out.change = change;
      return out;
    }
    case 'permission': {
      /** @type {Record<string, unknown>} */
      const out = { type, event: text(payload.event) };
      if (Number.isInteger(payload.callIndex)) out.callIndex = payload.callIndex;
      for (const key of ['tool', 'response', 'reason']) if (typeof payload[key] === 'string') out[key] = payload[key];
      if (Number.isInteger(payload.redactedCount)) out.redactedCount = payload.redactedCount;
      return out;
    }
    default: return { type };
  }
}

module.exports = { displayMessage, messageId, messageIndex, messagePage, progressEvent, toolLineEvent };
