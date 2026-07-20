'use strict';

const { isAbortError, createChatAbortError } = require('../../shared/runtime/abort');
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

function summarizeToolCall(toolCall) {
  return {
    id: toolCall?.id || null,
    name: toolCall?.function?.name || null,
    arguments: typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : '',
  };
}

function snapshotMessages(apiMessages) {
  return apiMessages.map((message) => {
    const row = {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content == null ? '' : String(message.content),
    };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      row.tool_calls = message.tool_calls.map(summarizeToolCall);
    }
    if (message.tool_call_id) row.tool_call_id = message.tool_call_id;
    return row;
  });
}

function parseResponseMessage(message) {
  if (!message) return null;
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map(summarizeToolCall) : [],
  };
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

function parseToolArguments(rawArguments) {
  try {
    return JSON.parse(rawArguments || '{}');
  } catch {
    return {};
  }
}

function createChatEngine({
  llm,
  tools,
  preferences,
  workspacePaths,
  rawExchange,
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

  function returnCancelledChat(onEvent, toolTrace, content = '', usage = null, rawExchanges = []) {
    emitPhase(onEvent, CHAT_PHASES.IDLE);
    return createCancelledChatResult({ content, toolTrace, usage, rawExchanges });
  }

  function makeStreamCallbacks(onEvent) {
    let started = false;
    const markGenerating = () => {
      if (started) return;
      started = true;
      emitPhase(onEvent, CHAT_PHASES.GENERATING);
    };
    return {
      reset() {
        started = false;
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

  async function explain({ payload }) {
    const messages = payload?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return createChatErrorResult({ error: 'Keine Nachrichten übergeben.', code: CHAT_ERROR_CODES.INVALID });
    }

    try {
      const resolved = await resolveTarget(false);
      if (resolved.error) return resolved.error;
      const { target } = resolved;

      const apiMessages = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content ?? '' }));
      if (apiMessages.length === 0) {
        return createChatErrorResult({ error: 'Keine gültigen Nachrichten.', code: CHAT_ERROR_CODES.INVALID });
      }

      const explainBundle = await llm.prepareSendBundle(target);
      const streamed = await llm.streamRound({
        target,
        sendBundle: explainBundle,
        messages: apiMessages,
        tools: undefined,
        callbacks: {
          reset() {},
          onMarkGenerating() {},
          onTextDelta() {},
          onReasoningDelta() {},
        },
        abortSignal: new AbortController().signal,
      });
      if (streamed.error) {
        return createChatErrorResult({ error: streamed.error, code: streamed.code || CHAT_ERROR_CODES.API });
      }
      return { content: streamed.message?.content ?? '' };
    } catch (error) {
      return createChatErrorResult({
        error: llm.formatRoundError(error),
        code: CHAT_ERROR_CODES.NETWORK,
      });
    }
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
    const rawExchanges = [];
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

      const uiPrefs = await preferences.read();
      const appLocale = resolveAppLocale(uiPrefs);
      const systemPrompt = typeof uiPrefs.baseSystemPrompt === 'string' ? uiPrefs.baseSystemPrompt.trim() : '';
      const allowWrite = uiPrefs.allowWorkspaceWrite === true;
      const disabledNames = Array.isArray(uiPrefs.disabledTools) ? uiPrefs.disabledTools : [];
      const toolOptions = { allowWrite, disabledNames };

      const apiMessages = [];
      if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
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
      const callbacks = makeStreamCallbacks(onEvent);
      const toolRoundLimit = resolveToolRoundLimit(uiPrefs, maxToolRounds);
      const emitToolLine = (phase, entry) => {
        const line = tools.formatDisplayLine(entry, phase, appLocale);
        entry.line = line;
        emit(onEvent, CHAT_ENGINE_EVENTS.TOOL_LINE, createToolLineEvent(phase, { ...entry, line }));
      };
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
          return returnCancelledChat(onEvent, toolTrace, '', requestUsage, rawExchanges);
        }

        emitPhase(onEvent, CHAT_PHASES.WAITING);
        callbacks.reset();
        truncateStaleToolOutputs(apiMessages, historyCharLimit);

        const recorder = rawExchange.createRoundRecorder();
        const sentMessages = snapshotMessages(apiMessages);
        const streamed = await llm.streamRound({
          target,
          sendBundle,
          messages: apiMessages,
          tools: toolDefs,
          callbacks,
          abortSignal,
          recorder,
        });

        rawExchanges.push(recorder.toExchange({
          providerId: target.providerId,
          model: sendBundle.model,
          round,
          ts: clock(),
          finishReason: streamed.finishReason,
          cancelled: !!streamed.cancelled,
          error: streamed.error || null,
          usage: streamed.usage || null,
          messages: sentMessages,
          response: parseResponseMessage(streamed.message),
        }));
        requestUsage = mergeUsage(requestUsage, streamed.usage);

        if (streamed.cancelled) {
          return returnCancelledChat(onEvent, toolTrace, streamed.message?.content ?? '', requestUsage, rawExchanges);
        }
        if (streamed.error) {
          emitPhase(onEvent, CHAT_PHASES.IDLE);
          return createChatErrorResult({
            error: streamed.error,
            code: streamed.code || CHAT_ERROR_CODES.API,
            usage: requestUsage,
            rawExchanges,
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
            rawExchanges,
          });
        }

        for (const toolCall of toolCalls) {
          if (abortSignal.aborted) {
            return returnCancelledChat(onEvent, toolTrace, '', requestUsage, rawExchanges);
          }
          const toolName = toolCall.function?.name || 'tool';
          const args = parseToolArguments(toolCall.function?.arguments);
          const entry = tools.buildTraceEntry(
            toolName,
            args,
            workspaceRoot ? undefined : { noWorkspace: true }
          );
          toolTrace.push(entry);
          emitToolLine(TOOL_LINE_PHASES.START, entry);

          if (!workspaceRoot) {
            emitToolLine(TOOL_LINE_PHASES.DONE, entry);
            apiMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: 'Kein Arbeitsordner geöffnet; Tools nicht verfügbar.' }),
            });
            continue;
          }

          let output;
          try {
            const execution = await tools.execute(toolName, args, { workspaceRoot, abortSignal, allowWrite, disabledNames });
            output = execution.output;
            emitProgressPayloads(execution.progressEvents);
          } catch (error) {
            if (isAbortError(error)) {
              return returnCancelledChat(onEvent, toolTrace, '', requestUsage, rawExchanges);
            }
            throw error;
          }
          emitToolLine(TOOL_LINE_PHASES.DONE, entry);
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
        rawExchanges,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return returnCancelledChat(onEvent, toolTrace, '', requestUsage, rawExchanges);
      }
      emitPhase(onEvent, CHAT_PHASES.IDLE);
      return createChatErrorResult({
        error: llm.formatRoundError(error),
        code: CHAT_ERROR_CODES.NETWORK,
        rawExchanges,
      });
    } finally {
      if (activeChatAborts.get(sessionId) === abortController) activeChatAborts.delete(sessionId);
    }
  }

  return { send, explain, abort };
}

module.exports = {
  CHAT_ENGINE_EVENTS,
  createChatEngine,
  resolveToolRoundLimit,
};
