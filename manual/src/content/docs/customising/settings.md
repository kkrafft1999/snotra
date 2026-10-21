---
title: Find your way around the settings
description: The seven sections of the settings, what takes effect at once and what on Apply, and what the section General holds.
sidebar:
  order: 1
---

Everything you can set up in Snotra is in one place: the settings. They open over the window and leave your chat where it is.

## Open the settings

*Snotra Agent › Settings…* on macOS, *View › Settings…* on Windows and Linux, or `Cmd+,` / `Ctrl+,`. [since 1.25] Or click the gear at the bottom of the sidebar, next to the [feedback](../../troubleshooting/send-feedback/) button. The menu and the shortcut stay when you hide the sidebar.

## The sections

| Section | What it holds |
| --- | --- |
| *Models* | The models Snotra offers in the chat, with their access. See [Manage your models](../models/). |
| *Tools › Autonomy* | How freely Snotra acts in the open folder, and with which tools. See [See and change what Snotra may do](../../safety/tools-and-security/). |
| *Tools › Security* | [since 1.26] The sandbox of every workspace, and what commands and Python runs may reach beyond it. See [Run commands in the sandbox](../../safety/sandbox/#set-up-the-sandbox). |
| *Tools › Setup* | The Python interpreter, the web search key, the image model and the MCP servers. See [Set up the built-in tools](../built-in-tools/) and [Connect an MCP server](../mcp-servers/). |
| *Skills* | The skills the model works with. See [Use skills](../skills/). |
| *Memory* | What Snotra remembers across chats. See [Let Snotra remember](../memory/). |
| *Remote access* | [since 1.28] Your chats on your iPhone — not open yet. See [Follow your chats from your phone](../remote-access/). |
| *General* | Instructions for every chat, the look, the language — see below. |

[since 1.26] *Autonomy*, *Security* and *Setup* sit together under the heading *Tools*; the heading itself is not a section.

[since 1.19] The `?` next to the name of the section at the top, and next to many headings inside a section, opens this manual at the page and section about it — in the window described in [The manual inside Snotra](../../#the-manual-inside-snotra).

## When a change takes effect

The line at the bottom of each section says it, because it differs:

- *Models* and *Skills* take effect when you click *Apply*. *Close* without *Apply* leaves them as they were.
- *Tools › Autonomy*, *Tools › Security*, *Memory* and *Remote access* take effect at once.
- In *Tools › Setup*, a key is saved with its own button and an MCP server at once; the interpreter and the image model wait for *Apply*.
- In *General*, switches, the appearance and the language take effect at once; the text fields wait for *Apply*.

## The section General

![Settings › General: a text field for the system prompt, the switches "Send environment information" and "Send AGENTS.md", and the choice between Light, Dark and System.](screenshots/settings-general.webp)

- ***System prompt*** — your own instructions for every conversation: a role, a tone, fixed rules. Sent to the model unchanged. Empty by default; Snotra sets none of its own here.
- ***Send environment information*** — tells the model the full path of the open folder (which contains your user name), whether it is a Git repository, your platform, the shell and today's date. Without it the model guesses the platform for commands and dates "last week" by when it was trained. On by default.
- ***Send AGENTS.md*** — the project instructions; see [Give a project its instructions](../project-instructions/). On by default.
- ***Appearance*** — *Light*, *Dark*, or [since 1.26] *System*, which follows the light or dark setting of macOS, Windows or Linux and switches with it while Snotra is open. *Light* is the default. This choice stays on this computer.
- ***Interface language*** — English or German, switching at once. It covers the window and the menu bar; what goes to the model stays English.
- ***Notify me when Snotra waits for my approval*** — [since 1.18] a system notification when an approval card waits while Snotra is in the background or the card is in another chat. It names the chat and what waits; a click brings Snotra up with that chat. On by default.
- ***Check for updates at start-up*** — [since 1.24] asks GitHub for a newer version a few seconds after every start and opens the update dialog if there is one. Switched off, Snotra only looks when you ask; see [Update Snotra Agent](../../updating/update-snotra/). On by default.
- ***Max. tool rounds*** — how often the model may call tools in a row before the chat stops. A guard against endless loops; 14 by default, at most 500.

## Where settings are kept

In your profile folder, outside the app and outside your projects: `~/Library/Application Support/Snotra AI` on macOS, `%APPDATA%\Snotra AI` on Windows, `~/.config/Snotra AI` on Linux. Keys are stored there encrypted. You do not need to touch the files; everything is set in the app.

## If it doesn't work

- **A change has no effect.** In *Models*, *Skills* and the text fields of *General*, click *Apply*.
- ***Settings could not be loaded.*** Close the settings and open them again. If it stays, the message names the file that could not be read.
- **No notification appears.** Check the switch above, and the system's own notification settings for Snotra Agent (on macOS *System Settings › Notifications*). The chat's row in the history says *Needs your approval* either way.
- ***System* stays light (or dark).** Snotra follows what the system reports as its preference: *System Settings › Appearance* on macOS, *Settings › Personalisation › Colours › Choose your mode* on Windows, the desktop's light or dark style on Linux (in GNOME *Settings › Appearance*). A Linux desktop that does not pass the style on to applications leaves Snotra light; pick *Light* or *Dark* there.
