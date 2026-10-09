---
title: Questions about permissions
description: Short answers to what puzzles people most about approvals — why Snotra asks again, why it does not ask, why a call is refused without a card — with the page that explains each in full.
sidebar:
  order: 3
---

Snotra decides for every tool call whether it runs, asks you first or is refused. Most surprises have a short answer; the pages under *Modes, permissions and safety* give the long one.

## What you need

A chat in which Snotra asked, did not ask, or refused something. The tool log above the answer shows how each step ended — *denied*, *blocked*, *expired* — and a hover over the step gives the details: [Follow what Snotra does](../../chatting/follow-the-work/).

## Why does Snotra ask again, although I allowed it?

- *Allow once* covers this one call only.
- *Allow for this session* covers the same tool on exactly the same targets, in this chat. Another file, another chat, a changed mode or rule, or a restart asks again.
- *Always allow this command* remembers one command line exactly. Another spelling — one more option, another working folder, other network access — is another command.
- Some kinds cannot be allowed beyond one call: overwriting with no way back, and external services such as web search or MCP tools. In *Smart* they ask every time.

[Answer an approval request](../../safety/approve-a-request/) explains each button.

## Why did Snotra not ask?

- In *Smart*, reading inside the open folder runs without asking.
- An allowance applies: one for this session, one for good, or a remembered command. *Settings › Tools & security* lists them, and revokes them: [See and change what Snotra may do](../../safety/tools-and-security/#revoke-an-allowance-or-reset).
- The chat is in *Auto*, or the folder has *Auto* as its default. The mode pill in the chat input shows it: [Choose a mode](../../safety/choose-a-mode/).

## Why was a call refused without a card?

- **A block covers it.** A block wins in every mode. The row of the risk class under *Settings › Tools & security* lists your blocks.
- **The tool is switched off.** Shell commands and Python are off until you switch them on, in the row *Execute*.
- **The target is never offered:** your home folder as a whole, the root of a disk, Snotra's own storage, and for writing places with credentials such as `~/.ssh`.
- **You denied the same call before** in this run. Asking unchanged ends the run; the denial stands.

## Why does a command fail although I allowed it?

On macOS and Linux every command runs in a sandbox, and your approval does not lift it. Look for the box *The sandbox blocked …* under the tool log: it says what the command tried to reach. [Run commands in the sandbox](../../safety/sandbox/) shows how to allow it for the next run.

## Why does the card say *Request expired*?

While the card waited, something it was based on changed: the chat, the folder, the mode or a rule. The run ends. Ask again if you still want it.

## Why can I not choose *Auto*?

*Auto* and remembered commands need the system's encrypted storage, so that nobody can change your permissions behind your back. Without it — on a Linux desktop without a keyring, for example — *Smart* and *Always ask* work as usual. See [Keychain questions and encrypted storage](../keychain-and-storage/).

## Why does the pill read *Auto · not isolated*?

In this folder, commands and Python would run without the sandbox and without asking: you switched the sandbox off for the folder, or the system has none, as on Windows. The mode menu says which.

## If it doesn't work

- **The permissions file was damaged or altered.** *Settings › Tools & security* says so. Snotra then runs in *Smart*, or in *Always ask* if that was set; allowances are discarded, blocks stay in force. Set up what you need again.
- **You want to start from scratch.** *Reset workspace rules* or *Reset all permissions*, at the bottom of *Settings › Tools & security*.
