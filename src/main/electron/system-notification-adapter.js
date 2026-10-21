'use strict';

/**
 * The notification port on the desktop (#983): Electron's `Notification`.
 * A click brings the app window to the front — restored if it was minimised —
 * before the caller learns of it (#792, step 5).
 */

/**
 * @typedef {{
 *   on?(event: string, listener: () => void): unknown,
 *   show(): void,
 *   close?(): void,
 * }} SystemNotification
 */

/**
 * @param {object} deps
 * @param {{ isSupported?: () => boolean, new (options: { title: string, body: string }): SystemNotification }|null} deps.Notification  Electron's
 * @param {() => import('electron').BrowserWindow|null} deps.getMainWindow
 * @returns {import('../../application/ports/notification-port').NotificationPort}
 */
function createSystemNotificationAdapter({ Notification, getMainWindow }) {
  function focusWindow() {
    const win = getMainWindow?.();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore?.();
    win.show?.();
    win.focus?.();
  }

  return {
    isSupported: () => typeof Notification === 'function'
      && (typeof Notification.isSupported !== 'function' || Notification.isSupported()),
    show({ title, body, onClick, onClose }) {
      if (!Notification) throw new Error('no notifications on this system');
      const notification = new Notification({ title, body });
      notification.on?.('click', () => {
        focusWindow();
        onClick();
      });
      notification.on?.('close', onClose);
      notification.show();
      return { close: () => notification.close?.() };
    },
  };
}

module.exports = { createSystemNotificationAdapter };
