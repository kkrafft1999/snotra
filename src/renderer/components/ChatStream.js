import { markdownToSafeHtml } from '../utils/helpers.js';
// Token-Usage-Normalisierung/-Summierung aus der gemeinsamen Contract-Schicht,
// damit Anzeige (Renderer) und Provider-Seite (Main) nicht auseinanderlaufen.
import contracts from '../generated/contracts.js';
// Einzeiler-Logik des kompakten Tool-Logs (Issue #60), DOM-frei und getestet.
import {
  toolLineText,
  summarizeToolLog,
  formatElapsedLabel,
  THINKING_LABEL,
  THINKING_ELAPSED_MIN_MS,
} from '../utils/tool-log-summary.js';
// Diagnose-Puffer für den Tool-Log (Issue #87): Ereignisse, Zustände, Fehler.
import { createToolLogDebug, compactToolLinePayload } from '../utils/tool-log-debug.js';

const { coerceUsage, mergeUsage, toolCategoryForEntry } = contracts;

// Ein Puffer je Renderer; in den DevTools per window.__snotraToolLogDebug.serialize()
// abrufbar, im Chat per Strg/Cmd+Shift+D in die Zwischenablage (Issue #87).
const toolLogDebug = createToolLogDebug();
if (typeof window !== 'undefined') window.__snotraToolLogDebug = toolLogDebug;

/** Erledigt-Marke: nur noch für Screenreader — sichtbar tragen die Zeilen ein Symbol. */
function buildToolLineStatus() {
  const status = document.createElement('span');
  status.className = 'chat-tool-line-status sr-only';
  status.textContent = 'Abgeschlossen';
  return status;
}

const CHAT_TOOL_CHEVRON_HTML =
  '<svg class="chat-tool-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

// Symbol je Tool-Art (Issue #60): sagt auf einen Blick, was der Schritt getan
// hat, und ersetzt den früheren linken Balken samt Häkchen.
const TOOL_CATEGORY_ICON_PATHS = {
  skill: '<path d="M4.2 2.2h7.6v11.6L8 11.1l-3.8 2.7z"/>',
  read: '<path d="M4 1.8h4.6L12 5.2v9H4z"/><path d="M8.4 1.9v3.4h3.4"/><path d="M6 9h4M6 11.4h4"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4 13.6 13.6"/>',
  list: '<path d="M2.2 4h3.9l1.2 1.6h6.5v7.4H2.2z"/>',
  check: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.6"/>',
  write: '<path d="M11.3 2.3 13.7 4.7 6.2 12.2H3.8V9.8z"/>',
  wait: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.4 1.5"/>',
  other: '<path d="M2.4 3.4h11.2v9.2H2.4z"/><path d="M5 7l1.6 1.6L5 10.2"/>',
};

