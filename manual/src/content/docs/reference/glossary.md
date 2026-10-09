---
title: Glossary
description: The words Snotra and this manual use — mode, approval card, skill, sandbox, MCP server and the rest — each in a sentence, with the page that explains it.
sidebar:
  order: 3
---

The terms in alphabetical order. Each entry says what the word means in Snotra and where to read more.

### AGENTS.md

A text file at the top of a folder in which you write down how work is done there. Snotra follows it in every chat in that folder. See [Give a project its instructions](../../customising/project-instructions/).

### Always ask

One of the three [modes](#mode). Snotra asks before every tool call, reading included. See [Choose a mode](../../safety/choose-a-mode/).

### Approval card

The card that appears in the chat when Snotra wants to do something that needs your yes: change a file, run a command, reach a service. You allow it once, for the session, or refuse. See [Answer an approval request](../../safety/approve-a-request/).

![An approval card titled "Confirm change": Snotra wants to change notes/spring-2026.md with edit_file. Below it the effect, the target file, the reason, the session scope and the mode, a preview of the replacement from old to new, and the buttons "Allow once", "Allow for this session" and "Deny".](screenshots/approval-card.webp)

### Auto

One of the three [modes](#mode). Snotra asks nothing; the folder boundary, your blocks and the protection of its own keys stay in force. Switching it on is confirmed in a system dialog.

### Block

A rule of yours that forbids a tool, or a whole [risk class](#risk-class), for one folder or all. A block always wins over an allowance. See [See and change what Snotra may do](../../safety/tools-and-security/).

### Chat

One conversation with Snotra, with its own [mode](#mode), model and reasoning level. Chats are kept in the [history](#history).

### Context window

What the model receives with a request: the conversation, the instructions, the descriptions of the tools. The size is shown next to the send button; it has a limit that depends on the model. See [Write a message](../../chatting/write-a-message/).

### Default mode

The mode a new chat starts in for one folder. Without one, it is *Smart*. See [Choose a mode](../../safety/choose-a-mode/).

### Global

Valid in every folder, as opposed to the open one: global memory, instructions and skills live in `~/.snotra/`. See [Find where Snotra keeps its files](../files-and-folders/).

### History

The list of your earlier chats, on the right of the window. See [Continue an earlier chat](../../chatting/chat-history/).

### MCP server

A small program that offers Snotra tools from another system — an issue tracker, a database — through the Model Context Protocol. Snotra starts it on your computer. See [Connect an MCP server](../../customising/mcp-servers/).

### Memory

What Snotra keeps for later chats: `.agents/memory.md` for a project, `~/.snotra/memory.md` for every folder. See [Let Snotra remember](../../customising/memory/).

### Mode

How often Snotra asks you: *Smart*, *Always ask* or *Auto*. It belongs to the chat. See [Choose a mode](../../safety/choose-a-mode/).

![The mode menu above the chat input: Smart, Always ask and Auto, each with a short description, "Always ask" selected. Below, the checkbox "“Always ask” for new chats in garden-planner too" and the link "All permissions in Settings › Tools & security".](screenshots/mode-menu.webp)

### Model

The language model that answers in a chat, offered by a [provider](#provider). See [Manage your models](../../customising/models/).

### Open folder

The one project folder Snotra works in. It shows as the file tree on the left; Snotra cannot leave it. Many places in the app and in the code call it the *workspace*. See [Open a folder](../../getting-started/open-a-folder/).

### Preview

The middle column, which shows a file — rendered Markdown, code, an image, a PDF, an HTML page. See [Look at a file](../../workspace/preview/).

### Provider

The company or server that runs a model: OpenAI, or an OpenAI-compatible server of your own. The text of a chat goes to it. See [Connect a model](../../getting-started/connect-a-model/).

### Reasoning level

How much a model thinks before it answers; a setting of the chat, next to the model. See [Switch the model or the reasoning level](../../chatting/model-and-reasoning/).

### Risk class

The group a tool call belongs to, by what it can do: *Read*, *Read sensitive data*, *Change*, *Overwrite with no way back*, *Execute*, *External services*. The mode decides per class whether Snotra asks. See [Why Snotra asks before it acts](../../safety/why-snotra-asks/).

### Sandbox

The enclosure around the commands and Python programs Snotra runs on macOS and Linux: they may write only in the open folder and reach only the hosts they were allowed. Windows has none. See [Run commands in the sandbox](../../safety/sandbox/).

### Sensitive

A file or content that looks like a secret — `.env`, a private key, a token. Targeted access asks first (except in *Auto*), and broad searches leave such files out. See [See and change what Snotra may do](../../safety/tools-and-security/).

### Session allowance

A yes from an approval card that holds for the rest of one chat — exactly this tool on exactly these targets. It ends when you leave the chat, change its mode or a rule, or restart Snotra. See [Answer an approval request](../../safety/approve-a-request/).

### Skill

A folder with a `SKILL.md` that tells the model how to do a kind of task. You switch skills on under *Settings › Skills*. See [Use skills](../../customising/skills/).

### Smart

One of the three [modes](#mode), and the default: reading in the open folder runs, everything else asks first.

### System prompt

Your own instructions for every chat, under *Settings › General*. Empty by default. See [Find your way around the settings](../../customising/settings/).

### Token

The unit a model counts text in; roughly four characters. The size of a request is shown in tokens.

### Tool

Something Snotra can do on its own account: read, search or change a file, run a command, search the web, generate an image. See [Set up the built-in tools](../../customising/built-in-tools/).

### Tool log

The summary above an answer that lists what Snotra read, changed and ran. See [Follow what Snotra does](../../chatting/follow-the-work/).

### Tool round

One go of the model calling tools and getting their results. The number in a row is limited by *Max. tool rounds* under *Settings › General*, 14 by default, so that a loop cannot run for ever.
