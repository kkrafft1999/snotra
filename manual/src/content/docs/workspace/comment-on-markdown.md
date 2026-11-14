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
- **The preview marks the passage** with a light wash and a small speech bubble after it. Click the bubble or the passage, or move to the bubble with `Tab` and press `Enter`, to read the comment with its author, its date and any replies underneath. `Esc` closes it.
- **The agent reads the comments with the file.** Ask it to "work through the comments in concept.md": it changes the text as asked and then removes the comments it has addressed. Comments it did not address stay.
- **Nothing is overwritten silently.** As with editing, Snotra checks that the file on disk is still the one you selected in. If another program changed it, the comment is not written; the preview shows the new version and you select again.
- Other Markdown viewers that don't know CriticMarkup — GitHub, for one — show the marks as plain text.

## Reply to a comment

[since 1.32.1] A comment can be answered right where it is, so that question and answer stay together.

1. Open the comment: click its speech bubble or the passage.
2. Click *Reply* at the bottom of the comment.
3. Type your reply and click *Reply*, or press `Cmd+Enter` / `Ctrl+Enter`. `Esc` or *Cancel* goes back to the comment.

![The middle column with crop-rotation.md: the opened comment by Grace Hopper "Beans or peas?" on "beans next year", and at its bottom the box "Your reply" with a reply typed in, the line "As Ada Lovelace" and the buttons Cancel and Reply.](screenshots/markdown-reply.webp)

The reply is written into the file right after the comment, as one more comment in the same notation: `{==beans next year==}{>>Grace Hopper, 2026-11-12: Beans or peas?<<}{>>Ada Lovelace, 2026-11-14: Peas, the beans had it last year.<<}`. Snotra reads comments that follow each other like this as one thread and shows them under the first; the agent reads them as the conversation they are. The comment opens again with your reply under it.

## Delete a comment

[since 1.32.1] A comment in the wrong place, or one that has done its job, can be taken out again — yours or anyone else's.

1. Open the comment.
2. Click *Delete comment* at the bottom right of the comment.
3. Snotra asks in the same place and says how many replies go with it. Click *Delete*. *Cancel* or `Esc` keeps the comment.

![The middle column with crop-rotation.md: the opened comment by Grace Hopper on "beans next year" with a reply by Ada Lovelace, and at its bottom the question "Delete this comment and 1 reply?" with the note that the marked text stays, and the buttons Cancel and Delete.](screenshots/markdown-delete.webp)

The comment and all its replies leave the file; the words they were on stay as they were: `{==beans next year==}{>>…<<}{>>…<<}` becomes `beans next year`. A single reply cannot be deleted on its own.

## If it doesn't work

- ***Comment* is greyed out and says Snotra is working.** Wait until the chat answer is finished, or stop it.
- ***Select text within one paragraph, heading, list item or table cell.*** A comment stays inside one of them. Comment each part on its own.
- ***Code cannot be commented.*** Code blocks and `code` in a sentence stay as they are. Comment the sentence around it.
- ***This text occurs more than once here.*** The same words appear several times in the paragraph, and Snotra cannot tell which you meant. Select a few more words.
- ***This passage cannot be traced back to the file exactly.*** Some formatting — raw HTML, an image, an unusual link — sits in the way. Select a little less or a little more.
- ***This passage overlaps a comment that is already there.*** Comments don't nest. Select a passage beside it.
- ***The file was changed on disk and has been reloaded. Your reply is still here …*** Another program saved the file while you were writing. The comment opens again with your text in the box: check the comment, then send it again.
- ***This comment can no longer be found in the file.*** The comment was changed or removed elsewhere in the meantime. Open it again in the reloaded preview.
- ***The file was changed on disk and has been reloaded. Nothing was deleted.*** Another program saved the file in the meantime. The comment opens again with this note: check that it is still the one you meant, and delete it again.
- **To change a comment or a single reply,** switch to *Source* and [edit](../edit-a-file/) the text between `{>>` and `<<}`. A reply is the `{>>…<<}` after its comment.
