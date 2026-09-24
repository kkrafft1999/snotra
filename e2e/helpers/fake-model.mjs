// Gefakter OpenAI-kompatibler Modellserver fuer den Smoke-Test (Issue #78).
//
// Der Smoke-Test braucht ein Modell, das antwortet — aber keinen API-Key, kein
// Netz und keine Wartezeit. Der Provider `mlx-lm` hat ein `baseUrl`-Feld und
// verlangt keinen Key, also zeigt die Testkonfiguration einfach hierher.
// Gesprochen wird das Chat-Completions-Protokoll als SSE, genau so viel davon,
// wie src/main/providers/mlx-lm.js liest.

import http from 'node:http';

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const contentChunk = (text) => sse({
  id: 'fake', object: 'chat.completion.chunk', model: 'fake-model',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});

/**
 * Startet den Server auf einem freien Port.
 *
 * Antworten werden vorab hinterlegt und ueber `match` der passenden Anfrage
 * zugeordnet — **nicht** der Reihe nach. Die App fragt naemlich nach jeder Runde
 * noch einmal nach einem Gespraechstitel; eine reine Warteschlange wuerde dieser
 * Zwischenfrage die Antwort des naechsten Testschritts vorsetzen.
 * `chunkDelayMs` macht den Stream langsam genug, um ihn im Test abzubrechen.
 * `untilAbortedMs` (with a `chunkDelayMs`) keeps it going until the client
 * aborts, at most that long.
 * Was der Client geschickt hat, landet in `requests` — daran laesst sich pruefen,
 * ob ein Abbruch wirklich beim Server ankam.
 */
export async function startFakeModel() {
  const answers = [];
  const requests = [];
  // Numbers the TCP connections, so a trace shows whether a request rode on a
  // kept-alive socket and whether that socket went away with the abort (#327).
  let socketSeq = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const raw = body || '{}';
      const record = { body: JSON.parse(raw), aborted: false, finished: false };
      requests.push(record);
      // Server-side timeline for #327: when the stream was written, when the
      // response and its socket closed, relative to the request's arrival.
      const socket = req.socket;
      socket.snotraId ??= ++socketSeq;
      socket.snotraRequests = (socket.snotraRequests ?? 0) + 1;
      const arrivedAt = Date.now();
      record.trace = {
        arrivedAt,
        socketId: socket.snotraId,
        socketReused: socket.snotraRequests > 1,
        chunksWritten: 0,
        lastWriteMs: null,
        resCloseMs: null,
        socketCloseMs: null,
        endMs: null,
      };
      const sinceArrival = () => Date.now() - arrivedAt;
      res.on('close', () => { record.trace.resCloseMs = sinceArrival(); });
      socket.once('close', () => { record.trace.socketCloseMs ??= sinceArrival(); });
      // Nicht `req.on('aborted')`: das Ereignis ist seit Node 18 abgekuendigt und
      // bleibt hier aus. Verlaesslich ist, ob die Antwort zugeht, bevor wir mit
      // dem Schreiben fertig sind — genau das ist ein Abbruch durch den Client.
      res.on('close', () => { if (!record.finished) record.aborted = true; });

      // Die Titel-Anfrage bekommt nie eine hinterlegte Antwort. Sie traegt die
      // ganze bisherige Konversation im Body und wuerde sonst die Antwort des
      // naechsten Schritts abraeumen — der Grund fuer einen zaehen Flake.
      record.isTitleRequest = raw.includes('Du benennst Konversationen');
      const index = record.isTitleRequest
        ? -1
        : answers.findIndex((a) => !a.match || raw.includes(a.match));
      const answer = index >= 0 ? answers.splice(index, 1)[0] : { text: 'Kurz.', chunkDelayMs: 0 };
      record.answer = answer;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Tool-Aufruf statt Text (Issue #166): dasselbe SSE-Protokoll, nur mit
      // `tool_calls` im Delta und `finish_reason: 'tool_calls'` am Ende. Damit
      // laesst sich die Strecke Modell → Freigabe → Tool im Test fahren, ohne
      // ein echtes Modell zu fragen.
      if (Array.isArray(answer.toolCalls) && answer.toolCalls.length > 0) {
        answer.toolCalls.forEach((call, index) => {
          res.write(sse({
            id: 'fake', object: 'chat.completion.chunk', model: 'fake-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index,
                  id: `call_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                }],
              },
              finish_reason: null,
            }],
          }));
        });
        res.write(sse({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
        record.finished = true;
        return;
      }

      // In Woerter zerlegen, damit ein Abbruch mitten im Stream moeglich ist.
      const parts = answer.text.match(/\S+\s*/g) ?? [answer.text];
      // `untilAbortedMs` repeats the text until the client closes, so a test
      // that aborts cannot race the answer's natural end (#327). The cap only
      // keeps a broken abort from streaming forever; hitting it ends the answer
      // normally, which the test then sees as `finished` instead of `aborted`.
      const deadline = answer.untilAbortedMs ? Date.now() + answer.untilAbortedMs : null;
      for (let i = 0; deadline ? Date.now() < deadline : i < parts.length; i += 1) {
        const part = parts[i % parts.length];
        if (res.destroyed || res.writableEnded || record.aborted) return;
        res.write(contentChunk(part));
        record.trace.chunksWritten += 1;
        record.trace.lastWriteMs = sinceArrival();
        if (answer.chunkDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, answer.chunkDelayMs));
        }
      }
      if (res.destroyed || res.writableEnded || record.aborted) return;
      res.write(sse({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
      res.write('data: [DONE]\n\n');
      res.end();
      record.finished = true;
      record.trace.endMs = sinceArrival();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** @param {{ match?: string, text?: string, chunkDelayMs?: number, untilAbortedMs?: number, toolCalls?: Array<{name: string, arguments?: object}> }} answer */
    queueAnswer(answer) { answers.push(answer); },
    /** Die Anfrage, die diesen Text enthielt — fuer Zusicherungen zum Abbruch. */
    requestFor(match) {
      return requests.find((r) => !r.isTitleRequest && JSON.stringify(r.body).includes(match)) ?? null;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
