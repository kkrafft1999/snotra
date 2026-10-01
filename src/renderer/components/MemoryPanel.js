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
import { getLocale, t, tMessage, tPlural, onLocaleChange } from '../i18n.js';
import { bindInstantSwitch } from './InstantSetting.js';

const { MEMORY_SCOPES, MEMORY_ORIGINS, MAX_MEMORY_CHARS } = contracts;

const TRASH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/** `2026-09-21` in the app language's date form; anything else stays as it is in the file. */
function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? t('format.date', { year: match[1], month: match[2], day: match[3] }) : value || '';
}

function formatChars(count) {
  return new Intl.NumberFormat(getLocale()).format(count);
}

export function initMemoryPanel({ api }) {
  const host = document.getElementById('settings-memory-scopes');
  const selfToggle = document.getElementById('input-memory-self');
  if (!host) return { refresh: async () => {} };

  /** Zuletzt geladener Stand. */
  let state = { available: false, scopes: [] };
  /**
   * What the last "Forget" has to say, shown in its card's status line:
   * `{ scope, message, isError }`. The message stays a message object and is
   * put into words when drawn, so a language change does not strand it.
   */
  let notice = null;

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
      badge.textContent = t('settings.memory.origin.self');
      text.appendChild(badge);
    }
    item.appendChild(text);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'memory-item__forget';
    forget.innerHTML = TRASH_ICON;
    // Ohne den Text im Label liest ein Screenreader nur „Schaltfläche" — bei
    // einer Liste gleichaussehender Knöpfe ist das keine Bedienung.
    forget.setAttribute('aria-label', t('settings.memory.forget.label', { text: entry.text }));
    forget.title = t('settings.memory.forget.title');
    // The keyboard lands on a button after a forget; what went wrong is read with it.
    forget.setAttribute('aria-describedby', statusId(scope.scope));
    forget.addEventListener('click', async () => {
      // One forget at a time. Marked busy rather than disabled: a disabled
      // button loses the focus to the top of the window (CR-B14-07).
      if (forget.getAttribute('aria-disabled') === 'true') return;
      forget.setAttribute('aria-disabled', 'true');
      showNotice(null);
      const index = scope.entries.indexOf(entry);
      let result;
      try {
        result = await api.forgetMemoryEntry(scope.scope, entry.line, entry.text);
      } catch {
        result = null;
      }
      if (result?.ok && result.state) {
        const hadFocus = document.activeElement === forget;
        // Main found no such line with that text — the file changed in the
        // meantime. The list shows what it holds now, and says why the entry
        // may still be there.
        const missed = result.removed === false;
        notice = missed
          ? { scope: scope.scope, message: { key: 'settings.memory.forget.notFound' }, isError: false }
          : null;
        state = result.state;
        render();
        if (hadFocus) focusAfterForget(scope.scope, index, missed ? entry.text : null);
      } else {
        forget.removeAttribute('aria-disabled');
        showNotice({ scope: scope.scope, message: result?.error ?? null, isError: true });
      }
    });
    item.appendChild(forget);
    return item;
  }

  function renderScope(scope) {
    const card = document.createElement('div');
    card.className = 'settings-tools-card memory-card';
    card.dataset.scope = scope.scope;

    const head = document.createElement('div');
    head.className = 'memory-card__head';
    const title = document.createElement('h3');
    title.className = 'settings-subsection-title';
    // Der Ordnername sagt mehr als „Projekt": Wer zwei Fenster offen hat,
    // erkennt sonst nicht, wessen Gedächtnis er gerade vor sich hat.
    title.textContent =
      scope.scope === MEMORY_SCOPES.WORKSPACE
        ? (scope.folderName
          ? t('settings.memory.scope.workspace.named', { folder: scope.folderName })
          : t('settings.memory.scope.workspace'))
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
      // Where the keyboard lands once the last entry is forgotten.
      empty.tabIndex = -1;
      empty.setAttribute('aria-describedby', statusId(scope.scope));
      empty.textContent = scope.path
        ? t('settings.memory.empty')
        : t('settings.memory.empty.noFolder');
      card.appendChild(empty);
    }

    // Present while empty, so that a screen reader is listening when a
    // failed forget writes into it.
    const noticeEl = document.createElement('p');
    noticeEl.className = 'memory-card__status';
    noticeEl.id = statusId(scope.scope);
    noticeEl.setAttribute('role', 'status');
    fillNotice(noticeEl, scope.scope);
    card.appendChild(noticeEl);

    const meta = document.createElement('p');
    meta.className = 'memory-meta';
    const count = scope.entries.length;
    const parts = [
      tPlural('settings.memory.entries', count),
      t('settings.memory.chars', { used: formatChars(scope.chars), max: formatChars(scope.maxChars || MAX_MEMORY_CHARS) }),
    ];
    if (scope.truncated) parts.push(t('settings.memory.truncated'));
    meta.textContent = parts.join(' · ');
    card.appendChild(meta);

    return card;
  }

  function statusId(scopeKey) {
    return `memory-status-${scopeKey}`;
  }

  function fillNotice(el, scopeKey) {
    const own = notice && notice.scope === scopeKey ? notice : null;
    el.textContent = own
      ? tMessage(own.message) || (own.isError ? t('settings.error.memory.forgetFailed') : '')
      : '';
    el.classList.toggle('is-error', !!own?.isError);
  }

  /** A new notice (or none) without redrawing the list — the focus stays put. */
  function showNotice(next) {
    notice = next;
    for (const el of host.querySelectorAll('.memory-card__status')) {
      fillNotice(el, el.id.slice('memory-status-'.length));
    }
  }

  function cardOf(scopeKey) {
    return [...host.querySelectorAll('.memory-card')].find((node) => node.dataset.scope === scopeKey) || null;
  }

  /**
   * After a forget the list is drawn anew and the pressed button is gone: the
   * keyboard moves to the entry that took its place, else the one before it,
   * else the card's empty hint (CR-B14-07). An entry main did not remove
   * (`keepText`) keeps the focus where it still stands.
   */
  function focusAfterForget(scopeKey, index, keepText = null) {
    const card = cardOf(scopeKey);
    const buttons = card ? [...card.querySelectorAll('.memory-item__forget')] : [];
    const entries = state.scopes?.find((scope) => scope.scope === scopeKey)?.entries || [];
    const kept = keepText === null ? -1 : entries.findIndex((entry) => entry.text === keepText);
    const target = buttons[kept] || buttons[index] || buttons[index - 1]
      || card?.querySelector('.memory-empty') || selfToggle;
    target?.focus();
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
      notice = null;
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
