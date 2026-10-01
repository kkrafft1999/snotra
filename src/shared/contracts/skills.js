/**
 * Contracts für das Skill-System (Issue #18).
 *
 * Ein Skill ist ein Verzeichnis mit einer `SKILL.md` im Agent-Skills-Format
 * (agentskills.io). Snotra kennt zwei Arten von Quellen:
 *
 * - **System-Skills** sind fest in die App eingebaut (`system-skills/` im
 *   App-Bundle). Sie werden nicht installiert, sind immer vorhanden und
 *   laufen ansonsten durch dieselbe Registry wie alles andere.
 * - **Ordner-Skills** liegen im Workspace unter `.agents/skills/` oder global
 *   unter `~/.snotra/skills/`. `~/.snotra/` ist die Wurzel für Snotra-eigene
 *   Nutzerdaten und seit Issue #251 der Standardort für globale Skills;
 *   `~/.agents/skills/` bleibt als kompatibler Alt-Ort lesbar. Andere
 *   Werkzeugverzeichnisse — insbesondere `.claude/` — liest Snotra bewusst
 *   nicht (Issue #103).
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

const { createMessage, isMessage } = require('./message');

/**
 * Name des Tools, mit dem das Modell die Anleitung eines eingeschalteten
 * Skills nachlädt (Issue #173). Steht hier, weil drei Schichten denselben
 * Namen brauchen: die Registry beim Registrieren, die Engine beim Prüfen, ob
 * es ihn überhaupt gibt, und die Anzeige für die Zeile im Verlauf.
 */
const LOAD_SKILL_TOOL = 'load_skill';

/**
 * Where a skill keeps what it produces, relative to the open folder (#548).
 * A skill folder is read-only: it is shared by every workspace the skill is
 * switched on in and gets replaced when the skill is updated, so its data
 * lives with the project instead. Skills written for other agents spell the
 * place `<workspace>/.agents/data/…`.
 */
const SKILL_DATA_DIR = '.agents/data';

/** The refusal of a write into a skill folder — it names the place to use instead. */
const SKILL_FOLDER_READ_ONLY =
  `Skill folders are read-only. Keep what a skill produces in "${SKILL_DATA_DIR}/" in the open folder.`;

/** Quellen in Prioritätsreihenfolge: der erste Treffer eines Namens gewinnt. */
const SKILL_SOURCES = Object.freeze({
  /** Eingebaut, Teil der App — kann nicht überschrieben werden. */
  SYSTEM: 'system',
  WORKSPACE_AGENTS: 'workspace-agents',
  /** Standardort für globale Skills (Issue #251). */
  USER_SNOTRA: 'user-snotra',
  /** Kompatibler Alt-Ort, weiterhin gelesen. */
  USER_AGENTS: 'user-agents',
});

/**
 * Der Workspace bleibt die stärkste Ordner-Quelle; unter den globalen gewinnt
 * der neue Standardort vor dem Alt-Ort (entschieden am 2026-09-21, #251).
 */
const SKILL_SOURCE_ORDER = Object.freeze([
  SKILL_SOURCES.SYSTEM,
  SKILL_SOURCES.WORKSPACE_AGENTS,
  SKILL_SOURCES.USER_SNOTRA,
  SKILL_SOURCES.USER_AGENTS,
]);

/**
 * Headings of the source groups in the settings, as catalogue keys (#353):
 * they are words, and the settings are read in either language.
 */
const SKILL_SOURCE_LABEL_KEYS = Object.freeze({
  [SKILL_SOURCES.SYSTEM]: 'skills.source.system',
  [SKILL_SOURCES.WORKSPACE_AGENTS]: 'skills.source.workspaceAgents',
  [SKILL_SOURCES.USER_SNOTRA]: 'skills.source.userSnotra',
  [SKILL_SOURCES.USER_AGENTS]: 'skills.source.userAgents',
});

const SKILL_STATUS = Object.freeze({
  /** Nutzbar und in den Einstellungen eingeschaltet. */
  ACTIVE: 'active',
  /** Nutzbar, aber nicht eingeschaltet. */
  AVAILABLE: 'available',
  /** Gleicher Name existiert in einer höher priorisierten Quelle. */
  SHADOWED: 'shadowed',
  /** `SKILL.md` fehlt oder das Frontmatter ist unbrauchbar. */
  INVALID: 'invalid',
});

