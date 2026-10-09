---
title: Find where Snotra keeps its files
description: The profile folder with your settings and chats, and the files Snotra reads or writes in a project and in your home folder.
sidebar:
  order: 2
---

Snotra keeps what belongs to you in three places: a profile folder for settings and chats, the project folder you opened, and `~/.snotra/` in your home folder. This page lists what lies where, and what you may edit yourself.

## Where Snotra looks for things

| Place | What lives there |
| --- | --- |
| The profile folder | Your models and keys, your settings, your chats, your permissions. Belongs to you, not to a project. |
| `AGENTS.md` and `.agents/` in the open folder | Instructions, memory, skills and skill data of this project. Travels with the folder — and can end up in a repository. |
| `~/.snotra/` in your home folder | Instructions, memory and skills for **every** folder. |
| `~/.agents/` in your home folder | The older place for global instructions and skills. Still read. |

## The profile folder

| System | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Snotra AI` |
| Windows | `%APPDATA%\Snotra AI` |
| Linux | `~/.config/Snotra AI` |

It still carries the name of the platform, Snotra AI, although the app is called Snotra Agent. Nothing was moved when the app was renamed: see [Install Snotra Agent](../../getting-started/install/).

| File | What it holds |
| --- | --- |
| `llm-config.json` | The models in the list and how to reach them. Keys are stored encrypted. |
| `ui-preferences.json` | Your settings and the layout: language, the system prompt, the switches, the width of the columns, the zoom of Markdown files, the Python interpreter, the image model. |
| `tool-policy.json` and `tool-policy.key` | The mode, your blocks and allowances, the default mode of a folder. Signed, so a changed file is noticed. |
| `mcp-servers.json` | The MCP servers. Secret environment variables are encrypted. |
| `web-search-config.json` | The key for the web search, encrypted. |
| `chat-history.json` | Your chats, encrypted. |
| `chat-attachments/` | The images that belong to your chats, one folder per chat. |
| `folder-history.json` and `last-folder.json` | The recent folders, and the one that opens at the next start. |
| `window-state.json` | Size and place of the window. |

Anything else in the folder — `Cache`, `Local Storage` and the like — is the framework's own and can be left alone.

### Which of them you may edit

Almost none. Everything in them is set in the app, and the app writes the files itself, so a change made behind its back can be overwritten. One setting has no place in the app, and one file must stay as it is:

- **`ui-preferences.json`** takes `historyCharLimit`, a number the settings do not show: the budget in characters for the chat history sent with each request (200,000 by default, 4,000 to 2,000,000). Older messages beyond it are left out, and large tool results of earlier rounds are cut short. Quit Snotra before you edit the file.
- **`tool-policy.json`** is signed. Do not edit it: Snotra then falls back to *Smart* — or stays on *Always ask* — and drops your allowances; your blocks stay in force. Change permissions under *Settings › Tools & security* instead.

To start from scratch, quit Snotra and move the folder somewhere else. Keys and chats are then gone from the app — keep a copy first.

### Keys and encryption

API keys, secret environment variables, the search key and your chats are encrypted with a key from the system: on macOS the keychain item *Snotra AI Safe Storage*, on Windows the user account, on Linux the keyring. A copy of the folder is therefore useless on another computer or another account, and the keys have to be entered again there. Where the system offers no encrypted storage — a Linux desktop without a keyring, say — Snotra says *Encrypted storage is not available on this system* instead of saving a key.

If the key changes, a chat history that can no longer be read is not deleted: it is kept as `chat-history.json.undecryptable-<time>` next to the new one.

## In a project

| What | Where | Written by |
| --- | --- | --- |
| Project instructions | `AGENTS.md`, at the top of the folder | you — see [Give a project its instructions](../../customising/project-instructions/) |
| Project memory | `.agents/memory.md` | Snotra on your request, or you — see [Let Snotra remember](../../customising/memory/) |
| Skills of the project | `.agents/skills/<name>/SKILL.md` | you, or Snotra when you ask for a skill — see [Use skills](../../customising/skills/) |
| What a skill keeps | `.agents/data/` | the skill |

When Snotra overwrites a file in a project, a copy of the old version goes to the trash first.

## In your home folder

| What | Where |
| --- | --- |
| Instructions for every folder | `~/.snotra/AGENTS.md`, then `~/.agents/AGENTS.md` |
| Global memory | `~/.snotra/memory.md` |
| Your own skills | `~/.snotra/skills/<name>/`, and `~/.agents/skills/<name>/` |

The skill folders in your home folder are read-only for every tool: you change your own skills and instructions yourself, in your file manager or editor. Global memory is written when you ask Snotra to remember something for every folder, and every such write asks first.

## If it doesn't work

- **Settings are gone after a fresh install.** The profile folder is named after the platform, not the app: look for `Snotra AI`, not `Snotra Agent`. A start with `--user-data-dir` uses another folder altogether.
- **Keys are asked for again, or *enter the key again* appears.** The system key changed — a new user account, a restored backup, a new computer. Enter the keys once more.
- **A change to `ui-preferences.json` has no effect.** Snotra was probably running when you saved it and wrote its own settings over yours. Quit Snotra first.
