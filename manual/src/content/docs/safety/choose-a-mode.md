---
title: Choose a mode
description: Switch a chat between Smart, Always ask and Auto. The folder remembers your pick for its new chats.
sidebar:
  order: 3
---

The mode decides how often Snotra asks you. Every chat has its own, and you switch it at any time. The folder remembers what you picked last: new chats in it start with that mode.

## The three modes

| Mode | Reading | Everything else: sensitive files, changes, commands, external services |
| --- | --- | --- |
| *Smart* — the default | runs | asks first |
| *Always ask* | asks | asks first |
| *Auto* | runs | runs without asking |

- ***Smart*** reads inside the open folder without asking and asks before anything else. Allowances you gave for a session or for good apply.
- ***Always ask*** asks before every tool call, reading included. Allowances do not apply. Choose it for a folder with content you want to watch closely.
- ***Auto*** asks nothing. The folder boundary, your blocks and the protection of Snotra's own keys stay in force; what [holds in every mode](../why-snotra-asks/#what-holds-in-every-mode) holds here too. Switch it on deliberately, for a task you trust.

## Steps

1. Click the mode pill in the chat input. It shows the current mode, for example *Smart*.
2. Pick a mode from the menu.
3. For *Auto*, the operating system asks once more: *Switch on Auto (full access)?* The dialog names the folder, because new chats there will start in *Auto* too. Confirm with *Switch on Auto*.

Going back to *Smart* or on to *Always ask* never asks — making Snotra more careful needs no confirmation.

![The mode menu above the chat input: Smart, Always ask and Auto, each with a short description, "Always ask" selected and tagged "Default in garden-planner". Below, the link "All permissions in Settings › Tools › Autonomy".](screenshots/mode-menu.webp)

## The folder's default mode

[since 1.30] The mode you pick in a chat becomes the folder's default as well. Every new chat in that folder starts with it, also after a restart — *Auto* included. Only a folder in which you have never picked a mode starts in *Smart*.

- The menu marks the default with *Default in ‹folder›*.
- Opening an older chat from the history does not change the default; only picking a mode does.
- You can also set the default without opening a chat: under *Default mode* at the top of *Settings › Tools › Autonomy*. *Auto* is confirmed there in a system dialog that names the folder, with *Make “Auto” the default*.

The default is stored with your permissions, not in the folder. A repository you download cannot make itself *Auto*.

## What happens

- The pill shows the new mode, and every tool call from then on follows it.
- A chat from the history comes back with its own mode.
- After a restart a chat comes back with the folder's default. A chat that is on *Auto* while the folder's default is something else — because you changed the default in the settings afterwards — runs on the default until you open it again from the history.

## If it doesn't work

- **The pill reads *Auto · not isolated*, in amber.** In this folder, commands or Python would run without the sandbox and without asking — because you switched the sandbox off for the folder, or because the system has none (Windows). The menu says which. See [Run commands in the sandbox](../sandbox/).
- ***Auto* cannot be chosen.** It needs the system's encrypted storage, to keep your permissions safe from tampering. Without it — on a Linux desktop without a keyring, for example — *Smart* and *Always ask* work as usual.
- **A new chat does not start with the mode I picked.** The default belongs to the folder the chat was in. In another folder, or with no folder open, new chats start with that folder's default, or with *Smart*.
