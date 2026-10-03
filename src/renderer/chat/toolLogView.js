// Tool-Log im Chat: DOM-Schicht (Issue #81, herausgeloest aus ChatStream.js).
//
// Hier liegt alles, was aus einem Tool-Trace sichtbare Schritte macht: die
// einzelnen Zeilen samt Zustand und Berechtigungs-Audit, der aufklappbare
// <details>-Block und der Einzeiler in der <summary>. Die Entscheidung, *was*
// dort steht, faellt weiterhin DOM-frei in utils/tool-log-summary.js — dieses
// Modul uebersetzt sie nur in Knoten.
//
// Alle Funktionen sind frei von Chat-Zustand: sie bekommen ihre Elemente und
// Eintraege uebergeben und greifen auf nichts aus ChatStream.js zu.
import contracts from '../generated/contracts.js';
import {
  toolLineText,
  summarizeToolLog,
  formatElapsedLabel,
  thinkingLabel,
  THINKING_ELAPSED_MIN_MS,
} from '../utils/tool-log-summary.js';
import { describePermissionAudit, permissionStatusKey } from '../utils/tool-approval-view.js';
import { toolLogDebug } from './toolLogDebug.js';
import { normalizeChanges } from './fileChanges.js';
import { t, tPlural } from '../i18n.js';

const { toolCategoryForEntry } = contracts;

/** Erledigt-Marke: nur noch für Screenreader — sichtbar tragen die Zeilen ein Symbol. */
export function buildToolLineStatus() {
  const status = document.createElement('span');
  status.className = 'chat-tool-line-status sr-only';
  status.textContent = t('toolLog.line.done');
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
  // Terminal-Prompt: ausgefuehrter Code (Issue #86).
  exec: '<path d="M2.4 3.4h11.2v9.2H2.4z"/><path d="M4.8 6.4 6.8 8l-2 1.6"/><path d="M8.4 10h3"/>',
  other: '<path d="M2.4 3.4h11.2v9.2H2.4z"/><path d="M5 7l1.6 1.6L5 10.2"/>',
};

export function toolCategoryIconHtml(category) {
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
export function buildToolLine(text, state /* 'pending' | 'running' | 'done' */, callIndex, category, permission, changes) {
  const row = document.createElement('div');
  row.className = 'chat-tool-line';
  row.classList.add(TOOL_LINE_STATE_CLASS[state] || TOOL_LINE_STATE_CLASS.done);
  row.setAttribute('role', 'listitem');
  if (Number.isInteger(callIndex)) row.dataset.callIndex = String(callIndex);
  applyPermissionToRow(row, permission);
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
    row.setAttribute('aria-label', t('toolLog.line.running.label', { text }));
  } else {
    row.setAttribute('aria-label', t('toolLog.line.done.label', { text }));
    row.appendChild(buildToolLineStatus());
    applyChangesToRow(row, changes);
  }

  return row;
}

/** "3 lines added, 2 lines removed" — what "+3 −2" says. */
export function changeCountsLabel(added, removed) {
  return [
    tPlural('changes.added', added, { count: added }),
    tPlural('changes.removed', removed, { count: removed }),
  ].join(', ');
}

const SHORT_STATUS_KEYS = {
  'eol-only': 'changes.short.eol',
  binary: 'changes.short.binary',
  'too-large': 'changes.short.tooLarge',
  unchanged: 'changes.short.unchanged',
};

/**
 * A word in place of "+0 −0" for a change without lines to count: only line
 * endings, binary, too large, the same as before, or a new empty file.
 */
function shortStatusOf(changes) {
  const last = Array.isArray(changes) ? changes[changes.length - 1] : null;
  if (!last) return null;
  if (SHORT_STATUS_KEYS[last.status]) return t(SHORT_STATUS_KEYS[last.status]);
  return last.created ? t('changes.short.empty') : null;
}

/**
 * "+3 −2", with its spoken form for screen readers (#348). Nothing to count
 * says what happened instead.
 */
