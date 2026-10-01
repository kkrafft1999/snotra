'use strict';

/**
 * Skill-Discovery und -Parsing (Issue #18).
 *
 * Sammelt Skills aus vier Quellen — den eingebauten System-Skills der App,
 * `.agents/skills` im Workspace, `~/.snotra/skills` (Standardort für globale
 * Skills, Issue #251) und `~/.agents/skills` (kompatibler Alt-Ort) — und
 * liefert einen Katalog für die Einstellungen sowie die Bodies der
 * eingeschalteten Skills für den Systemprompt. Verzeichnisse anderer
 * Werkzeuge, insbesondere `.claude/`, liest Snotra bewusst nicht (Issue #103).
 *
 * Gescannt wird beim ersten Zugriff je Workspace, danach liefert der Cache.
 * Verworfen wird er von `reload()` — entweder durch den Datei-Watcher, der
 * die Skill-Verzeichnisse beobachtet (`skills-watcher.js`, Issue #126), oder
 * durch „Skills neu laden“ in den Einstellungen. Der Dienst selbst kennt
 * beide nicht und weiss nur, wie er alles wegwirft.
 */

const { parseSkillDocument } = require('../../shared/runtime/skill-frontmatter');
const { fillUiQuotes } = require('../../shared/i18n/ui-quotes');
const { createMessage } = require('../../shared/contracts/message');
const {
  SKILL_SOURCES,
  SKILL_STATUS,
  MAX_SKILL_BODY_CHARS,
  isValidSkillName,
} = require('../../shared/contracts/skills');

const SKILL_FILE = 'SKILL.md';
/** Schutz vor versehentlich riesigen Verzeichnissen. */
const MAX_SKILLS_PER_DIRECTORY = 200;

/**
 * Menu paths quoted in a system skill follow the interface language (#294).
 * Applied on the way out rather than when the file is read, so the scan cache
 * keeps the raw text and a language change costs nothing.
 *
 * Only the app's own skills. A folder skill is somebody else's text and is
 * passed through exactly as it stands.
 */
function withMenuPaths(skill, locale) {
  if (skill.source !== SKILL_SOURCES.SYSTEM) return skill;
  return {
    ...skill,
    description: fillUiQuotes(locale, skill.description),
    body: fillUiQuotes(locale, skill.body),
  };
}

