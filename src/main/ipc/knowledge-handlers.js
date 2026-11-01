'use strict';

/**
 * Settings › Knowledge (#1278): what the page shows besides skills and
 * memory — the rules files of both levels with their state and switches, the
 * AGENTS.md files found, the folder's text marked when it showed a covert
 * signal (#1280), the agent's last changes to knowledge files with *Undo*,
 * and the hints of the review for memory and rules entries (#1279) — those
 * dismissed kept in the UI preferences, `dismissedKnowledgeHints`.
 *
 * Nothing here takes a path from the renderer: a file to open is named by
 * its source and name, and resolved against what the listing found.
 */

const { createSettingsError } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const {
  RULE_LEVELS,
  RULE_SOURCES,
  RULE_SOURCE_PATHS,
  RULE_LIMITS,
  isValidRuleName,
  isRuleLevel,
  ruleSwitchKey,
  ruleFileId,
} = require('../../shared/contracts/rules');
const {
  PROJECT_INSTRUCTION_SOURCES,
  PROJECT_INSTRUCTION_SOURCE_PATHS,
} = require('../../shared/contracts/project-instructions');
const { MEMORY_SCOPES, MEMORY_SCOPE_SHORT_PATHS } = require('../../shared/contracts/memory');
const { newRuleFileText } = require('../../shared/contracts/knowledge-write');
const { findCovertSignals } = require('../../application/chat/injection-detector');
const { planRules, applyKnowledgeBudget, ON_DEMAND_REASONS } = require('../../application/chat/rules-prompt');
const { reviewKnowledge } = require('../../application/chat/knowledge-review');
const { createKnowledgeHintActions, HintActionError } = require('../services/knowledge-hint-actions');

/** What a hint's button asks main to do (#1279); *Distil…* (#1316) joins them later. */
const HINT_ACTION_NAMES = new Set(['remove', 'edit', 'moveToRules', 'createSkill', 'merge']);

/**
 * Where a hint's entry or file is, as the page shows paths.
 *
 * @param {any} at
 */
function placeOf(at) {
  if (at.kind === 'memory' || at.kind === 'memoryFile') return MEMORY_SCOPE_SHORT_PATHS[at.scope] || '';
  if (at.kind === 'rule' || at.kind === 'ruleFile') return `${RULE_SOURCE_PATHS[/** @type {import('../../shared/contracts/rules').RuleSource} */ (at.source)]}/${at.name}.md`;
  return '';
}

/** @param {Array<{ kind: string }>|null} signals */
const kindsOf = (signals) => (signals ? [...new Set(signals.map((signal) => signal.kind))] : []);

/**
 * @param {Object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Record<string, string>} deps.REQ
 * @param {any} deps.knowledge  from create-knowledge.js
 * @param {any} deps.memory
 * @param {any} deps.uiPrefsStore
 * @param {() => string|null} deps.getActiveWorkspaceRoot
 * @param {Pick<import('electron').Shell, 'openPath'>|null} [deps.shell]
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string} deps.homeDir
 * @param {() => Date} [deps.now]  the review's clock, for "noted a while ago"
 */
