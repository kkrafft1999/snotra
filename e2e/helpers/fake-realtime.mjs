// OpenAI's realtime transcription, played by a local WebSocket server (#859).
//
// Speaks just enough of the protocol for live voice input: answers the
// session.update, turns loud audio into word deltas of a scripted sentence,
// and settles the sentence on a commit — capitalised and with a full stop, as
// the real model would. The app is pointed here by swapping the WebSocket
// constructor in main (see `routeRealtime`); nothing reaches OpenAI.
//
// Plain `node:http` and hand-made frames: the repository has no WebSocket
// server library, and the few frame types needed fit in a screen.

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** One frame off the front of `buffer`, or null while it is incomplete. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, rest: buffer.subarray(offset + maskBytes + length) };
}

function rmsOf(base64) {
  const bytes = Buffer.from(base64, 'base64');
  let squares = 0;
  const count = bytes.length >> 1;
  for (let i = 0; i < count; i += 1) {
    const value = bytes.readInt16LE(i * 2) / 32768;
    squares += value * value;
  }
  return count ? Math.sqrt(squares / count) : 0;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.sentences] spoken in turn, one per committed turn
 * @param {'normal'|'drop-after-first'|'silent'} [options.mode] drop the connection once the
 *   first turn is settled; or hear nothing at all, for a test that pushes the transcript itself
 */
export async function startFakeRealtime({
  sentences = ['kannst du die readme kürzen', 'und die screenshots neu machen'],
  mode = 'normal',
} = {}) {
  const connections = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = { url: req.url, auth: req.headers.authorization, events: [], closed: false };
    connections.push(connection);
    const send = (event) => {
      if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(event)));
    };

    let itemNo = 0;
    let sentenceNo = 0;
    let wordsSent = 0;
    let loudChunks = 0;
    let settled = 0;
    const itemId = () => `item_${itemNo}`;
    const words = () => sentences[sentenceNo % sentences.length].split(' ');

    function onEvent(event) {
      connection.events.push(event);
      if (event.type === 'session.update') {
        send({ type: 'session.updated', session: event.session });
      } else if (mode === 'silent') {
        // Connected, and nothing more.
      } else if (event.type === 'input_audio_buffer.append') {
        if (rmsOf(event.audio) < 0.01) return;
        loudChunks += 1;
        // A word every 300 ms of speech.
        if (loudChunks % 3 === 0 && wordsSent < words().length) {
          send({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: itemId(),
            content_index: 0,
            delta: (wordsSent ? ' ' : '') + words()[wordsSent],
          });
          wordsSent += 1;
        }
      } else if (event.type === 'input_audio_buffer.commit') {
        if (wordsSent === 0) {
          send({ type: 'error', error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'buffer too small', event_id: event.event_id } });
          return;
        }
        const id = itemId();
        const text = words().join(' ');
        send({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: itemNo ? `item_${itemNo - 1}` : null });
        send({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: id,
          content_index: 0,
          transcript: `${text[0].toUpperCase()}${text.slice(1)}.`,
        });
        itemNo += 1;
        sentenceNo += 1;
        wordsSent = 0;
        loudChunks = 0;
        settled += 1;
        if (mode === 'drop-after-first' && settled === 1) {
          setTimeout(() => socket.destroy(), 50);
        }
      }
    }

    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (let frame = decodeFrame(buffer); frame; frame = decodeFrame(buffer)) {
        buffer = frame.rest;
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame('', 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload.toString(), 0xa));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        try {
          onEvent(JSON.parse(frame.payload.toString('utf8')));
        } catch { /* not JSON */ }
      }
    });
    socket.on('close', () => { connection.closed = true; });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    connections,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Points the app's realtime connection at the fake, in the running main process. */
export async function routeRealtime(app, port) {
  await app.evaluate((_electron, target) => {
    const Native = globalThis.WebSocket;
    globalThis.WebSocket = class extends Native {
      constructor(url, options) {
        const { search, pathname } = new URL(url);
        super(`ws://127.0.0.1:${target}${pathname}${search}`, options);
      }
    };
  }, port);
}

/**
 * The microphone, played from a WAV in a loop. Not Chromium's fake capture
 * device: on macOS a capture is granted to the app that launched the process,
 * and a test started from an editor or an agent without microphone access
 * waits for `getUserMedia` for ever. Everything after it — the worklet, the
 * resampling to 24 kHz, IPC, the turn detection — runs as with a real one.
 */
export async function feedMicrophone(page, wav) {
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(bytes.buffer);
    navigator.mediaDevices.getUserMedia = async () => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      return destination.stream;
    };
  }, wav.toString('base64'));
}

/**
 * A WAV that sounds like speech to a level meter: bursts of a warbling tone
 * with a syllable rhythm, then a pause long enough to end a turn. Chromium's
 * fake microphone plays it in a loop.
 */
export function speechLikeWav({ sampleRate = 48000, bursts = 3, speakMs = 2400, pauseMs = 1400 } = {}) {
  const perBurst = Math.round((sampleRate * (speakMs + pauseMs)) / 1000);
  const speak = Math.round((sampleRate * speakMs) / 1000);
  const samples = new Int16Array(perBurst * bursts);
  for (let i = 0; i < samples.length; i += 1) {
    const at = i % perBurst;
    if (at >= speak) continue;
    const time = at / sampleRate;
    const syllables = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time);
    const pitch = 180 + 40 * Math.sin(2 * Math.PI * 3 * time);
    const voice = Math.sin(2 * Math.PI * pitch * time) + 0.5 * Math.sin(2 * Math.PI * pitch * 2.1 * time)
      + 0.25 * Math.sin(2 * Math.PI * pitch * 3.3 * time);
    samples[i] = Math.round(voice * syllables * 0.22 * 32767);
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
