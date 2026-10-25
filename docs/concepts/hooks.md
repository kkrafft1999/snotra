# Hooks — design

Hooks are user-defined commands that Snotra itself runs at fixed events of a
run, not the model. They make behaviour deterministic that instructions in
`AGENTS.md` or a skill can only ask for: format every file the agent wrote,
refuse certain commands or paths outright, add context at the start of a chat,
check the result before a run is reported finished, signal when a run waits or
ends.

This document is the contract the implementation is built against
([epic #925](https://github.com/kkrafft1999/snotra/issues/925), design
[#926](https://github.com/kkrafft1999/snotra/issues/926)). It was agreed with
the owner on 2026-10-17. **Nothing of it is built yet**; the parts land in
[#927](https://github.com/kkrafft1999/snotra/issues/927) (port, tool events),
[#928](https://github.com/kkrafft1999/snotra/issues/928) (trust, sandbox),
[#929](https://github.com/kkrafft1999/snotra/issues/929) (remaining events) and
[#930](https://github.com/kkrafft1999/snotra/issues/930) (trace, settings,
manual). Whoever changes the contract while building changes this document in
the same pull request.

Code references name functions first; line numbers are those of `main` at
`54bc533` and will drift.

## 1. Decisions at a glance

| Question | Decision |
| --- | --- |
| File format | **Own schema** (`version: 1`), shaped like Claude Code's (event → list of hooks), with Snotra's tool names and risk-class matchers. **No importer**; the manual carries a mapping table (§9). |
| Events | `ChatStart`, `PromptSubmit`, `PreToolUse`, `PostToolUse`, `RunEnd`, `Notification` (§2). |
| Levels | User `~/.snotra/hooks.json`, workspace `.agents/hooks.json`. Both run; user first, then workspace, each in file order, one after the other (§3.4). |
| Handler | A shell command. Event as JSON on stdin, answer through exit code and optional JSON on stdout. Exit `2` blocks, as in Claude Code (§4). |
| Precedence | A hook can tighten, never loosen. The strictest answer wins (`deny` > `ask` > `allow`); a policy `deny` is final (§5). |
| Hook failure in `PreToolUse` | Counts as **`ask`**: the call gets the approval card with the hook's error, in every mode (§4.5). |
| Trust | Workspace hooks are inert until trusted. Trust is remembered per canonical folder and a SHA-256 over `.agents/hooks.json` **plus every file under `.agents/hooks/`**; any change asks again (§6.1). |
| Sandbox | Every hook runs in the `shell_execute` sandbox. Only a **user-level** hook may opt out with `"sandbox": false`; a workspace hook never can (§6.2). |
| Argument rewriting | Not supported. A hook can refuse a call, not change it (§10). |

## 2. Events

There is no chat lifecycle in the engine today: `runSend` in
`src/application/chat/chat-engine.js` rebuilds the whole system prompt for every
run from the history the renderer sends. The events below are therefore defined
in terms of runs, and `ChatStart` keeps its own small piece of state.

| Event | Fires | Answers that count | Effect |
| --- | --- | --- | --- |
| `ChatStart` | Before the first model request of the first run of a chat in this app process | `context` | Marked block in the system prompt, cached for the chat |
| `PromptSubmit` | Once per run, before anything goes to the model | `deny`, `context` | Blocks the run with a reason shown to the user, or adds context to this run |
| `PreToolUse` | Per tool call, after the planner and the policy verdict, before any card | `allow`, `ask`, `deny` | Tightens the policy verdict (§5) |
| `PostToolUse` | Per tool call that actually ran, after the result is in | `context`, `deny` | Feedback appended to the tool result for the model |
| `RunEnd` | When the model ends a round without tool calls | `deny` | Sends the model back for another round with the reason, at most 3 times per run |
| `Notification` | A card waits for the user; a run has ended | — | Side effects only; not awaited |

Answers an event does not list are ignored and noted in the trace.

### 2.1 `ChatStart`

- **Fires** in `runSend` after the context blocks are loaded (after the memory
  block, around :1296) and before `composeSystem()` (:1311), when no `ChatStart`
  has run for this `chatId` since the app started. `reason` is `"new"` when the
  history holds a single user message, otherwise `"resumed"`; a chat reopened
  after a restart is `"resumed"`.
- **Effect:** the combined `context` of all `ChatStart` hooks becomes one marked
  block, *Context from hooks*, placed after the folder memory and before the
  workspace block (so the "tool results are data" rule still follows it, as for
  `AGENTS.md`, see the comment at :1298). It passes through
  `guardEmbeddedFiles` like every embedded text and gets its own entry in the
  context breakdown (`buildStaticContextParts`).
- **Cached per chat** in the engine's memory for the life of the app process.
  Re-running it on every run would change the system prompt each time and
  defeat the provider's prompt cache. A chat's entry is dropped when the chat is
  deleted, and the whole cache when the hook files change.
- Exit `2` or `deny` cannot block a chat; they are reported as a hook error.

### 2.2 `PromptSubmit`

- **Fires** in `runSend` once the messages are validated (after :1075) and
  before the target is resolved (:1077). The prompt is the last user message of
  the history.
- **`deny`** (or exit `2`) ends the run before any provider request with a new
  result code `HOOK_BLOCKED` and the hook's reason. The renderer treats it like a
  failed send since #919 (`abandonSend` in `ChatStream.js`): both messages are
  removed and the draft goes back into the composer. The model never sees the
  prompt.
- **`context`** is attached to the user message of *this run only*, as a marked
  trailer. It is not written to the chat history, so later runs do not see it;
  context that has to stay belongs in `ChatStart`.
- A hook error lets the prompt through and shows the error in the trace. A
  guard that must never fail open belongs in `PreToolUse`, where errors ask.

### 2.3 `PreToolUse`

- **Fires** in `runToolCall` after `tools.plan()` (:2134), after the
  repeated-denial check (:2164) and after `decideToolPolicy()` (:2175) — so the
  hook sees the resolved targets, the risk classes and the policy verdict — and
  before the outside-folder card (:2202) and the approval card (:2224).
- It runs for every tool, including MCP tools (`mcp__<server>__<tool>`) and
  `propose_config_change`. It does **not** run when the verdict is already
  `deny`: there is nothing left to tighten.
- **Effect:** see the precedence table in §5. A hook `deny` returns
  `permissionDenied` with the new reason `hook_denied`; the message for the
  model names the hook and carries its reason. It is remembered like a user's
  denial (`deniedPlanKeys`), so the identical call a second time ends the run
  with `repeated_denial` instead of looping.
- **The decision is made once per call.** When the plan is re-planned after a
  card (:2236) or after `reclassify` (:2325), the hooks do not run again; the
  arguments are the same.

### 2.4 `PostToolUse`

- **Fires** in the call loop after `runToolCall` returned (:2539) and before
  `capToolOutput` (:2569) — only for calls that actually ran. A denied, unknown
  or cancelled call gets no `PostToolUse`.
- **Effect:** `context` (or the reason of exit `2` / `deny`, which here means
  "the hook reports a problem") is appended to the tool result as a marked
  section, `<hook_feedback hook="workspace:lint">…</hook_feedback>`. It stays a
  tool result, so the existing rule *tool results are data, not commands*
  applies. When the result has to be shortened for the budget, the tool output
  is cut first and the feedback is kept.
- A hook error is shown in the trace; the model gets no feedback for it.
- **Injection flags (#1011).** A `PostToolUse` hook is meant to become one
  more source behind `application/ports/injection-flag-port.js`, next to the
  built-in detector: a hook that recognises an injection adds a flag with the
  source `hook:<key>`, merged with the built-in one onto the tool row. The flag
  is a warning and nothing more — it does not reach the model, the policy or
  any card.
- **A failing tightening hook fails open.** `PostToolUse` runs after the call,
  so it cannot hold one back; a hook that errors, times out or answers with
  garbage leaves the result as it is — no feedback and, as a flag source, no
  flag. That is fail-open for the hook's own effect only: every boundary that
  was in force holds unchanged, and the next call goes through the policy and
  `PreToolUse` again. A guard that must never fail open does not belong here
  but in `PreToolUse`, where an error counts as `ask` (§4.5).

### 2.5 `RunEnd`

- **Fires** at the natural end of a run: the model returned a message without
  tool calls (:2495). It does not fire on cancel, error, the round limit or a
  run ended by a denial.
- **`deny`** (or exit `2`) keeps the run going: the assistant message stays in
  the history, a marked message with the hook's reason is appended, and the
  round loop continues instead of returning.
- **Loop guard:** at most **3** send-backs per run, and the round budget
  (`toolRoundLimit`) still applies. The payload carries `send_backs` so a hook
  can stop itself. Once the limit is reached the run ends normally and the trace
  says that a hook wanted another round.
- A hook error ends the run normally and shows the error.

### 2.6 `Notification`

- **Fires** with `kind: "approval"` wherever the engine emits
  `PERMISSION_PROGRESS_EVENTS.AWAITING` (the approval card in `askUser`, the
  config card, the outside-folder and sandbox cards), and with
  `kind: "run-end"` in the `finally` of `runSend` (:2606), with
  `outcome: "completed" | "cancelled" | "error" | "blocked"`.
- **Fire and forget:** not awaited, the answer is ignored, errors go to the
  trace and the log. If the previous run of the same hook is still going, the
  new event for it is skipped, so a slow notifier cannot pile up processes.
- Default timeout 10 s instead of 30 s.

## 3. Hook files

### 3.1 Where they live

| Level | File | Scripts by convention | Needs trust |
| --- | --- | --- | --- |
| User | `~/.snotra/hooks.json` | anywhere | no — the user's own file, like `~/.snotra/AGENTS.md` |
| Workspace | `.agents/hooks.json` in the open folder | `.agents/hooks/` | yes (§6.1) |

The legacy `~/.agents/` level that skills and `AGENTS.md` still read is **not**
read for hooks: a file that runs code gets exactly one place per level.

Both files are read through `main/services/embedded-text-file.js`
(`readForPrompt`): bounded in size like `AGENTS.md`, and a symlink that leads out of its
root counts as absent (#534). They are read for every run, like `AGENTS.md`;
there is no cache that could go stale.

### 3.2 Schema

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "id": "no-env-files",
        "description": "Never touch .env files",
        "match": { "paths": ["**/.env", "**/.env.*"] },
        "command": "echo 'This project keeps secrets in .env; do not read or write it.' >&2; exit 2"
      },
      {
        "id": "no-force-push",
        "match": { "tools": ["shell_execute"], "commands": ["git push*--force*", "git push*-f*"] },
        "command": ".agents/hooks/ask.sh 'Force-push needs a human'"
      }
    ],
    "PostToolUse": [
      {
        "id": "format",
        "description": "Prettier on every file the agent wrote",
        "match": { "risk": ["write"], "paths": ["**/*.{js,ts,css,md}"] },
        "command": ".agents/hooks/format.sh",
        "timeoutMs": 60000
      }
    ],
    "Notification": [
      {
        "id": "sound",
        "match": { "kinds": ["approval"] },
        "command": "afplay /System/Library/Sounds/Glass.aiff",
        "sandbox": false
      }
    ]
  }
}
```

Top level:

| Field | Type | Rule |
| --- | --- | --- |
| `version` | number | Required, `1`. A higher version makes the whole file unreadable (shown, nothing runs from it) rather than half-understood. |
| `hooks` | object | Keys are event names from §2; each value is a list of hooks. An unknown event name is an error for that key. |

Per hook:

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `id` | string | — | Required. `^[a-z0-9][a-z0-9-]{0,63}$`, unique within the file. Names the hook in the trace, the trust prompt and the settings; with the level it forms the key `user:format` / `workspace:format`. |
| `description` | string | — | Up to 200 characters, shown in the trust prompt and the settings. |
| `match` | object | matches everything | §3.3. Only for `PreToolUse`, `PostToolUse` and `Notification`. |
| `command` | string | — | Required, at most 8,000 characters (`SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS`). |
| `timeoutMs` | number | 30,000 (`Notification`: 10,000) | 500 to 300,000, the `shell_execute` limits. |
| `enabled` | boolean | `true` | `false` keeps the hook in the file but never runs it. Switching a hook off in the settings is stored separately (§7) and does not touch the file. |
| `network` | string[] | `[]` | Domains the hook may reach through the sandbox proxy, in the notation of `shell_execute`'s domains. Shown in the trust prompt. |
| `sandbox` | boolean | `true` | `false` is accepted **only in the user file**. In a workspace file it makes the hook invalid. |

Validation is strict, because a typo in a guard must not pass as a guard that
matches nothing: an unknown key, a wrong type or a value out of range makes
**that hook** invalid. Invalid hooks never run; the valid ones of the same file
do. Every invalid hook and every unreadable file is listed in the settings and
noted once per run in the trace. The schema and its validation live in
`src/shared/contracts/` as pure functions, so the adapter, the settings page
and the tests share them.

### 3.3 Matchers

Matchers are applied to the **plan**, not to the raw arguments the model
produced. The planner has already resolved and contained the paths, so a
`../` detour or a different spelling of the same file cannot slip past a path
matcher.

| Field | Matches | Notation |
| --- | --- | --- |
| `tools` | tool name | Exact names, `*` as wildcard: `["write_file_text", "mcp__github__*"]` |
| `risk` | any of the call's risk classes | `read`, `read-sensitive`, `write`, `delete`, `execute`, `external` |
| `paths` | any target of the plan | Globs (`**`, `*`, `?`, `{a,b}`) on the path relative to the workspace root; patterns starting with `/` or `~/` match targets outside it |
| `commands` | the `shell_execute` command line | Glob with `*` on the trimmed line |
| `kinds` | `Notification` only | `approval`, `run-end` |

Within a field the entries are alternatives (OR); fields combine with AND. A
field that does not apply to the call — `commands` on `edit_file`, `paths` on a
call without targets — does not match. A hook without `match` matches every
call of its event.

`risk` is the preferred way to say "every tool that writes": it keeps matching
when new writing tools are added, which a list of tool names does not.

### 3.4 How the levels combine

- Both levels are loaded for every run. Hooks run **one after the other**:
  first all matching user hooks, then all matching workspace hooks, each in the
  order of its file. Sequential order keeps the trace readable and the outcome
  reproducible.
- Ids are per level. A workspace hook with the same id as a user hook is a
  different hook; a workspace file cannot replace, reorder or switch off a user
  hook.
- **Decisions** combine to the strictest one (`deny` > `ask` > `allow`), so the
  order never changes the outcome. On the first `deny` the remaining
  `PreToolUse` hooks of that call are skipped.
- **Context** from several hooks is concatenated in run order, each part headed
  with its hook key.

## 4. The command handler

### 4.1 How it is started

- Through the same login shell and the same spawn path as `shell_execute`
  (`shell-runner-service.js` → `planSpawn` in `sandboxed-spawn.js` →
  `child-run.js`), with its process-tree kill and output sinks.
- Working directory: the workspace root; without an open folder the home
  directory (workspace hooks never fire without a folder).
- Environment: the login-shell `PATH` and the sandbox's run variables, plus
  `SNOTRA_HOOK_EVENT`, `SNOTRA_HOOK_ID`, `SNOTRA_HOOK_LEVEL` and
  `SNOTRA_WORKSPACE_ROOT`.

### 4.2 Input on stdin

One JSON object, followed by a newline; stdin is then closed. Keys are
`snake_case`, as in the JSON the tools return to the model. Where a key means
the same as in Claude Code's hook input, it has the same name
(`hook_event_name`, `cwd`, `tool_name`, `tool_input`, `prompt`), which keeps
small scripts portable.

Common to every event:

```json
{
  "version": 1,
  "hook_event_name": "PreToolUse",
  "hook": { "id": "no-env-files", "level": "workspace" },
  "chat_id": "c-…",
  "run_id": "r-…",
  "workspace_root": "/Users/me/project",
  "cwd": "/Users/me/project",
  "permission_mode": "smart",
  "locale": "en"
}
```

`run_id` is assigned by the engine per run, so a hook can relate the events of
one run. `workspace_root` is `null` without an open folder.

Per event:

| Event | Additional fields |
| --- | --- |
| `ChatStart` | `reason`: `"new"` \| `"resumed"` |
| `PromptSubmit` | `prompt` (text), `attachments`: `[{ "name", "type" }]` — names only, never content |
| `PreToolUse` | `tool_name`, `tool_input` (the parsed arguments), `risk_classes`, `targets`: `[{ "path", "relative_path", "kind", "sensitive" }]`, `shell_command` (for `shell_execute`), `policy`: `{ "decision", "source" }` |
| `PostToolUse` | the `PreToolUse` fields without `policy`, plus `tool_response`: `{ "content", "is_error", "file_changes": [{ "path", "kind" }], "sandbox_blocked", "duration_ms" }` |
| `RunEnd` | `last_message` (the assistant text), `send_backs`, `rounds`, `tools_used` (names), `file_changes` |
| `Notification` | `kind`: `"approval"` \| `"run-end"`; for `approval`: `tool_name`, `checkpoint`; for `run-end`: `outcome` |

Limits and masking:

- The whole input is capped at 200,000 characters
  (`SHELL_EXECUTION_LIMITS.MAX_STDIN_CHARS`). Longer string fields —
  `tool_input.content`, `tool_response.content`, `prompt`, `last_message` — are
  cut from the end until it fits, and `"truncated": ["tool_input.content", …]`
  lists what was cut.
- The input passes through the own-secret guard (`embedded-text-guard.js`)
  before it leaves the app: keys Snotra keeps for itself are never handed to a
  hook.
- **Workspace hooks** never see content the policy classed `read-sensitive`:
  for such a call `tool_response.content` is replaced by
  `[sensitive content withheld]`, the existing redaction placeholder.

### 4.3 Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Success. stdout is read as the answer (§4.4). |
| `2` | Block. stderr (trimmed) is the reason; stdout is ignored. For `PreToolUse` this is `deny`, for `PromptSubmit` a block, for `RunEnd` a send-back, for `PostToolUse` feedback. For `ChatStart` and `Notification` it is a hook error. Same convention as Claude Code. |
| anything else, killed by a signal, could not be started, sandbox could not be prepared | Hook error (§4.5). |

### 4.4 Answer on stdout

- Empty stdout: no answer — for `PreToolUse` the same as `allow`.
- stdout that starts with `{` (after trimming) is parsed as JSON:

  ```json
  { "decision": "deny", "reason": "Force-push needs a human", "context": "…" }
  ```

  | Field | Values | Limit |
  | --- | --- | --- |
  | `decision` | `allow`, `ask`, `deny` | — |
  | `reason` | text for the model and the user | 2,000 characters |
  | `context` | text for the model | 10,000 characters per hook, 20,000 per event |

  Unknown fields are ignored, for forward compatibility. JSON that does not
  parse is a hook error, not plain text — a guard whose answer is garbled must
  not pass as a guard that said nothing.
- Any other stdout is plain text and counts as `context` for the events that
  take context; for the others it only goes to the trace.
- Whatever exceeds a limit is cut and ends in
  `… [cut by Snotra: hook output over N characters]`. Raw stdout and stderr are
  read up to the `shell_execute` cap of 200,000 bytes each; the rest is
  dropped.

### 4.5 Timeout, crash, cancel

- **Timeout:** the process tree is killed (`killTree`), and the hook counts as
  failed.
- **Hook error** — timeout, crash, unexpected exit code, unparsable JSON, a
  sandbox that cannot be prepared — is never swallowed and never takes the run
  down. Per event:
  - `PreToolUse`: counts as **`ask`**. The call gets the approval card with the
    hook's error in it, in every permission mode including `auto`. Without an
    approval UI that is `no_approval_ui`, i.e. a denial.
  - `PromptSubmit`, `PostToolUse`, `RunEnd`, `ChatStart`, `Notification`: the
    run carries on as if the hook had not answered; the error is in the trace.
- **Cancel:** when the run is aborted, running hook processes are killed with
  it and their results are discarded.
- Hooks of one event run one after the other, so the time they cost adds up.
  The trace shows each hook's duration, which is the first place to look when a
  run feels slow.

## 5. Precedence

A hook adds a check on top of the existing decision; it never takes one away.
The binding order of `docs/security/security-concept.md` §3 (hard boundaries → deny
rules → `ask-all` → `auto` → `smart`) stays as it is, and the hook verdict is
combined with its result:

| Policy verdict | Hook `allow` / no answer | Hook `ask` | Hook `deny` | Hook error |
| --- | --- | --- | --- | --- |
| `allow` (`auto`, session grant, command rule, allow rule, matrix) | `allow` | card | `deny` (`hook_denied`) | card with the error |
| `ask` | card | card | `deny` (`hook_denied`) | card with the error |
| `deny` (hard boundary, deny rule, disabled or unknown tool) | `deny` — the hook does not run | | | |

Further rules:

- **A card a hook forced offers only *Allow once* and *Reject*.** A session or
  "always" approval would not hold anyway — the hook asks again next time — so
  the card does not offer it. The card shows which hook asked and why.
- `allow` from a hook skips **nothing**: not the card the policy asks for, not
  the outside-folder card, not the sandbox, not the output checkpoint for
  sensitive output. Claude Code's `allow`, which skips the permission prompt,
  has no counterpart here.
- The sandbox, its refusal cards and the live-network card work as before; a
  hook cannot widen what the sandbox allows.
- A hook verdict is part of the call's audit entry (`entry.permission`), next to
  the policy source.

## 6. Security

### 6.1 Trust for workspace hooks

A folder cloned from somewhere must not run code just because it was opened.

- **Inert until trusted.** Workspace hooks do not run until the user has
  trusted exactly this content. Until then the chat says once per chat that the
  folder brings hooks, with a way to review them; runs are not blocked.
- **What is shown** before trusting: for every hook its event, id,
  description, matcher in words, the command verbatim (invisible and
  bidirectional characters made visible as on the approval card, `⟨U+202E⟩`),
  timeout, network domains and sandbox state; the files under `.agents/hooks/`
  with their sizes and their content on request; and the current isolation
  state of the sandbox on this machine.
- **What is remembered:** per canonical workspace root, a SHA-256 over a
  manifest of `.agents/hooks.json` and every regular file under
  `.agents/hooks/` (relative path and bytes, sorted by path; a symlink counts
  with its target path, one that leads out of the folder as absent), together
  with whether the sandbox isolated at the time of the decision. A refusal is
  remembered with the same hash, so the same content does not ask again.
  Limits: at most 200 files and 5 MB under `.agents/hooks/`; beyond that the
  content cannot be reviewed, and the hooks stay inert with that reason.
- **Where:** in the HMAC-signed `tool-policy.json`, next to the workspace rules
  and the sandbox opt-out — the store that already holds the security
  decisions per folder. Not in `ui-preferences.json`, which is unsigned.
- **What asks again:** a different hash (any change to the file or a script,
  added or removed files), a sandbox that isolated at trust time and no longer
  does, and a reset of the policy store.
- **The hash is checked again right before each workspace hook runs**, not only
  when the files are loaded. If it differs, workspace hooks are inert for the
  rest of the run and the prompt appears. This closes the gap between loading
  and running, including a change the agent itself made during the run.
- **The agent cannot rewrite the hooks unseen.** `.agents/hooks.json` and
  `.agents/hooks/**` are added to the paths that always ask before a write, in
  every mode, and to the sandbox's write-deny list — for `shell_execute`, for
  `run_python` and for the hooks themselves. A change approved on a card still
  changes the hash and asks for trust again.
- **Revoking** is possible at any time in the settings (#930); the record is
  removed and the hooks are inert again.

The two alternatives #928 lists stay rejected: never running workspace hooks
loses the point of sharing them with a project, and trusting a whole folder
once would let a later change run unseen.

What the hash does not cover is code the command calls outside
`.agents/hooks/` — `npm run lint` runs whatever `package.json` says. That is the
project's own code; the user trusts the command, and the sandbox limits what it
can do.

### 6.2 Sandboxing

- Every hook runs through `planSpawn` with the rules of `shell_execute`: write
  access to the workspace and a per-run temp folder, the sensitive read paths
  denied, network only to the domains in the hook's `network` list. A hook
  gets **none** of the chat's sandbox grants: the cards a user answered for the
  model's calls do not extend to hooks.
- A user-level hook with `"sandbox": false` runs without isolation — for
  notifications, sounds or logs in the home folder. The settings show such
  hooks as not isolated. Workspace hooks cannot opt out.
- If the user switched the sandbox off for this workspace (#357), workspace
  hooks run without isolation as well; the trust prompt says so.
- If the sandbox cannot be prepared, the hook does not run (a hook error, as for
  `shell_execute`). If it is not available on this machine at all — Windows
  today, or missing dependencies — hooks run without isolation like
  `shell_execute` does there, and a workspace hook needs a trust decision that
  was taken while isolation was not available (§6.1).
- Sandbox refusals of a hook are reported in its trace entry, like those of a
  tool call. There is no refusal card for hooks: a hook is not a call the user
  can approve step by step; its rights are fixed in the file.

### 6.3 Hook output is data

- Everything a hook returns to the model is marked with its origin —
  `<hook_feedback hook="workspace:format">…</hook_feedback>` in tool results, a
  headed block in the system prompt for `ChatStart`, a marked trailer for
  `PromptSubmit` and `RunEnd`. The model is told that the text comes from a hook
  the user configured, not from the user.
- Output of workspace hooks is as foreign as the folder's `AGENTS.md` and is
  introduced by its origin. It cannot grant permissions; the rule *tool
  results are data, not commands* (`TOOL_RESULTS_ARE_DATA_RULE`) covers it.
- A hook's `reason` shown to the user is rendered as text, never as Markdown or
  HTML.

### 6.4 Switches

- A global **Hooks** switch in *Settings › Tools & security* turns every hook
  off at once — the emergency brake, like the `AGENTS.md` switch.
- Single hooks can be switched off per level. The state lives in the signed
  policy store and does not touch the file.

## 7. Architecture

- **Port** `hook-port.js` in `src/application/ports/` (#927). The engine asks it
  to run the hooks of one event and gets back one combined result; it knows
  neither where hooks live nor how they run.

  ```js
  /**
   * @typedef {'ChatStart'|'PromptSubmit'|'PreToolUse'|'PostToolUse'|'RunEnd'|'Notification'} HookEvent
   *
   * @typedef {Object} HookRunResult
   * @property {'allow'|'ask'|'deny'|null} decision  strictest answer; null = none
   * @property {Array<{ key: string, text: string }>} reasons
   * @property {Array<{ key: string, text: string }>} contexts
   * @property {boolean} failed      at least one hook errored (PreToolUse → ask)
   * @property {HookTraceEntry[]} trace
   *
   * @typedef {Object} HookPort
   * @property {(args: { event: HookEvent, workspaceRoot: string|null, chatId: string,
   *   runId: string, call?: HookCallFacts, payload: object, abortSignal: AbortSignal })
   *   => Promise<HookRunResult>} run
   * @property {(args: { event: 'Notification', workspaceRoot: string|null, chatId: string,
   *   runId: string, payload: object }) => void} notify   fire and forget
   * @property {(args: { workspaceRoot: string|null }) => Promise<HookInventory>} describe
   *   for the trust prompt and the settings
   */
  ```

  `HookCallFacts` are the planned facts matchers need: tool name, risk classes,
  targets, shell command.
- **Core:** the combination of policy verdict and hook result (§5) is a pure
  function next to `decideToolPolicy` in `src/application/permissions/`, tested
  for every mode × answer. The engine takes `hooks` as an optional dependency;
  without it, nothing changes.
- **Contracts:** event names, the schema and its validation, the answer parser
  and the limits live in `src/shared/contracts/` — pure and shared by adapter,
  settings and tests.
- **Adapter** in `src/main/adapters/`, analogous to
  `project-instructions-adapter.js`: reads both files through
  `embedded-text-file.js`, validates, matches, checks trust against the policy
  store, and runs the commands through a small hook runner in
  `src/main/services/` that reuses `sandboxed-spawn.js` and `child-run.js`.
  Wired in `src/main/composition/create-application.js`.
- **Trace:** the engine emits a new event next to `tool-line` for each hook
  run — key, event, duration, decision, short output, error — which the chat
  renders like the tool and sandbox boxes (#930).

## 8. Questions from #925, answered

| Question in #925 | Answer |
| --- | --- |
| Final events and names | The six of the draft, unchanged (§2). |
| What "a chat starts or is resumed" means without a chat lifecycle | First run of a chat in this app process; output cached per chat (§2.1). |
| Where `PromptSubmit` context goes | Into this run only; persistent context belongs in `ChatStart` (§2.2). |
| How `RunEnd` cannot loop | At most 3 send-backs per run plus the round limit (§2.5). |
| Matchers: tool names or argument patterns | Both, applied to the plan, plus risk classes (§3.3). |
| How the two levels combine | Both run, user first; strictest decision wins; no overriding across levels (§3.4). |
| Exit codes and answer format | §4.3, §4.4; exit `2` as in Claude Code. |
| Timeout and crash | §4.5; in `PreToolUse` an error asks. |
| A hook can tighten, never loosen — exactly how | §5. |
| What is remembered for trust | Folder + hash over the file and `.agents/hooks/`, plus isolation state (§6.1). |
| Do user hooks run sandboxed | Yes, with an explicit opt-out per hook only at user level (§6.2). |
| Behaviour on Windows | Like `shell_execute`: not isolated, said so in the trust prompt and the settings (§6.2). |
| "Hook input is data" — how it is marked | §6.3. |
| Own schema or Claude Code's, importer | Own schema, no importer (§9). |

## 9. Own schema, not Claude Code's

Claude Code keeps its hooks in `settings.json` under event names of its own
(`SessionStart`, `Stop`, …), matches on its own tool names (`Bash`, `Edit`) and
lets a `PreToolUse` hook *allow* a call past the permission prompt. Reading that
format directly would bind Snotra to a foreign schema whose central word means
the opposite here. An importer would have to map tool names that have no
one-to-one counterpart and make the changed meaning of `allow` visible — real
work for a handful of hooks that are quicker to rewrite.

What stays compatible: the shape of the file (event → list), exit code `2`, and
the stdin keys that mean the same thing. The manual page (#930) carries this
table:

| Claude Code | Snotra |
| --- | --- |
| `SessionStart` | `ChatStart` |
| `UserPromptSubmit` | `PromptSubmit` |
| `PreToolUse` | `PreToolUse` — `allow` does not skip any question |
| `PostToolUse` | `PostToolUse` |
| `Stop` | `RunEnd` |
| `Notification` | `Notification` |
| `SubagentStop`, `PreCompact`, `SessionEnd` | — |
| matcher `Bash` | `"tools": ["shell_execute"]` |
| matcher `Edit\|Write\|MultiEdit` | `"risk": ["write"]` |
| matcher `Read` | `"tools": ["read_file_text", "read_file_lines"]` |
| `hookSpecificOutput.permissionDecision` | `decision` |
| `additionalContext` | `context` |
| `updatedInput` | not supported |
| `$CLAUDE_PROJECT_DIR` | `$SNOTRA_WORKSPACE_ROOT` |

If users ask for an importer later, it gets an issue of its own.

## 10. Not in this epic

- **Rewriting arguments** (`updatedInput`): a hook that changes a call would
  run something other than what was planned, shown and approved.
- **Prompt-based handlers** (a small model call decides): possible later as a
  second handler type behind the same port; the answer contract stays.
- **Running hooks in parallel:** sequential is reproducible and readable; if
  `PostToolUse` latency becomes a problem, parallel runs of hooks of the same
  event can be added without changing the contract, since decisions do not
  depend on the order.
- **More events** (`ChatEnd`, before compaction, per subagent): none of them
  has a use case yet.

## 11. What the other parts take from this

- **#927** — port, contracts, adapter, `PreToolUse` / `PostToolUse` for user
  hooks; the combination table of §5 as a pure function with tests for every
  mode; the new denial reason `hook_denied`; the card without session buttons
  when a hook asked; hook denials in `deniedPlanKeys`; error → `ask`.
- **#928** — trust manifest, hash and record in the signed policy store, the
  re-check before each run, the write protection of `.agents/hooks.json` and
  `.agents/hooks/**` (always ask, sandbox write-deny), the sandbox for hooks
  without the chat's grants. It also writes the section **Hooks** into
  `docs/security/security-concept.md`, which this design does not touch: §6 of this
  document as the content, plus `hook_denied` among the denial reasons and the
  hook files among the protected paths.
- **#929** — `ChatStart` cache per chat, `PromptSubmit` context for one run,
  `HOOK_BLOCKED` with the draft given back, the limit of 3 send-backs,
  `Notification` kinds and skipping a notifier that is still running.
- **#930** — the trace event and its entries, the global switch and per-hook
  switches in the policy store, revoking trust, and the mapping table of §9 in
  the manual.
