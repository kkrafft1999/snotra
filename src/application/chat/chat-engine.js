'use strict';

const { isAbortError, createChatAbortError } = require('../../shared/runtime/abort');
const { extractStringFromPartialJson } = require('../../shared/runtime/partial-json');
const { mergeUsage, normalizeUsage } = require('../../shared/contracts/usage');
const {
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  APP_LOCALES,
  PERMISSION_PROGRESS_EVENTS,
  createChatResult,
  createCancelledChatResult,
  createChatErrorResult,
  createDeltaEvent,
  createToolLineEvent,
  createPhaseEvent,
  createReasoningEvent,
  createPermissionProgressEvent,
  sanitizeChatTitle,
} = require('../../shared/contracts');
const {
  TOOL_RISK_CLASSES,
  POLICY_DECISIONS,
  APPROVAL_RESPONSES,
  PERMISSION_DECISION_SOURCES,
  PERMISSION_DENIAL_REASONS,
  PERMISSION_DENIED_MESSAGES,
  TOOL_EXECUTION_STATUSES,
  TOOL_RESULTS_ARE_DATA_RULE,
  DEFAULT_TOOL_PERMISSION_MODE,
  normalizeToolPermissionMode,
  normalizeRiskClasses,
  createPermissionDeniedToolResult,
  createPermissionAuditEntry,
} = require('../../shared/contracts/tool-permissions');
const {
  resolveHistoryCharLimit,
  trimHistoryMessages,
  truncateStaleToolOutputs,
} = require('./chat-history-trim');
const { decideToolPolicy } = require('../permissions/tool-policy');
const { createSessionGrants } = require('../permissions/session-grants');
const { buildApprovalRequest } = require('../permissions/approval-request');
const {
  createSensitiveMarker,
  redactSensitiveToolMessages,
  stripSensitiveMarkers,
} = require('../permissions/sensitive-redaction');

/* ── Konversationstitel ──────────────────────────────────────────────────────
 * Nach dem ersten Austausch benennt das Modell die Konversation selbst. Der
 * Aufruf ist bewusst klein gehalten: nur die erste Frage und der Anfang der
 * ersten Antwort, keine Tools, kein Verlauf, harte Zeitgrenze. Schlaegt er
 * fehl, bleibt der aus der Frage abgeleitete Titel stehen. */
const TITLE_INPUT_CHAR_LIMIT = 1200;
const TITLE_TIMEOUT_MS = 20000;
const TITLE_SYSTEM_PROMPT = [
  'Du benennst Konversationen.',
  'Gib eine knappe Ueberschrift aus, die Thema und Absicht des Gespraechs trifft.',
  'Drei bis sechs Woerter. Dieselbe Sprache wie das Gespraech.',
  'Keine Anfuehrungszeichen, kein Satzzeichen am Ende, keine Einleitung.',
  'Antworte ausschliesslich mit der Ueberschrift.',
].join(' ');

const CHAT_ENGINE_EVENTS = Object.freeze({
  DELTA: 'delta',
  PROGRESS: 'progress',
  TOOL_LINE: 'tool-line',
});

/** Wie oft ein Aufruf nach geändertem Plan neu bewertet wird, bevor er verfällt. */
const MAX_PLAN_ATTEMPTS = 3;

function resolveAppLocale(uiPrefs) {
  return uiPrefs?.appLocale === APP_LOCALES.EN ? APP_LOCALES.EN : APP_LOCALES.DE;
}

function resolveToolRoundLimit(uiPrefs, mainDefault) {
  const MIN = 1;
  const MAX_CAP = 500;
  let value =
    typeof uiPrefs?.maxToolRounds === 'number' && Number.isFinite(uiPrefs.maxToolRounds)
      ? Math.round(uiPrefs.maxToolRounds)
      : mainDefault;
  if (!Number.isFinite(value)) value = mainDefault;
  return Math.min(MAX_CAP, Math.max(MIN, value));
}

/**
 * Sachkontext zum geöffneten Ordner: welcher Ordner offen ist, welche Tools
 * bereitstehen und was im Baum ausgewählt ist. Bewusst ohne Ton- oder
 * Sprachvorgaben — die bleiben dem Prompt des Nutzers überlassen. Die
 * Prompt-Injection-Regel (Konzept §5) hängt an den Tools, nicht am Prompt des
 * Nutzers, und lässt sich dort nicht abschalten.
 */
function buildWorkspaceSystemPrompt({ folderName, toolsPrompt, selectedRelPath, selectedIsDirectory }) {
  const parts = [`Du arbeitest im in der App geöffneten Ordner „${folderName}“.`];
  if (toolsPrompt) parts.push(toolsPrompt);
  // @-Referenzen aus der Chat-Eingabe (Issue #52): nur die Konvention erklären,
  // Inhalte werden bewusst nicht automatisch eingebettet (Token-Ziel).
  const mentionHint =
    'Referenzen der Form „@<Pfad>“ (z. B. „@docs/roadmap.md“) bezeichnen eine Datei oder ' +
    'einen Ordner mit diesem Pfad relativ zur Ordnerwurzel.';
  parts.push(
    toolsPrompt
      ? `${mentionHint} Ihr Inhalt wird nicht automatisch mitgeschickt — lies ihn bei Bedarf mit den Lese-Tools.`
      : mentionHint
  );
  if (selectedRelPath) {
    const kind = selectedIsDirectory ? 'folgenden Ordner' : 'folgende Datei';
    parts.push(
      `Der Nutzer hat gerade ${kind} im Baum ausgewählt: „${selectedRelPath}“. ` +
        `Beziehe dich bei Fragen ohne expliziten Pfad auf diese Auswahl.`
    );
  }
  if (toolsPrompt) parts.push(TOOL_RESULTS_ARE_DATA_RULE);
  return parts.join('\n\n');
}

