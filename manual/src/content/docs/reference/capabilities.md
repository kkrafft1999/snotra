---
title: What Snotra can and cannot do
description: Everything Snotra can do on one page — reading, changing and running things in your folder, the web, images, memory, skills and MCP servers — what it cannot do, and where each part is explained.
sidebar:
  order: 0
---

Snotra is a desktop app for macOS, Windows and Linux. You open one folder, the file tree stays in view, and the chat works inside that folder with the model you connected. There is no web version and no terminal session: what the model does, it does through the tools below, and each of them can ask you first.

This page is the overview. Every row links to the page that explains it.

## What it can do

| Area | What Snotra does | Read more |
| --- | --- | --- |
| Read | Lists folders, finds files by name, searches their text, reads them, outlines code and reads the text of PDF, Word, Excel and PowerPoint files | [Set up the built-in tools](../../customising/built-in-tools/) |
| Change | Creates and edits files in the open folder; before a file is replaced as a whole, a copy goes to the trash | [See what Snotra changed](../../chatting/review-changes/) |
| Run | Runs shell commands and Python code — off until you switch them on, and isolated in a sandbox on macOS and Linux | [Run commands in the sandbox](../../safety/sandbox/) |
| The web | Searches the web (with a Tavily key) and fetches a single page | [Set up the built-in tools](../../customising/built-in-tools/#web-search) |
| Images | Draws an image with your OpenAI key and saves it in the folder; reads screenshots you paste into a message, when the model understands images | [Generate an image](../../chatting/generate-images/), [Write a message](../../chatting/write-a-message/) |
| Dictation | Turns speech into text in the message field, with OpenAI access | [Write a message](../../chatting/write-a-message/) |
| Memory | Keeps facts for this folder or for you across chats | [Let Snotra remember](../../customising/memory/) |
| Skills | Follows instructions you give it as skills — built in, for one folder or for all of them — and can write a new skill into the open folder | [Use skills](../../customising/skills/), [Let Snotra write a skill](../../customising/write-a-skill/) |
| MCP servers | Uses the tools of MCP servers you connect: tickets, a database, a calendar, anything a server offers | [Connect an MCP server](../../customising/mcp-servers/) |
| Models | Works with OpenAI, Anthropic and Google in the cloud; with Ollama, LM Studio and any server with an OpenAI-compatible interface on your machine or in your network; and through gateways such as OpenRouter | [Connect a model](../../getting-started/connect-a-model/) |
| Questions about Snotra | Looks the answer up in this manual and links the page it used | [Set up the built-in tools](../../customising/built-in-tools/#the-built-in-tools) |

What a chat may do on its own depends on its mode and on the risk class of each tool — see [Why Snotra asks before it acts](../../safety/why-snotra-asks/).

## What it cannot do

- **No audio and no video.** Snotra generates images, nothing else.
- **No mail, messages, calendar or tickets of its own.** That comes only through an MCP server you connect.
- **No Office files or PDFs written.** Snotra reads their text, but no tool creates or changes them.
- **No work outside the open folder unasked.** A path outside it is asked about on a card in every mode; your home folder as a whole, the root of a disk and Snotra's own storage are never offered.
- **No commands that keep running.** Each command or Python call runs once and ends: nothing is kept between calls, nothing waits for input, nothing stays in the background.
- **No changes to its own settings.** The model can suggest switching a skill or tool on for the chat, but only your click on that card does it — the mode, keys and lasting settings stay yours.

## Without an open folder

You can chat without opening a folder, but the model then has no tools to change or run anything. It can still read the folders of the skills that are on, search the web, fetch a page, use MCP servers and look things up in this manual. A skill has nowhere to keep its data until a folder is open.

## Limits

| Limit | Value |
| --- | --- |
| Size of a file the model writes or edits | 2 MB |
| Images per answer | 4 |
| Memory per level (this folder, everywhere) | 8,000 characters |
| A page fetched from the web | one `http` or `https` address per call, text only, never an address on your local network |

## If it doesn't work

- **The model says it cannot do something this page says it can.** The tool is probably switched off or not set up. Click the skills pill in the chat bar: a missing tool is listed with the reason and a button to the setting.
- **A tool is missing although it is switched on.** Some tools only appear once they are set up — `web_search` with a Tavily key, `generate_image` with an OpenAI key, `run_python` with Python 3. See [Set up the built-in tools](../../customising/built-in-tools/).