function registerKnowledgeHandlers({ ipcMain, REQ, knowledge, memory, uiPrefsStore, getActiveWorkspaceRoot, shell = null, fs, path, homeDir, now = () => new Date() }) {
  const { rules, projectInstructions, journal } = knowledge;
  const hintActions = createKnowledgeHintActions({ fs, path, homeDir, rules, memory, knowledgeWriter: knowledge.knowledgeWriter, journal });

  async function buildState() {
    const workspaceRoot = getActiveWorkspaceRoot();
    const prefs = await uiPrefsStore.readUIPrefs();
    const listing = await rules.load({ workspaceRoot });
    const switchedOff = new Set(Array.isArray(prefs.disabledRules) ? prefs.disabledRules : []);
    const levelOn = (/** @type {string} */ level) => (level === RULE_LEVELS.WORKSPACE ? prefs.rulesWorkspaceEnabled !== false : prefs.rulesUserEnabled !== false);
    const usable = listing.files.filter((/** @type {any} */ file) => !file.shadowed && levelOn(file.level) && !switchedOff.has(ruleSwitchKey(file, workspaceRoot)));

    const agentsFiles = prefs.projectInstructionsEnabled === false ? [] : await projectInstructions.load({ workspaceRoot });
    const memoryFiles = await memory.load({ workspaceRoot });
    const memoryChars = memoryFiles.reduce((/** @type {number} */ sum, /** @type {any} */ file) => sum + file.text.length, 0);
    // The budgets as a chat with the default context would meet them; the
    // context breakdown of a chat says what its own model left.
    const budgeted = applyKnowledgeBudget({
      plan: planRules(usable),
      files: usable,
      budgetChars: Math.floor((Number(prefs.historyCharLimit) || 200_000) / 4),
      memoryChars,
      agentsMdChars: agentsFiles.reduce((/** @type {number} */ sum, /** @type {any} */ file) => sum + file.text.length, 0),
    });

    const levels = [RULE_LEVELS.WORKSPACE, RULE_LEVELS.USER].map((level) => {
      const sources = level === RULE_LEVELS.WORKSPACE ? [RULE_SOURCES.WORKSPACE] : [RULE_SOURCES.USER_SNOTRA, RULE_SOURCES.USER_AGENTS];
      return {
        level,
        enabled: levelOn(level),
        available: level === RULE_LEVELS.USER || Boolean(workspaceRoot),
        dir: RULE_SOURCE_PATHS[sources[0]],
        files: listing.files.filter((/** @type {any} */ file) => file.level === level).map((/** @type {any} */ file) => {
          const key = ruleSwitchKey(file, workspaceRoot);
          const reason = budgeted.plan.onDemand.get(ruleFileId(file));
          return {
            source: file.source,
            name: file.name,
            path: `${RULE_SOURCE_PATHS[/** @type {import('../../shared/contracts/rules').RuleSource} */ (file.source)]}/${file.name}.md`,
            description: file.description,
            descriptionDerived: file.descriptionDerived,
            always: file.always,
            chars: file.body.length,
            truncated: file.truncated,
            shadowed: file.shadowed === true,
            key,
            on: !switchedOff.has(key),
            overBudget: reason === ON_DEMAND_REASONS.OVER_LEVEL_BUDGET,
            givenWay: reason === ON_DEMAND_REASONS.KNOWLEDGE_BUDGET,
            covert: file.source === RULE_SOURCES.WORKSPACE
              ? kindsOf(findCovertSignals(file.always ? `${file.description}\n${file.body}` : file.description)) : [],
          };
        }),
        inSubfolders: sources.reduce((sum, source) => sum + (listing.inSubfolders?.[source] || 0), 0),
        overLimit: sources.reduce((sum, source) => sum + (listing.overLimit?.[source] || 0), 0),
        invalid: (listing.invalid || []).filter((/** @type {any} */ item) => sources.includes(item.source)).map((/** @type {any} */ item) => item.file),
      };
    });

    // A memory file is known by its level, and the folder's by the folder too,
    // so that a hint dismissed in one project stays in the others.
    const hints = reviewKnowledge({
      memory: memoryFiles.map((/** @type {any} */ file) => ({
        scope: file.scope,
        text: file.text,
        key: file.scope === MEMORY_SCOPES.WORKSPACE ? `memory:${file.scope}:${workspaceRoot || ''}` : `memory:${file.scope}`,
      })),
      rules: listing.files.map((/** @type {any} */ file) => {
        const key = ruleSwitchKey(file, workspaceRoot);
        return {
          level: file.level, source: file.source, name: file.name, body: file.body, always: file.always,
          on: levelOn(file.level) && !switchedOff.has(key), shadowed: file.shadowed === true, truncated: file.truncated === true, key,
        };
      }),
      now: now(),
      dismissed: Array.isArray(prefs.dismissedKnowledgeHints) ? prefs.dismissedKnowledgeHints : [],
    }).map((hint) => ({
      ...hint,
      actions: hintActions.actionsOf(hint),
      where: placeOf(hint.at),
      ...(hint.with ? { withWhere: placeOf(hint.with) } : {}),
    }));

    const workspaceMemory = memoryFiles.find((/** @type {any} */ file) => file.scope === MEMORY_SCOPES.WORKSPACE);
    return {
      workspaceRoot,
      rules: levels,
      agents: {
        enabled: prefs.projectInstructionsEnabled !== false,
        files: agentsFiles.map((/** @type {any} */ file) => ({
          source: file.source,
          path: PROJECT_INSTRUCTION_SOURCE_PATHS[file.source],
          inFolder: file.source === PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
          chars: file.text.length,
          truncated: file.truncated === true,
          givenWay: budgeted.agentsMdRoom !== null,
          covert: file.source === PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS ? kindsOf(findCovertSignals(file.text)) : [],
        })),
      },
      memoryCovert: workspaceMemory ? kindsOf(findCovertSignals(workspaceMemory.text)) : [],
      hints,
      journal: journal ? await journal.list() : [],
    };
  }

  /**
   * The file a request names, as the listing found it — never a path the
   * renderer made up.
   *
   * @param {{ kind?: unknown, source?: unknown, name?: unknown }} request
   */
  async function fileOf({ kind, source, name }) {
    const workspaceRoot = getActiveWorkspaceRoot();
    if (kind === 'rule') {
      if (typeof source !== 'string' || !isValidRuleName(name)) return null;
      const dir = rules.dirOf?.({ workspaceRoot, source });
      return dir ? path.join(dir, `${name}.md`) : null;
    }
    if (kind === 'agents') {
      const found = await projectInstructions.load({ workspaceRoot });
      if (!found.some((/** @type {any} */ file) => file.source === source)) return null;
      const shown = PROJECT_INSTRUCTION_SOURCE_PATHS[/** @type {string} */ (source)];
      if (source === PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS) return workspaceRoot ? path.join(workspaceRoot, 'AGENTS.md') : null;
      return typeof shown === 'string' && shown.startsWith('~/') ? path.join(homeDir, shown.slice(2)) : null;
    }
    return null;
  }

  ipcMain.handle(REQ.KNOWLEDGE_GET_STATE, async () => buildState());

  ipcMain.handle(REQ.KNOWLEDGE_SET_RULE_SWITCH, async (_event, payload) => {
    const level = payload?.level;
    const key = typeof payload?.key === 'string' ? payload.key.slice(0, 1024) : '';
    const enabled = payload?.enabled === true;
    if (!isRuleLevel(level) && !key) return createSettingsError(createMessage('settings.knowledge.error.invalid'));
    await uiPrefsStore.updateUIPrefs((/** @type {any} */ prefs) => {
      if (isRuleLevel(level) && !key) {
        return { ...prefs, [level === RULE_LEVELS.WORKSPACE ? 'rulesWorkspaceEnabled' : 'rulesUserEnabled']: enabled };
      }
      const off = new Set(Array.isArray(prefs.disabledRules) ? prefs.disabledRules : []);
      if (enabled) off.delete(key);
      else off.add(key);
      return { ...prefs, disabledRules: [...off] };
    });
    return { ok: true, state: await buildState() };
  });

  ipcMain.handle(REQ.KNOWLEDGE_OPEN_FILE, async (_event, payload) => {
    const file = await fileOf(payload || {});
    if (!file || !shell) return createSettingsError(createMessage('settings.knowledge.error.open'));
    const failure = await shell.openPath(file);
    return failure ? createSettingsError(failure) : { ok: true };
  });

  ipcMain.handle(REQ.KNOWLEDGE_NEW_RULE_FILE, async (_event, payload) => {
    const level = payload?.level;
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const description = typeof payload?.description === 'string' ? payload.description.trim().slice(0, RULE_LIMITS.DESCRIPTION_CHARS) : '';
    if (!isRuleLevel(level) || !isValidRuleName(name)) return createSettingsError(createMessage('settings.knowledge.error.name'));
    if (!description) return createSettingsError(createMessage('settings.knowledge.error.description'));
    const source = level === RULE_LEVELS.WORKSPACE ? RULE_SOURCES.WORKSPACE : RULE_SOURCES.USER_SNOTRA;
    const dir = rules.dirOf?.({ workspaceRoot: getActiveWorkspaceRoot(), source });
    if (!dir) return createSettingsError(createMessage('settings.knowledge.error.noFolder'));
    const file = path.join(dir, `${name}.md`);
    try {
      await fs.mkdir(dir, { recursive: true });
      // `wx`: an existing file of that name is never written over.
      await fs.writeFile(file, newRuleFileText({ description, always: payload?.always === true, line: '- ' }), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      return createSettingsError(error?.code === 'EEXIST' ? createMessage('settings.knowledge.error.exists') : (error?.message || createMessage('settings.knowledge.error.create')));
    }
    if (shell) await shell.openPath(file);
    return { ok: true, state: await buildState() };
  });

  ipcMain.handle(REQ.KNOWLEDGE_UNDO, async (_event, payload) => {
    const id = typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '';
    if (!journal || !id) return createSettingsError(createMessage('settings.knowledge.error.invalid'));
    const result = await journal.undo(id);
    if (!result.ok) return createSettingsError(createMessage(`settings.knowledge.undo.error.${result.reason || 'gone'}`));
    return { ok: true, state: await buildState() };
  });

  // Only a key the review gives right now is kept — the renderer cannot fill
  // the preferences with anything else.
  ipcMain.handle(REQ.KNOWLEDGE_DISMISS_HINT, async (_event, payload) => {
    const key = typeof payload?.key === 'string' ? payload.key : '';
    const state = await buildState();
    if (!key || !state.hints.some((hint) => hint.dismissible && hint.key === key)) {
      return createSettingsError(createMessage('settings.knowledge.error.invalid'));
    }
    await uiPrefsStore.updateUIPrefs((/** @type {any} */ prefs) => ({
      ...prefs,
      dismissedKnowledgeHints: [...(Array.isArray(prefs.dismissedKnowledgeHints) ? prefs.dismissedKnowledgeHints : []).filter((/** @type {string} */ known) => known !== key), key],
    }));
    return { ok: true, state: await buildState() };
  });

  // A hint's action names the hint, never a file, a line or a text: main finds
  // the hint in its own review and acts on what that points at.
  ipcMain.handle(REQ.KNOWLEDGE_HINT_ACTION, async (_event, payload) => {
    const ref = typeof payload?.ref === 'string' ? payload.ref : '';
    const action = typeof payload?.action === 'string' ? payload.action : '';
    const choice = payload?.choice && typeof payload.choice === 'object' ? payload.choice : {};
    const workspaceRoot = getActiveWorkspaceRoot();
    const hint = HINT_ACTION_NAMES.has(action) ? (await buildState()).hints.find((item) => item.ref === ref) : null;
    if (!hint || !hint.actions.includes(action)) return createSettingsError(createMessage('settings.knowledge.error.invalid'));
    try {
      if (action === 'edit') {
        if (!shell) return createSettingsError(createMessage('settings.knowledge.error.open'));
        const failure = await shell.openPath(hintActions.fileOf(hint, workspaceRoot));
        return failure ? createSettingsError(failure) : { ok: true };
      }
      const done = await hintActions[/** @type {'remove'|'moveToRules'|'createSkill'|'merge'} */ (action)](hint, choice, workspaceRoot);
      return { ok: true, done: { action, ...(done || {}) }, state: await buildState() };
    } catch (error) {
      if (error instanceof HintActionError) return createSettingsError(createMessage(error.key, error.params));
      return createSettingsError(createMessage('settings.knowledge.hint.error.write', { reason: error?.message || '' }));
    }
  });

  return { buildState };
}

module.exports = { registerKnowledgeHandlers };