function parseToolArguments(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Anweisungsteil der eingeschalteten Skills (Issue #18). Steht hinter dem
 * Prompt des Nutzers, aber vor dem Ordnerkontext: Skills beschreiben, *wie*
 * gearbeitet wird, der Ordnerkontext nur, *woran*.
 */
function buildSkillsSystemPrompt(activeSkills, { toolsAvailable = false } = {}) {
  if (!Array.isArray(activeSkills) || activeSkills.length === 0) return '';
  const usable = activeSkills.filter(
    (skill) => skill && typeof skill.body === 'string' && skill.body.trim()
  );
  if (usable.length === 0) return '';
  const sections = usable.map((skill) => `## Skill: ${skill.name}\n\n${skill.body.trim()}`);
  const intro = [
    'Folgende Skills sind eingeschaltet. Ihre Anweisungen gelten für diese ' +
      'Unterhaltung zusätzlich zu allem Übrigen in diesem Prompt.',
  ];
  // Ein Skill besteht oft aus mehr als der SKILL.md — verweist sie auf
  // references/ oder assets/, muss das Modell wissen, wie es dorthin kommt
  // (Issue #61). Ohne offenen Ordner gibt es keine Tools, dann bleibt der
  // Hinweis weg.
  if (toolsAvailable) {
    const names = usable.map((skill) => skill.name).join(', ');
    intro.push(
      `Verweist ein Skill auf Dateien neben seiner SKILL.md (z. B. „references/…“ oder ` +
        `„assets/…“), liest du sie mit den Lese-Tools über den Pfad ` +
        `„skill:<name>/<pfad>“, etwa „skill:${usable[0].name}/references/anleitung.md“. ` +
        `Eingeschaltet sind: ${names}. Geschrieben wird dort nicht — Schreib-Tools ` +
        `gelten weiterhin nur für den Arbeitsordner.`
    );
  }
  return [...intro, ...sections].join('\n\n');
}

/** Provider-Endpunkt als Bindungsschlüssel sensibler Freigaben (Konzept §4). */
function buildProviderKey(target, sendBundle) {
  const providerId = typeof target?.providerId === 'string' ? target.providerId : '';
  const baseUrl = typeof sendBundle?.config?.baseUrl === 'string' ? sendBundle.config.baseUrl.trim() : '';
  return baseUrl ? `${providerId}|${baseUrl}` : providerId;
}

function buildProviderLabel(target, sendBundle) {
  const providerId = typeof target?.providerId === 'string' ? target.providerId : 'Provider';
  const baseUrl = typeof sendBundle?.config?.baseUrl === 'string' ? sendBundle.config.baseUrl.trim() : '';
  if (!baseUrl) return providerId;
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return host ? `${providerId} (${host})` : providerId;
}

function sanitizeChatId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

/** Fail-safe-Stand, wenn kein Policy-Port angebunden ist: smart, keine Regeln. */
function defaultPolicySnapshot() {
  return {
    mode: DEFAULT_TOOL_PERMISSION_MODE,
    rules: [],
    sensitivePathPatterns: [],
    policyVersion: 'default',
  };
}

function createChatEngine({
  llm,
  tools,
  preferences,
  workspacePaths,
  skills = null,
  toolPolicy = null,
  approvals = null,
  sessionGrants = createSessionGrants(),
  maxToolRounds,
  clock = () => Date.now(),
}) {
  /** @type {Map<string | number, AbortController>} */
  const activeChatAborts = new Map();

  function emit(onEvent, type, payload) {
    onEvent?.({ type, payload });
  }

  function emitPhase(onEvent, phase) {
    emit(onEvent, CHAT_ENGINE_EVENTS.PROGRESS, createPhaseEvent(phase));
  }

  function returnCancelledChat(onEvent, toolTrace, content = '', usage = null, contextUsage = null) {
    emitPhase(onEvent, CHAT_PHASES.IDLE);
    return createCancelledChatResult({ content, toolTrace, usage, contextUsage });
  }

  // Argumente, die in der Tool-Zeile erscheinen (Pfad, Suchbegriff, Muster).
  const PENDING_LABEL_ARGUMENT_KEYS = ['relative_path', 'query', 'pattern'];
  // Nur der Anfang der Argumente wird nach Label-Werten durchsucht — der
  // Dateiinhalt von write_file_text kann bis zu 2 MB groß werden.
  const PENDING_ARGUMENT_SCAN_LIMIT = 8192;

  /**
   * Stream-Callbacks für den LLM-Port. Neben Text/Reasoning melden die Provider
   * hier auch Tool-Aufrufe, die das Modell gerade streamt; daraus entsteht die
   * vorläufige Tool-Zeile (Phase 'pending'), noch bevor das Tool ausgeführt wird.
   */
  function makeStreamCallbacks(onEvent, { onToolCallPending } = {}) {
    let started = false;
    /** Gerade gestreamte Tool-Aufrufe: Provider-Index → Zwischenstand. */
    let pendingCalls = new Map();
    const markGenerating = () => {
      if (started) return;
      started = true;
      emitPhase(onEvent, CHAT_PHASES.GENERATING);
    };
    const notifyPending = (pending) => {
      if (typeof onToolCallPending === 'function') onToolCallPending(pending);
    };
    return {
      reset() {
        started = false;
        pendingCalls = new Map();
      },
      onMarkGenerating: markGenerating,
      onTextDelta(text) {
        if (!text) return;
        markGenerating();
        emit(onEvent, CHAT_ENGINE_EVENTS.DELTA, createDeltaEvent(text));
      },
      onReasoningDelta(text) {
        if (!text) return;
        markGenerating();
        emit(onEvent, CHAT_ENGINE_EVENTS.PROGRESS, createReasoningEvent(text));
      },
      onToolCallStart({ index, name, args } = {}) {
        markGenerating();
        const key = index ?? pendingCalls.size;
        if (pendingCalls.has(key)) return;
        const complete = !!args && typeof args === 'object';
        const pending = {
          callIndex: pendingCalls.size,
          tool: typeof name === 'string' && name ? name : 'tool',
          args: complete ? { ...args } : {},
          partialArguments: '',
          labelResolved: complete,
        };
        pendingCalls.set(key, pending);
        notifyPending(pending);
      },
      onToolCallArgumentsDelta({ index, delta } = {}) {
        if (typeof delta !== 'string' || !delta) return;
        markGenerating();
        const pending = pendingCalls.get(index);
        if (!pending || pending.labelResolved) return;
        pending.partialArguments += delta;
        let changed = false;
        for (const key of PENDING_LABEL_ARGUMENT_KEYS) {
          const value = extractStringFromPartialJson(pending.partialArguments, key);
          if (value === null) continue;
          pending.args[key] = value;
          changed = true;
        }
        if (changed || pending.partialArguments.length > PENDING_ARGUMENT_SCAN_LIMIT) {
          pending.labelResolved = true;
        }
        if (changed) notifyPending(pending);
      },
    };
  }

  async function resolveTarget(forSend) {
    const target = await llm.resolveChatTarget();
    if (target.error) return { error: target };
    const validation = await llm.validateTarget(target, { forSend });
    if (validation) return { error: validation };
    return { target };
  }

  async function readPolicySnapshot() {
    if (!toolPolicy || typeof toolPolicy.read !== 'function') return defaultPolicySnapshot();
    try {
      const snapshot = await toolPolicy.read();
      return {
        mode: normalizeToolPermissionMode(snapshot?.mode),
        rules: Array.isArray(snapshot?.rules) ? snapshot.rules : [],
        sensitivePathPatterns: Array.isArray(snapshot?.sensitivePathPatterns)
          ? snapshot.sensitivePathPatterns
          : [],
        policyVersion: typeof snapshot?.policyVersion === 'string' ? snapshot.policyVersion : 'unknown',
        integrity: snapshot?.integrity,
      };
    } catch {
      // Fehlerhafte Sicherheitsregeln blockieren Tools, statt Sperren zu
      // verlieren (Konzept §3): ohne lesbaren Stand gibt es keine Erlaubnis.
      return { ...defaultPolicySnapshot(), policyVersion: 'unreadable', unreadable: true };
    }
  }

  function abort(sessionId) {
    const controller = activeChatAborts.get(sessionId);
    if (controller && !controller.signal.aborted) controller.abort(createChatAbortError());
  }

  async function send({ sessionId, payload, onEvent }) {
    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    const previous = activeChatAborts.get(sessionId);
    if (previous && previous !== abortController && !previous.signal.aborted) {
      previous.abort(createChatAbortError());
    }
    activeChatAborts.set(sessionId, abortController);

    const toolTrace = [];
    // requestUsage: Summe ueber alle Runden (Verbrauch dieses Zugs).
    // contextUsage: Usage der letzten Runde — deren prompt ist die Groesse des
    // Kontextfensters, das zuletzt an das Modell ging (Anzeige im Composer).
    let requestUsage = null;
    let contextUsage = null;

    try {
      const messages = payload?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return createChatErrorResult({ error: 'Keine Nachrichten übergeben.', code: CHAT_ERROR_CODES.INVALID });
      }

      const resolved = await resolveTarget(true);
      if (resolved.error) return resolved.error;
      const { target } = resolved;
      const sendBundle = await llm.prepareSendBundle(target);
      const providerKey = buildProviderKey(target, sendBundle);
      const providerLabel = buildProviderLabel(target, sendBundle);
      const chatId = sanitizeChatId(payload?.chatId);

      const workspaceRoot = workspacePaths.resolveRoot(payload?.workspaceRoot);
      const selection = workspaceRoot
        ? workspacePaths.resolveSelection(
            workspaceRoot,
            payload?.selectedPath,
            payload?.selectedIsDirectory
          )
        : null;

      const uiPrefs = await preferences.read();
      const appLocale = resolveAppLocale(uiPrefs);
      const systemPrompt = typeof uiPrefs.baseSystemPrompt === 'string' ? uiPrefs.baseSystemPrompt.trim() : '';
      const disabledNames = Array.isArray(uiPrefs.disabledTools) ? uiPrefs.disabledTools : [];
      // Deaktivierte Tools bleiben unsichtbar und gesperrt; der Modus allein
      // versteckt keine Tools (Konzept §8) — pro Aufruf entscheidet die Policy.
      const toolOptions = { disabledNames };
      // Ohne diesen Kontext sieht das Modell nur die rohen Tool-Schemas und weiß
      // nicht, dass überhaupt ein Ordner offen ist — es antwortet dann gern, es
      // könne keine Dateien lesen oder schreiben.
      const workspaceSystem = workspaceRoot
        ? buildWorkspaceSystemPrompt({
            folderName: workspacePaths.basename(workspaceRoot),
            toolsPrompt: tools.buildSystemPrompt(toolOptions),
            selectedRelPath: selection?.relativePath || null,
            selectedIsDirectory: selection?.isDirectory === true,
          })
        : '';
      // Skills gelten unabhängig davon, ob ein Ordner offen ist — die
      // System-Skills beschreiben die App selbst.
      let skillsSystem = '';
      // Verzeichnisse der eingeschalteten Skills sind zusätzliche Lesewurzeln
      // für die Lese-Tools (Issue #61); Schreib-Tools sehen sie nie.
      let skillRoots = [];
      if (skills) {
        try {
          const active = await skills.getActiveSkills({
            workspaceRoot,
            activeSkills: Array.isArray(uiPrefs.activeSkills) ? uiPrefs.activeSkills : null,
          });
          skillsSystem = buildSkillsSystemPrompt(active, { toolsAvailable: Boolean(workspaceRoot) });
          skillRoots = active
            .filter((skill) => skill && skill.name && typeof skill.path === 'string' && skill.path)
            .map((skill) => ({ name: skill.name, dir: skill.path }));
        } catch {
          // Ein kaputtes Skill-Verzeichnis darf den Chat nicht blockieren.
          skillsSystem = '';
          skillRoots = [];
        }
      }
      const skillSignature = skillRoots.map((entry) => entry.name).sort().join(',');

      // Der Prompt des Nutzers steht vorn und behält damit den Vorrang.
      const combinedSystem = [systemPrompt, skillsSystem, workspaceSystem]
        .filter((part) => typeof part === 'string' && part.trim())
        .join('\n\n');

      const apiMessages = [];
      if (combinedSystem) apiMessages.push({ role: 'system', content: combinedSystem });
      const historyCharLimit = resolveHistoryCharLimit(uiPrefs);
      const historyRows = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content ?? '' }));
      // Die App-Begrüßung steht als Assistant-Nachricht am Chat-Anfang; einige
      // Provider (Anthropic, Google) verlangen, dass die Konversation mit einer
      // User-Nachricht beginnt.
      while (historyRows.length > 0 && historyRows[0].role !== 'user') {
        historyRows.shift();
      }
      const { messages: windowedHistory } = trimHistoryMessages(historyRows, historyCharLimit);
      apiMessages.push(...windowedHistory);

      const toolDefs = workspaceRoot ? tools.getTools(toolOptions) : undefined;
      const toolRoundLimit = resolveToolRoundLimit(uiPrefs, maxToolRounds);
      const emitToolLine = (phase, entry, extra = {}) => {
        const line = tools.formatDisplayLine(entry, phase, appLocale);
        entry.line = line;
        emit(onEvent, CHAT_ENGINE_EVENTS.TOOL_LINE, createToolLineEvent(phase, { ...entry, ...extra, line }));
      };
      // Tool-Zeile schon, während das Modell den Aufruf streamt: Beim Schreiben
      // einer Datei entsteht der Inhalt im Stream, die Ausführung selbst dauert
      // nur Millisekunden — ohne diese Phase sähe man nur das fertige Ergebnis.
      const callbacks = makeStreamCallbacks(onEvent, {
        onToolCallPending(pending) {
          const entry = tools.buildTraceEntry(
            pending.tool,
            { ...pending.args },
            workspaceRoot ? undefined : { noWorkspace: true }
          );
          emitToolLine(TOOL_LINE_PHASES.PENDING, entry, { callIndex: pending.callIndex });
        },
      });
      const emitProgressPayloads = (progressEvents) => {
        if (!Array.isArray(progressEvents)) return;
        for (const payload of progressEvents) {
          if (payload && typeof payload === 'object') {
            emit(onEvent, CHAT_ENGINE_EVENTS.PROGRESS, payload);
          }
        }
      };

      /* ── Berechtigungen (Issue #66) ─────────────────────────────────────────
       * Pläne, die der Nutzer in diesem Lauf abgelehnt hat: identische
       * Anfragen werden nicht erneut gestellt (Konzept §7). */
      const deniedPlanKeys = new Set();

      function buildScopeKey(policy) {
        return JSON.stringify([chatId, workspaceRoot, policy.mode, policy.policyVersion, skillSignature]);
      }

      function permissionDenied(entry, { reason, ruleId, riskClasses, mode, targets, message }) {
        entry.permission = createPermissionAuditEntry({
          decision: POLICY_DECISIONS.DENY,
          source: PERMISSION_DECISION_SOURCES.DENY,
          reason,
          ruleId,
          riskClasses,
          mode,
          status: TOOL_EXECUTION_STATUSES.DENIED,
          targets,
        });
        return {
          content: createPermissionDeniedToolResult({ reason, ruleId, riskClasses, message }),
          denied: true,
          reason,
        };
      }

      /**
       * Freigabe-Karte anzeigen und auf die Entscheidung warten. Ohne
       * erreichbare Oberfläche verfällt die Anfrage sofort (fail-safe).
       */
      async function askUser({ entry, callIndex, toolName, plan, verdict, policy, checkpoint }) {
        if (deniedPlanKeys.has(plan.planKey)) {
          return { response: APPROVAL_RESPONSES.DENY, reason: PERMISSION_DENIAL_REASONS.REPEATED_DENIAL };
        }
        if (!approvals || typeof approvals.requestApproval !== 'function' || !approvals.isAvailable?.(sessionId)) {
          return { invalidated: true, reason: PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI };
        }
        const request = buildApprovalRequest({
          tool: toolName,
          plan,
          askClasses: verdict.askClasses,
          mode: policy.mode,
          providerKey,
          providerLabel,
          policyVersion: policy.policyVersion,
          chatId,
          checkpoint,
        });
        entry.permission = createPermissionAuditEntry({
          decision: POLICY_DECISIONS.ASK,
          riskClasses: plan.riskClasses,
          mode: policy.mode,
          status: TOOL_EXECUTION_STATUSES.AWAITING_APPROVAL,
          targets: plan.targets,
        });
        emit(
          onEvent,
          CHAT_ENGINE_EVENTS.PROGRESS,
          createPermissionProgressEvent(PERMISSION_PROGRESS_EVENTS.AWAITING, { callIndex, tool: toolName })
        );
        let outcome;
        try {
          outcome = await approvals.requestApproval({ sessionId, request, abortSignal });
        } catch (error) {
          if (isAbortError(error)) throw error;
          outcome = { invalidated: true, reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED };
        }
        // Abbruch des Laufs während der Karte ist ein Abbruch, kein Verfall.
        if (abortSignal.aborted) throw createChatAbortError();
        emit(
          onEvent,
          CHAT_ENGINE_EVENTS.PROGRESS,
          createPermissionProgressEvent(PERMISSION_PROGRESS_EVENTS.RESOLVED, {
            callIndex,
            tool: toolName,
            response: outcome?.invalidated ? undefined : outcome?.response,
            reason: outcome?.invalidated ? outcome.reason || PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED : undefined,
          })
        );
        if (!outcome || outcome.invalidated) {
          return { invalidated: true, reason: outcome?.reason || PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED };
        }
        if (outcome.response === APPROVAL_RESPONSES.DENY) {
          deniedPlanKeys.add(plan.planKey);
          return { response: APPROVAL_RESPONSES.DENY, reason: PERMISSION_DENIAL_REASONS.USER_DENIED };
        }
        if (outcome.response === APPROVAL_RESPONSES.ALLOW_SESSION && request.sessionAllowed) {
          sessionGrants.grant({
            scopeKey: buildScopeKey(policy),
            tool: toolName,
            targets: plan.targets,
            riskClasses: plan.riskClasses,
            providerKey,
          });
          return { response: APPROVAL_RESPONSES.ALLOW_SESSION };
        }
        return { response: APPROVAL_RESPONSES.ALLOW_ONCE };
      }

      /**
       * Ein Tool-Aufruf von der Planung bis zur geprüften Ausgabe. Liefert die
       * Tool-Nachricht fürs Modell; `endRun` beendet den Lauf ohne weiteren
       * Provider-Request (verfallene Freigabe, Konzept §6).
       */
      async function runToolCall({ entry, callIndex, toolName, args }) {
        const policy = await readPolicySnapshot();
        if (policy.unreadable) {
          return {
            ...permissionDenied(entry, {
              reason: PERMISSION_DENIAL_REASONS.POLICY_DENIED,
              mode: policy.mode,
              message: 'Berechtigungsregeln nicht lesbar; Tools bleiben bis zur Korrektur blockiert.',
            }),
          };
        }
        const toolDisabled = disabledNames.includes(toolName);
        let forcedClasses = [];
        let lastPlanKey = null;

        for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt += 1) {
          if (abortSignal.aborted) throw createChatAbortError();
          const plan = await tools.plan(toolName, args, {
            workspaceRoot,
            skillRoots,
            sensitivePathPatterns: policy.sensitivePathPatterns,
            forcedClasses,
          });
          if (!plan || plan.error) {
            return permissionDenied(entry, {
              reason: plan?.reason || PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS,
              riskClasses: plan?.riskClasses,
              mode: policy.mode,
              targets: plan?.targets,
              message: plan?.error,
            });
          }
          const riskClasses = normalizeRiskClasses(plan.riskClasses);
          const scopeKey = buildScopeKey(policy);
          const grant = riskClasses
            ? sessionGrants.find({ scopeKey, tool: toolName, targets: plan.targets, riskClasses, providerKey })
            : null;
          const verdict = decideToolPolicy({
            mode: policy.mode,
            toolName,
            riskClasses,
            targets: plan.targets,
            root: workspaceRoot,
            rules: policy.rules,
            sessionGrant: grant,
            toolDisabled,
            unknownTool: plan.unknownTool === true,
            hardLimit: plan.hardLimit || null,
          });

          if (verdict.decision === POLICY_DECISIONS.DENY) {
            return permissionDenied(entry, {
              reason: verdict.reason,
              ruleId: verdict.ruleId,
              riskClasses,
              mode: policy.mode,
              targets: plan.targets,
            });
          }

          let source = verdict.source;
          if (verdict.decision === POLICY_DECISIONS.ASK) {
            const answer = await askUser({ entry, callIndex, toolName, plan, verdict, policy, checkpoint: 'access' });
            if (answer.invalidated) {
              return { ...permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, riskClasses, mode: policy.mode, targets: plan.targets, message: PERMISSION_DENIED_MESSAGES[answer.reason] }), endRun: true, invalidatedReason: answer.reason };
            }
            if (answer.response === APPROVAL_RESPONSES.DENY) {
              return permissionDenied(entry, { reason: answer.reason, riskClasses, mode: policy.mode, targets: plan.targets });
            }
            source =
              answer.response === APPROVAL_RESPONSES.ALLOW_SESSION
                ? PERMISSION_DECISION_SOURCES.ALLOW_SESSION
                : PERMISSION_DECISION_SOURCES.ALLOW_ONCE;
            // Vor der Ausführung erneut planen: geänderte Datei, Wurzel oder
            // Argumente machen die Karte ungültig (Konzept §6).
            const recheck = await tools.plan(toolName, args, {
              workspaceRoot,
              skillRoots,
              sensitivePathPatterns: policy.sensitivePathPatterns,
              forcedClasses,
            });
            if (!recheck || recheck.error || recheck.planKey !== plan.planKey) {
              if (lastPlanKey === (recheck?.planKey ?? null) || attempt === MAX_PLAN_ATTEMPTS - 1) {
                return { ...permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, riskClasses, mode: policy.mode, targets: plan.targets }), endRun: true, invalidatedReason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED };
              }
              lastPlanKey = plan.planKey;
              continue;
            }
          }

          entry.permission = createPermissionAuditEntry({
            decision: POLICY_DECISIONS.ALLOW,
            source,
            ruleId: verdict.ruleId,
            riskClasses,
            mode: policy.mode,
            status: TOOL_EXECUTION_STATUSES.EXECUTED,
            targets: plan.targets,
          });

          const execution = await tools.execute(toolName, args, {
            workspaceRoot,
            skillRoots,
            abortSignal,
            disabledNames,
            approved: true,
            plan,
            riskClasses,
            ownSecretsCheck: true,
          });

          if (execution?.invalidated) {
            return { ...permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, riskClasses, mode: policy.mode, targets: plan.targets }), endRun: true, invalidatedReason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED };
          }
          if (Array.isArray(execution?.reclassify) && execution.reclassify.length > 0) {
            // Beispiel: Wiederherstellungskopie fehlgeschlagen → der Aufruf
            // ist jetzt `delete` und läuft erneut durch die Matrix (Konzept §9).
            const next = normalizeRiskClasses([...forcedClasses, ...execution.reclassify]) || forcedClasses;
            if (next.length === forcedClasses.length) {
              return permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.INVALID_ARGUMENTS, riskClasses, mode: policy.mode, targets: plan.targets, message: execution.output });
            }
            forcedClasses = next;
            continue;
          }
          if (execution?.hardLimit) {
            return permissionDenied(entry, {
              reason: execution.hardLimit.reason || PERMISSION_DENIAL_REASONS.OWN_SECRET,
              riskClasses,
              mode: policy.mode,
              targets: plan.targets,
            });
          }

          let sensitiveMarker = null;
          if (execution?.sensitive && !riskClasses.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
            // Zweite Prüfstelle (Konzept §4): unerwartet sensibler Inhalt bleibt
            // im Puffer, bis die Policy ihn als read-sensitive freigibt.
            const escalated = normalizeRiskClasses([...riskClasses, TOOL_RISK_CLASSES.READ_SENSITIVE]);
            const escalatedPlan = { ...plan, riskClasses: escalated, planKey: `${plan.planKey}#sensitive` };
            const escalatedGrant = sessionGrants.find({ scopeKey, tool: toolName, targets: plan.targets, riskClasses: escalated, providerKey });
            const outputVerdict = decideToolPolicy({
              mode: policy.mode,
              toolName,
              riskClasses: escalated,
              targets: plan.targets,
              root: workspaceRoot,
              rules: policy.rules,
              sessionGrant: escalatedGrant,
              toolDisabled,
            });
            if (outputVerdict.decision === POLICY_DECISIONS.DENY) {
              return permissionDenied(entry, { reason: outputVerdict.reason, ruleId: outputVerdict.ruleId, riskClasses: escalated, mode: policy.mode, targets: plan.targets });
            }
            let outputSource = outputVerdict.source;
            if (outputVerdict.decision === POLICY_DECISIONS.ASK) {
              const answer = await askUser({ entry, callIndex, toolName, plan: escalatedPlan, verdict: outputVerdict, policy, checkpoint: 'output' });
              if (answer.invalidated) {
                return { ...permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, riskClasses: escalated, mode: policy.mode, targets: plan.targets, message: PERMISSION_DENIED_MESSAGES[answer.reason] }), endRun: true, invalidatedReason: answer.reason };
              }
              if (answer.response === APPROVAL_RESPONSES.DENY) {
                return permissionDenied(entry, { reason: answer.reason, riskClasses: escalated, mode: policy.mode, targets: plan.targets });
              }
              outputSource =
                answer.response === APPROVAL_RESPONSES.ALLOW_SESSION
                  ? PERMISSION_DECISION_SOURCES.ALLOW_SESSION
                  : PERMISSION_DECISION_SOURCES.ALLOW_ONCE;
            }
            entry.permission = createPermissionAuditEntry({
              decision: POLICY_DECISIONS.ALLOW,
              source: outputSource,
              ruleId: outputVerdict.ruleId,
              riskClasses: escalated,
              mode: policy.mode,
              status: TOOL_EXECUTION_STATUSES.EXECUTED,
              targets: plan.targets,
            });
            sensitiveMarker = createSensitiveMarker({ providerKey, targets: plan.targets });
          } else if (riskClasses.includes(TOOL_RISK_CLASSES.READ_SENSITIVE)) {
            sensitiveMarker = createSensitiveMarker({ providerKey, targets: plan.targets });
          }
          if (sensitiveMarker) entry.permission.sensitive = true;

          return {
            content: execution.output,
            progressEvents: execution.progressEvents,
            sensitiveMarker,
          };
        }

        return { ...permissionDenied(entry, { reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, mode: policy.mode }), endRun: true, invalidatedReason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED };
      }

      for (let round = 0; round < toolRoundLimit; round += 1) {
        if (abortSignal.aborted) {
          return returnCancelledChat(onEvent, toolTrace, '', requestUsage, contextUsage);
        }

        emitPhase(onEvent, CHAT_PHASES.WAITING);
        callbacks.reset();
        truncateStaleToolOutputs(apiMessages, historyCharLimit);
        // Provider-Bindung sensibler Tool-Nachrichten (Konzept §4): fremder
        // Endpunkt → Inhalt zurückhalten und den Nutzer darauf hinweisen.
        const redactedCount = redactSensitiveToolMessages(apiMessages, providerKey);
        if (redactedCount > 0) {
          emit(
            onEvent,
            CHAT_ENGINE_EVENTS.PROGRESS,
            createPermissionProgressEvent(PERMISSION_PROGRESS_EVENTS.REDACTED, { redactedCount })
          );
        }

        const streamed = await llm.streamRound({
          target,
          sendBundle,
          messages: stripSensitiveMarkers(apiMessages),
          tools: toolDefs,
          callbacks,
          abortSignal,
        });
        requestUsage = mergeUsage(requestUsage, streamed.usage);
        // Bei Abbruch ohne Usage bleibt die letzte vollstaendige Runde stehen.
        contextUsage = normalizeUsage(streamed.usage) || contextUsage;

        if (streamed.cancelled) {
          return returnCancelledChat(onEvent, toolTrace, streamed.message?.content ?? '', requestUsage, contextUsage);
        }
        if (streamed.error) {
          emitPhase(onEvent, CHAT_PHASES.IDLE);
          return createChatErrorResult({
            error: streamed.error,
            code: streamed.code || CHAT_ERROR_CODES.API,
            usage: requestUsage,
            contextUsage,
          });
        }

        const assistantMessage = streamed.message;
        if (!assistantMessage) {
          return createChatErrorResult({ error: 'Ungültige Antwort der API.', code: CHAT_ERROR_CODES.INVALID });
        }
        apiMessages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls;
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
          emitPhase(onEvent, CHAT_PHASES.IDLE);
          return createChatResult({
            content: assistantMessage.content ?? '',
            toolTrace,
            usage: requestUsage,
            contextUsage,
          });
        }

        for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
          const toolCall = toolCalls[callIndex];
          if (abortSignal.aborted) {
            return returnCancelledChat(onEvent, toolTrace, '', requestUsage, contextUsage);
          }
          const toolName = toolCall.function?.name || 'tool';
          const args = parseToolArguments(toolCall.function?.arguments);
          const entry = tools.buildTraceEntry(
            toolName,
            args,
            workspaceRoot ? undefined : { noWorkspace: true }
          );
          toolTrace.push(entry);
          emitToolLine(TOOL_LINE_PHASES.START, entry, { callIndex });

          if (!workspaceRoot) {
            emitToolLine(TOOL_LINE_PHASES.DONE, entry, { callIndex });
            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: 'Kein Arbeitsordner geöffnet; Tools nicht verfügbar.' }),
            });
            continue;
          }

          let outcome;
          try {
            outcome = await runToolCall({ entry, callIndex, toolName, args });
            emitProgressPayloads(outcome.progressEvents);
          } catch (error) {
            if (isAbortError(error)) {
              return returnCancelledChat(onEvent, toolTrace, '', requestUsage, contextUsage);
            }
            throw error;
          }
          emitToolLine(TOOL_LINE_PHASES.DONE, entry, { callIndex });
          const toolMessage = { role: 'tool', tool_call_id: toolCall.id, content: outcome.content };
          if (outcome.sensitiveMarker) toolMessage.sensitiveMarker = outcome.sensitiveMarker;
          apiMessages.push(toolMessage);

          if (outcome.endRun) {
            // Verfall beendet den Lauf ohne weiteren Provider-Request; das
            // Ergebnis bleibt im Verlauf sichtbar (Konzept §6).
            emitPhase(onEvent, CHAT_PHASES.IDLE);
            return createChatErrorResult({
              error:
                outcome.invalidatedReason === PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI
                  ? 'Der Tool-Aufruf braucht eine Freigabe, aber es ist keine Freigabe-Oberfläche verfügbar. Der Lauf wurde beendet.'
                  : 'Die Freigabe-Anfrage ist verfallen (Datei, Kontext oder Regeln haben sich geändert). Der Lauf wurde beendet; stelle die Frage bei Bedarf erneut.',
              code: CHAT_ERROR_CODES.PERMISSION,
              usage: requestUsage,
              contextUsage,
              toolTrace,
            });
          }
        }
      }

      emitPhase(onEvent, CHAT_PHASES.IDLE);
      return createChatErrorResult({
        error:
          `Zu viele Tool-Runden (aktuell ${toolRoundLimit}). ` +
          'Erhöhe das Limit unter Einstellungen › Allgemein oder formuliere die Frage enger.',
        code: CHAT_ERROR_CODES.TOOL_LIMIT,
        usage: requestUsage,
        contextUsage,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return returnCancelledChat(onEvent, toolTrace, '', requestUsage, contextUsage);
      }
      emitPhase(onEvent, CHAT_PHASES.IDLE);
      return createChatErrorResult({
        error: llm.formatRoundError(error),
        code: CHAT_ERROR_CODES.NETWORK,
      });
    } finally {
      if (activeChatAborts.get(sessionId) === abortController) activeChatAborts.delete(sessionId);
    }
  }

  /** Callbacks-Attrappe: Der Titel-Aufruf soll keine Chat-Ereignisse ausloesen. */
  function silentStreamCallbacks() {
    const noop = () => {};
    return {
      reset: noop,
      onMarkGenerating: noop,
      onTextDelta: noop,
      onReasoningDelta: noop,
      onToolCallStart: noop,
      onToolCallArgumentsDelta: noop,
    };
  }

  function clipForTitle(content) {
    const text = typeof content === 'string' ? content : String(content ?? '');
    const flat = text.trim();
    if (flat.length <= TITLE_INPUT_CHAR_LIMIT) return flat;
    return `${flat.slice(0, TITLE_INPUT_CHAR_LIMIT)}…`;
  }

  /**
   * Laesst das aktive Modell eine Ueberschrift fuer die Konversation bilden.
   * Erwartet die ersten Nachrichten des Gespraechs; nutzt daraus die erste
   * Nutzerfrage und die erste Antwort. Liefert { title } oder { error } —
   * der Aufrufer faellt bei einem Fehler auf den abgeleiteten Titel zurueck.
   */
  async function generateTitle({ messages } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const firstUser = list.find((m) => m && m.role === 'user' && String(m.content ?? '').trim());
    if (!firstUser) return { error: 'Keine Nutzerfrage vorhanden.', code: CHAT_ERROR_CODES.INVALID };
    const firstAnswer = list.find(
      (m) => m && m.role === 'assistant' && !m.greeting && String(m.content ?? '').trim()
    );

    const resolved = await resolveTarget(false);
    if (resolved.error) return resolved.error;
    const { target } = resolved;

    const parts = [`Frage:\n${clipForTitle(firstUser.content)}`];
    if (firstAnswer) parts.push(`Antwort:\n${clipForTitle(firstAnswer.content)}`);

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(createChatAbortError()), TITLE_TIMEOUT_MS);
    try {
      const sendBundle = await llm.prepareSendBundle(target);
      const round = await llm.streamRound({
        target,
        sendBundle,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: parts.join('\n\n') },
        ],
        tools: [],
        callbacks: silentStreamCallbacks(),
        abortSignal: abortController.signal,
      });
      if (round?.cancelled) return { error: 'Titel-Anfrage abgebrochen.', code: CHAT_ERROR_CODES.INVALID };
      if (round?.error) return { error: round.error, code: round.code || CHAT_ERROR_CODES.API };
      const title = sanitizeChatTitle(round?.message?.content);
      if (!title) return { error: 'Leere Antwort auf die Titel-Anfrage.', code: CHAT_ERROR_CODES.INVALID };
      return { title };
    } catch (error) {
      if (isAbortError(error)) return { error: 'Titel-Anfrage abgebrochen.', code: CHAT_ERROR_CODES.INVALID };
      return { error: llm.formatRoundError(error), code: CHAT_ERROR_CODES.API };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send, abort, generateTitle, sessionGrants };
}

module.exports = {
  CHAT_ENGINE_EVENTS,
  MAX_PLAN_ATTEMPTS,
  createChatEngine,
  resolveToolRoundLimit,
  buildProviderKey,
};
