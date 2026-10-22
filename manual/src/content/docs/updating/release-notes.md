---
title: Read the release notes
description: Where to see what a new version changes for you before you install it, and how to read the warnings in it.
sidebar:
  order: 2
---

Before you download a version, you can see what it changes for you. The update dialog shows the notes written for you, in the language of the interface.

## Steps

1. When the update dialog offers a version, click *What has changed* under the text. The notes unfold in the dialog; long ones scroll.
2. Read the points from top to bottom. Each one starts with a sentence in bold that says what you will notice: a new feature, a changed default, something that works differently, a problem that is fixed.
3. Look for a quoted paragraph at the top. That is where a release warns you about something — a setting that needs to be set up again, a step you take by hand, a version you cannot go back from.
4. Then decide: *Download*, *Remind me later* or *Skip this version*. See [Update Snotra Agent](../update-snotra/).

The box is also there in the step *Ready*, after the download, in case you want to read the notes before the restart.

## What you see

[since 1.25] The dialog shows only what changes for you. Work behind the scenes — tests, build, documentation, internal restructuring — is left out. If a version brings nothing you will notice, the notes say so in one sentence.

The notes follow the interface language: switch it under [*Settings › General*](../../customising/settings/#the-section-general), and the open dialog switches with it. The complete list of every change, with links to the pull requests, is in the [releases on GitHub](https://github.com/kkrafft1999/snotra/releases), in English. On an installation that cannot update itself, the dialog's button *Open release page* takes you there. On GitHub you also find the notes of versions you skipped or of older ones.

## Ask Snotra about versions

[since 1.27.2] You don't have to open a dialog to find out what a version changed. Ask in the chat:

- *What has changed since 1.25.0?* — everything between that version and the one you have installed.
- *What's new in my version?* — the notes of the installed version.
- *Is there a newer version, and what would it bring me?* — the notes of the versions after yours.

Snotra reads the notes of the releases with the tool `list_release_notes`, in the language of the interface, and answers grouped — what is new, what got better, what was fixed — with the version numbers, and links the manual page where a feature is described. For that it asks GitHub for the public list of releases, the same request as the update check; nothing of your files or of the chat goes along, so it does not ask first. The request goes out only when you ask, whatever the setting *Check for updates at start-up* says.

## If it doesn't work

- **There is no *What has changed* box.** The release has no notes written for you — versions before 1.25 don't. The release page still shows what changed.
- **You want the notes of a version you already installed.** The dialog only shows them while an update is offered. Ask Snotra in the chat, see above, or read them on the [releases page](https://github.com/kkrafft1999/snotra/releases).
- **Snotra says it could not read the release history.** The lookup needs a connection to GitHub, and GitHub limits requests from a shared network after a while. Try again later; the notes are also on the [releases page](https://github.com/kkrafft1999/snotra/releases). Snotra does not fill the gap from memory.
- **Snotra says a version has no notes for you.** Versions before 1.25 have none; Snotra names them and does not make up changes.
