# Test concept

Concept from 2026-10-11 ([#751](https://github.com/kkrafft1999/snotra/issues/751)).
The measurements behind it are in
[the issue](https://github.com/kkrafft1999/snotra/issues/751#issuecomment-6112476343);
this document keeps what a decision needs.

The quality the tests give us is not up for negotiation. This concept is about
the **time a change waits for its tests** — locally before a push and in CI
before a merge — and about the rule that keeps any speed-up honest:

> **Hard constraint.** No change to how tests run may reduce what is verified
> before a merge to `main`. Whatever runs less locally has to be covered by the
> gate; whatever leaves the gate has to be shown to be covered elsewhere.

## The levels

| Level | Where | What it is responsible for | What it leaves to another level |
| --- | --- | --- | --- |
| **Unit and wiring** | `test/*.test.js`, `node --test` | Application core, adapters, IPC contracts, the boundary guards in [`architecture.md`](./architecture.md#automated-boundary-guards), renderer components against a `happy-dom` DOM | Real Chromium — layout, focus, sanitizing — and the process model of the running app |
| **Real-system tests** (inside the unit suite) | e.g. `sandbox-isolation`, `sandbox-runners`, `shell-runner-service`, `workspace-watcher-real-fs`, `mcp-settings-handlers` | What only means something against the real thing: the Seatbelt/bubblewrap sandbox, file-system events, child processes, a real MCP server | Nothing — they guard security and data, so they stay in the gate |
| **Electron E2E** | `e2e/*.test.mjs`, `node --test` + `playwright-core` | The running app against a fake model server: sanitizing with the real DOMPurify, layout and focus, restarts, approval flows | Look and feel |
| **Look scripts** | `e2e/manual-*.mjs` | Screenshots of a state, for a person to look at | Everything automated — no gate |
| **Manual screenshots** | `manual/`, `npm run screenshots` | The generated motifs of the user manual, four variants each | — |
| **Release hand checks** | [`release.md`](./release.md) › *Manual checks before tagging* | What only a person can judge in the packaged app | — |
| **Benchmark** | `bench/tool-accuracy/` | Whether the model still picks the right tool; real model, costs tokens | Never part of CI |
| **Coverage** | `npm run coverage` | A local ratchet, not a merge condition | — |

**Three operating systems.** CI runs the unit and the E2E suite on macOS,
Windows and Linux. That is not redundancy: Windows regularly catches what a Mac
does not (line endings, drive paths, rename semantics), and the sandbox is a
different program on every platform. It stays.

**The real-system tests are a class of their own.** They are the expensive and
the fragile part of the unit suite at the same time: they wait for real
processes, timers and file-system events. In the measurements, the slow files
and the flaky files were largely the same. The rules for them are in
[*Writing tests that wait*](#writing-tests-that-wait).

## What runs when

| Moment | What runs | Who |
| --- | --- | --- |
| While working | Single files: `node --test test/<file>.test.js` | Developer or agent |
| Before every push | `npm test` and `npm run test:e2e`, in full | Developer or agent ([`git-workflow.md`](../.claude/rules/git-workflow.md)) |
| Pull request, push to `main` | `ci.yml`: both suites on three platforms — the three required checks | GitHub |
| Release tag | The same `ci.yml`, as the gate before any build | GitHub |
| Before tagging | Release hand checks | Owner |
| On demand | Look scripts, coverage, benchmark | Developer or agent |

This stays as it is. In particular the local rule does not change: before a
push, everything runs.

## What the measurements say

State of 2026-10-11, 303 unit files and 24 E2E files:

- **Local:** `npm test` takes 57 s, `npm run test:e2e` 40 s (both at the default
  concurrency on the reference machine). Inside the agent sandbox `npm test`
  is 13 % slower and covers the same tests.
- **The suite waits more than it computes.** 368 s of serial work, but only
  136 s of CPU time.
- **Half of that waiting was not the tests.** With `NODE_USE_SYSTEM_CA=1` — set
  in the agent's environment — every process that loads `tls` waits ~2 s on
  exit for the macOS keychain certificates. Without it the serial run drops
  from 368 to 239 s, the default run from 57 to 43 s, E2E from 36 to 29 s.
- **And the timing-sensitive tests were living off it.** Every denser run
  without that wait had a red test (`sandbox-isolation`, `gitignore-budget`).
- **A few files dominate.** Seven files are half of the serial time, six of
  them real-system tests; the longest (25.6 s) is the floor of the whole run.
- **CI:** 233 s from push to the last green job; the runners run only 2–3 files
  at a time (*cores − 1*) although the suite mostly waits. The macOS job grew
  from 85 to 225 s between 2026-09-29 and 2026-10-11.
- **Flakes:** 10.7 % of the runs on `main` were red or needed a re-run, mostly
  in E2E.

## Options

| | Option | Gain | Cost and risk |
| --- | --- | --- | --- |
| A | Test processes without the system certificate store (`--no-use-system-ca`) | Locally 57 → 43 s (unit), 36 → 29 s (E2E); none in CI | One flag; makes the suite denser and the timing tests fail — only together with B |
| B | Harden the tests that wait | Fewer flakes, a shorter critical path | One small change per file; must not weaken what a real-system test verifies |
| C | Keep E2E off the developer's keychain | No blocking dialog after an Electron update; the test binary no longer reaches the installed app's key | Small, but the obvious switch does not take effect yet — needs finding out |
| D | Higher concurrency on the CI runners | macOS unit step ~130 → 60–80 s (estimated) | One setting, measured in an experiment; only after B |
| E | Unit and E2E as separate CI jobs | A run takes the longer of the two instead of the sum (~233 → ~160 s); a flaky E2E file re-runs only E2E | The required checks in the ruleset change; setup runs twice |
| F | Start the longest files first (own runner on the `run()` API) | −15 % locally today, much less after A and B | Own code in the test path |
| G | Locally run only the tests a change affects; CI keeps everything | At most the local run itself, ~45 s | A dependency map that knows what DOM tests load at run time; a weaker local gate, every miss costs a red CI run |
| H | Tiers (fast per push, full before merge, extended before release) | — | They exist in effect (see *What runs when*); a new tier is only worth it together with G |
| I | Pruning redundant tests | No redundancy measured | — |

## Decision

Decided by the owner on 2026-10-11, in three steps, each measured before the
next one starts:

1. **B, A and C** — no rule changes.
   - [#881](https://github.com/kkrafft1999/snotra/issues/881) `sandbox-isolation`:
     a refused access goes missing under load (also a product question)
   - [#882](https://github.com/kkrafft1999/snotra/issues/882) `gitignore-budget`:
     time-budget assertions on the wall clock
   - [#883](https://github.com/kkrafft1999/snotra/issues/883) harden the other
     tests that wait for real time
   - [#884](https://github.com/kkrafft1999/snotra/issues/884)
     `--no-use-system-ca` for the test runs, after #881 and #882
   - [#885](https://github.com/kkrafft1999/snotra/issues/885) keep E2E off the
     developer's keychain
2. **D** — [#886](https://github.com/kkrafft1999/snotra/issues/886), an
   experiment on the runners after step 1.
3. **E** — [#887](https://github.com/kkrafft1999/snotra/issues/887), decided
   with the numbers step 2 leaves behind; the ruleset change gets the owner's
   go first, as [`git-workflow.md`](../.claude/rules/git-workflow.md) asks.

Not pursued: F (its gain shrinks once step 1 is done), G (it weakens the local
gate to save less than a minute), H beyond naming the levels here, I (nothing
measured to prune).

## Writing tests that wait

- **No fixed sleep as a guarantee.** Wait for the state itself, with a
  deadline, the way the E2E helpers poll.
- **Inject time limits.** A test that needs a time budget or a timeout to run
  out gets a short one injected; that the real default has the right value is
  a separate, instant assertion.
- **No wall-clock bounds near the real time.** A performance guard asserts the
  mechanism (it gives up, it counts, it is not called again); a wall-clock
  bound, if any, sits far from the time the unprotected case would take.
- **A real-system test stays real.** It is made robust, never replaced by a
  mock — that is what it is there for.
- **Nothing from the machine.** No test depends on the machine's trust store,
  its keychain or the network.
- **Prove it denser.** A change that touches one of these tests runs the suite
  at a higher concurrency than usual a few times before it is merged — that is
  where the races show.

## When to revisit

The concept is reopened when one of these holds:

- the full local gate (`npm test` plus `npm run test:e2e`) takes more than
  3 minutes on the reference machine,
- a CI run takes more than 5 minutes from push to green at the median,
- more than 5 % of the runs on `main` are red or need a re-run over two weeks.

G and a sharded CI are the candidates for that day.
