'use strict';

// How a round ends, across the five providers (#538): a failed, refused or
// cut-off round must not come back as a finished answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const openai = require('../src/main/providers/openai');
const compatible = require('../src/main/providers/openai-compatible');
const anthropic = require('../src/main/providers/anthropic');
const google = require('../src/main/providers/google');
const ollama = require('../src/main/providers/ollama');
const { FINISH_REASONS, isCutOff, finishReasonOf } = require('../src/shared/contracts/finish-reason');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const MESSAGES = [{ role: 'user', content: 'Hi' }];

const event = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
const data = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

async function round(t, provider, chunks, config = { apiKey: 'k' }) {
  mockFetch(t, () => sseResponse(chunks));
  const sink = collectCallbacks();
  const result = await provider.streamChatRound({
    config,
    model: 'm',
    messages: MESSAGES,
    callbacks: sink.callbacks,
  });
  return { result, sink };
}

const chatCompletions = (t, chunks) => round(t, compatible, chunks, { baseUrl: 'http://127.0.0.1:1/v1' });

test('the vocabulary: a cut-off reason wins over tool calls', () => {
  assert.equal(finishReasonOf({}), FINISH_REASONS.STOP);
  assert.equal(finishReasonOf({ toolCalls: true }), FINISH_REASONS.TOOL_CALLS);
  assert.equal(finishReasonOf({ cutOff: FINISH_REASONS.LENGTH, toolCalls: true }), FINISH_REASONS.LENGTH);
  assert.equal(finishReasonOf({ cutOff: 'max_tokens' }), FINISH_REASONS.STOP, 'only the vocabulary counts');
  for (const reason of ['length', 'content_filter', 'incomplete']) assert.ok(isCutOff(reason));
  for (const reason of ['stop', 'tool_calls', undefined, null, 'max_tokens']) assert.equal(isCutOff(reason), false);
});

// --- Responses --------------------------------------------------------------

test('Responses: response.failed is an error with the API message', async (t) => {
  const { result } = await round(t, openai, [
    event('response.output_text.delta', { delta: 'Partial ' }),
    event('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }),
  ]);
  assert.deepEqual(result, { error: 'boom', code: 'API' });
});

test('Responses: response.incomplete is cut off at the limit or by the filter', async (t) => {
  const { result } = await round(t, openai, [
    event('response.output_text.delta', { delta: 'Cut' }),
    event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }),
  ]);
  assert.equal(result.message.content, 'Cut');
  assert.equal(result.finishReason, FINISH_REASONS.LENGTH);

  const filtered = await round(t, openai, [
    event('response.incomplete', { response: { incomplete_details: { reason: 'content_filter' } } }),
  ]);
  assert.equal(filtered.result.finishReason, FINISH_REASONS.CONTENT_FILTER);
});

test('Responses: a refusal is the answer text', async (t) => {
  const { result, sink } = await round(t, openai, [
    event('response.refusal.delta', { delta: "I can't help with that." }),
    event('response.completed', { response: {} }),
  ]);
  assert.equal(result.message.content, "I can't help with that.");
  assert.equal(result.finishReason, FINISH_REASONS.STOP);
  assert.deepEqual(sink.textDeltas, ["I can't help with that."]);
});

test('Responses: a stream without a closing event is incomplete', async (t) => {
  const { result } = await round(t, openai, [event('response.output_text.delta', { delta: 'Half an ans' })]);
  assert.equal(result.message.content, 'Half an ans');
  assert.equal(result.finishReason, FINISH_REASONS.INCOMPLETE);
});

// --- Chat Completions -------------------------------------------------------

test('Chat Completions: a refusal is the answer text', async (t) => {
  const { result } = await chatCompletions(t, [
    data({ choices: [{ delta: { refusal: "I can't help." } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ]);
  assert.equal(result.message.content, "I can't help.");
  assert.equal(result.finishReason, FINISH_REASONS.STOP);
});

test('Chat Completions: a tool call cut off at the limit is reported as cut off, not as a tool round', async (t) => {
  const { result } = await chatCompletions(t, [
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]);
  assert.equal(result.finishReason, FINISH_REASONS.LENGTH);
  assert.equal(result.message.tool_calls.length, 1);
});

test('Chat Completions: content_filter, [DONE] without a finish reason, and no end at all', async (t) => {
  const filtered = await chatCompletions(t, [
    data({ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }),
  ]);
  assert.equal(filtered.result.finishReason, FINISH_REASONS.CONTENT_FILTER);

  const done = await chatCompletions(t, [data({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']);
  assert.equal(done.result.finishReason, FINISH_REASONS.STOP);

  const dropped = await chatCompletions(t, [data({ choices: [{ delta: { content: 'Half' } }] })]);
  assert.equal(dropped.result.finishReason, FINISH_REASONS.INCOMPLETE);
});

// --- Anthropic --------------------------------------------------------------

test('Anthropic: max_tokens in the middle of a tool call is cut off', async (t) => {
  const { result } = await round(t, anthropic, [
    data({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'write_file' } }),
    data({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } }),
    data({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    data({ type: 'message_stop' }),
  ]);
  assert.equal(result.finishReason, FINISH_REASONS.LENGTH);
});

test('Anthropic: refusal, a normal end, and no end at all', async (t) => {
  const refused = await round(t, anthropic, [
    data({ type: 'message_delta', delta: { stop_reason: 'refusal' } }),
    data({ type: 'message_stop' }),
  ]);
  assert.equal(refused.result.finishReason, FINISH_REASONS.CONTENT_FILTER);

  const ended = await round(t, anthropic, [
    data({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
    data({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    data({ type: 'message_stop' }),
  ]);
  assert.equal(ended.result.finishReason, FINISH_REASONS.STOP);

  const dropped = await round(t, anthropic, [
    data({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
  ]);
  assert.equal(dropped.result.finishReason, FINISH_REASONS.INCOMPLETE);
});

// --- Gemini -----------------------------------------------------------------

test('Gemini: MAX_TOKENS, SAFETY, a blocked prompt, and no finish reason', async (t) => {
  const candidate = (finishReason) => data({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }] });

  assert.equal((await round(t, google, [candidate('MAX_TOKENS')])).result.finishReason, FINISH_REASONS.LENGTH);
  assert.equal((await round(t, google, [candidate('SAFETY')])).result.finishReason, FINISH_REASONS.CONTENT_FILTER);
  assert.equal((await round(t, google, [candidate('STOP')])).result.finishReason, FINISH_REASONS.STOP);
  assert.equal(
    (await round(t, google, [data({ promptFeedback: { blockReason: 'SAFETY' } })])).result.finishReason,
    FINISH_REASONS.CONTENT_FILTER
  );
  assert.equal(
    (await round(t, google, [data({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })])).result.finishReason,
    FINISH_REASONS.INCOMPLETE
  );
});

// --- Ollama -----------------------------------------------------------------

test('Ollama: done_reason length is cut off, a stream without done is incomplete', async (t) => {
  const line = (payload) => `${JSON.stringify(payload)}\n`;
  const config = { baseUrl: 'http://127.0.0.1:1' };

  const cut = await round(t, ollama, [
    line({ message: { content: 'x' } }),
    line({ done: true, done_reason: 'length' }),
  ], config);
  assert.equal(cut.result.finishReason, FINISH_REASONS.LENGTH);

  const dropped = await round(t, ollama, [line({ message: { content: 'x' } })], config);
  assert.equal(dropped.result.finishReason, FINISH_REASONS.INCOMPLETE);
});