function toolCategoryIconHtml(category) {
  const paths = TOOL_CATEGORY_ICON_PATHS[category] || TOOL_CATEGORY_ICON_PATHS.other;
  return `<svg class="chat-tool-line-icon" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
}

const TOOL_LINE_STATE_CLASS = {
  pending: 'chat-tool-line--pending',
  running: 'chat-tool-line--running',
  done: 'chat-tool-line--done',
};

// state 'pending': Das Modell streamt den Aufruf noch (Argumente unvollständig),
// das Tool ist noch nicht gelaufen. Optisch wie 'running', damit z. B. beim
// Schreiben einer Datei sofort sichtbar ist, dass etwas passiert.
function buildToolLine(text, state /* 'pending' | 'running' | 'done' */, callIndex, category) {
  const row = document.createElement('div');
  row.className = 'chat-tool-line';
  row.classList.add(TOOL_LINE_STATE_CLASS[state] || TOOL_LINE_STATE_CLASS.done);
  row.setAttribute('role', 'listitem');
  if (Number.isInteger(callIndex)) row.dataset.callIndex = String(callIndex);
  if (category) {
    row.dataset.category = category;
    row.insertAdjacentHTML('afterbegin', toolCategoryIconHtml(category));
  }

  const textEl = document.createElement('span');
  textEl.className = 'chat-tool-line-text';
  textEl.textContent = text;
  row.appendChild(textEl);

  if (state === 'running' || state === 'pending') {
    row.setAttribute('aria-busy', 'true');
    row.setAttribute('aria-label', `Läuft: ${text}`);
  } else {
    row.setAttribute('aria-label', `Abgeschlossen: ${text}`);
    row.appendChild(buildToolLineStatus());
  }

  return row;
}

function setToolLineDone(row, doneText) {
  if (!row || row.classList.contains('chat-tool-line--done')) return;
  row.classList.remove('chat-tool-line--running');
  row.classList.add('chat-tool-line--done');
  row.removeAttribute('aria-busy');

  const textEl = row.querySelector('.chat-tool-line-text');
  if (doneText && textEl) textEl.textContent = doneText;
  const finalText = textEl?.textContent || doneText || '';
  if (finalText) row.setAttribute('aria-label', `Abgeschlossen: ${finalText}`);

  if (!row.querySelector('.chat-tool-line-status')) row.appendChild(buildToolLineStatus());
}

function setToolLineText(row, text) {
  const textEl = row?.querySelector('.chat-tool-line-text');
  if (!textEl || !text) return;
  textEl.textContent = text;
  row.setAttribute('aria-label', `Läuft: ${text}`);
}

/** Vorläufige Zeile (Aufruf gestreamt) wird zur laufenden Zeile (Tool wird ausgeführt). */
function promoteToolLineToRunning(row, text) {
  if (!row) return;
  row.classList.remove('chat-tool-line--pending');
  row.classList.add('chat-tool-line--running');
  setToolLineText(row, text);
}

function findPendingToolLine(linesEl, callIndex, fallbackToFirst = false) {
  if (!linesEl) return null;
  const byIndex = Number.isInteger(callIndex)
    ? linesEl.querySelector(`.chat-tool-line--pending[data-call-index="${callIndex}"]`)
    : null;
  if (byIndex || !fallbackToFirst) return byIndex;
  return linesEl.querySelector('.chat-tool-line--pending');
}

/** Die Einzeiler-Zeile in der <summary>: aktueller bzw. letzter Schritt plus Zusatz. */
function buildToolSummaryLine() {
  const line = document.createElement('span');
  line.className = 'chat-tool-line chat-tool-summary-line chat-tool-line--done';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  // Platzhalter-Symbol schon beim Bauen (Issue #87): So hält auch der noch
  // nicht synchronisierte Rohzustand die Textkante und sieht nicht „leer“ aus.
  line.dataset.iconKey = '';
  line.insertAdjacentHTML('afterbegin', toolCategoryIconHtml('other'));
  line.querySelector('.chat-tool-line-icon').classList.add('chat-tool-line-icon--empty');
  const textEl = document.createElement('span');
  textEl.className = 'chat-tool-line-text';
  line.appendChild(textEl);
  // Verstrichene Denkzeit (Issue #87): tickt sekündlich, deshalb außerhalb der
  // Live-Region-Ansage — sonst spräche der Screenreader jede Sekunde.
  const elapsed = document.createElement('span');
  elapsed.className = 'chat-tool-summary-elapsed';
  elapsed.setAttribute('aria-hidden', 'true');
  elapsed.hidden = true;
  line.appendChild(elapsed);
  const extra = document.createElement('span');
  extra.className = 'chat-tool-summary-extra';
  extra.hidden = true;
  line.appendChild(extra);
  // Chevron in der Zeile statt daneben, damit er bei Umbruch mit dem Text wandert.
  line.insertAdjacentHTML('beforeend', CHAT_TOOL_CHEVRON_HTML);
  return line;
}

function readToolLogSteps(wrap) {
  const rows = wrap.querySelectorAll('.chat-tool-lines > .chat-tool-line');
  return [...rows].map((row) => ({
    text: row.querySelector('.chat-tool-line-text')?.textContent || '',
    category: row.dataset.category || null,
    state: row.classList.contains('chat-tool-line--pending')
      ? 'pending'
      : row.classList.contains('chat-tool-line--running')
        ? 'running'
        : 'done',
  }));
}

/**
 * Symbol des Einzeilers an die Kategorie anpassen. Ohne Kategorie — beim
 * Nachdenken und bei Sessions von vor #60 — bleibt der Platz reserviert, sonst
 * rutschte der Text bei jedem Wechsel um die Symbolbreite nach links.
 */
function syncToolSummaryIcon(line, category) {
  const key = category || '';
  if (line.dataset.iconKey === key && line.querySelector('.chat-tool-line-icon')) return;
  line.querySelector('.chat-tool-line-icon')?.remove();
  line.dataset.iconKey = key;
  if (category) line.dataset.category = category;
  else delete line.dataset.category;
  line.insertAdjacentHTML('afterbegin', toolCategoryIconHtml(category || 'other'));
  if (!category) {
    line.querySelector('.chat-tool-line-icon').classList.add('chat-tool-line-icon--empty');
  }
}

function syncToolSummaryLine(line, summary) {
  const { text, state, extra } = summary;
  syncToolSummaryIcon(line, summary.category);
  line.classList.remove(
    TOOL_LINE_STATE_CLASS.pending,
    TOOL_LINE_STATE_CLASS.running,
    TOOL_LINE_STATE_CLASS.done
  );
  line.classList.add(TOOL_LINE_STATE_CLASS[state] || TOOL_LINE_STATE_CLASS.done);

  // Nur bei echter Änderung schreiben, damit die Live-Region nicht unnötig ansagt.
  const textEl = line.querySelector('.chat-tool-line-text');
  if (textEl && textEl.textContent !== text) textEl.textContent = text;
  const extraEl = line.querySelector('.chat-tool-summary-extra');
  if (extraEl) {
    if (extraEl.textContent !== extra) extraEl.textContent = extra;
    extraEl.hidden = !extra;
  }
  const elapsedEl = line.querySelector('.chat-tool-summary-elapsed');
  if (elapsedEl) {
    const elapsed = summary.elapsed || '';
    if (elapsedEl.textContent !== elapsed) elapsedEl.textContent = elapsed;
    elapsedEl.hidden = !elapsed;
  }

  const label = extra ? `${text} ${extra}` : text;
  if (state === 'done') {
    line.removeAttribute('aria-busy');
    line.setAttribute('aria-label', `Abgeschlossen: ${label}`);
    if (!line.querySelector('.chat-tool-line-status')) {
      line.insertBefore(buildToolLineStatus(), line.querySelector('.chat-tool-chevron'));
    }
    line.querySelector('.chat-tool-line-status').textContent = 'Abgeschlossen';
  } else {
    line.setAttribute('aria-busy', 'true');
    line.setAttribute('aria-label', `Läuft: ${label}`);
    line.querySelector('.chat-tool-line-status')?.remove();
  }
}

/**
 * Die Schrittliste ist höhenbegrenzt und scrollt (Issue #60). Der Fade am
 * unteren Rand erscheint nur, solange dort wirklich noch etwas folgt — sonst
 * sähe die letzte Zeile dauerhaft ausgegraut aus.
 */
function syncToolListOverflow(linesEl) {
  if (!linesEl) return;
  const overflowing = linesEl.scrollHeight - linesEl.clientHeight > 1;
  const atBottom = linesEl.scrollTop + linesEl.clientHeight >= linesEl.scrollHeight - 2;
  linesEl.classList.toggle('chat-tool-lines--fade', overflowing && !atBottom);
}

/** Neue Schritte nachziehen, solange der Nutzer die Liste unten hat. */
function appendToolLine(linesEl, row) {
  const atBottom = linesEl.scrollTop + linesEl.clientHeight >= linesEl.scrollHeight - 2;
  linesEl.appendChild(row);
  if (atBottom) linesEl.scrollTop = linesEl.scrollHeight;
  syncToolListOverflow(linesEl);
}

/**
 * Einzeiler und Aufklapp-Zustand aus der Schrittliste ableiten (Issue #60).
 * Ein einzelner Schritt bekommt kein Aufklapp-Element: Chevron aus, <summary>
 * nicht fokussierbar, ein offenes <details> wird wieder geschlossen.
 */
function syncToolLogSummary(wrap, { thinking = false, elapsedMs = 0 } = {}) {
  if (!wrap) return;
  const summary = summarizeToolLog(readToolLogSteps(wrap), { thinking, elapsedMs });
  // Ohne Zeitangabe im Schlüssel, sonst füllt der Sekundentakt den Puffer.
  toolLogDebug.recordIfChanged('summary', {
    text: summary.text, extra: summary.extra, state: summary.state, count: summary.count, thinking,
  });
  const line = wrap.querySelector('.chat-tool-summary-line');
  if (line) syncToolSummaryLine(line, summary);

  syncToolListOverflow(wrap.querySelector('.chat-tool-lines'));
  wrap.classList.toggle('chat-tool-log--single', !summary.expandable);
  const summaryEl = wrap.querySelector('.chat-tool-summary');
  if (summaryEl) summaryEl.tabIndex = summary.expandable ? 0 : -1;
  if (!summary.expandable && wrap.open) wrap.open = false;
}

/**
 * Kategorie eines Trace-Eintrags. Vor #60 gespeicherte Sessions enthalten
 * bloße Strings ohne Tool-Namen — die bleiben ohne Symbol und lassen die
 * Zusammenfassung auf die alte Form zurückfallen.
 */
/**
 * Trace-Eintrag für Store und Verlauf: nur Anzeige-Zeile und Tool-Name. Die
 * Argumente aus dem Engine-Ergebnis bleiben bewusst draußen (write_file_text
 * trägt dort bis zu 2 MB Dateiinhalt).
 */
function toolTraceEntryForStore(entry) {
  const line = toolLineText(entry);
  const tool = typeof entry?.tool === 'string' ? entry.tool : '';
  const skill = typeof entry?.skill === 'string' ? entry.skill : '';
  if (!tool && !skill) return line;
  const out = { line };
  if (tool) out.tool = tool;
  if (skill) out.skill = skill;
  return out;
}

function traceEntryCategory(entry) {
  if (typeof entry === 'string' || !entry) return null;
  const hasInfo =
    (typeof entry.tool === 'string' && entry.tool)
    || (typeof entry.skill === 'string' && entry.skill);
  return hasInfo ? toolCategoryForEntry(entry) : null;
}

function hasToolSteps(message) {
  return (message?.toolTrace?.length || 0) + (message?.pendingToolLines?.length || 0) > 0;
}

/**
 * „Denkt nach“ = Streaming läuft, aber noch nichts Sichtbares: Warten auf die
 * Runde oder erste Tokens ohne Text (z. B. gestreamte Tool-Argumente, bevor
 * die vorläufige Zeile steht). Ein laufender Tool-Schritt hat in der
 * Einzeiler-Zeile ohnehin Vorrang.
 */
function isThinking(message) {
  if (!message?.streaming || message.phase === 'idle') return false;
  if (message.phase === 'generating') return !(message.content && message.content.length > 0);
  return true;
}

/**
 * Dauer des aktuellen Nachdenkens (Issue #87). `thinkingSince` setzt der
 * Phasenwechsel auf 'waiting' (Beginn jeder Runde) und löscht das nächste
 * Tool-Ereignis bzw. der erste Text; nur Anzeige, wird nicht persistiert.
 */
function thinkingElapsedMs(message) {
  const since = Number(message?.thinkingSince);
  return since > 0 ? Math.max(0, Date.now() - since) : 0;
}

/**
 * Die Phasen-Zeile über dem Tool-Log erscheint nur, solange es noch keinen
 * Tool-Schritt gibt. Danach zeigt der Tool-Einzeiler das Nachdenken selbst,
 * sonst würde die Zeile bei jeder Runde ein- und ausblenden und alles
 * darunter springen (Issue #60).
 */
function syncPhaseLine(phaseEl, message) {
  if (!phaseEl) return;
  const show = isThinking(message) && !hasToolSteps(message);
  phaseEl.classList.toggle('hidden', !show);
  // Auch vor dem ersten Tool-Schritt kann ein Reasoning-Modell lange nachdenken:
  // ab fünf Sekunden steht die Dauer dahinter (Issue #87).
  const elapsedMs = show ? thinkingElapsedMs(message) : 0;
  const suffix = elapsedMs >= THINKING_ELAPSED_MIN_MS ? ` · ${formatElapsedLabel(elapsedMs)}` : '';
  phaseEl.textContent = show ? `${THINKING_LABEL}${suffix}` : '';
}

const CHAT_SEND_ICON_HTML =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

const CHAT_STOP_ICON_HTML =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

const tokenCountFormatter = new Intl.NumberFormat('de-DE');

function formatChatTokenUsage(total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  if (n < 1000) {
    return `${tokenCountFormatter.format(n)} Tokens`;
  }
  const inK = n / 1000;
  if (inK < 10) {
    const oneDecimal = new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return `${oneDecimal.format(inK)} K Tokens`;
  }
  const wholeK = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${wholeK.format(inK)} K Tokens`;
}

