import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
} from '../chat/mentionAutocomplete.js';

const MAX_VISIBLE_OPTIONS = 8;
// Die Pfadliste wird beim ersten „@“ lazy geladen und kurz vorgehalten. Explizit
// verworfen wird sie bei Workspace-Wechsel und nach Schreib-Tools (siehe app.js);
// die kurze Lebensdauer fängt Änderungen ab, die kein Ereignis auslösen (z. B.
// Verschieben im Baum, Änderungen außerhalb der App).
const CACHE_MAX_AGE_MS = 30_000;

/**
 * @-Vervollständigung für die Chat-Eingabe (Issue #52): Tippt der Nutzer „@“,
 * erscheint über dem Textfeld eine filterbare Liste der Workspace-Pfade.
 * ↑/↓ navigiert, Enter/Tab übernimmt, Esc schließt. Ohne geöffneten Workspace
 * passiert nichts — „@“ bleibt normaler Text.
 */
export function initMentionAutocomplete({ api, appStore, onInputChanged }) {
  const chatInput = document.getElementById('chat-input');
  const menu = document.getElementById('chat-mention-menu');
  const inactive = { invalidate() {}, close() {}, isOpen: () => false };
  if (!chatInput || !menu || typeof api?.listWorkspacePaths !== 'function') return inactive;

  let cache = null; // { root, entries, fetchedAt }
  let pending = null; // { root, promise }
  let cacheGeneration = 0;
  let active = null; // { start, query } der offenen Referenz
  let items = [];
  let selectedIndex = 0;
  let updateSeq = 0;

  const isOpen = () => !menu.classList.contains('hidden');

  function close() {
    active = null;
    items = [];
    selectedIndex = 0;
    if (!isOpen()) return;
    menu.classList.add('hidden');
    menu.innerHTML = '';
    chatInput.removeAttribute('aria-activedescendant');
  }

  function invalidate() {
    cacheGeneration += 1;
    cache = null;
    pending = null;
    close();
  }

  async function loadEntries() {
    const root = appStore.rootPath;
    if (!root) return [];
    if (cache?.root === root && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
      return cache.entries;
    }
    if (pending?.root === root) return pending.promise;

    const generation = cacheGeneration;
    const promise = (async () => {
      let entries = [];
      try {
        const result = await api.listWorkspacePaths();
        entries = Array.isArray(result?.entries) ? result.entries : [];
      } catch {
        entries = [];
      }
      if (generation === cacheGeneration && appStore.rootPath === root) {
        cache = { root, entries, fetchedAt: Date.now() };
      }
      if (pending?.promise === promise) pending = null;
      return entries;
    })();
    pending = { root, promise };
    return promise;
  }

  function markSelected({ scroll = false } = {}) {
    const options = menu.querySelectorAll('.chat-mention-option');
    options.forEach((el, i) => {
      el.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');
    });
    const current = options[selectedIndex];
    if (!current) return;
    chatInput.setAttribute('aria-activedescendant', current.id);
    if (scroll && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest' });
    }
  }

  function buildOption(entry, index) {
    const li = document.createElement('li');
    li.className = 'chat-mention-option';
    li.id = `chat-mention-option-${index}`;
    li.setAttribute('role', 'option');
    li.dataset.index = String(index);

    const isDirectory = entry.kind === 'directory';
    const slash = entry.path.lastIndexOf('/');
    const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
    const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : '';

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-mention-name';
    nameEl.textContent = isDirectory ? `${name}/` : name;
    li.appendChild(nameEl);

    if (dir) {
      const dirEl = document.createElement('span');
      dirEl.className = 'chat-mention-dir';
      dirEl.textContent = dir;
      li.appendChild(dirEl);
    }
    return li;
  }

  function renderMenu() {
    menu.innerHTML = '';
    if (!active || items.length === 0) {
      menu.classList.add('hidden');
      chatInput.removeAttribute('aria-activedescendant');
      return;
    }
    items.forEach((entry, index) => menu.appendChild(buildOption(entry, index)));
    menu.classList.remove('hidden');
    markSelected({ scroll: true });
  }

  async function update() {
    if (!appStore.rootPath) {
      close();
      return;
    }
    const found = findMentionQuery(chatInput.value, chatInput.selectionStart);
    if (!found) {
      close();
      return;
    }
    const seq = ++updateSeq;
    const entries = await loadEntries();
    if (seq !== updateSeq) return; // inzwischen weitergetippt — jüngerer Aufruf übernimmt

    // Text und Cursor können sich während des Ladens geändert haben.
    const current = findMentionQuery(chatInput.value, chatInput.selectionStart);
    if (!current) {
      close();
      return;
    }
    const queryChanged =
      !active || active.query !== current.query || active.start !== current.start;
    active = current;
    items = filterMentionCandidates(entries, current.query, MAX_VISIBLE_OPTIONS);
    if (queryChanged || selectedIndex >= items.length) selectedIndex = 0;
    renderMenu();
  }

  function move(delta) {
    if (items.length === 0) return;
    selectedIndex = (selectedIndex + delta + items.length) % items.length;
    markSelected({ scroll: true });
  }

  function applySelected(index = selectedIndex) {
    const entry = items[index];
    if (!active || !entry) return;
    const { text, caret } = applyMention(
      chatInput.value,
      active.start,
      chatInput.selectionStart,
      entry
    );
    const isDirectory = entry.kind === 'directory';
    chatInput.value = text;
    chatInput.setSelectionRange(caret, caret);
    onInputChanged?.();
    close();
    chatInput.focus();
    // Ordner: Die Referenz bleibt offen („@src/“), die Liste zeigt den Ordnerinhalt.
    if (isDirectory) void update();
  }

  // Capture-Phase, damit Enter/Tab/Esc hier landen, bevor ChatStream (Senden)
  // oder der globale Escape-Handler des FileTree sie sehen.
  chatInput.addEventListener(
    'keydown',
    (e) => {
      if (!isOpen()) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowDown':
          move(1);
          break;
        case 'ArrowUp':
          move(-1);
          break;
        case 'Enter':
        case 'Tab':
          if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
            handled = false;
            break;
          }
          applySelected();
          break;
        case 'Escape':
          close();
          break;
        default:
          handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );

  chatInput.addEventListener('input', () => {
    void update();
  });
  chatInput.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      void update();
    }
  });
  chatInput.addEventListener('click', () => {
    void update();
  });
  chatInput.addEventListener('blur', () => close());

  // Fokus bleibt im Textfeld, sonst schließt blur die Liste vor dem Klick.
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('click', (e) => {
    const option = e.target.closest('.chat-mention-option');
    if (!option) return;
    applySelected(Number(option.dataset.index));
  });
  menu.addEventListener('mouseover', (e) => {
    const option = e.target.closest('.chat-mention-option');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (!Number.isInteger(index) || index === selectedIndex) return;
    selectedIndex = index;
    markSelected();
  });

  return { invalidate, close, isOpen };
}
