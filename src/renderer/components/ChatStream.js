import { markdownToSafeHtml } from '../utils/helpers.js';
import { isOpenableChatLink, openChatLink } from '../chat/openChatLink.js';
// Bild-Anhaenge im Composer (Issue #84): Aufnahme aus der Zwischenablage,
// Limits und Verkleinern.
import {
  imageFilesFromClipboard,
  planAttachmentIntake,
  prepareImageAttachment,
  rejectionMessage,
  toDataUrl,
} from '../chat/imageAttachments.js';
// Token-Usage-Normalisierung/-Summierung aus der gemeinsamen Contract-Schicht,
// damit Anzeige (Renderer) und Provider-Seite (Main) nicht auseinanderlaufen.
import contracts from '../generated/contracts.js';
// Sichtbarer Tool-Log (Issue #60/#81): Zeilen, Einzeiler und Phasenzeile als
// eigenes Modul — ChatStream sagt nur noch, wann sich etwas geaendert hat.
import {
  appendToolLine,
  applyPermissionToRow,
  buildToolLine,
  buildToolLog,
  finalizeAllToolLines,
  findPendingToolLine,
  isThinking,
  promoteToolLineToRunning,
  setToolLineDone,
  setToolLineText,
  syncPhaseLine,
  syncToolListOverflow,
  syncToolLogSummary,
  thinkingElapsedMs,
  toolTraceEntryForStore,
  traceEntryCategory,
} from '../chat/toolLogView.js';
// Diagnose-Puffer für den Tool-Log (Issue #87): Ereignisse, Zustände, Fehler.
import { toolLogDebug } from '../chat/toolLogDebug.js';
import { compactToolLinePayload } from '../utils/tool-log-debug.js';
// Aufschlüsselung hinter der Token-Anzeige (Issue #174).
import { initTokenBreakdownPanel } from './TokenBreakdownPanel.js';
// Klick auf ein Thumbnail zeigt das Bild gross (Issue #94).
import { initImageLightbox } from './ImageLightbox.js';
// Bilder aus dem Arbeitsordner in der Antwort (Issue #244): Die Bytes kommen
// per IPC und werden nach dem Sanitizing auf den fertigen <img>-Knoten gesetzt.
import { applyWorkspaceImages, clearWorkspaceImageCache } from '../chat/workspaceImages.js';
import { getLocale, onLocaleChange, t, tMessage } from '../i18n.js';

const { coerceUsage, createEmptyUsage, inferChatTitle } = contracts;

const CHAT_SEND_ICON_HTML =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

const CHAT_STOP_ICON_HTML =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

// A thousands separator is a dot in German and a comma in English, so the
// formatter follows the interface language rather than the machine's (#290).
function tokenCount(value, digits = 0) {
  return new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatChatTokenUsage(total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  if (n < 1000) return t('chat.tokens', { count: tokenCount(n) });
  const inK = n / 1000;
  return t('chat.tokens.thousands', { count: tokenCount(inK, inK < 10 ? 1 : 0) });
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
    content: t('chat.greeting', { name }),
  };
}

/**
 * Welche Konversation gehoert beim Betreten eines Ordners auf den Schirm
 * (Issue #131)? `getChatHistory` liefert nur Sessions des aktiven Workspaces.
 * Erste Wahl ist die gemerkte aktive Chat-ID, zweite die zuletzt gefuehrte
 * Session. Ohne diese zweite Stufe bliebe ein Ordner leer, sobald keine aktive
 * ID gemerkt ist — etwa nach „Neuer Chat“ ohne Eingabe oder nach dem Loeschen
 * des aktiven Chats.
 *
 * DOM-frei und exportiert, weil es keinen DOM-Test-Stack gibt (#78).
 */
export function pickSessionToRestore(sessions, activeChatId) {
  const usable = Array.isArray(sessions)
    ? sessions.filter((s) => s && Array.isArray(s.messages) && s.messages.length > 0)
    : [];
  const active = activeChatId ? usable.find((s) => s.id === activeChatId) : null;
  if (active) return { session: active, wasActive: true };
  let newest = null;
  const at = (s) => (Number.isFinite(s.updatedAt) ? s.updatedAt : 0);
  for (const s of usable) {
    if (!newest || at(s) > at(newest)) newest = s;
  }
  return { session: newest || null, wasActive: false };
}

