---
title: Why Snotra asks before it acts
description: How Snotra decides which tool calls run on their own and which wait for you, and what holds in every mode.
sidebar:
  order: 1
---

Snotra works through tools: it reads files, changes them, runs commands, searches the web. Before any tool call runs, Snotra checks it against fixed rules. The model can ask for anything; whether it happens is decided outside the model, by Snotra itself.

## Six kinds of risk

Every tool call belongs to one risk class. The class, together with the [mode](../choose-a-mode/) of the chat, decides whether the call runs, asks you first, or is not offered at all.

| Risk class | What it covers | In *Smart*, the default mode |
| --- | --- | --- |
| *Read* | Reading files and listing folders inside the open folder | runs |
| *Read sensitive data* | Reading a file that may contain credentials, such as `.env`, a private key or `.ssh/` | asks |
| *Change* | Creating a file or changing one; before a file is replaced as a whole, a copy goes to the trash | asks |
| *Overwrite with no way back* | Replacing a file when no copy can go to the trash | asks, every time |
| *Execute* | Running a shell command or Python code | asks — except a command you told it to always allow |
| *External services* | Searching the web, fetching a page, generating an image, the tools of MCP servers | asks, every time |

*Settings › Tools & security* shows these six rows for the open folder, with what applies there and why: [See and change what Snotra may do](../tools-and-security/).

## Why reading runs and everything else asks

**Reading** inside the folder you opened changes nothing, and you chose that folder yourself. So in *Smart* Snotra reads without asking — that is what makes it useful.

**Sensitive files** are different: their content would go to your model provider. The approval card names that provider before you decide. Broad searches and listings leave such files out and only say how many they skipped.

**Changes** leave traces in your files. You see the new content or the replacement on the card before anything is written.

**Commands** can do whatever you can do in a terminal. You see the full command on the card before it runs. On macOS and Linux they also run in a [sandbox](../sandbox/).

**External services** receive data from your computer: a search query, an address, an image description, the arguments of an MCP tool.

## What holds in every mode

Even in *Auto*, the mode without questions:

- No tool reaches outside the open folder unasked. Reading also works in the folders of skills you switched on. [since 1.18] A file tool that wants a file or folder outside asks first on a card, in every mode, *Auto* included — see [Answer an approval request](../approve-a-request/#a-file-outside-the-open-folder). Your home folder as a whole, the root of a disk and Snotra's own storage are never offered.
- Skill folders stay read-only.
- Snotra's own settings, keys and permissions are out of reach for every tool.
- A tool output that contains one of your provider keys is held back.
- A block you set always wins.

## Why loosening goes through a system dialog

The chat shows content Snotra did not write: model answers, files, web pages. A text in a file can contain instructions aimed at the model. For the model it is material, not a command, and every tool call that follows goes through the same check again.

That is also why the app window is not trusted to loosen protection on its own. Switching on *Auto*, allowing something for good, switching the sandbox off or deleting a block is confirmed in a dialog of the operating system, outside the window. Tightening — a block, *Always ask* — takes effect at once, without a dialog.

Your permissions are stored signed in your profile, not in the project folder. A repository you download cannot switch itself to *Auto* or turn the sandbox off.
