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

const { checkSkillDocument } = require('../../shared/runtime/skill-frontmatter');
const { fillUiQuotes } = require('../../shared/i18n/ui-quotes');
const { createMessage } = require('../../shared/contracts/message');
const {
  SKILL_SOURCES,
  SKILL_STATUS,
  MAX_SKILL_BODY_CHARS,
  WORKSPACE_SKILLS_DIR,
  isValidSkillName,
} = require('../../shared/contracts/skills');
const { renameWithRetry } = require('./rename-with-retry');
const {
  switchedOn,
  selectActiveSkills,
  bindSkillSelection,
  workspaceActiveNames,
  switchOnGlobally,
} = require('../../application/skills/skill-selection');

/** @typedef {import('../../application/skills/skill-selection').ScannedSkill} ScannedSkill */

/**
 * Which skills are switched on: the global list and, per folder, that
 * folder's own (#576).
 *
 * @typedef {Object} SkillSwitches
 * @property {string|null} [workspaceRoot]
 * @property {string[]|null} [activeSkills]  `null` means the default set
 * @property {Record<string, string[]>|null} [activeWorkspaceSkills]
 */

/**
 * Why `planMakeGlobal` or `makeGlobal` refuses; the caller words it.
 *
 * @typedef {{ error: 'not-found'|'no-workspace'|'no-home' }} MakeGlobalRefusal
 *
 * What making a skill global would do (#764).
 * @typedef {{ error?: undefined, name: string, from: string, to: string, conflict: boolean }} MakeGlobalPlan
 */

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
 *
 * @param {ScannedSkill} skill
 * @param {string|null|undefined} locale
 */
function withMenuPaths(skill, locale) {
  if (skill.source !== SKILL_SOURCES.SYSTEM) return skill;
  return {
    ...skill,
    description: fillUiQuotes(locale ?? '', skill.description),
    body: fillUiQuotes(locale ?? '', skill.body),
  };
}

/**
 * The system skills ship as a folder in the app bundle, readable inside
 * app.asar as well. Without an app that knows its path — a test — there are
 * none.
 *
 * @param {{ appPath?: string | null, path: typeof import('path') }} deps  `appPath` is where the app is installed
 * @returns {string|null}
 */
function bundledSystemSkillsDir({ appPath, path }) {
  return appPath ? path.join(appPath, 'system-skills') : null;
}

/**
 * @param {{
 *   fs: typeof import('fs/promises'),
 *   path: typeof import('path'),
 *   os?: typeof import('os'),
 *   systemSkillsDir?: string|null,
 *   maxSkillBodyChars?: number,
 * }} deps
 */