function finalizeAllToolLines(wrap) {
  if (!wrap) return;
  // Vorläufige Zeilen ohne Start-Ereignis: Das Tool ist nie gelaufen (Abbruch/Fehler).
  wrap.querySelectorAll('.chat-tool-lines > .chat-tool-line--pending').forEach((row) => row.remove());
  wrap.querySelectorAll('.chat-tool-lines > .chat-tool-line--running').forEach(setToolLineDone);
  syncToolLogSummary(wrap);
}

function folderNameFromPath(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// Begrüßung als erste, rein anzeigende Assistant-Nachricht (greeting: true).
// Sie wird weder ans Modell geschickt noch persistiert — die App setzt keinen
// eigenen System-Prompt mehr, der Einstieg passiert über diese Nachricht.
function buildGreetingMessage(workspaceRoot) {
  if (!workspaceRoot) return null;
  const name = folderNameFromPath(workspaceRoot);
  return {
    role: 'assistant',
    greeting: true,
    content: `Wir sind im Ordner **„${name}"**. Was möchtest du tun?`,
  };
}

export function initChatStream({
  api,
  appStore,
  onInputChanged,
  stopChatVoiceListening,
  activeProviderConfigured,
  syncLiveDot,
  onWorkspaceFileWritten,
}) {
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');
  const chatTokenUsageEl = document.getElementById('chat-token-usage');

  function setChatTokenUsage(usage) {
    appStore.chatTokenUsage = coerceUsage(usage);
    syncChatTokenUsageDisplay();
  }

  function resetChatTokenUsage() {
    setChatTokenUsage({ prompt: 0, completion: 0, total: 0 });
  }

  function syncChatTokenUsageDisplay() {
    if (!chatTokenUsageEl) return;
    const total = appStore.chatTokenUsage?.total || 0;
    chatTokenUsageEl.textContent = formatChatTokenUsage(total);
  }

  function applyUsageFromResult(result) {
    if (!result?.usage) return;
    appStore.chatTokenUsage = mergeUsage(appStore.chatTokenUsage, result.usage);
    syncChatTokenUsageDisplay();
  }
  function syncChatSendButton() {
    const inFlight = !!appStore.chatInFlight;
    btnChatSend.classList.toggle('chat-send--stop', inFlight);
    btnChatSend.disabled = inFlight ? false : !activeProviderConfigured();
    btnChatSend.title = inFlight ? 'Antwort abbrechen' : 'Senden';
    btnChatSend.setAttribute('aria-label', inFlight ? 'Antwort abbrechen' : 'Senden');
    btnChatSend.innerHTML = inFlight ? CHAT_STOP_ICON_HTML : CHAT_SEND_ICON_HTML;
  }

  function buildToolLog(trace, state /* 'running' | 'done' */, pendingLines, { thinking = false, elapsedMs = 0 } = {}) {
    // Kompakter Tool-Log (Issue #60): <summary> zeigt eine Zeile (aktueller
    // bzw. letzter Schritt), der Body die vollständige Liste in Ausführungsreihenfolge.
    const log = document.createElement('details');
    log.className = 'chat-tool-log';
    log.classList.add(state === 'running' ? 'chat-tool-log--running' : 'chat-tool-log--done');
    if (state === 'running') log.setAttribute('aria-busy', 'true');

    const summaryEl = document.createElement('summary');
    summaryEl.className = 'chat-tool-summary';
    summaryEl.appendChild(buildToolSummaryLine());
    log.appendChild(summaryEl);

    const lines = document.createElement('div');
    lines.className = 'chat-tool-lines';
    lines.setAttribute('role', 'list');
    lines.setAttribute('aria-label', 'Alle Tool-Schritte');
    lines.addEventListener('scroll', () => syncToolListOverflow(lines));
    log.appendChild(lines);

    if (Array.isArray(trace) && trace.length > 0) {
      for (let i = 0; i < trace.length; i += 1) {
        const text = toolLineText(trace[i]);
        // Beim Nachdenken ist die vorige Runde komplett erledigt.
        const lineState =
          state === 'running' && !thinking && i === trace.length - 1 ? 'running' : 'done';
        lines.appendChild(buildToolLine(text, lineState, undefined, traceEntryCategory(trace[i])));
      }
    }
    if (state === 'running' && Array.isArray(pendingLines)) {
      for (const pending of pendingLines) {
        lines.appendChild(
          buildToolLine(pending.line, 'pending', pending.callIndex, traceEntryCategory(pending))
        );
      }
    }
    // Ein Schritt = eine Zeile: Öffnen (Klick/Tastatur) wieder zurücknehmen.
    log.addEventListener('toggle', () => {
      if (log.open && log.classList.contains('chat-tool-log--single')) log.open = false;
    });
    syncToolLogSummary(log, { thinking, elapsedMs });
    return log;
  }

  function appendReasoningDetails(bubble, reasoningText) {
    if (!reasoningText?.trim()) return;
    if (bubble.querySelector('.chat-reasoning-details')) return;
    const det = document.createElement('details');
    det.className = 'chat-reasoning-details';
    const sum = document.createElement('summary');
    sum.textContent = 'Zwischenschritte (Modell)';
    const body = document.createElement('pre');
    body.className = 'chat-reasoning-body';
    body.textContent = reasoningText;
    det.appendChild(sum);
    det.appendChild(body);
    const anchor = bubble.querySelector('.chat-md-streaming, .chat-md');
    if (anchor) bubble.insertBefore(det, anchor);
    else bubble.appendChild(det);
  }

  function finalizeStreamingToolLog(wrap) {
    finalizeAllToolLines(wrap);
    // Zugeklappt wieder an den Anfang: wer die Liste danach öffnet, liest von
    // oben. Eine offene Liste bleibt dort, wo der Nutzer sie hat.
    const lines = wrap.querySelector('.chat-tool-lines');
    if (lines && !wrap.open) {
      lines.scrollTop = 0;
      syncToolListOverflow(lines);
    }
    wrap.classList.remove('chat-tool-log--running');
    wrap.classList.add('chat-tool-log--done');
    wrap.removeAttribute('aria-busy');
  }

  function finalizeStreamingAssistantBubble(bubble, message) {
    delete message.pendingToolLines;
    delete message.thinkingSince;
    bubble.querySelector('.chat-phase')?.remove();
    bubble.querySelector('.chat-reasoning-stream')?.remove();

    const toolLog = bubble.querySelector('.chat-tool-log');
    if (toolLog) {
      finalizeStreamingToolLog(toolLog);
    } else if (Array.isArray(message.toolTrace) && message.toolTrace.length > 0) {
      const anchor = bubble.querySelector('.chat-md-streaming');
      const log = buildToolLog(message.toolTrace, 'done');
      if (anchor) bubble.insertBefore(log, anchor);
      else bubble.appendChild(log);
    }

    appendReasoningDetails(bubble, message.reasoningText);

    const streamEl = bubble.querySelector('.chat-md-streaming');
    if (streamEl) {
      streamEl.classList.remove('chat-md-streaming');
      streamEl.innerHTML = markdownToSafeHtml(message.content || '');
    }
  }

  function syncChatBusyState() {
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    const busy = !!(last && last.role === 'assistant' && last.streaming);
    chatMessagesEl.setAttribute('aria-busy', busy ? 'true' : 'false');
    syncLiveDot();
  }

  let streamRenderRaf = 0;

  function scheduleStreamRender(streamEl, text) {
    if (!streamEl) return;
    if (streamRenderRaf) cancelAnimationFrame(streamRenderRaf);
    streamRenderRaf = requestAnimationFrame(() => {
      streamRenderRaf = 0;
      streamEl.innerHTML = markdownToSafeHtml(text);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    });
  }

  function updateStreamingChrome() {
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    if (!last?.streaming) return;
    const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
    if (!bubble) return;
    syncPhaseLine(bubble.querySelector('.chat-phase'), last);
    syncToolLogSummary(bubble.querySelector('.chat-tool-log'), {
      thinking: isThinking(last),
      elapsedMs: thinkingElapsedMs(last),
    });
    const reasoningEl = bubble.querySelector('.chat-reasoning-stream');
    if (reasoningEl) {
      reasoningEl.textContent = last.reasoningText || '';
      if (last.reasoningText && last.reasoningText.length > 0) {
        reasoningEl.classList.remove('hidden');
      } else {
        reasoningEl.classList.add('hidden');
      }
    }
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  /**
   * Sekundentakt beim Nachdenken (Issue #87): nur die Einzeiler-Zeile
   * nachziehen — kein Scrollen, damit der Nutzer währenddessen oben lesen kann.
   */
  function syncThinkingElapsed() {
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    if (!last?.streaming || !isThinking(last)) return;
    const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
    if (!bubble) return;
    syncPhaseLine(bubble.querySelector('.chat-phase'), last);
    const wrap = bubble.querySelector('.chat-tool-log');
    if (wrap) syncToolLogSummary(wrap, { thinking: true, elapsedMs: thinkingElapsedMs(last) });
  }

  function renderChatMessages() {
    chatMessagesEl.innerHTML = '';
    for (const m of appStore.chatMessages) {
      const li = document.createElement('li');
      const roleClass = m.role === 'user' ? 'user' : 'assistant';
      li.classList.add('chat-msg', roleClass);
      if (m.isError) li.classList.add('error');
      if (m.role === 'assistant' && !m.isError) {
        if (m.streaming) {
          const phaseEl = document.createElement('div');
          phaseEl.className = 'chat-phase';
          syncPhaseLine(phaseEl, m);
          li.appendChild(phaseEl);

          const reasoningEl = document.createElement('pre');
          reasoningEl.className = 'chat-reasoning-stream';
          reasoningEl.textContent = m.reasoningText || '';
          if (!(m.reasoningText && m.reasoningText.length)) {
            reasoningEl.classList.add('hidden');
          }
          li.appendChild(reasoningEl);

          li.appendChild(
            buildToolLog(m.toolTrace, 'running', m.pendingToolLines, {
              thinking: isThinking(m),
              elapsedMs: thinkingElapsedMs(m),
            })
          );

          const stream = document.createElement('div');
          stream.className = 'chat-md-streaming chat-md';
          stream.innerHTML = markdownToSafeHtml(m.content || '');
          li.appendChild(stream);
        } else {
          if (Array.isArray(m.toolTrace) && m.toolTrace.length > 0) {
            li.appendChild(buildToolLog(m.toolTrace, 'done'));
          }
          if (m.reasoningText && m.reasoningText.trim()) {
            const det = document.createElement('details');
            det.className = 'chat-reasoning-details';
            const sum = document.createElement('summary');
            sum.textContent = 'Zwischenschritte (Modell)';
            const body = document.createElement('pre');
            body.className = 'chat-reasoning-body';
            body.textContent = m.reasoningText;
            det.appendChild(sum);
            det.appendChild(body);
            li.appendChild(det);
          }
          const inner = document.createElement('div');
          inner.className = 'chat-md';
          inner.innerHTML = markdownToSafeHtml(m.content);
          li.appendChild(inner);
        }
      } else {
        li.textContent = m.content;
      }
      chatMessagesEl.appendChild(li);
    }
    syncChatBusyState();
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function seedGreetingIfWorkspace(workspaceRoot) {
    const greeting = buildGreetingMessage(workspaceRoot);
    if (greeting) appStore.chatMessages.push(greeting);
  }

  async function persistCurrentChat() {
    const persistable = appStore.chatMessages.filter((m) => !m.greeting);
    if (!appStore.currentChatId || persistable.length === 0) return;
    await api.upsertChatSession({
      id: appStore.currentChatId,
      workspaceRoot: appStore.currentChatWorkspace,
      updatedAt: Date.now(),
      messages: persistable,
      tokenUsage: appStore.chatTokenUsage,
    });
    await api.setActiveChatId(appStore.currentChatWorkspace, appStore.currentChatId);
  }

  async function loadChatForWorkspace(workspaceRoot) {
    stopChatVoiceListening();
    await persistCurrentChat();
    appStore.chatSessionId += 1;

    const hist = await api.getChatHistory(workspaceRoot);
    const sessions = Array.isArray(hist?.sessions) ? hist.sessions : [];
    if (hist?.activeChatId) {
      const s = sessions.find((x) => x.id === hist.activeChatId);
      if (s && Array.isArray(s.messages)) {
        appStore.currentChatId = s.id;
        appStore.currentChatWorkspace = workspaceRoot || null;
        appStore.chatMessages = s.messages;
        setChatTokenUsage(s.tokenUsage);
        chatInput.value = '';
        onInputChanged();
        renderChatMessages();
        return;
      }
      await api.setActiveChatId(workspaceRoot, null);
    }
    appStore.currentChatId = crypto.randomUUID();
    appStore.currentChatWorkspace = workspaceRoot || null;
    appStore.chatMessages = [];
    seedGreetingIfWorkspace(appStore.currentChatWorkspace);
    resetChatTokenUsage();
    chatInput.value = '';
    onInputChanged();
    renderChatMessages();
  }

  async function startNewChat() {
    stopChatVoiceListening();
    await persistCurrentChat();
    appStore.chatSessionId += 1;
    appStore.currentChatId = crypto.randomUUID();
    appStore.currentChatWorkspace = appStore.rootPath || null;
    appStore.chatMessages = [];
    seedGreetingIfWorkspace(appStore.currentChatWorkspace);
    resetChatTokenUsage();
    chatInput.value = '';
    onInputChanged();
    await api.setActiveChatId(appStore.currentChatWorkspace, null);
    renderChatMessages();
  }

  function finalizeInFlightAssistantMessage() {
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    if (!last || last.role !== 'assistant' || !last.streaming) return false;
    last.streaming = false;
    last.phase = 'idle';
    const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
    if (bubble) {
      finalizeStreamingAssistantBubble(bubble, last);
      syncChatBusyState();
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      return true;
    }
    renderChatMessages();
    return true;
  }

  function abortChatRequest() {
    if (!appStore.chatInFlight) return;
    appStore.chatAbortedSendSeq = appStore.chatSendSeq;
    if (typeof api.abortChat === 'function') api.abortChat();
    finalizeInFlightAssistantMessage();
    appStore.chatInFlight = false;
    syncChatSendButton();
    void persistCurrentChat();
  }

  async function sendChatMessage() {
    if (appStore.chatInFlight) return;
    stopChatVoiceListening();
    const text = chatInput.value.trim();
    if (!text || !activeProviderConfigured()) return;
    const sessionAtSend = appStore.chatSessionId;
    chatInput.value = '';
    onInputChanged();
    appStore.chatMessages.push({ role: 'user', content: text });
    renderChatMessages();
    appStore.chatSendSeq += 1;
    const sendSeq = appStore.chatSendSeq;
    appStore.chatInFlight = true;
    syncChatSendButton();

    const payload = appStore.chatMessages
      .filter((m) => !m.greeting)
      .map(({ role, content }) => ({ role, content }));
    appStore.chatMessages.push({
      role: 'assistant',
      content: '',
      toolTrace: [],
      pendingToolLines: [],
      reasoningText: '',
      streaming: true,
      phase: 'waiting',
      thinkingSince: Date.now(),
    });
    renderChatMessages();

    const offDelta =
      typeof api.onChatDelta === 'function'
        ? api.onChatDelta((payload) => toolLogDebug.guard('chat:delta', () => {
            const deltaText = payload?.text;
            const last = appStore.chatMessages[appStore.chatMessages.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return;
            const hadContent = !!(last.content && last.content.length > 0);
            last.content = (last.content || '') + (deltaText || '');
            if (last.content) delete last.thinkingSince;
            const streamEl = chatMessagesEl.querySelector(
              '.chat-msg.assistant:last-of-type .chat-md-streaming'
            );
            if (streamEl) {
              scheduleStreamRender(streamEl, last.content);
            } else {
              renderChatMessages();
            }
            // Erster Text: „denkt nach“ endet, Phasen-Zeile und Einzeiler nachziehen.
            if (!hadContent && last.content) updateStreamingChrome();
          }))
        : () => {};

    const offTool =
      typeof api.onChatToolLine === 'function'
        ? api.onChatToolLine((payload) => toolLogDebug.guard('chat:tool-line', () => {
            toolLogDebug.record('tool-line', compactToolLinePayload(payload));
            const last = appStore.chatMessages[appStore.chatMessages.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return;

            const phase =
              typeof payload === 'object' && payload !== null && payload.phase
                ? payload.phase
                : 'start';
            // Main liefert fertige Anzeige-Zeilen in payload.line (Rohdaten optional für Debug).
            // Strings in toolTrace sind persistierte Alt-Sessions.
            const line =
              typeof payload === 'string'
                ? payload
                : typeof payload?.line === 'string'
                  ? payload.line
                  : '';
            if (!line) return;
            const callIndex = Number.isInteger(payload?.callIndex) ? payload.callIndex : null;
            // Ein Tool-Ereignis beendet die Denkpause; 'done' allein nicht — danach
            // kommt sofort 'waiting' für die nächste Runde (Issue #87).
            if (phase !== 'done') delete last.thinkingSince;
            if (!Array.isArray(last.toolTrace)) last.toolTrace = [];
            if (!Array.isArray(last.pendingToolLines)) last.pendingToolLines = [];

            // Zustand im Store: toolTrace = ausgeführte Tools (wird persistiert),
            // pendingToolLines = vom Modell noch gestreamte Aufrufe (nur Anzeige).
            // Der Tool-Name kommt mit dem Event und bleibt im Verlauf stehen —
            // daraus entstehen Symbol und gruppierte Zusammenfassung (#60).
            const tool = typeof payload?.tool === 'string' ? payload.tool : '';
            const skill = typeof payload?.skill === 'string' ? payload.skill : '';
            const entry = toolTraceEntryForStore({ line, tool, skill });
            if (phase === 'pending') {
              const existing = last.pendingToolLines.find((p) => p.callIndex === callIndex);
              if (existing) {
                existing.line = line;
                if (tool) existing.tool = tool;
                if (skill) existing.skill = skill;
              } else {
                last.pendingToolLines.push({
                  callIndex,
                  line,
                  tool: tool || undefined,
                  skill: skill || undefined,
                });
              }
            } else if (phase === 'start') {
              const pendingPos = last.pendingToolLines.findIndex((p) => p.callIndex === callIndex);
              if (pendingPos >= 0) last.pendingToolLines.splice(pendingPos, 1);
              else if (last.pendingToolLines.length > 0) last.pendingToolLines.shift();
              last.toolTrace.push(entry);
            } else if (phase === 'done') {
              if (last.toolTrace.length > 0) last.toolTrace[last.toolTrace.length - 1] = entry;
              else last.toolTrace.push(entry);
            }

            const wrap = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type .chat-tool-log');
            if (!wrap) {
              renderChatMessages();
              return;
            }

            let linesEl = wrap.querySelector('.chat-tool-lines');
            if (!linesEl) {
              linesEl = document.createElement('div');
              linesEl.className = 'chat-tool-lines';
              linesEl.setAttribute('role', 'list');
              wrap.appendChild(linesEl);
            }

            const category = traceEntryCategory({ tool, skill });
            if (phase === 'pending') {
              // Vorläufige Zeile anlegen bzw. aktualisieren (z. B. sobald der Pfad bekannt ist).
              const row = findPendingToolLine(linesEl, callIndex);
              if (row) setToolLineText(row, line);
              else appendToolLine(linesEl, buildToolLine(line, 'pending', callIndex, category));
            } else if (phase === 'done') {
              const runningRows = [...linesEl.querySelectorAll('.chat-tool-line--running')];
              setToolLineDone(runningRows[runningRows.length - 1], line);
            } else {
              linesEl.querySelectorAll('.chat-tool-line--running').forEach((row) => {
                setToolLineDone(row);
              });
              // Die passende vorläufige Zeile wird zur laufenden — sonst neue Zeile.
              const pendingRow = findPendingToolLine(linesEl, callIndex, true);
              if (pendingRow) promoteToolLineToRunning(pendingRow, line);
              else appendToolLine(linesEl, buildToolLine(line, 'running', callIndex, category));
            }

            syncToolLogSummary(wrap, { thinking: isThinking(last), elapsedMs: thinkingElapsedMs(last) });
            syncPhaseLine(wrap.closest('.chat-msg')?.querySelector('.chat-phase'), last);
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
          }, compactToolLinePayload(payload)))
        : () => {};

    const offProgress =
      typeof api.onChatProgress === 'function'
        ? api.onChatProgress((p) => toolLogDebug.guard('chat:progress', () => {
            const last = appStore.chatMessages[appStore.chatMessages.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return;
            if (p.type === 'phase' && p.phase) {
              toolLogDebug.record('phase', { phase: p.phase });
              last.phase = p.phase;
              // Jede Runde beginnt mit 'waiting': ab hier zählt die Denkzeit (Issue #87).
              if (p.phase === 'waiting') last.thinkingSince = Date.now();
              else if (p.phase === 'idle') delete last.thinkingSince;
              updateStreamingChrome();
            }
            if (p.type === 'reasoning' && p.text) {
              last.reasoningText = (last.reasoningText || '') + p.text;
              updateStreamingChrome();
            }
            if (
              p.type === 'workspace'
              && p.event === 'fileWritten'
              && typeof p.relativePath === 'string'
              && typeof onWorkspaceFileWritten === 'function'
            ) {
              onWorkspaceFileWritten(p.relativePath);
            }
          }, p?.type))
        : () => {};

    // Sekundentakt für die Denkzeit (Issue #87); endet mit der Antwort.
    const elapsedTicker = setInterval(syncThinkingElapsed, 1000);

    let result;
    try {
      result = await api.chat(payload, {
        workspaceRoot: appStore.rootPath,
        selectedPath: appStore.selectedPath,
        selectedIsDirectory: appStore.selectedIsDirectory,
      });
    } finally {
      clearInterval(elapsedTicker);
      offDelta();
      offTool();
      offProgress();
      appStore.chatInFlight = false;
      syncChatSendButton();
    }

    if (sessionAtSend !== appStore.chatSessionId) return;

    const abortedLocally = appStore.chatAbortedSendSeq === sendSeq;
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    let skipRender = false;
    if (abortedLocally || result?.cancelled) {
      if (last && last.role === 'assistant') {
        if (last.streaming) {
          last.streaming = false;
          if (typeof result?.content === 'string' && result.content.length > 0) {
            last.content = result.content;
          }
          last.toolTrace = Array.isArray(result?.toolTrace)
            ? result.toolTrace.map(toolTraceEntryForStore)
            : last.toolTrace || [];
          const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
          if (bubble) {
            finalizeStreamingAssistantBubble(bubble, last);
            syncChatBusyState();
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
            skipRender = true;
          }
        }
      }
      if (appStore.chatAbortedSendSeq === sendSeq) {
        appStore.chatAbortedSendSeq = 0;
      }
    } else if (result.error) {
      if (last && last.streaming) {
        appStore.chatMessages.pop();
      }
      appStore.chatMessages.push({ role: 'assistant', content: result.error, isError: true });
    } else if (last && last.role === 'assistant' && last.streaming) {
      last.streaming = false;
      last.content = result.content ?? '';
      last.toolTrace = Array.isArray(result.toolTrace)
        ? result.toolTrace.map(toolTraceEntryForStore)
        : last.toolTrace || [];
      const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
      if (bubble) {
        finalizeStreamingAssistantBubble(bubble, last);
        syncChatBusyState();
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        skipRender = true;
      }
    }
    if (!skipRender) renderChatMessages();
    applyUsageFromResult(result);
    await persistCurrentChat();
  }

  chatMessagesEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
      e.preventDefault();
      api.openExternal(href);
    }
  });

  function onSendOrStopClick() {
    if (appStore.chatInFlight) {
      abortChatRequest();
      return;
    }
    sendChatMessage();
  }

  btnChatSend.addEventListener('click', onSendOrStopClick);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  let tokenUsageNoteTimer = 0;
  function flashTokenUsageNote(text) {
    if (!chatTokenUsageEl) return;
    clearTimeout(tokenUsageNoteTimer);
    chatTokenUsageEl.textContent = text;
    tokenUsageNoteTimer = setTimeout(() => {
      tokenUsageNoteTimer = 0;
      syncChatTokenUsageDisplay();
    }, 2500);
  }

  // Diagnose-Export (Issue #87): Strg/Cmd+Shift+D kopiert den Tool-Log-Puffer
  // (Ereignisse, Zustände der Einzeiler-Zeile, abgefangene Fehler) als JSON.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
    if (String(e.key).toLowerCase() !== 'd') return;
    e.preventDefault();
    const json = toolLogDebug.serialize();
    const toConsole = () => {
      console.info(json);
      toolLogDebug.record('export', { via: 'console' });
      flashTokenUsageNote('Tool-Log-Diagnose in der Konsole');
    };
    // Über den Main-Prozess, weil der Permission-Handler der App
    // navigator.clipboard im Renderer nicht zulässt.
    const write = typeof api.writeClipboardText === 'function'
      ? api.writeClipboardText(json).then((r) => (r?.ok ? r : Promise.reject(new Error(r?.error || 'Zwischenablage'))))
      : Promise.reject(new Error('Zwischenablage nicht verfügbar.'));
    write.then(() => {
      toolLogDebug.record('export', { via: 'clipboard' });
      flashTokenUsageNote('Tool-Log-Diagnose kopiert');
    }, toConsole);
  });

  syncChatTokenUsageDisplay();

  return {
    renderChatMessages,
    persistCurrentChat,
    loadChatForWorkspace,
    startNewChat,
    seedGreetingIfWorkspace,
    sendChatMessage,
    syncChatSendButton,
    resetChatTokenUsage,
    setChatTokenUsage,
  };
}