export function buildChangeStat(added, removed, changes) {
  const stat = document.createElement('span');
  stat.className = 'chat-change-stat';
  const word = added === 0 && removed === 0 ? shortStatusOf(changes) : null;
  if (word) {
    stat.textContent = word;
    return stat;
  }
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  shown.textContent = `+${added} −${removed}`;
  const spoken = document.createElement('span');
  spoken.className = 'sr-only';
  spoken.textContent = changeCountsLabel(added, removed);
  stat.append(shown, spoken);
  return stat;
}

/**
 * The counts of a writing call at the end of its row (#348). Several files in
 * one patch are summed; which file got what is in the preview.
 */
export function applyChangesToRow(row, changes) {
  const list = normalizeChanges(changes);
  if (!row || !list || row.querySelector('.chat-change-stat')) return;
  const added = list.reduce((sum, change) => sum + change.added, 0);
  const removed = list.reduce((sum, change) => sum + change.removed, 0);
  row.insertBefore(buildChangeStat(added, removed, list), row.querySelector('.chat-tool-line-status'));
}

function baseNameOf(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || relativePath;
}

/**
 * The line under the tool log: every file the message changed, each a button
 * that opens its diff in the preview (#348). It stands outside the folded
 * log, so that a change can be seen without unfolding it — and a log of one
 * step cannot be unfolded at all. Returns null when nothing was changed.
 *
 * `files` comes from `changedFilesOf`; `isLive(changes)` says whether main
 * still holds them; `onOpen(file)` opens one.
 */
export function buildChangesStrip(files, { isLive, onOpen }) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const strip = document.createElement('div');
  strip.className = 'chat-changes';
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', t('toolLog.changes.label'));
  const lead = document.createElement('span');
  lead.className = 'chat-changes-lead';
  lead.textContent = t('toolLog.changes.lead');
  strip.append(lead);
  let anyGone = false;
  for (const file of files) {
    const live = typeof isLive === 'function' && isLive(file.changes);
    if (!live) anyGone = true;
    const item = document.createElement(live ? 'button' : 'span');
    item.className = 'chat-change-file';
    item.title = file.relativePath;
    const name = document.createElement('span');
    name.className = 'chat-change-name';
    name.textContent = baseNameOf(file.relativePath);
    const stat = buildChangeStat(file.added, file.removed, file.changes);
    item.append(name, stat);
    if (live) {
      item.type = 'button';
      item.setAttribute('aria-label', t('toolLog.changes.open', {
        name: file.relativePath,
        counts: stat.querySelector('.sr-only')?.textContent || stat.textContent,
      }));
      item.addEventListener('click', () => onOpen?.(file));
    } else {
      item.classList.add('chat-change-file--gone');
    }
    strip.append(item);
  }
  if (anyGone) {
    const note = document.createElement('span');
    note.className = 'chat-changes-note';
    note.textContent = t('toolLog.changes.unavailable');
    strip.append(note);
  }
  return strip;
}

/** Puts the line under the tool log of `messageEl`, or takes it away. */
export function syncChangesStrip(messageEl, files, options) {
  if (!messageEl) return;
  const log = messageEl.querySelector('.chat-tool-log');
  const old = messageEl.querySelector(':scope > .chat-changes, .chat-tool-log + .chat-changes');
  const strip = log ? buildChangesStrip(files, options) : null;
  if (old && strip) old.replaceWith(strip);
  else if (old) old.remove();
  else if (strip) log.after(strip);
}

/**
 * Berechtigungs-Audit an der Zeile (Issue #66/#67): Entscheidung, Klasse,
 * Status und Grund als Tooltip, der Zustand als data-Attribut. Die Zeile
 * selbst kommt fertig vom Main („· abgelehnt“, „· wartet auf Freigabe“).
 */
export function applyPermissionToRow(row, permission) {
  if (!row || !permission || typeof permission !== 'object') return;
  const key = permissionStatusKey(permission);
  if (key) row.dataset.permission = key;
  const description = describePermissionAudit(permission);
  if (description) row.title = description;
}

export function setToolLineDone(row, doneText) {
  if (!row || row.classList.contains('chat-tool-line--done')) return;
  row.classList.remove('chat-tool-line--running');
  row.classList.add('chat-tool-line--done');
  row.removeAttribute('aria-busy');

  const textEl = row.querySelector('.chat-tool-line-text');
  if (doneText && textEl) textEl.textContent = doneText;
  const finalText = textEl?.textContent || doneText || '';
  if (finalText) row.setAttribute('aria-label', t('toolLog.line.done.label', { text: finalText }));

  if (!row.querySelector('.chat-tool-line-status')) row.appendChild(buildToolLineStatus());
}

