# Architecture

A short overview of the layered and port/adapter structure of Snotra AI after
the five roadmap stages were completed (as of 2026-07-12). Diagrams:
[`architecture-layers.svg`](./architecture-layers.svg),
[`architecture-hexagonal.svg`](./architecture-hexagonal.svg),
[`architecture.svg`](./architecture.svg).

## Direction of dependencies

Dependencies always point **inwards** — from the outer edge (UI, IPC,
infrastructure) to the transport-agnostic core:

```
Renderer / preload / IPC handlers
        ↓
Main adapters & composition (src/main/adapters/, composition/)
        ↓
Application core (src/application/)
        ↓
Shared contracts & runtime (src/shared/contracts/, runtime/)
```

The application core (`src/application/`) imports only modules under
`src/application/` and `src/shared/`. It knows neither Electron nor provider
implementations nor the file system.

## Layers

| Layer | Path | Role |
| ------- | ---- | ----- |
| **Contracts** | `src/shared/contracts/` | Versioned DTOs, events, enums, validators for the IPC boundary and persistence |
| **Presentation (shared)** | `src/shared/presentation/` | Domain-adjacent display helpers for main adapters and tests (e.g. tool lines); not imported by the core |
| **Application** | `src/application/chat/`, `src/application/ports/` | Chat orchestration, tool loop, history trimming — only through injected ports |
| **Main adapters** | `src/main/adapters/` | Concrete port implementations (LLM, tools, storage, FS, speech, updates, …) |
| **Main ports** | `src/main/ports/` | Interface types for infrastructure (narrow surfaces, no leaks) |
| **Composition root** | `src/main/composition/` | Wiring: `createApplication()` builds services, adapters and engine, registers IPC |
| **IPC** | `src/main/ipc/` | Thin driving adapters: IPC ↔ use-case calls, event push to the renderer |
| **Renderer** | `src/renderer/` | Pure presentation: DOM, CSS, local formatting; only `window.electronAPI` + contracts |

Legacy re-exports under `src/main/chat-engine.js` and
`src/main/chat-history-trim.js` forward to `src/application/chat/`, so that
existing imports stay stable.

## Ports

**Application ports** (`src/application/ports/`) — consumed by the chat core:

