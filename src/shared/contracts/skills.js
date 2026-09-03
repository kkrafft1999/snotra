/**
 * Contracts für das Skill-System (Issue #18).
 *
 * Ein Skill ist ein Verzeichnis mit einer `SKILL.md` im Agent-Skills-Format
 * (agentskills.io). Snotra kennt zwei Arten von Quellen:
 *
 * - **System-Skills** sind fest in die App eingebaut (`system-skills/` im
 *   App-Bundle). Sie werden nicht installiert, sind immer vorhanden und
 *   laufen ansonsten durch dieselbe Registry wie alles andere.
 * - **Ordner-Skills** liegen im Workspace oder im Home-Verzeichnis unter
 *   `.agents/skills/` bzw. `.claude/skills/` — damit sind vorhandene
 *   Claude-Code-Skills direkt nutzbar.
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

/** Quellen in Prioritätsreihenfolge: der erste Treffer eines Namens gewinnt. */
const SKILL_SOURCES = Object.freeze({
  /** Eingebaut, Teil der App — kann nicht überschrieben werden. */
  SYSTEM: 'system',
  WORKSPACE_AGENTS: 'workspace-agents',
  WORKSPACE_CLAUDE: 'workspace-claude',
  USER_AGENTS: 'user-agents',
  USER_CLAUDE: 'user-claude',
});

const SKILL_SOURCE_ORDER = Object.freeze([
  SKILL_SOURCES.SYSTEM,
  SKILL_SOURCES.WORKSPACE_AGENTS,
  SKILL_SOURCES.WORKSPACE_CLAUDE,
  SKILL_SOURCES.USER_AGENTS,
  SKILL_SOURCES.USER_CLAUDE,
]);

/** Anzeigenamen der Quellgruppen in den Einstellungen. */
const SKILL_SOURCE_LABELS = Object.freeze({
  [SKILL_SOURCES.SYSTEM]: 'System-Skills (eingebaut)',
  [SKILL_SOURCES.WORKSPACE_AGENTS]: 'Ordner · .agents/skills',
  [SKILL_SOURCES.WORKSPACE_CLAUDE]: 'Ordner · .claude/skills',
  [SKILL_SOURCES.USER_AGENTS]: 'Benutzer · ~/.agents/skills',
  [SKILL_SOURCES.USER_CLAUDE]: 'Benutzer · ~/.claude/skills',
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

/** Obergrenze für die Anzahl gleichzeitig aktiver Skills (Token-Budget). */
const MAX_ACTIVE_SKILLS = 8;
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
    if (seen.size >= MAX_ACTIVE_SKILLS) break;
  }
  return [...seen];
}

/** Ein Katalog-Eintrag für die Einstellungen (IPC-DTO). */
function normalizeSkillSummary(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return null;
  const source = isSkillSource(data.source) ? data.source : SKILL_SOURCES.USER_CLAUDE;
  const status = isSkillStatus(data.status) ? data.status : SKILL_STATUS.AVAILABLE;
  return {
    name,
    description: typeof data.description === 'string' ? data.description.trim() : '',
    source,
    status,
    /** Absoluter Pfad des Skill-Verzeichnisses; bei System-Skills nur informativ. */
    path: typeof data.path === 'string' ? data.path : '',
    /** Grund, falls `status === 'invalid'` oder `'shadowed'`. */
    detail: typeof data.detail === 'string' ? data.detail : '',
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
  SKILL_SOURCES,
  SKILL_SOURCE_ORDER,
  SKILL_SOURCE_LABELS,
  SKILL_STATUS,
  MAX_ACTIVE_SKILLS,
  MAX_SKILL_BODY_CHARS,
  isSkillSource,
  isSkillStatus,
  isValidSkillName,
  normalizeActiveSkills,
  normalizeSkillSummary,
  normalizeSkillCatalog,
};
