'use strict';

/**
 * Which links from a chat answer may be opened (#82, #83, CR-B11-09). One
 * predicate for both sides: the renderer's sanitizer keeps exactly these links
 * clickable, and the main process opens exactly these. When the two disagreed,
 * a link stayed clickable that main then refused.
 *
 * Web links and e-mail addresses; everything else (`file:`, `javascript:`, …)
 * is refused. `mailto:` is strict on top: it needs an address and carries no
 * line break, not even percent-encoded — otherwise `%0A` could smuggle a second
 * header (Bcc, …) into the prepared mail.
 */
function isOpenableUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'mailto:') return false;
    if (!parsed.pathname.trim()) return false;
    return !/[\u0000-\u001f\u007f]/.test(trimmed) && !/%0[ad]/i.test(trimmed);
  } catch {
    return false;
  }
}

module.exports = { isOpenableUrl };
