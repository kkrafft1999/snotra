'use strict';

/**
 * A system notification when an approval card waits out of sight (#792,
 * step 5): Snotra is in the background, or the card belongs to another chat
 * than the one on screen. The renderer decides that — it knows which chat is
 * visible and whether the window has the focus — and writes the words in the
 * language of the interface; main shows the notification, keeps the user's
 * switch, and on a click brings the window up and tells the renderer which
 * chat to open.
 *
 * One notification per card. It goes away when the card is decided or
 * expires, so that an old one cannot lead to a chat where nothing waits.
 */

const LIMITS = Object.freeze({ ID: 128, TITLE: 120, BODY: 300, OPEN: 50 });

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * @param {object} deps
 * @param {{ isSupported?: () => boolean, new (options: object): object }|null} deps.Notification  Electron's
 * @param {() => object|null} deps.getMainWindow
 * @param {() => Promise<boolean>|boolean} deps.isEnabled  the switch under Settings › General
 * @param {(chatId: string|null) => void} deps.openChat  tells the renderer which chat to show
 */
function createApprovalNotifier({ Notification, getMainWindow, isEnabled, openChat }) {
  /** requestId → the notification on screen. */
  const open = new Map();

  function supported() {
    try {
      return typeof Notification === 'function' && (typeof Notification.isSupported !== 'function' || Notification.isSupported());
    } catch {
      return false;
    }
  }

  function focusWindow() {
    const win = getMainWindow?.();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore?.();
    win.show?.();
    win.focus?.();
  }

  function forget(requestId, notification) {
    if (open.get(requestId) === notification) open.delete(requestId);
  }

  /**
   * @param {{ requestId: string, chatId?: string|null, title: string, body: string }} request
   * @returns {Promise<boolean>} whether a notification went up
   */
  async function show(request = {}) {
    const requestId = text(request.requestId, LIMITS.ID);
    const title = text(request.title, LIMITS.TITLE);
    if (!requestId || !title || open.has(requestId)) return false;
    let enabled = false;
    try {
      enabled = (await isEnabled()) !== false;
    } catch {
      enabled = false;
    }
    if (!enabled || !supported()) return false;
    // Many cards at once — a misbehaving run — must not flood the system.
    if (open.size >= LIMITS.OPEN) return false;
    const chatId = typeof request.chatId === 'string' && request.chatId ? request.chatId.slice(0, LIMITS.ID) : null;
    let notification;
    try {
      notification = new Notification({ title, body: text(request.body, LIMITS.BODY) });
    } catch {
      return false;
    }
    open.set(requestId, notification);
    notification.on?.('click', () => {
      forget(requestId, notification);
      focusWindow();
      openChat(chatId);
    });
    notification.on?.('close', () => forget(requestId, notification));
    notification.show();
    return true;
  }

  /** The card was decided or expired: its notification has nothing left to point to. */
  function close(requestId) {
    const id = text(requestId, LIMITS.ID);
    const notification = open.get(id);
    if (!notification) return false;
    open.delete(id);
    try {
      notification.close?.();
    } catch {
      /* already gone */
    }
    return true;
  }

  function closeAll() {
    for (const id of [...open.keys()]) close(id);
  }

  return { show, close, closeAll, openCount: () => open.size };
}

module.exports = { createApprovalNotifier, APPROVAL_NOTIFICATION_LIMITS: LIMITS };
