const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 600;
const CHAT_MIN = 260;

// Tastaturbedienung der Trenner (WAI-ARIA "Window Splitter"). Gelesen wird
// die Pfeilrichtung woertlich: Der Trenner wandert dorthin, wohin die Taste
// zeigt — beim Chat-Trenner waechst das Panel dadurch nach links, weil es
// rechts davon liegt. Home/End sind die beiden Endlagen.
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
// Eine gehaltene Pfeiltaste feuert Dutzende Male pro Sekunde. Die Breite
// wandert sofort mit, geschrieben wird erst, wenn die Taste zur Ruhe kommt.
const KEY_PERSIST_DELAY = 300;
// So lange bleibt der Griff nach einem Tastenschritt hervorgehoben — ohne das
// hat ein Tastendruck keine sichtbare Rueckmeldung ausser der neuen Breite.
const KEY_ACTIVE_DURATION = 320;

function clampSidebarWidth(raw) {
  return Math.max(SIDEBAR_MIN, Math.min(raw, SIDEBAR_MAX));
}

// Bezugsflaeche ist seit der Umgruppierung (Epic #223, Phase A) #app, also das
// ganze Fenster unter der Titelzeile — vorher war es der Container aus Anzeige
// und Chat. Der Chat ist jetzt eine der beiden Haelften; seine Obergrenze ist
// entsprechend die halbe Fensterbreite, dieselbe Grenze steht als max-width im
// CSS.
function maxChatWidth(bounds) {
  if (!bounds) return CHAT_MIN;
  const rect = bounds.getBoundingClientRect();
  return Math.max(CHAT_MIN, Math.min(rect.width * 0.5, rect.width - 200));
}

function clampChatWidth(raw, bounds) {
  return Math.max(CHAT_MIN, Math.min(raw, maxChatWidth(bounds)));
}