export function setToolLineText(row, text) {
  const textEl = row?.querySelector('.chat-tool-line-text');
  if (!textEl || !text) return;
  textEl.textContent = text;
  row.setAttribute('aria-label', t('toolLog.line.running.label', { text }));
}

/** Vorläufige Zeile (Aufruf gestreamt) wird zur laufenden Zeile (Tool wird ausgeführt). */
export function promoteToolLineToRunning(row, text) {
  if (!row) return;
  row.classList.remove('chat-tool-line--pending');
  row.classList.add('chat-tool-line--running');
  setToolLineText(row, text);
}

export function findPendingToolLine(linesEl, callIndex, fallbackToFirst = false) {
  if (!linesEl) return null;
  const byIndex = Number.isInteger(callIndex)
    ? linesEl.querySelector(`.chat-tool-line--pending[data-call-index="${callIndex}"]`)
    : null;
  if (byIndex || !fallbackToFirst) return byIndex;
  return linesEl.querySelector('.chat-tool-line--pending');
}

/** Die Einzeiler-Zeile in der <summary>: aktueller bzw. letzter Schritt plus Zusatz. */
export function buildToolSummaryLine() {
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

export function readToolLogSteps(wrap) {
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
export function syncToolSummaryIcon(line, category) {
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

export function syncToolSummaryLine(line, summary) {
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
    line.setAttribute('aria-label', t('toolLog.line.done.label', { text: label }));
    if (!line.querySelector('.chat-tool-line-status')) {
      line.insertBefore(buildToolLineStatus(), line.querySelector('.chat-tool-chevron'));
    }
    line.querySelector('.chat-tool-line-status').textContent = t('toolLog.line.done');
  } else {
    line.setAttribute('aria-busy', 'true');
    line.setAttribute('aria-label', t('toolLog.line.running.label', { text: label }));
    line.querySelector('.chat-tool-line-status')?.remove();
  }
}

/**
 * Die Schrittliste ist höhenbegrenzt und scrollt (Issue #60). Der Fade am
 * unteren Rand erscheint nur, solange dort wirklich noch etwas folgt — sonst
 * sähe die letzte Zeile dauerhaft ausgegraut aus.
 */
export function syncToolListOverflow(linesEl) {
  if (!linesEl) return;
  const overflowing = linesEl.scrollHeight - linesEl.clientHeight > 1;
  const atBottom = linesEl.scrollTop + linesEl.clientHeight >= linesEl.scrollHeight - 2;
  linesEl.classList.toggle('chat-tool-lines--fade', overflowing && !atBottom);
}

/** Neue Schritte nachziehen, solange der Nutzer die Liste unten hat. */
export function appendToolLine(linesEl, row) {
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
export function syncToolLogSummary(wrap, { thinking = false, elapsedMs = 0 } = {}) {
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
 * Trace-Eintrag für Store und Verlauf: nur Anzeige-Zeile und Tool-Name. Die
 * Argumente aus dem Engine-Ergebnis bleiben bewusst draußen (write_file_text
 * trägt dort bis zu 2 MB Dateiinhalt). What a writing call changed comes along
 * as summaries — ids and line counts, never content (#348).
 */
export function toolTraceEntryForStore(entry) {
  const line = toolLineText(entry);
  const tool = typeof entry?.tool === 'string' ? entry.tool : '';
  const skill = typeof entry?.skill === 'string' ? entry.skill : '';
  // Das Audit ist bereits bereinigt (nur Entscheidung, Klassen, Status,
  // Pfade – keine Inhalte); der Main normalisiert es beim Speichern erneut.
  const permission = entry?.permission && typeof entry.permission === 'object' ? { ...entry.permission } : null;
  const changes = normalizeChanges(entry?.changes);
  if (!tool && !skill && !permission && !changes) return line;
  const out = { line };
  if (tool) out.tool = tool;
  if (skill) out.skill = skill;
  if (permission) out.permission = permission;
  if (changes) out.changes = changes;
  return out;
}

/**
 * Kategorie eines Trace-Eintrags. Vor #60 gespeicherte Sessions enthalten
 * bloße Strings ohne Tool-Namen — die bleiben ohne Symbol und lassen die
 * Zusammenfassung auf die alte Form zurückfallen.
 */
export function traceEntryCategory(entry) {
  if (typeof entry === 'string' || !entry) return null;
  const hasInfo =
    (typeof entry.tool === 'string' && entry.tool)
    || (typeof entry.skill === 'string' && entry.skill);
  return hasInfo ? toolCategoryForEntry(entry) : null;
}

export function hasToolSteps(message) {
  return (message?.toolTrace?.length || 0) + (message?.pendingToolLines?.length || 0) > 0;
}

/**
 * „Denkt nach“ = Streaming läuft, aber noch nichts Sichtbares: Warten auf die
 * Runde oder erste Tokens ohne Text (z. B. gestreamte Tool-Argumente, bevor
 * die vorläufige Zeile steht). Ein laufender Tool-Schritt hat in der
 * Einzeiler-Zeile ohnehin Vorrang.
 */
export function isThinking(message) {
  if (!message?.streaming || message.phase === 'idle') return false;
  if (message.phase === 'generating') return !(message.content && message.content.length > 0);
  return true;
}

/**
 * Dauer des aktuellen Nachdenkens (Issue #87). `thinkingSince` setzt der
 * Phasenwechsel auf 'waiting' (Beginn jeder Runde) und löscht das nächste
 * Tool-Ereignis bzw. der erste Text; nur Anzeige, wird nicht persistiert.
 */
export function thinkingElapsedMs(message) {
  const since = Number(message?.thinkingSince);
  return since > 0 ? Math.max(0, Date.now() - since) : 0;
}

/**
 * Die Phasen-Zeile über dem Tool-Log erscheint nur, solange es noch keinen
 * Tool-Schritt gibt. Danach zeigt der Tool-Einzeiler das Nachdenken selbst,
 * sonst würde die Zeile bei jeder Runde ein- und ausblenden und alles
 * darunter springen (Issue #60).
 */
export function syncPhaseLine(phaseEl, message) {
  if (!phaseEl) return;
  const show = isThinking(message) && !hasToolSteps(message);
  phaseEl.classList.toggle('hidden', !show);
  // Auch vor dem ersten Tool-Schritt kann ein Reasoning-Modell lange nachdenken:
  // ab fünf Sekunden steht die Dauer dahinter (Issue #87).
  const elapsedMs = show ? thinkingElapsedMs(message) : 0;
  const suffix = elapsedMs >= THINKING_ELAPSED_MIN_MS ? ` · ${formatElapsedLabel(elapsedMs)}` : '';
  phaseEl.textContent = show ? `${thinkingLabel()}${suffix}` : '';
}

export function finalizeAllToolLines(wrap) {
  if (!wrap) return;
  // Vorläufige Zeilen ohne Start-Ereignis: Das Tool ist nie gelaufen (Abbruch/Fehler).
  wrap.querySelectorAll('.chat-tool-lines > .chat-tool-line--pending').forEach((row) => row.remove());
  wrap.querySelectorAll('.chat-tool-lines > .chat-tool-line--running').forEach(setToolLineDone);
  syncToolLogSummary(wrap);
}

export function buildToolLog(trace, state /* 'running' | 'done' */, pendingLines, { thinking = false, elapsedMs = 0 } = {}) {
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
  lines.setAttribute('aria-label', t('toolLog.allSteps'));
  lines.addEventListener('scroll', () => syncToolListOverflow(lines));
  log.appendChild(lines);

  if (Array.isArray(trace) && trace.length > 0) {
    for (let i = 0; i < trace.length; i += 1) {
      const text = toolLineText(trace[i]);
      // Beim Nachdenken ist die vorige Runde komplett erledigt.
      const lineState =
        state === 'running' && !thinking && i === trace.length - 1 ? 'running' : 'done';
      lines.appendChild(
        buildToolLine(text, lineState, undefined, traceEntryCategory(trace[i]), trace[i]?.permission, trace[i]?.changes)
      );
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
