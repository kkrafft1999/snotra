/**
 * Aufschlüsselung der Token-Anzeige (Issue #174).
 *
 * Der Zähler unter dem Eingabefeld sagte bisher nur, *dass* ein Prompt groß
 * ist. Diese Fläche sagt, *woraus* er besteht: je eingeschaltetem Skill eine
 * Zeile, dazu Tool-Definitionen (getrennt nach eingebaut und je MCP-Server),
 * der übrige System-Prompt und der Verlauf.
 *
 * Die Zahlen kommen aus der Engine (shared/contracts/context-breakdown.js):
 * Die Gesamtzahl ist die echte des Anbieters, die Anteile sind aus Zeichen
 * geschätzt. Beides wird in der Anzeige auseinandergehalten.
 */
import contracts from '../generated/contracts.js';
import { dismissOnOutsideClick } from '../utils/helpers.js';

const { normalizeContextBreakdown, groupContextParts } = contracts;

const tokenFormatter = new Intl.NumberFormat('de-DE');
const oneDecimalFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const percentFormatter = new Intl.NumberFormat('de-DE', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const percentWholeFormatter = new Intl.NumberFormat('de-DE', {
  style: 'percent',
  maximumFractionDigits: 0,
});

/** Kompakte Tokenzahl für die Zeilen: „980", „3,1 K", „17 K". */
export function formatTokensShort(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return tokenFormatter.format(n);
  const inK = n / 1000;
  if (inK < 10) return `${oneDecimalFormatter.format(inK)} K`;
  return `${tokenFormatter.format(Math.round(inK))} K`;
}

/** Anteile unter 1 % nicht auf „0 %" runden — sonst sieht klein aus wie nichts. */
export function formatShare(share) {
  const value = Number(share);
  if (!Number.isFinite(value) || value <= 0) return '0 %';
  if (value < 0.01) return `< ${percentWholeFormatter.format(0.01)}`;
  if (value < 0.1) return percentFormatter.format(value);
  return percentWholeFormatter.format(value);
}

/**
 * Spitze Klammer wie bei den aufklappbaren Zeilen in den Einstellungen —
 * dieselbe Form, dieselbe Drehung beim Öffnen, damit „das kann man aufklappen"
 * in der App überall gleich aussieht.
 */
const CHEVRON_ICON_HTML =
  '<svg class="token-breakdown__group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Balken als Anteilsbild. Rein begleitend — die Zahl daneben trägt die
 * Aussage, der Balken ist nie der einzige Träger (WCAG 1.4.1).
 */
function buildBar(share) {
  const track = el('span', 'token-breakdown__bar');
  track.setAttribute('aria-hidden', 'true');
  const fill = el('span', 'token-breakdown__bar-fill');
  const percent = Math.max(0, Math.min(100, (Number(share) || 0) * 100));
  // Unter 1,5 % bliebe der Balken unsichtbar; ein Strich zeigt wenigstens, dass
  // die Zeile überhaupt etwas beiträgt.
  fill.style.width = `${percent > 0 ? Math.max(1.5, percent) : 0}%`;
  track.appendChild(fill);
  return track;
}

function buildRowBody(part) {
  const body = el('span', 'token-breakdown__row-body');
  const head = el('span', 'token-breakdown__row-head');
  const label = el('span', 'token-breakdown__row-label', part.label);
  label.title = part.label;
  // Zahl und Anteil bleiben zusammen: Bei schmalem Chat-Panel rutscht das Paar
  // als Ganzes unter das Etikett, statt in zwei Zeilen zu zerfallen.
  const figures = el('span', 'token-breakdown__figures');
  figures.append(
    el('span', 'token-breakdown__row-tokens', formatTokensShort(part.tokens)),
    el('span', 'token-breakdown__row-share', formatShare(part.share))
  );
  head.append(label, figures);
  body.appendChild(head);
  body.appendChild(buildBar(part.share));
  if (part.detail) body.appendChild(el('span', 'token-breakdown__row-detail', part.detail));
  return body;
}

export function initTokenBreakdownPanel({
  trigger,
  panel,
  getState,
  onOpenSkillSettings,
  onOpen,
} = {}) {
  let open = false;
  // Welche Gruppen aufgeklappt sind. Lebt so lange wie die Fläche selbst,
  // damit ein Blick auf die Skills nicht nach jeder Antwort neu erarbeitet
  // werden muss.
  const expandedGroups = new Set();

  function isOpen() {
    return open;
  }

  function renderEmpty(message) {
    panel.appendChild(el('p', 'token-breakdown__empty', message));
  }

  function renderSkillAction(row) {
    // Der Hinweis ist Beiwerk: Was der Klick tut, steht im aria-label der Zeile.
    const action = el('span', 'token-breakdown__row-action', 'Einstellungen');
    action.setAttribute('aria-hidden', 'true');
    row.appendChild(action);
  }

  function renderRow(list, part) {
    const item = el('li', 'token-breakdown__row-item');
    const canJump = Boolean(part.skillName) && typeof onOpenSkillSettings === 'function';
    const row = el(canJump ? 'button' : 'div', 'token-breakdown__row');
    if (canJump) {
      row.type = 'button';
      row.classList.add('token-breakdown__row--action');
      row.dataset.skillName = part.skillName;
      // Wer sieht, was ein Skill kostet, will ihn sofort abschalten können.
      row.setAttribute(
        'aria-label',
        `${part.label}, ${formatTokensShort(part.tokens)} Tokens, ${formatShare(part.share)} — Skill in den Einstellungen öffnen`
      );
    }
    row.appendChild(buildRowBody(part));
    if (canJump) renderSkillAction(row);
    item.appendChild(row);
    list.appendChild(item);
  }

  /**
   * Eine Gruppe: Summe immer sichtbar, Einzelposten erst auf Klick.
   *
   * Zugeklappt ist der Ausgangszustand — die erste Frage lautet „wo geht der
   * Platz hin", nicht „welcher Skill genau". Wer aufklappt, bleibt aufgeklappt:
   * `expandedGroups` überlebt das Neuzeichnen nach einer neuen Antwort und das
   * Schließen der Fläche, sonst müsste man nach jeder Anfrage wieder klicken.
   */
  function renderGroup(group) {
    const item = el('li', 'token-breakdown__group');
    const expanded = expandedGroups.has(group.group);
    if (expanded) item.classList.add('token-breakdown__group--open');

    const rowsId = `chat-token-breakdown-rows-${group.group}`;
    const head = el('button', 'token-breakdown__group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    head.setAttribute('aria-controls', rowsId);
    head.dataset.group = group.group;

    const headLine = el('span', 'token-breakdown__group-line');
    headLine.insertAdjacentHTML('beforeend', CHEVRON_ICON_HTML);
    const groupFigures = el('span', 'token-breakdown__figures');
    groupFigures.append(
      el('span', 'token-breakdown__group-tokens', formatTokensShort(group.tokens)),
      el('span', 'token-breakdown__group-share', formatShare(group.share))
    );
    headLine.append(
      el('span', 'token-breakdown__group-label', group.label),
      el(
        'span',
        'token-breakdown__group-count',
        group.parts.length === 1 ? '1 Posten' : `${group.parts.length} Posten`
      ),
      groupFigures
    );
    head.appendChild(headLine);
    // Der Balken gehört zur Summe, nicht zum Detail: Er zeigt auch zugeklappt,
    // welche Gruppe den Prompt dominiert.
    head.appendChild(buildBar(group.share));
    item.appendChild(head);

    const rows = el('ul', 'token-breakdown__rows');
    rows.id = rowsId;
    rows.hidden = !expanded;
    for (const part of group.parts) renderRow(rows, part);
    item.appendChild(rows);
    return item;
  }

  function render() {
    const state = typeof getState === 'function' ? getState() : {};
    const breakdown = normalizeContextBreakdown(state?.breakdown);
    const usage = state?.usage || { prompt: 0, completion: 0, total: 0 };
    panel.textContent = '';

    const header = el('div', 'token-breakdown__header');
    const title = el('h2', 'token-breakdown__title', 'Kontextfenster der letzten Anfrage');
    title.id = 'chat-token-breakdown-title';
    header.appendChild(title);
    const sum = el(
      'p',
      'token-breakdown__sum',
      `${tokenFormatter.format(usage.prompt || 0)} Tokens Prompt · ${tokenFormatter.format(
        usage.completion || 0
      )} Tokens Antwort`
    );
    header.appendChild(sum);
    panel.appendChild(header);

    if (state?.inFlight) {
      panel.appendChild(
        el(
          'p',
          'token-breakdown__note token-breakdown__note--live',
          'Eine Anfrage läuft — die Werte stammen noch von der vorherigen.'
        )
      );
    }

    if (!breakdown) {
      renderEmpty(
        usage.prompt > 0
          ? 'Für diese Anfrage liegt keine Aufschlüsselung vor. Sie entsteht beim nächsten Absenden.'
          : 'Noch keine Anfrage gestellt. Sobald eine Antwort da ist, steht hier, woraus der Prompt bestand — je Skill, Tool-Gruppe und Verlauf.'
      );
      return;
    }

    const groups = groupContextParts(breakdown);
    const list = el('ul', 'token-breakdown__list');
    for (const group of groups) list.appendChild(renderGroup(group));
    panel.appendChild(list);

    panel.appendChild(
      el(
        'p',
        'token-breakdown__note',
        breakdown.scaled
          ? 'Die Gesamtzahl kommt vom Anbieter, die Aufteilung ist aus der Zeichenzahl geschätzt.'
          : 'Der Anbieter hat keine Tokenzahl gemeldet — alle Werte sind geschätzt.'
      )
    );
  }

  function openPanel() {
    if (open) return;
    open = true;
    render();
    panel.classList.remove('hidden');
    trigger?.setAttribute('aria-expanded', 'true');
    onOpen?.();
  }

  function closePanel({ focusTrigger = false } = {}) {
    if (!open) return;
    open = false;
    panel.classList.add('hidden');
    panel.textContent = '';
    trigger?.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger?.focus();
  }

  function toggle() {
    if (open) closePanel({ focusTrigger: true });
    else openPanel();
  }

  /** Neue Zahlen: nur nachzeichnen, wenn gerade jemand hinsieht. */
  function refresh() {
    if (open) render();
  }

  // Klick daneben schliesst — dasselbe Muster wie Modell-Auswahl und
  // @-Vervollstaendigung.
  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (target) => !!target?.closest?.('.chat-token-usage-wrap'),
    onDismiss: () => closePanel(),
  });

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });

  panel?.addEventListener('click', (event) => {
    const head = event.target.closest?.('.token-breakdown__group-head');
    if (head) {
      // An Ort und Stelle umschalten statt neu zu zeichnen: Die Fläche scrollt,
      // und ein Neuaufbau würde beim Aufklappen unter dem Finger wegspringen.
      const group = head.dataset.group;
      const expanded = head.getAttribute('aria-expanded') === 'true';
      const rows = head.parentElement?.querySelector('.token-breakdown__rows');
      if (expanded) expandedGroups.delete(group);
      else expandedGroups.add(group);
      head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      head.parentElement?.classList.toggle('token-breakdown__group--open', !expanded);
      if (rows) rows.hidden = expanded;
      return;
    }

    const row = event.target.closest?.('.token-breakdown__row--action');
    if (!row) return;
    const name = row.dataset.skillName;
    if (!name) return;
    closePanel();
    onOpenSkillSettings?.(name);
  });

  panel?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePanel({ focusTrigger: true });
    }
  });

  trigger?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      closePanel({ focusTrigger: true });
    }
  });

  return { isOpen, open: openPanel, close: closePanel, toggle, refresh, render };
}
