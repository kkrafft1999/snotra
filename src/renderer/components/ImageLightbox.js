/**
 * Bild-Anhang in gross (Issue #94).
 *
 * Ein Thumbnail im Verlauf ist 240 px breit — bei einem Screenshot mit
 * Fehlermeldung reicht das nicht zum Lesen. Der Klick darauf legt das Bild
 * bildschirmfuellend darueber.
 *
 * Der Dialog hat genau ein bedienbares Element (Schliessen), deshalb ist der
 * Fokus-Kaefig eine Zeile: Tab bleibt auf dem Knopf. Escape und ein Klick auf
 * den Hintergrund schliessen ebenfalls, danach steht der Fokus wieder auf dem
 * Thumbnail, von dem der Dialog ausging.
 */
export function initImageLightbox() {
  const root = document.getElementById('image-lightbox');
  const backdrop = document.getElementById('image-lightbox-backdrop');
  const imgEl = document.getElementById('image-lightbox-img');
  const captionEl = document.getElementById('image-lightbox-caption');
  const closeBtn = document.getElementById('image-lightbox-close');
  if (!root || !imgEl || !closeBtn) return { open() {}, close() {}, isOpen: () => false };

  let lastTrigger = null;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  function close() {
    if (!isOpen()) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    // Die Data-URL wieder loslassen, damit das Bild nicht im DOM haengen bleibt.
    imgEl.removeAttribute('src');
    imgEl.alt = '';
    if (captionEl) captionEl.textContent = '';
    const back = lastTrigger;
    lastTrigger = null;
    if (back && back.isConnected) back.focus();
  }

  function open({ src, alt = '', trigger = null } = {}) {
    if (!src) return;
    lastTrigger = trigger;
    imgEl.src = src;
    imgEl.alt = alt;
    if (captionEl) captionEl.textContent = alt;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    closeBtn.focus();
  }

  backdrop?.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      closeBtn.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  return { open, close, isOpen };
}
