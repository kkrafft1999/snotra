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

The table names the core paths. The exact file lists, tests included, are in
the block issues #486–#503, measured on 2026-10-01 at `08013d2`; the line
counts below come from that measurement. Every source and test file in
`src/`, `test/` and `e2e/` belongs to exactly one block — except the vendored
fonts, the image assets and the manual screenshot scripts `e2e/manual-*.mjs`,
which do not run in CI.

| # | Block | Core paths | ≈ LOC | Stability |
|---|---|---|---|---|
| **Wave 1 — foundation and trust boundaries** |||||
| B01 | Skeleton and boundaries | `main/index.js`, `main/window*.js`, `main/permissions.js`, `preload/`, `shared/ipc-channels.js`, `shared/limits.js`, `main/composition/`, `contracts/index.js`, `contracts/enums.js`, `ipc/shell-handlers`, `ipc/request-lifecycle`, boundary guards | 2.8k | stable |
| B02 | Permission decisions | `application/permissions/`, `tool-policy-store`, `program-allowances-service`, `ipc/tool-permission-handlers`, `tool-approval-adapter`, `contracts/tool-permissions`, `contracts/program-allowances`, `runtime/sensitive-*`, `runtime/path-pattern` | 4.1k | stable |
| B03 | Sandbox and process execution | `sandbox-service`, `sandboxed-spawn`, `shell-runner-service`, `python-runner-service`, `runtime/shell-command-guard`, `runtime/simple-command`, `runtime/sandbox-domains`, `child-output-sink` | 2.0k | stable |
| **Wave 2 — chat core** |||||
| B04 | Chat engine | `application/chat/`, `application/ports/`, `ipc/chat-handlers`, `contracts/chat`, `contracts/message`, `contracts/context-breakdown`, `contracts/usage`, `runtime/abort`, `runtime/partial-json` | 3.9k | stable |
| B05 | Providers | `main/providers/`, `provider-*-adapter`, `credential-adapter`, `provider-secrets-adapter`, `request-timeout`, `contracts/llm-target`, `contracts/provider-endpoint`, `runtime/fetch-errors`; voice input in the main process: `whisper-service`, `speech-adapter`, `contracts/voice` | 2.9k | mostly stable (#428 adds a provider) |
| B06 | Tools | `main/tools/`, `workspace-tool-adapter`, `workspace-path-adapter`, `http-url-fetch-adapter`, `tavily-web-search-adapter`, `presentation/tool-display`, `contracts/tool-categories`, `runtime/url-safety`, `runtime/html-to-text` | 3.7k | stable |
| **Wave 3 — state and lifecycle** |||||
| B07 | Settings and persistence | `storage-service`, `ipc/settings-handlers`, `contracts/settings`, `chat-session-settings`, `settings-presentation-service`, `persistence-store-adapters`, `chat-preferences-adapter`, `userdata-migration`, `rename-with-retry` | 3.8k | stable (#473 is fixed) |
| B08 | Chat history and attachments | `chat-history-normalization`, `ipc/chat-history-handlers`, `chat-attachment-store`, `contracts/attachments`, `contracts/workspace-image` | 1.3k | stable |
| B09 | Update and release | `update-*`, `ipc/update-handlers`, `UpdateDialog`, `AppVersionBadge`, `application-menu`, `.github/workflows/`, `scripts/`, `package.json` | 2.0k, plus 1.0k outside `src/` | stable |
| B10 | Skills, memory, project instructions | `skills-*`, `skill-suggestion-service`, `memory-adapter`, `project-instructions-adapter`, `environment-adapter`, their contracts and runtime helpers, `system-skills/` | 2.1k | stable (#160 comes later) |
| **Wave 4 — renderer** |||||
| B11 | Chat stream | `ChatStream`, tool log (`renderer/chat/toolLog*`, `utils/tool-log-*`), images and links in the chat (`renderer/chat/`), `ImageLightbox`, `state/store`, `utils/helpers` | 3.1k | medium |
| B12 | Composer and chat panels | `app.js`, pickers, autocomplete (with its sources in `renderer/chat/`), `SkillSuggestion`, `WhisperRecorder`, `ChatHistoryPanel`, `TokenBreakdownPanel`, `state/tool-permissions` | 3.2k | medium |
| B13 | Approval and security UI | `ToolApprovalCard`, `tool-approval-*`, `ToolPermissionsPanel`, `SecurityPanel`, `security-overview-view`, `ProgramAllowancesSetting`, `FolderSandboxShield`, `sandbox-status-view`, `tool-catalog-view` | 3.9k | stable |
| B14 | Settings dialog | `SettingsModal`, `McpPanel`, `MemoryPanel`, `*Setting.js`, `ThemeManager` | 3.6k | medium |
| B15 | Styling and language catalogue | `styles.css`, `styles/`, `index.html`, `shared/i18n/`, `renderer/i18n.js` | 13.6k, mostly tool-assisted | stable |
| **Wave 5 — once the areas have settled** |||||
| B16 | MCP | `mcp-service`, `mcp-stdio-transport`, `mcp-adapter`, the MCP tool migrations, `contracts/mcp*` | 2.1k | after #341 |
| B17 | File system and watchers (main) | `fs-service`, `ipc/fs-handlers`, `ipc/dialog-handlers`, `filesystem-ipc-adapter`, `workspace-activation`, `directory-watcher`, `workspace-watcher`, `file-info`, search, `pdf-assets`, `contracts/workspace-tree`, `contracts/workspace-pdf` | 4.8k | after #343 |
| B18 | Workspace UI | `FileTree`, `file-views/`, `SidebarResizer`, `renderer/tree/`, `nativePath`, `startupLayout` | 4.3k | after #343, #479, #74 |

The first draft of this table had seventeen blocks. Once every file was
assigned, the chat UI came to 6.3k lines, so it became B11 and B12, and the
blocks after it moved up by one.

B15 is not read line by line. It is checked with targeted searches: raw
colour and spacing values instead of tokens (against
[`ui-design-tokens.md`](../.claude/rules/ui-design-tokens.md)), key parity
between `en` and `de`, and orphaned selectors. Its few code files —
`shared/i18n/index.js`, `shared/i18n/ui-quotes.js`, `renderer/i18n.js` — are
read as usual, and the Content-Security-Policy in `index.html` is reviewed in
B01.

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
   matching section of `architecture.md`, and the checklist below. The block
   issues were filed ahead of time (#486–#503); the SHA is recorded when the
   review of a block starts.
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
   - each issue is linked to its block issue as a sub-issue
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
- Waves 1–4 (B01–B15) cover areas that are expected to stay quiet for the next
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
