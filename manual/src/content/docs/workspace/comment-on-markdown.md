---
title: Comment on a Markdown file
description: Select a passage in the preview and write a comment on it — it goes into the file, so the agent and everyone else who opens the file see it.
sidebar:
  order: 7
---

[since 1.32] Reviewing a concept or a note works the way it does in a word processor: select a passage in the formatted preview, type what you think, move on. Later you can ask the agent to work through the comments.

![The middle column with crop-rotation.md in the preview: "beans next year" carries a light wash and a speech bubble; below "the north bed" a small form with the selected words, the comment "Only five hours of sun there.", the line "As Ada Lovelace" and the buttons Cancel and Comment.](screenshots/markdown-comment.webp)

## What you need

- An open folder and a Markdown file from it in the [preview](../preview/), on its *Preview* side.
- No chat answer is running. While the agent works, comments wait, as [editing](../edit-a-file/) does.
- Optional: a name under [*Settings › General*](../../customising/settings/#the-section-general), *Name for comments*. Without it Snotra signs with the full name of your user account, as it does in a PDF.

## Steps

1. Select a passage with the mouse or the keyboard — a few words, a sentence, a cell of a table.
2. Click *Comment* next to the selection, or press `Option+Cmd+M` / `Ctrl+Alt+M`.
3. Type the comment and click *Comment*, or press `Cmd+Enter` / `Ctrl+Enter`. `Esc` cancels.

## What happens

- **The comment is written into the file.** The passage becomes `{==the version scheme==}{>>Ada Lovelace, 2026-11-14: Semantic versioning, or a date?<<}` — CriticMarkup, a plain-text convention for comments. The comment travels with the file: through Git, a synced folder, an e-mail.
- **The preview marks the passage** with a light wash and a small speech bubble after it. Click the bubble or the passage, or move to the bubble with `Tab` and press `Enter`, to read the comment with its author and date. `Esc` closes it.
- **The agent reads the comments with the file.** Ask it to "work through the comments in concept.md": it changes the text as asked and then removes the comments it has addressed. Comments it did not address stay.
- **Nothing is overwritten silently.** As with editing, Snotra checks that the file on disk is still the one you selected in. If another program changed it, the comment is not written; the preview shows the new version and you select again.
- Other Markdown viewers that don't know CriticMarkup — GitHub, for one — show the marks as plain text.

## If it doesn't work

- ***Comment* is greyed out and says Snotra is working.** Wait until the chat answer is finished, or stop it.
- ***Select text within one paragraph, heading, list item or table cell.*** A comment stays inside one of them. Comment each part on its own.
- ***Code cannot be commented.*** Code blocks and `code` in a sentence stay as they are. Comment the sentence around it.
- ***This text occurs more than once here.*** The same words appear several times in the paragraph, and Snotra cannot tell which you meant. Select a few more words.
- ***This passage cannot be traced back to the file exactly.*** Some formatting — raw HTML, an image, an unusual link — sits in the way. Select a little less or a little more.
- ***This passage overlaps a comment that is already there.*** Comments don't nest. Select a passage beside it.
- **To change or delete a comment,** switch to *Source*, [edit](../edit-a-file/) the text between `{>>` and `<<}`, or remove the whole mark.
