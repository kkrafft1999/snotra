import { formatHistoryTime } from '../chat/messageUtils.js';
import { dismissOnOutsideClick } from '../utils/helpers.js';

export function initChatHistoryDrawer({
  api,
  appStore,
  stopChatVoiceListening,
  persistCurrentChat,
  renderChatMessages,
  updateChatChrome,
  onInputChanged,
  setChatTokenUsage,
  resetChatTokenUsage,
  seedGreetingIfWorkspace,
  onNewChatStarted,
}) {
  const chatHistoryDrawer = document.getElementById('chat-history-drawer');
  const chatHistoryList = document.getElementById('chat-history-list');
  const chatHistoryEmpty = document.getElementById('chat-history-empty');
  const btnChatHistory = document.getElementById('btn-chat-history');

  function setHistoryDrawerOpen(open) {
    chatHistoryDrawer.classList.toggle('hidden', !open);
    chatHistoryDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    btnChatHistory.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  async function renderHistoryList() {
    const hist = await api.getChatHistory(appStore.rootPath);
    const sessions = Array.isArray(hist.sessions) ? [...hist.sessions] : [];
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chatHistoryList.innerHTML = '';
    if (sessions.length === 0) {
      chatHistoryEmpty.classList.remove('hidden');
      return;
    }
    chatHistoryEmpty.classList.add('hidden');
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'chat-history-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if (s.id === appStore.currentChatId) row.classList.add('chat-history-row--current');
      const main = document.createElement('div');
      main.className = 'chat-history-row-main';
      const titleEl = document.createElement('span');
      titleEl.className = 'chat-history-row-title';
      titleEl.textContent = s.title || 'Chat';
      const meta = document.createElement('span');
      meta.className = 'chat-history-row-meta';
      meta.textContent = formatHistoryTime(s.updatedAt);
      main.appendChild(titleEl);
      main.appendChild(meta);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-history-row-delete';
      del.title = 'Aus Verlauf entfernen';
      del.setAttribute('aria-label', 'Aus Verlauf entfernen');
      del.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
      row.appendChild(main);
      row.appendChild(del);

      const openThis = () => openChatSession(s.id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.chat-history-row-delete')) return;
        openThis();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThis();
        }
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeChatFromHistory(s.id);
      });
      chatHistoryList.appendChild(row);
    }
  }

  async function openChatSession(id) {
    if (!id || id === appStore.currentChatId) {
      setHistoryDrawerOpen(false);
      return;
    }
    stopChatVoiceListening();
    await persistCurrentChat();
    appStore.chatSessionId += 1;
    const hist = await api.getChatHistory(appStore.rootPath);
    const s = hist.sessions?.find((x) => x.id === id);
    if (!s || !Array.isArray(s.messages)) {
      setHistoryDrawerOpen(false);
      return;
    }
    appStore.currentChatId = id;
    appStore.currentChatWorkspace = s.workspaceRoot || null;
    appStore.chatMessages = s.messages;
    appStore.currentChatTitle = s.title || '';
    setChatTokenUsage?.(s.tokenUsage);
    onInputChanged();
    await api.setActiveChatId(appStore.currentChatWorkspace, id);
    renderChatMessages();
    updateChatChrome();
    setHistoryDrawerOpen(false);
    await renderHistoryList();
  }

  async function removeChatFromHistory(id) {
    await api.deleteChatSession(id);
    if (id === appStore.currentChatId) {
      stopChatVoiceListening();
      appStore.chatSessionId += 1;
      appStore.currentChatId = crypto.randomUUID();
      appStore.currentChatWorkspace = appStore.rootPath || null;
      appStore.chatMessages = [];
      appStore.currentChatTitle = '';
      seedGreetingIfWorkspace?.(appStore.currentChatWorkspace);
      resetChatTokenUsage?.();
      onInputChanged();
      await api.setActiveChatId(appStore.currentChatWorkspace, null);
      renderChatMessages();
      updateChatChrome();
    }
    await renderHistoryList();
  }

  async function startNewChatWithHistory() {
    await onNewChatStarted();
    setHistoryDrawerOpen(false);
    await renderHistoryList();
  }

  btnChatHistory.addEventListener('click', async (e) => {
    e.stopPropagation();
    const open = chatHistoryDrawer.classList.contains('hidden');
    if (open) await renderHistoryList();
    setHistoryDrawerOpen(open);
  });

  chatHistoryDrawer.addEventListener('click', (e) => e.stopPropagation());

  dismissOnOutsideClick({
    isOpen: isHistoryDrawerOpen,
    ownsTarget: (t) => chatHistoryDrawer.contains(t) || btnChatHistory.contains(t),
    onDismiss: () => setHistoryDrawerOpen(false),
  });

  function isHistoryDrawerOpen() {
    return !chatHistoryDrawer.classList.contains('hidden');
  }

  return {
    isHistoryDrawerOpen,
    setHistoryDrawerOpen,
    renderHistoryList,
    openChatSession,
    removeChatFromHistory,
    startNewChatWithHistory,
  };
}
