# Architecture review

Phase 2 of [#752](https://github.com/kkrafft1999/snotra/issues/752): does the
architecture Snotra has fit what Snotra has to achieve? Measured scenario by
scenario against the quality model the owner agreed on 2026-10-16,
[`quality-requirements.md`](./quality-requirements.md). Reviewed on 2026-10-16
at `c66b3c5` (v1.23.0); the only later commit on `main`, #975, adds the
container view to [`architecture.md`](./architecture.md) and changes no code.

Each finding is an issue of its own, `AR-01` … `AR-38`, on the board in
*Backlog* and linked to #752 as a sub-issue. This document holds the
evaluation; the issues hold the details and the definitions of done. Fixing
them is a separate step, prioritised like any other work.

## The result in brief

| Rank | Goal | Verdict | Why |
| --- | --- | --- | --- |
| 1 | Agent security | **partly supported** | A mature design — risk classes, cards bound to what runs, a fail-safe that only tightens, a self-tested sandbox — with two paths that fail open (AR-01, AR-11) and every loosening confirmation tied to an Electron dialog (AR-05). |
| 2 | Usability and accessibility | **partly supported** | Run and update errors say what to do next; most parity gaps are visible. Accessibility is verified by hand on macOS only (AR-24), and a failure outside a dialog has no way to reach the user (AR-03). |
| 3 | Privacy | **partly supported** | No telemetry, offline CSP, consent for external calls in Smart. The update check cannot be switched off (AR-12), and nothing proves PRI-1 (AR-13). |
| 4 | Robust operation | **at risk** | Atomic writes everywhere (ROB-5) and a run that cannot end in "running". But the worst failure of §3, *silent misbehaviour*, has no safety net: no global handlers, no log, a chat that cannot be saved says nothing (AR-02, AR-03, AR-25). |
| 5 | Separable core | **at risk** | The import guard holds, but `src/application/` carries about 5.3k of roughly 34k lines of backend logic. The renderer owns the conversation, and there is no Electron-free composition (AR-06 – AR-08). |
| — | Safe changeability | partly supported | The gate is real (three platforms, no bypass, median 222 s), but 9.1 % of runs on `main` were red over two weeks — above the 5 % trigger — and `architecture.md` has drifted (AR-34). |
| — | Portability and parity | **at risk** | Reasoning levels exist for OpenAI only, image attachments for three providers are on hold (AR-19); two Windows gaps have no issue (AR-15, AR-16). |
| — | Bilingual interface | partly supported | The catalogues are enforced well (I18N-1); a third language would need code changes in about ten places (AR-32). |
| — | Performance | **at risk** | Nothing is measured (AR-09). The history store re-reads and re-encrypts everything on each access (AR-10), and rendering grows with content (AR-23). |

**What to do first.** The order follows severity and the ranking of §3, cheap
fixes first where the risk is equal:

1. **The two small, high fixes:** the own-secret check that fails open
   ([AR-01](https://github.com/kkrafft1999/snotra/issues/976)) and the chat
   that is silently not saved ([AR-02](https://github.com/kkrafft1999/snotra/issues/977)).
   Both are effort S.
2. **A safety net against silent misbehaviour:** global handlers, a local log
   and a notice channel ([AR-03](https://github.com/kkrafft1999/snotra/issues/978)),
   then the catch guard ([AR-25](https://github.com/kkrafft1999/snotra/issues/1000))
   and the set-aside notices ([AR-26](https://github.com/kkrafft1999/snotra/issues/1001))
   that use it.
3. **Measure before optimising:** the performance harness
   ([AR-09](https://github.com/kkrafft1999/snotra/issues/984)), then the
   history store ([AR-10](https://github.com/kkrafft1999/snotra/issues/985)).
4. **The separable core, in this sequence:** checked ports
   ([AR-29](https://github.com/kkrafft1999/snotra/issues/1004)) →
   Electron-free composition ([AR-08](https://github.com/kkrafft1999/snotra/issues/983)) →
   confirmation port ([AR-05](https://github.com/kkrafft1999/snotra/issues/980)) →
   conversation in the core ([AR-06](https://github.com/kkrafft1999/snotra/issues/981)) →
   remaining logic into the core ([AR-07](https://github.com/kkrafft1999/snotra/issues/982)).
   The remote interface ([AR-14](https://github.com/kkrafft1999/snotra/issues/989))
   is designed before the first second front end is started, not after.
5. **The owner's decisions** that unblock others:
   [AR-11](https://github.com/kkrafft1999/snotra/issues/986) (Auto without a
   platform sandbox) and the hold on #90–#92
   ([AR-19](https://github.com/kkrafft1999/snotra/issues/994)).

## Method

ATAM-light, as #752 proposed. Each scenario of §4 was mapped to the
architectural approaches meant to serve it and rated **supported**, **partly
supported**, **at risk** or **not built**, with the evidence in the code. Four
strands ran in parallel: security and privacy; robust operation; the separable
core and the documentation; usability, parity and performance. All of them
read `src/`, `docs/`, the manual and the CI history (via `gh`); the claims the
high findings rest on were checked again by hand.

**Limits.** Nothing was executed. The catch census behind AR-25 is a
heuristic. The spellchecker suspicion in AR-13 is unverified. No performance
number in this document is measured — which is itself finding AR-09.

## Approaches and what they serve

| Approach | Serves | State |
| --- | --- | --- |
| Layering and ports (`application` → `shared`, import guard) | CORE-1, CORE-2, CHG-1 | The guard holds; the core is small and the ports are unchecked prose (AR-07, AR-29). |
| Composition root (`createApplication`) | CORE-1, CORE-2 | Fuses wiring and IPC registration, injects Electron raw, has grown back to 1,055 lines (AR-08, AR-30). |
| IPC contracts (`shared/contracts`, channel constants, keyed errors) | CORE-1, SEC-5, USE-2 | Good DTO validators; no per-channel schema, session = `webContents` id (AR-14). |
| Process model (sandboxed renderer, fuses, CSP, preview session) | SEC-1, PRI-1 | Solid; renderer on `file://` makes `'self'` cover the disk (AR-37). |
| Permission system (risk classes, modes, cards, signed policy, fail-safe) | SEC-1 – SEC-3 | The strongest part of the architecture; loosening is confirmed only in the IPC layer (AR-05). |
| Execution sandbox (`sandbox-runtime`, domain proxy, self-test) | SEC-2, POR-1 | macOS and Linux; Windows and MCP servers unisolated (AR-15, AR-17). |
| Storage and encryption (`safeStorage`, set-aside rules, atomic writes) | PRI-3, ROB-3, ROB-5, PERF-2 – 4 | Atomic everywhere; one blob for all chats (AR-10); set-asides silent (AR-26). |
| Self-update (three modules, digest check, Windows helper) | ROB-2, PRI-1 | Windows has a rollback contract, macOS and Linux do not (AR-28); no switch (AR-12). |
| Renderer split (components, `ChatStream`, state store) | USE-2 – 4, CORE-2, PERF-2/3 | Owns the conversation (AR-06); full re-render per frame and per switch (AR-23). |

## Scenario by scenario

| ID | Rating | Reasoning | Findings |
| --- | --- | --- | --- |
| SEC-1 | partly supported | The boundary is enforced lexically and by real path, with symlink tests for nearly every file tool. Since #792 a path outside is offered on a card instead of refused — the scenario has been restated to match (see [Changes to the quality model](#changes-to-the-quality-model)). | AR-35, AR-37 |
| SEC-2 | partly supported | Execution asks on every call and runs in the sandbox on macOS and Linux. Windows and MCP servers run unisolated. | AR-15, AR-17 |
| SEC-3 | partly supported | Most degraded states fail closed and show it. Two fail open: the own-secret read, and Auto on a platform without a sandbox. | AR-01, AR-11 |
| SEC-4 | not built | Only the fixed prompt rule exists; the hooks (#926/#927) are the natural place. | AR-36 |
| SEC-5 | not built | No listener exists. Approvals fail safe without a UI, but loosening confirmations live in the Electron IPC layer, and the protocol is not designed. | AR-05, AR-14 |
| USE-1 | partly supported | A default OpenAI entry, a hint and a tested first-run path exist; the five minutes were never measured, and the first start ignores the OS language. | AR-38 |
| USE-2 | partly supported | Runs and updates report with a next step. Rejected invokes show Electron's English wrapper; failures without a dialog have no channel. | AR-03, AR-38 |
| USE-3 | partly supported | Rules and spot tests exist; no automated scan, screen readers only on macOS by hand. | AR-24 |
| USE-4 | partly supported | Most gaps are shown where the user meets them; the image refusal blames the model, the manual misstates Windows. | AR-16, AR-20, AR-21 |
| PRI-1 | partly supported | The update check is the only automatic call found, but it cannot be switched off and nothing measures the scenario. | AR-12, AR-13 |
| PRI-2 | partly supported | External calls are carded in Smart; voice input does not name OpenAI, the price button names the wrong host. | AR-37 |
| PRI-3 | partly supported | Keys are encrypted or not stored. The check matches verbatim only and fails open on a read error. | AR-01, AR-18, AR-37 |
| ROB-1 | **at risk** | No process-level handlers, no log file, no notice channel; 310 of 673 catch sites quiet without a comment. | AR-02, AR-03, AR-25, AR-27 |
| ROB-2 | partly supported | Digest check before the swap; Windows can roll back. macOS and Linux keep no failure record and delete the backup too early; no platform proves the new version starts. | AR-28 |
| ROB-3 | partly supported | Nothing is overwritten and the app starts — but the user is not told. | AR-26 |
| ROB-4 | **at risk** | Finished turns survive; the running turn's finished steps do not, and a cut-off run leaves no trace. | AR-04, AR-06 |
| ROB-5 | supported | Temp file and rename in every recurring writer. Small gaps only. | AR-38 |
| CORE-1 | **at risk** | The core is about 11 % of the backend logic; a CLI would have to take most of `src/main` and parts of the renderer along. | AR-05 – AR-08, AR-14, AR-33 |
| CORE-2 | **at risk** | No check exists, and the newest feature (#949) put logic into the renderer. Logic sits in the composition root and in IPC handlers. | AR-06, AR-30, AR-31 |
| CORE-3 | partly supported | The settings form is generic, but provider IDs branch in the core and the contracts; the last provider touched 32 files. | AR-21 |
| CHG-1 | partly supported | Required checks, no bypass, CI median 222 s. Red rate 9.1 % over 2026-10-02 … 16, above the 5 % trigger; no job timeout. | AR-22, AR-29; #883, #886, #887 |
| CHG-2 | **at risk** | Paths and names in `architecture.md` are accurate; its structural claims are not. | AR-34, AR-35 |
| POR-1 | **at risk** | Reasoning levels for OpenAI only; images on hold for three providers; two Windows gaps without an issue. | AR-15, AR-16, AR-19, AR-21 |
| I18N-1 | supported | Key parity, placeholders, used keys and German literals are tested; the manual's parity check is not a required check. | AR-38 |
| I18N-2 | **at risk** | About ten locale branches outside the catalogue; plurals hard-wired to two forms. | AR-32 |
| PERF-1 | at risk (unmeasured) | Sensible design (show on `ready-to-show`, lazy MCP and pdf.js), but "usable" waits for a full history decrypt; 155 unbundled modules. | AR-09, AR-10 |
| PERF-2 | **at risk** | A chat switch re-renders every message; the history list ships every message of every chat. | AR-10, AR-23 |
| PERF-3 | partly supported | Streaming is coalesced per frame, walks are capped and async — but each frame re-parses the whole answer. | AR-23 |
| PERF-4 | at risk (unmeasured) | All sessions with all messages are held in renderer memory. | AR-09, AR-10 |

## Sensitivity points

Places where one design parameter drives a quality goal on its own — where a
small change has a large effect:

- **`resolveToolPath` plus `outside-access`** is the only gate between the file
  tools and the disk outside the workspace (SEC-1).
- **The plan key of the tool-call planner** binds a card to what runs. A field
  missing from it lets an approval drift from the execution (SEC-2).
- **`sandbox.detect()` runs once per start.** Every card's statement about
  isolation rests on that one cached result (SEC-2, SEC-3).
- **`safeStorage.isEncryptionAvailable()`** alone gates Auto, allow rules, the
  sandbox opt-out, kept hosts, key storage, history encryption and the policy
  signature (SEC-3, PRI-3, CORE-1).
- **`readOwnSecrets`** — its completeness and its verbatim matching are the
  only output gate for keys (PRI-3).
- **The `finally` in `chat-handlers.js`** is the one guarantee that a run's UI
  state ends (ROB-1).
- **Object identity in `storesFromFailedReads`.** It protects the history only
  if handlers write back the object they read; a spread copy bypasses #473
  (ROB-3).
- **The history store format** drives PERF-2, PERF-3 and PERF-4 at once.
- **`MAX_CHAT_SESSIONS = 200`, `MAX_WATCHED_DIRECTORIES = 2000`** are the
  scaling knobs, neither backed by a measurement.
- **The provider capability vocabulary** decides whether a parity gap can be
  shown at all — today it has one flag (USE-4, POR-1).
- **The definition of "usable"** in PERF-1: first paint and "folder and chat
  restored" differ by a full history decrypt.

## Trade-offs

Where one goal was paid for with another. *Follows §3* means the decision
matches the agreed ranking.

| Decision | Wins | Loses | Follows §3? |
| --- | --- | --- | --- |
| Outside access by card instead of refusal (#792) | usability | security, with consent kept in every mode | yes — SEC-1 restated |
| Sandbox opt-out per workspace (#357) | usability | security, chosen by the user, never the default | yes |
| Auto without a platform sandbox runs unasked | usability | security, without anyone choosing it | **no** — AR-11 |
| Own-secret check fails open | robust operation (4) | security (1) | **no** — AR-01 |
| Unreadable files set aside silently | robust operation | usability (2), and the worst failure | **no** — AR-26 |
| Update check automatic, without a switch | security | privacy | **half** — AR-12 |
| History in plain text without a keyring | usability (2) | privacy (3) | yes, documented |
| Whole history encrypted as one blob | privacy | performance | open — AR-10 |
| Insecure TLS per provider entry, opt-in | usability | security | yes — a softer setting, never the default |
| Logic built where it is fastest (#949) | cadence | separable core | **no** — §3 "always through the core", AR-06 |
| Plain JS without a build step | cadence | checkable ports | open — AR-29 keeps both |
| One CI job, unit then e2e, no timeout | simplicity | changeability (one hang holds the gate) | open — AR-22, #887 |

## Decisions to make explicit

These decisions are embodied in the code but written down nowhere as a
decision. Each is a candidate for an architecture decision record in
[`architecture.md`](./architecture.md).

**The founding decisions**, open to question here for the first time
(`code-review-concept.md`, *Given, not findings*):

- **Electron.** It serves platform parity, offline operation and the CSP. It
  costs memory (PERF-4), fuses and backports (#571, #572), a `file://`
  renderer, and a self-built updater. It does not block the separable core:
  only four files in `src/main` import `electron`. *Recommendation:* keep it,
  and record "Electron is the shell; the core runs on plain Node" (AR-08).
- **Plain JavaScript, no types, no linter.** It serves cadence and the
  build-free renderer. It costs drifting contracts — five blocks of the code
  review noted it. *Recommendation:* keep JS and add `tsc --checkJs` over the
  core, the ports and the contracts (AR-29).
- **No renderer framework.** About twenty findings of the code review (blocks
  B11 – B15, B18: redraw, focus, races) are its cost, against usability, rank 2.
  A framework would not fix who owns the conversation. *Recommendation:* decide
  between shared primitives (keyed render, popup, cancellation) and a vendored
  library without a build step, in its own issue once AR-06 has moved the state
  out.

**Implicit decisions:**

- The renderer owns the conversation and its persistence (AR-06).
- Tool registry and planner live in main; the "application" ports for tools are
  consumed only by main (AR-07).
- `safeStorage` is the single trust anchor for secrets, history and policy,
  without a port (AR-08).
- Native dialogs in the IPC layer are the trust anchor for loosening (AR-05).
- IPC with string channels and the `webContents` id as session is the only API
  (AR-14).
- An auxiliary check that cannot read its input fails open (AR-01) — while the
  policy file fails closed.
- Errors are "reported" when they reach `console` (AR-03).
- Unreadable files are set aside silently (AR-26).
- The self-update failure contract differs per platform (AR-28).
- The streaming render strategy is a full re-render per frame (AR-23).
- Capabilities are one flag plus special cases (AR-21); some gaps are
  permanent by design (Linux without a keyring → no Auto; `.deb` → no
  self-update) and need a record, not an issue.
- Voice input and image generation always use the OpenAI key, web search
  always Tavily, whatever the chat's provider.
- The run lifecycle (reply, run-end marker, 10 s grace, #721) exists only as
  prose; every future front end has to implement it.

## Patterns from the code review

The staged code review (#482: 18 blocks, 118 findings) took the architecture as
given. Read across all blocks, its findings recur in patterns that point to
structural causes:

| Pattern | Seen in | Structural cause | Addressed by |
| --- | --- | --- | --- |
| One rule in several copies that drift | 9 of 18 blocks (#519, #538, #552, #557, #607, …) | No owner module, no type that forces reuse | AR-07, AR-21, AR-29, AR-33 |
| Hand-built redraw, focus and concurrency | B11 – B15, B18, ~20 findings | No renderer framework | ADR above |
| Untyped contracts and paths | B01, B02, B04, B05, B17 (#511, #525, #531, #650) | Ports as prose | AR-29 |
| Modules that keep growing | `send()` in the engine, `SettingsModal`, `fs-service`, `styles.css`, the composition root | No size guard, logic without a home | AR-30, AR-34 |
| Logic or trust in the wrong layer | #508, #537, #560, #646, #649 — and again since (#949) | The renderer and the IPC layer as the easy place | AR-06, AR-31 |
| Silent or fail-open handling of unreadable state | #512, #527, #557, #561, #565 – #567 | No error policy, no notice channel | AR-01, AR-03, AR-26 |
| Test doubles that cannot express the platform | B13, B17, B18 (happy-dom, a fake `watch`) | Known limit of the test stack | `test-concept.md` |
| Self-built instead of a library | updater (#569), MCP client (#625 – #628) | Few dependencies by choice | AR-28; revisit with #341 |
| Missing cross-cutting primitives | logger (#648), cancellation (#634), bounded read (#643) | No shared runtime layer for them | AR-03 |

## Drift between documentation and code

- **`architecture.md`** — paths and identifiers are accurate, the structure is
  not: the layers table, five claims about thin layers, the port list, the
  composition root, the guards table, self-update. The new container view
  repeats "presentation only" for the renderer. → [AR-34](https://github.com/kkrafft1999/snotra/issues/1009)
- **`security-concept.md`** — §4 to §7 predate #792 and #946. → [AR-35](https://github.com/kkrafft1999/snotra/issues/1010)
- **The manual** — Windows background processes (AR-16), the image refusal
  (AR-20), and the list of local providers on the capabilities page (AR-38).

## Changes to the quality model

Made in the same pull request as this report:

- **SEC-1 restated.** The scenario said a path outside the workspace is
  refused. Since #792 it is offered on a card in every mode, which the owner
  had decided before the quality model was written. The response and the
  measure now say so.

## All findings

Ordered by priority: severity first, then the rank of the goal, then effort.

| ID | Finding | Severity | Effort | Scenarios |
| --- | --- | --- | --- | --- |
| [AR-01](https://github.com/kkrafft1999/snotra/issues/976) | The own-secret check fails open when the secret list cannot be read | high | S | SEC-3, PRI-3 |
| [AR-02](https://github.com/kkrafft1999/snotra/issues/977) | A chat that cannot be saved is lost on quit without a word | high | S | ROB-1, ROB-3, ROB-4 |
| [AR-03](https://github.com/kkrafft1999/snotra/issues/978) | Errors outside a chat run have no safety net | high | M | ROB-1, USE-2 |
| [AR-04](https://github.com/kkrafft1999/snotra/issues/979) | A running turn is only saved when it ends | high | M | ROB-4, ROB-1 |
| [AR-05](https://github.com/kkrafft1999/snotra/issues/980) | Loosening confirmations exist only as Electron dialogs in IPC handlers | high | M | SEC-5, CORE-1 |
| [AR-06](https://github.com/kkrafft1999/snotra/issues/981) | The renderer owns the conversation | high | L | CORE-1, CORE-2, ROB-4 |
| [AR-07](https://github.com/kkrafft1999/snotra/issues/982) | Most of the agent's core logic lives outside `src/application/` | high | L | CORE-1, CORE-2 |
| [AR-08](https://github.com/kkrafft1999/snotra/issues/983) | No Electron-free composition; Electron APIs injected raw | high | M | CORE-1, SEC-3 |
| [AR-09](https://github.com/kkrafft1999/snotra/issues/984) | Nothing measures performance | high | M | PERF-1 – 4 |
| [AR-10](https://github.com/kkrafft1999/snotra/issues/985) | The chat history is read and rewritten in full on every access | high | M | PERF-2 – 4 |
| [AR-11](https://github.com/kkrafft1999/snotra/issues/986) | Decide: Auto without a platform sandbox | medium | S | SEC-2, SEC-3 |
| [AR-12](https://github.com/kkrafft1999/snotra/issues/987) | The update check cannot be switched off | medium | S | PRI-1 |
| [AR-13](https://github.com/kkrafft1999/snotra/issues/988) | Prove PRI-1 with an idle network test; check the spellchecker | medium | M | PRI-1, PRI-2 |
| [AR-14](https://github.com/kkrafft1999/snotra/issues/989) | Design the localhost remote interface | medium | M | SEC-5, CORE-1 |
| [AR-15](https://github.com/kkrafft1999/snotra/issues/990) | Windows has no sandbox, and no issue tracks it | medium | L | SEC-2, POR-1 |
| [AR-16](https://github.com/kkrafft1999/snotra/issues/991) | Background processes outlive the run on Windows; the manual says otherwise | medium | M | USE-4, POR-1 |
| [AR-17](https://github.com/kkrafft1999/snotra/issues/992) | MCP servers run unsandboxed | medium | L | SEC-2 |
| [AR-18](https://github.com/kkrafft1999/snotra/issues/993) | The own-secret check matches only verbatim | medium | M | PRI-3 |
| [AR-19](https://github.com/kkrafft1999/snotra/issues/994) | Provider parity: reasoning levels and image attachments | medium | L | POR-1, USE-4 |
| [AR-20](https://github.com/kkrafft1999/snotra/issues/995) | The image refusal blames the model | medium | S | USE-4 |
| [AR-21](https://github.com/kkrafft1999/snotra/issues/996) | Capabilities handled one by one, not as a register | medium | M | USE-4, POR-1, CORE-3 |
| [AR-22](https://github.com/kkrafft1999/snotra/issues/997) | CI jobs have no timeout | medium | S | CHG-1 |
| [AR-23](https://github.com/kkrafft1999/snotra/issues/998) | Streaming and switching chats re-render everything | medium | M | PERF-2, PERF-3 |
| [AR-24](https://github.com/kkrafft1999/snotra/issues/999) | Accessibility is checked by hand on macOS only | medium | M | USE-3, POR-1 |
| [AR-25](https://github.com/kkrafft1999/snotra/issues/1000) | Catch discipline is not guarded | medium | M | ROB-1 |
| [AR-26](https://github.com/kkrafft1999/snotra/issues/1001) | Set-aside settings and history are never mentioned | medium | S | ROB-3, USE-2 |
| [AR-27](https://github.com/kkrafft1999/snotra/issues/1002) | The start-up chain has no catch | medium | S | ROB-1 |
| [AR-28](https://github.com/kkrafft1999/snotra/issues/1003) | The update helper on macOS and Linux has no rollback | medium | M | ROB-2 |
| [AR-29](https://github.com/kkrafft1999/snotra/issues/1004) | Ports and contracts are unchecked prose | medium | M | CORE-1, CHG-1 |
| [AR-30](https://github.com/kkrafft1999/snotra/issues/1005) | The composition root has grown back | medium | S | CORE-2 |
| [AR-31](https://github.com/kkrafft1999/snotra/issues/1006) | Business logic sits in IPC handlers | medium | M | CORE-2 |
| [AR-32](https://github.com/kkrafft1999/snotra/issues/1007) | Locale branches outside the catalogue | medium | S | I18N-2, ROB-1 |
| [AR-33](https://github.com/kkrafft1999/snotra/issues/1008) | Tool knowledge spread over many files | medium | M | CORE-1, CORE-2 |
| [AR-34](https://github.com/kkrafft1999/snotra/issues/1009) | `architecture.md` has drifted from the code | medium | S | CHG-2 |
| [AR-35](https://github.com/kkrafft1999/snotra/issues/1010) | `security-concept.md` does not know #792 and #946 | medium | S | CHG-2, SEC-1 |
| [AR-36](https://github.com/kkrafft1999/snotra/issues/1011) | Prompt-injection flagging has no layer | low | M | SEC-4 |
| [AR-37](https://github.com/kkrafft1999/snotra/issues/1012) | Low-severity findings: security and privacy | low | S | SEC-1, PRI-2, PRI-3 |
| [AR-38](https://github.com/kkrafft1999/snotra/issues/1013) | Low-severity findings: robustness and usability | low | S | USE-1, USE-2, USE-4, ROB-5, I18N-1 |

**Already covered elsewhere, not filed again:** the CI red rate above the 5 %
trigger (#883, #886, #887 and the revisit of `test-concept.md` they belong to);
image attachments for Anthropic, Google and Ollama (#90 – #92, the decision is
in AR-19).

## When to look again

- **Before the first second front end** (headless, CLI or mobile) is started:
  CORE-1 and SEC-5 against the state of AR-05 – AR-08 and AR-14.
- **Once AR-09 measures:** PERF-1 – PERF-4 with numbers instead of reading.
- **Otherwise in six months**, or when a goal in
  [`quality-requirements.md`](./quality-requirements.md) changes.