function createSkillsService({ fs, path, os, systemSkillsDir = null, maxSkillBodyChars = MAX_SKILL_BODY_CHARS }) {
  if (!fs || !path) throw new TypeError('createSkillsService benötigt fs und path.');

  /** @type {Map<string, Promise<{ skills: ScannedSkill[] }>>} */
  const scanCache = new Map();

  function homeDir() {
    try {
      return os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {unknown} workspaceRoot
   */
  function sourceDirectories(workspaceRoot) {
    /** @type {Array<{ source: ScannedSkill['source'], dir: string }>} */
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

  /**
   * @param {ScannedSkill['source']} source
   * @param {string} dir
   * @returns {Promise<ScannedSkill[]>}
   */
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
    /** @type {ScannedSkill[]} */
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

  /**
   * @param {ScannedSkill['source']} source
   * @param {string} name
   * @param {string} skillDir
   * @param {ScannedSkill['detail']} detail
   * @returns {ScannedSkill}
   */
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

  /**
   * @param {ScannedSkill['source']} source
   * @param {string} dirName
   * @param {string} skillDir
   * @returns {Promise<ScannedSkill>}
   */
  async function readSkillFolder(source, dirName, skillDir) {
    const filePath = path.join(skillDir, SKILL_FILE);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return invalidSkill(source, dirName, skillDir, createMessage('skills.invalid.missingFile', { file: SKILL_FILE }));
    }

    const checked = checkSkillDocument(raw, dirName);
    if (!checked.ok) return invalidSkill(source, dirName, skillDir, createMessage(checked.key, checked.params));
    const { name, description } = checked;

    const body = checked.body.length > maxSkillBodyChars ? checked.body.slice(0, maxSkillBodyChars) : checked.body;
    return {
      name,
      description,
      source,
      status: SKILL_STATUS.AVAILABLE,
      path: skillDir,
      detail: '',
      body,
      truncated: checked.body.length > maxSkillBodyChars,
    };
  }

  /**
   * @param {unknown} workspaceRoot
   * @returns {Promise<{ skills: ScannedSkill[] }>}
   */
  async function scanAll(workspaceRoot) {
    /** @type {ScannedSkill[]} */
    const collected = [];
    for (const { source, dir } of sourceDirectories(workspaceRoot)) {
      collected.push(...(await readSkillDirectory(source, dir)));
    }

    // Erster Treffer eines Namens gewinnt; die Quellen kommen bereits in
    // Prioritätsreihenfolge. Ungültige Einträge verdrängen nichts.
    /** @type {Map<string, ScannedSkill>} */
    const winners = new Map();
    for (const skill of collected) {
      if (skill.status === SKILL_STATUS.INVALID) continue;
      if (!winners.has(skill.name)) winners.set(skill.name, skill);
    }
    for (const skill of collected) {
      if (skill.status === SKILL_STATUS.INVALID) continue;
      const winner = winners.get(skill.name);
      if (winner && winner !== skill) {
        skill.status = SKILL_STATUS.SHADOWED;
        skill.detail = createMessage('skills.shadowedBy', { path: winner.path });
      }
    }

    return { skills: collected };
  }

  /**
   * @param {unknown} workspaceRoot
   */
  function cacheKey(workspaceRoot) {
    return typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : '';
  }

  /**
   * @param {unknown} workspaceRoot
   * @returns {Promise<{ skills: ScannedSkill[] }>}
   */
  function scan(workspaceRoot) {
    const key = cacheKey(workspaceRoot);
    let scanned = scanCache.get(key);
    if (!scanned) {
      scanned = scanAll(workspaceRoot);
      scanCache.set(key, scanned);
    }
    return scanned;
  }

  /** Cache verwerfen — für „Skills neu laden“ in den Einstellungen. */
  function reload() {
    scanCache.clear();
  }

  /**
   * @param {SkillSwitches & { locale?: string|null }} [options]
   * @returns {Promise<{ skills: Array<Omit<import('../../shared/contracts/skills').SkillSummary, 'builtin'>> }>}
   */
  async function listCatalog({
    workspaceRoot = null,
    activeSkills = null,
    activeWorkspaceSkills = null,
    locale = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    const isOn = switchedOn(skills, { workspaceKey: cacheKey(workspaceRoot), activeSkills, activeWorkspaceSkills });
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
   *
   * @param {SkillSwitches & { invokedSkills?: string[]|null, locale?: string|null }} [options]
   */
  async function getActiveSkills({
    workspaceRoot = null,
    activeSkills = null,
    activeWorkspaceSkills = null,
    invokedSkills = null,
    locale = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    const selected = selectActiveSkills(skills, {
      workspaceKey: cacheKey(workspaceRoot), activeSkills, activeWorkspaceSkills, invokedSkills,
    });
    return selected.map(({ skill: raw, invoked }) => {
      const skill = withMenuPaths(raw, locale);
      return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
        body: skill.body,
        /** Kam dieser Skill per `/name` dazu statt über die Einstellungen? */
        invoked,
      };
    });
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
   *
   * @param {SkillSwitches & { selected?: string[] }} [options]
   */
  async function bindSelection({
    workspaceRoot = null,
    selected = [],
    activeSkills = null,
    activeWorkspaceSkills = null,
  } = {}) {
    const { skills } = await scan(workspaceRoot);
    return bindSkillSelection(skills, { workspaceKey: cacheKey(workspaceRoot), selected, activeSkills, activeWorkspaceSkills });
  }

  /** Where a skill made global goes (#764): Snotra's own folder, never the old location. */
  function globalSkillsDir() {
    const home = homeDir();
    return home ? path.join(home, '.snotra', 'skills') : null;
  }

  /**
   * @param {string} target
   */
  async function pathExists(target) {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * What making a workspace skill global would do (#764): the folder it comes
   * from, the folder it goes to, and whether that name is taken there. Only a
   * usable skill of the open folder qualifies — the name comes from the
   * renderer and is looked up in the catalogue, never joined into a path
   * unchecked. `error` is a reason code; the caller words it.
   *
   * @param {{ workspaceRoot?: string|null, name?: string }} [request]
   * @returns {Promise<MakeGlobalRefusal | MakeGlobalPlan>}
   */
  async function planMakeGlobal({ workspaceRoot = null, name } = {}) {
    if (typeof name !== 'string' || !isValidSkillName(name)) return { error: 'not-found' };
    const key = cacheKey(workspaceRoot);
    if (!key) return { error: 'no-workspace' };
    const { skills } = await scan(workspaceRoot);
    const skill = skills.find((entry) => entry.source === SKILL_SOURCES.WORKSPACE_AGENTS && entry.name === name);
    if (!skill || skill.status === SKILL_STATUS.INVALID) return { error: 'not-found' };
    const target = globalSkillsDir();
    if (!target) return { error: 'no-home' };
    const from = path.join(key, ...WORKSPACE_SKILLS_DIR.split('/'), name);
    const to = path.join(target, name);
    return { name, from, to, conflict: await pathExists(to) };
  }

  /**
   * Moves a workspace skill to `~/.snotra/skills/<name>/` (#764). A name that
   * is taken there is refused, never overwritten. Across volumes `rename`
   * fails with EXDEV; then the folder is copied and the original removed.
   *
   * @param {{ workspaceRoot?: string|null, name?: string }} [request]
   * @returns {Promise<MakeGlobalRefusal | { error: 'conflict', from: string, to: string }
   *   | { error?: undefined, ok: true, from: string, to: string }>}
   */
  async function makeGlobal({ workspaceRoot = null, name } = {}) {
    const plan = await planMakeGlobal({ workspaceRoot, name });
    if (plan.error) return plan;
    if (plan.conflict) return { error: 'conflict', from: plan.from, to: plan.to };
    await fs.mkdir(path.dirname(plan.to), { recursive: true });
    // Checked again right before the move: the dialog may have stood open a while.
    if (await pathExists(plan.to)) return { error: 'conflict', from: plan.from, to: plan.to };
    try {
      await renameWithRetry(fs, plan.from, plan.to);
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
      await fs.cp(plan.from, plan.to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await fs.rm(plan.from, { recursive: true, force: true });
    }
    reload();
    return { ok: true, from: plan.from, to: plan.to };
  }

  /**
   * The switch-on of a skill that left the open folder (#764). A workspace
   * skill is switched on per folder (#576); once global, its switch is the
   * global list. A skill that was on here stays on — now everywhere, which is
   * what making it global asks for. One that was off stays off. `null` when
   * nothing changes.
   *
   * @param {SkillSwitches & { name?: string }} [options]
   */
  async function switchOnAfterMakeGlobal({
    workspaceRoot = null,
    name,
    activeSkills = null,
    activeWorkspaceSkills = null,
  } = {}) {
    const workspaceKey = cacheKey(workspaceRoot);
    // Nothing to move: no scan needed.
    if (!workspaceKey || !workspaceActiveNames(workspaceKey, activeWorkspaceSkills).includes(name)) return null;
    const { skills } = await scan(workspaceRoot);
    return switchOnGlobally(skills, { workspaceKey, name, activeSkills, activeWorkspaceSkills });
  }

  return {
    listCatalog,
    getActiveSkills,
    bindSelection,
    reload,
    planMakeGlobal,
    makeGlobal,
    switchOnAfterMakeGlobal,
  };
}

module.exports = {
  bundledSystemSkillsDir,
  createSkillsService,
  MAX_SKILLS_PER_DIRECTORY,
};
