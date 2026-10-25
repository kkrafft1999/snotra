---
title: Follow what Snotra does
description: The tool log above each answer shows which files Snotra read, which it changed, and what it ran.
sidebar:
  order: 4
---

Snotra does not only answer; it reads files, changes them and runs commands on the way. Each answer keeps a log of these steps, so you can see what the answer rests on.

## What you need

A chat in which Snotra used its tools — for most questions about the folder, it does.

## Read the tool log

While Snotra works, the steps appear above the answer one by one: *File src/calendar.js read*, *File notes/spring-2026.md changed*. A line that is still running shows it; *Model is thinking …* stands there while the model works out its next step.

Once the answer is complete, the steps fold into one line that counts them, such as *2 files written · 2 files read*. Click it to unfold them again.

![An answer with its tool log unfolded: "2 files written · 2 files read", below it the four steps — src/calendar.js and plants.csv read, src/calendar.js and notes/spring-2026.md changed, each change with its count of added and removed lines — then the line "Changed:" with calendar.js and spring-2026.md, the answer text, and under it "Answered in 4.2 sec".](screenshots/tool-log.webp)

- A change carries its count of added and removed lines, for example `+2 −1`.
- A step that did not run says why: *denied* when you said no on the card, *blocked* when a rule stopped it, *expired* when the request lapsed. Hover over it for the details.
- A step that came from a skill names the skill.
- [since 1.22] A look into this manual reads *Searched the manual for “…”* or *Manual page … read*; folded, it counts as *1 look into the manual*. The answer then links the page it used; a click on such a link opens the page in the help window, as written for the version you have installed.

## When the sandbox stopped something

If a command or a Python run on macOS or Linux tried to reach something the sandbox keeps closed — a folder outside the project, a host it was not allowed — a box *The sandbox blocked …* appears under the tool log. It lists what was blocked, how often, and why. That is usually the reason a command failed in a way its own output does not explain. [since 1.18] For a write or a read of a protected location, a card asks right after the run whether to allow it and run the command again; a connection to a host the call did not name waits for you on a card while the command runs. The box then also says what you decided; [since 1.21] once you have answered everything, the card gives way to it, and it folds to one line that opens on a click. More on [Run commands in the sandbox](../../safety/sandbox/).

## When a result reads like instructions

[since 1.27.1] Some text is written for the model rather than for you: a web page that says *ignore all previous instructions*, a file that poses as a message from Snotra, characters you cannot see. When a tool result contains something like that, a box *A tool result reads like instructions to the agent* appears under the tool log. It names the step, says what kind of text it found, and quotes it.

![An answer whose tool log reads "1 file read". Below it a box: "A tool result reads like instructions to the agent · File notes/seed-catalogue.md read", the kind "Tells the agent to ignore what it was told" with the quoted sentence from the file, a note that what the agent may do has not changed, and the link "What this check does". Then the answer, which says it left the request in the file alone.](screenshots/injection-flag.webp)

Nothing about what Snotra may do has changed: the next tool call is checked like every other one, and cards and the sandbox apply as before. Look closely at what it proposes next — a command you did not expect, a file that has nothing to do with the task, an address you don't know. If something seems off, deny the card or stop the run. Why the box can be wrong both ways: [Why Snotra asks before it acts](../../safety/why-snotra-asks/#when-a-tool-result-looks-like-instructions).

## How long an answer took

[since 1.27.5] Under each finished answer, a small line says how long it took: *Answered in 4.2 sec*, *Answered in 3:05 min*. The time runs from the moment you send the message until the answer is complete — thinking, tool steps and the text all count, and so does the time a card waited for your decision. A turn you stopped reads *Stopped after …*; one that ended with an error carries *Failed after …* under the error. Hover over the line for what it measures. The duration is kept with the answer, so it is still there when you open the chat again.

## What happens

The tool log stays with the answer, also in the chat history. Files Snotra read or changed are marked in the file tree as well, and the line *Changed:* under the log leads to each change: [See what Snotra changed](../review-changes/).

## If it doesn't work

- **An answer has no tool log.** The model answered from what it already knew, without using a tool.
- **An answer shows no time under it.** It was written with a version before 1.28, or Snotra was closed or reloaded before it finished — then only the completed steps were kept, and no time.
- **You want to report a problem with a run.** `Cmd+Shift+D` / `Ctrl+Shift+D` copies the diagnostics of the tool log to the clipboard, ready to paste into a bug report.
