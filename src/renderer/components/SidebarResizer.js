const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 600;
const CHAT_MIN = 260;
// Ohne gemerkte Breite ist das die Breite aus dem CSS. Sie steht hier, damit
// currentChatWidth() sie auch dann nennen kann, wenn der Chat gerade die ganze
// Flaeche fuellt (weggeschaltete Anzeige) und Messen die falsche Zahl liefert.
const CHAT_DEFAULT = 320;
const HISTORY_MIN = 180;
const HISTORY_MAX = 800;
const HISTORY_DEFAULT = 260;
const CONTENT_MIN = 200;
// Breite, in der der Startschirm aufgeht: `#welcome` ist inhaltlich auf 560 px
// begrenzt und hat 32 px Polsterung je Seite (styles.css). Mehr Spalte hiesse
// nur mehr Leerraum um denselben Text — den Platz bekommt beim Erststart
// lieber der Chat (Issue #258). `test/startup-layout.test.js` haelt die Zahl
// mit dem CSS zusammen.
const CONTENT_WELCOME = 560 + 2 * 32;

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

/**
 * Was dem Arbeitsbereich mindestens bleiben muss. Genau so viel, wie seine
 * sichtbaren Spalten brauchen — weggeschaltete zaehlen nicht mit, sonst
 * reservierte man Platz fuer etwas, das gar nicht da ist.
 */
function workspaceMin(bounds, sidebarPx) {
  const noSidebar = bounds?.classList.contains('app--no-sidebar');
  const noPreview = bounds?.classList.contains('app--no-preview');
  // Die Seitenleiste geht mit ihrer eingestellten Breite ein, nicht mit ihrem
  // Minimum: Wer sie breit gezogen hat, will sie breit sehen — dann weicht
  // lieber der Verlauf, als dass die Anzeige auf einen Streifen zusammenfaellt.
  return (noSidebar ? 0 : sidebarPx) + (noPreview ? 0 : CONTENT_MIN);
}

// Bezugsflaeche ist seit der Umgruppierung (Epic #223) #app, also das ganze
// Fenster unter der Titelzeile — vorher war es der Container aus Anzeige und
// Chat. Seit Phase B teilt sich der Chat den Bereich mit dem Verlauf, deshalb
// geht dessen Breite hier mit ein: Was beide zusammen belegen, darf dem
// Arbeitsbereich nicht unter sein Mindestmass druecken.
function maxChatWidth(bounds, historyPx, sidebarPx) {
  if (!bounds) return CHAT_MIN;
  const rect = bounds.getBoundingClientRect();
  const room = rect.width - workspaceMin(bounds, sidebarPx) - historyPx;
  return Math.max(CHAT_MIN, Math.min(rect.width * 0.5, room));
}

