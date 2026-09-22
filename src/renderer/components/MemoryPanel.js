/**
 * Einstellungen › Gedächtnis (Issue #166).
 *
 * Zeigt beide Ebenen als eigene Karte — Projekt und global gleichzeitig,
 * jede mit ihrem Pfad, ihrem Schalter und ihren Einträgen. Die Frage, die
 * dieser Bereich beantworten muss, lautet „was weiß Snotra über dieses Projekt
 * und was über mich"; eine Ansicht, die nur eine Ebene auf einmal zeigt,
 * beantwortet sie nicht ohne Klick.
 *
 * Die Einträge stammen aus einer Datei, die auch von Hand oder von einem
 * fremden Projekt kommen kann. Sie werden deshalb ausschließlich über
 * `textContent` gesetzt — nie als HTML.
 *
 * Das Vergessen wirkt **sofort** und nicht erst mit „Übernehmen": Es schreibt
 * eine Datei, die dem Main gehört, und der liefert den neuen Stand gleich
 * zurück. Since issue #297 the send-along switches and "remember on its own"
 * take effect at once as well — they are written through setUIPrefs the
 * moment they are flipped.
 */

import contracts from '../generated/contracts.js';
import { t, tPlural, onLocaleChange } from '../i18n.js';
import { bindInstantSwitch } from './InstantSetting.js';

const { MEMORY_SCOPES, MEMORY_ORIGINS, MAX_MEMORY_CHARS } = contracts;

const TRASH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/** `2026-09-21` → `21.09.2026`; alles andere bleibt, wie es in der Datei steht. */
function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || '';
}

function formatChars(count) {
  return new Intl.NumberFormat('de-DE').format(count);
}

