# Quality requirements

What Snotra has to achieve as a system, written down so that architecture
decisions can be measured against it instead of against taste. Elicited in an
interview with the owner on 2026-10-15 as phase 1 of the architecture review
([#752](https://github.com/kkrafft1999/snotra/issues/752)); arc42 chapters 1, 2
and 10 served as orientation.

**Status:** draft, awaiting the owner's agreement. Phase 2 of #752 — evaluating
the architecture scenario by scenario — starts only after that.

A change to a goal, its rank or a scenario is a change to this file, made in a
pull request like any other. Issues and pull requests that touch a goal may cite
a scenario by its ID (`SEC-1`, `ROB-2`, …).

## 1. Context

Snotra Agent is a desktop app in which an AI agent works on the files of a
folder the user opens, with tools, skills and MCP servers, against the model
providers the user configures. It has no server of its own.

| Stakeholder | What they need from the system |
| --- | --- |
| **Public users** — the primary audience | Download the app from GitHub or the website and get along without the author: onboarding, manual and error messages have to carry on their own. |
| **The owner** — the only developer | Keep a large code base changeable alone, at a cadence of several releases a day at times. |
| **AI agents working on the code** | Find where a change belongs from the documentation, and learn from the gate whether it broke something. Much of the code is written this way. |
| **Future consumers of the core** — headless/server mode, a CLI, a mobile app | A core that runs without Electron and is driven through adapters, so that a new front end does not mean a second implementation. |

## 2. Constraints

| Area | Constraint |
| --- | --- |
| Organisation | Solo hobby project, no company, no paid tier. Everything runs through GitHub (issues, board, Actions). |
| Runtime | Electron 44 with Electron Forge 8, Node ≥ 24. Plain JavaScript: no TypeScript, linter, formatter or renderer framework. These founding decisions are *given* here, but open to question in phase 2 (see `code-review-concept.md`, "Given, not findings"). |
| Dependencies | Two runtime dependencies (`@anthropic-ai/sandbox-runtime`, `undici`); marked, DOMPurify, pdf.js and Prism are vendored. No CDN, CSP `default-src 'none'` — the app has to run offline. |
| Platforms | macOS on Apple Silicon (signed, notarised), Windows x64 (unsigned for now, #19/#911), Linux x64 (deb, AppImage, tar.gz). **All three rank equally** — see the parity rule in §3. |
| Providers | OpenAI (Responses and Chat Completions), Anthropic, Google, Ollama, OpenAI-compatible servers (LM Studio, MLX-LM, llama.cpp, vLLM, OpenRouter). **Every provider the app offers has to work** — again under the parity rule. |
| Backend | No server of ours, no account, no telemetry — not even opt-in. Data goes to the providers and services the user sets up; the one automatic outbound call is the update check against the GitHub releases API. |
| Delivery | Ruleset on `main`: pull request required, unit and e2e tests on macOS, Windows and Linux mandatory, no bypass for anyone (#240). Squash merge. Releases are cut from a tag that must match `package.json` (#570). |
| Languages | English is the source language of the UI and the manual, German is derived and held to the same standard (`.claude/rules/language.md`). |

## 3. Quality goals

Ranked: when two goals conflict, the higher one wins.

| Rank | Goal | In one sentence |
| --- | --- | --- |
| 1 | **Agent security** | The agent cannot do anything the user did not allow, and what it may do stays inside the boundaries the user can see. |
| 2 | **Usability and accessibility** | A public user gets along without help, every state gives feedback, and the app meets WCAG 2.1 AA in light and dark. |
| 3 | **Privacy** | Data stays on the user's machine and with the services the user set up; anything beyond that needs consent. |
| 4 | **Robust operation** | Updates, broken files and failed runs never cost data or the ability to start — and nothing goes wrong silently. |
| 5 | **Separable core** | The application core runs without Electron, so that headless, CLI and mobile front ends can be built on it. |

Below the top five and still binding — they lose a conflict with the five above,
but they are not optional:

| Goal | In one sentence |
| --- | --- |
| **Safe changeability** | A change by the owner or by an AI agent is verified on all three platforms before it reaches `main`. |
| **Portability and parity** | macOS, Windows and Linux, and every offered provider, are first-class. |
| **Bilingual interface** | English and German are complete; a third language needs only a new catalogue. |
| **Performance** | Start-up, responsiveness and memory stay within fixed budgets. |

### Rules for the conflicts that are already decided

These came out of the interview and override the ranking where they apply.

- **Security over usability.** Already practised: skill folders back to
  read-only (#548), no Auto mode without the OS keyring (#419). A softer setting
  can be offered per workspace when otherwise users would switch a protection
  off entirely, but it is never the default (#357).
- **Privacy has a floor the ranking cannot lower.** No data goes to a service
  the user did not set up before the user has agreed to it, with the service
  named and the consent revocable. Above that floor usability wins.
- **Update check: automatic, but switchable.** The check at start-up stays on by
  default, so that security fixes arrive; a setting turns it off.
- **Parity: ship, and show the gap.** A feature that cannot reach every platform
  or provider in time ships where it works. The gap is visible in the UI where
  the user meets it, named in the manual, and tracked by an issue.
- **Logic always goes through the core.** Business logic belongs in
  `src/application/` behind ports, even when building it directly in main or
  the renderer would be faster. The rank decides *what* the product does when
  goals collide; this rule decides *where* the logic lives, and it is not traded
  for speed.
- **Remote control stays on the machine.** Headless and mobile front ends reach
  the core over localhost only. Anything further — LAN, VPN, the internet — is a
  tunnel the user sets up themselves.
- **Prompt-injection detection is an extra layer, never the protection.** It
  may warn, it must not be relied on; isolation and approvals are what protect.
- **Silent misbehaviour is the worst failure.** Of all the ways the app can
  fail, an error the user does not see — a swallowed exception, a status that
  says "running" after the run ended — is the one the architecture has to guard
  against hardest.

## 4. Quality scenarios

Each scenario is written as *stimulus → response → measure*, so that phase 2 can
check it against the architecture and the code. Measures marked *(proposed)*
were set while writing this document, not in the interview, and need the
owner's confirmation.

### Agent security

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| SEC-1 | Text in a file steers the model into reading or writing a path outside the workspace, directly or through a symlink. | The tool call is refused before it touches the file system; the chat shows the refused call. | No file access outside the workspace boundary; every file tool is covered by a test for it. |
| SEC-2 | The agent wants to run a shell or Python command that no rule allows. | Nothing runs before the user approves it. On macOS and Linux the approved command runs in the sandbox, which refuses network and writes outside the workspace. | Approval for every execution not covered by a rule; sandbox on by default. |
| SEC-3 | A safety mechanism cannot be established — no OS keyring, sandbox unavailable, policy file unreadable. | The app falls back to the stricter state and says so in the UI. | No path that fails open; every degraded state is visible. |
| SEC-4 | A tool result contains text that looks like an injection. | The extra layer may flag it to the user; the call itself is still bound by isolation and approvals. | A flag never loosens a boundary, and a missing flag never opens one. |
| SEC-5 | A process tries to reach the core's remote-control interface (headless, mobile). | Only connections over the loopback interface are accepted, and only with a credential the app issued *(proposed)*. | No listening socket on a non-loopback interface. |

### Usability and accessibility

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| USE-1 | A first-time user installs the app and wants a first answer. | Setup guides them to a provider and a folder without the manual. | First answer within 5 minutes, leaving the app only to fetch an API key *(proposed)*. |
| USE-2 | An operation takes longer, or fails. | Anything over one second shows progress; a failure says what failed and what to do next, in the user's language. | No operation without feedback (see also ROB-1). |
| USE-3 | A user works with the keyboard only, or with a screen reader. | Every function is reachable by keyboard, focus is visible, controls are labelled. | WCAG 2.1 AA in light and dark. |
| USE-4 | A feature is not available on the user's platform or provider. | The UI says so where the user meets it, and the manual names it. | No undocumented gap (parity rule). |

### Privacy

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| PRI-1 | The app runs without the user sending anything. | It contacts nothing but the GitHub releases API for the update check; with the check switched off, nothing at all. | A network trace of an idle session shows at most that one request. |
| PRI-2 | A feature wants to send data to a service the user has not set up. | It asks first, naming the service; the consent can be revoked. | No request before consent. |
| PRI-3 | Keys and tokens are stored and used. | They are encrypted with the OS keyring, never logged, and never handed to the model. | The own-secrets check finds none of them in a prompt or a tool result. |

### Robust operation

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| ROB-1 | An error occurs in any layer — provider, tool, IPC, file system, renderer. | It reaches the user as a visible message, and every status in the UI ends in a final state. | No swallowed error: every `catch` rethrows, reports, or carries a comment why it may stay quiet. No "running" after the run ended. |
| ROB-2 | An update download is corrupt or interrupted, or the new version fails to swap in. | The installed version keeps working, the user learns what happened and can retry. | Never an app that does not start after an update. |
| ROB-3 | A settings, policy or chat file is unreadable or corrupt. | The app starts, keeps the unreadable file aside, falls back to defaults and says so. | No file silently overwritten; no failed start. |
| ROB-4 | The app quits or crashes in the middle of a run. | The chat up to the last completed step is preserved. | No completed message lost. |
| ROB-5 | The app writes a file in the workspace or its own data folder. | It writes to a temporary file and renames it over the target. | No half-written file after a crash. |

### Separable core

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| CORE-1 | A headless, CLI or mobile front end is built. | It reuses `src/application/` unchanged and adds only driving adapters and its own composition root. | No import of Electron, Node's file system or the DOM in `src/application/` (guarded by a test); the business logic of a feature exists exactly once. |
| CORE-2 | A feature with business logic is added. | The logic lands in `src/application/` behind ports; IPC handlers and the renderer stay thin, the composition root only wires. | Checked in review; logic piling up in the composition root (#508) is a finding. |
| CORE-3 | A new model provider is added. | It needs a new adapter, its definition and catalogue entries — nothing in `src/application/` or the renderer. | The diff touches only those places plus tests. |

### Below the top five

| ID | Stimulus | Response | Measure |
| --- | --- | --- | --- |
| CHG-1 | The owner or an AI agent makes a change. | Unit and e2e tests on all three platforms catch a regression before it reaches `main`. | Required checks, no bypass. Local gate ≤ 3 min, CI median ≤ 5 min, < 5 % red or re-run over two weeks (the revisit triggers in `test-concept.md`). |
| CHG-2 | An agent new to the code reads `docs/architecture.md` to find where a change belongs. | The document describes the code as it is. | No drift between document and code (checked in phase 2). |
| POR-1 | A feature is released. | It works on macOS, Windows and Linux and with every offered provider — or the gap is handled by the parity rule. | No undocumented gap; CI on all three platforms is mandatory. |
| I18N-1 | A UI text is added or changed. | It exists in English and German. | Tests and the manual build fail on a text or page in one language only. |
| I18N-2 | A third interface language is added. | It needs a new catalogue and an entry in the language selector, nothing else. | No language-specific branch in the code. |
| PERF-1 | The user starts the app. | The window is usable. | Cold start ≤ 3 s. |
| PERF-2 | The user types, clicks or switches chats. | The UI reacts. | ≤ 200 ms. |
| PERF-3 | A long answer streams in, or a large workspace is open (up to the limit of 2000 watched folders). | The UI keeps responding. | No freeze longer than 500 ms. |
| PERF-4 | The app sits idle with a chat open. | — | ≤ 1 GB of memory across all its processes. |

The performance budgets apply to a current Apple Silicon Mac. On Windows, Linux
and the CI runners twice the time is allowed *(proposed)*. None of them is
measured today; how to measure them is part of phase 2.

## 5. Non-goals

What Snotra consciously does not optimise for. A request in one of these
directions is declined with a reference to this section, not weighed anew.

- **Multi-user operation.** No team server, no accounts, no shared workspaces —
  the distinction from Open WebUI or LibreChat.
- **An IDE.** Editing text files is in scope (#863, #864; the "the preview stays
  a preview" of #226 is superseded), but no language server, debugger or
  project build. Snotra is for work that isn't code.
- **A backend of our own and telemetry** — see the constraints in §2.
- **Remote control beyond localhost** — see the rules in §3.

## 6. Deliberately left open

- **Further CPU architectures** (Intel Mac, ARM Windows and Linux): neither a
  goal nor a non-goal. A request is decided on its own.

## 7. Interview record

The decisions above, as given on 2026-10-15. The record is what the goals stand
on; it is not rewritten when a goal changes — the change is made above and
dated there.

| Question | Answer |
| --- | --- |
| Who is Snotra built for, first of all? | Public users. |
| Which platforms rank equally? | All three. |
| Which providers must work? | Every provider the app offers. |
| How serious is separating the back end from the front end? | A concrete goal. |
| Which second consumer of the core is planned? | Headless/server mode, a CLI, a mobile app. |
| A feature cannot reach parity in time — what then? | Ship it where it works, show the gap, track it in an issue. |
| Update check: security or privacy? | Automatic by default, switchable. |
| Faster in main/renderer, or cleaner through `application/`? | Always through the core. |
| Ranking of the goals | Security > usability > privacy > robust operation > separable core. |
| May a feature send data to a service the user did not set up? | Only after consent. |
| Is performance a quality goal? | Yes, with budgets — the moderate set. |
| Remote control: how far may it reach? | Localhost only. |
| Which failure is the worst? | Silent misbehaviour. |
| Non-goals | Multi-user operation; an IDE. |
| Editing text files in the app (#226 vs #863/#864)? | Yes. |
| Prompt-injection detection? | As an extra layer. |
| Further CPU architectures? | Left open. |
| Further interface languages? | Not planned, but must be possible with a catalogue alone. |
