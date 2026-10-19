# Relay conformance

The mobile remote's relay (epic [#1081](https://github.com/kkrafft1999/snotra/issues/1081))
is built and deployed in [snotra-promotion#165](https://github.com/kkrafft1999/snotra-promotion/issues/165).
This folder holds what holds it to [`docs/remote-protocol.md`](../../docs/remote-protocol.md)
part 1 (pairing), from this repository's side ([#1135](https://github.com/kkrafft1999/snotra/issues/1135)):

| File | What it is |
| --- | --- |
| [`relay-conformance.mjs`](./relay-conformance.mjs) | The runner. Drives the desktop through the bridge's own Firebase adapter and the phone through the reference phone, against the relay it is given, and stops at the first step the relay does not pass. |
| [`reference-phone.js`](./reference-phone.js) | The phone's half of the protocol over the relay's real interface, computed with the reference implementation in [`scripts/remote-protocol-vectors.js`](../../scripts/remote-protocol-vectors.js) — not with the bridge's code, so that the two sides come from two implementations. |
| [`relay-stand-in.js`](./relay-stand-in.js) | A small HTTP stand-in for the relay: endpoints, Identity Toolkit and the database's REST interface with the read rules. `npm test` runs the runner against it ([`test/remote-relay-conformance.test.js`](../../test/remote-relay-conformance.test.js)), so that runner and phone do not rot between two bumps of the pin over there. |

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
| `--wait-ms` | `SNOTRA_RELAY_WAIT_MS` | optional | How long the desktop's stream may take to show a change; 10,000 by default |

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

Four scenarios, each step named after the section of the spec it holds the
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
- **rules** — a challenge is taken once (`403` the second time, §5.2), a body
  over 4 KiB is refused (`413`, §5.1), an unknown pairing id is not found.

A database refusal may come as `401` or `403`; the Realtime Database answers
`401 Permission denied`. The rules scenario leaves one open pairing behind,
which the relay's clean-up removes after five minutes.

Not covered yet: the rate limit (`429`), the clean-up itself, and part 2 of
the spec — handshake, envelopes and presence — which follows once the bridge
has its channel.

## What snotra-promotion's checkout needs

The runner loads files from these folders and nothing else, so a sparse
checkout at the pinned commit needs them next to the protocol folders it
already takes. They are folders because `actions/checkout` checks out sparse in
cone mode, which takes no single files:

```
e2e/remote
scripts
src/main/remote
src/shared/contracts/remote
src/shared/runtime
```
