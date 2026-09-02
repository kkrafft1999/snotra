import { markdownToSafeHtml } from '../utils/helpers.js';
// Token-Usage-Normalisierung/-Summierung aus der gemeinsamen Contract-Schicht,
// damit Anzeige (Renderer) und Provider-Seite (Main) nicht auseinanderlaufen.
import contracts from '../generated/contracts.js';

const { coerceUsage, mergeUsage } = contracts;

function toolLineText(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.line ?? entry?.summary ?? entry?.text ?? '';
}

function createToolCheckIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chat-tool-line-check');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Abgeschlossen');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 8l3 3 7-7');
  svg.appendChild(path);
  return svg;
}

function buildToolLine(text, state /* 'running' | 'done' */) {
  const row = document.createElement('div');
  row.className = 'chat-tool-line';
  row.classList.add(state === 'running' ? 'chat-tool-line--running' : 'chat-tool-line--done');
  row.setAttribute('role', 'status');

  const textEl = document.createElement('span');
  textEl.className = 'chat-tool-line-text';
  textEl.textContent = text;
  row.appendChild(textEl);

  if (state === 'running') {
    row.setAttribute('aria-busy', 'true');
    row.setAttribute('aria-label', `Läuft: ${text}`);
  } else {
    row.setAttribute('aria-label', `Abgeschlossen: ${text}`);
    const status = document.createElement('span');
    status.className = 'chat-tool-line-status';
    const srDone = document.createElement('span');
    srDone.className = 'sr-only';
    srDone.textContent = 'Abgeschlossen';
    status.appendChild(srDone);
    status.appendChild(createToolCheckIcon());
    row.appendChild(status);
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

  let status = row.querySelector('.chat-tool-line-status');
  if (!status) {
    status = document.createElement('span');
    status.className = 'chat-tool-line-status';
    row.appendChild(status);
  }
  if (!status.querySelector('.sr-only')) {
    const srDone = document.createElement('span');
    srDone.className = 'sr-only';
    srDone.textContent = 'Abgeschlossen';
    status.insertBefore(srDone, status.firstChild);
  }
  if (!status.querySelector('.chat-tool-line-check')) {
    status.appendChild(createToolCheckIcon());
  }
}

function syncToolLogLayout(wrap) {
  if (!wrap) return;
  const count = wrap.querySelectorAll('.chat-tool-line').length;
  wrap.classList.toggle('chat-tool-log--multi', count >= 2);
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
  wrap?.querySelectorAll('.chat-tool-line--running').forEach(setToolLineDone);
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

  function buildToolLog(trace, state /* 'running' | 'done' */) {
    const log = document.createElement('div');
    log.className = 'chat-tool-log';
    log.classList.add(state === 'running' ? 'chat-tool-log--running' : 'chat-tool-log--done');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    if (state === 'running') log.setAttribute('aria-busy', 'true');

    const lines = document.createElement('div');
    lines.className = 'chat-tool-lines';
    log.appendChild(lines);

    if (Array.isArray(trace) && trace.length > 0) {
      for (let i = 0; i < trace.length; i += 1) {
        const text = toolLineText(trace[i]);
        const lineState =
          state === 'running' && i === trace.length - 1 ? 'running' : 'done';
        lines.appendChild(buildToolLine(text, lineState));
      }
      syncToolLogLayout(log);
    }
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
    wrap.classList.remove('chat-tool-log--running');
    wrap.classList.add('chat-tool-log--done');
    wrap.removeAttribute('aria-busy');
  }

  function finalizeStreamingAssistantBubble(bubble, message) {
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
    const phase = bubble.querySelector('.chat-phase');
    if (phase) {
      const ph = last.phase;
      if (ph === 'generating' || ph === 'idle') {
        phase.classList.add('hidden');
        phase.textContent = '';
      } else {
        phase.classList.remove('hidden');
        phase.textContent = 'Modell denkt nach …';
      }
    }
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
          if (m.phase === 'generating' || m.phase === 'idle') {
            phaseEl.classList.add('hidden');
          } else {
            phaseEl.textContent = 'Modell denkt nach …';
          }
          li.appendChild(phaseEl);

          const reasoningEl = document.createElement('pre');
          reasoningEl.className = 'chat-reasoning-stream';
          reasoningEl.textContent = m.reasoningText || '';
          if (!(m.reasoningText && m.reasoningText.length)) {
            reasoningEl.classList.add('hidden');
          }
          li.appendChild(reasoningEl);

          li.appendChild(buildToolLog(m.toolTrace, 'running'));

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
      reasoningText: '',
      streaming: true,
      phase: 'waiting',
    });
    renderChatMessages();

    const offDelta =
      typeof api.onChatDelta === 'function'
        ? api.onChatDelta(({ text: deltaText }) => {
            const last = appStore.chatMessages[appStore.chatMessages.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return;
            last.content = (last.content || '') + (deltaText || '');
            const streamEl = chatMessagesEl.querySelector(
              '.chat-msg.assistant:last-of-type .chat-md-streaming'
            );
            if (streamEl) {
              scheduleStreamRender(streamEl, last.content);
            } else {
              renderChatMessages();
            }
          })
        : () => {};

    const offTool =
      typeof api.onChatToolLine === 'function'
        ? api.onChatToolLine((payload) => {
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

            const wrap = chatMessagesEl.querySelector('.chat-msg.assistant:last-of-type .chat-tool-log');
            if (!wrap) {
              if (!Array.isArray(last.toolTrace)) last.toolTrace = [];
              if (phase === 'start') {
                last.toolTrace.push(line);
              } else if (phase === 'done') {
                if (last.toolTrace.length > 0) {
                  last.toolTrace[last.toolTrace.length - 1] = line;
                } else {
                  last.toolTrace.push(line);
                }
              }
              renderChatMessages();
              return;
            }

            let linesEl = wrap.querySelector('.chat-tool-lines');
            if (!linesEl) {
              linesEl = document.createElement('div');
              linesEl.className = 'chat-tool-lines';
              wrap.appendChild(linesEl);
            }

            if (phase === 'done') {
              const runningRows = [...linesEl.querySelectorAll('.chat-tool-line--running')];
              const target = runningRows[runningRows.length - 1];
              setToolLineDone(target, line);
              if (target && Array.isArray(last.toolTrace) && last.toolTrace.length > 0) {
                last.toolTrace[last.toolTrace.length - 1] = line;
              }
            } else {
              if (!Array.isArray(last.toolTrace)) last.toolTrace = [];
              last.toolTrace.push(line);
              linesEl.querySelectorAll('.chat-tool-line--running').forEach((row) => {
                setToolLineDone(row);
              });
              linesEl.appendChild(buildToolLine(line, 'running'));
            }

            syncToolLogLayout(wrap);
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
          })
        : () => {};

    const offProgress =
      typeof api.onChatProgress === 'function'
        ? api.onChatProgress((p) => {
            const last = appStore.chatMessages[appStore.chatMessages.length - 1];
            if (!last || last.role !== 'assistant' || !last.streaming) return;
            if (p.type === 'phase' && p.phase) {
              last.phase = p.phase;
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
          })
        : () => {};

    let result;
    try {
      result = await api.chat(payload, {
        workspaceRoot: appStore.rootPath,
        selectedPath: appStore.selectedPath,
        selectedIsDirectory: appStore.selectedIsDirectory,
      });
    } finally {
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
            ? result.toolTrace.map((e) => toolLineText(e))
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
        ? result.toolTrace.map((e) => toolLineText(e))
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
