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
 * Was der Client geschickt hat, landet in `requests` — daran laesst sich pruefen,
 * ob ein Abbruch wirklich beim Server ankam.
 */
export async function startFakeModel() {
  const answers = [];
  const requests = [];

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

      // In Woerter zerlegen, damit ein Abbruch mitten im Stream moeglich ist.
      const parts = answer.text.match(/\S+\s*/g) ?? [answer.text];
      for (const part of parts) {
        if (res.destroyed || res.writableEnded || record.aborted) return;
        res.write(contentChunk(part));
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
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** @param {{ match?: string, text: string, chunkDelayMs?: number }} answer */
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
