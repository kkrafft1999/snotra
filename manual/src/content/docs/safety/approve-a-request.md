---
title: Answer an approval request
description: What the approval card in the chat shows, and what each of its buttons allows.
sidebar:
  order: 2
---

When a tool call needs your approval, Snotra pauses and shows a card in the chat. The run waits until you decide; there is no time limit, and no button is preselected.

## What you need

A chat in *Smart* or *Always ask* and a request from the model that needs approval, for example a change to a file. Which calls ask is explained in [Why Snotra asks before it acts](../why-snotra-asks/).

## What the card shows

![An approval card titled "Confirm change": Snotra wants to change notes/spring-2026.md with edit_file. Below it the effect, the target file, the reason, the session scope and the mode, a preview of the replacement from old to new, and the buttons "Allow once", "Allow for this session" and "Deny".](screenshots/approval-card.webp)

- **The title** names the kind of request: *Confirm change*, *Confirm execution*, *Confirm file access* or *Confirm external access*.
- **The headline** says what Snotra wants to do, on which target, with which tool.
- **The details** list the effect, every target, the reason it asks and the mode. For a sensitive file the card names the provider the content would go to. For a command it adds the shell, the working folder, the network access and whether the run is isolated — see [Run commands in the sandbox](../sandbox/).
- **The preview** shows exactly what would happen: the new content, the replacement from old to new, the patch, the Python source or the full command. Characters you cannot see, such as direction marks, are shown as `⟨U+202E⟩` where they sit, with a warning.

## Steps

Read the card, then choose one of its buttons:

- ***Allow once*** runs this one call.
- ***Allow for this session*** runs it, and lets the same tool on exactly the same targets run without asking for the rest of this chat. The card's *Session scope* line says what that covers. It ends when you leave the chat, change its mode or a rule, or restart Snotra.
- ***Always allow this command*** appears instead on a card for a shell command. It remembers exactly this command line, in this working folder and with this network access, for the open folder. The operating system asks you to confirm it once. Any other spelling of the command asks again.
- ***Deny*** — or `Esc` — refuses the call. The model is told that you said no and can answer without it.

## What happens

The tool line in the chat shows how it ended, for example *denied* or *blocked*, also later in the chat history. An allowance for the session shows up under *Settings › Tools & security* at the bottom of the page, where you can revoke it; a remembered command is listed in the row *Execute*. See [See and change what Snotra may do](../tools-and-security/).

## If it doesn't work

- ***Allow for this session* is missing.** It only exists for reading, reading sensitive data and ordinary changes, and not in *Always ask*. Overwriting with no way back, commands and external services can only be allowed one call at a time.
- ***Always allow this command* is not available.** The line below the buttons says why: only a simple command can be remembered — one program with plain arguments, without chaining, pipes, redirection, variables or quotes. It also needs an open folder and the system's encrypted storage.
- **The card says *Request expired*.** The chat, the folder, the mode or a rule changed while the card was open. The run ends; ask again if you still want it.
