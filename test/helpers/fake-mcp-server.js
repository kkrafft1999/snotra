'use strict';

/**
 * Ein echter MCP-Server für die Tests zu Issue #106 — bewusst ein eigener
 * Prozess und keine Attrappe: Framing über Zeilen, Teil-Chunks, CRLF, ein
 * sterbender Server und ein Prozess, der auf EOF nicht reagiert, lassen sich
 * mit einem gefälschten Stream nicht ehrlich prüfen.
 *
 * Das Verhalten steuert argv[2]:
 *   ok             — normaler Server mit zwei Tools
 *   split          — schreibt Antworten in Häppchen, teils mit CRLF
 *   noisy          — schreibt zusätzlich Nicht-JSON auf stdout
 *   paginate       — tools/list über zwei Seiten mit nextCursor
 *   no-tools       — meldet keine tools-Capability
 *   flood          — schickt auf tools/list eine riesige Zeile ohne Zeilenende
 *   slow-init      — antwortet auf initialize nie
 *   slow-call      — antwortet auf tools/call nie
 *   crash-on-call  — stirbt beim ersten tools/call
 *   error-on-call  — antwortet mit einem JSON-RPC-Fehler
 *   tool-error     — antwortet mit isError: true (fachlicher Fehler)
 *   die-on-start   — schreibt auf stderr und beendet sich sofort
 *   leak-env       — schreibt seinen Token auf stderr und beendet sich (Leck-Test)
 *   ignore-eof     — reagiert nicht auf das Schließen von stdin
 */

const mode = process.argv[2] || 'ok';

if (mode === 'leak-env') {
  // Ein schlecht gebauter Server, der beim Scheitern seine Umgebung ausgibt.
  // Genau der Fall, gegen den die Maskierung in #108 schuetzt.
  process.stderr.write(`fake-mcp: Start fehlgeschlagen, GITHUB_TOKEN=${process.env.GITHUB_TOKEN}\n`);
  process.exit(4);
}

if (mode === 'die-on-start') {
  process.stderr.write('fake-mcp: Konfiguration unvollständig, breche ab.\n');
  process.exit(3);
}

// `echo` traegt bewusst ein Pydantic-Schema, wie es die Mehrzahl der Server
// liefert: `title` an jeder Eigenschaft und am Wurzelschema, dazu eine
// Eigenschaft, die selbst `title` heisst. Genau daran entscheidet sich, ob
// das Entschlacken in #185 schemabewusst ist oder ein Tool bricht.
const TOOLS = [
  {
    name: 'echo',
    description: 'Gibt den Text zurück.',
    inputSchema: {
      type: 'object',
      title: 'echoArguments',
      properties: {
        text: { type: 'string', title: 'Text' },
        title: { type: 'string', title: 'Title', description: 'Überschrift über der Ausgabe.' },
      },
      required: ['text'],
    },
  },
  { name: 'add', description: 'Addiert zwei Zahlen.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];

function write(text) {
  if (mode === 'split') {
    // In Häppchen und mit CRLF — genau das, was unter Windows ankommt.
    const payload = text.replace(/\n$/, '\r\n');
    const cut = Math.floor(payload.length / 2);
    process.stdout.write(payload.slice(0, cut));
    setTimeout(() => process.stdout.write(payload.slice(cut)), 5);
    return;
  }
  process.stdout.write(text);
}

function send(message) {
  write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    if (mode === 'slow-init') return; // nie antworten
    if (mode === 'noisy') process.stdout.write('fake-mcp bereit\n');
    reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: mode === 'no-tools' ? {} : { tools: { listChanged: false } },
      serverInfo: { name: 'fake-mcp', version: '1.2.3' },
    });
    return;
  }

  if (method === 'tools/list') {
    if (mode === 'flood') {
      // Ueber MCP_LIMITS.MAX_MESSAGE_BYTES (8 MiB), und bewusst ohne „\n".
      process.stdout.write('x'.repeat(9 * 1024 * 1024));
      return;
    }
    if (mode === 'paginate') {
      if (!params || !params.cursor) {
        reply(id, { tools: [TOOLS[0]], nextCursor: 'seite-2' });
      } else {
        reply(id, { tools: [TOOLS[1]] });
      }
      return;
    }
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    if (mode === 'slow-call') return; // nie antworten
    if (mode === 'crash-on-call') {
      process.exit(9);
      return;
    }
    if (mode === 'error-on-call') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unbekanntes Tool.' } });
      return;
    }
    if (mode === 'tool-error') {
      reply(id, { content: [{ type: 'text', text: 'Datei nicht gefunden.' }], isError: true });
      return;
    }
    const args = (params && params.arguments) || {};
    if (params && params.name === 'add') {
      reply(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }], isError: false });
      return;
    }
    reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }], isError: false });
    return;
  }

  // Unbekannte Methode: JSON-RPC verlangt eine Antwort, wenn eine id da ist.
  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unbekannte Methode ${method}.` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        process.stderr.write(`fake-mcp: unlesbare Zeile: ${line}\n`);
      }
    }
    newline = buffer.indexOf('\n');
  }
});

// Ohne stdin endet der Prozess von selbst — das ist der freundliche Weg des
// Schließens. Ein Server, der ihn ignoriert, muss hart beendet werden.
if (mode === 'ignore-eof') {
  setInterval(() => {}, 1000);
}
