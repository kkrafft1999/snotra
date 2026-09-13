import contracts from '../generated/contracts.js';

const {
  SKILL_SUGGESTION_MODES,
  DEFAULT_SKILL_SUGGESTION_MODE,
  isSkillSuggestionMode,
  findSkillQuery,
  applySkillInvocation,
  createSkillSuggester,
} = contracts;

/**
 * Wie lange nach dem letzten Tastendruck gewartet wird, bevor bewertet wird.
 *
 * Lexikalisch kostet eine Bewertung nichts und darf flott kommen. Das Modell
 * zu fragen ist dagegen ein Netzaufruf pro Eingabe — hier wird deutlich
 * länger gewartet, damit nicht jeder Tastendruck beim Anbieter landet.
 */
const DEBOUNCE_MS = 200;
const DEBOUNCE_MODEL_MS = 900;

/**
 * Antworten des Modells je Anliegen merken. Wer ein Zeichen tippt und wieder
 * löscht, fragt sonst zweimal dasselbe — und bezahlt es auch zweimal.
 */
const MODEL_CACHE_MAX = 50;

/**
 * Vorschlag eines passenden Skills unter dem Eingabefeld (Issue #125).
 *
 * Gezeigt wird er **nur, solange eine „/“-Abfrage offen ist**. Das ist die
 * bewusste Entscheidung gegen einen Hinweis, der beim normalen Tippen
 * mitläuft: Wer „/“ tippt, sucht in diesem Moment ohnehin einen Skill — dann
 * stört ein Vorschlag nicht, sondern beantwortet genau die Frage, die der
 * Nutzer gerade hat. Und weil die Liste der Skills *über* dem Feld aufgeht,
 * kommen sich die beiden nicht in die Quere.
 *
 * Bewertet wird der Text **ohne** die offene „/“-Abfrage: Der Nutzer schreibt
 * „Mach mir ein Protokoll vom Meeting gestern /“ — das Anliegen steht davor,
 * der Schrägstrich ist nur das Signal, dass er einen Namen sucht, den er
 * nicht kennt.
 *
 * Das Übernehmen bleibt in jedem Fall eine Nutzeraktion. Ein Ordner-Skill ist
 * fremder Inhalt, und ein Vorschlag darf ihn nie von selbst einschalten
 * (Issue #18).
 */