function clampChatWidth(raw, bounds, historyPx, sidebarPx) {
  return Math.max(CHAT_MIN, Math.min(raw, maxChatWidth(bounds, historyPx, sidebarPx)));
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
  initialChatHistoryWidth,
  // Klappt die Verlaufsspalte weg oder wieder auf, wenn der Platz es verlangt
  // (Epic #223, Phase B). Geschaltet wird sie im Verlauf selbst, damit Knopf,
  // ARIA-Zustand und Spalte zusammenbleiben.
  setHistoryVisible = () => {},
}) {
  const divider = document.getElementById('divider');
  const sidebar = document.getElementById('sidebar');
  const appRoot = document.getElementById('app');
  const chatDivider = document.getElementById('chat-divider');
  const chatPanel = document.getElementById('chat-panel');
  const historyDivider = document.getElementById('history-divider');
  const chatHistory = document.getElementById('chat-history');

  // Massgeblich ist der gesetzte Inline-Wert; nur solange es keinen gibt,
  // zaehlt die gemessene Breite aus dem CSS-Default.
  function currentSidebarWidth() {
    return parsePx(sidebar.style.width) ?? sidebar.getBoundingClientRect().width;
  }

  /** Breite der Chat-Spalte — 0, solange sie weggeschaltet ist. */
  function currentChatWidth() {
    if (!chatPanel) return CHAT_MIN;
    if (appRoot?.classList.contains('app--no-chat')) return 0;
    const inline = parsePx(chatPanel.style.width);
    if (inline !== null) return inline;
    // Ohne Anzeige fuellt der Chat die ganze Flaeche; gemessen kaeme hier die
    // Fensterbreite heraus und wuerde beim naechsten Schreiben festgeschrieben.
    if (appRoot?.classList.contains('app--no-preview')) return CHAT_DEFAULT;
    return chatPanel.getBoundingClientRect().width;
  }

  /** Breite der Verlaufsspalte — 0, solange sie weggeschaltet ist. */
  function currentHistoryWidth() {
    if (!chatHistory || appRoot?.classList.contains('app--no-history')) return 0;
    return parsePx(chatHistory.style.width) ?? chatHistory.getBoundingClientRect().width;
  }

  function maxHistoryWidth() {
    if (!appRoot) return HISTORY_MIN;
    const rect = appRoot.getBoundingClientRect();
    const room = rect.width - workspaceMin(appRoot, currentSidebarWidth()) - currentChatWidth();
    return Math.max(HISTORY_MIN, Math.min(HISTORY_MAX, room));
  }

  function applySidebarWidth(raw) {
    const width = clampSidebarWidth(raw);
    sidebar.style.width = `${width}px`;
    syncSeparator(divider, width, SIDEBAR_MIN, SIDEBAR_MAX);
    return width;
  }

  function applyChatWidth(raw) {
    if (!chatPanel) return null;
    const historyPx = currentHistoryWidth();
    const sidebarPx = currentSidebarWidth();
    const width = clampChatWidth(raw, appRoot, historyPx, sidebarPx);
    chatPanel.style.width = `${width}px`;
    syncSeparator(chatDivider, width, CHAT_MIN, maxChatWidth(appRoot, historyPx, sidebarPx));
    return width;
  }

  function applyHistoryWidth(raw) {
    if (!chatHistory) return null;
    const width = Math.max(HISTORY_MIN, Math.min(raw, maxHistoryWidth()));
    chatHistory.style.width = `${width}px`;
    syncSeparator(historyDivider, width, HISTORY_MIN, maxHistoryWidth());
    return width;
  }

  /**
   * Haelt dem Arbeitsbereich sein Mindestmass frei. Zuerst gibt der Chat nach,
   * dann der Verlauf; reicht beides nicht, klappt der Verlauf weg — lieber
   * eine Spalte weniger als drei, die alle zu schmal sind.
   */
  // Wahr, solange der Verlauf nur wegen Platzmangels zu ist. Wer ihn selbst
  // zugeklappt hat, soll ihn nicht im breiteren Fenster wiederfinden.
  let collapsedForSpace = false;
  // Die Breite von vor dem Zusammendruecken: Kommt die Spalte im breiteren
  // Fenster zurueck, soll sie nicht auf ihrem Minimum stehen bleiben.
  let widthBeforeSqueeze = null;
  // setHistoryVisible() meldet sich zurueck und landet wieder hier — ohne
  // diesen Riegel liefe das im Kreis.
  let adjusting = false;

  function ensureRoomForWorkspace() {
    if (!appRoot || adjusting) return;
    const total = appRoot.getBoundingClientRect().width;
    if (!total) return;
    adjusting = true;
    try {
      const needed = workspaceMin(appRoot, currentSidebarWidth());
      // Die weggeschaltete Spalte behaelt ihre gemerkte Breite: Ein
      // applyChatWidth(0) schriebe sie auf das Minimum fest.
      if (!appRoot.classList.contains('app--no-chat')) applyChatWidth(currentChatWidth());

      if (collapsedForSpace && currentHistoryWidth() === 0) {
        const wanted = widthBeforeSqueeze
          ?? parsePx(chatHistory?.style.width)
          ?? HISTORY_DEFAULT;
        if (total - currentChatWidth() - wanted >= needed) {
          collapsedForSpace = false;
          widthBeforeSqueeze = null;
          if (chatHistory) chatHistory.style.width = `${wanted}px`;
          setHistoryVisible(true);
        }
        return;
      }

      let rest = total - currentChatWidth() - currentHistoryWidth();
      if (rest >= needed || currentHistoryWidth() === 0) {
        if (rest >= needed) widthBeforeSqueeze = null;
        return;
      }
      if (widthBeforeSqueeze === null) widthBeforeSqueeze = currentHistoryWidth();
      applyHistoryWidth(currentHistoryWidth() - (needed - rest));
      rest = total - currentChatWidth() - currentHistoryWidth();
      if (rest < needed) {
        collapsedForSpace = true;
        setHistoryVisible(false);
      }
    } finally {
      adjusting = false;
    }
  }

  /**
   * Stellt die Chat-Breite so ein, dass der mittleren Spalte genau der
   * Startschirm bleibt (Issue #258). Gerufen wird das nur beim Start ohne
   * Ordner und ohne gemerkte Chat-Breite — eine gemerkte Breite ist ein
   * ausdruecklicher Wunsch und bleibt stehen. Geschrieben wird hier nichts:
   * Was der Start einrichtet, ist kein neuer Wunsch.
   *
   * Das Clamping in applyChatWidth bleibt zustaendig — im schmalen Fenster
   * deckelt es den Chat bei der halben Breite, und die Spalte wird dann eben
   * schmaler als der Startschirm gern haette.
   */
  function fitChatToWelcome() {
    if (!appRoot || !chatPanel) return null;
    if (appRoot.classList.contains('app--no-preview')) return null;
    if (appRoot.classList.contains('app--no-chat')) return null;
    const total = appRoot.getBoundingClientRect().width;
    if (!total) return null;
    // Die weggeschaltete Seitenleiste belegt nichts — wie in workspaceMin.
    const sidebarPx = appRoot.classList.contains('app--no-sidebar')
      ? 0
      : currentSidebarWidth();
    return applyChatWidth(total - sidebarPx - currentHistoryWidth() - CONTENT_WELCOME);
  }

  /**
   * Meldung aus dem Verlauf, dass seine Spalte umgeschaltet wurde. `persisted`
   * heisst: Der Nutzer hat es so gewollt — dann ist ein spaeteres automatisches
   * Aufklappen nicht mehr unsere Sache.
   */
  function handleHistoryVisibility({ persisted } = {}) {
    if (persisted) {
      collapsedForSpace = false;
      widthBeforeSqueeze = null;
    }
    ensureRoomForWorkspace();
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
    syncSeparator(
      chatDivider,
      currentChatWidth(),
      CHAT_MIN,
      maxChatWidth(appRoot, currentHistoryWidth(), currentSidebarWidth()),
    );
  }

  if (
    chatHistory
    && typeof initialChatHistoryWidth === 'number'
    && Number.isFinite(initialChatHistoryWidth)
  ) {
    applyHistoryWidth(initialChatHistoryWidth);
  } else {
    syncSeparator(historyDivider, currentHistoryWidth(), HISTORY_MIN, maxHistoryWidth());
  }

  let isResizing = false;
  let isResizingChat = false;
  let isResizingHistory = false;

  async function persistPanelWidths() {
    if (!api?.setUIPrefs) return;
    const patch = {};
    const sidebarWidth = parsePx(sidebar.style.width);
    if (sidebarWidth !== null) patch.sidebarWidth = sidebarWidth;
    if (chatPanel) {
      const chatPanelWidth = parsePx(chatPanel.style.width);
      if (chatPanelWidth !== null) patch.chatPanelWidth = chatPanelWidth;
    }
    if (chatHistory) {
      const chatHistoryWidth = parsePx(chatHistory.style.width);
      if (chatHistoryWidth !== null) patch.chatHistoryWidth = chatHistoryWidth;
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
        || appRoot.classList.contains('app--no-chat')
      ) {
        carry = 0;
        return;
      }
      const share = growth / 2 + carry;
      const step = Math.trunc(share);
      carry = share - step;
      if (step !== 0) {
        const before = currentChatWidth();
        if (applyChatWidth(before + step) !== before) schedulePersist();
      }
      ensureRoomForWorkspace();
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

  // Der Verlauf liegt ebenfalls rechts von seinem Trenner.
  bindKeys(historyDivider, (direction, distance) => (
    applyHistoryWidth(currentHistoryWidth() - direction * distance)
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
      // Rechts vom Chat kann die Verlaufsspalte stehen; der Trenner sitzt
      // entsprechend weiter links als der Fensterrand.
      applyChatWidth(rect.right - currentHistoryWidth() - e.clientX);
      return;
    }
    if (isResizingHistory && appRoot && chatHistory) {
      const rect = appRoot.getBoundingClientRect();
      applyHistoryWidth(rect.right - e.clientX);
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
    if (isResizingHistory) {
      isResizingHistory = false;
      historyDivider?.classList.remove('dragging');
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

  historyDivider?.addEventListener('mousedown', (e) => {
    isResizingHistory = true;
    widthBeforeSqueeze = null;
    historyDivider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  // Der Verlauf schaltet sich ueber seinen eigenen Knopf ein; danach muss der
  // Platz neu aufgeteilt werden, sonst steht er ueber dem Arbeitsbereich.
  return { ensureRoomForWorkspace, handleHistoryVisibility, fitChatToWelcome };
}
