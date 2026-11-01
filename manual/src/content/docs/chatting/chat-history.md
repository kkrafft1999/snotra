---
title: Continue an earlier chat
description: Start a new chat, go back to an earlier one, let a chat work on in the background, keep the ones that matter, and delete what you no longer need.
sidebar:
  order: 7
---

Snotra keeps your chats. You can start a new one at any time, go back to an earlier one and continue where you left off.

## What you need

Nothing; every chat you send a message in is saved.

## Show the history

Click the rightmost button in the title bar, *Show chat history*. The history appears as a column next to the chat, newest chat first. It holds the chats of the open folder only: every folder keeps its own. Click the button again to hide it.

![The chat column with the chat "Garden Planner overview", and next to it the history column with three chats — Garden Planner overview, Spacing of the radishes, Crop rotation for next year — and the button "New chat" at the top.](screenshots/history.webp)

## Steps

- **Start a new chat:** *New chat* at the top of the history, *File › New Chat*, or `Cmd+N` / `Ctrl+N`.
- **Go back to a chat:** click it in the history. It comes back with its messages, its model, its reasoning level and its mode.
- **Delete a chat:** click the bin next to it and confirm *Delete this chat?* with *Delete*. Images you attached to it go with it.
- [since 1.30] **Keep a chat:** point at it and click the bookmark next to the bin, *Keep chat*. The bookmark stays filled; a kept chat is never removed to make room. Click it again to take the mark off.
- [since 1.30] **Bring back chats from a renamed folder:** when chats belong to a folder that no longer exists, a note above the list says how many, for example *4 chats from folders that no longer exist*. Click *Review*: the chats appear grouped by the folder they were in. *Assign* moves one chat into the folder that is open now, *Assign all* every chat of that old folder.

![The history column. At the top the unfolded note "4 chats from folders that no longer exist" with the old folder "gardening" and three chats, each with "Assign", and "Assign all" next to the folder; below it "balcony-herbs" with one chat. Under the note the folder's own chats; "Garden Planner overview" and "Crop rotation for next year" carry a filled bookmark.](screenshots/history-keep.webp)

## What happens

- **A chat works on in the background.** Switch to another chat while Snotra is still answering, and the answer carries on. The history marks that chat *Working…*, or *Needs your approval* when a card waits for you there; [since 1.18] a system notification says so as well.
- **Snotra picks up where you left off.** At the next start it opens the folder's most recent chat.
- [since 1.25] **A cut-off answer keeps its finished steps.** If Snotra closes or crashes while an answer is under way, or you reload the window with *View › Reload*, the chat keeps every step that had finished. The answer comes back with the note *Interrupted.* under it; send your question again to carry on. A reload stops the answer that was running.
- [since 1.23] **Each chat shows what it cost.** Next to its time, the history shows the chat's estimated API cost, for example *~$0.42*. More on [See what a chat costs](../chat-cost/).
- **A new chat starts fresh:** without the earlier conversation, without marks in the tree, in the folder's default mode.
- [since 1.30] **Every folder keeps its 200 most recent chats.** Beyond that the oldest one goes when a new one is saved — chats you marked *Keep* stay and do not count. What you do in other folders never pushes this folder's chats out; chats without a folder count as a folder of their own.
- [since 1.30] **Assigned chats belong to the open folder from then on:** they appear in its history and open like any other chat. A chat from a missing folder cannot be opened before you assign it.
- [since 1.30] **Above 2,000 chats in all, the history says so.** A note at the end of the list tells you; nothing is removed because of it. Delete the chats you no longer need.

The history is stored encrypted in your profile, not in the project folder.

## If it doesn't work

- **The history column is missing.** The window is too narrow for all columns; the history gives way and comes back in a wider window. Hide the sidebar or the middle column to make room.
- **Chats are missing after you renamed or moved a folder.** They are still there, filed under the old name. Open the folder under its new name and use *Review* in the note above the history to assign them.
- **A folder on an external drive shows up as no longer existing.** While the drive is not connected, Snotra cannot tell it from a deleted folder. Connect the drive instead of assigning its chats elsewhere.
- **An image in an answer of an older chat shows a placeholder.** The image lies in another folder than the one open now, or the file is gone. In answers, Snotra shows images only from the open folder.
