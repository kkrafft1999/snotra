'use strict';

/**
 * The window follows a turn it did not start (#1194, step 2b of
 * `docs/remote/remote-interface.md` §10): a phone's turn reaches the window on the
 * channels its own turns use — `chat:delta`, `chat:tool-line`,
 * `chat:progress` — with `chat:turn-started` ahead of them, once the
 * question is saved, so that the window knows the run and can show the
 * question. The window is the desktop kind (§7.1): it gets the events as its
 * own turns' events, nothing filtered.
 */

/**
 * @param {{
 *   push: (channel: string, payload: object) => boolean,
 *   PUSH: { CHAT_DELTA: string, CHAT_TOOL_LINE: string, CHAT_PROGRESS: string, CHAT_TURN_STARTED: string },
 * }} deps
 * @returns {(event: { chatId: string, runId: string, type: string, payload: Record<string, unknown> }) => void}
 */
function createWindowFollower({ push, PUSH }) {
  /** @type {Record<string, string>} */
  const channels = {
    'turn-started': PUSH.CHAT_TURN_STARTED,
    delta: PUSH.CHAT_DELTA,
    'tool-line': PUSH.CHAT_TOOL_LINE,
    progress: PUSH.CHAT_PROGRESS,
  };
  return ({ chatId, runId, type, payload }) => {
    const channel = Object.hasOwn(channels, type) ? channels[type] : undefined;
    if (!channel) return;
    // The route last, as `chat-handlers.js` sends it: a payload cannot name another chat.
    push(channel, { ...payload, chatId, runId });
  };
}

module.exports = { createWindowFollower };
