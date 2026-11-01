'use strict';

/**
 * What a remote front end is shown of a chat (#1194;
 * docs/remote/remote-interface.md §8.1 `DisplayMessage`, §8.2): what the desktop
 * shows, not what it stores — the text, the tool lines as the desktop worded
 * them (decided 2026-10-20: in the desktop's language, since the history
 * keeps no arguments to word them again), images as placeholders. No tool
 * arguments, schemas, results, sandbox details or reasoning of stored turns.
 */

const { isMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');
const { normalizeMessageOrigin } = require('../../shared/contracts/remote/message-origin');

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
  // Written by a remote front end (#1197): its kind and the name it gave.
  const origin = message.role === 'user' ? normalizeMessageOrigin(message.origin) : null;
  if (origin) out.origin = origin;
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

/**
 * A path as a remote is shown it: inside the workspace relative to it, with
 * `/` between the parts; outside it as the card names it — that place is
 * what is being approved (§8.1 `ApprovalRequest`).
 * @param {string|null} root
 * @param {unknown} value
 */
function inWorkspace(root, value) {
  if (typeof value !== 'string') return '';
  if (!root) return value;
  if (value === root) return '.';
  for (const sep of ['/', '\\']) {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (value.startsWith(prefix)) return value.slice(prefix.length).split('\\').join('/') || '.';
  }
  return value;
}

/**
 * A card as a remote front end sees it (#1194, step 3; §8.1
 * `ApprovalRequest`): what is being decided — the tool, the targets, the
 * reason in the connection's language, the preview masked as on the desktop,
 * a sandbox card's offers — and `options`, the answers this connection may
 * give. Nothing of what a wider answer would store: no session scope, no
 * command rule, no "for this workspace".
 *
 * @param {Record<string, unknown>} dto  the window's card
 * @param {{ root: string|null, word: (message: import('../../shared/contracts/message').Message) => string, options: string[] }} context
 */
function approvalRequest(dto, { root, word, options }) {
  const parts = Array.isArray(dto.reasonParts) ? dto.reasonParts.filter(isMessage) : [];
  /** @type {Record<string, unknown>} */
  const out = {
    requestId: text(dto.requestId),
    chatId: text(dto.chatId),
    tool: text(dto.tool),
    riskClasses: Array.isArray(dto.riskClasses) ? dto.riskClasses.filter((c) => typeof c === 'string') : [],
    targets: (Array.isArray(dto.targets) ? dto.targets : []).filter(isRecord).map((target) => ({
      path: inWorkspace(root, target.path),
      kind: text(target.kind),
      exists: target.exists === true,
      sensitive: target.sensitive === true,
      ...(typeof target.sensitiveReason === 'string' ? { sensitiveReason: target.sensitiveReason } : {}),
      // What the knowledge file is, and an `always` rule (#1319).
      ...(typeof target.knowledge === 'string' ? { knowledge: target.knowledge } : {}),
      ...(target.knowledgeAlways === true ? { knowledgeAlways: true } : {}),
    })),
    reason: parts.length ? parts.map((part) => word(part)).join(' ') : text(dto.reason),
    ...(parts.length ? { reasonParts: parts } : {}),
    checkpoint: text(dto.checkpoint),
    options: [...options],
  };
  if (isRecord(dto.preview)) {
    const preview = dto.preview;
    /** @type {Record<string, unknown>} */
    const shown = { kind: text(preview.kind), text: text(preview.text), truncated: preview.truncated === true, masked: preview.masked === true };
    for (const key of ['shell', 'memoryScope', 'stdin']) if (typeof preview[key] === 'string') shown[key] = preview[key];
    if (typeof preview.cwd === 'string') shown.cwd = inWorkspace(root, preview.cwd);
    if (Array.isArray(preview.argv)) shown.argv = preview.argv.filter((a) => typeof a === 'string');
    out.preview = shown;
  }
  if (isRecord(dto.sandbox) && Array.isArray(dto.sandbox.entries)) {
    const sandbox = dto.sandbox;
    out.sandbox = {
      entries: /** @type {unknown[]} */ (sandbox.entries).filter(isRecord).map((entry) => ({
        kind: text(entry.kind),
        target: inWorkspace(root, entry.target),
        count: Number.isInteger(entry.count) ? entry.count : 1,
        folder: entry.folder === true,
        allow: Array.isArray(entry.allow) ? entry.allow.map((p) => inWorkspace(root, p)) : [],
        ...(entry.sensitive === true ? { sensitive: true } : {}),
      })),
      ...(Array.isArray(sandbox.domains) ? { domains: sandbox.domains.filter((d) => typeof d === 'string') } : {}),
    };
  }
  if (isRecord(dto.config)) out.config = dto.config;
  // A knowledge card (#1319) and its warning (#1280): the phone shows it in full.
  if (dto.knowledge === true) {
    out.knowledge = true;
    if (dto.knowledgeWarning === true) out.knowledgeWarning = true;
  }
  if (isRecord(dto.knowledgeChange)) out.knowledgeChange = dto.knowledgeChange;
  return out;
}

module.exports = { approvalRequest, displayMessage, inWorkspace, messageId, messageIndex, messagePage, progressEvent, toolLineEvent };