- `llm-port` — streaming rounds against a provider
- `tool-port` — tool registry and execution
- `chat-preferences-port` — UI prefs, system prompt, tool round limit
- `workspace-path-port` — path helpers (e.g. `basename`)
- `skill-port` — bodies of the enabled skills for the system prompt
- `environment-port` — environment details for the environment block in the
  system prompt (issue #138): working directory, git yes/no, platform, system
  version, shell and today's date. They are determined in
  `main/adapters/environment-adapter.js` — the core itself sees neither
  `process.platform` nor the file system
- `memory-port` — the two `memory.md` files and the appending of individual
  entries (#166). Adapter: `main/adapters/memory-adapter.js`. **The paths are
  formed exclusively there**: the `remember` tool names only the level
  (`workspace` | `user`), never a path — which is why writing to `~/.snotra`
  does not soften the workspace boundary of the file tools. The adapter writes
  serially per file, so that two windows on the same folder do not overwrite
  each other.
- `project-instructions-port` — the `AGENTS.md` files that were found, for the
  block with the project instructions (issue #212). Where they live is known
  only to `main/adapters/project-instructions-adapter.js`; the core sees neither
  `os.homedir()` nor the file system. Deliberately **without a cache and
  without a watcher**: these are three files that are read afresh per request —
  unlike the skill catalogue, which scans entire directories and parses front
  matter, and therefore needs both
- `web-search-port` — searching the internet (issue #63); the provider sits in
  the adapter alone (`main/adapters/tavily-web-search-adapter.js`), and the tool
  handler does not know it
- `url-fetch-port` — reading a web page as text (issue #95); address rules,
  redirects and limits live in the adapter
  (`main/adapters/http-url-fetch-adapter.js`), the address check itself in
  `shared/runtime/url-safety.js`
- `code-execution-port` — running a Python program (issue #86); interpreter
  detection, time limit and process-tree kill live in
  `main/services/python-runner-service.js`. The PATH used for lookup and
  execution is not raised by the service itself: it comes in from outside as
  `readShellPath` (issue #111)
- `mcp-port` — listing and calling tools of external MCP servers (issue #106,
  part of #62). The core sees neither processes nor JSON-RPC: connection
  management (handshake, `tools/list`, `tools/call`, timeouts, cancellation,
  clean shutdown) lives in `main/services/mcp-service.js`, the line framing over
  stdin/stdout in `main/services/mcp-stdio-transport.js`. The separation is
  deliberate: consciously no `@modelcontextprotocol/sdk` as long as only stdio
  and only `tools` are in play — the transport is the place where an SDK could
  dock later without port or core changing. Validation of the server
  configuration in `shared/contracts/mcp.js`.

  These tools reach the model through `main/adapters/mcp-adapter.js`, which
  translates them into registry definitions (issue #107). Four rules apply:

  * **Namespace** `mcp__<serverId>__<toolName>` — a foreign `read_file` can
    never shadow the built-in one. The double underscore is reserved as a
    separator, so server identifiers must not contain it.
  * **Risk classes**: always `execute` **and** `external`. An MCP tool is
    foreign code with unknown effect — planning does not know its target paths,
    so `targets` stays empty. The server's annotations may only tighten
    (`destructiveHint` adds `delete`); `readOnlyHint` is deliberately ignored,
    because otherwise the foreign server would decide how strictly we treat it.
    A consequence of that class choice: MCP calls can be approved neither for a
    session nor permanently — every single one is asked about.
  * **Errors are results**: a dead or unstartable server returns an error
    message as a tool result, not a throw. The chat keeps running.
  * **`title` is stripped from the schema** (issue #185): Pydantic servers
    attach a label to every property that merely repeats the field name
    (`session_id` → `"title": "Session Id"`). It tells the model nothing and
    costs in every round — on the heimat server, 72 of 204 schema tokens, a good
    third. `stripSchemaTitles` in `shared/contracts/mcp.js` clears them away
    when the catalogue is taken over. The walk is **schema-aware**, and that is
    the whole point: inside `properties`, `$defs` & co. the key is a *name*, not
    a keyword — a parameter actually called `title` (four of them at Atlassian,
    among them `confluence_get_page`) is left untouched. A naive walk over all
    objects would delete it and break the tool. `description` always stays; that
    is where what the model needs to know lives.

  Because MCP tools are only known at runtime, the `tool-port` has the optional
  `prepare()`: the engine calls it once per run, before the system prompt and
  the tool list are built. After that the list is fixed for that run.

  The server list lives in `mcp-servers.json` in the userData directory (issue
  #108), its own file as with the search service. Environment variables are
  stored there per key either as `{ enc }` (encrypted via `safeStorage`) or as
  `{ value }` (plain text) — **encrypted is the default**, plain text the
  deliberate exception per key. Whoever does not touch the checkbox has their
  token protected; forgetting must not be the expensive case. If encryption is
  not possible (Linux without a keyring), the server is **not** stored rather
  than putting a token down in plain text; the plain values alone could still be
  saved.

  This is operated in the settings dialog under "MCP" (issue #109). The section
  lives as its own renderer component in `renderer/components/McpPanel.js`: the
  panel only carries the list with status and switch, while creating and editing
  happen in a sub-dialog following the pattern of "Modell hinzufügen". Like the
  permissions and unlike the rest of the dialog, changes there take effect
  **immediately** — the list belongs to main, that is where the secrets live,
  and a connection test needs the stored state anyway. The footer says so per
  section.

  A stored secret appears in the form only as a placeholder; whoever does not
  touch it sends `{ keep: true }` instead of a value the renderer does not even
  know.

  Two read paths, deliberately separate and nailed down in
  `test/infrastructure-boundaries.test.js`: `createMcpConfigStorePort` returns
  the display form without secrets and is what handlers and renderer reach;
  `createMcpSecretsPort` decrypts and exists only for the service that starts
  the processes. MCP secrets additionally feed into `readOwnSecrets` — an MCP
  server could otherwise return its own token via a tool result — and are masked
  out of error messages and stderr excerpts (`redactOwnSecrets`) before a status
  leaves the main process.
- `shell-execution-port` — running a command in the operating system's shell
  (issue #102); shell detection (POSIX as a login shell, so that the PATH from
  the user profile applies), time limit and process-tree kill live in
  `main/services/shell-runner-service.js`, the blocked effects as a pure check
  in `shared/runtime/shell-command-guard.js`

The shell service is at the same time the only place that starts a login shell
(issue #111). Its detection runs interactively on POSIX (`-ilc`), because zsh
reads `.zshrc` only for interactive shells and most PATH lines sit exactly
there; it reads the PATH along the way and remembers the result for the lifetime
of the app. Both execution services pass this PATH on to their child processes —
an Electron app started from Finder otherwise inherits only the sparse PATH of
the window server. Commands still run non-interactively, so that prompt output
does not end up in the result. On Windows the profile run is dropped: the PATH
there comes from the registry and the user environment. Composition wires this
in `main/composition/create-application.js` — the shell service is built before
the Python service, because the latter draws its PATH from it.

Both execution ports are deliberately cut equally narrow — one program or one
command in, output and exit code out, no state between two calls — and carry the
class `execute` in the registry: no workspace boundary, no sandbox, but an
approval before every run and switched off as shipped (see
`docs/sicherheitskonzept.md`, section 9).

Both network tools are marked in the registry as `requiresWorkspace: false`
(issue #96): the engine no longer builds the tool list wholesale only with an
open project folder, but filters per tool.

**Infrastructure ports** (`src/main/ports/`) — implemented by adapters,
injected via composition:

- Storage: `llm-config-store-port`, `ui-prefs-store-port`,
  `chat-history-store-port`, `workspace-folder-store-port`,
  `provider-secrets-port`, `web-search-store-port`
- Runtime: `provider-runtime-port`, `provider-catalog-port`,
  `provider-model-listing-port`, `credential-port`, `filesystem-port`,
  `speech-port`, `update-port`

### Self-update: three steps, three modules

The `update-port` is deliberately not a single "update yourself", but
`checkForUpdate` / `downloadUpdate` / `installUpdate` plus cancellation. The
reason is the requirement itself (issue #232): the user confirms downloading and
installing separately and can step out in between — a combined call could not
express that.

Behind it sit three modules in `services/`, separated by what can go wrong in
each:

- `update-targets.js` — **pure**, without file system and processes. Answers
  "what kind of installation is running here" (macOS bundle, Windows directory,
  AppImage, extracted Linux directory, system package, development build) and
  "which release asset fits it". This decision comes out differently on every
  platform and can be tried out safely on none, which is why it stands on its own
  as a pure function.
- `update-download.js` — stream to disk, with progress and real cancellation.
  Downloads only from `github.com` or `*.githubusercontent.com` over HTTPS and
  discards a file whose length does not match the announced one; a torso must not
  pass as a finished download on the next attempt.
- `update-installer.js` — the replacement. The same pattern everywhere: the new
  version is fully unpacked and verified **next to** the old one, and only then
  does a detached helper script take over that waits for this process to end,
  renames and restarts. It would not work inside the running process — on Windows
  the `.exe` is locked, on Linux the AppImage is mounted as a file system inside
  its own process. The scripts themselves are built as plain strings and are
  therefore testable without an installation.

The address of the package never leaves the main process: from `checkForUpdate`
the renderer learns only name and size, and triggers the download without
parameters.

The **skill service** (`services/skills-service.js`) scans the four skill
sources — the built-in system skills from `system-skills/` in the app bundle,
`.agents/skills/` in the workspace, and in the home directory `~/.snotra/skills/`
and `~/.agents/skills/`; directories belonging to other tools such as `.claude/`
stay unread — and is passed into the chat engine through
`adapters/skills-adapter.js` as a narrow `skill-port`.

`~/.snotra/` is Snotra's **own user directory**: the root for user-wide data that
belongs to Snotra and for which no vendor-neutral standard exists (issue #251).
`.agents/` stays reserved for what tools have agreed on. Since #251,
`~/.snotra/skills/` is the standard location for global skills and takes
precedence over the legacy location `~/.agents/skills/`; the workspace remains
the strongest folder source. Nothing is created and nothing is migrated — a
missing directory is no more an error than anything else. It is strictly
separated from the `userData` folder: that is Electron-managed app state and off
limits for tools. Parsing the front matter lives as a pure function in
`shared/runtime/skill-frontmatter.js`, the enums and DTOs in
`shared/contracts/skills.js`.

### One watcher, two consumers

That the app notices what happens **next to** it in the file system is the work
of a single service: `services/directory-watcher.js`. It encapsulates the
dearly-paid quirks of `fs.watch` — missing target directories, a disappearing
watch root (macOS goes silent, Windows fires endlessly), the Linux sham with
`recursive: true`, event avalanches (debouncing with a maximum window), `error`
events without listeners, and re-arming after a lost event (issues
[#126](https://github.com/kkrafft1999/snotra/issues/126),
[#155](https://github.com/kkrafft1999/snotra/issues/155)).

On top of it sit two thin shells that only say *what* is being watched:

- `services/skills-watcher.js` — `.agents/skills` in the workspace as well as
  `~/.snotra/skills` and `~/.agents/skills` in the home directory, each with an
  ancestor chain (the directories are usually missing). Reports without a
  payload; the skill catalogue is read completely afresh anyway.
- `services/workspace-watcher.js` — the project folder, recursively and without a
  chain upwards. It reports the affected **folders**, so that the file tree does
  not have to reload everything on every event (issue
  [#158](https://github.com/kkrafft1999/snotra/issues/158)). An ignore list keeps
  the contents of `node_modules/` and `.git/` as well as editor temporary files
  out; `.git/HEAD` and `.git/index` deliberately get through — they are the sign
  of a branch switch and report as `complete: false`, whereupon the renderer
  reloads once, more coarsely, instead of a hundred times individually.

The path to the tree: `fs:tree-changed`
(`shared/contracts/workspace-tree.js`) → `FileTree.js` reloads the reported
folders, but only the currently visible ones, and only if their content has
actually changed. Selection, keyboard focus and scroll position are saved before
the redraw and restored afterwards.

## Workspace images in the chat

An image produced by the model (`![Diagram](diagram.png)`) lives in the project
folder and thus outside the app origin. The renderer's CSP allows
`img-src 'self' data:` — so it is loaded **not** through a custom protocol, but
over IPC as a `data:` URI (issue
[#244](https://github.com/kkrafft1999/snotra/issues/244)). That saves both a CSP
relaxation and a `protocol.handle` registration; the price is base64 in memory
and no browser caching, against which stand a 10 MB size limit and a small cache
in the renderer.

The path: after sanitizing, `ChatStream.js` calls `applyWorkspaceImages`
(`renderer/chat/workspaceImages.js`) on the finished `<img>` nodes in the DOM —
never by string replacement in the HTML; DOMPurify runs first, unchanged. The
`src` there is a **URL, not a file path**: `marked` percent-encodes what must not
stand raw in a URL, so `C:\ws\plot.png` becomes `C:%5Cws%5Cplot.png` and
`images/grün.png` becomes `images/gr%C3%BCn.png`. Without the reversal in
`decodeWorkspaceImageSource`, the main process would find no file containing a
space, an umlaut or a Windows separator. From there `fs:readWorkspaceImage` goes
to `fs-service.readWorkspaceImage`, which resolves the path (relative or
absolute) against the active workspace, checks it lexically **and** via
`realpath`, determines the type from the file header (PNG, JPEG, GIF, WebP — no
SVG) and limits the size. Back comes `{ mime, base64 }` or a reason from
`shared/contracts/workspace-image.js`, out of which the renderer builds a
designed placeholder.

**One exception in the sanitizer**, the only one at this point: DOMPurify allows
only known URL schemes and throws everything else away. A Windows path
`D:\ws\plot.png` looks to that check like a scheme `d:` — the `src` disappears,
while `/Users/…` passes without complaint on macOS and Linux. An
`uponSanitizeAttribute` hook in `renderer/utils/helpers.js` therefore holds on to
exactly this one case: only `<img src>`, only a real drive path
(`isWindowsDrivePath`). It opens nothing — the value is never loaded but replaced
by a `data:` URI or a placeholder; and even if that did not happen,
`img-src 'self' data:` does not permit a `d:`, and the path is checked in the
main process anyway. Without it there would never be an image via an absolute
path on Windows.

Two quirks hang on streaming: while the answer is running, `scheduleStreamRender`
sets the complete `innerHTML` anew on every animation frame — which is why images
get only a calm placeholder until the end. And completion cancels the still
pending frame (`cancelStreamRender`), because it would otherwise write the
intermediate state back over the image that was just loaded.

## Workspace management in the main process

The **active workspace** is the trust boundary of the file system: all file tools
and the IPC file accesses resolve relative paths against it. It therefore lives
exclusively in the main process (`main/workspace-state.js`) and is set only by
`services/workspace-activation.js` (issue
[#68](https://github.com/kkrafft1999/snotra/issues/68)):

- `activateChosenFolder` — after a real selection in the native folder dialog.
  Only this path accepts a previously unknown path; it checks that it is an
  existing folder, writes `last-folder.json` and the history, and activates it.
  Only afterwards does the dialog handler (`ipc/dialog-handlers.js`) return the
  activated path to the renderer.
- `activateKnownFolder` — for the history menu, the welcome chips and the restore
  at startup (`SETTINGS_ACTIVATE_FOLDER`). The path that is passed in must be
  stored in the re-validated history or as the last opened folder, otherwise the
  previous root stays in place.

### Import from outside: the one deliberately asymmetric check

The drop from Finder/Explorer into the file tree (issue
[#101](https://github.com/kkrafft1999/snotra/issues/101)) is the first route on
which a path from **outside** the workspace has an effect. It therefore gets its
own channels instead of an extension of `fs:moveItem` — there
`adapters/filesystem-ipc-adapter.js` checks source *and* target via `boundPath()`,
and that is meant to stay:

- `fs:inspectImport` — counts folders, files and bytes, without writing.
- `fs:importItems` — confirms natively and copies.

In the adapter only the **target** goes through `boundPath()` (realpath-checked).
The **source** is deliberately not checked against the workspace — that is
exactly what the channel is for — but it must be absolute and must not match
`shared/runtime/sensitive-paths.js`; a hit rejects the drop. The rest lives in
`services/fs-service.js`: `inspectImportSources` counts recursively (symlinks and
sensitive names are counted and skipped, not followed), `importExternalItems`
copies with `fs.cp` — copies, not moves, because `fs.rename` only works within one
file system, and deleting the source outside would not be recoverable. Both
routes share the collision scheme `name (2).ext` via `findFreeTargetPath`. The
limits (`MAX_IMPORT_ENTRIES`, `MAX_IMPORT_TOTAL_BYTES`) live in
`shared/limits.js`; exceeding one rejects the whole drop instead of copying half
of it. Confirmation happens natively in `ipc/fs-handlers.js` via
`dialog.showMessageBox` — the renderer only triggers it, see
`docs/sicherheitskonzept.md` §5.

### Context menu of the file tree

`services/file-context-menu.js` builds the native menu (open, reveal,
information, delete). The renderer only triggers it via `fs:showFileContextMenu`;
the path is checked beforehand by `resolveWorkspacePath()` in the handler, so
only an already-checked absolute path arrives in the menu. `isDirectory` from the
renderer merely tailors the menu and is therefore uncritical.

The information behind it lives in `services/file-info.js` (issue
[#123](https://github.com/kkrafft1999/snotra/issues/123)) and returns a field
list that the menu shows as a `dialog.showMessageBox` — the same make as the
delete confirmation, no separate renderer code. Three decisions in it are
deliberate:

- **Folders are not counted recursively.** What is shown is the number of
  *direct* entries; summing up everything below can become arbitrarily expensive
  on `node_modules`, and a dialog must not wait for that.
- **Formatting without `Intl`.** Thousands separators and `21.09.2026, 14:32` are
  produced by hand, so that the output does not depend on the ICU equipment of
  the respective Node version. Values that do not exist or that sit on the epoch
  — `birthtime` is often 0 on Linux/ext4 — become "unbekannt" (unknown) instead of
  "01.01.1970".
- **"Open with" is best effort.** Electron does not know the default application;
  it costs a child process with a hard timeout on each platform, every failure
  ends as "unknown", and the rest of the display never depends on it. On macOS a
  JXA one-liner asks `NSWorkspace.URLForApplicationToOpenURL:`, **not** the
  Finder: an Apple event to the Finder would require the automation permission and
  runs into the timeout waiting for an answer. On Windows `AssocQueryString`
  resolves via the extension (normalising CRLF), on Linux `xdg-mime` plus `Name=`
  from the `.desktop` entry.

This means the renderer cannot move the boundary: it no longer names the
workspace in any call. `CHAT_SEND`, the skill catalogue and the chat history get
the root injected via `getActiveWorkspaceRoot()` in the respective handler; a path
sent along in the payload is discarded. At startup `main/index.js` does not set
anything in advance either — the root comes into being only with the activation by
the renderer, so that interface and trust boundary mean the same folder.

The chat history has a single, narrowly drawn exception (issue #131): a
conversation belongs to the folder it was held in, but the renderer saves it on a
folder change only once the new root is already active in main. A session is
therefore allowed to name its own root in `CHAT_HISTORY_UPSERT` — it is accepted
only if `workspaceActivation.isKnownFolder()` confirms it as an already opened
folder, otherwise the active root applies again. The path thus ends up solely as
a key in the history bucket and opens no file access; the trust boundary remains
`getActiveWorkspaceRoot()`. Which bucket `CHAT_HISTORY_SET_ACTIVE` hits is
decided, for the same reason, by the session itself and not by the currently
active folder.

### Image attachments in the history (issue #94)

Images live **next to** the history file, not inside it:
`services/chat-attachment-store.js` writes them to
`chat-attachments/<chat-id>/<SHA-256>.<ext>` in the userData folder, and the
session carries only `{ kind, mediaType, file }`. Four screenshots in one message
thus cost the session JSON a few dozen characters instead of megabytes of base64.
The file name is the content hash — the same screenshot lands under the same name
every time it is saved, so writing is repeatable.

Normalisation (`chat-history-normalization.js`) accepts **only** references via
`normalizeStoredAttachments()`. Base64 therefore cannot get into the history file
even if the store is missing or a write attempt fails. File names from the history
file are checked against `ATTACHMENT_FILE_RE` before every path assembly, and chat
IDs that are unusable as a folder name run via their hash — nothing leads out of
the attachment folder.

On loading, the renderer receives only the reference and fetches the image data
only when displaying, via `CHAT_ATTACHMENT_READ`; a folder with many sessions thus
does not send its entire image stock over IPC. A missing file is `{ ok: false }`
and is shown as a placeholder, not as an error. Cleanup happens under the history
lock: `CHAT_HISTORY_DELETE` removes the chat's folder, and every
`CHAT_HISTORY_UPSERT` additionally removes everything for which there is no longer
a session (dropped out of `MAX_CHAT_SESSIONS`, remnants of a quarantined history
file).

### Model and permission mode belong to the chat (issue #211)

Both used to be app-wide only: `activePresetId` in the LLM configuration, the
permission mode in the signed `tool-policy.json`. An entry from the history
therefore came back with its messages, but ran on with the currently configured
model and mode.

`services/chat-session-settings.js` is the counterpart to that. It remembers
`modelPresetId` and `toolPermissionMode` per chat, writes both into the chat's row
in the history and applies them again on a switch. The values come exclusively
from main: `CHAT_HISTORY_ACTIVATE` names only the chat identifier and whether the
switch was explicit, and `CHAT_HISTORY_UPSERT` discards what the renderer sends
along for these two fields (concept §5).

Two deliberately different rules for a new chat:

- **Model**: the entry last explicitly chosen continues to apply. It sits as
  `defaultPresetId` in the LLM configuration and is only advanced by a real
  choice (pill, settings) — restoring an old chat sets only `activePresetId`. If
  the field is missing in an older configuration, `readLLMConfig` fills it in once
  from `activePresetId`; without this step the default would wander along on the
  first chat switch.
- **Permission mode**: `smart` again every time. `auto` comes back only on an
  explicit switch in the history; on an automatic restore (app start, folder
  change) it falls back to `smart` — details in
  [`sicherheitskonzept.md`](./sicherheitskonzept.md) §8.

An entry that no longer exists, or whose access is incomplete, falls back to the
default (`isPresetUsable`) instead of opening the chat with a dead model.

## Composition root

`src/main/composition/create-application.js` is the central entry point after the
Electron bootstrap:

1. Creates infrastructure services (`storage-service`, `fs-service`, …)
2. Wraps them in narrow port adapters (`persistence-store-adapters`, …)
3. Builds the chat application via `create-chat-application.js` (LLM, tool and
   preferences adapters → `createChatEngine`)
4. Registers IPC handlers with injected dependencies

Before `createApplication()`, `src/main/index.js` calls only the one-time
userData migration (`services/userdata-migration.js`, taking over from the folder
of the predecessor identity "Weyouze Anything") — no scattered wiring in the
handlers.

The **menu bar** lives as a pure template in `services/application-menu.js`:
`createApplicationMenuTemplate()` receives platform, app name, `getMainWindow`,
`shell` and the update check, and returns the menu structure.
`Menu.buildFromTemplate()` stays in `index.js` — that way it is possible to check
what is in which menu without starting Electron (`test/application-menu.test.js`).

## Provider adapters

`src/main/providers/` holds one module per provider that fulfils the contract
from `providers/index.js` (`listModels`, `streamChatRound`, plus `fields`,
`presentation`, `capabilities`). Six are registered: `openai`, `anthropic`,
`google`, `ollama`, `mlx-lm` and `openai-compatible`.

The two OpenAI protocols exist **once** and are shared, instead of being copied
per provider:

| Module | Protocol | Used by |
| ----- | --------- | ----------- |
| `openai-chat-transport.js` | Chat Completions (`POST {base}/chat/completions`), SSE | `mlx-lm`, `openai-compatible` |
| `openai-responses-transport.js` | Responses (`POST {base}/responses`), SSE | `openai`, `openai-compatible` |

The transports know neither provider IDs nor stored configuration: they receive
finished headers, a base URL and the messages. Everything provider-specific —
which headers, whether images, whether tools, which style — is decided by the
provider module. `ollama` stays out of it: it speaks the native API (`/api/tags`,
`/api/chat` with NDJSON) and not the OpenAI layer under `/v1`.

### What a provider says about its fields

`fields` steers form, persistence and validation together — the renderer shows
exactly the fields a provider declares (`buildProviderFormView` in
`shared/contracts/settings.js`), the storage service reads exactly those
(`getEffectiveProviderConfig`), and the settings handler writes exactly those
(`mergeProviderPatchIntoConfigImpl`). Besides `apiKey`, `baseUrl` and
`insecureTls`, there have been `displayName`, `apiStyle`, `extraHeaders`,
`supportsImages` and `sendTools` since issue #193.

A provider additionally declares three special cases on the module:

- `optionalApiKey: true` — an empty key is a **valid** state. Otherwise a
  provider with `fields.apiKey` and no key counts as incompletely configured and
  refuses both model listing and sending.
- `capabilitiesFor(config)` — capabilities that depend on the stored
  configuration rather than on the adapter. `capabilities` remains the default
  for providers without this function.
- `connectionPerPreset: true` — the connection belongs to the **entry**, not to
  the provider (issue #202). See below.

Secrets do not leave the main process: the API key and the extra headers are
stored `safeStorage`-encrypted (`apiKeyEnc`, `extraHeadersEnc`), and the view
reports only `hasKey` or `hasExtraHeaders` to the renderer — never the content.

### Connection per entry

With `connectionPerPreset`, the connection sits not under `providers[id]` but as
`connection` on the preset:

```jsonc
{
  "version": 4,
  "providers": { /* the other five providers */ },
  "presets": [
    { "id": "…", "providerId": "openai-compatible", "model": "qwen2.5",
      "connection": { "baseUrl": "…", "apiKeyEnc": "…", "displayName": "LM Studio", … } }
  ]
}
```

The reason is a use case that was previously impossible: a local server **and** a
corporate gateway side by side. The price is that a key appears in the file as
often as there are entries pointing at the same server; which is why the rule
applies only to the generic provider and not to the five fixed ones.

Four things follow from it that are easily overlooked:

- **The chat target carries `presetId`.** Without the identifier the connection
  can no longer be resolved; `getEffectiveProviderConfig(providerId,
  { presetId })` needs it. Deliberately only the identifier — the target travels
  as a DTO all the way into the renderer.
- **`configured` is a property of the entry**, not of the provider:
  `buildPresetView` decides it, not `buildProviderView`.
- **The redaction of own keys** (`readOwnSecrets` in `create-application.js`)
  runs over `providers` *and* over the entries — otherwise exactly the gateway
  token would slip through.
- **The provider entry must not come back.** The renderer and
  `mergeProviderPatchIntoConfigImpl` leave out `providers[id]` for such
  providers; otherwise there would be a second, competing truth next to the
  connection on the entry.

The schema version sits as `LLM_CONFIG_VERSION` in
`shared/contracts/settings.js` — the main process and the settings handler read
the same number. The migration v3 → v4 copies `providers['openai-compatible']`
into every entry of that provider and removes the provider entry; it is
idempotent and leaves an already existing connection in place.

### Local or remote: by host, not by ID

Three places treat local providers differently from cloud providers: the timeout
of the model listing (`services/request-timeout.js`), the character budget of the
history (`application/chat/chat-history-trim.js`) and the characters→tokens
divisor of the context breakdown (`shared/contracts/context-breakdown.js`).

Up to issue #193 this hung on a fixed list of provider IDs. The generic provider
fits into no such list — the same ID serves LM Studio on `localhost` and a
gateway on the network. The question is therefore answered by
`shared/contracts/provider-endpoint.js` at the **host of the base URL**; the
existing ID entries for `ollama` and `mlx-lm` stay untouched, and the host rule
applies in addition.

## Renderer: what was moved, what stays

**Removed from the renderer** (now main or `shared/`):

- Provider/preset form semantics → `settings-presentation-service` +
  `shared/contracts/settings.js`
- Tool display lines → `shared/presentation/tool-display.js` (via the tool port adapter)
- History normalisation (title, sanitizing, usage) →
  `chat-history-normalization.js`

**Legitimate in the renderer** (presentation, no domain knowledge):

- Markdown rendering and HTML sanitizing (`marked`, `DOMPurify`)
- DOM construction for chat, tool lines, modals
- Local time/date formatting (`messageUtils.formatHistoryTime`)
- Display of pre-built DTO fields (`entry.line`, `providers[].presetFields`)

The renderer **may** *display* provider IDs and preset fields from IPC DTOs, as
long as it parses no provider wire formats and duplicates no tool or provider
logic.

### Splitting inside the renderer ([#81](https://github.com/kkrafft1999/snotra/issues/81))

The components under `renderer/components/` are the wiring: they attach handlers
to elements and draw. Everything that can be *decided* without touching a node
sits next to them — and is thereby testable on its own, instead of only being
reachable through the whole component:

| Module | What lives there | Test |
| ----- | -------------- | ---- |
| `renderer/tree/treePaths.js` | Path and tree logic of the file tree: sorting folders top to bottom, indentation → tree depth, external drop and its target folder, comparing folder contents, what has to be re-expanded after a redraw | `test/tree-paths.test.js` |
| `renderer/chat/toolLogView.js` | The tool log in the chat as a DOM layer: lines with state and permission audit, the expandable `<details>` block, the one-liner in the `<summary>`, finishing off an aborted run | `test/tool-log-view-dom.test.js` |
| `renderer/chat/toolLogDebug.js` | The diagnostic buffer of the tool log ([#87](https://github.com/kkrafft1999/snotra/issues/87)) as one instance per renderer — the view and `ChatStream` share it instead of passing it through every signature | `test/tool-log-debug.test.js` |
| `renderer/utils/tool-log-summary.js` | What the one-liner *says* — DOM-free, older than the split | `test/tool-log-summary.test.js` |

`FileTree.js` and `ChatStream.js` stay large, because wiring simply takes space —
but the path and tool-log logic is no longer inside them. The remaining chunks
(`styles.css`, `fs-service.js`, `SettingsModal.js`) are split up together with
the issues that touch them anyway; a reshuffle without cause only creates
conflict surface.

**Module boundary:** `src/renderer/package.json` declares `{ "type": "module" }`.
The main process is CommonJS, the renderer loads native ES modules without a
bundler; without this one file Node would have to parse every renderer file twice
during the test run and would warn on every run
(`MODULE_TYPELESS_PACKAGE_JSON`). The root package deliberately stays without a
`type`. The file has no effect on packaging: the allowlist in
`config.forge.packagerConfig.ignore` lets everything under `src/` through, and
`scripts/check-asar-contents.js` verifies that after every build.

### Two halves: workspace and chat ([#223](https://github.com/kkrafft1999/snotra/issues/223))

The directory tree and the content pane belong together — you click a file on the
left and see it next to it. The chat is the other half. Up to 1.7.0 the markup
expressed exactly the opposite: `#workspace` bracketed the content pane and the
chat, while the tree stood alone beside it. Since phase A:

```
#app
├── #workspace        workspace: #sidebar · #divider · #content
├── #chat-divider
└── #chat-panel       chat (in phase B: chat + history)
```

Two rules hang on that:

- **All hide states sit on `#app`** — `app--no-sidebar`, `app--no-preview`,
  `app--no-chat` and `app--no-history`. Previously each half carried its own
  mechanism on a different container; the same gesture was described twice.
  Without the content pane, `#workspace` falls back to `flex: 0 0 auto`;
  otherwise it would share the width with the chat instead of shrinking to the
  sidebar.
- **When the window gets wider, both halves share the growth equally.** That
  lives in `SidebarResizer.js` (a `ResizeObserver` on `#app`) and not in the CSS:
  flexbox cannot express "distribute additional width evenly", because it lacks
  the reference point — `flex-grow` distributes the remainder against the basis,
  not against the previous state. Only the new chat width is written; the
  workspace fills the rest by itself as `flex: 1`. The calculation works the same
  way in reverse, which is why maximising and restoring land back where you were.

Since phase B the right half is a pair as well: `#chat-area` brackets chat and
history, making the structure symmetric.

```
#app
├── #workspace        #sidebar · #divider · #content
├── #chat-divider
└── #chat-area        #chat-panel · #history-divider · #chat-history
```

Up to 1.7.0 the history was a drop-down over the messages: it pushed the chat
down, closed again on a click beside it and on Escape, and disappeared after
every selection. As a column it stays put — which is why `ChatHistoryPanel.js` no
longer closes anything by itself, `FileTree.js` has lost its Escape hook for it,
and `ToolApprovalCard.js` no longer counts it among the overlays that claim
Escape for themselves.

Since then the symmetry is also operable: **each of the four columns has exactly
one switch, and all four sit in the title bar** — on the left those of the
workspace, on the right, mirrored, those of the chat side, each in the order of
their columns and with the same, mirrored image. The same pattern therefore
applies to chat and history as to tree and content pane:

- The chat can be hidden (`app--no-chat`, `chatPanelVisible` in the UI prefs);
  what remains is the history. `SidebarResizer.js` computes its width as 0 in
  this state and leaves the remembered width alone, so that it comes back as wide
  as it went away.
- **A click in the history brings the chat column back** (`revealChatPanel`) —
  the mirror image of `revealContentPane` on clicking a file in the tree. Without
  it, the click would run into a hidden area.
- The button for a new chat sits in the header of the history, just as "Ordner
  öffnen" (Open folder) sits in the header of the tree: the action that gives a
  column entries belongs in that column.
- The settings dialog no longer has a button. The gear sat in the chat header and
  was gone with its column; since then only the menu bar leads into it
  (`CmdOrCtrl+,`) — a push on `UI_OPEN_SETTINGS`, exactly like `UI_TOGGLE_SIDEBAR`
  for the `Cmd/Ctrl+B` shortcut. Where the entry sits is decided by the platform
  (issue #266): on macOS in the app menu under *Snotra AI → Einstellungen…*,
  right below "Über" (About), as Mac users expect; on Windows and Linux, where
  there is no app menu, under *Ansicht → Einstellungen…*. Never in both places,
  because `CmdOrCtrl+,` would otherwise be assigned twice.
  The shortcut hangs on the menu entry and not on a key check in the renderer, so
  that it also applies inside an input field. A second invocation while the dialog
  is open is a no-op: `openSettingsModal()` remembers the focus from **before**
  opening, and would otherwise overwrite it with an element from the dialog
  itself.
- The three column headers (`#tree-header`, `#chat-header`,
  `#chat-history-header`) form one line. Their height used to come from the icon
  buttons inside them; since the gear disappeared, the chat header has none and
  therefore carries the same calculation as a `min-height`.

Three rules hold the four columns together, all in `SidebarResizer.js`:

- **The workspace keeps its minimum** (`workspaceMin()`): the configured width of
  the sidebar plus `CONTENT_MIN`, and only for what is currently visible. The
  sidebar goes in with its configured width, not with its minimum — whoever
  dragged it wide wants to see it wide; then the history gives way instead.
- **When it gets too tight, the chat gives way first, then the history, and then
  the history collapses** (`ensureRoomForWorkspace()`). This happens with
  `persist: false`: the user's remembered wish stays in place, so that the column
  returns in a wider window — at the width it had before being squeezed. Whoever
  collapses it themselves will not find it back on its own.
- **The upper bound of the chat** is computed against `#app` and subtracts the
  history width. It now lives only in JS, no longer as a `max-width` in the CSS:
  "what has to be left for tree and content pane after chat and history" is not a
  percentage.

The list hangs on `onChatPersisted` from `ChatStream.js` — a column that stands
beside you permanently must not show the title from earlier.

### Startup state of the middle column ([#208](https://github.com/kkrafft1999/snotra/issues/208), [#255](https://github.com/kkrafft1999/snotra/issues/255), [#258](https://github.com/kkrafft1999/snotra/issues/258))

Without a stored wish, the folder decides: with a folder the column stays closed
([#255](https://github.com/kkrafft1999/snotra/issues/255)) — there would be
nothing to see there but the welcome screen. Without a folder, that screen is
exactly the right thing
([#258](https://github.com/kkrafft1999/snotra/issues/258)), because otherwise the
app would stand there empty on first start.

For that, `contentPaneVisible` is **three-valued**: `normalizeUiPrefs` leaves the
key out as long as nothing is stored, instead of normalising it to `false`.
"Never set" is something different from "explicitly hidden" — only that way can
the startup show the welcome screen without overriding the decision of someone
who clicked the column away. The value is written by the toggle in the title bar
alone.

And whoever leaves the app inside a conversation should land there again — not
next to the welcome screen, which is meant for the cold start. The decision about
that is spread over three places, and the order is the point:

1. **`index.html` starts with `app--no-preview`.** The first paint happens before
   `app.js` knows anything; if the open column stood there, the welcome screen
   would flash up and jump away again. `test/startup-layout.test.js` keeps markup
   and toggle state (`aria-pressed`) together.
2. **`loadChatForWorkspace()` reports its result** (`{ restored, wasActive }`)
   instead of only applying it — the startup needs the information, the folder
   change ignores it.
3. **`contentPaneVisibleOnStart()`** (`renderer/utils/startupLayout.js`) combines
   both with the stored setting and the opened folder: a restored chat beats
   everything, then the explicit preference counts, and without it the folder.
   `app.js` applies the result in the `finally` of the startup sequence, so that
   an error during loading does not leave the column stuck closed.

If the column shows the welcome screen, it gets only that screen's width:
`#welcome` is limited to 560 px of content and has 32 px of padding per side,
making 624 px. The rest of the window is given to the chat by `fitChatToWelcome()`
(`SidebarResizer.js`) — bounded by the same cap at half the window width as when
dragging the divider. A remembered chat width stays untouched, and nothing is
written here: what the startup sets up is not a new wish.
`test/startup-layout.test.js` keeps the 624 px together with the CSS.

The preview lives in this column, which is why clicking a file brings it back via
`revealContentPane` — otherwise the click would have no consequence.

### Window state ([#209](https://github.com/kkrafft1999/snotra/issues/209))

Size, position, maximised and full screen live in `window-state.json` in the
`userData` folder — deliberately beside the store from `storage-service`: the
state belongs to the window alone, nobody else reads it, and it has to be in
place before any service exists. It is written synchronously (the last change is
due at closing time, after which the process waits for nothing) and debounced
during operation, because dragging the window edge would otherwise hit the disk
dozens of times per second. What is saved is always `getNormalBounds()`, i.e. the
measurement *underneath* maximisation and full screen.

The decision at startup lives as the pure function `resolveWindowBounds()` in
`src/main/window-state.js`, because between two starts displays appear, disappear
and change their resolution: limit the size to the work area, snap the position
into it, and if less than 100 px of the stored rectangle would be visible, drop
the position — Electron then centres it. Without a stored state, the startup size
from #208 applies (1536 × 960).

## Automated boundary guards

| Test | What it checks |
| ---- | ------------ |
| `test/application-layer-imports.test.js` | `src/application/` imports only `application/` + `shared/` |
| `test/infrastructure-boundaries.test.js` | Storage/credentials without provider registry leaks |
| `test/adapter-port-shapes.test.js` | Port adapters expose only permitted methods |
| `test/contracts*.test.js` | Wire enums and settings DTOs at the IPC boundary |
| `test/*-presentation.test.js`, `test/chat-history-normalization.test.js` | Normalised display data for settings and history |

## Renderer tests against the DOM

Since [#78](https://github.com/kkrafft1999/snotra/issues/78), renderer components
are tested against a real DOM — `happy-dom` as the only test dependency,
`node --test` remains the runner, and CI needs nothing further.
`test/helpers/dom.js` builds a window from the **real** `src/renderer/index.html`
(without its script tags) and puts the browser globals on `globalThis`; the
components are loaded as native ESM via `await import(...)` and initialised with
a stubbed `api`/`appStore`.

| Test | What it checks |
| ---- | ------------ |
| `test/file-tree-dom.test.js` | Drawing the tree, expanding/collapsing, preview, drop from outside ([#101](https://github.com/kkrafft1999/snotra/issues/101)): target folder per hit area, reading the `DataTransfer` before the first `await`, busy lock, tree refresh |
| `test/settings-modal-dom.test.js` | Tab switching: panel, `aria-selected`, roving tabindex, heading, Escape |
| `test/chat-links-dom.test.js` | Click handler for links from model answers ([#82](https://github.com/kkrafft1999/snotra/issues/82), [#83](https://github.com/kkrafft1999/snotra/issues/83)) including the error message in the status line |
| `test/chat-restore-report-dom.test.js` | What `loadChatForWorkspace()` reports to the startup ([#208](https://github.com/kkrafft1999/snotra/issues/208)): restored conversation, empty folder, plain greeting |

Outside the DOM stack, but on the same stretch: `test/window-state.test.js`
checks the window decision at startup (default size, remembered state, unplugged
display) as well as writing and reading the state file.

Limits, so that the green line does not promise more than it delivers: no real
Chromium, and therefore **no layout** (`offsetParent`, `getBoundingClientRect`)
and **no sanitizing** — DOMPurify demonstrably works incorrectly under happy-dom
(details in the header of `test/helpers/dom.js`). `DataTransfer`/`DragEvent` are
reproduced by the helper itself. A real Finder/Explorer drop stays manual.

## Smoke test in the real app

What a DOM stand-in cannot deliver is checked by a run through the live Electron
app: `npm run test:e2e` (not part of `npm test`). Deliberately **one** test — the
Electron level is the most expensive per bug found, and a run that touches
everything once at startup catches the bulk of it. It takes about three seconds.

- **Driver:** `playwright-core` (`_electron.launch`) as a devDependency. No
  browser download, no second test runner: `node --test` stays.
- **Isolation:** its own `--user-data-dir` and a working folder created via
  `mkdtemp`. The settings of the installed app remain untouched.
- **Model:** `e2e/helpers/fake-model.mjs`, a small OpenAI-compatible SSE server.
  The `mlx-lm` provider points there via `baseUrl` — no API key, no network, and
  the stream can be slowed down in order to abort it.
- **Route:** start with a pre-set folder → tree → open a file and preview → abort
  a chat round (the abort has to reach the server) → second round with links and
  dangerous markup → **sanitizing in real Chromium** → a click on the link lands
  in the main process → open settings, switch tab, close with Escape.
- `shell.openExternal` is replaced in the main process so that the test does not
  open a real browser.

Pitfalls of the driver are documented in the header of `e2e/helpers/app.mjs` —
above all: Playwright's own waiting hangs here (timer throttling in the
renderer), which is why the driver polls itself.

Since [#237](https://github.com/kkrafft1999/snotra/issues/237) the smoke test
also runs in `ci.yml`, in the same job as `npm test`, on all three platforms. On
Linux the runner has no display — the step runs there via
`xvfb-run --auto-servernum`, while macOS and Windows need no addition. CI
therefore checks both test levels, not just the DOM stand-in, and the required
gate in the ruleset on `main` actually covers what the project rule
[`git-workflow.md`](../.claude/rules/git-workflow.md) demands before a push.

## Coverage: an honest denominator, separate thresholds

`npm run coverage` runs the suite with `--experimental-test-coverage` and checks
two areas against their own thresholds. Exit code 1 if one of them falls below.

As of 2026-09-14 (Node 24):

| Area | Files in the report | Lines | Branches | Functions |
| --- | --- | --- | --- | --- |
| Core (`main`, `application`, `shared`, `preload`) | 119/122 | 95.7 % | 86.0 % | 89.6 % |
| Renderer | 30/31 | 42.1 % | 74.3 % | 58.4 % |

Thresholds (in `scripts/coverage.js`): core 94 / 85 / 88, renderer 41 / 72 / 56.
They are a **ratchet** — just below the measured state, so that a regression
stands out without every change having to move the number. Whoever lowers one
says why in the commit.

Two things about it are deliberate:

**The denominator contains all source files.** Node measures only what the run
loads — a file no test touches is missing from the report and does not drag the
number down. That is exactly where the earlier figure of ~94 % lines came from:
it described a selection. `test/source-files-load.test.js` therefore loads
**every** file under `src/` (and incidentally finds broken import paths in files
nobody else imports). What cannot be loaded outside Electron is listed with a
reason in `scripts/source-files.js` — four entry points — and `npm run coverage`
lists them in the report instead of concealing them. If a file is missing without
a reason, the run fails.

**The thresholds are separate.** The renderer is roughly a third of the code and
harder to reach from a test run than the core; a shared threshold would have to
orient itself on the weaker part and would let the core go to seed. The 42 % of
lines in the renderer are not a target but the honest state — what is missing
there is partly caught by the smoke test at a different level.

Coverage is **not** a CI gate: there, `npm test` runs. The thresholds are a local
ratchet, not a merge condition.

## System prompt

The system prompt is assembled per request from five building blocks
(`application/chat/chat-engine.js`), in this order:

1. **Base prompt** from the settings — it stands first and keeps precedence.
2. **Memory block** (`application/chat/memory-prompt.js`,
   [#166](https://github.com/kkrafft1999/snotra/issues/166)) — the two
   `memory.md` files from `<workspace>/.agents` and `~/.snotra`. It stands
   directly behind the base prompt, because it is the same thing: what the user
   said themselves, only across several conversations — nothing foreign should
   push itself in between. At most 8,000 characters per level
   (`MAX_MEMORY_CHARS`), oversized content is visibly truncated, and each level
   gets its own line in the context breakdown (#174). Can be switched off per
   level under Settings › Gedächtnis (Memory; on by default). It is written only
   via the `remember` tool; the instructions for that live in the system skill
   `snotra-memory` and are loaded only on demand — content always, rules on
   request.
3. **Skill block** (`buildSkillsSystemPrompt`) — the enabled skills; they
   describe the *how*. The prompt carries only name and short description per
   skill, and the model fetches the instructions on demand with `load_skill`
   ([#173](https://github.com/kkrafft1999/snotra/issues/173)). Only two cases go
   into the prompt in full immediately: skills invoked via `/name`, and the
   fallback when there is no `load_skill`.
4. **Environment block** (`application/chat/environment-prompt.js`, issue #138)
   — working directory (absolute path), git yes/no, platform, system version, the
   shell of `shell_execute` and today's date. The shell only appears there if the
   tool is switched on *and* a shell was found; without an open folder the path
   and git lines fall away. Deliberately without a time of day, so that the block
   stays stable for a day and the providers' prompt caching does not break on
   every message. Can be switched off via "Umgebungsinformationen mitschicken"
   (Send environment information) in the settings (on by default) — the absolute
   path contains the user name and goes to the provider.
5. **Project instructions** (`application/chat/project-instructions-prompt.js`,
   issue #212, sharpened in #253) — the `AGENTS.md` files from
   `<workspace>/.agents`, `~/.snotra` and `~/.agents`, all existing ones
   concatenated. They **complement one another and apply jointly**; none beats
   another, so the order is a reading order and not a precedence. It is the same
   source list as for skills (#251) — two orderings that would have to be learned
   separately would cost more than the one alignment. Within the project only
   `.agents/` counts: an `AGENTS.md` in the folder root is not read, even though
   that is the more common form outside this project. At most 20,000 characters
   per file (`MAX_PROJECT_INSTRUCTION_CHARS`, the same limit as for skill
   bodies), oversized content is visibly truncated rather than discarded, and each
   file gets its own line in the context breakdown (#174). Can be switched off via
   "`AGENTS.md` mitschicken" (Send `AGENTS.md`) in the settings (on by default).
6. **Folder/tool block** (`buildWorkspaceSystemPrompt`, otherwise
   `buildNoWorkspaceSystemPrompt`) — the open folder, tool descriptions, the tree
   selection and the rule that tool results are data.

The order of the last two is deliberate: the content of an `AGENTS.md` is
**instruction, not data** — unlike tool results, for which
`TOOL_RESULTS_ARE_DATA_RULE` applies. It is meant to change the model's
behaviour, otherwise it would be pointless; that is defensible because the user
opened the folder themselves. Precisely for that reason it stands **before** the
folder/tool block and not after it: the rule that tool results are data should not
be the last thing a foreign instruction file could overwrite. The emergency brake
is the switch, not the placement.

### Baseline equipment of the tools

Principle since [#180](https://github.com/kkrafft1999/snotra/issues/180): what is
in Settings › Tools goes to the model — and vice versa. Otherwise a schema costs
tokens in every round that nobody can deselect, because it does not appear in the
list.

`essential: true` is the one explicit exception
([#195](https://github.com/kkrafft1999/snotra/issues/195)): hidden only in the
settings, always sent to the model. The user's checkboxes do not reach it, while
`requiresWorkspace` and `requiresSkills` still do. The opposite direction —
`internal: true`, hidden from user *and* model and only triggerable from tests —
was dropped with [#203](https://github.com/kkrafft1999/snotra/issues/203), after
its only bearer `debug_wait` was gone
([#197](https://github.com/kkrafft1999/snotra/issues/197)).

The baseline equipment consists of `list_directory` and `load_skill`. Neither is
an add-on; they are the access to something the user has already switched on
elsewhere — a folder and a skill respectively. Deselected, they would save a small
schema and cost a multiple of that elsewhere: without `load_skill` the skill block
falls back to the full body of every instruction, and without `list_directory` the
model guesses paths. A row with a checkbox would therefore not be a saving switch
there but a trap — which is why it is not in the list.

The block deliberately does *not* mention a **scratch directory**: the write tools
know only the working folder as their root, and a path beside it would be a hint
at something that does not work.

## Further functional modules

The skill system ([#18](https://github.com/kkrafft1999/snotra/issues/18)) is
built on this structure: discovery and parsing in the main service, selection and
system-prompt assembly in the core, catalogue and toggles over the existing
settings channels. Extended tool sets and use-case profiles are **not** part of
the completed architecture stages — they build on it as well and are tracked as
[GitHub issues](https://github.com/kkrafft1999/snotra/issues).
