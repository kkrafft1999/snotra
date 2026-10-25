# Relay conformance

The mobile remote's relay (epic [#1081](https://github.com/kkrafft1999/snotra/issues/1081))
is built and deployed in [snotra-promotion#165](https://github.com/kkrafft1999/snotra-promotion/issues/165).
This folder holds what holds it to [`docs/remote/remote-protocol.md`](../../docs/remote/remote-protocol.md)
part 1 (pairing) and part 2 (the channel), from this repository's side
([#1135](https://github.com/kkrafft1999/snotra/issues/1135)):

| File | What it is |
| --- | --- |
| [`relay-conformance.mjs`](./relay-conformance.mjs) | The runner. Drives the desktop through the bridge's own Firebase adapter and channel crypto and the phone through the reference phone, against the relay it is given, and stops at the first step the relay does not pass. |
| [`reference-phone.js`](./reference-phone.js) | The phone's half of the protocol over the relay's real interface — pairing, then token, streams, handshake and envelopes — computed with the reference implementations in [`scripts/remote-protocol-vectors.js`](../../scripts/remote-protocol-vectors.js) and [`scripts/remote-protocol-channel-vectors.js`](../../scripts/remote-protocol-channel-vectors.js), not with the bridge's code, so that the two sides come from two implementations. It streams its nodes by REST; the iPhone app will use the SDK. |
| [`relay-stand-in.js`](./relay-stand-in.js) | A small HTTP stand-in for the relay: endpoints, Identity Toolkit and the database's REST interface — reads, writes, the server's timestamp and streaming — with the conditions of snotra-promotion's `relay/database.rules.json`. `npm test` runs the runner against it ([`test/remote-relay-conformance.test.js`](../../test/remote-relay-conformance.test.js)), so that runner and phone do not rot between two bumps of the pin over there. |

The desktop's own channel, `src/application/remote/remote-channel.js`, is held
to the reference phone through the stand-in in
[`test/remote-channel-end-to-end.test.js`](../../test/remote-channel-end-to-end.test.js).
The runner plays the desktop's side of the channel itself, step by step: it
holds the relay to the spec, and it stays within the folders listed at the end.

The runner knows no path of snotra-promotion. That repository's CI checks
this one out at the commit it pins, starts the Firebase emulator with its
relay and calls the runner — the direction rule of
[`task-management.md`](../../.claude/rules/task-management.md) holds both ways.

## Running it

```sh
node e2e/remote/relay-conformance.mjs \
  --relay-url http://127.0.0.1:5001/<project>/europe-west1/relay/v1 \
  --database-url 'http://127.0.0.1:9000/?ns=<instance>' \
  --identity-toolkit-url http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1 \
  --api-key <any key the emulator takes> \
  --app-check-token <the emulator's App Check debug token>
```

Node 24 and nothing else: no `npm install`, no Electron.

| Argument | Environment | | What it is |
| --- | --- | --- | --- |
| `--relay-url` | `SNOTRA_RELAY_URL` | required | The endpoints' base, ending in `/v1` (§5.1) |
| `--database-url` | `SNOTRA_RELAY_DATABASE_URL` | required | The Realtime Database. The emulator's carries `?ns=<instance>`; the path goes before that query |
| `--api-key` | `SNOTRA_RELAY_API_KEY` | required | The web API key, for the Identity Toolkit |
| `--app-check-token` | `SNOTRA_RELAY_APP_CHECK_TOKEN` | required | Sent as `X-Firebase-AppCheck` on the phone's calls. An emulator debug token — never one registered in production |
| `--identity-toolkit-url` | `SNOTRA_RELAY_IDENTITY_TOOLKIT_URL` | optional | The Auth emulator's; Google's by default |
| `--relay-host` | `SNOTRA_RELAY_HOST` | optional | The host the QR code would name; the relay URL's host by default |
| `--wait-ms` | `SNOTRA_RELAY_WAIT_MS` | optional | How long a stream — the desktop's or the phone's — may take to show a change; 10,000 by default |

Arguments win over the environment; both `--flag value` and `--flag=value`
work.

**Output.** One line per step passed (`ok    pair: a second claim is refused (§5.5)`),
then a summary. A failure is one line on stderr — `FAIL  <step>: <what the
spec wanted, and what came back>` — with the HTTP status and the relay's
`reason`. Tokens never appear in either, not even inside a URL.

| Exit code | Means |
| --- | --- |
| `0` | Every step passed |
| `1` | A step failed, or the relay could not be reached |
| `2` | An argument is missing or unknown; the usage follows on stderr |

## What it checks

Five scenarios, each step named after the section of the spec it holds the
relay to:

- **pair** — open (§5.2, §5.3), the desktop's stream of `meta` (§5.10), a look-up
  without App Check refused (`401`), a claim with a proof that does not verify
  refused (`403`), the claim (§5.5) with `MAC_P` checked by the desktop (§6),
  a second claim refused (`404`), the claimed pairing no longer found (`404`),
  the same safety phrase on both sides (§7); before `paired` the phone reads
  `meta` but neither its inbox nor the desktop's handshake, gets no token
  (`403`) and may not confirm (`403`); confirm (§5.6) and a second confirm
  refused (`409`); `MAC_D` checked by the phone; once `paired` the phone reads
  its inbox but never the desktop's inbox or the channel node (#1142), and gets
  a fresh token (§5.9); a restarted desktop removes the phone with a token of
  its own (§5.8, §5.9), its stream sees `meta` vanish, and the deleted channel
  gives no token (`404`).
- **cancel** — the desktop cancels (§5.7); the pairing is not found any more.
- **disconnect** — pair, then the phone deletes the channel (§5.8); the
  desktop's stream sees `meta` vanish; a second delete finds nothing (`404`).
- **channel** (part 2) — pair; before `paired` the phone may write neither
  its handshake, nor an envelope, nor its presence. Once paired both sides
  get a token and follow their four nodes (§12); each side's heartbeat
  reaches the other stamped with the server's time. The phone may not write
  into its own inbox, the desktop's handshake or presence, a heartbeat or an
  envelope without the server's time, the presence record from before the
  heartbeat (#1227), or an envelope under a malformed counter, and reads
  neither its own handshake nor its own presence
  back. A handshake that offers only an unknown version is answered
  `protocol-unsupported` (§13); a real one gives both sides the same session
  (§14). `session.hello` goes to the desktop and its answer back, each opened
  and deleted by its receiver (§15, §17); an envelope is never overwritten and
  the sender cannot delete it, and the desktop gets it as first written. A
  second handshake makes a new session with an id of its own, starting at
  envelope 0. Presence goes on both sides; the phone deletes the channel and
  the desktop's stream of `meta` sees it vanish.
- **rules** — a challenge is taken once (`403` the second time, §5.2), a body
  over 4 KiB is refused (`413`, §5.1), an unknown pairing id is not found.

A database refusal may come as `401` or `403`; the Realtime Database answers
`401 Permission denied`. The rules scenario leaves one open pairing behind,
which the relay's clean-up removes after five minutes.

Not covered: the rate limit (`429`), the clean-up itself, and what the
relay's rules leave to the clients — the order rule of §16, a tag that does
not verify, the JSON-RPC inside the envelopes. Those are the desktop's
decisions, held to the reference phone in
[`test/remote-channel-end-to-end.test.js`](../../test/remote-channel-end-to-end.test.js).
Before the channel is removed, the runner closes the channel streams of both
sides: which stream hears first that a channel is gone is the database's
choice, and only the stream of `meta` is held to it (§12).

## What snotra-promotion's checkout needs

The runner loads files from these folders and nothing else, so a sparse
checkout at the pinned commit needs them next to the protocol folders it
already takes. Part 2 added none. They are folders because `actions/checkout` checks out sparse in
cone mode, which takes no single files:

```
e2e/remote
scripts
src/main/remote
src/shared/contracts/remote
src/shared/runtime
```
