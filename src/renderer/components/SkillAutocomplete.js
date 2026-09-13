import contracts from '../generated/contracts.js';

const { SKILL_STATUS, findSkillQuery, filterSkillCandidates, applySkillInvocation } = contracts;

const MAX_VISIBLE_OPTIONS = 8;
/**
 * Der Katalog wird beim ersten „/“ lazy geladen und danach vorgehalten.
 *
 * Dass ein neuer Skill auftaucht, besorgt seit Issue #126 der Datei-Watcher:
 * Er meldet sich über `skills:changed`, und der Cache fällt sofort. Diese
 * Frist ist nur noch das Sicherheitsnetz für Dateisysteme, auf denen das
 * Betriebssystem keine Änderungen meldet — etwa Netzlaufwerke. Deshalb darf
 * sie großzügig sein (Issue #130).
 */
const CACHE_MAX_AGE_MS = 5 * 60_000;

/**
 * `/`-Vervollständigung für die Chat-Eingabe (Issue #124, Teil von #89):
 * Tippt der Nutzer „/“, erscheint über dem Textfeld eine filterbare Liste
 * aller aufrufbaren Skills — nicht nur der in den Einstellungen
 * eingeschalteten. ↑/↓ navigiert, Enter/Tab übernimmt, Esc schließt.
 *
 * Übernommen wird nur der Text „/name“; wirksam wird der Skill erst im Main,
 * der ihn aus der abgeschickten Nachricht wieder herausliest. Die Auswahl in
 * den Einstellungen bleibt dabei unberührt.
 *
 * Anders als bei der @-Referenz braucht es keinen offenen Ordner: Die
 * System-Skills sind immer da.
 */
export function initSkillAutocomplete({ api, appStore, onInputChanged }) {
  const chatInput = document.getElementById('chat-input');
  const menu = document.getElementById('chat-skill-menu');
  const inactive = { invalidate() {}, refresh() {}, close() {}, isOpen: () => false };
  if (!chatInput || !menu || typeof api?.getSkillCatalog !== 'function') return inactive;

  let cache = null; // { root, skills, fetchedAt }
  let pending = null; // { root, promise }
  let cacheGeneration = 0;
  let active = null; // { start, query } des offenen Aufrufs
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

  /**
   * Wie `invalidate`, schließt die Liste aber nicht, sondern füllt sie neu.
   *
   * Für die Meldung des Datei-Watchers (Issue #130). Die kann mitten in der
   * Eingabe eintreffen, und dann darf die Liste dem Nutzer weder unter den
   * Fingern zuschnappen noch veraltet stehen bleiben.
   *
   * Entscheidend ist `update()` statt einer Prüfung auf eine *offene* Liste:
   * Wer „/neu“ tippt, während dieser Skill gerade angelegt wird, sieht eine
   * geschlossene Liste — es gibt ja noch keinen Treffer. Genau der Fall soll
   * aufgehen, sobald der Skill da ist. `update()` entscheidet selbst anhand
   * der Eingabe und schließt, wenn gar keine Abfrage offen ist.
   */
  function refresh() {
    cacheGeneration += 1;
    cache = null;
    pending = null;
    void update();
  }

  /** Aufrufbar ist, was nutzbar ist — verdeckte und kaputte Skills nicht. */
  function isInvocable(skill) {
    return skill?.status === SKILL_STATUS.ACTIVE || skill?.status === SKILL_STATUS.AVAILABLE;
  }

  async function loadSkills() {
    // Der Katalog hängt am Workspace (Ordner-Skills), also ist der Root Teil
    // des Cache-Schlüssels — auch wenn ohne Ordner die System-Skills bleiben.
    const root = appStore.rootPath || '';
    if (cache?.root === root && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
      return cache.skills;
    }
    if (pending?.root === root) return pending.promise;

    const generation = cacheGeneration;
    const promise = (async () => {
      let skills = [];
      try {
        const result = await api.getSkillCatalog();
        skills = Array.isArray(result?.skills) ? result.skills.filter(isInvocable) : [];
      } catch {
        skills = [];
      }
      if (generation === cacheGeneration && (appStore.rootPath || '') === root) {
        cache = { root, skills, fetchedAt: Date.now() };
      }
      if (pending?.promise === promise) pending = null;
      return skills;
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

  function buildOption(skill, index) {
    const li = document.createElement('li');
    li.className = 'chat-mention-option';
    li.id = `chat-skill-option-${index}`;
    li.setAttribute('role', 'option');
    li.dataset.index = String(index);

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-mention-name';
    nameEl.textContent = `/${skill.name}`;
    li.appendChild(nameEl);

    if (skill.description) {
      const descEl = document.createElement('span');
      descEl.className = 'chat-mention-dir';
      descEl.textContent = skill.description;
      li.appendChild(descEl);
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
    items.forEach((skill, index) => menu.appendChild(buildOption(skill, index)));
    menu.classList.remove('hidden');
    markSelected({ scroll: true });
  }

  async function update() {
    const found = findSkillQuery(chatInput.value, chatInput.selectionStart);
    if (!found) {
      close();
      return;
    }
    const seq = ++updateSeq;
    const skills = await loadSkills();
    if (seq !== updateSeq) return; // inzwischen weitergetippt — jüngerer Aufruf übernimmt

    // Text und Cursor können sich während des Ladens geändert haben.
    const current = findSkillQuery(chatInput.value, chatInput.selectionStart);
    if (!current) {
      close();
      return;
    }
    const queryChanged =
      !active || active.query !== current.query || active.start !== current.start;
    active = current;
    items = filterSkillCandidates(skills, current.query, MAX_VISIBLE_OPTIONS);
    if (queryChanged || selectedIndex >= items.length) selectedIndex = 0;
    renderMenu();
  }

  function move(delta) {
    if (items.length === 0) return;
    selectedIndex = (selectedIndex + delta + items.length) % items.length;
    markSelected({ scroll: true });
  }

  function applySelected(index = selectedIndex) {
    const skill = items[index];
    if (!active || !skill) return;
    const { text, caret } = applySkillInvocation(
      chatInput.value,
      active.start,
      chatInput.selectionStart,
      skill
    );
    chatInput.value = text;
    chatInput.setSelectionRange(caret, caret);
    onInputChanged?.();
    close();
    chatInput.focus();
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

  return { invalidate, refresh, close, isOpen };
}