export function initSkillSuggestion({ catalog, api, onInputChanged, onApplied }) {
  const chatInput = document.getElementById('chat-input');
  const row = document.getElementById('chat-skill-suggestion');
  const inactive = { setMode() {}, refresh() {}, hide() {} };
  if (!chatInput || !row || !catalog) return inactive;

  let mode = DEFAULT_SKILL_SUGGESTION_MODE;
  let suggester = null;
  let suggesterFor = null; // Katalog, aus dem das Modell gebaut wurde
  let timer = null;
  let seq = 0;
  /** Für diese Eingabe hat der Nutzer den Vorschlag weggeklickt. */
  let dismissedFor = null;
  let current = null; // { skill, start, caret }
  /** @type {Map<string, { name: string, description: string } | null>} */
  const modelCache = new Map();

  function hide() {
    current = null;
    if (row.classList.contains('hidden')) return;
    row.classList.add('hidden');
    row.replaceChildren();
  }

  function setMode(next) {
    mode = isSkillSuggestionMode(next) ? next : DEFAULT_SKILL_SUGGESTION_MODE;
    if (mode === SKILL_SUGGESTION_MODES.OFF) hide();
    else schedule();
  }

  /**
   * Das Bewertungsmodell hängt am gesamten Katalog (ein Wort ist nur relativ
   * zu den anderen selten), also einmal bauen und behalten, bis sich der
   * Katalog ändert.
   */
  async function getSuggester() {
    const skills = await catalog.load();
    if (suggester && suggesterFor === skills) return suggester;
    suggester = createSkillSuggester(skills);
    suggesterFor = skills;
    return suggester;
  }

  /** Der Teil der Nachricht, der das Anliegen trägt — ohne die „/“-Abfrage. */
  function anliegenVor(found) {
    return chatInput.value.slice(0, found.start);
  }

  async function ermittle(text) {
    if (mode === SKILL_SUGGESTION_MODES.MODEL) {
      if (typeof api?.suggestSkills !== 'function') return null;
      if (modelCache.has(text)) return modelCache.get(text);
      try {
        const result = await api.suggestSkills(text);
        const name = typeof result?.name === 'string' ? result.name : '';
        if (!name) return null;
        const skills = await catalog.load();
        const treffer = skills.find((s) => s.name === name);
        const antwort = treffer ? { name: treffer.name, description: treffer.description } : null;
        if (modelCache.size >= MODEL_CACHE_MAX) modelCache.clear();
        modelCache.set(text, antwort);
        return antwort;
      } catch {
        // Ein fehlgeschlagener Vorschlag ist kein Fehler, der den Chat stört.
        // Bewusst nicht gemerkt: Beim nächsten Mal darf es wieder klappen.
        return null;
      }
    }
    const s = await getSuggester();
    const [best] = s.suggest(text, { limit: 1 });
    return best ? { name: best.name, description: best.description } : null;
  }

  function render(skill, found) {
    row.replaceChildren();

    const label = document.createElement('span');
    label.className = 'chat-skill-suggestion-label';
    label.textContent = 'Passt dazu:';
    row.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-skill-suggestion-btn';
    btn.textContent = `/${skill.name}`;
    btn.title = skill.description || '';
    btn.addEventListener('click', uebernehmen);
    row.appendChild(btn);

    if (skill.description) {
      const desc = document.createElement('span');
      desc.className = 'chat-skill-suggestion-desc';
      desc.textContent = skill.description;
      row.appendChild(desc);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'chat-skill-suggestion-dismiss';
    dismiss.setAttribute('aria-label', 'Vorschlag ausblenden');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      dismissedFor = anliegenVor(found);
      hide();
      chatInput.focus();
    });
    row.appendChild(dismiss);

    current = { skill, start: found.start };
    row.classList.remove('hidden');
  }

  function uebernehmen() {
    if (!current) return;
    const found = findSkillQuery(chatInput.value, chatInput.selectionStart);
    // Zwischen Anzeige und Klick kann sich die Eingabe geändert haben.
    const start = found ? found.start : current.start;
    const caret = found ? chatInput.selectionStart : start;
    const { text, caret: next } = applySkillInvocation(chatInput.value, start, caret, current.skill);
    chatInput.value = text;
    chatInput.setSelectionRange(next, next);
    onInputChanged?.();
    hide();
    chatInput.focus();
    onApplied?.();
  }

  async function update() {
    if (mode === SKILL_SUGGESTION_MODES.OFF) {
      hide();
      return;
    }
    const found = findSkillQuery(chatInput.value, chatInput.selectionStart);
    if (!found) {
      hide();
      return;
    }
    const anliegen = anliegenVor(found);
    if (!anliegen.trim()) {
      // Nur ein „/“ ohne Text davor: Dann gibt es kein Anliegen zu deuten,
      // und die Liste über dem Feld zeigt ohnehin schon alles.
      hide();
      return;
    }
    if (dismissedFor === anliegen) return;

    const lauf = ++seq;
    const skill = await ermittle(anliegen);
    if (lauf !== seq) return; // inzwischen weitergetippt

    // Die Eingabe kann sich während des Ermittelns geändert haben.
    const jetzt = findSkillQuery(chatInput.value, chatInput.selectionStart);
    if (!jetzt || !skill || anliegenVor(jetzt) !== anliegen) {
      hide();
      return;
    }
    render(skill, jetzt);
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const wartezeit = mode === SKILL_SUGGESTION_MODES.MODEL ? DEBOUNCE_MODEL_MS : DEBOUNCE_MS;
    timer = setTimeout(() => {
      timer = null;
      void update();
    }, wartezeit);
  }

  /** Nach einer Katalogänderung (#126) neu bewerten. */
  function refresh() {
    suggester = null;
    suggesterFor = null;
    // Ein geänderter Katalog macht auch die Antworten des Modells hinfällig.
    modelCache.clear();
    schedule();
  }

  chatInput.addEventListener('input', () => {
    // Ein neuer Text ist eine neue Frage — ein früheres Wegklicken gilt nicht
    // mehr, sobald der Nutzer sein Anliegen ändert.
    const found = findSkillQuery(chatInput.value, chatInput.selectionStart);
    if (!found || anliegenVor(found) !== dismissedFor) dismissedFor = null;
    schedule();
  });
  chatInput.addEventListener('click', () => schedule());
  chatInput.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      schedule();
    }
  });

  return { setMode, refresh, hide };
}