/** Obergrenze für den in den Systemprompt übernommenen Body eines Skills. */
const MAX_SKILL_BODY_CHARS = 20000;

function isSkillSource(value) {
  return SKILL_SOURCE_ORDER.includes(value);
}

function isSkillStatus(value) {
  return Object.values(SKILL_STATUS).includes(value);
}

/**
 * Skill-Namen müssen zum Verzeichnisnamen passen (agentskills.io) — daher
 * dieselbe konservative Zeichenmenge wie bei den Verzeichnissen.
 */
function isValidSkillName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/**
 * Liste eingeschalteter Skills aus den UI-Prefs säubern.
 * @returns {string[] | null} `null`, wenn kein Array übergeben wurde (Feld
 *   also nie gesetzt war) — die Voreinstellung entscheidet dann.
 */
function normalizeActiveSkills(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!isValidSkillName(name) || seen.has(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

/** More folders than this with a switched-on skill of their own are not kept. */
const MAX_WORKSPACE_SKILL_ROOTS = 500;

/**
 * Skills switched on per folder, from the UI preferences (#576): the resolved
 * workspace root as key, the names of that folder's own skills as value.
 *
 * A workspace skill is somebody else's text, so its switch-on is bound to the
 * folder it was ticked in. The global `activeSkills` list only ever switches
 * on system and global skills — otherwise a cloned repository with a skill of
 * the same name would inherit the user's choice.
 *
 * @returns {Record<string, string[]> | null} `null` when nothing is stored
 */
function normalizeActiveWorkspaceSkills(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [root, names] of Object.entries(raw)) {
    if (count >= MAX_WORKSPACE_SKILL_ROOTS) break;
    // `__proto__` would set the prototype instead of a key; no root is named so.
    if (typeof root !== 'string' || !root.trim() || root === '__proto__') continue;
    const list = normalizeActiveSkills(names);
    if (!list || list.length === 0) continue;
    out[root] = list;
    count += 1;
  }
  return count > 0 ? out : null;
}

function normalizeSkillDetail(value) {
  if (isMessage(value)) return createMessage(value.key, value.params);
  return typeof value === 'string' ? value : '';
}

/** Ein Katalog-Eintrag für die Einstellungen (IPC-DTO). */
function normalizeSkillSummary(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return null;
  const source = isSkillSource(data.source) ? data.source : SKILL_SOURCES.USER_AGENTS;
  const status = isSkillStatus(data.status) ? data.status : SKILL_STATUS.AVAILABLE;
  return {
    name,
    description: typeof data.description === 'string' ? data.description.trim() : '',
    source,
    status,
    /** Absoluter Pfad des Skill-Verzeichnisses; bei System-Skills nur informativ. */
    path: typeof data.path === 'string' ? data.path : '',
    /**
     * Grund, falls `status === 'invalid'` oder `'shadowed'` — a message
     * descriptor since #353, worded where the settings show it.
     */
    detail: normalizeSkillDetail(data.detail),
    /** System-Skills lassen sich nicht durch Ordner-Skills ersetzen. */
    builtin: source === SKILL_SOURCES.SYSTEM,
  };
}

function normalizeSkillCatalog(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const skills = Array.isArray(data.skills)
    ? data.skills.map((row) => normalizeSkillSummary(row)).filter(Boolean)
    : [];
  return { skills };
}

module.exports = {
  LOAD_SKILL_TOOL,
  SKILL_DATA_DIR,
  SKILL_FOLDER_READ_ONLY,
  SKILL_SOURCES,
  SKILL_SOURCE_ORDER,
  SKILL_SOURCE_LABEL_KEYS,
  SKILL_STATUS,
  MAX_SKILL_BODY_CHARS,
  isSkillSource,
  isSkillStatus,
  isValidSkillName,
  normalizeActiveSkills,
  normalizeActiveWorkspaceSkills,
  MAX_WORKSPACE_SKILL_ROOTS,
  normalizeSkillSummary,
  normalizeSkillCatalog,
};
