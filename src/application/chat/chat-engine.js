'use strict';

const { isAbortError, createChatAbortError } = require('../../shared/runtime/abort');
const { extractStringFromPartialJson } = require('../../shared/runtime/partial-json');
const { mergeUsage } = require('../../shared/contracts/usage');
const {
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  APP_LOCALES,
  createChatResult,
  createCancelledChatResult,
  createChatErrorResult,
  createDeltaEvent,
  createToolLineEvent,
  createPhaseEvent,
  createReasoningEvent,
} = require('../../shared/contracts');
const {
  resolveHistoryCharLimit,
  trimHistoryMessages,
  truncateStaleToolOutputs,
} = require('./chat-history-trim');

const CHAT_ENGINE_EVENTS = Object.freeze({
  DELTA: 'delta',
  PROGRESS: 'progress',
  TOOL_LINE: 'tool-line',
});

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
 * Sprachvorgaben — die bleiben dem Prompt des Nutzers überlassen.
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
  return parts.join('\n\n');
}

function parseToolArguments(rawArguments) {
  try {
    return JSON.parse(rawArguments || '{}');
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

function createChatEngine({
  llm,
  tools,
  preferences,
  workspacePaths,
  skills = null,
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

  function returnCancelledChat(onEvent, toolTrace, content = '', usage = null) {
    emitPhase(onEvent, CHAT_PHASES.IDLE);
    return createCancelledChatResult({ content, toolTrace, usage });
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
    let requestUsage = null;

    try {
      const messages = payload?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return createChatErrorResult({ error: 'Keine Nachrichten übergeben.', code: CHAT_ERROR_CODES.INVALID });
      }

      const resolved = await resolveTarget(true);
      if (resolved.error) return resolved.error;
      const { target } = resolved;
      const sendBundle = await llm.prepareSendBundle(target);

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
      const allowWrite = uiPrefs.allowWorkspaceWrite === true;
      const disabledNames = Array.isArray(uiPrefs.disabledTools) ? uiPrefs.disabledTools : [];
      const toolOptions = { allowWrite, disabledNames };
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

      for (let round = 0; round < toolRoundLimit; round += 1) {
        if (abortSignal.aborted) {
          return returnCancelledChat(onEvent, toolTrace, '', requestUsage);
        }

        emitPhase(onEvent, CHAT_PHASES.WAITING);
        callbacks.reset();
        truncateStaleToolOutputs(apiMessages, historyCharLimit);

        const streamed = await llm.streamRound({
          target,
          sendBundle,
          messages: apiMessages,
          tools: toolDefs,
          callbacks,
          abortSignal,
        });
        requestUsage = mergeUsage(requestUsage, streamed.usage);

        if (streamed.cancelled) {
          return returnCancelledChat(onEvent, toolTrace, streamed.message?.content ?? '', requestUsage);
        }
        if (streamed.error) {
          emitPhase(onEvent, CHAT_PHASES.IDLE);
          return createChatErrorResult({
            error: streamed.error,
            code: streamed.code || CHAT_ERROR_CODES.API,
            usage: requestUsage,
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
          });
        }

        for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
          const toolCall = toolCalls[callIndex];
          if (abortSignal.aborted) {
            return returnCancelledChat(onEvent, toolTrace, '', requestUsage);
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

          let output;
          try {
            const execution = await tools.execute(toolName, args, {
              workspaceRoot,
              skillRoots,
              abortSignal,
              allowWrite,
              disabledNames,
            });
            output = execution.output;
            emitProgressPayloads(execution.progressEvents);
          } catch (error) {
            if (isAbortError(error)) {
              return returnCancelledChat(onEvent, toolTrace, '', requestUsage);
            }
            throw error;
          }
          emitToolLine(TOOL_LINE_PHASES.DONE, entry, { callIndex });
          apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
        }
      }

      emitPhase(onEvent, CHAT_PHASES.IDLE);
      return createChatErrorResult({
        error:
          `Zu viele Tool-Runden (aktuell ${toolRoundLimit}). ` +
          'Erhöhe das Limit unter Einstellungen › Allgemein oder formuliere die Frage enger.',
        code: CHAT_ERROR_CODES.TOOL_LIMIT,
        usage: requestUsage,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return returnCancelledChat(onEvent, toolTrace, '', requestUsage);
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

  return { send, abort };
}

module.exports = {
  CHAT_ENGINE_EVENTS,
  createChatEngine,
  resolveToolRoundLimit,
};