export function initChatStream({
  api,
  appStore,
  onInputChanged,
  stopChatVoiceListening,
  activeProviderConfigured,
  activeProviderSupportsImages,
  syncLiveDot,
  syncChatTitle,
  onWorkspaceFileWritten,
  approvalCards,
  openSkillSettings,
  // Modell und Freigabemodus des Chats herstellen (Issue #211).
  activateChatSession = async () => {},
  // Meldet, dass der laufende Chat in die Ablage geschrieben wurde — der
  // Verlauf haengt daran seine Liste nach (Epic #223, Phase B).
  onChatPersisted = () => {},
  // A run started, ended or changed its state — the history column marks
  // running chats (#320).
  onRunsChanged = () => {},
}) {
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnChatSend = document.getElementById('btn-chat-send');
  const chatTokenUsageEl = document.getElementById('chat-token-usage');
  const chatTokenUsageValueEl = document.getElementById('chat-token-usage-value');
  const chatTokenBreakdownEl = document.getElementById('chat-token-breakdown');
  const chatAttachmentsEl = document.getElementById('chat-attachments');

  // Anhaenge des noch nicht abgeschickten Zuges (Issue #84). Sie leben nur im
  // Composer; mit dem Senden wandern sie an die Nachricht.
  let pendingAttachments = [];

  const imageLightbox = initImageLightbox();

  const tokenBreakdownPanel = initTokenBreakdownPanel({
    trigger: chatTokenUsageEl,
    panel: chatTokenBreakdownEl,
    getState: () => ({
      breakdown: appStore.chatContextBreakdown,
      usage: appStore.chatTokenUsage,
      inFlight: !!appStore.chatInFlight,
    }),
    // Wer sieht, dass ein Skill 3.000 Token kostet, will ihn sofort
    // abschalten können (Issue #174).
    onOpenSkillSettings: (name) => openSkillSettings?.(name),
  });

  function setChatTokenUsage(usage, { breakdown = null } = {}) {
    appStore.chatTokenUsage = coerceUsage(usage);
    appStore.chatContextBreakdown = breakdown;
    syncChatTokenUsageDisplay();
  }

  function resetChatTokenUsage() {
    setChatTokenUsage({ prompt: 0, completion: 0, total: 0 });
  }

  // Der Zaehler zeigt die Groesse des Kontextfensters, das zuletzt an das
  // Modell ging: die Prompt-Tokens der letzten LLM-Runde. Er wird pro Zug
  // ersetzt, nicht aufaddiert — der Verbrauch ueber den Chat ist keine
  // Kontextgroesse.
  function syncChatTokenUsageDisplay() {
    if (!chatTokenUsageEl) return;
    const usage = appStore.chatTokenUsage || createEmptyUsage();
    if (chatTokenUsageValueEl) chatTokenUsageValueEl.textContent = formatChatTokenUsage(usage.prompt);
    chatTokenUsageEl.title = t('chat.tokens.title', {
      prompt: tokenCount(usage.prompt),
      completion: tokenCount(usage.completion),
    });
    tokenBreakdownPanel.refresh();
  }

  function applyUsageFromResult(result) {
    // contextUsage = letzte Runde (Kontext). Aeltere Engine-Ergebnisse ohne
    // das Feld liefern nur die Zugsumme; die ist dann das Beste, was wir haben.
    const usage = result?.contextUsage ?? result?.usage;
    if (!usage) return;
    appStore.chatTokenUsage = coerceUsage(usage);
    // Die Aufschlüsselung gehoert zu genau dieser Zahl (Issue #174) — fehlt
    // sie, bleibt keine alte stehen, die etwas anderes beschreibt.
    appStore.chatContextBreakdown = result?.contextBreakdown ?? null;
    syncChatTokenUsageDisplay();
  }
  function syncChatSendButton() {
    const inFlight = !!appStore.chatInFlight;
    btnChatSend.classList.toggle('chat-send--stop', inFlight);
    btnChatSend.disabled = inFlight ? false : !activeProviderConfigured();
    const sendLabel = t(inFlight ? 'chat.send.abort' : 'chat.send');
    btnChatSend.title = sendLabel;
    btnChatSend.setAttribute('aria-label', sendLabel);
    btnChatSend.innerHTML = inFlight ? CHAT_STOP_ICON_HTML : CHAT_SEND_ICON_HTML;
    // Die Aufschlüsselung sagt waehrend einer laufenden Anfrage dazu, dass
    // ihre Werte noch von der vorherigen stammen (Issue #174).
    tokenBreakdownPanel.refresh();
  }

  function appendReasoningDetails(bubble, reasoningText) {
    if (!reasoningText?.trim()) return;
    if (bubble.querySelector('.chat-reasoning-details')) return;
    const det = document.createElement('details');
    det.className = 'chat-reasoning-details';
    const sum = document.createElement('summary');
    sum.textContent = t('chat.reasoning.title');
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
    delete message.toolRunning;
    delete message.runningCallIndex;
    delete message.permissionNote;
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

    // Ein noch ausstehender Frame des Streams wuerde gleich wieder den
    // Zwischenstand schreiben — samt Platzhaltern statt der Bilder (#244).
    cancelStreamRender();
    const streamEl = bubble.querySelector('.chat-md-streaming');
    if (streamEl) {
      streamEl.classList.remove('chat-md-streaming');
      streamEl.innerHTML = markdownToSafeHtml(message.content || '');
      // Erst jetzt: Waehrend des Streams stand hier nur ein Platzhalter.
      void showWorkspaceImages(streamEl);
    }
  }

  function syncChatBusyState() {
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    const busy = !!(last && last.role === 'assistant' && last.streaming);
    chatMessagesEl.setAttribute('aria-busy', busy ? 'true' : 'false');
    syncLiveDot();
  }

  /**
   * Bilder eines gerenderten Antwort-Knotens aufloesen (Issue #244). Relative
   * Pfade gelten gegen den **gerade** geoeffneten Ordner — ein in einem anderen
   * Workspace geoeffneter Verlauf zeigt deshalb Platzhalter statt fremder
   * Bilder, und auf den frueheren Ordner wird nie zugegriffen.
   */
  function showWorkspaceImages(container, { streaming = false } = {}) {
    return applyWorkspaceImages(container, { api, workspaceRoot: appStore.rootPath, streaming });
  }

  let streamRenderRaf = 0;

  function cancelStreamRender() {
    if (!streamRenderRaf) return;
    cancelAnimationFrame(streamRenderRaf);
    streamRenderRaf = 0;
  }

  function scheduleStreamRender(streamEl, text) {
    if (!streamEl) return;
    cancelStreamRender();
    streamRenderRaf = requestAnimationFrame(() => {
      streamRenderRaf = 0;
      streamEl.innerHTML = markdownToSafeHtml(text);
      void showWorkspaceImages(streamEl, { streaming: true });
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

  // Symbol fuer einen Anhang, dessen Datei nicht mehr da ist: Bildrahmen mit
  // Strich. Kein Emoji, kein Rot — der Zustand steht zusaetzlich als Text da.
  const MISSING_IMAGE_ICON_HTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/>' +
    '<path d="M3.5 16.5 8.5 11l3.5 3.5"/><circle cx="15.5" cy="9" r="1.4"/>' +
    '<path d="M4 20 20 4"/></svg>';

  /**
   * Bilder einer gesendeten Nachricht. Frisch eingefuegte Anhaenge tragen ihre
   * Daten noch selbst; aus dem Verlauf geladene nur eine Datei-Referenz — die
   * wird hier nachgeholt (Issue #94).
   */
  function buildAttachmentGallery(attachments) {
    const gallery = document.createElement('ul');
    gallery.className = 'chat-msg-attachments';
    for (const attachment of attachments) {
      gallery.appendChild(buildAttachmentTile(attachment));
    }
    return gallery;
  }

  function buildAttachmentTile(attachment) {
    const item = document.createElement('li');
    const label = attachment?.name || t('chat.attachment.fallbackName');

    const showImage = (src) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-msg-attachment';
      button.setAttribute('aria-label', t('chat.attachment.zoom', { label }));
      button.title = label;
      const img = document.createElement('img');
      img.className = 'chat-msg-attachment-img';
      img.src = src;
      img.alt = label;
      button.appendChild(img);
      button.addEventListener('click', () => imageLightbox.open({ src, alt: label, trigger: button }));
      item.replaceChildren(button);
    };

    const showNote = (modifier, text) => {
      const box = document.createElement('div');
      box.className = `chat-msg-attachment chat-msg-attachment--${modifier}`;
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `${label}: ${text}`);
      if (modifier === 'missing') {
        const icon = document.createElement('span');
        icon.className = 'chat-msg-attachment-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = MISSING_IMAGE_ICON_HTML;
        box.appendChild(icon);
      }
      const note = document.createElement('span');
      note.className = 'chat-msg-attachment-note';
      note.textContent = text;
      box.appendChild(note);
      item.replaceChildren(box);
    };

    const inlineUrl = toDataUrl(attachment);
    if (inlineUrl) {
      showImage(inlineUrl);
    } else if (attachment?.file) {
      showNote('loading', t('chat.attachment.loading'));
      void loadStoredAttachment(attachment, { showImage, showNote });
    } else {
      showNote('missing', t('chat.attachment.missing'));
    }
    return item;
  }

  async function loadStoredAttachment(attachment, { showImage, showNote }) {
    const chatId = appStore.currentChatId;
    const sessionAtLoad = appStore.chatSessionId;
    let result = null;
    try {
      result =
        typeof api.readChatAttachment === 'function'
          ? await api.readChatAttachment(chatId, attachment.file)
          : null;
    } catch {
      result = null;
    }
    // Der Nutzer kann inzwischen die Konversation gewechselt haben.
    if (sessionAtLoad !== appStore.chatSessionId) return;
    if (!result?.ok || !result.dataBase64) {
      showNote('missing', t('chat.attachment.missing'));
      return;
    }
    // Einmal geholt, bleibt das Bild am Anhang haengen: das naechste Rendern
    // kommt ohne IPC aus, und eine Anschlussfrage nimmt es wieder mit zum
    // Modell — sonst fiele es beim Weiterreden aus dem Kontext.
    attachment.dataBase64 = result.dataBase64;
    if (result.mediaType) attachment.mediaType = result.mediaType;
    showImage(toDataUrl(attachment));
  }

  function renderChatMessages() {
    // Der Kurztitel in der Kopfzeile leitet sich aus der ersten Nutzerfrage
    // ab und steht deshalb erst nach dem Rendern der Nachrichten fest.
    syncChatTitle?.();
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

          // A step that is running is not thinking, even if the phase says so
          // — without this a chat opened again mid-run showed its running
          // step as done (#320).
          const toolLog = buildToolLog(m.toolTrace, 'running', m.pendingToolLines, {
            thinking: isThinking(m) && !m.toolRunning,
            elapsedMs: thinkingElapsedMs(m),
          });
          const runningRow = m.toolRunning ? [...toolLog.querySelectorAll('.chat-tool-lines > .chat-tool-line--running')].pop() : null;
          if (runningRow) {
            if (Number.isInteger(m.runningCallIndex)) runningRow.dataset.callIndex = String(m.runningCallIndex);
            if (m.permissionNote) showPermissionNote(runningRow, m.permissionNote);
            syncToolLogSummary(toolLog, { thinking: false, elapsedMs: thinkingElapsedMs(m) });
          }
          li.appendChild(toolLog);

          // Freigabe-Karten (Issue #67) stehen sichtbar zwischen Tool-Log und
          // Antworttext – außerhalb des eingeklappten Logs.
          const cardsBox = document.createElement('div');
          cardsBox.className = 'chat-approval-cards';
          li.appendChild(cardsBox);

          const stream = document.createElement('div');
          stream.className = 'chat-md-streaming chat-md';
          stream.innerHTML = markdownToSafeHtml(m.content || '');
          void showWorkspaceImages(stream, { streaming: true });
          li.appendChild(stream);
          approvalCards?.mount(li, m);
        } else {
          if (Array.isArray(m.toolTrace) && m.toolTrace.length > 0) {
            li.appendChild(buildToolLog(m.toolTrace, 'done'));
          }
          if (m.reasoningText && m.reasoningText.trim()) {
            const det = document.createElement('details');
            det.className = 'chat-reasoning-details';
            const sum = document.createElement('summary');
            sum.textContent = t('chat.reasoning.title');
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
          void showWorkspaceImages(inner);
          li.appendChild(inner);
          // Karten des abgeschlossenen Zuges (Entscheidung, Verfall, Abbruch)
          // bleiben an ihrer Nachricht, bis der Chat gewechselt wird.
          approvalCards?.mount(li, m);
        }
      } else {
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          li.appendChild(buildAttachmentGallery(m.attachments));
        }
        if (m.content) {
          const textEl = document.createElement('div');
          textEl.className = 'chat-msg-text';
          textEl.textContent = m.content;
          li.appendChild(textEl);
        }
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

  /**
   * Writes a chat into the history. Any chat, not only the one on screen: a
   * run that ends in the background writes its own (#320) — and does not make
   * it the folder's active chat, which stays the one the user looks at.
   */
  async function persistChat(chat, { markActive = false } = {}) {
    if (!chat?.id || lastPersisted.get(chat.id) === DELETED) return;
    const persistable = persistableMessages(chat.messages);
    if (persistable.length === 0) return;
    lastPersisted.set(chat.id, { messages: chat.messages, count: persistable.length });
    // Ohne Zeitstempel: Wann ein Chat zuletzt gefuehrt wurde, entscheidet der
    // Main am Nachrichtenstand (Issue #245). Diese Funktion laeuft auch beim
    // blossen Verlassen eines Chats — ein Stempel von hier hiesse „heute
    // gesprochen“, obwohl niemand etwas gesagt hat.
    await api.upsertChatSession({
      id: chat.id,
      workspaceRoot: chat.workspaceRoot,
      messages: persistable,
      tokenUsage: chat.tokenUsage,
      // Nur einen bereits benannten Chat betiteln — sonst leitet die Ablage
      // den Titel selbst aus der ersten Frage ab.
      ...(chat.title ? { title: chat.title } : {}),
    });
    if (markActive) await api.setActiveChatId(chat.id);
    // Die Verlaufsspalte steht seit Epic #223 (Phase B) dauerhaft daneben und
    // wuerde sonst den alten Titel und den alten Zeitpunkt zeigen.
    onChatPersisted();
  }

  async function persistCurrentChat() {
    await persistChat(currentChatSnapshot(), { markActive: true });
  }

  /**
   * Meldet zurueck, ob eine vorhandene Konversation wiederhergestellt wurde —
   * der Start richtet die mittlere Spalte danach aus (Issue #208).
   */
  async function loadChatForWorkspace(workspaceRoot) {
    stopChatVoiceListening();
    await persistCurrentChat();
    appStore.chatSessionId += 1;

    const hist = await api.getChatHistory();
    const sessions = Array.isArray(hist?.sessions) ? hist.sessions : [];
    const { session: restore, wasActive } = pickSessionToRestore(sessions, hist?.activeChatId);
    // A run in the chat just shown goes on in the background (#320).
    detachCurrentChat();
    if (restore) {
      // Still running in memory, that state is newer than the file.
      if (!attachChat(restore.id)) {
        appStore.currentChatId = restore.id;
        appStore.currentChatWorkspace = workspaceRoot || null;
        appStore.chatMessages = restore.messages;
        appStore.currentChatTitle = restore.title || '';
        setChatTokenUsage(restore.tokenUsage);
      }
      // Die zuletzt gefuehrte Konversation wird damit auch die aktive dieses
      // Ordners — sonst begaenne der naechste Wechsel wieder von vorn.
      if (!wasActive) await api.setActiveChatId(restore.id);
      // Automatisch hergestellt (App-Start, Ordnerwechsel): Modell und Modus
      // dieses Chats gelten wieder — „Auto“ aber nicht, das faellt auf
      // „Intelligent“ zurueck (Issue #211).
      await activateChatSession(restore.id, 'auto');
      chatInput.value = '';
      onInputChanged();
      renderChatMessages();
      afterChatSwitch();
      return { restored: true, wasActive };
    }
    if (hist?.activeChatId) await api.setActiveChatId(null);
    appStore.currentChatId = crypto.randomUUID();
    appStore.currentChatWorkspace = workspaceRoot || null;
    appStore.chatMessages = [];
    appStore.currentChatTitle = '';
    seedGreetingIfWorkspace(appStore.currentChatWorkspace);
    resetChatTokenUsage();
    await activateChatSession(appStore.currentChatId, 'auto');
    chatInput.value = '';
    onInputChanged();
    renderChatMessages();
    afterChatSwitch();
    return { restored: false, wasActive: false };
  }

  async function startNewChat() {
    stopChatVoiceListening();
    await persistCurrentChat();
    // A run in the chat just left goes on in the background (#320).
    detachCurrentChat();
    appStore.chatSessionId += 1;
    appStore.currentChatId = crypto.randomUUID();
    appStore.currentChatWorkspace = appStore.rootPath || null;
    appStore.chatMessages = [];
    appStore.currentChatTitle = '';
    seedGreetingIfWorkspace(appStore.currentChatWorkspace);
    resetChatTokenUsage();
    chatInput.value = '';
    onInputChanged();
    await api.setActiveChatId(null);
    // Neuer Chat: Standard-Modell aus den Einstellungen, Modus „Intelligent“.
    await activateChatSession(appStore.currentChatId, 'explicit');
    renderChatMessages();
    afterChatSwitch();
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

  // --- Runs per chat (#320) --------------------------------------------------
  //
  // A run belongs to the chat it was started in, not to the screen. While its
  // chat is on screen, the chat's data lives in `appStore` as it always did and
  // the run draws into the list. When another chat takes the screen, the run
  // takes its chat along (`run.chat`) and goes on writing into those messages
  // without touching the list; opening the chat again puts it back on screen.

  let runSeq = 0;
  // chatId → what was written last: the message array and how many messages
  // went in. A title that arrives late only writes its snapshot if that is
  // still the latest state of the chat.
  const lastPersisted = new Map();
  const DELETED = Symbol('deleted');

  function persistableMessages(messages) {
    return messages.filter((m) => !m.greeting);
  }

  /** Whether `chat` is exactly what the history holds for it right now. */
  function isLatestWritten(chat) {
    const latest = lastPersisted.get(chat.id);
    return !!latest && latest !== DELETED && latest.messages === chat.messages
      && latest.count === persistableMessages(chat.messages).length;
  }

  function isRunning(run) {
    return !!run && !run.settled && !run.aborted;
  }

  function isOnScreen(run) {
    return !!run && !run.chat && run.chatId === appStore.currentChatId;
  }

  /** `'running'`, `'awaiting'` (a card waits for the user) or `null`. */
  function runStateOf(chatId) {
    const run = appStore.chatRuns.get(chatId);
    if (!isRunning(run)) return null;
    return approvalCards?.pendingChatIds?.().has(chatId) ? 'awaiting' : 'running';
  }

  /** The chat on screen plus every chat that still has its run in memory. */
  function liveChatIds() {
    return new Set([appStore.currentChatId || null, ...appStore.chatRuns.keys()]);
  }

  function syncChatInFlight() {
    appStore.chatInFlight = isRunning(appStore.chatRuns.get(appStore.currentChatId));
    syncChatSendButton();
  }

  function notifyRunsChanged() {
    try {
      onRunsChanged();
    } catch {
      // The history column is a view; it must not get in the way of a run.
    }
  }

  // Sekundentakt für die Denkzeit (Issue #87). One for all runs: it only ever
  // touches the chat on screen, and stops once nothing is running.
  let elapsedTicker = 0;
  function syncElapsedTicker() {
    const anyRunning = [...appStore.chatRuns.values()].some(isRunning);
    if (anyRunning && !elapsedTicker) {
      elapsedTicker = setInterval(syncThinkingElapsed, 1000);
    } else if (!anyRunning && elapsedTicker) {
      clearInterval(elapsedTicker);
      elapsedTicker = 0;
    }
  }

  function currentChatSnapshot() {
    return {
      id: appStore.currentChatId,
      workspaceRoot: appStore.currentChatWorkspace,
      messages: appStore.chatMessages,
      title: appStore.currentChatTitle,
      tokenUsage: appStore.chatTokenUsage,
      contextBreakdown: appStore.chatContextBreakdown,
    };
  }

  /** Before another chat takes the screen: a running chat takes its data along. */
  function detachCurrentChat() {
    const run = appStore.chatRuns.get(appStore.currentChatId);
    if (run && !run.chat) run.chat = currentChatSnapshot();
    // A frame still due would draw the old chat's stream into the next one.
    cancelStreamRender();
  }

  /** Whether this chat is in memory with its run — then it opens from there, not from disk. */
  function canAttachChat(chatId) {
    return !!appStore.chatRuns.get(chatId)?.chat;
  }

  /** Puts a chat that still has its run in memory back on screen. */
  function attachChat(chatId) {
    const run = appStore.chatRuns.get(chatId);
    if (!run?.chat) return false;
    const chat = run.chat;
    run.chat = null;
    appStore.currentChatId = chat.id;
    appStore.currentChatWorkspace = chat.workspaceRoot;
    appStore.chatMessages = chat.messages;
    appStore.currentChatTitle = chat.title;
    setChatTokenUsage(chat.tokenUsage, { breakdown: chat.contextBreakdown });
    return true;
  }

  /** After the screen switched chats: the send button, the cards and the history follow. */
  function afterChatSwitch() {
    syncChatInFlight();
    approvalCards?.retainChats?.(liveChatIds());
    notifyRunsChanged();
  }

  /** The chat is being deleted: its run stops and must not write the chat back. */
  function discardChatRun(chatId) {
    lastPersisted.set(chatId, DELETED);
    const run = appStore.chatRuns.get(chatId);
    if (!run) return;
    run.discarded = true;
    if (!run.settled && !run.aborted) {
      run.aborted = true;
      if (typeof api.abortChat === 'function') api.abortChat(chatId);
    }
    appStore.chatRuns.delete(chatId);
    syncChatInFlight();
    syncElapsedTicker();
    notifyRunsChanged();
  }

  /**
   * The run an event belongs to (#320). Events name their chat and their run;
   * a late event of an earlier turn, or of a run that has ended, finds nothing.
   */
  function runForEvent(payload) {
    const chatId = typeof payload?.chatId === 'string' ? payload.chatId : null;
    const run = chatId ? appStore.chatRuns.get(chatId) : null;
    if (!run || run.settled || run.runId !== payload?.runId) return null;
    const last = run.assistantMessage;
    if (!last || last.role !== 'assistant' || !last.streaming) return null;
    return run;
  }

  /** What a permission event says about the running step: waiting, denied, expired — or nothing. */
  function permissionNoteFor(p) {
    if (p.event === 'awaiting') return 'awaiting';
    if (p.event !== 'resolved') return null;
    const allowed = typeof p.response === 'string' && p.response !== 'deny';
    if (allowed) return null;
    return p.response === 'deny' ? 'denied' : 'expired';
  }

  const PERMISSION_NOTES = Object.freeze({
    awaiting: { suffix: 'tools.line.suffix.awaiting', state: 'awaiting' },
    denied: { suffix: 'tools.line.suffix.denied', state: 'denied' },
    expired: { suffix: 'tools.line.suffix.expired', state: 'cancelled' },
  });

  /** Warten und Entscheidung an der Tool-Zeile sichtbar machen (Issue #67). */
  function showPermissionNote(row, note) {
    if (!row) return;
    const textEl = row.querySelector('.chat-tool-line-text');
    const base = row.dataset.baseText || textEl?.textContent || '';
    if (!row.dataset.baseText) row.dataset.baseText = base;
    const shown = PERMISSION_NOTES[note];
    setToolLineText(row, shown ? `${base} · ${t(shown.suffix)}` : base);
    if (shown) row.dataset.permission = shown.state;
    else if (note === 'allowed') row.dataset.permission = 'allowed';
  }

  function onChatDelta(payload) {
    const run = runForEvent(payload);
    if (!run) return;
    const last = run.assistantMessage;
    const hadContent = !!(last.content && last.content.length > 0);
    last.content = (last.content || '') + (payload?.text || '');
    if (last.content) delete last.thinkingSince;
    // Off screen, the message is all there is; the list is drawn from it on return.
    if (!isOnScreen(run)) return;
    const streamEl = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type .chat-md-streaming');
    if (streamEl) {
      scheduleStreamRender(streamEl, last.content);
    } else {
      renderChatMessages();
    }
    // Erster Text: „denkt nach“ endet, Phasen-Zeile und Einzeiler nachziehen.
    if (!hadContent && last.content) updateStreamingChrome();
  }

  function onChatToolLine(payload) {
    toolLogDebug.record('tool-line', compactToolLinePayload(payload));
    const run = runForEvent(payload);
    if (!run) return;
    const last = run.assistantMessage;

    const phase =
      typeof payload === 'object' && payload !== null && payload.phase
        ? payload.phase
        : 'start';
    // Main liefert fertige Anzeige-Zeilen in payload.line (Rohdaten optional für Debug).
    const line = typeof payload?.line === 'string' ? payload.line : '';
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
    const permission =
      payload?.permission && typeof payload.permission === 'object' ? payload.permission : null;
    const entry = toolTraceEntryForStore({ line, tool, skill, permission });
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
      // Which step is running lives in the message, not only in its row: a
      // chat opened again mid-run is drawn from the message (#320).
      last.toolRunning = true;
      last.runningCallIndex = callIndex;
      delete last.permissionNote;
    } else if (phase === 'done') {
      if (last.toolTrace.length > 0) last.toolTrace[last.toolTrace.length - 1] = entry;
      else last.toolTrace.push(entry);
      delete last.toolRunning;
      delete last.runningCallIndex;
      delete last.permissionNote;
    }

    if (!isOnScreen(run)) return;

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
      const byIndex = Number.isInteger(callIndex)
        ? linesEl.querySelector(`.chat-tool-line--running[data-call-index="${callIndex}"]`)
        : null;
      const doneRow = byIndex || runningRows[runningRows.length - 1];
      setToolLineDone(doneRow, line);
      applyPermissionToRow(doneRow, permission);
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
  }

  function onChatProgress(p) {
    const run = runForEvent(p);
    if (!run) return;
    const last = run.assistantMessage;
    const onScreen = isOnScreen(run);
    if (p.type === 'phase' && p.phase) {
      toolLogDebug.record('phase', { phase: p.phase });
      last.phase = p.phase;
      // Jede Runde beginnt mit 'waiting': ab hier zählt die Denkzeit (Issue #87).
      if (p.phase === 'waiting') {
        last.thinkingSince = Date.now();
        delete last.toolRunning;
      } else if (p.phase === 'idle') delete last.thinkingSince;
      if (onScreen) updateStreamingChrome();
    }
    if (p.type === 'reasoning' && p.text) {
      last.reasoningText = (last.reasoningText || '') + p.text;
      if (onScreen) updateStreamingChrome();
    }
    if (p.type === 'permission' && p.event) {
      // Kept in the message as well, for a chat drawn again from it (#320).
      last.permissionNote = permissionNoteFor(p);
      if (!last.permissionNote) delete last.permissionNote;
    }
    if (p.type === 'permission' && p.event && onScreen) {
      toolLogDebug.record('permission', { event: p.event, callIndex: p.callIndex, response: p.response, reason: p.reason });
      // Warten und Entscheidung an der Tool-Zeile sichtbar machen (Issue #67);
      // das Ergebnis der Ausführung bringt später die 'done'-Zeile vom Main.
      const wrap = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type .chat-tool-log');
      const row = wrap && Number.isInteger(p.callIndex)
        ? wrap.querySelector(`.chat-tool-line--running[data-call-index="${p.callIndex}"]`)
        : null;
      if (row) {
        showPermissionNote(row, last.permissionNote || (p.event === 'resolved' ? 'allowed' : null));
        syncToolLogSummary(wrap, { thinking: isThinking(last), elapsedMs: thinkingElapsedMs(last) });
      }
    }
    if (p.type === 'workspace' && p.event === 'fileWritten' && typeof p.relativePath === 'string') {
      // Ein ueberschriebenes Bild traegt seinen neuen Inhalt nicht im
      // Pfad — der Cache aus #244 zeigte sonst weiter den alten Stand.
      clearWorkspaceImageCache();
      // The tree shows the open folder; a run in another one wrote elsewhere.
      if (run.toolRoot === appStore.rootPath && typeof onWorkspaceFileWritten === 'function') {
        onWorkspaceFileWritten(p.relativePath);
      }
    }
  }

  // Registered once (#320): the runs of all chats arrive on the same channels.
  if (typeof api.onChatDelta === 'function') {
    api.onChatDelta((payload) => toolLogDebug.guard('chat:delta', () => onChatDelta(payload)));
  }
  if (typeof api.onChatToolLine === 'function') {
    api.onChatToolLine((payload) =>
      toolLogDebug.guard('chat:tool-line', () => onChatToolLine(payload), compactToolLinePayload(payload)));
  }
  if (typeof api.onChatProgress === 'function') {
    api.onChatProgress((p) => toolLogDebug.guard('chat:progress', () => onChatProgress(p), p?.type));
  }

  function abortChatRequest() {
    const run = appStore.chatRuns.get(appStore.currentChatId);
    if (!isRunning(run)) return;
    run.aborted = true;
    // Only this chat's run; the others keep theirs (#320).
    if (typeof api.abortChat === 'function') api.abortChat(run.chatId);
    finalizeInFlightAssistantMessage();
    syncChatInFlight();
    syncElapsedTicker();
    notifyRunsChanged();
    void persistCurrentChat();
  }

  async function sendChatMessage() {
    if (appStore.chatInFlight) return;
    stopChatVoiceListening();
    const text = chatInput.value.trim();
    // Ein Screenshot ohne Begleitfrage ist eine gueltige Eingabe (Issue #84).
    if ((!text && pendingAttachments.length === 0) || !activeProviderConfigured()) return;
    chatInput.value = '';
    onInputChanged();
    const userMessage = { role: 'user', content: text };
    if (pendingAttachments.length > 0) {
      userMessage.attachments = pendingAttachments;
      pendingAttachments = [];
      renderAttachmentChips();
    }
    appStore.chatMessages.push(userMessage);
    renderChatMessages();

    const payload = appStore.chatMessages
      .filter((m) => !m.greeting)
      .map(({ role, content, attachments }) =>
        (Array.isArray(attachments) && attachments.length > 0
          ? { role, content, attachments }
          : { role, content }));
    const assistantMessage = {
      role: 'assistant',
      content: '',
      toolTrace: [],
      pendingToolLines: [],
      reasoningText: '',
      streaming: true,
      phase: 'waiting',
      thinkingSince: Date.now(),
    };
    appStore.chatMessages.push(assistantMessage);

    runSeq += 1;
    const chatId = appStore.currentChatId;
    const run = {
      chatId,
      runId: `${runSeq}-${Date.now().toString(36)}`,
      // The folder the tools work in — main takes the open one at send time.
      toolRoot: appStore.rootPath,
      assistantMessage,
      aborted: false,
      settled: false,
      discarded: false,
      // The chat's data while it is off screen; `null` while it is on screen.
      chat: null,
    };
    appStore.chatRuns.set(chatId, run);
    syncChatInFlight();
    approvalCards?.beginRun(chatId, assistantMessage);
    renderChatMessages();
    syncElapsedTicker();
    notifyRunsChanged();
    // The question is part of the chat from now on — also for the history
    // column, which marks the chat as running while it is off screen.
    void persistCurrentChat();

    let result;
    try {
      result = await api.chat(payload, {
        selectedPath: appStore.selectedPath,
        selectedIsDirectory: appStore.selectedIsDirectory,
        // Geltungsbereich fuer Sitzungsfreigaben von Tool-Aufrufen (Issue #66).
        chatId,
        runId: run.runId,
      });
    } catch {
      // A run that never answers would leave its chat marked as running.
      result = { error: t('chat.error.runLost') };
    }
    await settleRun(run, result);
  }

  /**
   * Brings a finished turn into its chat — on screen or off it (#320).
   * Returns what the list on screen needs, if the chat is there.
   */
  function settleRunMessages(run, result, messages) {
    const last = run.assistantMessage;
    const streaming = !!last?.streaming && messages.includes(last);
    const finish = () => {
      last.streaming = false;
      last.phase = 'idle';
      delete last.pendingToolLines;
      delete last.thinkingSince;
      delete last.toolRunning;
      delete last.runningCallIndex;
      delete last.permissionNote;
    };
    if (run.aborted || result?.cancelled) {
      if (!streaming) return { kind: 'render' };
      finish();
      if (typeof result?.content === 'string' && result.content.length > 0) last.content = result.content;
      last.toolTrace = Array.isArray(result?.toolTrace)
        ? result.toolTrace.map(toolTraceEntryForStore)
        : last.toolTrace || [];
      return { kind: 'finalize' };
    }
    if (result?.error) {
      // Seit #306 schickt der Kern einen Schluessel statt eines Satzes; was
      // noch fertigen Text liefert — die Provider-Adapter — geht durch
      // `tMessage` unveraendert durch (#293).
      const errorText = tMessage(result.error);
      let kind = 'render';
      if (streaming) {
        if (Array.isArray(result.toolTrace) && result.toolTrace.length > 0) {
          // Lauf durch verfallene Freigabe beendet (Issue #66/#67): Die bis
          // dahin gelaufenen Schritte samt Audit und Karte bleiben sichtbar,
          // der Fehler folgt als eigene Nachricht. Kein vollständiger
          // Neuaufbau, sonst verschwände die Karte mit dem Verfallsgrund.
          finish();
          last.toolTrace = result.toolTrace.map(toolTraceEntryForStore);
          if (!last.content) last.content = '';
          kind = 'finalize-with-error';
        } else {
          messages.splice(messages.indexOf(last), 1);
        }
      }
      messages.push({ role: 'assistant', content: errorText, isError: true });
      return { kind, errorText };
    }
    if (!streaming) return { kind: 'render' };
    finish();
    last.content = result?.content ?? '';
    last.toolTrace = Array.isArray(result?.toolTrace)
      ? result.toolTrace.map(toolTraceEntryForStore)
      : last.toolTrace || [];
    return { kind: 'finalize' };
  }

  /** Draws a settled turn into the list — only for the chat on screen. */
  function showSettledRun(run, outcome) {
    const bubble = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type');
    if (outcome.kind === 'finalize' && bubble) {
      finalizeStreamingAssistantBubble(bubble, run.assistantMessage);
      syncChatBusyState();
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      return;
    }
    if (outcome.kind === 'finalize-with-error' && bubble) {
      finalizeStreamingAssistantBubble(bubble, run.assistantMessage);
      const errorLi = document.createElement('li');
      errorLi.classList.add('chat-msg', 'assistant', 'error');
      errorLi.textContent = outcome.errorText;
      chatMessagesEl.appendChild(errorLi);
      syncChatBusyState();
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      return;
    }
    renderChatMessages();
  }

  async function settleRun(run, result) {
    run.settled = true;
    // Replaced by a newer turn in the same chat (stop, then send again) or
    // deleted with its chat: the turn has nothing left to write.
    if (appStore.chatRuns.get(run.chatId) !== run) return;
    syncChatInFlight();
    syncElapsedTicker();
    notifyRunsChanged();

    const onScreen = isOnScreen(run);
    const chat = onScreen ? null : run.chat;
    if (!onScreen && !chat) {
      // Neither on screen nor carrying its chat — nothing to write it into.
      appStore.chatRuns.delete(run.chatId);
      notifyRunsChanged();
      return;
    }
    const outcome = settleRunMessages(run, result, onScreen ? appStore.chatMessages : chat.messages);
    if (onScreen) {
      showSettledRun(run, outcome);
      applyUsageFromResult(result);
    } else {
      const usage = result?.contextUsage ?? result?.usage;
      if (usage) {
        chat.tokenUsage = coerceUsage(usage);
        chat.contextBreakdown = result?.contextBreakdown ?? null;
      }
    }

    try {
      // Written into its own chat — not into whichever chat is open now.
      if (onScreen) await persistCurrentChat();
      else await persistChat(chat);
    } finally {
      if (appStore.chatRuns.get(run.chatId) === run) appStore.chatRuns.delete(run.chatId);
      // The chat may have been opened during the write; then it is on screen
      // and keeps its cards, otherwise they go with the run.
      approvalCards?.retainChats?.(liveChatIds());
      notifyRunsChanged();
    }
    // Ueberschrift im Hintergrund nachziehen: Sie darf die Antwort nicht
    // aufhalten und ihr Fehlschlag darf den Chat nicht stoeren.
    void maybeGenerateChatTitle(run.chatId, run.chat);
  }

  /**
   * Laesst das Modell die Konversation benennen, sobald die erste Antwort
   * steht. Laeuft genau einmal je Chat: Danach steht im Titel etwas, das nicht
   * mehr dem aus der Frage abgeleiteten entspricht. Aeltere Chats mit
   * abgeleitetem Titel werden beim naechsten Zug nachbenannt.
   *
   * `offScreenChat` is the chat of a run that ended in the background (#320);
   * without it, the chat on screen is meant.
   */
  async function maybeGenerateChatTitle(chatId, offScreenChat = null) {
    if (!activeProviderConfigured?.()) return;
    const source = offScreenChat || (appStore.currentChatId === chatId ? currentChatSnapshot() : null);
    if (!source) return;
    const messages = source.messages.filter((m) => !m.greeting && !m.isError && !m.streaming);
    const firstUser = messages.find((m) => m.role === 'user');
    const firstAnswer = messages.find((m) => m.role === 'assistant');
    if (!firstUser || !firstAnswer) return;

    const current = typeof source.title === 'string' ? source.title.trim() : '';
    if (current && current !== inferChatTitle(messages)) return;

    let result = null;
    try {
      result = await api.generateChatTitle([
        { role: 'user', content: String(firstUser.content ?? '') },
        { role: 'assistant', content: String(firstAnswer.content ?? '') },
      ]);
    } catch {
      return;
    }
    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!title) return;
    if (lastPersisted.get(chatId) === DELETED) return;
    // Wherever the chat is by now, the title follows it there.
    if (appStore.currentChatId === chatId && !canAttachChat(chatId)) {
      appStore.currentChatTitle = title;
      syncChatTitle?.();
      await persistCurrentChat();
      return;
    }
    const run = appStore.chatRuns.get(chatId);
    if (run?.chat) {
      // Running again in the background: its next write takes the title along.
      run.chat.title = title;
      return;
    }
    // Nobody has the chat open. Only write if nothing newer went in since —
    // otherwise the snapshot would take back what was said after it.
    if (!isLatestWritten(source)) return;
    await persistChat({ ...source, title });
  }

  function formatAttachmentSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  }

  function renderAttachmentChips() {
    if (!chatAttachmentsEl) return;
    chatAttachmentsEl.innerHTML = '';
    chatAttachmentsEl.classList.toggle('hidden', pendingAttachments.length === 0);
    pendingAttachments.forEach((attachment, index) => {
      const li = document.createElement('li');
      li.className = 'chat-attachment-chip';

      const img = document.createElement('img');
      img.className = 'chat-attachment-thumb';
      img.src = toDataUrl(attachment);
      img.alt = '';
      li.appendChild(img);

      const meta = document.createElement('div');
      meta.className = 'chat-attachment-meta';
      const name = document.createElement('span');
      name.className = 'chat-attachment-name';
      name.textContent = attachment.name || t('chat.attachment.image');
      const size = document.createElement('span');
      size.className = 'chat-attachment-size';
      size.textContent = formatAttachmentSize(attachment.bytes);
      meta.appendChild(name);
      meta.appendChild(size);
      li.appendChild(meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chat-attachment-remove';
      remove.title = t('chat.attachment.remove');
      remove.setAttribute('aria-label', t('chat.attachment.remove.label', { name: attachment.name || t('chat.attachment.image') }));
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => {
        pendingAttachments.splice(index, 1);
        renderAttachmentChips();
        chatInput.focus();
      });
      li.appendChild(remove);

      chatAttachmentsEl.appendChild(li);
    });
  }

  // Einstieg fuer Screenshots (Issue #84): Cmd/Ctrl+V. Der Text im Eingabefeld
  // bleibt unberuehrt — nur wenn wirklich Bilder in der Zwischenablage liegen,
  // wird das Standardverhalten unterdrueckt.
  async function takeImageFiles(files) {
    const { accepted, rejections } = planAttachmentIntake(pendingAttachments.length, files, {
      imagesSupported: activeProviderSupportsImages?.() === true,
    });
    for (const reason of rejections) flashTokenUsageNote(rejectionMessage(reason));
    if (accepted.length === 0) return;

    for (const file of accepted) {
      let result;
      try {
        result = await prepareImageAttachment(file);
      } catch {
        result = { ok: false, reason: '' };
      }
      if (!result.ok) {
        flashTokenUsageNote(rejectionMessage(result.reason));
        continue;
      }
      pendingAttachments.push(result.attachment);
      renderAttachmentChips();
    }
  }

  chatInput.addEventListener('paste', (e) => {
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    takeImageFiles(files);
  });

  // Links aus Modellantworten oeffnet der Main-Prozess (Issue #82/#83).
  // Ohne Auswertung des Ergebnisses sieht ein Fehlschlag aus wie ein toter
  // Link, darum die Rueckmeldung ueber die Statuszeile.
  chatMessagesEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!isOpenableChatLink(href)) return;
    e.preventDefault();
    openChatLink(api, href).then((result) => {
      if (!result.ok) flashTokenUsageNote(result.error);
    });
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
    // Nur den Text austauschen, nicht den Inhalt des Schalters: Die Anzeige
    // ist seit Issue #174 ein Button mit eigener Textzelle.
    if (chatTokenUsageValueEl) chatTokenUsageValueEl.textContent = text;
    else chatTokenUsageEl.textContent = text;
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
      flashTokenUsageNote(t('chat.debug.toConsole'));
    };
    // Über den Main-Prozess, weil der Permission-Handler der App
    // navigator.clipboard im Renderer nicht zulässt.
    const write = typeof api.writeClipboardText === 'function'
      ? api.writeClipboardText(json).then((r) => (r?.ok ? r : Promise.reject(new Error(r?.error || 'clipboard'))))
      : Promise.reject(new Error('clipboard unavailable'));
    write.then(() => {
      toolLogDebug.record('export', { via: 'clipboard' });
      flashTokenUsageNote(t('chat.debug.copied'));
    }, toConsole);
  });

  syncChatTokenUsageDisplay();

  /**
   * A language change repaints the running chat (#290). Everything in here is
   * built at runtime — tool lines, the greeting, the token figure — so
   * `data-i18n` never reaches it. The greeting is display-only and is not
   * persisted, so it can simply be written again in the new language; the
   * conversation itself is the user's text and stays untouched.
   */
  onLocaleChange(() => {
    const workspaceRoot = appStore.currentChatWorkspace;
    for (const message of appStore.chatMessages) {
      if (!message.greeting) continue;
      const fresh = buildGreetingMessage(workspaceRoot);
      if (fresh) message.content = fresh.content;
    }
    renderChatMessages();
    syncChatSendButton();
    syncChatTokenUsageDisplay();
  });

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
    // Runs per chat (#320), for the history column.
    runs: {
      detach: detachCurrentChat,
      canAttach: canAttachChat,
      attach: attachChat,
      afterSwitch: afterChatSwitch,
      discard: discardChatRun,
      stateOf: runStateOf,
    },
  };
}
