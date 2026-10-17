---
title: Find logs and report a problem
description: Where Snotra keeps what it knows about a run, an update and its own errors, and how to put it into a bug report without giving away your keys.
sidebar:
  order: 4
---

[since 1.25] Snotra writes its own warnings and errors to a log file on your computer. Together with a few other places — the tool log in the chat, the developer tools of the window, and the update log — it holds what a bug report needs. This page shows where each one is and what to send along when you report a problem.

## What you need

The chat or the dialog where the problem showed, and for a report a GitHub account.

## Where to look

| What went wrong | Where to look |
| --- | --- |
| A notice at the top of the window says *Something went wrong in the background.* | Snotra caught an error it did not expect and keeps running. The details are in the [log file](#the-log-file); *Copy diagnostics* in the notice puts what a report needs on the clipboard. |
| The window turned blank, or a box says *The window stopped working* | Choose *Reload Window*. A reply that was still being written is lost; saved chats are kept. The log file says why the window stopped. |
| A chat answer: a tool step failed, a command did nothing, a file was not changed | The tool log above the answer, and the box *The sandbox blocked …* under it: [Follow what Snotra does](../../chatting/follow-the-work/). |
| The tool log itself shows something odd — a line stays empty, a step is missing | Press `Cmd+Shift+D` / `Ctrl+Shift+D`. Snotra copies the tool log diagnostics as JSON to the clipboard and says *Tool log diagnostics copied*. |
| An error from the provider | The red box under your message: [When the model reports an error](../provider-errors/). |
| The window shows something wrong or stops reacting | The log file first. For more, *View › Developer Tools*, the tab *Console*: errors are listed in red. |
| An update did not go through, or the new version did not start | `update-install.log` in the profile folder; the update dialog names its path. |
| Snotra does not start at all | The box that says so names the log file. If no box appears, start Snotra from a terminal, see below. |

## The log file

*Help › Show Log File* opens the folder with the log in the Finder or the Explorer, with the file selected. The button *Show log file* in the notice does the same.

The log is called `main.log` and sits in the folder `logs` inside the [profile folder](#the-profile-folder). When it reaches 1 MB, it becomes `main.old.log` and a fresh `main.log` starts, so the two together never take more than about 2 MB.

| The log holds | The log never holds |
| --- | --- |
| A line for each start, with the version and the system | Your chats, your messages or the model's answers |
| Warnings and errors of Snotra itself | The arguments of tool calls or the contents of your files |
| Errors in the window that nothing caught, with their stack trace | API keys, tokens or other secrets |
| Paths of files and folders on your computer | — |

The log stays on your computer. Snotra never sends it anywhere; it only goes out when you copy it into a report yourself.

## Copy the diagnostics

*Help › Copy Diagnostics* — or *Copy diagnostics* in the notice — puts a short report on the clipboard: the version of Snotra, your system, how many errors were caught since the start, and the last 200 lines of the log. Your home folder is written as `~` in it, so the report does not name your user account.

From the menu, a box confirms the copy and offers *Show Log File*. In the notice, the button reads *Copied* for a moment.

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

When Snotra does not open, or closes at once, without a box that says why, start it from a terminal. It then prints what goes wrong.

- **macOS:**

  ```bash
  "/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent"
  ```

- **Linux, AppImage or tarball:** start the file in its folder, for example `./"Snotra Agent"` in the extracted tarball.

Quit Snotra first if it is still running; a second start only brings the first window forward.

## Steps: report a problem

1. Open the [issue form for bugs](https://github.com/kkrafft1999/snotra/issues/new?template=bug_report.yml). *Help › Project on GitHub* leads to the project as well.
2. Describe what happened, what you did before, and what you expected.
3. Choose *Help › Copy Diagnostics* and paste the result under *Logs / screenshots*. It gives the version and your system as well.
4. For a problem with a chat answer, press `Cmd+Shift+D` / `Ctrl+Shift+D` right after it happened and paste that result too.
5. Add a screenshot where it helps.

## What happens

The report is public. Neither the diagnostics nor the tool log diagnostics contain your chats, file contents or the arguments of tool calls. They do contain the names of files, folders and tools, error messages, and the first part of each tool line. Read through what you paste, and remove what you would not post in public.

## If it doesn't work

- ***The diagnostics could not be copied.*** The clipboard could not be used. Choose *Show Log File* in the same box, open `main.log` and copy the last lines from there.
- ***Tool log diagnostics in the console*** instead of *copied*. The clipboard could not be used. Open *View › Developer Tools*, tab *Console*: the diagnostics are there to copy.
- **The notice keeps coming back.** Each new error brings it back after you closed it; when errors keep coming, at most once a minute. Something does not work as it should — copy the diagnostics and report it.
- **The window stops working again after the reload.** Quit Snotra and start it again. If it keeps happening, report it with the diagnostics.
- **Never paste a key.** If an API key or a token shows up in something you want to send, remove it first. If one went out by mistake, revoke it with the provider and create a new one.
