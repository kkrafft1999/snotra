---
title: Set up the built-in tools
description: The tools Snotra brings along, which of them need setting up, and where — Python, web search and image generation.
sidebar:
  order: 8
---

Snotra comes with its own tools for reading, changing, running and searching. Most work right away; three need something from you first.

## The built-in tools

| Risk class | Tools | Ready? |
| --- | --- | --- |
| *Read* | `list_directory`, `read_file_text`, `read_file_lines`, `list_directory_tree`, `find_files`, `search_in_files`, `stat_path`, `outline_file`, `extract_document_text` (PDF, Word, Excel, PowerPoint), `load_skill` (the instructions of a skill that is on), `get_configuration` (which skills and tools this chat has), `search_manual` and `read_manual_page` (this manual), `propose_config_change` (suggests switching one on or off for this chat — you decide on a card) | yes |
| *Change* | `write_file_text`, `edit_file`, `apply_patch`, `remember`, `generate_image` | yes — `generate_image` needs an OpenAI key |
| *Execute* | `shell_execute`, `run_python` | off until you switch them on |
| *External services* | `fetch_url`, `web_search` | `web_search` needs a Tavily key |

Each tool can be switched off on its own under *Settings › Tools & security*, in the row of its risk class. What the classes mean is on [Why Snotra asks before it acts](../../safety/why-snotra-asks/).

**Questions about Snotra itself.** [since 1.22] Ask how to do something in Snotra, where a setting is or why something does not work, and the model looks it up in this manual with `search_manual` and reads the page with `read_manual_page` — in the language of the app — and links the page it used; the link opens in the help window. Both read only the manual that ships with your version: none of your files, nothing on the internet, so they never ask first.

## Python

`run_python` runs Python code the model writes — for calculations, data and charts.

1. Switch it on under *Settings › Tools & security › Execute › Allow Python execution*. Read [Run commands in the sandbox](../../safety/sandbox/) first.
2. Snotra looks for Python 3 by itself. To use a particular interpreter — a virtual environment with `pandas`, say — enter its path under *Settings › Tool setup › Python interpreter* and click *Apply*.

Snotra never installs packages by itself; the interpreter you choose decides which ones the model has.

## Web search

`web_search` searches the internet through **Tavily** and returns a title, an address and a short excerpt per hit.

1. Get a key at [app.tavily.com](https://app.tavily.com); there is a free plan.
2. Enter it under *Settings › Tool setup › Web search › Tavily API key* and click *Save key*.

The search query leaves your computer, so in *Smart* Snotra asks before every search. To read a whole page, the model uses `fetch_url`, which needs no key.

## Image generation

`generate_image` draws with your OpenAI key — see [Generate an image](../../chatting/generate-images/). Under *Settings › Tool setup › Image generation* you choose which of OpenAI's image models draws, then click *Apply*.

## If it doesn't work

- ***No Python 3 found.*** Install Python 3, or enter the path of your interpreter. The line under the field says where Snotra looked.
- ***Snotra could not check for Python.*** The search itself failed — it says nothing about whether Python is installed. Close the settings and open them again; Snotra then searches anew.
- **The model does not search the web.** Without a Tavily key, `web_search` is not offered to the model at all.
- **A tool is never used.** Click the skills pill in the chat bar: a missing tool is listed first, with the reason and a button to the setting. Under *Settings › Tools & security* its row says *Off* or names the tool as switched off.
