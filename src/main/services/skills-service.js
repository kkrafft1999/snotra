'use strict';

/**
 * Skill-Discovery und -Parsing (Issue #18).
 *
 * Sammelt Skills aus fünf Quellen — den eingebauten System-Skills der App und
 * je zwei Verzeichnissen im Workspace und im Home-Verzeichnis — und liefert
 * einen Katalog für die Einstellungen sowie die Bodies der eingeschalteten
 * Skills für den Systemprompt.
 *
 * Bewusst kein Datei-Watcher: gescannt wird beim ersten Zugriff je Workspace
 * und danach nur noch auf Anforderung („Skills neu laden“).
 */

const { parseSkillDocument } = require('../../shared/runtime/skill-frontmatter');
const {
  SKILL_SOURCES,
  SKILL_STATUS,
  MAX_SKILL_BODY_CHARS,
  isValidSkillName,
} = require('../../shared/contracts/skills');

const SKILL_FILE = 'SKILL.md';
/** Schutz vor versehentlich riesigen Verzeichnissen. */
const MAX_SKILLS_PER_DIRECTORY = 200;

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
      dirs.push({ source: SKILL_SOURCES.WORKSPACE_CLAUDE, dir: path.join(root, '.claude', 'skills') });
    }
    const home = homeDir();
    if (home) {
      dirs.push({ source: SKILL_SOURCES.USER_AGENTS, dir: path.join(home, '.agents', 'skills') });
      dirs.push({ source: SKILL_SOURCES.USER_CLAUDE, dir: path.join(home, '.claude', 'skills') });
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

    const found = [];
    for (const entry of entries.slice(0, MAX_SKILLS_PER_DIRECTORY)) {
      const dirName = entry.name;
      if (dirName.startsWith('.')) continue;
      const skillDir = path.join(dir, dirName);
      if (!entry.isDirectory()) {
        // Häufiger Praxisfall: ein heruntergeladenes `foo.zip` liegt daneben.
        found.push(invalidSkill(source, dirName, skillDir, 'Kein Verzeichnis'));
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
      return invalidSkill(source, dirName, skillDir, `${SKILL_FILE} fehlt`);
    }

    const parsed = parseSkillDocument(raw);
    if (!parsed) {
      return invalidSkill(source, dirName, skillDir, 'Kein YAML-Frontmatter');
    }

    const name = typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const description =
      typeof parsed.frontmatter.description === 'string' ? parsed.frontmatter.description.trim() : '';

    if (!name) return invalidSkill(source, dirName, skillDir, 'Frontmatter ohne name');
    if (!description) return invalidSkill(source, dirName, skillDir, 'Frontmatter ohne description');
    if (!isValidSkillName(name)) return invalidSkill(source, dirName, skillDir, `Ungültiger name: „${name}“`);
    if (name !== dirName) {
      return invalidSkill(source, dirName, skillDir, `name „${name}“ ≠ Verzeichnis „${dirName}“`);
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
        skill.detail = `Überdeckt von ${winner.path}`;
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

  async function listCatalog({ workspaceRoot = null, activeSkills = null } = {}) {
    const { skills } = await scan(workspaceRoot);
    const active = new Set(resolveActiveNames(skills, activeSkills));
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        status:
          skill.status === SKILL_STATUS.AVAILABLE && active.has(skill.name)
            ? SKILL_STATUS.ACTIVE
            : skill.status,
        path: skill.path,
        detail: skill.detail,
      })),
    };
  }

  /** Bodies der eingeschalteten Skills — Reihenfolge = Quellpriorität. */
  async function getActiveSkills({ workspaceRoot = null, activeSkills = null } = {}) {
    const { skills } = await scan(workspaceRoot);
    const active = new Set(resolveActiveNames(skills, activeSkills));
    return skills
      .filter((skill) => skill.status === SKILL_STATUS.AVAILABLE && active.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
        body: skill.body,
      }));
  }

  return {
    listCatalog,
    getActiveSkills,
    reload,
  };
}

module.exports = {
  createSkillsService,
  MAX_SKILLS_PER_DIRECTORY,
};
