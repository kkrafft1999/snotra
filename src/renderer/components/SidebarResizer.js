// One minimum per column, shared with the settings contract
// (`SIDEBAR_WIDTH_MIN` …) and with the `min-width` in styles.css. The sidebar
// said 150 here while the CSS rendered 180 — Home announced a width nobody
// saw (#637). test/sidebar-resizer-dom.test.js fails if the three drift apart.
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 600;
// The CSS width of `#sidebar`, where the layout starts without a remembered
// width (#637). Checked against styles.css like the minimum.
const SIDEBAR_DEFAULT = 280;
const CHAT_MIN = 260;
// Ohne gemerkte Breite ist das die Breite aus dem CSS. Sie steht hier, damit
// currentChatWidth() sie auch dann nennen kann, wenn der Chat gerade die ganze
// Flaeche fuellt (weggeschaltete Anzeige) und Messen die falsche Zahl liefert.
const CHAT_DEFAULT = 320;
const HISTORY_MIN = 180;
const HISTORY_MAX = 800;
const HISTORY_DEFAULT = 260;
const CONTENT_MIN = 200;
// `.pane-divider { width: 1px }` in styles.css. The dividers stand between
// the columns and take their pixel from the room as well — uncounted, the
// content pane kept 197 of its 200 px (#637). Checked against the CSS like
// the column widths.
const DIVIDER_PX = 1;
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

// Where each column's remembered width lives in the UI prefs.
const PREF_KEYS = { sidebar: 'sidebarWidth', chat: 'chatPanelWidth', history: 'chatHistoryWidth' };

/**
 * The divider on screen for a column (#637). Each counts with the column it
 * resizes: `#divider` with the sidebar, `#history-divider` with the history,
 * and `#chat-divider` with the chat — but only while the content pane is
 * there, styles.css hides it otherwise.
 */
function dividerPx(bounds, column) {
  const hidden = (state) => bounds?.classList.contains(`app--no-${state}`) === true;
  if (column === 'chat') return hidden('preview') || hidden('chat') ? 0 : DIVIDER_PX;
  return hidden(column) ? 0 : DIVIDER_PX;
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
  return (noSidebar ? 0 : sidebarPx) + dividerPx(bounds, 'sidebar')
    + (noPreview ? 0 : CONTENT_MIN);
}

