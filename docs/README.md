# Developer documentation

What Snotra Agent is made of, why it is built that way, and how it is worked
on. Everything here is internal and written in English. The user manual is a
separate thing: it lives in [`manual/`](../manual/) and is published at
https://docs.snotra-ai.dev.

The folders are sorted by topic, not by where a document came from — nearly
every one of them started as an issue.

## [`architecture/`](./architecture/) — how the app is built

- [`architecture.md`](./architecture/architecture.md) — layers, ports and
  adapters as the code has them, kept honest by `test/architecture-doc.test.js`.
  Its diagrams sit next to it: containers (C4 level 2), layers, hexagon,
  functional view, and where the agent's text comes from.
- [`quality-requirements.md`](./architecture/quality-requirements.md) — what
  the system has to achieve: constraints, ranked quality goals, scenarios,
  performance budgets.
- [`architecture-review.md`](./architecture/architecture-review.md) — the
  architecture measured against those requirements, findings AR-01 … AR-38.

## [`concepts/`](./concepts/) — features, designed before they were built

- [`hooks.md`](./concepts/hooks.md) — user-defined commands at fixed events of
  a run.
- [`memory-and-rules-concept.md`](./concepts/memory-and-rules-concept.md) — what
  goes into memory, rules files, skills and `AGENTS.md`, and how the agent
  writes them.
- [`task-kinds-concept.md`](./concepts/task-kinds-concept.md) — a kind of task
  per chat, for the usage report.
- [`web-search-concept.md`](./concepts/web-search-concept.md) — web search as a
  core tool with an exchangeable provider.

## [`security/`](./security/) — what the agent may do

- [`security-concept.md`](./security/security-concept.md) — permission modes,
  policy, approvals, sandbox, audit.
- `permissions-infographic.*` — the same model on one page, English and German,
  as HTML source and the PNG the READMEs show.

## [`remote/`](./remote/) — the mobile remote

- [`remote-interface.md`](./remote/remote-interface.md) — decision record: how a
  front end that is not the app window reaches the core.
- [`remote-protocol.md`](./remote/remote-protocol.md) — the wire protocol
  between app, relay and phone, down to the byte.
- [`remote-pairing-sequence.svg`](./remote/remote-pairing-sequence.svg) — the
  pairing and the channel as a sequence diagram.
- [`remote-protocol/`](./remote/remote-protocol/) — the protocol's test vectors,
  written by `scripts/remote-protocol-vectors.js` and
  `scripts/remote-protocol-channel-vectors.js`.

## [`development/`](./development/) — how the project is worked on

- [`test-concept.md`](./development/test-concept.md) — test levels and what
  keeps them fast without testing less.
- [`code-review-concept.md`](./development/code-review-concept.md) — the staged
  review of the whole code base.
- [`electron-lessons.md`](./development/electron-lessons.md) — Electron pitfalls
  that cost time once.

## [`release/`](./release/) — shipping and updating

- [`release.md`](./release/release.md) — the release pipeline and the app's
  self-update, with [`release-flow.svg`](./release/release-flow.svg).
- [`macos-signing-plan.md`](./release/macos-signing-plan.md) and
  [`windows-signing.md`](./release/windows-signing.md) — code signing per
  platform.

## [`ui-design/`](./ui-design/) — mockups

HTML mockups that a UI decision was made on. They show the state at the time of
the decision, not the current app.

## Where a new document goes

Into the folder of its topic. A concept for a feature that has no folder of its
own goes into `concepts/`; once a topic collects several documents, like the
mobile remote did, it gets its own folder. Diagrams sit next to the document
that explains them.
