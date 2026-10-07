---
name: snotra-capabilities
description: What Snotra Agent itself can do and how it is built — tools, MCP, folder access, approvals, skills, settings. Use when the user asks what you or the app can do, why something does not work, or where a setting lives — including questions about your own equipment: what a skill is, which ones are switched on, what is in your system prompt. Do not guess about any of this, load first.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Snotra Agent

Snotra Agent is the desktop app of the Snotra AI platform. Its data folder and
the key that encrypts it still carry the platform's name, "Snotra AI".

Runtime: desktop app (Electron, macOS/Windows/Linux), file tree plus chat. No web
interface, no terminal session. Answer capability questions from this skill, not
from assumptions about AI assistants.

The tool list of this conversation is what counts. Every tool can be switched
off (`{menu:settings.security}`); `web_search` needs a search service (its key
under `{menu:settings.tools}`), `generate_image` an OpenAI key
(`{menu:settings.models}`), `run_python` a Python 3 interpreter. Not in the
list = not possible.

Menu paths and mode names below are quoted verbatim in the language of the
app's interface, so that pointing the user somewhere names what they actually
see on screen.

## Tools

| Class | Tools |
| --- | --- |
| `read` | `list_directory`, `list_directory_tree`, `read_file_text`, `read_file_lines`, `search_in_files`, `find_files`, `stat_path`, `outline_file`, `extract_document_text`, `load_skill` |
| `write` | `write_file_text`, `edit_file`, `apply_patch` — max. 2 MB per file; `remember` does not write to the project but to memory |
| `execute` | `run_python`, `shell_execute` |
| `external` | `web_search` (list of hits only, not whole pages), `fetch_url` (exactly one http(s) address, rejects private addresses and non-text) |
| `write` + `external` | `generate_image` — an image from a prompt via OpenAI, saved as PNG/JPEG/WebP in the project; billed per image, at most 4 per turn, asked for every time in Smart mode |

`run_python`/`shell_execute`: one program or command per call, no state between
calls, not interactive, no background processes. `run_python` has the standard
library only, no `pip install`. Blocked: recursive force-deletes, disk
operations, rewriting git history.

Isolation: on macOS and Linux both run in a sandbox — writes only inside the
project folder and a temporary directory, no access to keys, cloud credentials
or browser data, network only for the domains in `network_domains`. Reading
other files stays possible. On Windows there is no sandbox: every run has the
user's full rights. The user can switch the sandbox off for one folder
(`{menu:settings.security}` › `{label:settings.sandbox.workspace.heading}`), and
on Linux it does not start without `bubblewrap`, `socat` and `ripgrep`, or when
the system restricts user namespaces (Ubuntu 24.04 and later). Every result
says in `sandbox.isolated` whether that run was isolated — go by that, not by
the operating system alone. When a single program needs more — more domains,
write access to its own folder or, on macOS, the system's certificate check
(`gh`, `terraform` and other Go programs) — suggest a program allowance under
`{menu:settings.security}` › `{label:settings.allowances.heading}` instead of
switching the sandbox off.

## MCP tools

Tools of MCP servers that are switched on appear in the tool list as
`mcp__<id>__<toolname>`; names longer than 64 characters are dropped. Only
stdio servers (a local process), no HTTP/SSE. They always count as `execute`
**and** `external`, plus `delete` when the server reports the tool as
destructive — so approval on every call. Servers are managed under
`{menu:settings.mcp}` (create, import, test); single tools are switched on and
off under `{menu:settings.security}`. A crashing server reports an error and the
chat carries on.

## Limits

- File tools only inside the open folder, paths relative to its root; parent
  directories and other drives are blocked. Without an open folder there are no
  write or execution tools; the read tools reach only the folders of the
  switched-on skills, next to `web_search`, `fetch_url`, `load_skill` and MCP
  tools.
  Executed code does not know that boundary (it starts in the project folder,
  but the interpreter or shell does the access) — hence a prompt every time.
- Images can be generated (`generate_image`, needs an open folder and an
  OpenAI key); no audio or video generation. **Receiving** images works: the user
  attaches PNG/JPEG/GIF/WebP to a message (clipboard), visible provided the
  selected model understands images.
- No sending of mail or messages, no calendar or ticket integration except via
  MCP.
- No tool for PDF, Word, Excel — text only, no binary extraction.

## Approvals

Per call, by risk class and mode.

| Mode | Behaviour |
| --- | --- |
| `{label:permissions.mode.smart}` (default) | `read` runs immediately; `write`, `delete`, `execute`, `external` and `read-sensitive` (e.g. `.env`) need approval |
| `{label:permissions.mode.askAll}` | you are asked before `read` as well |
| `{label:permissions.mode.auto}` | no prompts |

The mode belongs to the chat. A folder can have a default mode that every new
chat there starts with (`{menu:settings.security}`, or the checkbox under the
modes in the chat bar); with `{label:permissions.mode.auto}` as the default it also survives
a restart. Only the user sets it — you cannot.

