# Staged code review

Concept from 2026-09-30, tracked in epic
[#482](https://github.com/kkrafft1999/snotra/issues/482).

The whole code base is reviewed, but not in one go. It is cut into blocks that
follow the existing architecture, each small enough to be reviewed in one
sitting and to produce a set of findings that can be read in one go. The
findings become issues; fixing them is a separate, later step. That way the
review can be spread over several weeks and never turns into one large change.

## Starting point (checked 2026-09-30, `main` at `2a39533`)

- **Size:** about 68k lines in `src/`, of which roughly 8k are CSS and 3.4k the
  i18n catalogue, plus 227 test files.
- **Architecture:** the layering described in
  [`architecture.md`](./architecture.md) has been stable since July 2026 —
  renderer / preload / IPC → main adapters and composition → `application/` →
  `shared/contracts` and `shared/runtime`. The blocks below follow it.
- **Precedent:** the previous review (SNO-01 … SNO-16, #68–#83) filed one issue
  per finding. That worked and is kept, with a new ID scheme.
- **Expected change in the coming weeks**, judged from the open issues:
  - *volatile:* file tree and workspace (epic #343 with #347–#351, #74), file
    preview (#479), MCP transport (#341)
  - *quiet:* permissions and sandbox, chat engine, providers (#428 adds one but
    leaves the existing ones alone), update and release

## Blocks

A block holds at most about 2k–4.5k lines of production code; its tests are
reviewed with it. The order puts stable and security-relevant blocks first and
the volatile ones last.

| # | Block | Core paths | ≈ LOC | Stability |
|---|---|---|---|---|
| **Wave 1 — foundation and trust boundaries** |||||
| B01 | Skeleton and boundaries | `main/index.js`, `main/window*.js`, `preload/`, `shared/ipc-channels.js`, `main/composition/`, `contracts/index.js`, `contracts/enums.js`, boundary guards | 2.8k | stable |
| B02 | Permission decisions | `application/permissions/`, `tool-policy-store`, `program-allowances-service`, `ipc/tool-permission-handlers`, `tool-approval-adapter`, `contracts/tool-permissions`, `runtime/sensitive-*`, `runtime/path-pattern` | 3.9k | stable |
| B03 | Sandbox and process execution | `sandbox-service`, `sandboxed-spawn`, `shell-runner-service`, `python-runner-service`, `runtime/shell-command-guard`, `runtime/simple-command`, `runtime/sandbox-domains`, `child-output-sink` | 2.0k | stable |
| **Wave 2 — chat core** |||||
| B04 | Chat engine | `application/chat/`, `application/ports/`, `contracts/chat`, `contracts/context-breakdown`, `contracts/usage` | 3.7k | stable |
| B05 | Providers | `main/providers/`, `provider-*-adapter`, `credential-adapter`, `provider-secrets-adapter`, `request-timeout`, `contracts/llm-target`, `contracts/provider-endpoint` | 2.8k | mostly stable (#428 adds a provider) |
| B06 | Tools | `main/tools/`, `workspace-tool-adapter`, `http-url-fetch-adapter`, `tavily-web-search-adapter`, `runtime/url-safety`, `runtime/html-to-text` | 3.2k | stable |
| **Wave 3 — state and lifecycle** |||||
| B07 | Settings and persistence | `storage-service`, `ipc/settings-handlers`, `contracts/settings`, `chat-session-settings`, `settings-presentation-service`, `persistence-store-adapters`, `userdata-migration` | 3.6k | mostly stable (#473 touches it) |
| B08 | Chat history and attachments | `chat-history-normalization`, `ipc/chat-history-handlers`, `chat-attachment-store`, `contracts/attachments`, `contracts/workspace-image`, `contracts/workspace-pdf` | 1.5k | stable |
| B09 | Update and release | `update-*`, `ipc/update-handlers`, `UpdateDialog`, `application-menu`, `.github/workflows/`, `scripts/`, `package.json` | 2.3k | stable |
| B10 | Skills, memory, project instructions | `skills-*`, `skill-suggestion-service`, `memory-adapter`, `project-instructions-adapter`, their contracts and runtime helpers, `system-skills/` | 2.0k | stable (#160 comes later) |
| **Wave 4 — renderer** |||||
| B11 | Chat UI | `app.js`, `ChatStream`, `renderer/chat/`, pickers, autocomplete, `ChatHistoryPanel`, `TokenBreakdownPanel`, `renderer/state/` | 4.5k | medium |
| B12 | Approval and security UI | `ToolApprovalCard`, `tool-approval-*`, `ToolPermissionsPanel`, `SecurityPanel`, `security-overview-view`, `ProgramAllowancesSetting`, `sandbox-status-view` | 4.0k | stable |
| B13 | Settings dialog | `SettingsModal`, `McpPanel`, `MemoryPanel`, `*Setting.js` | 3.5k | medium |
| B14 | Styling and language catalogue | `styles.css`, `styles/tokens.css`, `index.html`, `shared/i18n/` | 13k, mostly tool-assisted | stable |
| **Wave 5 — once the areas have settled** |||||
| B15 | MCP | `mcp-service`, `mcp-stdio-transport`, `mcp-adapter`, `contracts/mcp*` | 2.1k | after #341 |
| B16 | File system and watchers (main) | `fs-service`, `ipc/fs-handlers`, `filesystem-ipc-adapter`, `directory-watcher`, `workspace-watcher`, `file-info`, search | 4.4k | after #343 |
| B17 | Workspace UI | `FileTree`, `file-views/`, `SidebarResizer`, `renderer/tree/` | 4.0k | after #343, #479, #74 |

B14 is not read line by line. It is checked with targeted searches: raw
colour and spacing values instead of tokens (against
[`ui-design-tokens.md`](../.claude/rules/ui-design-tokens.md)), key parity
between `en` and `de`, and orphaned selectors.

## Guardrails

Decided on 2026-09-30 in [#482](https://github.com/kkrafft1999/snotra/issues/482).

### What the review measures against

The project's own documents are binding. The general references come second
and are used as a checklist, not as the standard.

- **Binding:** [`architecture.md`](./architecture.md) (layers, ports, boundary
  guards), [`security-concept.md`](./security-concept.md) (risk classes,
  approval flow, workspace as trust boundary, sandbox),
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) (code conventions),
  [`ux-ui-standards.md`](../.claude/rules/ux-ui-standards.md) and
  [`ui-design-tokens.md`](../.claude/rules/ui-design-tokens.md),
  [`language.md`](../.claude/rules/language.md), and the coverage ratchet in
  `scripts/coverage.js`.
- **Checklist:** the Electron security checklist, OWASP, and common Node.js
  practice.

### Given, not findings

The code review takes the project's founding decisions as given and does not
decide on them — neither the choice of technology (plain JavaScript without
TypeScript, no linter and no formatter, a renderer without a framework,
Electron Forge as the build tool) nor the overall architecture (the layers,
the port/adapter cut, the split between main process and renderer). They do
not produce issues here; they belong to the
[architecture review](#afterwards-an-architecture-review) that follows.

### What counts as a finding

- **Always:** bugs, security gaps, possible data loss, and violations of the
  binding documents above — including WCAG 2.1 AA in the renderer.
- **Maintainability only with a nameable cost:** a duplicate that has already
  started to drift apart, a module in a core path that can no longer be
  followed, dead code that misleads. "Could be nicer" is not a finding.
- **Tests:** a finding when security- or data-relevant behaviour is untested,
  or when a test checks the wrong thing. Low renderer coverage alone is not a
  finding.
- **Performance:** only with a concrete symptom or an unbounded input (size,
  count, time), not on suspicion.
- **Code and documentation disagree:** that is a finding either way; the issue
  decides which side is right.
- **Dependencies:** outdated or vulnerable packages and the vendored libraries
  (`pdfjs`, `marked`, `DOMPurify`) are checked once, in B09, together with
  `package.json` and `scripts/sync-renderer-vendor.js`.

### How many issues per block

At most about **eight** issues of their own per block, for the weightiest
findings. Everything else above the threshold goes into the block's bundle
issue, so that each block can be read at a glance.

## Procedure per block

1. **Block issue.** File list, the commit SHA the review is pinned to, the
   matching section of `architecture.md`, and the checklist below.
2. **Review against that SHA**, within the [guardrails](#guardrails) above,
   along a fixed checklist:
   - correctness and edge cases
   - trust boundaries and security
   - error handling and cancellation
   - Windows and cross-platform behaviour (paths, CRLF)
   - conformance to the architecture (direction of dependencies, ports)
   - maintainability (size, duplication, dead code)
   - quality of the tests
   - renderer blocks additionally: UX states, keyboard operation, WCAG 2.1 AA,
     design tokens, i18n
3. **Compare with open issues** so nothing is filed twice.
4. **File the findings** as issues, in English, labelled `bug` or
   `enhancement`, on the board in *Backlog*:
   - one issue per finding, sized to one pull request, at most about eight per
     block (see [Guardrails](#how-many-issues-per-block))
   - low-severity items and anything beyond the cap bundled into one issue per
     block
   - ID scheme `CR-Bnn-mm` (e.g. `CR-B05-03`) in the title, so it does not
     collide with the earlier `SNO-nn`
   - each issue states severity (critical / high / medium / low), effort
     (S / M / L), the affected places and a definition of done
5. **Close the block issue** when the review is done — not when the fixes are.
   The fixes are prioritised afterwards like any other issue.

### Special cases

- **A finding outside the block** goes to the block it belongs to. If that
  block is already done, it is filed right away.
- **A pull request changes the block during its review:** only that diff is
  checked again, not the whole block.
- **Out of scope:** translating German comments (that runs in #281) and pure
  style preferences.

## Pace

- One block per sitting, two to four a week.
- Waves 1–4 (B01–B14) cover areas that are expected to stay quiet for the next
  three to four weeks and fit into that window.
- Wave 5 starts only once #341 and #343 are through; reviewing it earlier would
  mean reviewing code that is about to be rebuilt.

## Afterwards: an architecture review

Once the code review is done, an architecture review follows. That is where
the founding decisions are open to question: the choice of technology and the
overall architecture listed under [Given, not findings](#given-not-findings).
It gets a concept of its own when it is due. Until then, a place where a
founding decision is visibly costly may be noted in the block issue — as input
for the architecture review, not as a finding.