function createSkillsService({ fs, path, os, systemSkillsDir = null, maxSkillBodyChars = MAX_SKILL_BODY_CHARS }) {
  if (!fs || !path) throw new TypeError('createSkillsService benötigt fs und path.');

  /** @type {Map<string, Promise<{ skills: Array<object> }>>} */
  const scanCache = new Map();

  function homeDir() {
    try {
      return os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
  }

  function sourceDirectories(workspaceRoot) {
    const dirs = [];
    if (systemSkillsDir) {
      dirs.push({ source: SKILL_SOURCES.SYSTEM, dir: systemSkillsDir });
    }
    const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    if (root) {
      dirs.push({ source: SKILL_SOURCES.WORKSPACE_AGENTS, dir: path.join(root, '.agents', 'skills') });
    }
    const home = homeDir();
    if (home) {
      // `~/.snotra/` gehört Snotra allein und ist der Standardort; der ältere
      // `~/.agents/skills` bleibt lesbar und kommt deshalb dahinter.
      dirs.push({ source: SKILL_SOURCES.USER_SNOTRA, dir: path.join(home, '.snotra', 'skills') });
      dirs.push({ source: SKILL_SOURCES.USER_AGENTS, dir: path.join(home, '.agents', 'skills') });
    }
    return dirs;
  }

  async function readSkillDirectory(source, dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Fehlende oder unlesbare Verzeichnisse sind kein Fehler.
      return [];
    }

    // Hidden entries are skipped and the rest sorted before the cap applies
    // (#579): `readdir` order is the file system's (hash order on ext4), and
    // which skills a crowded folder keeps must not depend on it.
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_SKILLS_PER_DIRECTORY);
    const found = [];
    for (const entry of visible) {
      const dirName = entry.name;
      const skillDir = path.join(dir, dirName);
      if (!entry.isDirectory()) {
        // Häufiger Praxisfall: ein heruntergeladenes `foo.zip` liegt daneben.
        found.push(invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.notDirectory')));
        continue;
      }
      found.push(await readSkillFolder(source, dirName, skillDir));
    }
    return found;
  }

  function invalidSkill(source, name, skillDir, detail) {
    return {
      name,
      description: '',
      source,
      status: SKILL_STATUS.INVALID,
      path: skillDir,
      detail,
      body: '',
    };
  }

  async function readSkillFolder(source, dirName, skillDir) {
    const filePath = path.join(skillDir, SKILL_FILE);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.missingFile', { file: SKILL_FILE }));
    }

    const parsed = parseSkillDocument(raw);
    if (!parsed) {
      return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.noFrontmatter'));
    }

    const name = typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const description =
      typeof parsed.frontmatter.description === 'string' ? parsed.frontmatter.description.trim() : '';

    if (!name) return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.noName'));
    if (!description) return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.noDescription'));
    if (!isValidSkillName(name)) return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.badName', { name }));
    if (name !== dirName) {
      return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.nameMismatch', { name, dir: dirName }));
    }

    const body = parsed.body.length > maxSkillBodyChars ? parsed.body.slice(0, maxSkillBodyChars) : parsed.body;
    return {
      name,
      description,
      source,
      status: SKILL_STATUS.AVAILABLE,
      path: skillDir,
      detail: '',
      body,
      truncated: parsed.body.length > maxSkillBodyChars,
    };
  }

  async function scanAll(workspaceRoot) {
    const collected = [];
    for (const { source, dir } of sourceDirectories(workspaceRoot)) {
      collected.push(...(await readSkillDirectory(source, dir)));
    }

    // Erster Treffer eines Namens gewinnt; die Quellen kommen bereits in
    // Prioritätsreihenfolge. Ungültige Einträge verdrängen nichts.
    const winners = new Map();
    for (const skill of collected) {
      if (skill.status === SKILL_STATUS.INVALID) continue;
      if (!winners.has(skill.name)) winners.set(skill.name, skill);
    }
    for (const skill of collected) {
      if (skill.status === SKILL_STATUS.INVALID) continue;
      const winner = winners.get(skill.name);
      if (winner !== skill) {
        skill.status = SKILL_STATUS.SHADOWED;
        skill.detail = createMessage('skills.shadowedBy', { path: winner.path });
      }
    }

    return { skills: collected };
  }

  function cacheKey(workspaceRoot) {
    return typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : '';
  }

  function scan(workspaceRoot) {
    const key = cacheKey(workspaceRoot);
    if (!scanCache.has(key)) scanCache.set(key, scanAll(workspaceRoot));
    return scanCache.get(key);
  }

  /** Cache verwerfen — für „Skills neu laden“ in den Einstellungen. */
  function reload() {
    scanCache.clear();
  }

  /**
   * Voreinstellung: System-Skills sind an, Ordner-Skills nicht. Ordner-Skills
   * sind fremder Inhalt (Prompt-Injection) und werden nur nach ausdrücklicher
   * Auswahl in den Systemprompt übernommen.
   */
  function defaultActiveNames(skills) {
    return skills
      .filter((skill) => skill.source === SKILL_SOURCES.SYSTEM && skill.status !== SKILL_STATUS.INVALID)
      .map((skill) => skill.name);
  }

  function resolveActiveNames(skills, activeSkills) {
    return Array.isArray(activeSkills) ? activeSkills : defaultActiveNames(skills);
  }

  /** The names switched on for this folder's own skills (#576). */
  function workspaceActiveNames(workspaceRoot, activeWorkspaceSkills) {
    const key = cacheKey(workspaceRoot);
    if (!key || !activeWorkspaceSkills || typeof activeWorkspaceSkills !== 'object') return [];
    if (!Object.prototype.hasOwnProperty.call(activeWorkspaceSkills, key)) return [];
    const names = activeWorkspaceSkills[key];
    return Array.isArray(names) ? names : [];
  }

  /**
   * Which skills are switched on here. A switch-on is bound to where it was
   * made (#576): the global list switches on system and global skills only,
   * and a workspace skill only through its own folder's list. A name alone
   * would hand the user's choice to any skill that happens to win the name —
   * a cloned repository with `.agents/skills/<name>` would take over the
   * user's own global skill.
   */
  function switchedOn(skills, { workspaceRoot, activeSkills, activeWorkspaceSkills }) {
    const global = new Set(resolveActiveNames(skills, activeSkills));
    const workspace = new Set(workspaceActiveNames(workspaceRoot, activeWorkspaceSkills));
    return (skill) =>
      skill.status === SKILL_STATUS.AVAILABLE
      && (skill.source === SKILL_SOURCES.WORKSPACE_AGENTS ? workspace : global).has(skill.name);
  }

  async function listCatalog({
    workspaceRoot = null,
    activeSkills = null,
    activeWorkspaceSkills = null,
    locale = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    const isOn = switchedOn(skills, { workspaceRoot, activeSkills, activeWorkspaceSkills });
    return {
      skills: skills.map((raw) => withMenuPaths(raw, locale)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        status: isOn(skill) ? SKILL_STATUS.ACTIVE : skill.status,
        path: skill.path,
        detail: skill.detail,
      })),
    };
  }

  /**
   * Bodies der eingeschalteten Skills — Reihenfolge = Quellpriorität.
   *
   * `invokedSkills` sind die per `/name` im Chat aufgerufenen Skills
   * (Issue #124). Sie kommen zusätzlich zur dauerhaften Auswahl dazu und
   * gelten nur für diesen Verlauf.
   */
  async function getActiveSkills({
    workspaceRoot = null,
    activeSkills = null,
    activeWorkspaceSkills = null,
    invokedSkills = null,
    locale = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    const isOn = switchedOn(skills, { workspaceRoot, activeSkills, activeWorkspaceSkills });
    const invoked = new Set(Array.isArray(invokedSkills) ? invokedSkills : []);
    return skills
      .filter(
        (skill) =>
          skill.status === SKILL_STATUS.AVAILABLE
          && (isOn(skill) || invoked.has(skill.name))
      )
      .map((raw) => withMenuPaths(raw, locale))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
        body: skill.body,
        /** Kam dieser Skill per `/name` dazu statt über die Einstellungen? */
        invoked: invoked.has(skill.name) && !isOn(skill),
      }));
  }

  /**
   * Turn the ticks the settings show for the open folder into what is stored
   * (#576). `selected` is the names ticked in this catalogue; each is bound to
   * the skill that is usable here — a workspace skill to this folder's list,
   * anything else to the global one.
   *
   * What this catalogue cannot see stays as it was: another folder's list,
   * and a global name whose skill is shadowed or missing here. Otherwise
   * saving in a folder whose own skill shadows a global one would switch the
   * global one off everywhere.
   */
  async function bindSelection({
    workspaceRoot = null,
    selected = [],
    activeSkills = null,
    activeWorkspaceSkills = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    const chosen = new Set(Array.isArray(selected) ? selected : []);
    const usable = skills.filter((skill) => skill.status === SKILL_STATUS.AVAILABLE);
    const isWorkspace = (skill) => skill.source === SKILL_SOURCES.WORKSPACE_AGENTS;
    const decidedHere = new Set(usable.filter((skill) => !isWorkspace(skill)).map((skill) => skill.name));

    const global = resolveActiveNames(skills, activeSkills).filter((name) => !decidedHere.has(name));
    for (const skill of usable) {
      if (!isWorkspace(skill) && chosen.has(skill.name)) global.push(skill.name);
    }

    const perFolder = {};
    if (activeWorkspaceSkills && typeof activeWorkspaceSkills === 'object') {
      for (const [root, names] of Object.entries(activeWorkspaceSkills)) perFolder[root] = names;
    }
    const key = cacheKey(workspaceRoot);
    if (key) {
      const names = usable.filter((skill) => isWorkspace(skill) && chosen.has(skill.name)).map((skill) => skill.name);
      if (names.length > 0) perFolder[key] = names;
      else delete perFolder[key];
    }
    return { activeSkills: [...new Set(global)], activeWorkspaceSkills: perFolder };
  }

  return {
    listCatalog,
    getActiveSkills,
    bindSelection,
    reload,
  };
}

module.exports = {
  createSkillsService,
  MAX_SKILLS_PER_DIRECTORY,
};
