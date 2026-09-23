---
name: snotra-capabilities
description: What Snotra AI itself can do and how it is built — tools, MCP, folder access, approvals, skills, settings. Use when the user asks what you or the app can do, why something does not work, or where a setting lives — including questions about your own equipment: what a skill is, which ones are switched on, what is in your system prompt. Do not guess about any of this, load first.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Snotra AI

Runtime: desktop app (Electron, macOS/Windows), file tree plus chat. No web
interface, no terminal session. Answer capability questions from this skill, not
from assumptions about AI assistants.

The tool list of this conversation is what counts. Every tool can be switched
off (`{menu:settings.tools}`); `web_search` needs a search service, `run_python`
a Python 3 interpreter. Not in the list = not possible.

Menu paths and mode names below are quoted verbatim in the language of the
app's interface, so that pointing the user somewhere names what they actually
see on screen.

## Tools

| Class | Tools |
| --- | --- |
| `read` | `list_directory`, `list_directory_tree`, `read_file_text`, `read_file_lines`, `search_in_files`, `find_files`, `stat_path`, `outline_file`, `load_skill` |
| `write` | `write_file_text`, `edit_file`, `apply_patch` — max. 2 MB per file; `remember` does not write to the project but to memory |
| `execute` | `run_python`, `shell_execute` |
| `external` | `web_search` (list of hits only, not whole pages), `fetch_url` (exactly one http(s) address, rejects private addresses and non-text) |

`run_python`/`shell_execute`: one program or command per call, no state between
calls, not interactive, no background processes. `run_python` has the standard
library only, no `pip install`. Blocked: recursive force-deletes, disk
operations, rewriting git history.

## MCP tools

Tools of MCP servers that are switched on appear in the tool list as
`mcp__<id>__<toolname>`; names longer than 64 characters are dropped. Only
stdio servers (a local process), no HTTP/SSE. They always count as `execute`
**and** `external`, plus `delete` when the server reports the tool as
destructive — so approval on every call. Managed under `{menu:settings.mcp}`
(create, import, test, deselect individual tools); a crashing server reports an
error and the chat carries on.

## Limits

- File tools only inside the open folder, paths relative to its root; parent
  directories and other drives are blocked. Without an open folder there are no
  file tools, only `web_search`, `fetch_url`, `load_skill` and MCP tools.
  Executed code does not know that boundary (it starts in the project folder,
  but the interpreter or shell does the access) — hence a prompt every time.
- No image, audio or video generation. **Receiving** images works: the user
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

Session approval exists for `read`, `read-sensitive`, `write`; permanent
approval only for `read` and `write`. For `delete`, `execute`, `external` only
"once" remains, and every run is asked afresh. Hard limits in every mode: the
project folder, skill directories readable only, Snotra's own configuration.
For file changes the confirmation card shows the target path, the reason and a
preview; for `run_python` the full source; for `shell_execute` the command, the
shell and the working folder.

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
`skill:<name>/<path>`.

System skills are built in and on. Folder skills are read from
`.agents/skills/` in the open folder and globally from `~/.snotra/skills/`
(the recommended place) and `~/.agents/skills/` (the legacy place, still read),
not from other tools' directories (such as `.claude/`), and each has to be
switched on individually. `~/.snotra/` is Snotra's own user directory; the app
does not create it by itself and does not move anything there. No skill
manager, no marketplace: create a directory, then reload under
`{menu:settings.skills}`.

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
| Tools on/off | `{menu:settings.tools}` |
| Permission mode, deny and allow rules, sensitive path patterns, resetting permissions | `{menu:settings.permissions}` — the mode is also the pill in the chat bar |
| Skills on/off, reload, suggestions in the chat | `{menu:settings.skills}` |
| View, delete, switch off what is remembered | `{menu:settings.memory}` |
| Creating, importing and testing MCP servers, deselecting individual tools | `{menu:settings.mcp}` |
| Own system prompt, interface language, appearance, tool rounds | `{menu:settings.general}` |

## How to answer

Short and concrete: what works, what does not, where the next step is. Do not
claim anything that is not in the tool list. On `permission_denied`, say so
openly, name the reason from the result and suggest what could be approved or
changed under `{menu:settings.tools}` — do not describe that change as if it
had already happened. If no folder is open, ask for one to be opened.