function parsePx(styleWidth) {
  const n = parseInt(styleWidth, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * aria-valuenow & Co. am Trenner nachfuehren. ARIA verlangt die Werte an einem
 * fokussierbaren `separator`; ohne sie sagt der Screenreader beim Verschieben
 * nur "Trenner" und nicht, wo er inzwischen steht. `valuenow` bleibt aus,
 * solange keine belastbare Breite vorliegt (kein Layout, kein Inline-Wert) —
 * eine gemeldete 0 waere schlechter als keine Meldung.
 */
function syncSeparator(separator, value, min, max) {
  if (!separator) return;
  separator.setAttribute('aria-valuemin', String(Math.round(min)));
  separator.setAttribute('aria-valuemax', String(Math.round(max)));
  if (Number.isFinite(value) && value > 0) {
    separator.setAttribute('aria-valuenow', String(Math.round(value)));
  }
}

export function initSidebarResizer({
  api,
  initialSidebarWidth,
  initialChatPanelWidth,
}) {
  const divider = document.getElementById('divider');
  const sidebar = document.getElementById('sidebar');
  const appRoot = document.getElementById('app');
  const chatDivider = document.getElementById('chat-divider');
  const chatPanel = document.getElementById('chat-panel');

  // Massgeblich ist der gesetzte Inline-Wert; nur solange es keinen gibt,
  // zaehlt die gemessene Breite aus dem CSS-Default.
  function currentSidebarWidth() {
    return parsePx(sidebar.style.width) ?? sidebar.getBoundingClientRect().width;
  }

  function currentChatWidth() {
    if (!chatPanel) return CHAT_MIN;
    return parsePx(chatPanel.style.width) ?? chatPanel.getBoundingClientRect().width;
  }

  function applySidebarWidth(raw) {
    const width = clampSidebarWidth(raw);
    sidebar.style.width = `${width}px`;
    syncSeparator(divider, width, SIDEBAR_MIN, SIDEBAR_MAX);
    return width;
  }

  function applyChatWidth(raw) {
    if (!chatPanel) return null;
    const width = clampChatWidth(raw, appRoot);
    chatPanel.style.width = `${width}px`;
    syncSeparator(chatDivider, width, CHAT_MIN, maxChatWidth(appRoot));
    return width;
  }

  if (typeof initialSidebarWidth === 'number' && Number.isFinite(initialSidebarWidth)) {
    applySidebarWidth(initialSidebarWidth);
  } else {
    syncSeparator(divider, currentSidebarWidth(), SIDEBAR_MIN, SIDEBAR_MAX);
  }

  if (
    chatPanel
    && typeof initialChatPanelWidth === 'number'
    && Number.isFinite(initialChatPanelWidth)
  ) {
    applyChatWidth(initialChatPanelWidth);
  } else {
    syncSeparator(chatDivider, currentChatWidth(), CHAT_MIN, maxChatWidth(appRoot));
  }

  let isResizing = false;
  let isResizingChat = false;

  async function persistPanelWidths() {
    if (!api?.setUIPrefs) return;
    const patch = {};
    const sidebarWidth = parsePx(sidebar.style.width);
    if (sidebarWidth !== null) patch.sidebarWidth = sidebarWidth;
    if (chatPanel) {
      const chatPanelWidth = parsePx(chatPanel.style.width);
      if (chatPanelWidth !== null) patch.chatPanelWidth = chatPanelWidth;
    }
    if (Object.keys(patch).length === 0) return;
    try {
      await api.setUIPrefs(patch);
    } catch {
      // ignore persistence errors
    }
  }

  let persistTimer = null;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { void persistPanelWidths(); }, KEY_PERSIST_DELAY);
  }

  /**
   * Wird das Fenster breiter, teilen sich Arbeitsbereich und Chat den Zuwachs
   * je zur Haelfte (Epic #223) — vorher bekam ihn allein die Anzeige. Zu
   * schreiben ist nur die neue Chat-Breite: Der Arbeitsbereich fuellt den Rest
   * von selbst, weil er `flex: 1` traegt. Beim Schmalerwerden laeuft dieselbe
   * Rechnung rueckwaerts, sodass Maximieren und Zuruecksetzen wieder dort
   * landen, wo man vorher war.
   *
   * Ohne Anzeige nimmt der Chat ohnehin die ganze Breite ein — dann gibt es
   * nichts zu teilen.
   */
  if (typeof ResizeObserver !== 'undefined' && appRoot && chatPanel) {
    let lastWidth = appRoot.getBoundingClientRect().width;
    // Die halbe Pixelzahl bleibt beim Ziehen am Fensterrand liegen: ohne diesen
    // Uebertrag bekaeme der Chat bei lauter Ein-Pixel-Schritten jedes Mal eine
    // aufgerundete Haelfte und damit am Ende den ganzen Zuwachs.
    let carry = 0;
    new ResizeObserver(() => {
      const width = appRoot.getBoundingClientRect().width;
      const growth = width - lastWidth;
      lastWidth = width;
      if (
        growth === 0
        || isResizing
        || isResizingChat
        || appRoot.classList.contains('app--no-preview')
      ) {
        carry = 0;
        return;
      }
      const share = growth / 2 + carry;
      const step = Math.trunc(share);
      carry = share - step;
      if (step === 0) return;
      const before = currentChatWidth();
      if (applyChatWidth(before + step) !== before) schedulePersist();
    }).observe(appRoot);
  }

  /**
   * Gemeinsame Tastaturbedienung beider Trenner. `move` bekommt die Richtung,
   * in die der Trenner wandern soll (-1 nach links, +1 nach rechts), und die
   * Schrittweite; Home/End reichen Infinity durch und landen ueber das
   * Clamping in der jeweiligen Endlage.
   */
  function bindKeys(separator, move) {
    if (!separator) return;
    let activeTimer = null;
    separator.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      let direction;
      let distance = step;
      if (e.key === 'ArrowLeft') direction = -1;
      else if (e.key === 'ArrowRight') direction = 1;
      else if (e.key === 'Home') { direction = -1; distance = Infinity; }
      else if (e.key === 'End') { direction = 1; distance = Infinity; }
      else return;

      e.preventDefault();
      if (move(direction, distance) === null) return;

      separator.classList.add('dragging');
      clearTimeout(activeTimer);
      activeTimer = setTimeout(
        () => separator.classList.remove('dragging'),
        KEY_ACTIVE_DURATION,
      );
      schedulePersist();
    });
  }

  bindKeys(divider, (direction, distance) => (
    applySidebarWidth(currentSidebarWidth() + direction * distance)
  ));

  // Der Chat liegt rechts vom Trenner: geht der Trenner nach links, wird der
  // Chat breiter — deshalb das umgekehrte Vorzeichen.
  bindKeys(chatDivider, (direction, distance) => (
    applyChatWidth(currentChatWidth() - direction * distance)
  ));

  divider.addEventListener('mousedown', (e) => {
    isResizing = true;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      applySidebarWidth(e.clientX);
      return;
    }
    if (isResizingChat && appRoot && chatPanel) {
      const rect = appRoot.getBoundingClientRect();
      applyChatWidth(rect.right - e.clientX);
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      void persistPanelWidths();
    }
    if (isResizingChat) {
      isResizingChat = false;
      chatDivider.classList.remove('dragging');
      document.body.style.cursor = '';
      void persistPanelWidths();
    }
  });

  chatDivider.addEventListener('mousedown', (e) => {
    isResizingChat = true;
    chatDivider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
}