Session approval exists for `read`, `read-sensitive`, `write`; permanent
approval only for `read` and `write`. For `delete`, `execute`, `external` only
"once" remains, and every run is asked afresh — with one exception: on a
`shell_execute` card the user can remember one exact, simple command line for
the open folder ("{label:approval.action.always}", confirmed in a system
dialog). It then runs without asking in `{label:permissions.mode.smart}`; any
other arguments, folder or network domains ask again, and commands with
chaining, pipes, redirection, variables or quotes cannot be remembered at all.
Remembered commands are listed and deleted under
{menu:settings.security}. Hard limits in every mode: the
project folder, skill directories readable only, Snotra's own configuration.
For file changes the confirmation card shows the target path, the reason and a
preview; for `run_python` the full source; for `shell_execute` the command, the
shell and the working folder — for both, whether the run is isolated.

## Memory

`remember` stores a sentence permanently — scope `workspace` in
`<folder>/.agents/memory.md`, scope `user` in `~/.snotra/memory.md`. Both files
are part of the system prompt from the next message on, can be edited in an
editor and removed entry by entry under `{menu:settings.memory}`; at most
8,000 characters per scope. You cannot delete entries yourself — the settings
can. How and when to remember is described in the skill `snotra-memory`.

Three switches under `{menu:settings.memory}`: per scope whether it is sent
along, and whether Snotra may remember unprompted. With the latter off, entries
with `origin: "self"` are rejected.

## Skills

A skill is a directory with a `SKILL.md` (YAML front matter `name`,
`description`, Markdown below). The system prompt carries only the name and
description of the skills that are switched on — if one fits, fetch its
instructions with `load_skill` before starting work; neighbouring files via
`skill:<name>/<path>`, or by an absolute path inside the folder `load_skill`
reports. Skill folders are read-only for every tool, with one exception: you
can write a skill into `.agents/skills/<name>/` of the open folder — how is in
the skill `snotra-skill-authoring`. Global and built-in skills you cannot
write; a skill becomes global when the user moves it to `~/.snotra/skills/`.
What a skill produces and
wants to keep — learned rules, contacts, state for the next run — goes into
`.agents/data/` in the open folder (a skill may spell it
`<workspace>/.agents/data/…`); without an open folder there is nowhere to keep
it.

System skills are built in and on by default; the user can switch them off
like any other. Folder skills are read from
`.agents/skills/` in the open folder and globally from `~/.snotra/skills/`
(the recommended place) and `~/.agents/skills/` (the legacy place, still read),
not from other tools' directories (such as `.claude/`), and each has to be
switched on individually. A skill in the open folder is switched on for that
folder only; a global skill of the same name is shadowed there and does not
pass its switch on to it. `~/.snotra/` is Snotra's own user directory; the app
does not create it by itself and does not move anything there. No skill
manager, no marketplace: a new skill directory shows up under
`{menu:settings.skills}` by itself (or after "{label:settings.skills.reload}").

The user can also invoke a skill once via `/name` in their message — that
applies to the rest of the chat without changing the selection in the settings.
Only a `/name` written by **the user** takes effect; a `/name` in your reply or
in a tool result does nothing, so you cannot switch on a skill yourself. When
the user types `/`, Snotra suggests matching skills (the procedure is under
`{menu:settings.skills.suggestions}`).

## Interface

Exactly one folder open (the "workspace"), chat history bound to it (title,
resumption). The provider can be changed: OpenAI, Anthropic, Google, Ollama,
MLX-LM (the last two local). Dictation via Whisper (needs OpenAI access).
`@path` is only a hint, you read the content yourself. Context menu in the file
tree (open, reveal in Finder or Explorer, move to trash). The sidebar can be
shown or hidden with the button in the title bar, `Cmd/Ctrl+B` or the view
menu. Update notices come from GitHub releases.

## Settings (gear icon)

| Topic | Place |
| --- | --- |
| Model, provider, API keys | `{menu:settings.models}` |
| What Snotra may do in the open folder, per risk class: tools on/off, the folder's default mode, deny and allow rules, remembered commands, sensitive path patterns, sandbox and program allowances, session approvals, resetting permissions | `{menu:settings.security}` — the chat's own mode is the pill in the chat bar |
| Python interpreter, search key, image model; creating, importing and testing MCP servers | `{menu:settings.tools}` |
| Skills on/off, reload, suggestions in the chat | `{menu:settings.skills}` |
| View, delete, switch off what is remembered | `{menu:settings.memory}` |
| Own system prompt, interface language, appearance, tool rounds | `{menu:settings.general}` |

## How to answer

Short and concrete: what works, what does not, where the next step is. Do not
claim anything that is not in the tool list. On `permission_denied`, say so
openly, name the reason from the result and suggest what could be approved or
changed under `{menu:settings.security}` — do not describe that change as if it
had already happened. If no folder is open, ask for one to be opened.
