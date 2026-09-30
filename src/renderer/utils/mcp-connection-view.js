import contracts from '../generated/contracts.js';
import { t, tPlural, tMessage } from '../i18n.js';

const { MCP_CONNECTION_STATES } = contracts;

/**
 * The connection state of one MCP server, in words and in a shape. Settings ›
 * MCP and Settings › Security (#462) say the same thing about a server, so
 * both draw it from here.
 *
 * The shape carries the meaning, not the colour (no green status colours):
 * a filled dot is connected, a ring is off or not yet connected, an
 * exclamation mark is an error.
 */
export function describeConnection(server, connection) {
  if (!server?.enabled) return { kind: 'off', text: t('settings.mcp.state.off') };
  const state = connection?.state;
  if (state === MCP_CONNECTION_STATES.READY) {
    return { kind: 'on', text: tPlural('settings.mcp.state.connected', connection.toolCount ?? 0) };
  }
  if (state === MCP_CONNECTION_STATES.FAILED) {
    return {
      kind: 'error',
      text: t('settings.mcp.state.startFailed'),
      detail: tMessage(connection.error),
      stderr: connection.stderr,
    };
  }
  if (state === MCP_CONNECTION_STATES.STARTING) {
    return { kind: 'off', text: t('settings.mcp.state.starting'), pending: true };
  }
  // IDLE means: switched on, but never needed yet. Connecting lazily is
  // intended (#106) — it must not look like an error.
  return { kind: 'off', text: t('settings.mcp.state.notConnected') };
}

/** The status as an inline element: the shape, then the words. */
export function connectionStatusElement(status) {
  const wrap = document.createElement('span');
  wrap.className = 'mcp-status';
  const mark = document.createElement('span');
  mark.setAttribute('aria-hidden', 'true');
  if (status.kind === 'error') {
    mark.className = 'mcp-status__badge';
    mark.textContent = '!';
  } else {
    mark.className = `mcp-status__dot mcp-status__dot--${status.kind}`;
  }
  const text = document.createElement('span');
  text.textContent = status.text;
  wrap.append(mark, text);
  return wrap;
}
