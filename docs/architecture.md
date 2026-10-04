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
| **Contracts** | `src/shared/contracts/` | DTOs, events, enums, validators for the IPC boundary and persistence |
| **Presentation (shared)** | `src/shared/presentation/` | Domain-adjacent display helpers for main adapters and tests (e.g. tool lines); not imported by the core |
| **Application** | `src/application/chat/`, `src/application/ports/` | Chat orchestration, tool loop, history trimming — only through injected ports |
| **Main adapters** | `src/main/adapters/` | Concrete port implementations (LLM, tools, storage, FS, speech, updates, …) |
| **Main ports** | `src/main/ports/` | Interface types for infrastructure (narrow surfaces, no leaks) |
| **Composition root** | `src/main/composition/` | Wiring: `createApplication()` builds services, adapters and engine, registers IPC |
| **IPC** | `src/main/ipc/` | Thin driving adapters: IPC ↔ use-case calls, event push to the renderer |
| **Renderer** | `src/renderer/` | Pure presentation: DOM, CSS, local formatting; only `window.electronAPI` + contracts |

Main imports the chat core from `src/application/chat/` directly; the former
re-exports under `src/main/` are gone (#531).

## Ports

**Application ports** (`src/application/ports/`) — the contracts between the
application layer and main. Most are consumed by the chat core; `web-search`,
`url-fetch`, `code-execution`, `shell-execution` and `mcp` describe what main's
tool registry calls, and `memory`'s `remember`/`forget`/`paths` serve the tools
and the settings. The typedefs are prose — nothing checks them against the
adapters, so a change to what the engine passes changes the port as well:

- `llm-port` — streaming rounds against a provider
- `tool-port` — tool registry and execution
- `chat-preferences-port` — UI prefs, system prompt, tool round limit
- `workspace-path-port` — path helpers (e.g. `basename`)
- `own-secrets-port` — the app's own secrets, compared against the text the
  prompt embeds by itself (#528); wired to the list in
  `main/services/own-secrets.js` that the tool results are checked against
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
  each other. *Forget* names an entry by its line **and** its text, so a line
  that moved since the list was drawn cannot take another entry with it (#577).
- Both adapters below and the memory adapter read and write through
  `main/services/embedded-text-file.js` (#534): the folder's `AGENTS.md` and
  `.agents/memory.md` count only when their real path is a regular file inside
  the folder — a symlink that leads out is treated as absent and refused on
  write; the global files in the home folder only have to be regular files,
  because a dotfiles manager links them elsewhere. A read stops at its limit,
  a write goes to a temporary file next to the real target and is renamed onto
  it, and a read for a write that fails for any reason but a missing file
  writes nothing.
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

  The transport stays free of MCP's meaning in both directions (CR-B16-02,
  -04): a request the server sends goes to an `onRequest` handler of the
  service, which answers `ping` and refuses everything else with "method not
  found"; a request we give up on — aborted or timed out — is reported through
  `onCancel`, and the service tells the server with `notifications/cancelled`
  (never for `initialize`). A server starts in its configured working
  directory, relative to the home folder, or in the home folder itself
  (CR-B16-06). On Windows `main/services/windows-command.js` finds a bare
  command over `PATH` and `PATHEXT` and starts a `.cmd`/`.bat` through
  `cmd.exe` with its arguments escaped for both of cmd's reads, so `npx` works
  (CR-B16-01).

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
  know. Focus alone changes nothing, and while the value is kept its name and
  its "secret" box stay locked — renaming it or storing it in plain text needs
  the value again. Main checks the same: a `keep` with nothing stored under its
  name, or one that would flip between secret and plain text, is refused rather
  than dropped, and an empty secret value counts as "no value" unless it would
  replace a stored secret (CR-B14-02).

  Two read paths, deliberately separate and nailed down in
  `test/infrastructure-boundaries.test.js`: `createMcpConfigStorePort` returns
  the display form without secrets and is what handlers and renderer reach;
  `createMcpSecretsPort` decrypts and exists only for the service that starts
  the processes. MCP secrets additionally feed into `readOwnSecrets`
  (`main/services/own-secrets.js`) — an MCP server could otherwise return its
  own token via a tool result — and are masked out of error messages and stderr
  excerpts (`main/services/mcp-status-masking.js`) before a status leaves the
  main process.
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
class `execute` in the registry: an approval before every run and switched off
as shipped (see `docs/security-concept.md`, section 9).

**Isolation** ([#329](https://github.com/kkrafft1999/snotra/issues/329)) lives
below the ports, in `main/services/sandbox-service.js`, and neither the core nor
the tool registry knows how it works. Both runners take the service as a
dependency and hand the argv they would spawn anyway to
`main/services/sandboxed-spawn.js`; with isolation it comes back as
`/bin/sh -c <wrapped>` (Seatbelt on macOS, bubblewrap on Linux, via
`@anthropic-ai/sandbox-runtime`), without it unchanged plus the reason. Three
things cross the boundary upwards: the request carries `workspaceRoot` and
`networkDomains`, the result carries `isolation`, and the planner asks
`describeSandbox()` so that the approval card shows the same state the run gets.
The domains of a call are derived once, in `shared/runtime/sandbox-domains.js`,
for card and run alike. The service decides availability by a self-test on
first need and serialises runs whose domain sets differ, because the proxy's
allowlist is process-wide.

The **per-workspace opt-out** ([#357](https://github.com/kkrafft1999/snotra/issues/357))
is policy, not isolation, and lives in the signed policy file next to the rules
(`main/services/tool-policy-store.js`, a list of canonical roots). The planner
reads it through `isSandboxDisabled(root)`, puts it on the plan
(`plan.sandbox`, part of the plan key) and checks it again in `verifyTargets`,
so a switch flipped between card and run voids the call. The handler passes
`sandboxDisabled` from the approved plan to the runner, where `planSpawn` then
does not ask the service at all and reports the reason `workspace`. The
tool-permission state tells the renderer whether an offered execution tool
would run unisolated (`executionIsolation`, with `pending` while the detection
has not answered yet). The mode pill warns on it in "Auto" (#396), and the
shield next to the folder name (`FolderSandboxShield`, #398) shows it in any
mode; both take their words from `describeModePill` and
`describeFolderSandbox`.

**Program allowances** ([#408](https://github.com/kkrafft1999/snotra/issues/408))
widen the sandbox for one program in every workspace: domains, writable
folders and, on macOS, the trust service (`enableWeakerNetworkIsolation`). The
entry format is shared (`shared/contracts/program-allowances.js`) and stored in
the signed policy file. `main/services/program-allowances-service.js` resolves
programs through the shell's PATH, checks folders against Snotra's storage and
the sandbox's unreadable paths, and matches a command: one simple command
(`shared/runtime/simple-command.js`) whose program is the same real file. The
planner calls it through `matchProgramAllowance`, puts the result on
`plan.sandbox.allowance` (with the line rewritten to the absolute path, part of
the plan key) or `plan.sandbox.allowanceSkipped`, and re-checks the stored
entry in `verifyTargets`. The `shell_execute` handler hands the plan's
allowance to the runner; `planSpawn` passes folders and trustd to
`sandbox.prepare`, whose `buildConfig` adds them. The settings list lives in
`renderer/components/ProgramAllowancesSetting.js`; widening goes through a
native confirmation in `main/ipc/tool-permission-handlers.js`.

Both network tools are marked in the registry as `requiresWorkspace: false`
(issue #96): the engine no longer builds the tool list wholesale only with an
open project folder, but filters per tool.

**Infrastructure ports** (`src/main/ports/`) — implemented by adapters,
injected via composition:

- Storage: `llm-config-store-port`, `ui-prefs-store-port`,
  `chat-history-store-port`, `workspace-folder-store-port`,
  `provider-secrets-port`
- Runtime: `provider-runtime-port`, `provider-catalog-port`,
  `provider-model-listing-port`, `credential-port`, `filesystem-port`,
  `speech-port`, `update-port`

The web search key and the MCP stores are narrowed in
`adapters/persistence-store-adapters.js` (`createWebSearchStorePort`,
`createMcpConfigStorePort`, `createMcpSecretsPort`) without a typedef of their
own in `ports/`. A typedef lists every member its adapter provides;
`test/filesystem-port-typedef.test.js` holds `filesystem-port` to that.

### Self-update: three steps, three modules

The `update-port` is deliberately not a single "update yourself", but
`checkForUpdate` / `downloadUpdate` / `installUpdate` plus cancellation. The
reason is the requirement itself (issue #232): the user confirms downloading and
installing separately and can step out in between — a combined call could not
express that.

Behind it sit three modules in `services/`, separated by what can go wrong in
each:

- `update-targets.js` — **pure**, without file system and processes. Answers
  "what kind of installation is running here" (macOS bundle, a Mac bundle
  running read-only from the disk image or under App Translocation, Windows
  directory, AppImage, extracted Linux directory, system package, development
  build) and
  "which release asset fits it". This decision comes out differently on every
  platform and can be tried out safely on none, which is why it stands on its own
  as a pure function.
- `update-download.js` — stream to disk, with progress and real cancellation.
  Downloads only from `github.com` or `*.githubusercontent.com` over HTTPS —
  the address it asks for and the one GitHub redirects it to — and discards a
  file whose length does not match the announced one, or whose SHA-256 differs
  from the `digest` GitHub lists for the asset (#569, #573); a torso must not
  pass as a finished download on the next attempt. Cancellation covers the
  whole step from the click on, including the fresh check of the release that
  precedes the transfer (#568).
- `update-installer.js` — the replacement. The same pattern everywhere: the new
  version is fully unpacked and verified **next to** the old one — on macOS the
  DMG's own checksum, the bundle identifier and the version in `Info.plist`; in a
  Windows or Linux folder the product name and version in the `package.json`
  inside `resources/app.asar` (#569) — and only then
  does a detached helper script take over that waits for this process to end,
  renames and restarts. It would not work inside the running process — on Windows
  the `.exe` is locked, on Linux the AppImage is mounted as a file system inside
  its own process. On Windows the helper starts in two stages (#654): a child
  that Node spawns without `detached` is killed together with the app, so that
  child only starts the swap script with `Start-Process` and waits until the
  script reports that it runs. The app quits only then, and can still report a
  helper that did not start. The scripts themselves are built as plain strings
  and are therefore testable without an installation.

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
missing directory is no more an error than anything else.

**A switch-on is bound to where it was made** (#576). The UI preferences keep
two lists: `activeSkills` for system and global skills, and
`activeWorkspaceSkills` with one entry per workspace root for that folder's own
skills. The renderer only sends the names it shows ticked; the settings handler
binds each to the skill that is usable in the open folder
(`skillsService.bindSelection`) and keeps what that catalogue cannot see —
another folder's list, a global name whose skill is shadowed there. A name in
the global list therefore never switches on a workspace skill: a cloned
repository with `.agents/skills/<name>` would otherwise inherit the user's
choice of their own skill of that name. Where a folder skill shadows a
switched-on global one, neither is on in that folder until its own skill is
ticked there. It is strictly
separated from the `userData` folder: that is Electron-managed app state and off
limits for tools. Parsing the front matter lives as a pure function in
`shared/runtime/skill-frontmatter.js`, the enums and DTOs in
`shared/contracts/skills.js`.

### One watcher, two consumers

That the app notices what happens **next to** it in the file system is the work
of a single service: `services/directory-watcher.js`. It encapsulates the
dearly-paid quirks of `fs.watch` — missing target directories, a disappearing
watch root (macOS goes silent, Windows fires endlessly), event avalanches
(debouncing with a maximum window), `error` events without listeners, and
re-arming after a lost event (issues
[#126](https://github.com/kkrafft1999/snotra/issues/126),
[#155](https://github.com/kkrafft1999/snotra/issues/155)). A folder switch drops
whatever was still waiting to be reported for the folder just left
([#650](https://github.com/kkrafft1999/snotra/issues/650)).

What it does on each platform
([#648](https://github.com/kkrafft1999/snotra/issues/648)):

- **macOS and Windows** — one native `fs.watch(…, { recursive: true })` per
  target (FSEvents, `ReadDirectoryChangesW`). It costs one handle whatever the
  size of the folder, and it reports by path, so a file replaced by rename is
  reported like any other.
- **Linux** — watched folder by folder. Node's `recursive: true` is an emulation
  there: it puts an inotify watch on every file and every folder, `node_modules/`
  included, loses every file once it has been replaced by rename (an atomic
  write, an editor save, git's `HEAD.lock` → `HEAD`), and returns a partial
  watcher without a word when the kernel's watch budget runs out. Instead, every
  folder gets one plain watch — inotify reports a change to a child by its name,
  whatever happens to the child's inode. A folder that a rename brings in gets a
  watch, and its content is reported, since it may have filled up before the
  watch was set; one that goes loses its watch and those below it. The walk is
  asynchronous and breadth first, follows no symbolic links, keeps out of the
  folders the consumer names (`folderPolicy`), and stops at
  `LIMITS.MAX_WATCHED_DIRECTORIES` folders per target. At that cap, or when the
  kernel has no watch left (`ENOSPC`, `EMFILE`), the service says so through
  `onError` and reports `complete: false`, so the tree reloads coarsely and
  shows what is there at that moment. That is as far as it goes: the folders
  skipped at the limit stay without a watch until the watch is set up afresh,
  the next time the folder is opened, and what changes in them until then is
  not reported. A folder that goes frees its watch for the next new one. A
  folder's own events — a chmod, its removal, its move — arrive at its watch
  under its own name, as if a child of that name had changed; unless such a
  child exists, they count as an event on the folder itself.

`onError` always names the folder whose watch failed. The composition writes it
to the log, at most one line per watcher and minute.

On top of it sit two thin shells that only say *what* is being watched:

- `services/skills-watcher.js` — `.agents/skills` in the workspace as well as
  `~/.snotra/skills` and `~/.agents/skills` in the home directory, each with an
  ancestor chain (the directories are usually missing). Reports without a
  payload; the skill catalogue is read completely afresh anyway. It follows
  only the open folder, so a folder switch also drops the cached scans — a
  folder that comes back is read afresh instead of from a scan nothing watched
  (#578).
- `services/workspace-watcher.js` — the project folder, recursively and without a
  chain upwards. It reports the affected **folders**, so that the file tree does
  not have to reload everything on every event (issue
  [#158](https://github.com/kkrafft1999/snotra/issues/158)). An ignore list keeps
  the events from the contents of `node_modules/` and `.git/` out, whatever the
  case of the folder name, as the listing hides `.GIT` too — on Linux it
  also keeps the watches out of those folders, so a `node_modules/` of 20,000
  files costs none, and `.git` gets one watch of its own without its subfolders.
  Beyond that it ignores exactly the entries the listing never shows (`.git`,
  `.DS_Store`, `Thumbs.db`, `desktop.ini`), from the one definition in
  `shared/runtime/hidden-entries.js`; an editor's `notes.md~` is listed, so it
  is reported too (#650). `.git/HEAD`, `.git/index` and `.git/ORIG_HEAD`
  deliberately get through — they are the sign of a branch switch, a merge or a
  rebase and report as `complete: false`, whereupon the renderer reloads once,
  more coarsely, instead of a hundred times individually.

The path to the tree: `fs:tree-changed`
(`shared/contracts/workspace-tree.js`) → `FileTree.js` reloads the reported
folders, but only the currently visible ones, and only if their content has
actually changed. Selection, keyboard focus and scroll position are saved before
the redraw and restored afterwards.

Every other rebuild of rows takes the same road
([#636](https://github.com/kkrafft1999/snotra/issues/636)): an agent's write, a
delete from the context menu, a move, an import, a folder's first expansion and
the folder switch itself all run through one queue in `FileTree.js`, the
redraws through the one that keeps the view. Two rebuilds side by side would
both clear a container before either appends, and every row would show twice.
A folder switch that a newer one overtakes stops after its next await and
draws and reports nothing
([#633](https://github.com/kkrafft1999/snotra/issues/633)). Main's side of a
switch runs one step at a time — an activation and the announcement to the
chat never overlap — and the number that decides who is current is taken in
the activation's step, so no older call announces a folder main has already
left. The folder left is cleared at once, and a listing still running for it
is no longer waited for, so a share that does not answer holds up no folder
picked after it. A folder whose listing takes longer than 150 ms shows that it is loading —
a ring in its arrow's slot, or for the project folder a note in the tree's
place. A folder that cannot
be listed is not drawn empty: `readDirectory` returns `unreadable` with a reason
(`permission`, `missing`, `refused`, `failed`), and the tree puts a note from the
catalogue in its place
([#639](https://github.com/kkrafft1999/snotra/issues/639)).

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
`realpath`, determines the type from the file content (PNG, JPEG, GIF, WebP by
their signature; SVG, since [#345](https://github.com/kkrafft1999/snotra/issues/345),
by its root element) and limits the size. An SVG is only ever shown through
`<img>`, where no script in it runs and no reference in it is fetched. Back comes `{ mime, base64 }` or a reason from
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

**`<img>` is the only element that keeps a URL** ([#423](https://github.com/kkrafft1999/snotra/issues/423)).
The HTML profile allows more that loads on its own: `<video>`/`<audio>` with
`<source>` and `<track>`, a `poster`, `<input type="image">`, a table's
`background`. Each of them would read a local file past the main process —
`'self'` covers `file:`. So the sanitizer forbids the media tags and `picture`,
drops `poster` and `background`, and the same hook
removes `src` from every element but `<img>`; `<input>` itself has to stay, the
task lists render their checkboxes with it. The CSP says `media-src 'none'`:
the voice recording records a stream and never plays one back.

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

**Where the source comes from** (issue
[#646](https://github.com/kkrafft1999/snotra/issues/646)): the page cannot name
one. `FileTree.js` hands the preload the dropped `File` objects, and the preload
resolves each path itself with `webUtils.getPathForFile` — Electron's documented
pattern for a sandboxed preload behind `contextBridge`. A string, an object that
only looks like a `File`, or a `File` the page made has no path there and is
dropped; a drop with nothing from the file system in it does not reach main at
all. Between preload and main the channel still carries path strings, so main
keeps every check below: page script cannot choose those strings, but a
renderer process compromised below the page could.

In the adapter only the **target** goes through `boundPath()` (realpath-checked).
The **source** is deliberately not checked against the workspace — that is
exactly what the channel is for — but it must be absolute, and neither its
written nor its real path (`fs.realpath`) may match
`shared/runtime/sensitive-paths.js`; a hit rejects the drop, so `~/k8s → ~/.kube`
does not pass as `k8s/config`. The rest lives in `services/fs-service.js`:
`inspectImportSources` counts recursively (symlinks, sensitive names and
anything that is neither a regular file nor a folder — pipes, sockets, devices —
are counted and skipped, not followed), `importExternalItems` copies with
`fs.cp` — copies, not moves, because `fs.rename` only works within one file
system, and deleting the source outside would not be recoverable. Both routes
share the collision scheme `name (2).ext` via `findFreeTargetPath`; within one
drop the names handed out compare case-insensitively on macOS and Windows, where
`README.md` and `readme.md` are the same file. The copy is all or nothing: a
folder target is created exclusively before it is filled, files are copied with
`COPYFILE_EXCL`, and when one target fails, what this import created is removed
again — never what was there before. The limits (`MAX_IMPORT_ENTRIES`,
`MAX_IMPORT_TOTAL_BYTES`) live in `shared/limits.js`; exceeding one rejects the
whole drop instead of copying half of it. Confirmation happens natively in
`ipc/fs-handlers.js` via `dialog.showMessageBox`, with the skipped entries named
in it — the renderer only triggers it, see `docs/security-concept.md` §5.

### Context menu of the file tree

`services/file-context-menu.js` builds the native menu (open, new file, new
folder, reveal, information, rename, delete). The renderer only triggers it via `fs:showFileContextMenu`
and sends nothing but the path; the handler checks it with the adapter's
`resolveCheckedWorkspacePath()` (realpath-checked, not fs-service's lexical
`resolveWorkspacePath`), exactly as sent — a name may end in a space, and only
paths the model types are trimmed. Whether the path is a folder the handler
looks up itself with `lstat` (issue
[#649](https://github.com/kkrafft1999/snotra/issues/649)): it decides whether
"Open" is offered and how the delete confirmation words it, and that
confirmation is a safeguard against a compromised renderer. A symlink counts as
a link — "Open" is offered, and the trash takes the link, not its target.

**"Open"** hands the path to `shell.openPath`. For a document that means "show
it in its app"; for a program or script it means "run it", with the user's full
rights and outside the shell switch (#102) and the sandbox (#329). So before
`openPath` the menu checks the target — by extension per platform
(`LAUNCHABLE_EXTENSIONS`: `.exe`, `.bat`, `.ps1`, `.lnk`, `.url`, `.py` … on
Windows, plus `PATHEXT`; `.app`, `.command`, `.sh`, `.pkg`, `.scpt`, `.py` … on
macOS; `.desktop`, `.sh`, `.AppImage` … on Linux), following a link to what it
points to, and on macOS and Linux a regular file *without* an extension that has
an execute bit (a `report.pdf` from an exFAT stick, where everything is 0777,
opens by its type and does not ask) — and asks natively first,
"Cancel" as default and Escape answer. Files Snotra writes carry no
Mark-of-the-Web and no quarantine attribute, so SmartScreen and Gatekeeper would
not ask. A failed `openPath` (no app for the type) shows an error box. Every
click that opens a dialog is guarded against a rejection, which would otherwise
take down the main process when the window closes while the dialog is up.

**New file, new folder, rename** (issue
[#349](https://github.com/kkrafft1999/snotra/issues/349)) are split between the
two sides. The menu entries do nothing on disk: they push `fs:begin-create`
(`{ path, kind }` — the folder itself, or a file's folder) or `fs:begin-rename`
(`{ path }`) to the renderer, which opens a name field in the tree. The name
comes back over `fs:createItem` / `fs:renameItem`; the adapter binds the folder
or the entry to the workspace like every other path and refuses the workspace
folder itself (`reason: 'root'`), and fs-service checks the name with
`shared/contracts/item-name.js` — the same rule the renderer applies while the
user types, the strictest of the three platforms on all three (no separators,
no `.`/`..`, nothing Windows refuses, at most 255 bytes). A file is created with
`wx` and a folder with a non-recursive `mkdir`, so an existing name fails in the
same call that would create it. A rename refuses an existing name unless it is
the same inode — a case-only rename on APFS or NTFS —, which goes through a
temporary name so the new spelling shows on every platform. Failures carry a
`reason` code for the renderer to word, next to the system's message. While the
field is open it holds the tree's queue (#636), so a watcher report cannot
redraw the field away; the open folder's own menu, from the empty space below
the rows, offers "New" but neither rename nor delete.

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
lock: `CHAT_HISTORY_DELETE` removes the chat's folder, and a
`CHAT_HISTORY_UPSERT` removes the folders of the sessions it drops out of
`MAX_CHAT_SESSIONS`. After that it sweeps everything for which there is no longer a
session — but only while no history lies moved aside next to the live one
(`chat-history.json.undecryptable-*` or `.unreadable-*`). Those folders may belong
to the chats in that copy, and the copy is kept so that it can be recovered, images
included (#565). Once the copy is gone, the next save sweeps them.

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
  [`security-concept.md`](./security-concept.md) §8.

An entry that no longer exists, or whose access is incomplete, falls back to the
default (`isPresetUsable`) instead of opening the chat with a dead model.

The service keeps what changed in this session in memory, on top of what the
history file holds — never in place of it: a chat whose model was changed keeps
its stored mode, and the other way round (#558). Switches run one after
another, and the mode is applied before the model, so the chat on screen never
runs under the mode of the one before it — not after two quick clicks, not
after a failed model switch (#559).

### Runs per chat ([#320](https://github.com/kkrafft1999/snotra/issues/320))

A run belongs to the chat it was started in, not to the screen. Until 1.8.1 the
engine held one run per window (`sessionId = sender.id`), and the renderer
threw a run's result away as soon as another chat was opened.

- **Engine:** `activeRuns` is keyed by window *and* chat. A new turn in the same
  chat replaces its run; another chat's run goes on. `abort(sessionId, chatId)`
  stops one chat, without a chat every run of the window.
  `runningChatIds()` tells main which chats are still working.
- **Events:** `chat-handlers.js` adds `chatId` and the renderer's `runId` to
  every `chat:delta`, `chat:tool-line` and `chat:progress`. The renderer
  registers its listeners once and routes each event to its run; a late event
  of an earlier turn finds nothing.
- **Renderer:** `appStore.chatRuns` holds the runs. While its chat is on screen
  the chat's data lives in `appStore` as before; when another chat takes the
  screen, the run takes its chat along (`run.chat`) and keeps writing into those
  messages without touching the list. Opening the chat again puts it back
  (`ChatStream.runs.attach`) — from memory, because the file only knows the
  state from when it left. A finished run writes into its own chat and does
  not make it the folder's active chat. Deleting a running chat stops the run
  first, so that its answer cannot bring the chat back.
- **Mode:** the policy file holds the mode of the chat on screen.
  `chat-session-settings` remembers the mode a chat had when it left the screen
  (`modeFor`), and the policy port answers a run with its own chat's mode.
- **Approvals:** cards and session approvals live as long as their chat is on
  screen or running (`pruneChatScopedPermissions` in the composition root); a
  mode change only affects its own chat. Details in
  [`security-concept.md`](./security-concept.md) §7.
- **History:** a running row shows "Working…" or "Needs your approval" in place
  of its time (`ChatHistoryPanel.syncRunMarkers`).

### Recording what the agent changed (#348)

The three writing tools (`write_file_text`, `edit_file`, `apply_patch`) hand
every finished write to an `onWritten` callback in their options: the content
before (a Buffer, `null` for a new file) and after. `write_file_text` reads the
old content for that, within the read limit; `apply_patch` reports only once
every file of the patch is written, so a rollback leaves nothing behind.

`workspace-tool-adapter.js` collects those writes and, once the call has come
back without an error, passes them to `services/file-change-recorder.js`. The
recorder keeps both sides **in memory only** (2 MiB per file, 32 MiB in all,
oldest first out) and returns a summary without content —
`{ id, relativePath, status, created, added, removed }`. The summary travels
on the `fileWritten` progress event (for the tree) and on the done line of the
call (`entry.changes`, for the chat); the chat history stores it, never the
content. Ids carry a boot id, so one from before a restart is told apart from
an unknown one.

The renderer asks for the lines with `chat:file-changes` and the ids it was
given — never a path. `services/line-diff.js` compares lines without their
endings (Myers, with a bound on the edit distance), so a CRLF file edited with
LF lines shows the edit, and a pure line-ending change is reported as such.
Several ids of one file are combined: before the first against after the last.


## Composition root

`src/main/composition/create-application.js` is the central entry point after the
Electron bootstrap:

1. Creates infrastructure services (`storage-service`, `fs-service`, …)
2. Wraps them in narrow port adapters (`persistence-store-adapters`, …)
3. Builds the chat application via `create-chat-application.js` (LLM, tool and
   preferences adapters → `createChatEngine`)
4. Registers IPC handlers with injected dependencies

It holds wiring and nothing else (#508). Whatever makes a decision or shapes
data lives next to its topic and is tested there:

| Topic | Module |
| ----- | ------ |
| Own secrets (concept §5): which values a tool result must never carry | `services/own-secrets.js` |
| Masking the status of an MCP server | `services/mcp-status-masking.js` |
| The model's skill suggestion (`SKILLS_SUGGEST`) | `ipc/skill-suggestion-handlers.js` |
| What Settings › Security and the mode pill read | `services/security-page-data.js` |
| The update check after the start and from the menu | `createUpdateCheck` in `adapters/update-adapter.js` |

What stays in the module are the small state holders the wiring needs — the
remembered language, the hidden-files switch, whether a web search key is
present, the two execution switches — and the callbacks that tie services to
one another (pruning chat-scoped permissions, telling the renderer to read
again). They exist because two services meet there, not because of a rule of
their own.

Before `createApplication()`, `src/main/index.js` does only two things. It
claims the single-instance lock (`claimSingleInstance` in `app-lifecycle.js`,
#507): a second launch on the same userData folder brings the existing window
to the front and quits before it has started anything. And it runs the
one-time userData migration (`services/userdata-migration.js`, taking over from
the folder of the predecessor identity "Weyouze Anything"; skipped when the
userData folder was given with `--user-data-dir`, #688) — no scattered wiring in
the handlers. A start-up that throws ends in an error box and
`app.exit(1)` (`createStartupFailureHandler`, #509) instead of leaving a
process without a window behind.

### Files the store cannot use

`storage-service` keeps one JSON file per topic in the userData folder and
writes each atomically (temporary file, rename with the Windows retry of #472).
What it does with a file it finds but cannot use is one rule for all of them:

- **Missing** — start from the defaults; a first read may write them.
- **Not readable** (a read error after the retry) — shown as defaults, never
  written over; a save throws instead (#473).
- **Not understood** (broken JSON, or a version newer than this build, as after
  installing an older release over a newer one) — shown as defaults; before
  the next save it is moved aside as `<name>.unreadable-<stamp>`, byte for
  byte, and the store starts from its defaults. A move that fails throws, so
  nothing is written (#557).

The chat history follows the same idea with its own names: a history that
cannot be decrypted or parsed is moved aside as
`chat-history.json.undecryptable-<stamp>` on the first read, one written by a
newer release (`version` above this build's) as
`chat-history.json.unreadable-<stamp>` (#566), and when that move fails, no save
may write over it (#561). While such a copy lies there, the images of its chats
are not swept (#565).

The **menu bar** lives as a pure template in `services/application-menu.js`:
`createApplicationMenuTemplate()` receives platform, app name, `getMainWindow`,
`shell` and the update check, and returns the menu structure.
`Menu.buildFromTemplate()` stays in `index.js` — that way it is possible to check
what is in which menu without starting Electron (`test/application-menu.test.js`).

## Provider adapters

`src/main/providers/` holds one module per provider that fulfils the contract
from `providers/index.js` (`listModels`, `streamChatRound`, plus `fields`,
`presentation`, `capabilities`). Five are registered: `openai`, `anthropic`,
`google`, `ollama` and `openai-compatible`. MLX-LM had a module of its own
until issue #194; it is now a template of `openai-compatible`, and the
`llm-config.json` migration to version 5 moves existing entries over.

The two OpenAI protocols exist **once** and are shared, instead of being copied
per provider:

| Module | Protocol | Used by |
| ----- | --------- | ----------- |
| `openai-chat-transport.js` | Chat Completions (`POST {base}/chat/completions`), SSE | `openai-compatible` |
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
- **The redaction of own keys** (`readOwnSecrets` in `services/own-secrets.js`)
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
of the model listing (`modelsTimeoutFor` in `providers/openai-compatible.js`, with
the limits from `services/request-timeout.js`), the character budget of the
history (`application/chat/chat-history-trim.js`) and the characters→tokens
divisor of the context breakdown (`shared/contracts/context-breakdown.js`).

Up to issue #193 this hung on a fixed list of provider IDs. The generic provider
fits into no such list — the same ID serves LM Studio on `localhost` and a
gateway on the network. The question is therefore answered by
`shared/contracts/provider-endpoint.js` at the **host of the base URL**; the
remaining ID entry for `ollama` stays, and the host rule applies in addition.
(`mlx-lm` left the list with issue #194 — a MLX-LM server on `127.0.0.1` is
local through its URL.)

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
| `renderer/tree/workspacePaths.js` | The workspace's flat path list for the `@` menu and the tree's filter ([#350](https://github.com/kkrafft1999/snotra/issues/350)): one cache, keyed by folder and hidden files, dropped on a folder switch, an agent write or a watcher report. Ranking and highlighting live in `renderer/chat/mentionAutocomplete.js` (`rankMentionCandidates`, `mentionMatchRanges`), so both find the same files in the same order | `test/file-tree-filter-dom.test.js`, `test/mention-autocomplete.test.js` |
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

### File views: what the content pane shows ([#225](https://github.com/kkrafft1999/snotra/issues/225))

The content pane shows a file through a **file view** — either a *viewer*,
which only shows, or an *editor*, which can also hold changes that are not on
disk yet. Which view takes a file is decided by a registry, not by a chain of
`if` branches in `FileTree.js`. This is the extension point for every new file
type: a new view is one module and one line in the registry.

| Module | What lives there | Test |
| ----- | -------------- | ---- |
| `renderer/file-views/registry.js` | The descriptor, context and instance interface (documented in the module header), the registry and its order. DOM-free. | `test/file-view-registry.test.js` |
| `renderer/file-views/host.js` | The pane as host: reading the file, choosing the view, the header (name, size, tool area), the file info card as the last fallback, mount/update/unmount, and the one gate for unsaved changes | `test/file-view-host-dom.test.js` |
| `renderer/file-views/plain-text-view.js` | The default view: the text as it is, in `<pre id="preview-content">` | both of the above |
| `renderer/file-views/markdown-view.js` | `md`, `markdown`, `mdx`: rendered, with a "Preview \| Source" switch; images, links, notices ([#344](https://github.com/kkrafft1999/snotra/issues/344)) | `test/markdown-view-dom.test.js`, `e2e/smoke.test.mjs` |
| `renderer/file-views/markdown-document.js` | What needs no mounted view: front matter, paths relative to the file, link kinds, the inert fragment | `test/markdown-document.test.js` |
| `renderer/file-views/image-view.js` | `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`: fitted, toggle to actual size, checkerboard, pixel dimensions, a reason instead of an empty column; SVG with a "Preview \| Source" switch ([#345](https://github.com/kkrafft1999/snotra/issues/345)) | `test/image-view-dom.test.js`, `e2e/smoke.test.mjs` |
| `renderer/file-views/mode-switch.js` | The "Preview \| Source" control, shared by Markdown and SVG | both view tests |
| `renderer/file-views/read-failures.js` | Why a file is not shown as text: main's reason codes of `fs:readFile` and their catalogue sentences, for the info card and the SVG source ([#641](https://github.com/kkrafft1999/snotra/issues/641)) | `test/file-view-host-dom.test.js`, `test/image-view-dom.test.js` |
| `renderer/file-views/pdf-view.js` | `pdf`: continuous pages drawn near the viewport, page and zoom in the header, password field, a reason instead of an empty column ([#346](https://github.com/kkrafft1999/snotra/issues/346)) | `test/pdf-view-dom.test.js`, `e2e/smoke.test.mjs` |
| `renderer/file-views/pdf-engine.js` | Loading the vendored pdf.js, its options, the BinaryDataFactory that asks the main process for data files | `e2e/smoke.test.mjs` |
| `renderer/file-views/html-view.js` | `html`, `htm`: the page as it runs, in a view the main process lays over the stage; "Preview \| Source", Reload, Open in browser, the notice of what was blocked, a reason instead of an empty column ([#479](https://github.com/kkrafft1999/snotra/issues/479)) | `test/html-view-dom.test.js`, `e2e/html-preview.test.mjs`, `e2e/smoke.test.mjs` |
| `main/services/html-preview-service.js` | The page's side: its `WebContentsView`, the in-memory session, the `snotra-html:` scheme, what the page may load and where its links lead | `test/html-preview-service.test.js`, `test/html-preview-isolation.test.js` |
| `renderer/file-views/changes-view.js` | "Show changes": the diff of one or more writes to a file, its states and notes. Not in the registry — no file *is* a diff; the host mounts it on request and adds "Content \| Changes" to any file the conversation on screen changed ([#348](https://github.com/kkrafft1999/snotra/issues/348)) | `test/file-changes-dom.test.js`, `e2e/file-changes.test.mjs` |
| `renderer/file-views/diff-model.js` | Main's runs to rows: three lines of context, the rest folded into gaps. DOM-free | `test/file-changes-dom.test.js` |

```
FileTree.js ──"show X" / "X changed" / "X is gone"──▶ host.js
                                                      │ registry.resolve(file)
                                                      ▼
                          first view whose canHandle() says yes ─ none ─▶ info card
                                                      │ api.readFile — error ─▶ info card, with the reason
                                                      ▼
                          mount(fresh element, context) → instance
```

The rules the host guarantees:

- **The first view that can handle a file wins**, in the explicit order of the
  registry; specialised views go before `plain-text`. `resolve(file, id)` can
  pick another candidate — the hook for a later "rendered | source" or
  "view | edit" switch, which a type with more than one view will need.
- **The header belongs to the pane**, not to the view: name and size look the
  same for every type. A view may put controls into the tool area next to the
  size (`context.setTools`); it is hidden while empty. What the size pill says
  can be extended by the view (`context.setMeta`) — the image view puts the
  pixel dimensions after the size.
- **Every mount gets a fresh element.** Nothing is inherited from the previous
  view, including the scroll position.
- **`update()` only comes when the text on disk changed.** A watcher report for
  a neighbouring file, or the echo of the editor's own save, does not reach the
  view — a viewer keeps its scroll position and text selection. A refresh that
  finds the same text calls the optional `revalidate()` instead: the Markdown
  view checks its images again there, without rendering anew. A watcher report
  for other folders than the document's reaches the view as
  `revalidate({ directories })`, so an image in `docs/img/` follows its file
  too ([#640](https://github.com/kkrafft1999/snotra/issues/640)).
- **A read error is shown, not swallowed.** A file over the 1 MB preview limit
  goes to the info card — also when it grows past the limit while it is open,
  where the old text used to simply stay. `fs:readFile` answers a failure with a
  reason code next to the system's message (`refused`, `missing`, `permission`,
  `too-large`, `failed` — `refused` only for a path that really lies outside,
  a dangling link is `missing`, a closed folder on the way `permission`, the
  same codes the tree's listing uses); the card keeps the size in its Size row and says the
  reason below it, as a catalogue sentence in the interface language. A view
  that fails to mount logs the cause and gets a generic sentence
  ([#641](https://github.com/kkrafft1999/snotra/issues/641)).

**Editors.** An editor reports unsaved changes via `context.setDirty()`. Every
path that would replace or close it — another file, another folder, the file
deleted — goes through one gate in the host; there the editor can keep the pane
(`confirmLeave` answers `save`, `discard` or `cancel`). `selectFile()` only moves
the tree selection once the pane actually shows the new file, and
`openProject()` settles unsaved changes before it asks main to switch folders.
An editor with unsaved changes survives an external change (it gets `update()`
and decides) and a file it can no longer read. The dialog itself and the write
channel would come with the first editor; there is none, because editing in the
preview was dropped on 2026-09-26
([#226](https://github.com/kkrafft1999/snotra/issues/226)). The default answer
is `cancel`, because a lost edit is worse than a pane that stays where it is.
`setDirty()` is ignored for viewers, so a viewer can never trap the user.

The pane follows the open file, not the tree selection: clicking a folder
moves the selection, but the file on show keeps reloading when the watcher
reports its folder, and closes when it disappears.

**Commands and links.** A view may implement `command(name)`; the host passes
menu commands through `runCommand()` — today only `toggle-source`, the
Cmd/Ctrl+Shift+M shortcut of the Markdown view and of an SVG. A view that points
at another file calls `context.openFile(path)`, which the host hands to the file tree:
only the tree knows the workspace (`'outside'`), can unfold the folders and
select the row, and can tell a missing file (`'not-found'`) from one its
listing left out. A view that has been replaced gets `'stale'` and reaches
nothing. `context.openFile(path, { fragment })` keeps the `#section` in the
host, and the next open of that path hands it to the view it mounts as
`context.fragment` — the tree only ever opens the file
([#641](https://github.com/kkrafft1999/snotra/issues/641)).

#### Markdown ([#344](https://github.com/kkrafft1999/snotra/issues/344))

```
text ─ splitDocument ─▶ front matter ─▶ key/value block (raw YAML if unreadable)
                     └▶ body ─ markdownToSafeHtml(breaks: false, keepRelativeLinks)
                                 │  the one sanitizer, shared with the chat
                                 ▼
                          <template> (inert: nothing loads)
                                 │ img src → data-md-src, heading anchors,
                                 │ tables framed, links classified
                                 ▼
                          the view ─ images: fs:readWorkspaceImage → data: URI
                                   │         or a placeholder with the reason
                                   └ links:  external → shell, file#section → tree,
                                             #anchor → scroll and focus,
                                             else plain text
```

- **One sanitizer.** The chat and the preview both go through
  `markdownToSafeHtml()`. A file differs in two options only: `breaks: false`
  (a hard-wrapped paragraph is one paragraph, as on GitHub) and
  `keepRelativeLinks` (a link without a scheme leaves DOMPurify as
  `data-workspace-href` instead of disappearing). Both land in the app window,
  so nothing may reach beyond its own box: `id`, `name`, `role`, `tabindex`,
  `popover`, `popovertarget` and `popovertargetaction` are forbidden — a second
  `#chat-panel`, a `role="dialog"` that claims Escape, a first Tab stop or a
  box in the top layer would otherwise come from a README. So is everything
  that points at an element of the app by its id — `for`, `form`, `list`,
  `headers`, `command`, `commandfor`, `interestfor` — and every `aria-*`
  attribute (`ALLOW_ARIA_ATTR: false`): a `<label for="input-shell-enabled">`
  in a README would switch shell commands on with one click on its text
  ([#635](https://github.com/kkrafft1999/snotra/issues/635)).
- **Nothing loads on its own.** The HTML is parsed into a `<template>` and every
  `src` moves to `data-md-src` before a node reaches the window. Under the CSP
  `img-src 'self' data:` an `<img>` with an absolute path would otherwise load
  straight from the disk (`'self'` covers `file:`), past the main process's
  check whether the path lies inside the workspace. An image from the web is
  never requested: it becomes a placeholder with its address; the smoke test
  proves the absence with a CSP violation listener.
- **Paths start at the file.** `![](img/a.png)` in `docs/guide.md` means
  `docs/img/a.png`; a leading `/` means the root of the open folder, as on
  GitHub. The main process checks every image path again. Query and fragment
  are split off before the path is decoded, so `plot%231.png` is
  `plot#1.png`; tooltips and notices show the decoded path.
- **Images are checked again.** An overwritten image does not carry its new
  content in its path, so every render and every refresh checks each image:
  a cached one against size and date from a listing of its folder
  (`fs:readDirectory`, one call per folder), and only one that differs is read
  again — at most four reads at a time, each up to 10 MB of base64. A symbolic
  link lists its own date and is always read. A language switch renders the
  text anew and keeps every image as it was. The cache holds 24 images, like
  the chat's. An image that passes main's signature check but does not decode
  ends in the same placeholder as one that cannot be read
  ([#640](https://github.com/kkrafft1999/snotra/issues/640)).
- **Headings get anchors, not ids** (`data-md-anchor`, GitHub's slug, set after
  the sanitizer and only on headings): a heading called "Chat input" must not
  become a second `#chat-input`. Following an anchor scrolls to the heading and
  moves the focus there (`tabindex="-1"`, the ring only under
  `:focus-visible`); `guide.md#setup` does the same in the other file.
- **The mode belongs to the open file.** Every file opens in the preview; the
  source (the plain-text view, mounted on first use) and the preview both
  follow an external change, so switching back shows the current text.

#### Images ([#345](https://github.com/kkrafft1999/snotra/issues/345))

```
host ─ reads: 'none' ─▶ the host does not read the file
                         │
image view ─ fs:readWorkspaceImage(path) ─▶ main: lexical + realpath check,
                         │                  type from the content, 10 MB limit
                         ▼
          { mime, base64 } ─▶ <img src="data:…"> ─ decoded ─▶ fit, header W × H
          { reason }       ─▶ the reason as a sentence, in the column
```

- **The view reads, not the host.** A descriptor with `reads: 'none'` gets no
  text; `update({})` comes on every watcher report for the file, and the view
  compares size and modification time before it replaces anything — a click
  on the open image does not make it flash.
- **The same channel as the chat.** No `file://` URL, no CSP change; the main
  process stays the trust boundary. A symlink out of the workspace ends as
  "outside the open folder".
- **Fitted, never upscaled.** A click, or Enter/Space on the focused image,
  toggles to the actual size and scrolls to where the click landed. No zoom
  beyond that (decided with a mockup on 2026-09-27).
- **SVG stays a document.** It is shown through `<img>` only and never inlined;
  its markup is parsed with `DOMParser`, unattached, for the size it declares —
  Chromium would report 300 × 150 for an SVG with only a `viewBox`. Its source
  is the plain-text view behind the shared "Preview | Source" switch. A source
  that cannot be read as text — an SVG between the 1 MB text and the 10 MB
  image limit, a deleted file — is a message of its own in that pane, never the
  error as the file's content; the newest read wins
  ([#641](https://github.com/kkrafft1999/snotra/issues/641)).
- **Transparency shows.** A checkerboard sits behind the image only, in its own
  tokens (`--ds-checker-light`, `--ds-checker-dark`) for light and dark.

#### PDFs ([#346](https://github.com/kkrafft1999/snotra/issues/346))

Rendered by **pdf.js**, vendored from `pdfjs-dist` (a devDependency — only the
copy under `src/renderer/vendor/pdfjs/`, made by `scripts/sync-renderer-vendor.js`,
ships). The alternatives were Chromium's own PDF viewer, which needs
`plugins: true`, a looser CSP and cannot be themed, and a first-page thumbnail,
which Electron only offers on macOS and Windows.

```
pdf view ─ fs:readWorkspacePdf(path) ─▶ main: lexical + realpath check,
                │                       %PDF- in the first KB, 50 MB limit
                ▼
     { bytes: Uint8Array } ─▶ pdf.js (worker: vendor/pdfjs/pdf.worker.min.mjs)
                                 │ asks for CMaps, fonts, decoders
                                 ▼
                   BinaryDataFactory ─ pdf:readAsset(kind, name) ─▶ main:
                                 one of three fixed folders, a plain file name
```

**CSP and `webPreferences` are unchanged.** `sandbox`, `contextIsolation`,
no `nodeIntegration`, no `plugins`; `default-src 'none'`, `script-src 'self'`,
`connect-src 'none'`. The library and its worker are scripts from the app
itself — a worker falls back to `script-src`, and so does the decoders'
JavaScript fallback, which the worker `import()`s when WebAssembly is
refused. The data files are the part pdf.js would `fetch`; opening
`connect-src` for them would, under `file:`, let the renderer read any file on
the disk. They come through `pdf:readAsset` instead
(`main/services/pdf-assets.js`): `cmaps/`, `standard_fonts/`, `wasm/`, a plain
name, nothing else.

- **Nothing in a PDF acts.** No scripting sandbox is vendored or created, so
  PDF JavaScript never runs; `enableXfa: false`; no annotation layer, so a
  link is drawn but there is nothing to click. The smoke test opens a PDF
  with an OpenAction script and two link annotations and checks that nothing
  ran, opened or was requested.
- **No code from strings.** pdf.js 6 has no path that compiles code at run
  time any more and dropped its `isEvalSupported` option with it, so the
  option is not passed — an option pdf.js does not know protects nothing
  ([#641](https://github.com/kkrafft1999/snotra/issues/641)). In the page the
  CSP would refuse it: `script-src 'self'` without `'unsafe-eval'`. The
  worker does not get that CSP — it is loaded from a `file:` URL, whose
  response carries no policy, and a string timer runs there (checked on
  2026-10-02) — so in the worker what holds is the vendored code itself;
  `test/workspace-pdf.test.js` fails if a pdf.js update brings `eval` or
  `new Function` back.
- **Only pages near the viewport are drawn.** Every page gets a placeholder at
  once, sized like page 1: reading every page's size up front would load each
  page, thousands in a long scan
  ([#634](https://github.com/kkrafft1999/snotra/issues/634)). In a PDF of
  mixed sizes the scroll bar is therefore approximate until a page of another
  size comes near the viewport and takes its own. An IntersectionObserver
  draws pages within one screen of the viewport; further away a page loses
  its canvas and, through `page.cleanup()`, what pdf.js decoded for it — for
  the screen pdf.js only cleans up by itself after printing, so a scanned
  manual would otherwise keep 7–9 MB of every page ever drawn. A zoom change
  releases every drawn page the same way before it draws them again. A canvas
  is capped at 16 MP and drawn at a lower resolution above that.
- **Zoom** is relative to 96 dpi (100 % = one point as 1/72 inch); "Width"
  follows the column through a ResizeObserver. A zoom change keeps the same
  spot of the same page at the top. The value in the header is not a live
  region: a visually hidden status says the new zoom after the user zoomed,
  and stays silent when "Width" follows a divider drag or a window resize.
- **Password**: pdf.js asks through `onPassword`; the view shows a field in
  the column. The password lives in the view's closure until it unmounts — it
  is never stored — and is tried once more after a change on disk.
- **A load is never left behind** ([#634](https://github.com/kkrafft1999/snotra/issues/634)).
  pdf.js settles a load that waits for a password only in `destroy()`, so
  the view keeps the load under way and destroys it, with its worker, when
  the view is left or a newer open for changed bytes takes over. `update()` —
  the tree's refresh, which runs in the tree's sync chain — settles once the
  document or a reason is on show, once the form waits for the user, and
  once the load is stopped, whatever pdf.js does. A refresh at the prompt
  with unchanged bytes leaves the form alone; a redraw keeps what is typed,
  and the field takes the focus only when the form first appears or after
  the user's own wrong password. A document whose first page cannot be read
  is destroyed too, and the header shows only the size next to the reason. A
  file pdf.js could not read is not opened again — no new worker — until its
  size or mtime changes.
- **The header wraps** in a narrow column: the name keeps at least 10em, page
  and zoom tools and the size move to a second row, right-aligned.
- Not included: text selection and search (pdf.js's text layer), printing,
  the ICC profile for CMYK (it would need a synchronous request from the
  worker; colours are converted the simple way).

#### HTML pages ([#479](https://github.com/kkrafft1999/snotra/issues/479))

An `.html` file runs as a page, scripts included — the agent writes
interactive mockups and reports, and a static rendering would show them
broken. **It does not run in the app's renderer.** That was decided against
the obvious candidate, a sandboxed `<iframe>`, because the renderer's CSP
admits none: `default-src 'none'` with no `frame-src` refuses every frame
that loads a URL, and an `about:srcdoc` frame inherits `script-src 'self'`
and runs no inline script. Either would have meant relaxing the app's policy
for content it does not trust. A `<webview>` would have needed `webviewTag`
in the window's `webPreferences`. Both stay as they are, pinned by
`test/html-preview-isolation.test.js`.

```
html view ─ htmlPreview:open(path) ─▶ main: lexical + realpath check, 1 MB
    │                                   │ new WebContentsView, laid over the window
    │ the stage's rect, CSS px          │   own process · in-memory session
    ├─ htmlPreview:setBounds ─────────▶ │   no preload · sandbox · contextIsolation
    │  (null while a dialog covers it)  │   disableDialogs · no devTools
    │                                   ▼
    │                     loadURL(snotra-html://<host>/<absolute path>)
    │                                   │ every request
    │                                   ▼
    │       snotra-html:  ─▶ protocol handler: readWorkspaceFile (the checks of
    │                        images and PDFs), 1 MB HTML / 10 MB other, nosniff
    │       data: blob: about: ─▶ pass
    │       anything else ─▶ webRequest cancels and lists it
    │
    ◀── htmlPreview:event { blocked | open-file | focus-leave | unresponsive | gone }
```

- **Its own view, process and session.** The page lives in a
  `WebContentsView` that main adds to the window's `contentView` and places
  where the renderer says the stage is (`htmlPreview:setBounds`, CSS pixels
  times the window's zoom). Its session is a partition without `persist:`,
  so nothing it stores outlives the app, and every page gets a host of its
  own — no two pages share an origin, and a reopened page starts empty. No
  preload: the page has no `window.electronAPI`, and `guardIpcMain` (#509)
  would refuse it anyway.
- **A scheme of its own.** `snotra-html:` is registered as standard and
  secure before the app is ready, but handled only in the preview's session.
  The URL carries the file's **absolute** path, so `../../..` or `/etc/x`
  resolve to paths outside the folder and are refused by name — a URL rooted
  at the folder would clamp them to it without a word. Each file goes through
  `readWorkspaceFile`, the same check as images and PDFs (inside the folder
  lexically and after `realpath`, a regular file, a size limit), and comes
  with a content type from a fixed table and `X-Content-Type-Options:
  nosniff`. A root-relative `/style.css` therefore means the disk's root, not
  the folder's, and is refused: a page that wants its stylesheet writes it
  relative.
- **No network.** `webRequest.onBeforeRequest` cancels every request that is
  not `snotra-html:`, `data:`, `blob:` or `about:` and records it for the
  notice — fonts, scripts, images, `fetch`, beacons, WebSockets. What does
  not pass `webRequest` (WebRTC, a preconnect) meets a proxy that leads
  nowhere and the `disable_non_proxied_udp` WebRTC policy. The spell checker
  is off, since it would fetch dictionaries. Every permission is refused, and
  so is every download.
- **Links after a click only.** Popups are always denied. A navigation of the
  main frame never happens inside the view: within a second of a mouse or key
  input (`input-event`, which page script cannot fake), a link to another
  HTML file of the folder is reported to the renderer, which opens it through
  the tree like any other file — the `#fragment` goes along — and a web
  address goes to `shell.openExternal`. Without that input, both are refused
  and listed: `location = 'https://…?' + document.body.innerText` must not
  open a tab. Anchors within the page are the page's own business, and so
  are frames that show the page's own files.
- **What covers it.** A native view paints above everything of the window,
  so the renderer hides it (`setBounds(null)`) while a dialog of the app is
  open — `.modal` and `.add-model-overlay`, watched by a MutationObserver —
  while Source is on show, and while the stage has no room. A ResizeObserver
  and a look every 250 ms follow the stage.
- **Keyboard.** The stage is a Tab stop; its focus is handed to the page.
  Tab inside the page stays the page's; **F6** brings the focus back and on
  to the next element after the stage (Shift+F6: before it). The stage keeps
  2 px of its edge free of the page, so its focus ring stays visible.
- **Changes on disk.** The view keeps no bytes. `update()` and `revalidate()`
  ask main to compare: the page, every file it was served and every file it
  missed are checked by size and mtime, and the page reloads when any of them
  differs. The scroll position is read before and restored after, both in an
  isolated world the page cannot see. A page that does not answer within
  0.5 s — an endless loop — gets its process ended and a fresh one; the app's
  renderer is a different process and stays responsive throughout.
- **States.** An empty file and a file the preview cannot show (too large,
  gone, outside the folder, no folder, no view) say so in the column; Reload
  tries again and Open in browser (`shell.openPath`, HTML files of the folder
  only) still works. A page that hangs or ended says so above the page, with
  a Reload of its own.
- **Chat links.** The sanitizer keeps a chat link to an HTML file — relative,
  absolute, a drive path, a `file:` URL — as `data-workspace-href` with
  `href="#"`; a click opens it in the preview column and brings the column
  back. Every other non-web link still loses its `href`.
- Not included: opening the preview by itself when the agent writes an HTML
  file, a per-page opt-in to the network, printing.

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
  not against the previous state. Only the chat width is set; the workspace fills
  the rest by itself as `flex: 1`. The calculation works the same way in reverse,
  which is why maximising and restoring land back where you were: the share moves
  the chat's remembered width, which stays a linear function of the window width.
  It reaches the prefs only if the chat has a remembered width of its own — the
  width the first start fits to the welcome screen is not one
  ([#637](https://github.com/kkrafft1999/snotra/issues/637)).

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
  column entries belongs in that column. The same action sits in the menu bar
  (issue #381): *File → New Chat* (`CmdOrCtrl+N`; the German Mac menu is called
  *Ablage*, elsewhere *Datei*), a push on `UI_NEW_CHAT` along the same path as
  `UI_TOGGLE_SIDEBAR` — menu item, preload `onNewChat`, renderer. On top of what
  the button does, the renderer brings a hidden chat column back
  (`revealChatPanel`) and puts the focus into the input; while a dialog is open
  the shortcut does nothing, so the chat is never reset out of sight.
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

The rules that hold the four columns together all live in `SidebarResizer.js`:

- **Each column has a remembered width and a width on screen**
  ([#637](https://github.com/kkrafft1999/snotra/issues/637)). The remembered one
  comes from the UI prefs, from the user's last gesture or from what the startup
  set up; the one on screen is derived from it on every pass —
  `clamp(remembered, room)`. A squeeze therefore only ever touches the inline
  width, the result depends on the room alone and not on the way there, and a
  squeezed column grows back as soon as the room returns.
- **The workspace keeps its minimum** (`workspaceMin()`): the configured width of
  the sidebar plus `CONTENT_MIN`, and only for what is currently visible. The
  sidebar goes in with its configured width, not with its minimum — whoever
  dragged it wide wants to see it wide; then the history gives way instead.
- **When it gets too tight, the chat gives way first, then the history, and then
  the history collapses** (`ensureRoomForWorkspace()`). Only as a last resort the
  sidebar stops short of its own width (`maxSidebarWidth()`), so that the content
  pane keeps `CONTENT_MIN` beside a chat at its minimum — which is why End on the
  sidebar divider in a 1,000 px window ends at 538 px and not at 600. The 1 px
  dividers count with the column they resize (`DIVIDER_PX`, `#chat-divider` only
  while the content pane is shown), so the content pane keeps all of its 200 px
  instead of 197. The chat
  yields to the history's remembered width, not to its current one, so the
  history gets its room back first. A history that collapsed for want of room
  unfolds again as soon as it fits beside the chat's minimum. Whoever collapses
  it themselves will not find it back on its own.
- **The room check runs after every change of a column**: a gesture on a
  divider, a window resize in every state (also without content pane or chat),
  the first layout when the resizer is built, and every column shown or hidden.
  For the last, the resizer watches the classes on `#app` with a
  `MutationObserver` instead of relying on each switch in `app.js` and
  `ChatHistoryPanel.js` to call it — that is how the startup, which opens the
  content pane only once the folder is known, used to leave it 140 px.
- **Only what a gesture changed is written**, and only when it moved: a key step
  or a drag writes its own column, a click on a divider without movement, a key
  press at an end position, a squeeze and the startup layout write nothing.
- **The upper bound of the chat** is computed against `#app` and subtracts the
  history width. It now lives only in JS, no longer as a `max-width` in the CSS:
  "what has to be left for tree and content pane after chat and history" is not a
  percentage.
- **One minimum per column.** `SIDEBAR_MIN`, `CHAT_MIN` and `HISTORY_MIN` agree
  with the `min-width` of `#sidebar`, `#chat-panel` and `#chat-history` and with
  the limits in the settings contract, and `DIVIDER_PX` with the width of
  `.pane-divider`; `test/sidebar-resizer-dom.test.js` fails if they drift apart.
  The sidebar's minimum is 180 px — the value the CSS has always
  rendered, while JS and the contract said 150 until #637.

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
written here: what the startup sets up is not a new wish — neither a later
window resize nor a gesture on another divider writes it
([#637](https://github.com/kkrafft1999/snotra/issues/637)).
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
| `test/file-view-host-dom.test.js` | The content pane as host of the file views ([#225](https://github.com/kkrafft1999/snotra/issues/225)): switching and `unmount`, fresh element per mount, fallbacks (binary, too large, empty), `update()` only on changed text, overtaken reads, the tool area, the gate for an editor's unsaved changes |
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
- **Isolation:** its own `--user-data-dir` and a working folder, both created
  via `makeTempDir` in `e2e/helpers/app.mjs`, which removes them when the test
  process ends — also after a failed launch. The settings of the installed app
  remain untouched, and an explicit `--user-data-dir` also switches off the
  one-time migration from the legacy folder; without that, a machine that still
  has "Weyouze Anything" filled every empty test profile with its real chat
  history ([#688](https://github.com/kkrafft1999/snotra/issues/688),
  `e2e/legacy-migration-isolation.test.mjs`).
- **Home folder:** `--user-data-dir` does not move the home folder, and main
  reads global memory, instructions and skills below it. `launchApp` therefore
  sets `HOME` to a temp folder of its own, one per profile so that a restart
  finds the same one. Not on Windows yet: there the home folder comes from
  `USERPROFILE`, and with that moved Electron did not start at all. On macOS only
  `Library/Keychains` links to the real folder, since without the login keychain
  the app would run without safeStorage. A caller can hand over a prepared home
  (`home`), and a script that runs a real program with its real login keeps the
  real one (`home: false`)
  ([#702](https://github.com/kkrafft1999/snotra/issues/702),
  `e2e/home-isolation.test.mjs`).
- **Model:** `e2e/helpers/fake-model.mjs`, a small OpenAI-compatible SSE server.
  An `openai-compatible` entry points there via its connection's `baseUrl` — no
  API key, no network, and the stream can be slowed down in order to abort it.
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

The system prompt is assembled per request from seven building blocks
(`application/chat/chat-engine.js`), in this order:

1. **Base prompt** from the settings — it stands first and keeps precedence.
2. **The user's memory** (`application/chat/memory-prompt.js`,
   [#166](https://github.com/kkrafft1999/snotra/issues/166)) — `~/.snotra/memory.md`.
   It stands directly behind the base prompt, because it is the same thing: what
   the user said themselves, only across several conversations — nothing foreign
   should push itself in between. The folder's memory is block 6. At most 8,000 characters per level
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
   issue #212, sharpened in #253 and #432) — the `AGENTS.md` files from
   the `<workspace>` root, `~/.snotra` and `~/.agents`, all existing ones
   concatenated. They **complement one another and apply jointly**; none beats
   another, so the order is a reading order and not a precedence. It is the same
   source list as for skills (#251) — two orderings that would have to be learned
   separately would cost more than the one alignment. Within the project only
   the root-level file counts, where most repositories keep it (#432 reversed
   the `.agents/`-only rule of #253); `<workspace>/.agents/AGENTS.md` is not read. At most 20,000 characters
   per file (`MAX_PROJECT_INSTRUCTION_CHARS`, the same limit as for skill
   bodies), oversized content is visibly truncated rather than discarded, and each
   file gets its own line in the context breakdown (#174). Can be switched off via
   "`AGENTS.md` mitschicken" (Send `AGENTS.md`) in the settings (on by default).
6. **The folder's memory** (`<workspace>/.agents/memory.md`, #529) — it lives in
   the opened folder like its `AGENTS.md`, where a teammate or a cloned
   repository can have put it. It is therefore introduced by its origin ("notes
   kept in this folder"), not as the user's own words, and stands with the
   project instructions rather than with the user's memory.
7. **Folder/tool block** (`buildWorkspaceSystemPrompt`, otherwise
   `buildNoWorkspaceSystemPrompt`) — the open folder, tool descriptions, the tree
   selection and the rule that tool results are data.

Behind them, whenever the app contributes English scaffolding of its own (the
folder/tool block or the skill frame), comes one sentence: reply in the
language the user writes in, unless the instructions above say otherwise
(`REPLY_LANGUAGE_RULE`, #276).

Skills, `AGENTS.md` and both memory files are **embedded without being asked
for**, so they pass the secret protection of a tool result before they go out
(`application/chat/embedded-text-guard.js`, #528): a text that contains an own
secret is replaced by a short notice, credential patterns are masked, and a
text too large to scan is left out. The context breakdown marks the row.

The order of the project instructions, the folder's memory and the folder/tool
block is deliberate: the content of an `AGENTS.md` is
**instruction, not data** — unlike tool results, for which
`TOOL_RESULTS_ARE_DATA_RULE` applies. It is meant to change the model's
behaviour, otherwise it would be pointless; that is defensible because the user
opened the folder themselves. Precisely for that reason it stands **before** the
folder/tool block and not after it: the rule that tool results are data should not
be the last thing a foreign instruction file could overwrite. The emergency brake
is the switch, not the placement.

### Baseline equipment of the tools

Principle since [#180](https://github.com/kkrafft1999/snotra/issues/180): what is
switched on in Settings › Security goes to the model — and vice versa. Otherwise a schema costs
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

## Interface language

The interface speaks English **or** German. It is switched in Settings >
General, and the switch takes effect at once — no restart
([#277](https://github.com/kkrafft1999/snotra/issues/277)).

This does not mean the channel to the model. System prompt, tool schemas and
tool results have been English throughout since
[#276](https://github.com/kkrafft1999/snotra/issues/276) and stay that way
whatever the user picks; `test/model-prompt-language.test.js` guards the line.
Anyone who writes a translation and turns that test red has edited the wrong
half.

Per the project language rule
([`.claude/rules/language.md`](../.claude/rules/language.md)), **English is the
source version and German is derived from it** — and both are held to the same
standard. A German string that lags behind its English original is a defect.

### One catalogue for all three layers

`src/shared/i18n/` is CommonJS and therefore belongs to main **and** renderer,
just like the contracts next to it:

- `messages/en.js` and `messages/de.js` — flat catalogues with dotted keys
  (`settings.general.locale.label`).
- `index.js` — `translate(locale, key, params)`, `translatePlural(…)` and
  `createTranslator(locale)`. Placeholders look like `{name}`; plurals use the
  suffixes `.one` / `.other`.

The renderer loads native ESM and cannot import CommonJS directly.
`scripts/sync-renderer-vendor.js` therefore builds an ESM bundle into
`src/renderer/generated/i18n.js` — exactly as it does for the contract layer.
There is no second, diverging copy of the strings.

When a key is missing, the default locale answers first and the key itself
last. Visibly wrong beats silently German: a German sentence in an English
interface goes unnoticed, `settings.title` does not. That it never gets that
far is what `test/i18n-keys.test.js` is for — both languages carry the same
keys and the same placeholders, and every key used in the code exists.

### Contracts: errors carry a key, not a sentence

The contract layer is the one that belongs to both sides, and the two do not
agree on a language: a validation error arises where the file is written and is
read where the interface lives. So a contract answers with the *key* and the
values that fill it — `createMessage('mcp.error.idMissing')`,
`createMessage('mcp.error.idTooLong', { max: 64 })` — and the side that shows it
looks the sentence up with `tMessage()` / `translateMessage()`. Decided in
[#293](https://github.com/kkrafft1999/snotra/issues/293).

The alternative was to let the contract translate for itself: `src/shared/i18n`
sits right next to it and is CommonJS as well. It was turned down because the
active language does not live in the contract layer — it would have to be
threaded through every validator — and because a sentence chosen at the far end
of the IPC hop freezes: switch the language while the error is still on screen
and it stays in the old one. A key does not freeze.

The shape lives in `src/shared/contracts/message.js` rather than in the
catalogue, so that a contract never has to require `src/shared/i18n` — the two
modules would otherwise require each other in a circle. Where a reason is
already an enumerated value, the contract keeps a **table of keys** instead
(`PERMISSION_DENIED_MESSAGE_KEYS`, `WORKSPACE_IMAGE_ERROR_MESSAGE_KEYS`,
`MEMORY_SCOPE_LABEL_KEYS`, `SKILL_SOURCE_LABEL_KEYS`); `test/i18n-keys.test.js`
walks those tables, since a table is invisible to its scan for `t('…')`
literals.

A message may carry another one as a parameter. `resolveKeyParams` translates
it first, so a sentence that wraps a reason — "{reason} The other settings have
been saved." — reads in one language from end to end
([#308](https://github.com/kkrafft1999/snotra/issues/308)).

`tMessage()` still passes plain text through untouched, but since #308 plain
text is only ever **quoted material**: the error text of a provider's API, what
the network layer said (`fetch failed (ECONNREFUSED …)`), an exception from a
third-party library. Snotra's own sentences — the settings handlers'
`createSettingsError`, the provider adapters, `formatRoundError` — all travel as
keys. `createSettingsError` and `createListModelsResult` pass a descriptor
through instead of stringifying it.

The main process follows the same line
([#353](https://github.com/kkrafft1999/snotra/issues/353)). What it hands to the
renderer — the update chain's reasons and errors, link and clipboard failures,
skill reasons, a skipped MCP tool — is a descriptor; an error that is *thrown*
on the way, as in `update-installer.js`, carries one as `userMessage` and keeps
an English `message` for the log. The file tree side of `fs-service.js` is the
older exception: it words its errors in main, per call, from `getLocale`. What
main draws itself — native dialogs, the menu — is worded there, in the language
of the moment it opens.

The messages the **model** reads (`http-url-fetch-adapter.js`, `mcp-adapter.js`,
the fallback in `describeFetchError`) are deliberately not on this side of the
line. They are a [#276](https://github.com/kkrafft1999/snotra/issues/276) matter
and become English, not bilingual.

### Provider definitions speak through the catalogue

A provider definition (`src/main/providers/*.js`) may give its name, hints,
option labels and templates as `createMessage(key)` instead of a string. The
name matters most, because "Ollama (local)" carries a word
([#310](https://github.com/kkrafft1999/snotra/issues/310)). Proper nouns
("OpenAI", "LM Studio", "low") stay plain strings.

The two readers handle it differently. The **settings presentation** builds the
provider views in the stored language, following the tool catalogue (#291):
`buildLlmStateDto({ locale })` hands a translator to the view builders in
`src/shared/contracts/settings.js` (their `say` parameter). The renderer
therefore gets finished text and fetches the state again on a language change.
**Messages that name a provider** — "No API key stored for {provider}." — take
the name as it is. When the name is a descriptor, `resolveKeyParams` translates
it together with the sentence around it (#308).

The chat run itself came over in
[#306](https://github.com/kkrafft1999/snotra/issues/306): every error
`createChatErrorResult` writes is a descriptor now, and `ChatStream` puts it
into words the moment the result arrives. An error bubble is a record of a run
that has ended, like the conversation around it, so it keeps the language it was
shown in — what comes after a language change comes in the new one.

The context breakdown came over in
[#290](https://github.com/kkrafft1999/snotra/issues/290):
a part names its heading with `labelKey` and its second line with `detailKey`
plus the `params` that fill it, so that "3 schemas" is counted where it is known
and worded where it is shown.

**A parameter can be a key itself.** The permission planner knows *which* mode
and *which* risk classes belong in a sentence, but not what they are called in
the language the card is being read in. By convention it names such a parameter
`…Key` (one) or `…Keys` (several) — `createMessage('approval.reason.write',
{ modeKey: 'permissions.mode.smart' })` — and `translateMessage()` looks them up
before it interpolates, putting the result in under the bare name. The catalogue
entry only ever sees `{mode}` or `{effect}`.

The model-facing wording is a separate thing and stays English
(`PERMISSION_DENIED_TOOL_RESULT_MESSAGES`, `MEMORY_SCOPE_PROMPT_LABELS`,
issue #276) — it never goes through the catalogue.

### The chat: written when it is shown, not when it happens

The chat surface is built at runtime from beginning to end — there is no markup
for `data-i18n` to reach. So it goes through `t()` and repaints on
`onLocaleChange`: `ChatStream` (greeting, token figure, send button,
attachments), `ToolApprovalCard`, `ChatModelPicker`, `ToolModePicker` and the
token breakdown panel. The approval card is rebuilt from the entry the queue
still holds, so a resolved card keeps its outcome and a decision already on its
way keeps its buttons locked ([#290](https://github.com/kkrafft1999/snotra/issues/290)).

The **tool lines** are the one thing a language change does not touch. They are
written by `src/shared/presentation/tool-display.js` in the main process, from
the locale the chat engine hands it, and they reach the renderer as finished
text — a trace entry keeps its `line`, not the arguments it was made from. A
line already in the log is a record of something that happened, like the
conversation around it; what comes after the switch comes in the new language.

The locale reaches that formatter through
`createChatPreferencesAdapter` → `uiPrefs.appLocale` → `resolveAppLocale`. The
adapter is the whole path: anything it does not copy out of the stored
preferences is invisible to the chat core, which is exactly how the language sat
unused there between #289 and #290.

Number formatting follows the interface language as well, not the machine's: a
thousands separator is a dot in German and a comma in English, and the percent
sign takes a space on one side of the border and not on the other.

### Model-facing text quotes the interface

What goes to the model is English and stays English (#276). But some of those
sentences **name something the user has to find** — "the user can enable it
under …". A fixed German quotation inside an English sentence pointed at a page
that does not exist once the interface was switchable, so since
[#294](https://github.com/kkrafft1999/snotra/issues/294) the quotation follows
`appLocale` while the sentence around it does not.

`src/shared/i18n/ui-quotes.js` holds two placeholders, both resolved from the
**same catalogue entries the interface renders**:

| Placeholder | Yields |
| --- | --- |
| `{menu:settings.tools}` | `Settings › Tools` / `Einstellungen › Tools` — assembled from the navigation's own keys |
| `{label:permissions.mode.smart}` | `Smart` / `Intelligent` — one entry, quoted as it stands |

A path is never written out as its own string. `test/ui-quotes.test.js` checks
every key a path is built from against the `data-i18n` attributes of
`index.html`: rename a settings page and the quotation moves with it, and a
second list kept alongside would fail the test rather than drift.

**Filled where the app wrote the sentence, not at the door to the model.** The
tempting shortcut — substituting in every tool result on its way out — would
also rewrite file content a tool just read, and tool results are data. So the
four places that write such a sentence fill it themselves:

- the denial result (`permissionDenied` in `chat-engine`),
- the two errors the tool registry writes (`context.locale`),
- the memory adapter (`getLocale`, read fresh per call like the self-memory
  switch next to it),
- a **system** skill's instructions, on the one path they reach the model:
  `load_skill`. A folder skill is somebody else's text and is passed through
  exactly as written — rewriting it would be the same mistake as following an
  instruction found inside it.

`skills-service` fills the placeholder on the way out rather than when the file
is read, so the scan cache keeps the raw text and a language change costs
nothing.

### Model channel or user channel?

Every message the app writes belongs to exactly one of two channels, and the
channel decides the language: **the model channel is English, the user channel
is bilingual**. Which one a sentence is on is not always visible where it is
written — the web search looked like interface text in #306 and went to the
model, and tool *errors* stayed German until
[#309](https://github.com/kkrafft1999/snotra/issues/309) for the same reason. So
the question is answered by following the value, not by reading the sentence:

- **Model channel** — anything that ends up in a tool result: the JSON a tool
  handler returns (`error`, `note`, `hint`, `…_skipped`, truncation markers),
  the plan errors of `tool-call-planner` (they become the `message` of the
  denial result), and what the adapters behind a handler hand back
  (`fs-service`'s `run…Tool` functions, `http-url-fetch-adapter`,
  `mcp-adapter`). Plain English strings; `{menu:…}` / `{label:…}` only where a
  settings page or a mode is named.
- **User channel** — anything that reaches the renderer: IPC results,
  `createSettingsError`, approval cards and their previews, progress lines,
  Settings panels (a skipped MCP tool's `reason`, for example). Catalogue keys
  via `t()` / `createMessage()`, never a fixed sentence.
- **Neither** — programming errors thrown at construction time and console
  lines. Developer-facing, English as they are touched (#278).

Two tells when it is unclear: a function whose name starts with `run…Tool` or
that is called from a tool `handler` answers the model; a function that
translates (`t`, `ui()`, `createMessage`) answers the user. A locale on its own
is no tell — the model channel reads one too, to fill `{menu:…}`. When a string is
reachable from **both** — `fs-service`'s workspace path labels are resolved
by tool paths and by the IPC boundary of the file tree alike — it is neither
translated nor keyed in place: the two callers get separate messages first.
Until then it is listed as an exception in `test/model-prompt-language.test.js`,
which scans the model-channel files for German literals and drives their error
paths; an exception that no longer matches fails the test.

### Renderer: markup declaratively, built nodes by callback

`src/renderer/i18n.js` holds the active locale and knows three routes:

| Case | Means |
| --- | --- |
| Static markup | `data-i18n="key"` (text), `data-i18n-html="key"` (with `<strong>`/`<code>`), `data-i18n-attr="title:key;aria-label:key"` |
| Nodes built at runtime | `t('key', params)` or `tPlural('key', n)` |
| Components with state of their own | `onLocaleChange(() => …)` and redraw themselves |

`index.html` carries the **English** strings in its source — the default should
already be right before the first line of JavaScript runs. `setLocale()` sets
`lang` on `<html>`, walks the document once and only then notifies subscribers.

`data-i18n-html` assigns `innerHTML` and is therefore reserved for the
catalogues: those values live in the app's own source, never in an input.
Anything coming from a file, a model answer or a text field still goes through
`textContent`.

### Main process: a remembered locale and a rebuilt menu

The menu bar and the context menu are built **synchronously**; an `await` on
the preferences would mean a menu opening without labels. `create-application`
therefore keeps the locale in memory (the same construction as the web search
key) and hands `getAppLocale()` around. The language saves the moment it is
picked in *Settings › General*, not on Apply (#297). A change runs like this:

```
Renderer: language picked -> setUIPrefs({ appLocale })
  -> settings-handlers writes appLocale
  -> onAppLocaleChanged -> create-application remembers the locale
                        -> main/index.js rebuilds the menu bar
  -> Renderer: once the stored value comes back, setLocale() redraws the interface
```

Electron cannot rename a menu item after the fact — the menu is set anew as a
whole on every change. The file tree's context menu needs none of this: it
lives only until the click and reads the locale as it opens.

### English by default, existing installations stay German

`normalizeUiPrefs` falls back to `en`. An **existing** `ui-preferences.json`
without `appLocale`, however, comes from a time when there was only German;
`storage-service.readUIPrefs` slips `de` in before normalising. A missing
*file* means a new installation and therefore English, a missing *field* means
an existing one. The addition happens on every read and needs no migration step
of its own.

## Further functional modules

The skill system ([#18](https://github.com/kkrafft1999/snotra/issues/18)) is
built on this structure: discovery and parsing in the main service, selection and
system-prompt assembly in the core, catalogue and toggles over the existing
settings channels. Extended tool sets and use-case profiles are **not** part of
the completed architecture stages — they build on it as well and are tracked as
[GitHub issues](https://github.com/kkrafft1999/snotra/issues).
