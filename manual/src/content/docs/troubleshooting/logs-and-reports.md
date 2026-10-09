---
title: Find logs and report a problem
description: Where Snotra keeps what it knows about a run, an update and its own errors, and how to put it into a bug report without giving away your keys.
sidebar:
  order: 4
---

Snotra does not write a running log file. What it knows about a problem sits in a few places instead: the tool log in the chat, a diagnostics copy you can paste, the developer tools of the window, and — for an update on Windows — a log in the profile folder. This page shows where each one is and what to send along when you report a problem.

## What you need

The chat or the dialog where the problem showed, and for a report a GitHub account.

## Where to look

| What went wrong | Where to look |
| --- | --- |
| A chat answer: a tool step failed, a command did nothing, a file was not changed | The tool log above the answer, and the box *The sandbox blocked …* under it: [Follow what Snotra does](../../chatting/follow-the-work/). |
| The tool log itself shows something odd — a line stays empty, a step is missing | Press `Cmd+Shift+D` / `Ctrl+Shift+D`. Snotra copies the tool log diagnostics as JSON to the clipboard and says *Tool log diagnostics copied*. |
| An error from the provider | The red box under your message: [When the model reports an error](../provider-errors/). |
| The window shows something wrong or stops reacting | *View › Developer Tools*, the tab *Console*. Errors are listed in red. |
| An update on Windows did not go through | `update-install.log` in the profile folder; the update dialog names its path. |
| Snotra does not start at all | Start it from a terminal, see below; what it prints there says why. |

## The profile folder

Settings, chats and permissions are kept outside the app, in a folder that carries the platform's name:

| System | Profile folder |
| --- | --- |
| macOS | `~/Library/Application Support/Snotra AI` |
| Windows | `%APPDATA%\Snotra AI` |
| Linux | `~/.config/Snotra AI` |

On macOS, press `Cmd+Shift+G` in the Finder and paste the path to get there; on Windows, paste it into the address bar of the Explorer.

The folder holds your encrypted keys and chats as well. Do not send the folder or its files as a whole: pick the one log you need.

## Start Snotra from a terminal

When Snotra does not open, or closes at once, start it from a terminal. It then prints what goes wrong.

- **macOS:**

  ```bash
  "/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent"
  ```

- **Linux, AppImage or tarball:** start the file in its folder, for example `./"Snotra Agent"` in the extracted tarball.

Quit Snotra first if it is still running; a second start only brings the first window forward.

## Steps: report a problem

1. Open the [issue form for bugs](https://github.com/kkrafft1999/snotra/issues/new?template=bug_report.yml). *Help › Project on GitHub* leads to the project as well.
2. Describe what happened, what you did before, and what you expected.
3. Give the version — at the foot of the settings, next to *Check for updates* — and your system.
4. For a problem with a chat answer, press `Cmd+Shift+D` / `Ctrl+Shift+D` right after it happened and paste the result under *Logs / screenshots*.
5. Add a screenshot where it helps.

## What happens

The report is public. The diagnostics contain no file contents and no arguments of the tool calls, but they do contain the names of files and tools and the first part of each tool line. Read through what you paste, and remove what you would not post in public.

## If it doesn't work

- ***Tool log diagnostics in the console*** instead of *copied*. The clipboard could not be used. Open *View › Developer Tools*, tab *Console*: the diagnostics are there to copy.
- **Never paste a key.** If an API key or a token shows up in something you want to send, remove it first. If one went out by mistake, revoke it with the provider and create a new one.