export function initMemoryPanel({ api }) {
  const host = document.getElementById('settings-memory-scopes');
  const selfToggle = document.getElementById('input-memory-self');
  if (!host) return { refresh: async () => {} };

  /** Zuletzt geladener Stand. */
  let state = { available: false, scopes: [] };

  const PREF_KEYS = {
    [MEMORY_SCOPES.WORKSPACE]: 'memoryWorkspaceEnabled',
    [MEMORY_SCOPES.USER]: 'memoryUserEnabled',
  };

  async function savePref(key, value) {
    const prefs = await api.setUIPrefs({ [key]: value });
    return prefs?.[key] === value;
  }

  const selfSwitch = bindInstantSwitch(
    selfToggle,
    document.getElementById('status-memory-self'),
    (value) => savePref('memorySelfEnabled', value)
  );

  function renderEntry(scope, entry) {
    const item = document.createElement('li');
    item.className = 'memory-item';

    const date = document.createElement('span');
    date.className = 'memory-item__date';
    date.textContent = formatDate(entry.date);
    item.appendChild(date);

    const text = document.createElement('span');
    text.className = 'memory-item__text';
    text.textContent = entry.text;
    if (entry.origin === MEMORY_ORIGINS.SELF) {
      const badge = document.createElement('span');
      badge.className = 'memory-item__origin';
      badge.textContent = 'selbst gemerkt';
      text.appendChild(badge);
    }
    item.appendChild(text);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'memory-item__forget';
    forget.innerHTML = TRASH_ICON;
    // Ohne den Text im Label liest ein Screenreader nur „Schaltfläche" — bei
    // einer Liste gleichaussehender Knöpfe ist das keine Bedienung.
    forget.setAttribute('aria-label', `Vergessen: ${entry.text}`);
    forget.title = 'Diesen Eintrag vergessen';
    forget.addEventListener('click', async () => {
      forget.disabled = true;
      const result = await api.forgetMemoryEntry(scope.scope, entry.line);
      if (result?.ok && result.state) {
        state = result.state;
        render();
      } else {
        forget.disabled = false;
      }
    });
    item.appendChild(forget);
    return item;
  }

  function renderScope(scope) {
    const card = document.createElement('div');
    card.className = 'settings-tools-card memory-card';

    const head = document.createElement('div');
    head.className = 'memory-card__head';
    const title = document.createElement('h3');
    title.className = 'settings-subsection-title';
    // Der Ordnername sagt mehr als „Projekt": Wer zwei Fenster offen hat,
    // erkennt sonst nicht, wessen Gedächtnis er gerade vor sich hat.
    title.textContent =
      scope.scope === MEMORY_SCOPES.WORKSPACE
        ? `Projekt${scope.folderName ? ` · ${scope.folderName}` : ''}`
        : t('settings.memory.scope.global');
    head.appendChild(title);
    const pathEl = document.createElement('span');
    pathEl.className = 'memory-card__path';
    // Ohne geöffneten Ordner gibt es die Projekt-Ebene gerade nicht. Das zu
    // sagen ist ehrlicher als ein leerer Kasten ohne Erklärung.
    pathEl.textContent = scope.path ? scope.shortPath : t('settings.memory.scope.noFolder');
    // Der volle Pfad bleibt erreichbar, ohne die Zeile zu sprengen.
    if (scope.path) pathEl.title = scope.path;
    head.appendChild(pathEl);
    card.appendChild(head);

    // Two cards carry the same switch label, so its name includes the card
    // title — "Send along" alone does not say which memory.
    const titleId = `memory-title-${scope.scope}`;
    title.id = titleId;
    const row = document.createElement('div');
    row.className = 'settings-switch-row memory-card__toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.className = 'ds-switch';
    box.id = `memory-send-${scope.scope}`;
    const label = document.createElement('label');
    label.className = 'settings-switch-row__label';
    label.htmlFor = box.id;
    label.id = `${box.id}-label`;
    label.textContent = t('settings.memory.scope.send');
    box.setAttribute('aria-labelledby', `${label.id} ${titleId}`);
    box.checked = scope.enabled !== false;
    box.disabled = !scope.path;
    const status = document.createElement('span');
    status.className = 'settings-instant-status';
    status.setAttribute('role', 'status');
    const key = PREF_KEYS[scope.scope];
    bindInstantSwitch(box, status, async (value) => {
      const ok = key ? await savePref(key, value) : false;
      if (ok) scope.enabled = value;
      return ok;
    });
    row.append(label, status, box);
    card.appendChild(row);

    if (scope.entries.length > 0) {
      const list = document.createElement('ul');
      list.className = 'memory-list';
      for (const entry of scope.entries) list.appendChild(renderEntry(scope, entry));
      card.appendChild(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'settings-empty-hint memory-empty';
      empty.textContent = scope.path
        ? t('settings.memory.empty')
        : t('settings.memory.empty.noFolder');
      card.appendChild(empty);
    }

    const meta = document.createElement('p');
    meta.className = 'memory-meta';
    const count = scope.entries.length;
    const parts = [
      count === 1 ? '1 Eintrag' : tPlural('settings.memory.entries', count),
      t('settings.memory.chars', { used: formatChars(scope.chars), max: formatChars(scope.maxChars || MAX_MEMORY_CHARS) }),
    ];
    if (scope.truncated) parts.push(t('settings.memory.truncated'));
    meta.textContent = parts.join(' · ');
    card.appendChild(meta);

    return card;
  }

  function render() {
    host.textContent = '';
    if (!state.available) {
      const hint = document.createElement('p');
      hint.className = 'settings-empty-hint';
      hint.textContent = t('settings.memory.unavailable');
      host.appendChild(hint);
      return;
    }
    for (const scope of state.scopes) host.appendChild(renderScope(scope));
  }

  // Language change (epic #277): the cards are built here, not in the markup.
  onLocaleChange(() => { render(); });

  return {
    /** Stand vom Main holen und neu zeichnen — beim Öffnen des Dialogs. */
    async refresh() {
      selfSwitch.status.clear();
      try {
        state = (await api.getMemory()) || { available: false, scopes: [] };
      } catch {
        state = { available: false, scopes: [] };
      }
      selfSwitch.set(state.selfEnabled !== false);
      render();
    },
  };
}
