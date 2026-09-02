function readerFromChunks(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  let cancelled = false;
  return {
    async read() {
      if (cancelled || i >= chunks.length) return { done: true, value: undefined };
      const value = chunks[i++];
      return { done: false, value: typeof value === 'string' ? encoder.encode(value) : value };
    },
    async cancel() {
      cancelled = true;
    },
    releaseLock() {},
  };
}

function sseResponse(chunks, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    body: { getReader: () => readerFromChunks(chunks) },
    text: async () => '',
    json: async () => ({}),
  };
}

/** Replaces global.fetch for the duration of one node:test case. */
function mockFetch(t, impl) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

function collectCallbacks() {
  const textDeltas = [];
  const reasoningDeltas = [];
  const toolCallStarts = [];
  const toolCallArgumentDeltas = [];
  let markGeneratingCalls = 0;
  return {
    textDeltas,
    reasoningDeltas,
    toolCallStarts,
    toolCallArgumentDeltas,
    get markGeneratingCalls() {
      return markGeneratingCalls;
    },
    callbacks: {
      onTextDelta: (d) => textDeltas.push(d),
      onReasoningDelta: (d) => reasoningDeltas.push(d),
      onMarkGenerating: () => {
        markGeneratingCalls++;
      },
      onToolCallStart: (call) => toolCallStarts.push(call),
      onToolCallArgumentsDelta: (delta) => toolCallArgumentDeltas.push(delta),
    },
  };
}

module.exports = { readerFromChunks, sseResponse, mockFetch, collectCallbacks };
