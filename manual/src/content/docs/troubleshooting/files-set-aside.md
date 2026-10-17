---
title: When settings or the history start afresh
description: What the notice under the title bar means when Snotra could not read one of its files, where the old file went, and how to get it back.
sidebar:
  order: 6
---

Snotra keeps your settings, the list of recent folders and the chat history in files in its [profile folder](../logs-and-reports/#the-profile-folder). [since 1.24] If one of them cannot be read, Snotra does not write over it. It puts the file aside unchanged and tells you so in a notice under the title bar.

## What you need

Nothing beyond the app. Showing the old file uses your file manager: Finder on macOS, Explorer on Windows.

## Steps: when a file was put aside

The notice says ***Your model settings were reset.***, ***The chat history starts empty.*** or a similar line, depending on the file. Below it you see the file's name and the full path of the copy Snotra kept, for example `llm-config.json.unreadable-2026-10-16T09-12-44-120Z`.

1. Choose *Reveal in Finder* (*Show in Explorer* on Windows) in the notice to see the copy.
2. Set up again what was reset: your models under *Settings › Models*, the web search key and the MCP servers under *Settings › Tool setup*. The view settings and the list of recent folders fill themselves again as you work.
3. Close the notice with ×. It does not come back for this file until something happens to the file again.

Keep the copy until you are sure you do not need it. Snotra never deletes it.

## What happens

The file could not be understood. Its content was damaged — a crash while it was written, a sync tool, an edit by hand — or it was written by a newer version of Snotra than the one running now, for example after you went back to an older release. Snotra renames the file by adding `.unreadable-` and the time, then starts that part afresh. Every byte of the old file is still in the copy.

For the chat history the copy is the whole folder, `chat-history.unreadable-…`, or `chat-history.undecryptable-…` when it could not be decrypted with this system's key; see [Keychain questions and encrypted storage](../keychain-and-storage/) for that case. [since 1.25] When only one chat's file is damaged, only that file is put aside inside the folder, and the notice says ***One chat could not be read and is missing from the history.*** Your other chats stay. A history from before 1.25 is kept as `chat-history.json.unreadable-…` or `chat-history.json.undecryptable-…`.

## When changes are not saved

A notice in red says ***Changes to your model settings are not saved.*** or the same for another file. Snotra found the file but could not read it or could not move it aside — another program holds it, or its permissions changed. So it leaves the file as it is and skips the save, rather than write over what is in it.

1. Choose *Reveal in Finder* (*Show in Explorer* on Windows) in the notice to see the file.
2. Close the program that may hold it — a sync or backup tool, an editor — or give your user account the right to read and write it again.
3. Change the setting once more.

What happens then: as soon as a save goes through, the red notice disappears by itself.

The chat history has a banner of its own in the chat for this case; see [When a chat is not being saved](../keychain-and-storage/#when-a-chat-is-not-being-saved).

## If it doesn't work

- **I want the old settings back.** Quit Snotra. In the profile folder, delete or rename the new file, then rename the copy back to its original name — `llm-config.json`, for example. Start Snotra. If the copy was damaged, it is put aside again; if it was written by a newer version, install that version again.
- **The notice comes back at every start.** Something keeps damaging the file — most often a sync tool working on the profile folder. Keep the profile folder out of OneDrive, Dropbox or iCloud Drive.
- **The red notice stays.** The file is still held or still not readable. Restart your computer to release every hold on it, then change the setting again.
