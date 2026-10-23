# Remote interface: decision record

Architecture decision record for
[#989](https://github.com/kkrafft1999/snotra/issues/989) (AR-14 of the
[architecture review](./architecture-review.md)), written on 2026-10-17 against
`main` at `b320911`. **Status:** accepted for everything marked as decided;
the points in [§11](#11-open-decisions) are the owner's and stay open until
the owner decides them. Nothing of it is built yet.

It settles, before any code is written, how a front end that is not the app
window reaches the core: transport and framing, the message catalogue,
identity and trust, and the threat model. Two kinds of front end are in view:

- **local programs** — a CLI, a headless mode, scripts, the reference client
  of the end-to-end tests — over **localhost**;
- **the iPhone app** of the mobile remote, over the **blind relay** of
  [its concept](https://github.com/kkrafft1999/snotra-mobile/blob/main/docs/mobile-remote-concept.md)
  ([#1081](https://github.com/kkrafft1999/snotra/issues/1081)).

The wire format in full detail, with examples and test vectors, is
[`remote-protocol.md`](./remote-protocol.md): part 1, pairing (#1112), and
part 2, the channel (#1113), both since 2026-10-18. This record is what that
specification must not contradict.

## 1. Context

**What exists.**

- **One API, and it is Electron IPC.** [`src/shared/ipc-channels.js`](../src/shared/ipc-channels.js)
  defines 114 request and 32 push channels (105 and 29 when the review counted
  at `c66b3c5`), [`manual-channels.js`](../src/shared/manual-channels.js)
  another 6 and 4 for the manual window. They are string constants; what a
  channel carries is a comment and, where one exists, a normalizer in
  `src/shared/contracts/`. There is no schema per channel and no version —
  preload and main always ship together, so they never needed one. Errors come
  in at least five shapes: thrown errors, `createSettingsError`, `{ error }`
  without `ok`, reason codes, and sentences worded in main.
- **Trust means "the sender is the app window".** `guardIpcMain` in
  [`trusted-sender.js`](../src/main/ipc/trusted-sender.js) refuses every
  message whose sender is not the top frame of the app's own page (#509). For
  a socket that check has no meaning.
- **A session is a `webContents` id.** [`chat-handlers.js`](../src/main/ipc/chat-handlers.js)
  keys runs by `event.sender.id` and stops them when the window navigates,
  crashes or closes (#979). [`tool-approval-adapter.js`](../src/main/adapters/tool-approval-adapter.js)
  keeps one subscriber per `webContents` and accepts an answer only from the
  window the card went to (`approval.error.otherWindow`).
  [`request-lifecycle.js`](../src/main/ipc/request-lifecycle.js), voice input
  and the update download key their state by the sender object.
- **Some state is process-wide, not per window:** the active workspace, main's
  "chat on screen" (`chatSessionSettings.getCurrentChatId`) and the model
  preset and permission mode that `chatHistory:activate` switches with it. Two
  front ends would fight over them.
- **Loosening is confirmed by native dialogs inside IPC handlers**
  ([security concept §5](./security-concept.md#5-hard-boundaries-and-prompt-injection);
  AR-05, [#980](https://github.com/kkrafft1999/snotra/issues/980)). A remote
  front end cannot see that dialog and must never be the one to answer it.
  Some loosening had no dialog at all: `settings:setUIPrefs` switched shell
  and Python execution on, `settings:saveMcpServer` stored any command to
  start, `settings:commitSettings` turns off TLS checks for an entry. Since
  #1104 the first two go through the confirmation port, and the third is
  classified as not loosening (§7.6).
- **The conversation was the renderer's** until [#981](https://github.com/kkrafft1999/snotra/issues/981):
  it sent the whole history with every `chat:send` and wrote the chat back
  with `chatHistory:upsert`. Since #981 `chat:send` carries the question and
  the chat id, and the core's conversation service keeps, saves and names the
  chat; `chat:send` still answers only when the run is over, and the renderer
  still settles what it draws with the run-end marker and a grace of 10 s
  (#721).
- **The security concept puts local processes running with the user's rights
  outside the protection goal** (§5). A listener on localhost is the first part
  of Snotra that such a process — and a web page in the user's browser — can
  talk to.

**What has to be served.**

- [`quality-requirements.md`](./quality-requirements.md): **CORE-1** — a new
  front end adds driving adapters and its own composition root, nothing else;
  **SEC-5** — only loopback connections, only with a credential the app
  issued, no listening socket on any other interface; **SEC-6** — the relay
  sees ciphertext only, one phone, and from the phone only *allow once* or
  *deny*; and the rule *Remote control stays on the machine — or goes end to
  end*.
- The ground rules R1–R8 of the mobile concept, its message sketch (§7), and
  what it asks of this record (§4.1): a channel catalogue with request,
  response, push and error schemas, and a connection id in place of the
  `webContents` id.

## 2. Decision drivers

In the order of the quality goals:

1. **Agent security.** A remote front end can do no more than the user at the
   desktop allowed, can never loosen a protection, and the agent's own
   processes cannot reach it.
2. **Usability.** A CLI finds the interface without configuration and can be
   driven with `curl`; every state reaches the client — connected, busy,
   refused, waiting for an approval.
3. **Privacy.** Off by default: nothing listens before the user turns it on.
4. **Robust operation.** A reconnect loses nothing it cannot get back; nothing
   ends without a final state.
5. **Separable core.** The protocol speaks the core's language — workspaces,
   chats, runs, approvals — not the window's: menus, frames, view bounds.

Binding as well: the same behaviour on macOS, Windows and Linux, and few
dependencies (two runtime dependencies today, quality requirements §2).

## 3. The decision in brief

1. **One protocol, two transports.** A message layer — JSON-RPC 2.0 with the
   profile of [§6](#6-message-layer) — runs over a **local transport** (HTTP
   and server-sent events on loopback) and over the **relay transport** of the
   mobile concept. The messages are the same on both; only the
   authentication differs.
2. **Not a tunnel of the IPC channels.** The protocol is a small surface of
   14 methods and 11 events on the core's concepts. Every IPC channel is
   classified ([§8.3](#83-every-ipc-channel-classified)): mapped, mapped once
   a prerequisite lands, or desktop only. Window mechanics, native UI,
   settings, secrets, updates, voice, file operations and every loosening stay
   at the desktop.
3. **Local: loopback, a random port, a credential in a 0600 file**, new on
   every start. Host allowlist, `Origin` refused, the credential only in the
   `Authorization` header — against DNS rebinding and cross-site requests.
   Off by default.
4. **A connection replaces the window as the session.** The adapter that
   accepts a connection mints its `connectionId` and fixes its **kind** —
   `desktop`, `local` or `relay` — from the way it authenticated, never from
   anything the client says. The core keys subscriptions and approvals by
   connection, and runs by chat.
5. **Approvals are offered per connection and answered per kind.** A card
   goes to every connection subscribed to its chat; the first valid answer
   wins and the others receive `approval.resolved`. `local` and `relay`
   answer *allow once* or *deny*; anything else from them is refused in the
   core (#980).
6. **The agent's own processes are in scope.** Local processes in general
   stay outside the protection goal. The commands, interpreters and MCP
   servers Snotra starts itself do not: a command that reaches the interface
   could approve the agent's next call. The sandbox already denies reading
   Snotra's own folder; the credential never enters a child's environment,
   and the domain proxy refuses loopback.
7. **Prerequisites by method:** watching chats needs only the remote
   dispatcher; writing into a chat needs #981; answering approvals needs #980;
   a headless process serving the protocol needs
   [#983](https://github.com/kkrafft1999/snotra/issues/983).

## 4. Layers

```
front ends      app window            CLI · headless · scripts        iPhone app
                    │ IPC                    │ HTTP + SSE                │ encrypted envelopes
transports      Electron IPC adapter    local transport (loopback)    relay transport (Firebase)
                    │                        └────────────┬──────────────┘
                    │                    remote dispatcher: JSON-RPC 2.0 profile,
                    │                    method table per kind, normalizers
                    │                                     │
                    └─────────── connection { id, kind } ─┘
core            conversation service (#981) · approval broker · confirmation port (#980)
```

**The window keeps its IPC channels.** Its adapter registers the window with
the core as a connection of kind `desktop`, so that the core has one notion of
a front end, but the renderer does not move onto the protocol. The protocol
covers a fraction of what the window needs; moving the window would mean
designing all of IPC again for no gain in security. Channels the protocol
covers may move later if both sides would then share one dispatcher; nothing
here depends on it.

Where the pieces go, once built: the protocol's constants and normalizers in
`src/shared/contracts/remote/` (as the mobile concept names it), the
transports and the dispatcher in `src/main/remote/`, the decisions — who may
see, answer and send what — in `src/application/`, behind ports.

## 5. Local transport

### 5.1 Options

| Option | Reachable from a web page | Other users of the machine | Parser on the attack surface | Dependencies | Clients | Server to client |
| --- | --- | --- | --- | --- | --- | --- |
| **A. HTTP/1.1 + SSE on `127.0.0.1` / `[::1]`** *(decided)* | yes — needs the checks of §5.3 | credential only | Node's own `http` | none | any HTTP client, `curl` | SSE stream |
| B. WebSocket on `127.0.0.1` / `[::1]` | yes — the handshake needs the same checks | credential only | RFC 6455 framing: `ws`, or written by hand | one more, or a hand-written frame parser | most languages; not `curl` | native |
| C. Unix socket (macOS, Linux), named pipe (Windows), NDJSON | no | file permissions on macOS and Linux; on Windows Node cannot set the pipe's ACL, and a pipe name can be taken first by another process | a line reader of our own | none | Node, Python, Go, Swift; `curl` only with HTTP on top | native |
| D. stdio | — | — | — | none | only a child the app starts itself | native |

**Decided: A.** Reasons:

- **Nothing new parses hostile input.** Requests are read by Node's HTTP
  parser and `JSON.parse`. B needs either a dependency or a hand-written frame
  parser on an attack surface — the review's pattern *self-built instead of a
  library* in its most expensive place.
- **No dependency.** `http`, `crypto` and `fs` are enough.
- **Every client can drive it.** `curl` and every language's HTTP client; a
  CLI needs no client library, and a failure can be reproduced by hand.
- **The traffic fits.** Requests are short — sending a message starts a run
  and answers at once — and what streams goes from server to client, which is
  what SSE is for.
- **The same on all three platforms**, unlike C, and within SEC-5 as the owner
  agreed it (*connections over the loopback interface*).

B loses on the parser and the dependency; it comes back into question only if
a front end needs fast client-to-server streaming, which nothing in view does
(voice stays at the desktop, [§8.3](#83-every-ipc-channel-classified)). C is
the stronger isolation on macOS and Linux — no browser can reach a Unix
socket — but it behaves differently per platform and needs the credential on
Windows anyway; it can be added later as a second local transport carrying the
same messages. D is no way to reach a running app. A CLI that composes the
core in its own process (CORE-1) needs no transport at all; this record is for
programs that drive an app that is already running.

### 5.2 Finding the interface, and the credential

- **Off by default.** Nothing listens until the user switches the local
  interface on (where: [O1](#11-open-decisions)), or until a headless process
  is started with the switch on its command line.
- **Loopback only.** The listener binds `127.0.0.1` and, where the system has
  it, `[::1]`, on a port the system picks. Never `0.0.0.0`, `::` or a host
  name. After binding, the listener checks the address it got and stops if it
  is not loopback.
- **One discovery file**, `remote/local.json` in Snotra's user-data folder:
  the folder `0700`, the file `0600`, written to a temporary file and renamed
  over the old one (ROB-5). On Windows the mode bits mean nothing; there the
  per-user ACL of the profile folder protects it.

  ```json
  {
    "protocol": [1],
    "url": "http://127.0.0.1:53817",
    "token": "<256 random bits, base64url>",
    "pid": 4711,
    "startedAt": "2026-10-17T09:30:00.000Z"
  }
  ```

- **The token is new on every start** of the listener and on *Disconnect all*;
  the file is deleted on a clean shutdown. A file left behind by a crash names
  a token that nothing accepts any more.
- **How the token is handled.** Compared in constant time
  (`crypto.timingSafeEqual`). Never logged, never in an error, never in a URL,
  never in the environment of a process Snotra starts. It is added to Snotra's
  own secrets ([`own-secrets.js`](../src/main/services/own-secrets.js)), so a
  tool result that prints it is held back from the model like an API key.
- **A client reads the file at every connect** and sends the token only to
  the URL the file names — never to a port it found some other way, which
  could belong to a program that took the port after a crash.

### 5.3 Requests, events, and the checks in front of them

Two endpoints, nothing else:

- `POST /v1/rpc` — the body is one JSON-RPC request, the answer one JSON-RPC
  response. HTTP `200` for results and JSON-RPC errors alike; HTTP status codes
  only for what fails before dispatch.
- `GET /v1/events` — the connection's event stream (SSE). Every event carries
  `id: <seq>` and one JSON-RPC notification as `data`; `Last-Event-ID` resumes.

Every request passes these checks, in this order, in one place before
anything is dispatched — the way `guardIpcMain` sits in front of every IPC
handler:

1. The peer address is loopback.
2. **`Host`** is exactly `127.0.0.1:<port>`, `[::1]:<port>` or
   `localhost:<port>`; otherwise `403`. A page that rebinds its own name to
   `127.0.0.1` still sends its own name here.
3. **No `Origin`, no `Sec-Fetch-Site`, no `Sec-Fetch-Mode`**; otherwise `403`.
   A browser sends them with every cross-site request a page makes, and page
   script cannot leave them out. No Snotra client sends them.
4. **`Authorization: Bearer <token>`** matches; otherwise `401`, after a fixed
   delay. Repeated failures close the listener for a minute and leave a notice
   for the user (#1001).
5. `POST` only with `Content-Type: application/json` — never a request a page
   could send without a preflight — and a body of at most 1 MiB.
6. After `session.hello`, every request names its connection in
   `Snotra-Connection: <connectionId>`, and the connection belongs to this
   token's listener.
7. The answer never carries an `Access-Control-Allow-*` header, a cookie or a
   redirect. A path other than the two above gets `404` without a body.

### 5.4 The life of a local connection

1. `POST /v1/rpc` with `session.hello` returns the `connectionId`.
2. `GET /v1/events` with that id opens the stream. The connection counts as
   present while its stream is open.
3. **A dropped stream** keeps the connection, its subscriptions and up to
   30 s of its events. Reconnecting with `Last-Event-ID` delivers the gap; if
   the gap is no longer held, the first event is `session.resync`, and the
   client opens its chats again.
4. **It ends** with `session.bye`, when the 30 s pass without a stream, when
   the token changes, when the listener is switched off and when the app
   quits — each announced by `session.closing` where the stream is still
   open. Its subscriptions go with it; what happens to its approvals is in
   [§7.4](#74-approvals-per-connection).

At most four local connections at a time; a fifth `session.hello` is refused
with `busy`.

## 6. Message layer

### 6.1 JSON-RPC 2.0, profiled

- **Requests** `{ "jsonrpc": "2.0", "id": 7, "method": "chat.open", "params": { … } }`.
  `params` is always an object. Answers carry `result` or `error`.
- **Events** are notifications from the server:
  `{ "jsonrpc": "2.0", "method": "chat.delta", "params": { … } }`, numbered by
  the SSE `id` locally and by the envelope counter on the relay.
- **Everything a client sends gets an answer.** Notifications from the client
  and batches are not accepted — unlike `chat:abort` and `voice:audio`, which
  the window fires without waiting.
- **Names** follow the mobile concept's sketch: `noun.verb` for methods,
  `noun.event` for events.
- **Fields.** Unknown fields are ignored on both sides. Each method's
  normalizer takes over the fields it knows one by one, as `chat:send` does
  today, so nothing unknown reaches the core.

JSON-RPC rather than an envelope of our own: it is a standard Snotra already
speaks (the MCP transports are JSON-RPC), it has error codes for the cases
every protocol needs, and clients exist in every language. What it lacks —
events with a sequence, resuming, kinds of connection — the profile adds.

### 6.2 Versions

- The protocol has an integer version, starting at `1`. A new method, a new
  optional field or a new event does not change it; removing something or
  changing what it means does.
- `session.hello` names the versions the client speaks; the server takes the
  highest it shares, or answers `protocol-unsupported` with its own list, which
  the client shows (mobile concept §5.2).
- The answer to `session.hello` lists the methods this connection may call, so
  that a client hides what it cannot do instead of failing on it — the parity
  rule's *show the gap*.

### 6.3 Errors

One shape for everything that goes wrong after dispatch. The dispatcher turns
each of the shapes IPC uses today into it, so that a client has one path
for failure:

```
error: { code: int, message: string, data: { reason: string, message: { key, params } } }
```

- `data.message` is the descriptor of
  [`message.js`](../src/shared/contracts/message.js), keyed into the
  catalogue (#293). A client with a catalogue of its own — the phone —
  translates the key.
- `message` is the same sentence already worded in the connection's language
  from `session.hello`, for a client without a catalogue; a CLI prints it.
- Never a stack, never a secret, never a path outside the workspace.

| Code | `reason` | When |
| --- | --- | --- |
| −32700, −32600, −32601, −32602, −32603 | `parse`, `invalid-request`, `unknown-method`, `invalid-params`, `internal` | JSON-RPC's own; `invalid-params` when a normalizer refuses |
| −32001 | `refused` | Not allowed for this kind of connection: a desktop-only method, an approval option beyond *allow once* and *deny* |
| −32002 | `not-found` | The chat, workspace or request does not exist **or is not visible** to this connection — one answer for both, so that ids cannot be probed |
| −32003 | `busy` | Refused because of state: switching the workspace during a run (R6), a message into a chat that is still running, a fifth connection |
| −32004 | `unavailable` | The feature behind the method is off or not built yet, the app is quitting |
| −32005 | `too-large` | Over a limit |
| −32006 | `rate-limited` | Too many requests |
| −32010 | `protocol-unsupported` | No shared version |
| −32011 | `connection-unknown` | The connection id is stale; say `session.hello` again |

### 6.4 Binary payloads

- **The first version carries none.** Images in a chat arrive as a placeholder
  (*Image — open it on the desktop*, mobile concept §7); voice input stays at
  the desktop.
- **When bytes come**, they travel inside JSON as `{ mime, base64 }` — the
  shape `fs:readWorkspaceImage` already uses — with a cap per message (4 MiB
  decoded locally; on the relay what the envelope limit allows, so images as
  thumbnails) and ranged reads (`offset`, `length`) for anything larger. No
  binary frames, no second framing: the relay carries JSON in encrypted
  envelopes, and the local transport stays the same. Today's IPC binaries —
  PDFs as `Uint8Array` up to 50 MB, voice chunks, Whisper uploads — stay on
  IPC.
- Bytes from the workspace are never read on a client's word alone: an image
  read keeps the checks main makes today — type, size, symlink escape.

### 6.5 Order, and the end of a run

- **Events of one connection are in order.** Answers and events are not
  ordered against each other — the lesson of #721. `message.send` answers with
  the `runId` as soon as the run is accepted, and the run is over when, and
  only when, `chat.progress` with `type: "run-end"` arrives for that `runId`.
  No grace timer on the client.
- **A client takes events for a `runId` it has not been told about yet** and
  holds them for that chat.
- **Streamed text is batched** per chat by the transport: every 150 ms on the
  relay (mobile concept §7), every 50 ms locally. A client that lost deltas
  opens the chat again and gets a snapshot.

## 7. Identity and trust

### 7.1 The connection

`connection = { id, kind, client, locale, capabilities, subscriptions }`

- **`id`** — 128 random bits, base64url, minted by the adapter: at
  `session.hello` locally, at the end of the encrypted handshake on the relay,
  and for the window once per loaded page (a reload is a new connection,
  which is what #979 already assumes). Never reused, and it means nothing.
- **`kind`** — fixed by the adapter from how the connection authenticated:
  `desktop` (IPC from the app window, past `guardIpcMain`), `local` (the local
  transport's token), `relay` (the encrypted channel with the paired phone).
  No field in any message sets or changes it.
- **`client`** — name and version from `session.hello`, shown to the user and
  never trusted: a lie there gains nothing.

### 7.2 What replaces the sender frame URL

| Today | From now on |
| --- | --- |
| `isTrustedIpcSender`: the top frame of the app's page | Stays, as the gate of the IPC adapter |
| — | The local transport's checks ([§5.3](#53-requests-events-and-the-checks-in-front-of-them)) |
| — | The relay transport's handshake (mobile concept §5.2) |
| The window is trusted because it can confirm natively | The kind `desktop`, and the confirmation port (#980): only a `desktop` connection can lead to a confirmation with the user present |

The core never sees a URL, a frame or a socket — only the connection and its
kind. Each adapter has one gate in front of its dispatch, as `guardIpcMain` is
one place at registration that no handler can forget.

### 7.3 What replaces the `webContents` id

| Where | Keyed by today | Keyed by then |
| --- | --- | --- |
| Runs in the engine (`activeRuns`, `abort(sessionId, chatId)`) | window and chat | **chat**: the conversation service owns the run, and a front end that leaves does not end it (#981) |
| A run's events (`forwardEvent(event.sender, …)`) | the window that sent the turn | every connection subscribed to the chat |
| Approval subscribers | `webContents` | connection |
| Who may answer a card (`approval.error.otherWindow`) | the same window | a connection subscribed to the card's chat, of a kind that may give that answer |
| Cancelling a request (`request-lifecycle.js`) | the sender object | the connection |
| Stopping runs on reload or crash (#979) | events of the window | the window's connection ends; once #981 owns the runs, the reloaded page opens its chats again and finds them running |
| "The chat on screen" (`getCurrentChatId`) and the global preset and mode it switches | one per process | stays the **desktop's** screen state; a remote `chat.open` never changes it, and a remote turn runs with its own chat's model, mode and level — a requirement on #981 |

### 7.4 Approvals per connection

1. **The request is bound as today** — a random `requestId`, its chat, its
   run, the plan key and the policy version.
2. **It is offered** to every connection subscribed to its chat that declared
   the `approvals` capability. A connection that subscribes later finds it in
   the snapshot of `chat.open`.
3. **Each kind sees only its options.** `desktop`: what the card offers today.
   `local` and `relay`: `allow-once` and `deny`. A sandbox card's choice
   between the paths or hosts it offers counts as part of *allow once*, checked
   against the offer as now; a configuration card (#774) can be answered
   too — it switches no more than a tick in the settings would, and every call
   of a tool switched on that way still asks in *Smart*.
4. **An answer is accepted** when the request is open, the connection is
   subscribed to its chat, and the option is one its kind may give. An option
   beyond that from `local` or `relay` is **refused** (`refused`), not quietly
   made into *allow once*; the quiet downgrade of today stays for the window.
5. **The first valid answer wins.** Every connection the request was offered
   to receives `approval.resolved`, naming who answered (kind and client
   name), and the chat keeps that mark next to the decision (mobile concept
   §4.1, R8): the step stores `answeredBy: { kind, client }` and the window
   shows the phone on its tool line and on the folded card (#1197). An answer
   at the desktop stores nothing.
6. **No connection that can answer** means the request expires as today
   (`no_approval_ui`). In the desktop app the window counts as subscribed to
   every chat of its workspace, so this happens only headless or when the
   window is gone; headless, the last connection's 30 s grace covers a
   reconnect. *As built (#1194):* a card still needs the window to go out —
   a phone's turn included —, and a phone that follows the chat is offered
   it besides; without a window it expires, until a headless process
   (#983) changes that.

### 7.5 What a connection may see

- **`relay`**: only the workspaces opened for remote access (mobile concept
  §5.1), and only their chats. **`local`**: [O2](#11-open-decisions).
- **No method takes a path.** Workspaces and chats are addressed by ids the
  desktop issued: a `workspaceId` that is stable for a known folder and gives
  nothing of its path away, and the `chatId` as today. An id outside what the
  connection may see answers `not-found`, like an unknown one.
- **Events go only to subscribers** of their chat. `state` says about a
  workspace that is not visible to the connection no more than that the
  desktop is busy.

### 7.6 Loosening

Never over the protocol. No method sets a mode, adds or removes a rule, drops
a sensitive pattern, opts a workspace out of the sandbox, grants a program
allowance or keeps a host, and no approval option that stores something is
reachable. The method table of the dispatcher is the first line; the one that
holds is the confirmation port of #980, whose adapters for `local` and `relay`
answer every request with *no* — the measure of SEC-6.

The catalogue below found loosening that needed no native dialog at all
(the shell and Python switches, MCP servers, insecure TLS). #1104 decided
each ([security concept §5](./security-concept.md#5-hard-boundaries-and-prompt-injection)):
switching `shell_execute` or `run_python` on and storing a local MCP command
that is new or changed now go through the same port, and the stores refuse
both without a receipt — so even a remote kind that reached a settings write
could switch neither on. "Ignore TLS certificate" is classified as not
loosening: an `http://` address needs no dialog either, and the flag gives
the agent nothing. None of these channels is on the remote surface. Who
confirms a loosening when there is no desktop at all is
[O4](#11-open-decisions).

## 8. Catalogue

### 8.1 Methods

Notation: `name: type`, `?` optional, `|` alternatives, `[]` a list. Ids are
strings; `chatId` follows `sanitizeChatId` (1–128 characters). The kinds are
`L` (local) and `R` (relay); `desktop` uses IPC. The step says what has to be
built first ([§10](#10-consequences)): **1** the dispatcher and the
release list, **2** #981, **3** #980.

| Method | Params → result | Errors | Kinds | Step | From IPC |
| --- | --- | --- | --- | --- | --- |
| `session.hello` | `{ protocol: int[], client: { name ≤64, version ≤32 }, locale?: 'en'\|'de', capabilities?: ('approvals')[] }` → `{ protocol: int, connectionId, kind: 'local'\|'relay', app: { version }, methods: string[], approvalResponses: string[], limits: { maxRequestBytes, maxTextChars, maxConnections, eventBufferSeconds } }` | `protocol-unsupported`, `busy` | L R | 1 | `update:getVersion` |
| `session.bye` | `{}` → `{}` | — | L R | 1 | — |
| `workspaces.list` | `{}` → `{ workspaces: [{ workspaceId, name, active: bool }] }` — `name` is the folder's name, never its path | — | L R | 1 | `settings:getFolderHistory`, `settings:getLastFolder`, filtered by the release |
| `chats.list` | `{ workspaceId?, limit? ≤200, before? }` → `{ chats: [{ chatId, title, updatedAt, messageCount, state: 'idle'\|'running'\|'needs-approval' }], before? }` — `title` already worded | `not-found` | L R | 1 | `chatHistory:get` + the running chats + open cards |
| `chat.open` | `{ chatId, limit? ≤100 }` → `{ chatId, title, state, messages: DisplayMessage[], before?, runId?, pendingApprovals: ApprovalRequest[] }` — subscribes; never changes the chat on the desktop's screen | `not-found`, `busy` (the connection already follows as many chats as it may) | L R | 1 (live state of a running turn and `pendingApprovals`: 2, 3) | `chatHistory:getSession`, without `chatHistory:activate` |
| `chat.more` | `{ chatId, before, limit? ≤100 }` → `{ messages: DisplayMessage[], before? }` | `not-found` | L R | 1 | `chatHistory:getSession` |
| `chat.close` | `{ chatId }` → `{}` — ends the subscription | — | L R | 1 | — |
| `workspace.activate` | `{ workspaceId }` → `{ workspaceId }` — the path comes from the release list, never from the client; the window opens it as from its menu and says so in a notice | `not-found` (also when the window could not open it), `busy` with `data.why`: `running` (a turn works or waits, R6) or `unsaved-changes` (the file on show at the desktop has unsaved changes — refused without a dialog, decided 2026-10-20); `busy` without `why` when the window did not answer in time | L R | 2 | `settings:activateFolder` |
| `chat.new` | `{ workspaceId? }` → `{ chatId }` — nothing is written until the first `message.send`; without `workspaceId`, the open workspace | `not-found`, `refused` (a workspace other than the one open at the desktop) | L R | 2 | — (today the renderer makes chats and upserts them) |
| `message.send` | `{ chatId, text ≤maxTextChars, clientMessageId ≤64 }` → `{ runId, messageId }` — a repeated `clientMessageId` answers again and starts nothing, also on a new connection; `messageId` names the question; subscribes the sender to the chat before the turn starts, as `chat.open` does, so that it hears the turn from its first event — also in a chat from `chat.new`, which `chat.open` cannot find before its question is saved (#1228) | `not-found`, `refused` (the chat's workspace is not the one open at the desktop: its tools would work there — `workspace.activate` first), `busy` (the chat is running or waits for a card, or the connection already follows as many chats as it may and not this one), `too-large`, `unavailable` (no provider set up for the chat's model) | L R | 2 | `chat:send` — the text and the chat id, not the history |
| `run.abort` | `{ chatId }` → `{ aborted: bool }` | `not-found` | L R | 2 | `chat:abort` |
| `chat.configuration` | `{ chatId }` → `{ model: { label }, mode: 'smart'\|'ask-all'\|'auto', reasoning?: string, skills: [{ name, state }], tools: [{ name, on }] }` — read only | `not-found` | L R | 2 | `chat:getConfiguration`, per chat instead of "the chat on screen" |
| `approval.list` | `{ chatId? }` → `{ requests: ApprovalRequest[] }` — the open cards of the chats the connection may see | `not-found`, `refused` (the connection did not declare `approvals`) | L R | 3 | `toolApproval:listPending` |
| `approval.respond` | `{ requestId, response: 'allow-once'\|'deny', sandboxPaths?: (string\|null)[] }` → `{ response }` — `sandboxPaths` only as a choice among the card's offers, named as the card showed them | `not-found` (not open, or not a chat this connection follows), `refused` (an option or a path beyond the kind's, or no `approvals` capability), `invalid-params` | L R | 3 | `toolApproval:respond` |

`toolApproval:subscribe` has no method of its own: declaring `approvals` in
`session.hello` and subscribing to a chat with `chat.open` together do what it
does.

**`DisplayMessage`** — what the desktop shows, not what it stores (mobile
concept §7): `{ messageId, role: 'user'|'assistant', text: Markdown,
toolLines?: [{ line, tool, status }], attachments?: [{ kind: 'image',
placeholder: true, name? }], origin?: { kind, client }, interrupted?: bool,
createdAt? }`. Tool lines are the lines the desktop shows, worded by
[`tool-display.js`](../src/shared/presentation/tool-display.js) in the
desktop's language — the history keeps no arguments to word a stored line
again, and a chat should not mix two languages (decided 2026-10-20, #1194);
no tool arguments, no schemas, no tool results. `messageId` is `m<index>`,
the message's place in the chat, and `before` in `chat.more` is such an id.
The history keeps no time per message, so `createdAt` is left out for now.
`origin` is stored with the question since #1197 —
`{ kind: 'relay', client }`, the name from `session.hello`, cleaned and cut
to 64 characters by
[`message-origin.js`](../src/shared/contracts/remote/message-origin.js) —
so a question from the phone carries it in `chat.open` and `chat.more` as
well as in `chat.message`. A question asked at the desktop has none.

**`ApprovalRequest`** — the card's DTO (`createToolApprovalRequestDto`,
`contractVersion: 1`) as the connection's kind may see it: `requestId`,
`chatId`, `runId`, `tool`, `riskClasses`, `targets` (paths inside the
workspace relative to it, a path outside as the card names it — it is what is
being approved), `reason` worded and `reasonParts`, `checkpoint`, `preview`
masked exactly as on the desktop, `sandbox` offers, and `options` — the
answers this connection may give. `sessionAllowed`, `alwaysAllowed`,
`workspaceAllowed` and the command rule are replaced by `options`.

### 8.2 Events

| Event | Params | Step | From IPC |
| --- | --- | --- | --- |
| `session.welcome` | `{ connectionId, seq }` — the first event of every stream | 1 | — |
| `state` | `{ activeWorkspaceId, running: [{ chatId, workspaceId, state }], busy: bool }` — at `session.hello` and on every change | 1 | — |
| `chat.delta` | `{ chatId, runId, text }` | 1 | `chat:delta` |
| `chat.tool-line` | `{ chatId, runId, callIndex, phase: 'pending'\|'start'\|'done', tool, line, permission?, changes?: [{ relativePath, status, added, removed }] }` — no `args`, no `schema` | 1 | `chat:tool-line` |
| `chat.progress` | `{ chatId, runId, type: 'phase'\|'reasoning'\|'workspace'\|'permission'\|'run-end', … }` — the fields of each type as in [`chat.js`](../src/shared/contracts/chat.js) | 1 | `chat:progress` |
| `chat.message` | `{ chatId, message: DisplayMessage }` — a message another front end wrote: a turn's question once it is saved, to every follower but the connection that asked, with `origin` when a remote asked | 2 | — |
| `chat.updated` | `{ chatId, title?, cost?, configurationChanged?: true }` — so far `title`, when a chat got its name | 2 | `toolPermissions:changed`, `skills:changed`, in part |
| `approval.request` | `ApprovalRequest` | 3 | `toolApproval:request` |
| `approval.resolved` | `{ requestId, chatId, response: string\|null, invalidated: bool, reason: string\|null, by?: { kind, client } }` | 3 | `toolApproval:resolved` |
| `session.resync` | `{ reason }` — the gap could not be filled; open the chats again | 1 | — |
| `session.closing` | `{ reason: 'quit'\|'listener-off'\|'token-changed'\|'unpaired'\|'idle' }` | 1 | — |

In step 1 the events of a running turn are published by chat from where
`chat-handlers.js` forwards them today; what a turn streamed before a client
subscribed is missing until #981 holds the live turn, so `chat.open` shows
the turn as of its last finished step (#979) and the deltas from then on.

### 8.3 Every IPC channel, classified

**Mapped** names the method or event; **after** names the prerequisite;
**desktop** means it stays on IPC, with the reason. Channels of one prefix are
listed together where they share their class.

| IPC channels | Class | Why |
| --- | --- | --- |
| `chatHistory:get`, `chatHistory:getSession` | mapped: `chats.list`, `chat.open`, `chat.more` | Read only; display DTOs instead of stored rows |
| `chat:delta`, `chat:tool-line`, `chat:progress` (push) | mapped: `chat.delta`, `chat.tool-line`, `chat.progress` | Published by chat to subscribers, without raw tool arguments |
| `chat:turn-started` (push) | desktop | The window following a turn another front end started (#1194, step 2b); the remote side hears of it as `chat.message` |
| `workspace:switch-requested` (push), `workspace:switch-answer` | desktop | The window opening the folder `workspace.activate` asked for, and its outcome (#1194, step 2c) |
| `settings:getFolderHistory`, `settings:getLastFolder` | mapped: `workspaces.list` | Names and ids, never paths |
| `update:getVersion` | mapped: `session.hello` | — |
| `settings:activateFolder` | mapped in step 2: `workspace.activate` | By id, and refused during a run (R6) |
| `chat:send` | after #981: `message.send` | The client sends a message, not the history, and the core keeps the turn |
| `chat:abort` | after #981: `run.abort` | Runs are keyed by window today; a remote client could not reach a run the window started |
| `chat:getConfiguration` | after #981: `chat.configuration` | Answers for main's chat on screen today, not for a given chat |
| `toolApproval:subscribe`, `toolApproval:listPending`, `toolApproval:respond` | after #980: `session.hello` capability with `chat.open`, `approval.list`, `approval.respond` | Answers only *allow once* and *deny*; loosening stays with the confirmation port |
| `toolApproval:request`, `toolApproval:resolved` (push) | after #980: `approval.request`, `approval.resolved` | — |
| `toolPermissions:changed`, `skills:changed` (push) | after #981: folded into `chat.updated` | A remote client cares about its chat's configuration, not the settings page |
| *chatHistory:upsert*, *chat:title* — removed with #981 | **never**: the core persists and titles the chat (#981) | Remote front ends do not write chat rows; the window no longer does either |
| `chatHistory:setActive`, `chatHistory:activate` | desktop | The desktop's own screen state; `activate` switches the global preset and mode |
| `chatHistory:delete` | desktop, for now ([O6](#11-open-decisions)) | Destructive |
| `chatHistory:readAttachment` | later, as `attachment.read` | Images are placeholders in the first version ([§6.4](#64-binary-payloads)) |
| `chat:file-changes` | later | The diff of what the agent changed; useful to a local client, not needed first |
| `toolPermissions:setMode`, `addRule`, `removeRule`, `setSensitivePaths`, `resetWorkspaceRules`, `resetAll`, `setWorkspaceSandbox`, `setWorkspaceMode`, `setProgramAllowance`, `addHosts`, `setNewWorkspaceSandbox`, `resetWorkspaceSandbox`, `resetSandboxEverywhere` | desktop, **never** remote | Loosening (§7.6), or a reset that can undo a tightening |
| `toolPermissions:clearSessionGrants`, `revokeSessionGrant`, `removeWorkspaceHost`, `removeGlobalHost`, `removeProgramAllowance` | desktop | They only tighten and could be offered later; nothing needs them first |
| `toolPermissions:getState`, `getSecurityOverview`, `getSandboxOverview`, `resolveProgram`, `chooseAllowanceFolder` | desktop | The settings page's view; a folder dialog |
| `settings:setUIPrefs`, `settings:commitSettings`, `settings:saveMcpServer`, `settings:deleteMcpServer`, `settings:reloadMcpServers`, `settings:testMcpServer`, `settings:setWebSearchApiKey` | desktop, **never** remote | Secrets come in here; the execution switches and a local MCP command are confirmed through the port (§7.6, #1104) |
| `settings:getLLMState`, `setActivePreset`, `setReasoningEffort`, `listModels`, `cancelModels`, `getUIPrefs`, `getToolCatalog`, `getMcpCatalog`, `getWebSearchState`, `getImageGenerationState`, `listImageModels`, `cancelImageModels`, `getPythonState`, `getShellState`, `getSkillCatalog`, `reloadSkills`, `getMemory`, `forgetMemory`, `removeFolderFromHistory` | desktop | The settings window. Choosing a chat's model from a phone is [O6](#11-open-decisions); it needs the per-chat model of #981 first |
| `skills:suggest` | desktop | A helper of the window's composer |
| `skills:makeGlobal` | desktop | Native confirmation; writes a global skill folder (#980) |
| `dialog:openFolder` | desktop | A new folder comes in only through the native dialog (#68) |
| `fs:readDirectory`, `fs:readFile`, `fs:listWorkspacePaths`, `fs:readWorkspaceImage`, `fs:readWorkspacePdf` | desktop, for now ([O5](#11-open-decisions)) | They take paths, which the protocol does not; a read-only file scope for local programs would be its own decision |
| `fs:writeFile`, `fs:moveItem`, `fs:createItem`, `fs:renameItem` | desktop | Writes chosen by the user at the window |
| `fs:inspectImport`, `fs:importItems` | desktop, **never** remote | The source lies outside the workspace and is trusted only because the preload resolved it from a dropped file (#646) |
| `fs:showFileContextMenu`, `fs:revealItem`, `ui:showPreviewHistoryMenu` | desktop | Native menus and the file manager of the desktop |
| `fs:item-deleted`, `fs:clear-agent-mark`, `fs:show-changes`, `fs:show-info`, `fs:begin-create`, `fs:begin-rename` (push) | desktop | Follow-ups of a native context menu |
| `fs:tree-changed` (push) | later, with a file scope ([O5](#11-open-decisions)) | — |
| `pdf:readAsset`, all seven `htmlPreview:*`, `htmlPreview:event` (push) | desktop | pdf.js internals; a native view over the window |
| `shell:openExternal`, `shell:writeClipboardText`, `help:openManual` | desktop | The desktop's browser, clipboard and help window; a client opens links itself |
| `approvalNotification:show`, `approvalNotification:close`, `approvalNotification:open` (push) | desktop | Notifications of the desktop; the phone's push notifications are a later phase of the mobile concept |
| `modelPrices:describe`, `setOverride`, `update` | desktop | The settings; a chat's cost reaches clients in `chat.updated` once #981 keeps it |
| `notices:list`, `notices:dismiss`, `notices:reveal`, `notices:posted`, `notices:withdrawn` (push) | desktop; `notices.list` later | They name files of the desktop's store |
| `diagnostics:report-error`, `diagnostics:copy` | desktop | The window's own errors; a client reports its own |
| `update:check`, `ignoreVersion`, `download`, `cancelDownload`, `discardDownload`, `install`, `update:available`, `update:progress` (push) | desktop | Updating the app is the desktop's business |
| `feedback:getDiagnostics`, `feedback:send` | desktop | The feedback form |
| `remote:getState`, `remote:pair:start`, `remote:pair:cancel`, `remote:unpair`, `remote:state` (push) | desktop, **never** remote | Pairing and removing the phone (#1114); a phone must not be able to pair another or remove itself through the protocol, and the *Allow* is the confirmation port's |
| `remote:getPresence`, `remote:presence` (push) | desktop | The indicator in the desktop's title bar (#1196): whether a phone is connected and the computer kept awake for it; the phone knows it is connected |
| `remote:release:get`, `remote:release:set`, `remote:release:changed` (push) | desktop, **never** remote | Which workspaces the phone sees (#1195): opening one is a loosening with a receipt, and a phone must not widen what it may see |
| `developerMode:get`, `developerMode:toggle`, `developerMode:changed` (push) | desktop, **never** remote | Developer mode (#1213) opens pairing; a phone must not open pairing for another |
| `voice:start`, `voice:audio`, `voice:stop`, `voice:cancel`, `voice:transcript` (push), `whisper:transcribe`, `whisper:cancel` | desktop | The microphone belongs to the window; a phone has its own dictation |
| all `ui:*` pushes and `ui:preview-history-choice` | desktop | Menu items and shortcuts of the window |
| all `manual:*` channels | desktop | The manual window; it is also published at docs.snotra-ai.dev |

When the catalogue becomes code, a test checks that every request and push
channel is classified, so that a new IPC channel cannot slip past this table
([§10](#10-consequences)).

## 9. Threat model

### 9.1 What is protected

The chats; the workspace files and what the agent may do with them; the
**approvals**, which let the agent act; the protections — mode, rules,
sandbox, sensitive patterns; Snotra's secrets, the new token among them; and
the user's attention, which a flood of cards would wear down.

### 9.2 Who attacks, and what holds

| Attacker | What they try | What stops it | Defended? |
| --- | --- | --- | --- |
| **Someone on the network** | Reach the listener from the LAN or beyond | Loopback only, checked after binding; the SEC-5 measure as a test | yes |
| **A web page in the user's browser** | Cross-site requests, a WebSocket-style hijack, DNS rebinding, guessing the port | `Host` allowlist, `Origin` and fetch metadata refused, the token only in a header (which forces a preflight that never succeeds), JSON only, no CORS headers, no token in a URL, a random port | yes. A page can still tell from timing that *something* listens on a port; it learns nothing more |
| **Another user of the same machine** | Connect over loopback, which is open to every account | The token in a file only the user can read; 256 bits, constant-time comparison, new on every start, repeated failures throttled and reported | yes, as long as the operating system's file permissions hold |
| **The agent's own processes** — a command, a Python script or an MCP server, steered by a prompt injection | Read the token and approve the agent's next call, or send it messages | The sandbox denies reading Snotra's folder (`sensitiveReadPaths`) and network access except through the domain proxy — on macOS the one Unix socket it opens is the SSH agent's, on Linux it opens none (only the SSH relay outside the run's seccomp filter reaches the agent, #1155); the token is never in a child's environment; the domain proxy must refuse loopback whatever a card opened (to be enforced when this is built); the token is an own secret, so output that prints it never reaches the model | yes where the sandbox runs. **Not** where it does not — see [§9.3](#93-what-is-not-defended) |
| **A client with a valid credential**, buggy or hostile | Do more than its kind allows | Ids instead of paths, normalizers for every method, a method table per kind, loosening refused in the core (#980), limits on size, rate and connections, one run per chat, no workspace switch during a run | yes — what remains is what the credential is for: read the released chats, write into them, answer *allow once* or *deny*, stop a run |
| **A client answering someone else's card** | Answer a request of a chat it does not follow, or one that already ended | The answer is bound to the `requestId`, an open request, a subscription to its chat and the kind's options; requests are random 122-bit ids | yes |
| **A program on a stale port** | Receive the token after a crash | The token changes with every start; clients send it only to the URL in the file | yes |
| **The relay and its operator, a stolen phone, a second device** | — | The mobile concept, §5 and §6, with SEC-6 | as there |
| **A flood of requests** | Keep the desktop busy | Limits per connection; switching the interface off. Not a security goal beyond keeping the app responsive | partly |

### 9.3 What is not defended

- **Processes running with the user's rights**, outside Snotra's sandbox,
  stay outside the protection goal, as in security concept §5. Such a process
  can read the token like any file of the user. What it gains is what a
  `local` client gains — read the released chats, write into them, answer
  pending cards with *allow once* — and it could do more harm without the
  interface. It cannot loosen a protection and cannot read a secret: no method
  returns one.
- **That includes the agent's own processes where nothing isolates them** —
  every command on Windows today (AR-15), a workspace with the sandbox
  switched off (#357), and every MCP server (AR-17). There an approved command
  could approve the next one. The interface is off by default, every
  connection is shown at the desktop while it lasts (R8), every answer and
  message from a connection carries its origin in the chat, and *Disconnect
  all* ends every connection and changes the token at once. That makes it
  visible, not impossible; it shrinks with AR-15 and AR-17.
- **A compromised main process**, an administrator or root, and physical
  access to an unlocked machine.
- **Side channels** — timing and sizes on loopback.

### 9.4 What changes in the security concept

Section 5 of [`security-concept.md`](./security-concept.md) keeps its rule
that local processes with the user's rights are outside the goal, and names
two exceptions once a listener exists: other users of the machine and web
pages in the browser are inside it — they are defended by the checks above —
and so are the processes Snotra itself starts. The section points here for
the attacker model.

## 10. Consequences

**Build order.** The steps of [§8.1](#81-methods), each usable on its own:

1. **Watch.** The remote dispatcher, the local transport, the release list,
   and the read-only methods and events. Needs none of the prerequisites; a
   CLI can follow a chat from here on. *Built for the relay* (#1194):
   `application/remote/remote-dispatcher.js` behind the channel, the release
   list in `main/remote/release-store-adapter.js` (a workspace opens only
   with a receipt for `remote-workspace`; the switch on *Settings › Tools ›
   Security* asks for it, #1195, in `main/services/remote-release-settings.js`),
   the desktop's reads in `main/remote/desktop-adapter.js`. `session.welcome`'s `seq` is
   the dispatcher's count of its events, 0 for the welcome; on the relay
   `session.resync` follows an event the channel could not carry. The local
   transport is not built.
2. **Write.** `message.send`, `chat.new`, `run.abort`, `workspace.activate`,
   `chat.configuration` — after #981, which also has to answer a turn with its
   own chat's model and mode instead of the screen's (§7.3). *Built for the
   relay so far* (#1194, step 2a): every method but `workspace.activate`,
   writing only in the workspace open at the desktop. A turn goes through
   the conversation service under a session `remote:<connection>`; any run
   off screen — a phone's, or a chat left while its turn runs — takes its
   own chat's model entry and mode (`chat-session-settings.js`: `presetFor`,
   `runModeFor`). A stored *Auto* counts there only after an explicit switch
   at the desktop, as on an automatic restore (#567; decided 2026-10-20).
   Until step 3 the window answers a remote turn's cards. The window follows
   a remote turn as one of its own (step 2b): `main/remote/window-follow.js`
   sends `chat:turn-started` once the question is saved, then the turn's
   events on the window's own channels; the window settles it at `run-end`
   from what main saved, and its stop button stops it. `workspace.activate`
   (step 2c) goes through the window as well
   (`main/remote/window-workspace-switch.js`): it opens the folder as from
   its menu, or answers `unsaved` while the file on show has unsaved
   changes; without a window main opens it itself. A switch that happened
   posts the notice `remote-workspace-switched` with the folder's name.
3. **Decide.** The approval methods and events — after #980. *Built for
   the relay* (#1194): the tool approval adapter tells who it offered a
   card and who answered it (`observe`), and takes a remote's answer through
   `respondFromRemote` — *allow once* or *deny*, and on a sandbox card only
   paths it offered; anything wider is `refused`. A connection that declared
   `approvals` gets the cards of the chats it follows (`approval.request`,
   in `chat.open` as `pendingApprovals`) worded in its language, paths
   inside the workspace relative to it, without the session scope, the
   command rule or *for this workspace*; `approval.resolved` names who
   answered. The first valid answer wins, the window's included. Every IPC
   channel is classified in §8.3, and `test/remote-interface-catalogue.test.js`
   keeps it so.
4. **Relay.** The relay transport under the same dispatcher (phases 1–3 of
   #1081). A headless process serving the protocol needs #983 as well.

**Tests that come with it:**

- The listener binds loopback only, on all three platforms (SEC-5).
- The checks of §5.3 as a matrix: `Host`, `Origin`, fetch metadata, token,
  content type, connection id — each refused on its own.
- Every method against every kind; every loosening refused from `local` and
  `relay` (SEC-6, and the test #980 asks for).
- Approval binding with two connections: the first answer wins, the other
  gets `approval.resolved`, an unsubscribed connection and a closed request
  are refused.
- Inside the sandbox on macOS and Linux, a command can neither read
  `remote/local.json` nor connect to the port.
- The catalogue is complete: every IPC channel is classified (§8.3).
- The reference client of #1081 phase 3 drives both transports.

**Documents.** `docs/remote-protocol.md` with examples and test vectors
(phase 1 of #1081); a manual chapter once there is something to switch on
(`.claude/rules/user-manual.md`); section 5 of the security concept and the
container view of [`architecture.md`](./architecture.md) point here.

**What it costs.**

- A second surface to keep in step with the core. Kept small on purpose, and
  the completeness test makes every new IPC channel a decision.
- Two ways into the core until, perhaps, the window moves onto the
  dispatcher (§4).
- With HTTP and SSE, a connection is two TCP connections held together by an
  id, and resuming needs an event buffer.
- A port a browser can reach needs its checks for as long as it exists; a
  Unix socket would not (§5.1, C).

## 11. Open decisions

Decisions that belong to the owner. Each has a recommendation; none is taken
by this record.

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| O1 | **Where the local interface is switched on**, and what the user sees while it is on | (a) *Settings › Remote access*, next to the phone, with a list of connected programs and *Disconnect all*; (b) a command-line switch only, for headless use; (c) both | (c): the setting for the desktop app, the switch for a headless process. Off by default either way. The UI is a design decision and gets a mockup first (`.claude/rules/ux-ui-standards.md`) |
| O2 | **Which workspaces local programs see** | (a) the same per-workspace release as the phone; (b) every known folder | (a): one rule — a workspace not opened for remote access is invisible to every remote front end |
| O3 | **Whether local programs may answer approvals** | (a) *allow once* and *deny*, like the phone; (b) read and write only, cards stay at the desktop | (a): a CLI without approvals cannot run a single tool in *Smart*. Answers carry the program's name in the chat |
| O4 | **Who confirms a loosening when there is no desktop** (a headless process, #983) | (a) nobody: headless runs with what the desktop decided, and a loosening needs the desktop; (b) the terminal that started the headless process, with the user typing a confirmation there; (c) the remote client | (a) now, (b) worth deciding with #980 and #983. Never (c): a credential is not a person at the machine (#980) |
| O5 | **A file scope for local programs** — reading the workspace by relative path, for an editor plugin, say | (a) not in the first version; (b) read only, released workspaces only, as its own step | (a), and (b) as an issue of its own when a program needs it |
| O6 | **Deleting a chat, and choosing a chat's model, from a remote front end** | (a) desktop only; (b) allowed for both kinds | (a) for the first version. Choosing a model needs the per-chat model of #981 anyway |

## Related

- [`quality-requirements.md`](./quality-requirements.md) — SEC-5, SEC-6,
  CORE-1 and the rules on remote control.
- [`security-concept.md`](./security-concept.md) — section 5 for the trust
  model, section 6 for approvals.
- [`architecture.md`](./architecture.md) — containers, and *Runs per chat*.
- [`architecture-review.md`](./architecture-review.md) — AR-05, AR-06, AR-08,
  AR-14.
- Mobile remote: [concept](https://github.com/kkrafft1999/snotra-mobile/blob/main/docs/mobile-remote-concept.md),
  epic [#1081](https://github.com/kkrafft1999/snotra/issues/1081).
- [`remote-protocol.md`](./remote-protocol.md) — the bytes: pairing code,
  relay endpoints, MACs, safety phrase (#1112); handshake, session keys and
  envelopes (#1113); with test vectors.
- [`remote-pairing-sequence.svg`](./remote-pairing-sequence.svg) — pairing a
  phone and the relay channel step by step, from *Settings › Remote access* to
  *Remove phone* (agreed 2026-10-18).
- [`ui-design/remote-access-mockup.html`](./ui-design/remote-access-mockup.html) —
  the settings panel for it, every state, with the variant decided on 2026-10-18.
