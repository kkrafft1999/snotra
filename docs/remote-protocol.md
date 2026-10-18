# Remote protocol

Specification of what Snotra Agent, the relay and the iPhone app of the mobile
remote ([#1081](https://github.com/kkrafft1999/snotra/issues/1081)) exchange,
down to the byte. Protocol version **1**.

- **Part 1 — pairing** (this document, [#1112](https://github.com/kkrafft1999/snotra/issues/1112),
  written on 2026-10-18): the pairing code, the relay's endpoints, `MAC_P` and
  `MAC_D`, the safety phrase, with test vectors.
- **Part 2 — the channel** ([#1113](https://github.com/kkrafft1999/snotra/issues/1113)):
  tokens and presence on every connection, the handshake, the encrypted
  envelopes and JSON-RPC inside them. Not written yet.

It must not contradict the decision record
[`remote-interface.md`](./remote-interface.md) (#989) or the
[mobile remote concept](https://github.com/kkrafft1999/snotra-mobile/blob/main/docs/mobile-remote-concept.md);
where it changes the concept, [§11](#11-changes-to-the-concept) says so. The
flow it details is drawn in [`remote-pairing-sequence.svg`](./remote-pairing-sequence.svg)
— step numbers below refer to that diagram. The two choices this part ran into
were decided by the owner on 2026-10-18 ([§10](#10-decisions)).

Nothing of it is built yet. The reference implementation that pins the bytes
is [`scripts/remote-protocol-vectors.js`](../scripts/remote-protocol-vectors.js);
the bridge (#1114) and the app implement the same functions on their own and
prove them against the vectors ([§9](#9-test-vectors)).

## 1. Versions

- Version 1 is named in three places that change together: the QR payload
  (`snotra-pair:v1/…`), the relay's path prefix (`/v1/…`) and every label
  (`"snotra/v1 …"`).
- Adding an optional field, an endpoint or an error reason keeps the version.
  Changing a byte layout, a label, the word list or what a field means makes
  version 2. A phone that meets a version it does not speak says so and stops —
  it never guesses.

## 2. Conventions

| Notation | Means |
| --- | --- |
| `‖` | Concatenation of byte strings |
| `u16(n)` | `n` as two bytes, big-endian |
| `lp(x)` | `u16(len(x)) ‖ x` — every variable-length part of anything hashed, signed or MACed; text is UTF-8 |
| `b64u(x)` | Base64url without padding (RFC 4648 §5) — binary values inside JSON |
| `SHA-256`, `HMAC-SHA256` | FIPS 180-4, RFC 2104 |

**Labels** separate every use of a key or a hash from every other. Each is an
ASCII string, used as `lp(label)` at the start of its input:

| Label | Used for |
| --- | --- |
| `"snotra/v1 code-check"` | The check symbol of the pairing code ([§4](#4-the-pairing-code)) |
| `"snotra/v1 pair-open"` | The desktop's proof when it opens a pairing ([§5.3](#53-open-a-pairing)) |
| `"snotra/v1 pair-claim"` | The phone's proof when it claims one ([§5.5](#55-claim)) |
| `"snotra/v1 token"` | Either side's proof for a token ([§5.9](#59-tokens)) |
| `"snotra/v1 mac phone"` | `MAC_P` ([§6](#6-mac_p-and-mac_d)) |
| `"snotra/v1 mac desktop"` | `MAC_D` ([§6](#6-mac_p-and-mac_d)) |
| `"snotra/v1 phrase"` | The safety phrase ([§7](#7-the-safety-phrase)) |

## 3. Keys

Each side holds two long-term P-256 keys (concept §5.2): **sign** (ECDSA) and
**agree** (ECDH). On the phone both live in the Secure Enclave; on the desktop
they are kept through `safeStorage`. Private keys never leave the side that
made them.

- **A public key** is the uncompressed SEC1 point: `0x04 ‖ X ‖ Y`, 65 bytes —
  CryptoKit's `x963Representation`, Node's `ECDH#getPublicKey()`.
- **A key bundle** in JSON is `{ "sign": b64u(point), "agree": b64u(point) }`;
  as bytes it is `KB = lp(sign) ‖ lp(agree)`. `KB_D` is the desktop's,
  `KB_P` the phone's.
- **A signature** is ECDSA over SHA-256 in IEEE P1363 form, `r ‖ s`, 64 bytes —
  CryptoKit's `rawRepresentation`, Node's `dsaEncoding: 'ieee-p1363'`. ECDSA is
  randomised: two signatures over the same bytes differ, and both verify.

## 4. The pairing code

The desktop shows one code twice: as a QR code and, beneath it, as a typed key
(step 10). Both carry the same twenty symbols.

```
symbols    PPPP SSSSSSSSSSSSSSS C
           │    │               └ check symbol, 5 bits
           │    └ pairing secret, 15 symbols = 75 bits, from the desktop's CSPRNG
           └ pairing id, 4 symbols = 20 bits, minted by the relay
typed key  0111-EP9D-ZH4Q-PYT4-HWWF
QR         snotra-pair:v1/<relay-host>/0111EP9DZH4QPYT4HWWF
```

- **Alphabet:** Crockford's base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no I,
  L, O or U. Values are written most significant symbol first.
- **Check symbol:** the top five bits of
  `SHA-256(lp("snotra/v1 code-check") ‖ ascii(the first 19 symbols))`, as a
  symbol. It catches 31 of 32 typos on the phone, before the relay is asked.
- **Typed key:** the twenty symbols in groups of four, joined by `-`.
- **QR payload:** `snotra-pair:v1/` ‖ the relay's host name ‖ `/` ‖ the twenty
  symbols. The phone accepts **only relay hosts it ships with** (the production
  relay; the Firebase emulator in debug builds only). A code that names any
  other host is refused — a QR code must not be able to send the phone to a
  relay of somebody else's choosing.
- **Reading a typed key** (the phone): ignore case, drop `-` and white space,
  read `O` as `0` and `I` or `L` as `1`. Anything else outside the alphabet is
  `invalid-symbol`, another length `invalid-length`, a wrong check symbol
  `invalid-check`. A typed key goes to the phone's built-in relay.
- **The MAC key** `K` is the canonical code itself: its twenty ASCII bytes.

**Who knows what.** The relay mints the pairing id and never learns the secret:
neither the desktop nor the phone sends the code anywhere. The phone sends the
pairing id in the URL path, and proves that it knows the secret only through
`MAC_P`.

**Why these sizes** — decided on 2026-10-18 against the concept's 128 bits
([§10](#10-decisions), O2):

| Part | Bits | What it has to hold |
| --- | --- | --- |
| Pairing id | 20 | Names one pairing among those alive at the same time, for five minutes; the relay draws again on a collision. Guessing one yields the desktop's *public* keys and lets a stranger spend the pairing with a claim that fails the desktop's MAC check — App Check, a rate limit per IP and the one-use rule contain that, and the panel says *Pairing stopped*. |
| Secret | 75 | The relay sees `MAC_P` and could search for the secret offline, to swap in its own keys before the desktop answers. It has five minutes: 2⁷⁵ HMAC-SHA256 at 10¹² per second take about 1,200 years. And the safety phrase would still differ. |
| Check | 5 | Typos. |

## 5. The relay's endpoints

### 5.1 Common rules

- **Base:** `https://<relay-host>/v1`. Bodies are JSON, UTF-8, at most 4 KiB.
- **Who calls:** the desktop and the phone, nothing else. Calls from the phone
  carry an App Check token in `X-Firebase-AppCheck` (App Attest); calls that
  need a role carry `Authorization: Bearer <Firebase ID token>`.
- **Tokens:** the relay answers with a Firebase **custom token** whose claims
  are `{ "ch": channelId, "role": "desktop" | "phone" }`. The desktop exchanges
  it for an ID token through the Identity Toolkit REST endpoint
  `accounts:signInWithCustomToken` (no Firebase SDK in main); the phone signs
  in with the iOS SDK. The ID token authorises the database (`?auth=` on the
  REST interface) and the endpoints below.
- **Errors:** an HTTP status and `{ "error": { "reason": "<reason>" } }`, with
  the reasons of [`remote-interface.md` §6.3](./remote-interface.md#63-errors)
  where they fit:

  | Status | `reason` | When |
  | --- | --- | --- |
  | 400 | `invalid-request` | A field missing, malformed or the wrong size |
  | 401 | `unauthorized` | No or a bad ID token, no or a bad App Check token |
  | 403 | `refused` | A proof that does not verify, a role that may not do this |
  | 404 | `not-found` | Unknown, expired or already used — **one answer for all three**, so that ids cannot be probed |
  | 409 | `busy` | The record is not in the state the call needs (confirming a channel that is not `pending`) |
  | 413 | `too-large` | A body over 4 KiB |
  | 429 | `rate-limited` | Too many calls from this address |
  | 503 | `unavailable` | The relay cannot serve now |

- **Sizes:** points 65 bytes, signatures 64, MACs 32, channel ids 16, challenges
  at most 64 bytes.

### 5.2 Challenges

```
POST /v1/challenges          → 200 { "challenge": b64u, "expiresAt": ms }
```

A challenge is opaque to the clients and valid for **60 seconds**. Every proof
signs it, so that a proof cannot be replayed later. The relay may keep it
stateless (its own MAC over a random value and the expiry) or store it; either
way it accepts a challenge at most once per endpoint.

### 5.3 Open a pairing

Desktop, steps 5–7.

```
POST /v1/pairings
{ "challenge": b64u, "desktopKeys": { "sign", "agree" }, "proof": b64u }
→ 201 { "channelId": b64u(16 bytes), "pairingId": "0111", "expiresAt": ms, "token": "<custom token, role desktop>" }
```

- `proof = sign(desktop.sign, lp("snotra/v1 pair-open") ‖ lp(challenge) ‖ KB_D)`.
- The relay checks the proof against `desktopKeys.sign`, creates
  `/channels/{channelId}` with `status: "open"` and `/pairing/{pairingId}`
  pointing at it, valid for **five minutes and one claim**.
- The desktop then builds the code from `pairingId` and its own secret
  ([§4](#4-the-pairing-code)) and follows `/channels/{channelId}` by REST
  streaming (step 8).

### 5.4 Look up

Phone, steps 17–18.

```
GET /v1/pairings/{pairingId}                          X-Firebase-AppCheck
→ 200 { "channelId": b64u, "desktopKeys": { "sign", "agree" }, "expiresAt": ms }
```

`404 not-found` for an unknown, expired or claimed pairing.

### 5.5 Claim

Phone, steps 20–22.

```
POST /v1/pairings/{pairingId}/claim                   X-Firebase-AppCheck
{ "challenge": b64u, "phoneKeys": { "sign", "agree" }, "macP": b64u, "proof": b64u }
→ 200 { "channelId": b64u, "token": "<custom token, role phone>" }
```

- `proof = sign(phone.sign, lp("snotra/v1 pair-claim") ‖ lp(challenge) ‖ lp(channelId) ‖ KB_P)`,
  `channelId` as its 16 raw bytes.
- The relay checks that the pairing is alive and unclaimed and the proof
  verifies against `phoneKeys.sign`, then writes `phoneKeys` and `macP` into
  the channel, sets `status: "pending"` and marks the pairing claimed. **A
  second claim gets `404`**; a channel never takes a third key.
- The relay cannot check `macP` — it does not know the secret.

### 5.6 Confirm

Desktop, steps 34–35, after *Allow* in the confirmation port's native sheet.

```
POST /v1/channels/{channelId}/confirm                 Authorization: Bearer <ID token, role desktop>
{ "macD": b64u }
→ 204
```

The relay requires `status: "pending"` (else `409 busy`), writes `macD`, sets
`status: "paired"` and deletes the pairing. From then on the database rules
open the two outboxes (part 2).

### 5.7 Cancel

Desktop: *Cancel*, the five minutes running out (steps 12–14), or a wrong
`MAC_P` (step 26).

```
DELETE /v1/pairings/{pairingId}                       Authorization: Bearer <ID token, role desktop>
→ 204
```

Deletes the pairing and, unless it is `paired`, the channel. The relay's
scheduled clean-up does the same for pairings nobody cancelled.

### 5.8 Delete a channel

*Deny* at the desktop, *Remove phone*, *Disconnect* on the phone, a wrong
`MAC_D` on the phone.

```
DELETE /v1/channels/{channelId}                       Authorization: Bearer <ID token, either role>
→ 204
```

Deletes the channel with everything under it. Tokens for it are refused from
then on, and the other side's stream sees the record vanish.

### 5.9 Tokens

Either side, whenever it connects again (part 2).

```
POST /v1/tokens
{ "challenge": b64u, "channelId": b64u, "role": "desktop" | "phone", "proof": b64u }
→ 200 { "token": "<custom token>" }
```

- `proof = sign(<role>.sign, lp("snotra/v1 token") ‖ lp(challenge) ‖ lp(channelId) ‖ lp(role))`.
- The relay verifies against the key it stored for that role. A phone gets a
  token only for a `paired` channel; until then it uses the one from its claim.

### 5.10 What the clients read

The relay alone writes these fields; the clients follow them by streaming.

```
/channels/{channelId}
    desktopKeys     { sign, agree }                      written on open
    phoneKeys       { sign, agree }                      written on claim
    macP            b64u                                 written on claim
    macD            b64u                                 written on confirm
    status          "open" | "pending" | "paired"
    createdAt, lastSeen                                  ms
```

- **The desktop** reads the whole record.
- **The phone** reads `desktopKeys`, `status` and `macD` — and while `status`
  is not `paired`, nothing else under the channel. Both outboxes stay closed
  until then (decided 2026-10-18).
- A record that disappears means *cancelled, denied, expired or removed*.

## 6. `MAC_P` and `MAC_D`

```
T     = lp(channelId) ‖ KB_D ‖ KB_P
MAC_P = HMAC-SHA256(K, lp("snotra/v1 mac phone")   ‖ T)
MAC_D = HMAC-SHA256(K, lp("snotra/v1 mac desktop") ‖ T)
```

`K` is the code's twenty ASCII bytes ([§4](#4-the-pairing-code)), `channelId`
its 16 raw bytes. Both are compared in constant time.

- **The desktop checks `MAC_P`** as soon as the claim arrives (step 26). A wrong
  one means the keys in the channel are not the ones the person with the code
  sent — a relay that swapped them, a stranger with a guessed pairing id, a
  mistyped secret. The desktop cancels; the panel shows *Pairing stopped*.
- **The phone checks `MAC_D`** when `status` turns `paired` (step 37). A wrong
  one, or a channel that turns `paired` without it, makes the phone delete the
  channel and its keys and say the pairing failed.
- The labels keep one MAC from passing for the other: a relay cannot hand
  `MAC_P` back as `MAC_D`.

With both checks, each side knows from the secret alone that it holds the other
side's real keys. The safety phrase is the second, human check on top.

## 7. The safety phrase

Six words, shown by both sides (steps 27–29) and compared by the person at the
desktop before *Allow*.

```
H0 = SHA-256(lp("snotra/v1 phrase") ‖ KB_D ‖ KB_P),   H(i+1) = SHA-256(H(i))
```

- Read `H0`, then `H1`, … as 16-bit big-endian values. With a word list of `N`
  words, a value `v` below `floor(65536 / N) · N` gives the index `v mod N`; a
  value at or above it is skipped, so that every word is equally likely. The
  first six indices make the phrase. With `N = 1296` the bound is 64,800 and
  one value in about ninety is skipped.
- **One fixed word list, never translated** (decided 2026-10-18): a desktop in
  German and a phone in English show the same six words. The list is the
  **EFF short word list 2.0** — 1,296 words of 3 to 10 letters, each with a
  unique three-letter prefix — in
  [`src/shared/contracts/remote/safety-words-v1.json`](../src/shared/contracts/remote/safety-words-v1.json),
  index = position in its `words` array (`N = 1296`). It is part of protocol
  version 1: SHA-256 of the words joined by `\n`, with a final `\n`, is
  `7aa57a4d3ecf6581729992bad9575bacdebf7c28378af2aec6a50f11aec326f5`; another list is version 2.
- **Attribution.** The list is © Electronic Frontier Foundation under CC BY 3.0
  US. Every product that shows the phrase names it where it lists third-party
  material: the desktop in `THIRD_PARTY_NOTICES.md` and the licence note next
  to the JSON file, the iPhone app in its About screen.
- Shown in lower case as published (one word, `yo-yo`, has a hyphen), numbered
  1 to 6, in order, joined by ` · ` where they share a line. The desktop shows
  them large in *Settings › Remote access* and again in the native sheet.

Six words from 1,296 carry 62 bits. A relay that wanted the same phrase for
keys of its own would have to find them inside the pairing's five minutes —
after already failing `MAC_P` and `MAC_D`.

## 8. Pairing, step by step

| Steps | Who | Does | Checks |
| --- | --- | --- | --- |
| 3–4 | Desktop | Creates its keys once; draws a fresh secret | — |
| 5–7 | Desktop → relay | `POST /challenges`, `POST /pairings` | Relay: proof |
| 8–11 | Desktop | Follows the channel; shows QR code and typed key; starts five minutes | — |
| 15–16 | Phone | Reads the code; creates its keys in the Secure Enclave | Phone: host on its list, check symbol |
| 17–18 | Phone → relay | `GET /pairings/{id}` | Relay: App Check, alive and unclaimed |
| 19–22 | Phone → relay | Computes `MAC_P`; `POST /challenges`, `POST …/claim` | Relay: proof, one claim |
| 25–26 | Desktop | Sees `phoneKeys` and `macP` | Desktop: `MAC_P` |
| 27–32 | Both | Show the phrase; the desktop asks through the confirmation port | The person: the words |
| 33–35 | Desktop → relay | Keeps the phone's keys; `POST …/confirm` with `MAC_D` | Relay: `status: "pending"` |
| 36–37 | Phone | Sees `paired` and `macD`; keeps the desktop's keys | Phone: `MAC_D` |

What the user sees for each outcome is in the panel's states (#1110):
`invalid-*` on the phone before anything is sent; `404` → *expired or already
used*; a wrong `MAC_P` → *Pairing stopped*; `401`, `429`, `503` or no network →
*Can't reach the relay*; a vanished channel on the phone → *not allowed on the
desktop*.

## 9. Test vectors

[`remote-protocol/pairing-v1.json`](./remote-protocol/pairing-v1.json) holds
fixed inputs and every value derived from them:

- both sides' private scalars (hex) and public points (`b64u`), and `KB_D`,
  `KB_P`;
- the code — pairing id, secret, check, typed key, QR payload, `K`;
- parse cases: what a person may type, and the canonical code or the error;
- the channel id, `T`, `MAC_P`, `MAC_D`;
- the phrase: `H0`, the 16-bit values read, the six indices, the six words and
  the list checksum;
- for each proof the exact message (hex) and one signature that verifies.

The private scalars are SHA-256 hashes of short labels, so the file can be
rebuilt from scratch. `node scripts/remote-protocol-vectors.js` rewrites it,
keeping signatures that still verify; `test/remote-protocol-vectors.test.js`
recomputes everything with Node's `crypto` on every `npm test`. The app loads
the scalars with `P256.Signing.PrivateKey(rawRepresentation:)` and
`P256.KeyAgreement.PrivateKey(rawRepresentation:)` and runs the same file in
its own tests; a signature it makes itself must verify in Node and the other
way round.

## 10. Decisions

Decided by the owner on 2026-10-18 (#1116), from the options this part first
listed as open:

| # | Question | Decided | Considered |
| --- | --- | --- | --- |
| O1 | **The word list** of the safety phrase | The **EFF short word list 2.0**: 1,296 memorable words, each with a unique three-letter prefix, CC BY 3.0 US (§7). Nobody mistakes the phrase for a wallet's recovery words | BIP-39 English (2,048 words — known from crypto wallets, where such words *are* the key); the PGP word list (two lists of 256 for reading aloud, 48 bits for six words); the EFF short word list 1 (words of at most five letters, without unique prefixes) |
| O2 | **The size of the secret**, against the length of the typed key | **75 bits in twenty symbols**, the length the concept shows. The secret has to hold for five minutes against an offline search, not forever (§4) | 128 bits in 31 symbols, eight groups of four on a phone keyboard; 128 bits in the QR code and a second, shorter code for typing |

## 11. Changes to the concept

The concept (snotra-mobile, §5.1 and §10) took these over on 2026-10-18:

- **The secret is 75 bits, not 128**, and the twenty symbols of the typed key
  are pairing id, secret and a check symbol — the concept's example had twenty
  symbols but did not say how 128 bits and an id fit into them.
- **The relay's endpoints are concrete**: challenges, open, look up, claim,
  confirm, cancel, delete, tokens; the channel's `status` runs
  `open → pending → paired`.
- **The QR code's relay host is checked** against the hosts the app ships
  with.
- **The word list** is the EFF short word list 2.0, named in the app's About.

## Related

- [`remote-interface.md`](./remote-interface.md) — the decision record this
  specifies (#989).
- [`remote-pairing-sequence.svg`](./remote-pairing-sequence.svg) — the flow
  (#1107).
- [`ui-design/remote-access-mockup.html`](./ui-design/remote-access-mockup.html)
  — the panel (#1109, #1110).
- [Mobile remote concept](https://github.com/kkrafft1999/snotra-mobile/blob/main/docs/mobile-remote-concept.md),
  epic [#1081](https://github.com/kkrafft1999/snotra/issues/1081).
