# Snotra AI

**An open-source desktop agent built around your folder: always in view, and
nothing happens in it without asking. Cloud or local models, no account, no
telemetry.**

[**Download**](https://github.com/kkrafft1999/snotra/releases/latest) ·
[Website](https://snotra-ai.dev) ·
[Why Snotra?](#why-snotra) ·
[Build from source](#build-from-source) ·
[Deutsch](./README.de.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/demo-dark.gif">
  <img src="assets/readme/demo-light.gif" width="880"
       alt="Snotra reads a project folder, asks before it writes ARCHITECTURE.md, and the new file appears in the tree.">
</picture>

**Works with** OpenAI · Anthropic · Google Gemini · Ollama · any
OpenAI-compatible API (LM Studio, MLX-LM, llama.cpp, vLLM, OpenRouter …)

**Extensible with** Agent Skills (`SKILL.md`) · MCP servers (stdio) · built-in
workspace tools · any CLI on your machine

**Runs on** macOS (Apple Silicon) · Windows (x64) · Linux (x64)

> Status: a personal open-source project — no company behind it, no paid tier.
> Interfaces and configuration may still change.

## How it behaves

- **The folder is the workspace.** You open one folder; the file tree stays in
  view, and the chat works inside it. Files the agent writes show up as it
  writes them.
- **It asks before it acts.** In the default mode, *Smart*, reading runs without
  asking; changing a file or touching a sensitive one asks first. Running
  commands is switched off until you switch it on, and then every command gets
  its own approval card.
- **Auto is your decision, not the default.** The *Auto* mode drops the
  questions — workspace boundaries, blocks and the protection of Snotra's own
  keys stay. You switch it on deliberately.
- **Your models, your keys.** Cloud and local models sit side by side in one
  list; you switch per conversation. Keys are stored with the operating
  system's encryption.
- **Nothing phones home.** No account, no server of ours, no telemetry — not
  even opt-in.

## Download

Get the latest release from the
[releases page](https://github.com/kkrafft1999/snotra/releases/latest):

| System | File |
| --- | --- |
| macOS (Apple Silicon) | `Snotra-AI-<version>-mac-arm64.dmg` |
| Windows (x64) | `Snotra-AI-<version>-win-x64.zip` |
| Linux (x64) | `.deb` (recommended), `.AppImage` or `.tar.gz` — see [Installing on Linux](#installing-on-linux) |

**The builds are not signed yet**
([#19](https://github.com/kkrafft1999/snotra/issues/19)), so macOS and Windows
warn you on first launch:

- **macOS:** open the DMG and drag the app into Applications. Launch it and
  dismiss the warning, then *System Settings › Privacy & Security › Open
  Anyway*. If that option is missing or doesn't help, remove the quarantine
  flag by hand:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Snotra AI.app"
  ```

- **Windows:** unzip, start `Snotra AI.exe`, then *SmartScreen › More info ›
  Run anyway*.

## Why Snotra?

Open source, any model, MCP and Skills are what every agent desktop offers by
now. What Snotra does differently is how it works in your folder and how
carefully it acts there. Compared as of September 2026 — the field moves fast,
corrections welcome.

- **Goose** — the closest open-source match, and a good tool. Goose runs
  autonomously by default; Snotra starts with command execution switched off
  and asks before every command. There is no session-wide "allow" for
  commands, unless you switch the whole app to *Auto*. Goose's usage data is
  opt-in; Snotra has none to opt into.
- **Claude Desktop / ChatGPT desktop** — polished, and they sandbox well. But
  they require an account and a subscription, they are tied to one vendor, and
  local models are an afterthought.
- **LM Studio (Bionic)** — excellent for running local models, with native
  MLX. But the agent is closed source, and its cloud is LM Studio's own, so
  there are no OpenAI, Anthropic or Google models. Snotra uses LM Studio as
  one provider among several and treats cloud and local models the same.
- **Jan** — open source and local-first. Its folder agent and its sandbox are
  in nightly/preview builds; the stable app is a chat client with MCP.
- **Cherry Studio** — very feature-rich and close in scope. Analytics are on by
  default, and it documents no sandbox for agent commands.
- **AnythingLLM** — built for chatting with your documents (RAG). Its skills
  are NodeJS code, not text files, and it has no shell tool.
- **Open WebUI / LibreChat** — self-hosted web apps with logins and Docker: a
  server for a team, not a desktop agent working in your folder.
- **Msty** — closed source. Its agent mode wraps cloud coding CLIs rather than
  running its own agent on your models.
- **VS Code + Copilot/Cline, Cursor** — they have the file tree because they
  are code editors. Snotra keeps the folder in view without being an IDE, for
  work that isn't code.

What Snotra doesn't have yet: signed builds
([#19](https://github.com/kkrafft1999/snotra/issues/19)), a sandbox for commands
([#329](https://github.com/kkrafft1999/snotra/issues/329)), MCP over HTTP.

## Motivation

*A word from the author.*

I started out wanting to **understand agentic work** — agentic coding, and AI
agents in general. So I began with a simple experiment: running chats in order to
reproduce the exchange of information between a language model and a local
client, the way ChatGPT or Claude Code do it, just to see for myself what
actually travels between an LLM and an agent harness.

Somewhere along the way the experiment became the fun part. Trying out the
variants and giving Snotra one more capability turned out to be something I
enjoy, and that is largely why it kept growing.

The role models are obvious: **Cursor, Claude Code, ChatGPT** all take the same
approach. What they share is that they concentrate on their own models — with
Cursor as the exception, and even Cursor is likely to end up more firmly in the
hands of xAI, so models from that side can be expected to be favoured there too.
An agent harness, an agent desktop, that lets you attach **any model you like** —
and above all local models, to experiment with — is the thing that kept me
working on this.

And last but not least: I wanted Snotra to be a tool developers can use to try
out agentic working for themselves, and to use this open-source foundation to
build agents for **specific use cases** — for business departments in a corporate
setting, and just as much for private, consumer-side purposes — on top of
Snotra's agent harness. The architecture is cut so that the backend can be
separated from the frontend. What else can be made of that, I happily leave to
the developer community and its imagination.

The name comes from Norse mythology: Snotra is the goddess of wisdom and
prudence. It stands for an assistant that knows the context of its workspace
and acts deliberately.

## Current state & planning

Everything that is due — bugs, individual features and larger topics — runs
through [GitHub Issues](https://github.com/kkrafft1999/snotra/issues). Progress
is tracked on the associated
[GitHub Project](https://github.com/kkrafft1999/snotra/projects) (Kanban board:
*Backlog* → *Ready* → *In progress* → *In review* → *Done*).

Want to contribute? See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Tech stack

- [Electron](https://www.electronjs.org/) (main + renderer + preload)
- [Electron Forge](https://www.electronforge.io/) for packaging and makers (DMG / ZIP / DEB / AppImage)
- Vanilla JS in the renderer plus [`marked`](https://github.com/markedjs/marked) and [`DOMPurify`](https://github.com/cure53/DOMPurify) for Markdown
- [`@fontsource/inter`](https://fontsource.org/fonts/inter) as the typeface

## Requirements

- **Node.js** ≥ 24 (Active LTS, see `.nvmrc`; with nvm: `nvm use`)
- **npm** (ships with Node)
- macOS, Windows or Linux
- Optional: an API key for OpenAI / Anthropic / Google, a local
  [Ollama](https://ollama.com/), or any other server with an OpenAI-compatible
  interface (LM Studio, llama.cpp, vLLM, OpenRouter, a corporate gateway — see
  [Providers](#providers))

## Build from source

```bash
# Clone the repository
git clone git@github.com:<your-user>/snotra.git
cd snotra

# Install dependencies
npm install

# Start the app in development mode
npm start
```

On first start you can pick a provider in the settings and enter your API key.
The key is stored encrypted in your operating system's user profile — it does
**not** end up in the project folder or in the repository.

## Building / packaging the app

```bash
# macOS (Apple Silicon) – DMG + ZIP
npm run make

# Linux (x64) – DEB + AppImage; needs dpkg, fakeroot and mksquashfs
npm run make:linux

# Package only, without installers
npm run package         # macOS arm64
npm run package:win     # Windows x64
npm run package:linux   # Linux x64
```

The finished artifacts land in `out/` (excluded via `.gitignore`).

### Installing on Linux

The [releases](https://github.com/kkrafft1999/snotra/releases) contain three
files for Linux:

```bash
# Recommended (Debian, Ubuntu, Mint, Pop!_OS …): creates a menu entry and icon
sudo apt install ./Snotra-AI-<version>-linux-x64.deb

# Distribution-independent: one file, no root needed
chmod +x Snotra-AI-<version>-linux-x64.AppImage
./Snotra-AI-<version>-linux-x64.AppImage

# Fallback if neither fits
tar -xzf Snotra-AI-<version>-linux-x64.tar.gz
cd snotra-ai-<version>-linux-x64
./"Snotra AI"
```

The `.deb` is the recommended route: it is the only variant in which the
Chromium sandbox comes fully set up (setuid bit on `chrome-sandbox`), and it
registers the app in the application menu. The **AppImage** needs neither
installation nor root privileges — make it executable once after downloading;
the execute bit does not survive the trip through a browser.

**AppImage and tarball** rely on unprivileged user namespaces instead. On
distributions that restrict these — Ubuntu 24.04 and later among them — startup
can fail. With the **tarball** this shows up as *"The SUID sandbox helper binary
was found, but is not configured correctly"*; there it helps to fix things up
once inside the extracted folder:

```bash
cd snotra-ai-<version>-linux-x64
sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
```

With the **AppImage** this route leads nowhere: the image is mounted read-only
and `nosuid`, so a setuid bit inside it would have no effect. There, the `.deb`
is the answer.

The `.deb` also pulls in `bubblewrap`, `socat` and `ripgrep`, which the sandbox
for shell commands and Python needs (see [The sandbox per operating
system](#the-sandbox-per-operating-system)). With the AppImage or the tarball,
install them yourself: `sudo apt install bubblewrap socat ripgrep`.

## Updating

Snotra AI quietly checks for a newer version at startup and only speaks up if
there is one; *Help › Check for Updates…* — or *Check for updates* next to the
version number at the bottom of the settings — asks manually at any time. From
there a dialog walks through the whole path — **each step confirmed
individually, each one cancellable until the very end**:

1. **Found.** Version, package size and "What has changed". "Download" starts
   the download, "Skip this version" never offers this exact version again,
   "Remind me later" asks again on the next start.
2. **Downloading.** Progress in percent and megabytes. "Cancel" really aborts
   the download and clears away the half-written file.
3. **Ready.** Only now does it ask whether to install. On install the app quits,
   is replaced and restarts — unsent input is lost in the process. "Cancel"
   discards the downloaded file.
4. **Installing.** The only step without a way back; the dialog says so.

Only the release asset that GitHub itself designates for the running
installation is downloaded — the address never comes out of the window. Before
replacing anything, the app additionally verifies the bundle identifier and the
version number inside the downloaded package on macOS. If anything fails, the
running version stays untouched and the dialog names the reason.

**When the app does not update itself.** The dialog then explains why and points
to the release page:

| Case | Reason |
| --- | --- |
| Installed as `.deb` into `/opt` | Replacing it would need administrator rights. |
| No write permission at the install location | e.g. `C:\Program Files` or a multi-user Mac. |
| Development build (`npm start`) | There is nothing to replace. |
| No matching package in the release | Better to offer nothing than to install the wrong thing. |

What *can* update itself: the macOS app bundle, the Windows directory, a running
AppImage and an extracted Linux directory.

Because the artifacts are **unsigned**, `electron-updater` and Squirrel are
deliberately not used — both require a code signature.

## File tree

- **Open a project folder:** via the button in the sidebar or the list of
  recently used folders. Everything that follows always refers to this one
  folder.
- **Four columns, four switches:** the window consists of sidebar, content pane,
  chat and history, and each column has its own switch in the title bar — on the
  left the two belonging to the workspace, on the right, mirrored, the two
  belonging to the chat side, each in the order of their columns. All four carry
  the same image: a window with one narrow and one wide area, with the area the
  button controls filled in. Each state survives until the next start.
- **Hiding the sidebar:** the first button hides the sidebar together with its
  divider, and the workspace moves over. The same via keyboard with
  `Cmd/Ctrl+B` or through *View › Toggle Sidebar* (all shortcuts under
  [Keyboard shortcuts](#keyboard-shortcuts)).
- **Showing and hiding the middle pane:** the second button toggles the middle
  column — the one holding the file preview and the welcome screen. As long as
  you have not set anything, the folder decides: with a folder open the column
  stays **closed** and the chat gets the width. With no folder open, the welcome
  screen sits there, exactly as wide as it needs to be — the rest of the window
  belongs to the chat. Clicking a file in the tree brings the column back by
  itself, otherwise the click would go nowhere. Once you toggle it with the
  button, your decision also applies at startup.
- **Hiding the chat:** the second-to-last button takes away the chat column;
  what remains on the right is the history, if it is open. Clicking a chat there
  brings the column back by itself — the mirror image of clicking a file in the
  tree. The **settings** are reachable independently through the menu bar or
  `Cmd/Ctrl+,` — on macOS under *Snotra AI › Settings…*, on Windows and Linux
  under *View › Settings…*.
- **Showing the chat history:** the last button places the history as a column
  next to the chat. Clicking a row loads that conversation along with its model
  and its permission mode; the trash icon removes it. The button for a **new
  chat** sits in the header of that column — just like "Open folder" sits in
  the header of the tree. If the window becomes too narrow for
  all columns, the history gives way by itself and returns in a wider window.
- **Just as you left it:** at startup Snotra brings back the folder's most
  recent conversation and you land straight in the discussion. The welcome
  screen ("Where shall we start?") belongs to the
  cold start: it sits in the middle column and appears when no folder is open
  and there is nothing to continue — so on the very first start it appears by
  itself. The window also comes back the way you last set it: size, position and
  whether it was maximised or in full screen. On the very first start it opens
  at 1536 × 960 points, and on smaller screens as large as the work area allows.
  If you have unplugged the second monitor it last sat on, it comes back at the
  same size, centred on the primary display, instead of into the void.
- **Moving:** dragging a file or folder in the tree onto a folder row moves the
  entry there; dropping it on the free area below the tree puts it in the project
  folder. If the name already exists, it becomes `name (2).ext`.
- **Referencing in chat:** dragging a file or folder into the chat input inserts
  `@<path relative to the project root>` there; the same thing without dragging
  is the `@` button on the right of the row (hover or Tab). Details under
  [Chat](#chat).
- **Context menu:** a right-click (or ⌘/Ctrl-click, see
  [Keyboard shortcuts](#keyboard-shortcuts)) on a row opens "Open",
  "Reveal in Finder" ("Show in Explorer" on Windows, "Show in file manager" on
  Linux), "Information" and "Delete…". Deleting moves to the trash, after
  a confirmation.
- **Information:** the "Information" entry shows a file's name, full path, type,
  size (human-readable and to the byte), modification and creation date, plus the
  program "Open" would launch it with. For a folder, the number of its direct
  entries takes the place of the size — counting recursively is deliberately not
  done, as that can take arbitrarily long on `node_modules`. The **"Copy path"**
  button puts the full path on the clipboard. Values the operating system does
  not provide — under Linux often the creation date — show up as "unknown".
- **Taking things in from outside:** files and folders can be dragged straight
  from Finder or Explorer into the tree — onto a folder row, or onto the free
  area for the project folder. They are **copied**, the original stays put;
  multiple selection works, and name collisions end up as `name (2).ext` as
  above.

  Because this is the first time something from outside the project folder comes
  in, Snotra asks first: always for folders, and for files from 20 items or 10 MB
  on — stating count, size and target folder in plain words, with "Cancel"
  preselected. Files that look like credentials (`.env`, `*.pem`, `id_*`,
  anything under `.ssh/` …) are not taken in: what the model could later read
  should not slip in casually via a drop — the route through the file manager
  stays open. Symlinks are skipped, and a drop is rejected outright rather than
  half-copied if it exceeds 2000 entries or 200 MB.

## Chat

- **Sending:** `Enter` sends the message, `Shift+Enter` inserts a line break.
  While the model is answering, the send button becomes a stop button. The
  other shortcuts are collected under [Keyboard shortcuts](#keyboard-shortcuts).
- **Referencing files with `@`:** typing `@` in the input opens a list of the
  files and folders of the opened project folder above the text field. Typing
  further filters — fuzzily, too: `@rlse` finds `docs/release.md`, for example.
  `↑`/`↓` selects, `Enter` or `Tab` accepts, `Esc` closes. What gets inserted is
  the path relative to the project root (`@docs/release.md`); for folders the
  list stays open (`@src/`) so you can keep typing into the folder. The list
  hides what the `find_files` tool skips as well: hidden entries, `.git` and
  patterns from the project root's `.gitignore`. With no folder open, `@` stays
  ordinary text.
- **Taking files from the tree (mouse):** what you already have in front of you
  in the file tree, you should not have to retype. Drag the file or folder from
  the tree into the chat input — what gets inserted at the caret position is the
  path **relative to the project root** (`@docs/release.md`, folders with a
  trailing `/`), not the absolute path. Without dragging it works through the `@`
  button that appears on the right of a row as soon as you hover over it or reach
  the button with Tab. A plain click on a row remains what it was: select and
  show the preview; so does moving things in the tree by drag and drop.
- **Pasting screenshots:** an image on the clipboard (macOS `Cmd+Ctrl+Shift+4`,
  Windows Snipping Tool) lands as an attachment above the input line with
  `Cmd/Ctrl+V` — with preview, file size and a button to remove it. The typed
  text stays untouched; a screenshot without an accompanying question can be sent
  as well. PNG, JPEG, GIF and WebP are allowed, up to 4 images per message and
  5 MB per image; larger images are scaled down to 1568 px on the longest edge
  before sending. Because a screenshot often shows more than you consciously
  meant to share, you always see the preview before sending — with a cloud
  provider, the image leaves your machine. Images can be passed on by **OpenAI**
  and, if you set the "Allow image attachments" switch,
  by the **OpenAI-compatible** provider: if another provider is active, pasting
  is rejected with a note in the status line instead of silently vanishing — and
  if you attach an image and then switch to a model without image support,
  Snotra says so when sending, before the request goes out. Attached images are
  part of the saved history: they live as files under
  `chat-attachments/<chat-id>/` in the `userData` folder — unencrypted, just like
  the screenshots on your disk — while the history file only carries the file
  name and stays slim. When you open an older conversation the images are back; a
  click on the thumbnail shows it large. Delete a chat and its images go with it;
  the same applies when it drops out of the history. If a file has been removed by
  hand, a note stands in its place instead of a broken image.
- **Images from the working folder in the answer:** if the model writes an image
  into the project folder — a computed diagram, a plot — and then embeds it in
  its answer (`![Diagram](diagram.png)`), Snotra displays it in the chat, scaled
  to chat width and with the aspect ratio preserved. The **currently open** folder
  applies: relative and absolute paths are resolved against it, and anything
  outside is not loaded — no symlink pointing out of the folder either, and no
  address from the network. PNG, JPEG, GIF and WebP up to 10 MB are displayed,
  recognised by file content rather than extension; SVG stays out for now. When
  it does not work, what stands there is not a broken image but a placeholder
  with the reason ("Image not found", "Outside the working folder", "Image too
  large to show") and the model's alt text. While the answer is still running
  a calm placeholder stands there — the image appears once the message is
  finished, instead of reloading on every chunk of text. If you open an older
  conversation in a different folder, you see placeholders instead of foreign
  images; Snotra never reaches into the earlier folder.
- **What the model sees of it:** only the reference in the text. The system
  prompt explains the `@path` convention; the model reads the file itself when
  needed via the read tools, and contents are not embedded automatically (a token
  budget decision).

- **Running Python (off by default):** after switching it on under Settings ›
  Tools › "Run Python", the model gets the `run_python` tool:
  it writes a Python 3 program, Snotra runs it in the opened project folder and
  returns output, error output and exit code. That way analyses are computed
  instead of guessed — sums over a CSV, unit conversions, data reshaping, testing
  a regex against real examples. Every call is a fresh script; there is no state
  between calls and no `pip install`. Which packages are available is up to you
  via a custom interpreter path (a venv, for example). The interpreter is looked
  up in **your** PATH — Snotra reads it once at startup from your shell profile,
  so that an app launched from Finder also finds the Homebrew, pyenv or asdf
  Python instead of the system Python; subprocesses inside the script
  (`subprocess`) see the same PATH. Which interpreter was found is shown under
  Settings › Tools.

  **This is the riskiest setting in the app — how risky depends on your
  system.** On **macOS and Linux** the code runs in a sandbox: it can write only
  inside the project folder and a temporary folder, cannot read keys, cloud
  credentials or browser data, and reaches the network only for the domains it
  declares, which the approval card lists. It can still *read* your other files.
  On **Windows** there is no sandbox yet: the code runs with your privileges and
  can read and write anywhere, reach the network and start programs. Either way
  the approval comes first: Snotra shows you the complete source before every
  single run, and a pill on the card says whether the run is isolated — "Not
  isolated" in red. There is deliberately no "Allow for this session" for
  execution. If a script runs too long it is terminated after the time limit
  (10 s by default); "Stop" in the chat ends it as well.

- **Running shell commands (off by default):** after switching it on under
  Settings › Tools › "Run shell commands", the model
  gets the `shell_execute` tool: it runs a command in your operating system's
  shell — macOS and Linux in your login shell (zsh, bash, …), Windows in
  PowerShell or `cmd.exe` — and returns output, error output and exit code. That
  makes whatever is already on your machine usable: `git status`, `npm run build`,
  `docker ps`, an installed CLI tool that a skill describes. Because POSIX shells
  start as a **login shell** and Snotra reads your PATH once at startup from the
  profile — interactively, so including `.zshrc` — your usual PATH is there
  (Homebrew, nvm, pyenv), even if you launched the app from Finder. Commands are
  nevertheless not run interactively, so no prompt preamble ends up in the
  output. The working directory is the project folder or a subfolder of it; one
  command per call, no state between two calls (a `cd` only takes effect within
  the same command). Not interactive: there is no terminal, and a waiting prompt
  runs into the time limit (30 s by default, 300 s at most). Which shell was used
  is shown in the result and on the approval card.

  **This is the most far-reaching setting in the app.** On **macOS and Linux**
  every command runs in a sandbox: it writes only inside the project folder and a
  temporary folder (caches such as pip's and npm's are redirected there), cannot
  read keys, cloud credentials or browser data, and reaches the network only for
  the domains on the approval card — `pip install` and `npm install` get their
  registry automatically, anything else the model has to name. On **Windows**
  there is no sandbox yet: a command can do everything you can do yourself in a
  terminal — read and write anywhere, reach the network, install programs. Snotra
  shows you the complete command, the shell, the working directory and whether
  the run is isolated before every single run, and there is deliberately no
  "Allow for this session" for execution. What you can do instead is remember
  one **exact, simple command line** for the open folder — "Always allow this
  command" on the card, confirmed in a system dialog: `git status` then runs
  without asking in *Smart* mode, while `git status --short`, the same command in
  another folder, with other network domains, with chaining, pipes, redirection,
  variables or quotes still asks every time. Blocked are recursive forced
  deletion (`rm -rf` and equivalents), disk operations and rewriting Git history
  — that is an additional safeguard, **not** complete protection, because a
  script or an interpreter in between bypasses any pattern list. In *Auto* mode a
  command runs without asking — isolated, where the sandbox works. "Stop" in the
  chat and the time limit terminate the entire process tree, not just the shell.

- **Web search:** with a stored Tavily key (Settings › Tools › Web search) the
  model gets the `web_search` tool — it returns title, URL and a short excerpt per
  hit, not whole pages. Without a key the tool is not offered at all. The query
  leaves your machine, which is why the tool is classified as an **external
  service**: in *Smart* mode Snotra asks before every search. A free key is
  available at [app.tavily.com](https://app.tavily.com); it is stored encrypted
  like the model keys. The search does not need an open project folder — unlike
  the file tools it is available in an empty chat as well.
- **Reading pages:** what `web_search` finds in the way of addresses, the
  `fetch_url` tool reads in one piece: it retrieves exactly one http(s) address
  and returns the readable text of the page instead of the HTML — shortened,
  without scripts and navigation. Meant for what goes beyond the short excerpt: a
  changelog, a standard, a long error message. This tool is an **external
  service** too and needs no project folder; there is nothing to set up. Local and
  private addresses (`localhost`, home network, cloud metadata) are rejected —
  even when a redirect only leads there — as is anything that is not text: Snotra
  does not fetch PDFs, images or downloads. **The text that is read comes from a
  stranger**: for the model it is material, not an instruction, and every tool
  call after it goes through the approval again.

**Network timeouts:** model listings abort after 15 seconds (cloud) or 30
seconds (local) with an understandable error message, speech transcriptions
after 120 seconds. Ollama always counts as local; for the
"OpenAI-compatible" provider the host of the server URL decides — `localhost`,
`127.0.0.x`, `::1` and `*.local` count as local. The timeouts cover reading the
response as well. Closing the model or settings dialog, as well as switching
provider, aborts a running model query. A transcription can be aborted via the
microphone button; a context switch or hiding the app also discards the voice
input. Late results are no longer inserted.

### The sandbox per operating system

Whether a run is isolated is decided once per app start by a short self-test,
not assumed. Settings › Tools shows the result under each execution tool, and
the approval card shows it on every run.

- **macOS:** built in, nothing to install.
- **Linux:** needs `bubblewrap`, `socat` and `ripgrep`; the `.deb` installs
  them, for the AppImage and the tarball run
  `sudo apt install bubblewrap socat ripgrep`. **Ubuntu 24.04 and later**
  restrict unprivileged user namespaces, and the sandbox cannot start there as
  shipped — the settings say so. Lifting the restriction is a system-wide
  decision and yours to make:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  It lasts until the next reboot; to keep it, put the same line (without
  `sudo sysctl -w`) into a file under `/etc/sysctl.d/`. An AppArmor profile that
  grants `userns` to `bwrap` works as well. Restart Snotra afterwards.
- **Windows:** no sandbox yet. Every run has your full rights, and the card
  says "Not isolated" in red.

**Switching it off for one workspace.** When the sandbox gets in the way of
something legitimate in a project — writing to a sibling repository or to
`~/.config`, `gh` or `terraform` needing the network, an older `pip` in a venv —
you can switch it off for that folder under Settings › Tools › *Sandbox for this
workspace*. It applies to that one folder, never globally and never by default.
You confirm it in a system dialog, and it is stored with your permissions rather
than in the folder, so a checked-out repository cannot switch it off for itself.
From then on the approval card says "Not isolated" with the reason and a link
back to the setting, and the model is told that the run was not isolated. In
"Auto" mode such runs happen without asking; the mode pill in the chat bar turns
red whenever "Auto" would run `shell_execute` or `run_python` without a sandbox —
switched off here, or not available on the system. "Reset workspace rules" and
"Reset all permissions" switch the sandbox back on.

What the sandbox does not do: it does not stop a run from *reading* files
outside the protected locations, and whatever it read can reach a domain the
card allowed. On macOS, tools that verify certificates through the keychain —
`gh`, `terraform` and other Go programs — cannot reach the network inside it.

## Keyboard shortcuts

What Snotra adds on top of the usual system shortcuts. Copy, paste, undo, zoom
and full screen behave as in any other app on your platform and sit in the
*Edit*, *View* and *Window* menus.

**Anywhere in the window**

| What it does | macOS | Windows / Linux |
| --- | --- | --- |
| Open the settings | `Cmd+,` | `Ctrl+,` |
| Show or hide the sidebar | `Cmd+B` | `Ctrl+B` |
| Copy the tool log diagnostics as JSON to the clipboard — useful for a bug report | `Cmd+Shift+D` | `Ctrl+Shift+D` |

**Chat input**

| What it does | macOS | Windows / Linux |
| --- | --- | --- |
| Send the message | `Enter` | `Enter` |
| Insert a line break | `Shift+Enter` | `Shift+Enter` |
| Paste an image from the clipboard as an attachment | `Cmd+V` | `Ctrl+V` |
| In the `@` file list or the `/` skill list: select · accept · close | `↑`/`↓` · `Enter` or `Tab` · `Esc` | `↑`/`↓` · `Enter` or `Tab` · `Esc` |
| Deny the tool approval card that is on screen | `Esc` | `Esc` |

**File tree and columns**

| What it does | macOS | Windows / Linux |
| --- | --- | --- |
| Open the context menu of a row (instead of a right-click) | `Cmd`-click | `Ctrl`-click |
| Recently used folders: open · remove from the list | `Enter` or `Space` · `Delete` or `Backspace` | `Enter` or `Space` · `Delete` or `Backspace` |
| Focused column divider: move it · in larger steps · to its end position | `←`/`→` · `Shift+←`/`→` · `Home`/`End` | `←`/`→` · `Shift+←`/`→` · `Home`/`End` |

**Dialogs and menus**

| What it does | macOS | Windows / Linux |
| --- | --- | --- |
| Settings: move to the previous or next section · to the first or last | `↑`/`↓` or `←`/`→` · `Home`/`End` | `↑`/`↓` or `←`/`→` · `Home`/`End` |
| Close a dialog, a menu or an enlarged image | `Esc` | `Esc` |

## Providers

An **entry in the preference list** (Settings › Models › *Add model*)
connects a provider with a model; in the chat you switch between entries via the
pill next to the input. The chosen model stays with the conversation — a chat
from the history comes back with its own, a new chat starts with the one last
chosen. Five providers are available:

| Provider | Access | Note |
| -------- | ------ | ---- |
| **OpenAI** | API key | Speaks the Responses API; supports images and reasoning levels |
| **Anthropic** | API key | |
| **Google** | API key | |
| **Ollama** | Server URL | Native Ollama API (`/api/tags`, `/api/chat`), not the `/v1` layer |
| **OpenAI-compatible** | Server URL, key optional | Everything else with an OpenAI-shaped interface; **connection per entry**, several targets side by side |

### OpenAI-compatible

For anything that offers an OpenAI-shaped HTTP interface: **LM Studio**,
**MLX-LM** (`mlx_lm.server` on Apple Silicon), **llama.cpp** (`llama-server`),
**vLLM**, an in-house gateway, router services such as **OpenRouter**, Together,
Groq or Fireworks.

**MLX-LM used to be a provider of its own** and is now a template of this one. Existing MLX-LM entries are moved over on the first start after the
update, with nothing to do on your side: same model, same server URL, display
name "MLX-LM", no key.

**The connection belongs to the entry.** Every row of the preference list carries
its own address, its own key and its own name — so a local LM Studio server and a
corporate gateway sit side by side without overwriting each other. For the other
four providers it stays at one configuration per provider: the OpenAI key is
precisely *not* meant to be spread across several rows. The price of that choice
is known — anyone running six OpenRouter models enters the key six times and
changes it in six places.

You edit an existing row via the **pencil icon** in the list (reachable by Tab,
Enter opens it). The dialog is then called *Edit model*, the provider is fixed,
and **Apply changes** replaces the row
instead of creating a new one. Stored keys and headers are preserved as long as
you do not overwrite them or delete them with the trash icon next to them.

At the top of the dialog sits a **template**. It pre-fills the server URL and API
style (LM Studio, MLX-LM, llama.cpp, vLLM, Ollama `/v1`, OpenRouter, "Custom
endpoint"); after that every field is freely editable, and the template itself is
not stored. The fields:

| Field | Meaning |
| ---- | --------- |
| **Server URL** | Root of the API, e.g. `http://localhost:1234/v1`. Required; a trailing slash is stripped |
| **API key** | **Optional.** Leaving it empty means *no* `Authorization` header goes out — the normal case for local servers. With a key: `Authorization: Bearer …` |
| **Display name** | Appears in the chat before the model name ("LM Studio · qwen2.5") and distinguishes the rows from one another. Leave empty for "OpenAI-compatible" |
| **Extra headers** | One `Name: Value` per line, for gateway tokens or tenant headers. Treated like a key: stored encrypted, no longer displayed after saving, never in logs or error messages |
| **API style** | "Chat Completions only" (default, fits almost always) or "Responses, falling back to Chat Completions". Nothing is guessed; on `404`/`405` for `/responses` Snotra falls back exactly once and stays there for the session |
| **Ignore TLS certificate (insecure)** | As with Ollama, only for self-signed or internally signed certificates you trust |
| **Send tools along** | On by default. Turn it off for servers that choke on tool schemas — then it stays plain chat |
| **Allow image attachments** | Off by default. Turn it on only if the model behind it understands images; otherwise attachments are not even offered in the chat |

**Model list:** "Load models" queries `GET {server URL}/models`.
If that fails or the server returns an empty list, that is **not an error** — the
model name can be entered by hand and the entry stays usable; the status line
says why the list stayed empty. A manually entered name remains in place even if
the list loads later after all.

**Local or remote** is decided by the host of the server URL: `localhost`,
`127.0.0.x`, `::1` and `*.local` count as local and get the more generous timeout
for model listing, but the tighter history budget (see `historyCharLimit` below)
— just like Ollama.

## Configuration

Most settings (provider, models, system prompt, language) are maintained
directly in the app under **Settings** — opened via the menu bar
(*Snotra AI › Settings…* on macOS, *View › Settings…* on Windows and Linux) or
`Cmd/Ctrl+,` (see [Keyboard shortcuts](#keyboard-shortcuts)). There is
deliberately no button for it: it used to
sit in the chat header and was therefore gone as soon as you hid the chat column.
Beyond that, a few JSON files live in the user profile (Electron's `userData`
folder: macOS `~/Library/Application Support/Snotra AI`, Windows
`%APPDATA%\Snotra AI`, Linux `~/.config/Snotra AI`), among them
`ui-preferences.json` with the following options:

| Key                | Meaning                                                                   | Default   | Range            |
| ------------------ | ------------------------------------------------------------------------- | --------- | ---------------- |
| `maxToolRounds`    | Maximum tool rounds per chat request (also settable in the app)            | 14        | 1 – 500          |
| `historyCharLimit` | Character budget for the chat history sent to the provider (see below)     | 200,000   | 4,000 – 2,000,000 |

**Migrating from "Weyouze Anything" (up to v1.0.4):** on first start Snotra AI
copies settings, presets, folder history and chat history from the old `userData`
folder; the old folder stays behind unchanged as a backup. On macOS the API keys
have to be entered once more, because the keychain entry of Electron's
`safeStorage` is tied to the app name; the settings then show "enter the key
again". A chat history that can no longer be decrypted as a result is
preserved as `chat-history.json.undecryptable-<timestamp>` instead of being
overwritten.

**History trimming (`historyCharLimit`):** so that long sessions do not run into
the provider's token limit, the history is budgeted per request (heuristic: 1
token ≈ 4 characters). Older messages beyond the budget are dropped, and large
tool outputs from earlier tool rounds (files that were read, for instance) are
shortened to a placeholder. The current question, all user messages in the window
and the tool outputs of the most recent round are always preserved in full.

**What the prompt costs:** below the input field stands the size of the context
window of the last request. Clicking it (or Enter/Space when it has focus)
expands **what it consists of**: every enabled skill individually, the tool
definitions separated into built-in tools and per MCP server, the rest of the
system prompt, and the history. The total is the provider's real figure; the
breakdown of it is estimated from the character count (prose, Markdown and JSON
schemas have different densities, and the divisor differs per provider — one
tokenizer packs JSON more densely than the next) — both of which is stated in the
panel as well. If the provider read part of the prompt from its cache, that
number stands directly below the total; like the total it comes from the provider
and is not an estimate. From a skill row you jump straight to its switch under
**Settings › Skills** to turn it off.

**Tool permissions:** whether a tool call runs is decided by Snotra per call,
based on risk class (`read`, `read-sensitive`, `write`, `delete`, `execute`,
`external`) and mode. You choose the mode in the **chat bar** (the pill next to
the model selection) or under **Settings › Permissions** — both show the same
state. Switching to *Auto* requires a confirmation in a system dialog; the way
back to *Smart* is always possible without asking. The mode belongs to the
conversation: a chat from the history brings its own back, and a **new** chat
always starts at *Smart*. *Auto* also does not survive an app restart — after
startup even an auto chat runs on *Smart* until you explicitly open it from the
history. Mode, deny/allow rules and custom sensitive path patterns live in their
own HMAC-signed file `tool-policy.json` in the `userData` folder (the key
protected via `safeStorage`); if the file is tampered with, Snotra falls back to
*Smart* mode and discards allowances, while denials remain in effect. The
`allowWorkspaceWrite` switch used up to v1.3.1 is gone; both old values map onto
the default mode, and the settings point this out once.

| Mode | Reading | Reading sensitive data, modifying, overwriting irreversibly, executing, external services |
| ----- | ----- | ----- |
| **Smart** (`smart`, default) | runs | asks for approval in the chat |
| **Always ask** (`ask-all`) | asks | asks |
| **Auto** (`auto`) | runs | runs without asking |

Hard boundaries apply in every mode: no escaping the project folder, skill
directories stay read-only, Snotra's `userData` folder is off limits for tools,
and outputs containing one of its own provider keys are held back. Sensitive
paths (`.env*`, `*.pem`, `*.key`, `id_*`, `credentials*`, `secrets*`, `*.p12`,
`*.pfx`, `.netrc`, `.npmrc`, `.pypirc`, the folders `.ssh`, `.aws`, `.gnupg`,
`.kube`) and contents (private-key headers, known token prefixes, credential
assignments, bearer tokens) are detected locally: targeted access needs an
approval, while broad searches and listings omit such entries and only report the
count (`omitted_sensitive`). The concept behind this is written up in
[`docs/security-concept.md`](docs/security-concept.md).

The three write tools (max. 2 MB per file):

| Tool | What for |
| ---- | ----- |
| `write_file_text` | Create a text file or overwrite it completely; missing intermediate folders are created automatically. When overwriting, a copy of the old version goes to the trash first (file name with timestamp); if that does not succeed, the call counts as `delete` and needs its own approval |
| `edit_file` | One targeted replacement in an existing file (`old_string` → `new_string`), without rewriting the whole file |
| `apply_patch` | Several related changes in one call — as a list of replacements in one file, or as a unified diff across several files. All or nothing: if a step or a hunk fails, every affected file stays unchanged. The tool cannot create, delete or rename files |

Access stays strictly limited to the project folder, as with the read tools. In
the chat, the tool line (e.g. "Writing file docs/new.md …") already
appears while the model is still producing the content — not only after the
actual write.

**Approval card:** if a call needs approval, a card appears in the chat
("Confirm change", "Confirm execution" or "Confirm file access") with the tool,
its effect, all target paths, the reason and — for write and execution tools — a
masked preview of the new content, the replacement or the complete command; for
`shell_execute` the card additionally names the detected shell and the working
directory; when overwriting it states whether a copy goes to the trash. For
sensitive files the card names the provider the content would go to. Three
actions: **Allow once**, **Allow for this session** (only for reading, sensitive
reading and ordinary modification; exactly this tool on exactly these targets,
and not in *Always ask* mode) and **Deny**; on a `shell_execute` card the middle
button is **Always allow this command** instead, and the hint below it says what
exactly is remembered — or why the command cannot be. Esc denies, no button is
preselected, and there is no time limit. If chat, workspace, mode or rules
change while a card is open, the request lapses and the run ends visibly
("Request expired"). If you deny, the model receives a `permission_denied`
result; the tool line shows the decision ("· denied", "· blocked") with reason,
class and status as a tooltip — in saved histories too.

**Rule management (Settings › Permissions):** denials and allowances per tool or
risk class with path patterns (`*` within a folder, `**` across subfolders),
kept separately for all workspaces and for the opened workspace; denials always
win, permanent allowances exist only for reading and ordinary modification —
plus the shell commands you remembered from the card, listed under the workspace
with their working folder and deletable one by one — and, like deleting a
denial, they are confirmed in a system dialog. Alongside
that, custom sensitive path patterns and three reset actions with a stated
scope: "Delete session allowances", "Reset workspace rules", "Reset all
permissions" (which also sets the mode back to *Smart*). These settings take
effect immediately, independently of "Apply".

## Skills

A **skill** is a directory containing a `SKILL.md` in the
[Agent Skills format](https://agentskills.io/specification): YAML front matter
with `name` (which must match the directory name) and `description`, followed by
the instructions as Markdown. Enabled skills go to the model as part of the
system prompt.

**System skills** live under `system-skills/` in the app bundle, are part of the
product and are enabled by default. Shipped with it is `snotra-capabilities` —
with it the app can give information about itself (what works, what does not,
where something is configured) instead of guessing.

**Folder skills** are read by Snotra when a folder is opened, from three sources,
in this order:

| # | Level | Path |
|---|-------|------|
| 1 | Workspace | `<folder>/.agents/skills/*/SKILL.md` |
| 2 | User | `~/.snotra/skills/*/SKILL.md` |
| 3 | User (legacy location) | `~/.agents/skills/*/SKILL.md` |

`~/.snotra/` is **Snotra's own user directory** — the root for user data that
belongs to Snotra and for which no vendor-neutral standard exists; `skills/` is
its first inhabitant. It is the recommended place for global skills.
`~/.agents/skills` is still read so that existing installations do not break.
`~/.snotra/` is not created automatically, and Snotra does not move existing
skills anywhere: a missing directory is not an error.

Not to be confused with the `userData` folder managed by Electron — that stays
app state and is off limits for tools. `~/.snotra/` is the opposite: a place you
open, fill and version yourself.

Directories belonging to other tools — `.claude/` in particular — are not read by
Snotra, neither in the opened folder nor in the home directory. If the same name
exists more than once, the first hit wins — the rest appear in the settings as
"shadowed", with their path. System skills come first and cannot be replaced by a
directory slipped underneath. Invalid entries (not a directory, missing
`SKILL.md`, name ≠ directory) are skipped and shown with a reason, instead of
aborting the scan.

Everything is managed under **Settings › Skills**: a checkbox per skill (any
number at once), grouped by source, plus "Reload skills". The
skill directories are **watched**: if you create a skill, change its `SKILL.md`
or install one via `skill-manager`, Snotra notices by itself — the list in the
settings and the `/` completion in the chat follow immediately, without you
having to click anything. "Reload skills" remains as a way out for the cases in
which the operating system reports no change — on network drives, for instance.

**Folder skills are never automatically active:** they are foreign content and
therefore a prompt-injection risk, so each one needs an explicit selection.
`allowed-tools` from the front matter is ignored — what counts remains the tool
checkboxes under Settings › Tools.

### Invoking a skill in the chat: `/name`

For one-off use you do not have to go into the settings. Type a **`/`** in the
input field and — as with the `@` file reference — a list of **all available**
skills opens, not just the enabled ones; the search covers name *and*
description. `↑`/`↓` selects, `Enter` or `Tab` accepts, `Esc` closes. An open
folder is not required, and the system skills are always there.

What gets inserted is the text `/name`, which stays in your message. It takes
effect for the **rest of this chat** — including follow-up answers and after
reloading the chat, because the invocation is part of the message. Your selection
under Settings › Skills is not changed by it — the invocation applies only to this
chat and is your deliberate one-off decision.

Only what *you* write counts as an invocation — a `/name` in a model answer or in
a tool result has no effect. That way neither the model itself nor foreign file
content can switch on a skill. A slash in the middle of a word or in a path
(`/usr/bin`, `and/or`) stays ordinary text.

### Getting suitable skills suggested

`/name` only helps if you know the name. So Snotra suggests a fitting skill:
write your request and then type a **`/`** — below the input field, "Fits here:
`/meeting-protocol`" appears. A click accepts it, the `×` hides it.
Without `/` nothing happens; the suggestion therefore never pushes itself into an
ordinary conversation.

Where the suggestion comes from is configured under **Settings › Skills ›
Suggestions in the chat**:

- **From the descriptions (default).** Snotra compares your line with the skill
  descriptions — on your machine, without the network and without cost. Words
  that appear in many descriptions count for less than rare ones. Measured
  against 16 skills, the correct suggestion came first in 10 of 13 cases, and for
  five requests with no fitting skill there was not a single false suggestion.
  What this method cannot do: recognise domain abbreviations that appear in no
  description (`TTAI-421`), and tell two very similar skills apart.
- **Ask the model.** Exactly right for that. But it then costs a short call to
  the provider, takes a moment, and your line goes there together with the skill
  names.
- **No suggestions.**

In every case: suggested, never enabled. A folder skill is foreign content, and
accepting it remains your click.

### Files next to the `SKILL.md`

Many skills put their actual knowledge alongside it (`references/`, `assets/`,
`scripts/`) and point to it from the `SKILL.md`. The directory of every
**enabled** skill is therefore a second **read root**: the read tools reach it
via the prefix `skill:<name>/<path>`, for example
`skill:meeting-protocol/references/template.md`. The system prompt names the
addressing scheme and the enabled names as soon as a folder is open.

The boundaries stay narrow:

- **Read-only.** `write_file_text`, `edit_file` and `apply_patch` never even see
  the skill directories and reject `skill:` paths.
- **Enabled skills only.** A skill that is not selected is not a path; the error
  message names the skills that actually are enabled.
- **No escaping.** `..` and symlinks are checked against the real path, exactly as
  with the working folder.
- **Recognisable in the chat.** Read accesses to skill files get their own symbol
  in the tool log plus "(skill ‹name›)" in the text, so that they do not look like
  access to the project; in the collapsed summary, skill accesses come first.

Without an open folder there are no tools at all, and therefore no skill paths
either.

## Project instructions: `AGENTS.md`

A skill describes a way of working and gets switched on. An `AGENTS.md` describes
how work is done in *this* project — which package manager, which test commands,
which conventions, which folders are off limits — and applies without being
selected. Snotra reads it from three places while building every system prompt:

| # | Path | Scope |
|---|------|-------|
| 1 | `<folder>/.agents/AGENTS.md` | this project |
| 2 | `~/.snotra/AGENTS.md` | everywhere |
| 3 | `~/.agents/AGENTS.md` | everywhere, older location, still read |

The order is the same as for skills: the project first, then the global places.
**All existing files complement one another** and apply jointly — none replaces
another, so there is nothing to decide and no precedence. Missing files are the
normal case and not an error.

**Within the project, only `.agents/` counts.** An `AGENTS.md` directly in the
folder root is **not** read by Snotra — even though that is the more common form
outside this project. This gives the project exactly one place for AI
instructions, the same one as for skills. Anyone wanting to adopt a file from
another tool moves it into `.agents/`.

`AGENTS.md` is the only file name Snotra knows for this — no `CLAUDE.md`, no
`.cursorrules`. At most 20,000 characters per file are sent along; anything
longer is visibly truncated rather than discarded. How much each file contributes
to the context window is listed individually in the breakdown below the input
field.

**Changes take effect immediately**, without a restart and without a button: the
files are read afresh with every message.

**The content is instruction, not data.** Unlike a tool result, an `AGENTS.md` is
*meant* to change the model's behaviour — otherwise it would be pointless. Whoever
opens a foreign folder also adopts its instructions. The emergency brake for that
is the switch **Settings › General › "Send `AGENTS.md`"** (on by default), which
turns off all three places.

## Memory: `memory.md`

Snotra does not start every chat from scratch. Say **"please remember …"** in
the chat, and from the next message on the sentence is back
in the system prompt — in a new chat as well, and after a restart.

There are two levels, both ordinary Markdown files:

| Level | File | Applies to |
| --- | --- | --- |
| Project | `<folder>/.agents/memory.md` | only the opened folder |
| Global | `~/.snotra/memory.md` | every folder |

The same two places as for `AGENTS.md` and the skills. Because they are files,
you can read and edit them in an editor, and the project memory moves along when
the folder moves. But it therefore also lives **inside your project** and can end
up in a repository — what concerns only you belongs in the global memory, or
nowhere. **Never passwords, keys or credentials:** the memory goes to the provider
with every request.

Snotra also remembers **by itself** what looks permanently important. Every act of
remembering requires approval and appears with its target and path in the tool
log — and the self-directed remembering can be switched off, leaving only what you
explicitly ask for.

Under **Settings › Memory** you see both levels with all their
entries, delete individual ones and switch off each level. At most 8,000
characters per level are sent along; how much that contributes to the context
window is listed individually in the breakdown below the input field.

## MCP servers

Through the **Model Context Protocol (MCP)** you bring in tools from foreign
systems — Jira, Confluence, databases, internal APIs — without Snotra having to
ship a tool of its own for them. A new capability arrives by configuration, not
by release. This is managed under **Settings › MCP**; writing JSON files by hand
is not necessary.

Supported are servers that are started **locally as a process** (stdio
transport). Servers reachable only over HTTP or SSE do not work yet.

### Adding a server

"Add server" opens a small form:

| Field | Meaning |
| ---- | --------- |
| **Identifier** | Lowercase letters, digits, `.`, `-`, `_`. It later sits inside the tool name and cannot be changed afterwards |
| **Display name** | Freely chosen, only for the list |
| **Command** and **arguments** | What gets started, e.g. `npx` with `-y @modelcontextprotocol/server-github` |
| **Working directory** | Optional; empty means the project folder |
| **Environment variables** | Name/value pairs for the process |

**Environment variables are secret by default.** A secret value is stored
encrypted via Electron's `safeStorage` and is not displayed afterwards — only
replaced or deleted. Anyone who deliberately wants to keep a value readable (say
`LANG=de_DE`) unticks the box; it then sits in the configuration in plain text.
Forgetting should not be the expensive case. If encryption is not possible on the
system, nothing is stored at all rather than putting a token down in the open.

**"Test connection"** starts the server once and shows whether
it responds and which tools it offers — or an understandable error message
including `stderr` if it does not start. Only after that can individual tools be
deselected.

### Importing servers

Anyone already using MCP in Claude Desktop, Claude Code or Cursor does not have to
retype their servers: **"Import"** accepts a pasted `mcpServers`
block — with or without an enclosing `mcpServers`, and Markdown fences, comments
and trailing commas do not get in the way. While you paste, what was recognised
appears below.

The preview names, for each entry, the name, the identifier derived from it and
the start command, plus the points that require a decision: values flagged as
secret (key names such as `*_TOKEN` or known token formats), placeholders that
have not been filled in, and identifiers that would replace an existing server.
Entries that will not work — HTTP/SSE transport, missing command — are listed
below with a reason, instead of quietly disappearing. Every entry can be
deselected individually.

**Imported servers are switched off at first.** The import is a substitute for
retyping, not an approval: switching one on starts a process and brings its tools
to the model, and that remains a deliberate step.

Only what you paste is read. Snotra does not open foreign configuration files.

### How MCP tools appear in the chat

Tools of enabled servers reach the model with a namespace prefix:
`mcp__<identifier>__<toolname>`. That keeps them separate from the built-in tools
and makes it visible in the tool line where a call comes from. Composite names
over 64 characters are left out by Snotra and reported below the server list — a
name the model cannot address reliably is of no use to anyone.

For [tool permissions](#configuration), MCP tools always count as `execute`
**and** `external`: a foreign process runs, and data leaves the app. If a server
explicitly declares a tool as destructive, `delete` is added. So a server can
classify itself more strictly, but not more leniently — otherwise the foreign
server would decide how strictly we treat it.

A server that does not start or that crashes does not break the chat: the error is
reported and everything else keeps running.

## Project layout

```
.
├── src/
│   ├── application/     transport-agnostic application core (chat, ports)
│   │   ├── chat/        chat engine, history trimming
│   │   └── ports/       LLM, tool, preferences and other core ports
│   ├── main/            Electron main process
│   │   ├── composition/ composition root (wiring of all adapters)
│   │   ├── adapters/    port implementations (LLM, tools, storage, FS, …)
│   │   ├── ports/       infrastructure port interfaces
│   │   ├── ipc/         thin IPC handlers
│   │   ├── providers/   LLM provider implementations
│   │   ├── services/    infrastructure (storage, FS, Whisper, updates, presentation)
│   │   └── tools/       workspace tool registry
│   ├── preload/         secure bridge between main and renderer (bundled)
│   ├── renderer/        UI (HTML, CSS, JS) — pure presentation layer
│   └── shared/          contracts, IPC channels, shared presentation helpers
├── system-skills/       built-in system skills (one `SKILL.md` per directory)
├── test/                tests (node:test), including architecture boundary guards
├── e2e/                 smoke test against the running Electron app
├── scripts/             build helpers (vendor sync for the renderer, icon build)
├── docs/                architecture (`architecture.md`, SVG diagrams), release, security concept
├── assets/icon/         SVG sources of the app icon (macOS and Windows layout)
├── assets/readme/       demo GIF and stills for the README (light and dark)
├── icon.icns/.ico/.png  app icons for macOS / Windows / Linux, generated via `node scripts/build-icons.js`
└── package.json
```

Details on the layered architecture: [`docs/architecture.md`](./docs/architecture.md).

## Security notes

- API keys are stored **locally** and are not passed on to third parties.
- The workspace access of the file tools is limited to the currently opened
  project folder. Exceptions: the **read** tools additionally reach the
  directories of the enabled skills via `skill:<name>/…` (see [Skills](#skills);
  nothing is ever written there) — and the two **execution** tools `run_python`
  and `shell_execute` do not know this boundary at all: it is not Snotra that
  accesses files there, but the interpreter or the shell. Both are therefore off
  as shipped and need an approval before every run. On macOS and Linux they run
  in a sandbox that confines writes to the project folder and limits the network
  to the approved domains (see [The sandbox per operating
  system](#the-sandbox-per-operating-system)); on Windows they do not.
- Every tool call passes through a policy in the main process (risk class × mode,
  deny rules, hard boundaries); file modifications and access to sensitive files
  need an approval in the default mode (see [tool permissions](#configuration)).
  A tool text, a file or a skill cannot grant a permission.
- Even so: do not let the model work in folders holding sensitive data you do not
  want it to see.

## Contributing

Build prerequisites, test commands and the branch/PR conventions are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE).

Copyright © 2026 Konrad Krafft.