// Bezugsflaeche ist seit der Umgruppierung (Epic #223) #app, also das ganze
// Fenster unter der Titelzeile — vorher war es der Container aus Anzeige und
// Chat. Seit Phase B teilt sich der Chat den Bereich mit dem Verlauf, deshalb
// geht dessen Breite hier mit ein: Was beide zusammen belegen, darf dem
// Arbeitsbereich nicht unter sein Mindestmass druecken.
function maxChatWidth(bounds, historyPx, sidebarPx) {
  if (!bounds) return CHAT_MIN;
  const rect = bounds.getBoundingClientRect();
  const room = rect.width - workspaceMin(bounds, sidebarPx) - historyPx - dividerPx(bounds, 'chat');
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

  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  // The width each column is meant to have (#637): from the prefs, from the
  // user's last gesture, or what the startup set up. What stands on screen is
  // derived from it on every pass — clamp(wanted, room) — so a squeeze only
  // ever touches the inline width, and the column grows back once the room is
  // there again.
  const wanted = {
    sidebar: finite(initialSidebarWidth) ?? SIDEBAR_DEFAULT,
    chat: finite(initialChatPanelWidth) ?? CHAT_DEFAULT,
    history: finite(initialChatHistoryWidth) ?? HISTORY_DEFAULT,
  };
  // What the prefs hold, as far as this window knows. `null` means nothing is
  // stored: then a width the startup set up stays unwritten until a gesture
  // makes it a wish of the user's.
  const stored = {
    sidebar: finite(initialSidebarWidth),
    chat: finite(initialChatPanelWidth),
    history: finite(initialChatHistoryWidth),
  };
  // Columns a gesture has changed since the last write.
  const unsaved = new Set();

  // Massgeblich ist der gesetzte Inline-Wert — the width on screen. Before
  // the first pass it is the wish.
  function currentSidebarWidth() {
    return parsePx(sidebar.style.width) ?? wanted.sidebar;
  }

  /** Breite der Chat-Spalte — 0, solange sie weggeschaltet ist. */
  function currentChatWidth() {
    if (!chatPanel) return CHAT_MIN;
    if (appRoot?.classList.contains('app--no-chat')) return 0;
    return parsePx(chatPanel.style.width) ?? wanted.chat;
  }

  /** Breite der Verlaufsspalte — 0, solange sie weggeschaltet ist. */
  function currentHistoryWidth() {
    if (!chatHistory || appRoot?.classList.contains('app--no-history')) return 0;
    return parsePx(chatHistory.style.width) ?? wanted.history;
  }

  /**
   * What the open history claims next to the chat: its wish, not its current
   * width, and its divider. The chat gives way first, so a squeezed history
   * gets its room back before the chat does (#637).
   */
  function historyClaim() {
    if (!chatHistory || appRoot?.classList.contains('app--no-history')) return 0;
    return wanted.history + DIVIDER_PX;
  }

  /** The chat with its divider — 0 while it is hidden. */
  function chatTaken(chatPx = currentChatWidth()) {
    return chatPx === 0 ? 0 : chatPx + dividerPx(appRoot, 'chat');
  }

  /**
   * Upper bound of the sidebar: its own maximum and, as a last resort (#637),
   * never so wide that the content pane loses its minimum beside a chat at
   * its own minimum — the history has folded away long before that.
   */
  function maxSidebarWidth() {
    const total = appRoot?.getBoundingClientRect().width ?? 0;
    if (!total) return SIDEBAR_MAX;
    const contentPx = appRoot.classList.contains('app--no-preview') ? 0 : CONTENT_MIN;
    const chatPx = appRoot.classList.contains('app--no-chat') ? 0 : chatTaken(CHAT_MIN);
    const room = total - DIVIDER_PX - contentPx - chatPx;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, room));
  }

  function maxHistoryWidth() {
    if (!appRoot) return HISTORY_MIN;
    const rect = appRoot.getBoundingClientRect();
    const room = rect.width - workspaceMin(appRoot, currentSidebarWidth()) - chatTaken()
      - DIVIDER_PX;
    return Math.max(HISTORY_MIN, Math.min(HISTORY_MAX, room));
  }

  function applySidebarWidth(raw) {
    const max = maxSidebarWidth();
    const width = Math.max(SIDEBAR_MIN, Math.min(raw, max));
    sidebar.style.width = `${width}px`;
    syncSeparator(divider, width, SIDEBAR_MIN, max);
    return width;
  }

  function applyChatWidth(raw) {
    if (!chatPanel) return null;
    const historyPx = historyClaim();
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

  // Wahr, solange der Verlauf nur wegen Platzmangels zu ist. Wer ihn selbst
  // zugeklappt hat, soll ihn nicht im breiteren Fenster wiederfinden.
  let collapsedForSpace = false;
  // setHistoryVisible() meldet sich zurueck und landet wieder hier — ohne
  // diesen Riegel liefe das im Kreis.
  let adjusting = false;

  /**
   * Haelt dem Arbeitsbereich sein Mindestmass frei. Zuerst gibt der Chat nach,
   * dann der Verlauf; reicht beides nicht, klappt der Verlauf weg — lieber
   * eine Spalte weniger als drei, die alle zu schmal sind. Only then, as a
   * last resort, the sidebar stops short of its wish (`maxSidebarWidth`).
   *
   * Every pass starts again from the wished widths (#637), so the result
   * depends on the room alone and not on the way there: a squeezed column
   * grows back as soon as a wider window, a gesture or a hidden neighbour
   * returns the room, and the history unfolds as soon as it fits beside the
   * chat's minimum. Nothing here is written to the prefs.
   */
  function ensureRoomForWorkspace() {
    if (!appRoot || adjusting) return;
    const total = appRoot.getBoundingClientRect().width;
    if (!total) return;
    adjusting = true;
    try {
      const sidebarPx = applySidebarWidth(wanted.sidebar);
      const noChat = appRoot.classList.contains('app--no-chat');
      if (chatHistory) {
        // What is left for the history once the chat has given way entirely.
        // Its own divider counts whether it is open or not, so folding away
        // and unfolding happen at the same width.
        const room = total - workspaceMin(appRoot, sidebarPx)
          - (noChat ? 0 : chatTaken(CHAT_MIN)) - DIVIDER_PX;
        const open = !appRoot.classList.contains('app--no-history');
        if (open && room < HISTORY_MIN) {
          collapsedForSpace = true;
          setHistoryVisible(false);
        } else if (!open && collapsedForSpace && room >= HISTORY_MIN) {
          collapsedForSpace = false;
          setHistoryVisible(true);
        }
      }
      // A hidden chat takes no room. Its inline width stays at its wish, so it
      // comes back as wide as it went away.
      if (noChat) {
        if (chatPanel) chatPanel.style.width = `${Math.max(CHAT_MIN, wanted.chat)}px`;
      } else {
        applyChatWidth(wanted.chat);
      }
      applyHistoryWidth(wanted.history);
    } finally {
      adjusting = false;
    }
  }

  /**
   * A gesture on a divider (#637): the width the column ends up with on
   * screen becomes its wish and is marked for writing — but only if it moved.
   * A key press at an end position or a click without movement changes
   * nothing and therefore writes nothing. Then the other columns make room.
   */
  function resizeColumn(column, raw) {
    const before = { sidebar: currentSidebarWidth, chat: currentChatWidth, history: currentHistoryWidth }[column]();
    const width = { sidebar: applySidebarWidth, chat: applyChatWidth, history: applyHistoryWidth }[column](raw);
    if (width === null) return null;
    if (width !== before) {
      wanted[column] = width;
      unsaved.add(column);
    }
    ensureRoomForWorkspace();
    return width;
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
   *
   * The result becomes the chat's wish for this session, so the next pass
   * keeps it, but not a stored width (#637): neither a later window resize
   * nor a gesture on another divider writes it.
   */
  function fitChatToWelcome() {
    if (!appRoot || !chatPanel) return null;
    if (appRoot.classList.contains('app--no-preview')) return null;
    if (appRoot.classList.contains('app--no-chat')) return null;
    const total = appRoot.getBoundingClientRect().width;
    if (!total) return null;
    // Measure in the current state: the content pane has only just opened.
    ensureRoomForWorkspace();
    // Die weggeschaltete Seitenleiste belegt nichts — wie in workspaceMin.
    // The dividers count as well, so the column holds the whole 624 px.
    const sidebarPx = appRoot.classList.contains('app--no-sidebar')
      ? 0
      : currentSidebarWidth();
    const dividersPx = dividerPx(appRoot, 'sidebar') + dividerPx(appRoot, 'chat')
      + dividerPx(appRoot, 'history');
    wanted.chat = clampChatWidth(
      total - sidebarPx - currentHistoryWidth() - dividersPx - CONTENT_WELCOME,
      appRoot,
      historyClaim(),
      currentSidebarWidth(),
    );
    ensureRoomForWorkspace();
    return currentChatWidth();
  }

  /**
   * Meldung aus dem Verlauf, dass seine Spalte umgeschaltet wurde. `persisted`
   * heisst: Der Nutzer hat es so gewollt — dann ist ein spaeteres automatisches
   * Aufklappen nicht mehr unsere Sache.
   */
  function handleHistoryVisibility({ persisted } = {}) {
    if (persisted) collapsedForSpace = false;
    ensureRoomForWorkspace();
  }

  // The first pass sets every column from its wish. app.js no longer has to
  // call it after building the resizer (#637).
  ensureRoomForWorkspace();

  let isResizing = false;
  let isResizingChat = false;
  let isResizingHistory = false;

  /**
   * Writes what a gesture changed (#637): only those columns, and only when
   * the wish differs from what is stored. A squeeze or the startup layout
   * changes no wish and writes nothing.
   */
  async function persistPanelWidths() {
    // Only the chat's wish can leave its range — the window share moves it
    // freely, so a round trip lands where it started. The prefs get what the
    // contract accepts.
    const changes = [...unsaved]
      .map((column) => [
        column,
        Math.round(column === 'chat' ? Math.max(CHAT_MIN, wanted.chat) : wanted[column]),
      ])
      .filter(([column, width]) => width !== stored[column]);
    unsaved.clear();
    if (!api?.setUIPrefs || changes.length === 0) return;
    try {
      await api.setUIPrefs(Object.fromEntries(
        changes.map(([column, width]) => [PREF_KEYS[column], width]),
      ));
      for (const [column, width] of changes) stored[column] = width;
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
   * nichts zu teilen. The room check runs in every state, though (#637): a
   * window that shrinks while the content pane or the chat is hidden has to
   * make room just the same.
   *
   * The share moves the chat's wish, not just its width: it stays a linear
   * function of the window width, and a squeezed chat grows back first. Only
   * a width the user chose travels into the prefs with it — what the startup
   * set up (`fitChatToWelcome`) stays a layout (#637).
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
      } else {
        const share = growth / 2 + carry;
        const step = Math.trunc(share);
        carry = share - step;
        if (step !== 0) {
          wanted.chat += step;
          if (stored.chat !== null) {
            unsaved.add('chat');
            schedulePersist();
          }
        }
      }
      ensureRoomForWorkspace();
    }).observe(appRoot);
  }

  // Showing or hiding a column changes the room of all the others (#637). The
  // switches live in app.js and in the history; watching the classes on #app
  // runs the room check after every one of them, so none can forget it — the
  // startup included, which opens the content pane only once the folder is
  // known. A pass that changes nothing is cheap, the animation class may pass
  // through as well.
  if (typeof MutationObserver !== 'undefined' && appRoot) {
    new MutationObserver(() => ensureRoomForWorkspace())
      .observe(appRoot, { attributes: true, attributeFilter: ['class'] });
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
    resizeColumn('sidebar', currentSidebarWidth() + direction * distance)
  ));

  // Der Chat liegt rechts vom Trenner: geht der Trenner nach links, wird der
  // Chat breiter — deshalb das umgekehrte Vorzeichen.
  bindKeys(chatDivider, (direction, distance) => (
    resizeColumn('chat', currentChatWidth() - direction * distance)
  ));

  // Der Verlauf liegt ebenfalls rechts von seinem Trenner.
  bindKeys(historyDivider, (direction, distance) => (
    resizeColumn('history', currentHistoryWidth() - direction * distance)
  ));

  divider.addEventListener('mousedown', (e) => {
    isResizing = true;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      resizeColumn('sidebar', e.clientX);
      return;
    }
    if (isResizingChat && appRoot && chatPanel) {
      const rect = appRoot.getBoundingClientRect();
      // Rechts vom Chat kann die Verlaufsspalte stehen; der Trenner sitzt
      // entsprechend weiter links als der Fensterrand.
      resizeColumn('chat', rect.right - currentHistoryWidth() - e.clientX);
      return;
    }
    if (isResizingHistory && appRoot && chatHistory) {
      const rect = appRoot.getBoundingClientRect();
      resizeColumn('history', rect.right - e.clientX);
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
    historyDivider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  // Der Verlauf schaltet sich ueber seinen eigenen Knopf ein; danach muss der
  // Platz neu aufgeteilt werden, sonst steht er ueber dem Arbeitsbereich.
  return { ensureRoomForWorkspace, handleHistoryVisibility, fitChatToWelcome };
}
