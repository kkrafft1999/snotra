---
title: When Snotra cannot update itself
description: Which installations replace themselves and which do not, how to update those by hand, and what to know about the keychain question on macOS and about old Windows versions.
sidebar:
  order: 3
---

Some installations cannot replace themselves. Snotra says so in the update dialog, with the reason, and points to the release page instead of offering a download it could not install.

## What you need

The file for your system from the [release page](https://github.com/kkrafft1999/snotra/releases/latest), the same one you installed from. [Install Snotra Agent](../../getting-started/install/) lists the names.

## Who updates itself

| Installation | Updates itself? | If not |
| --- | --- | --- |
| macOS app in *Applications* | Yes | |
| macOS app started from the disk image, or from a copy macOS has moved aside | No: it cannot write to its place | Move the app to *Applications* and start it from there. |
| Windows folder you can write to | Yes | |
| Windows folder in `C:\Program Files` or another protected place | No: it needs administrator rights | Move the folder to your user folder, or update by hand. |
| Linux AppImage | Yes | |
| Linux tarball in a folder you can write to | Yes | |
| Linux `.deb` package | No: replacing it needs administrator rights | `sudo apt install ./Snotra-Agent-<version>-linux-x64.deb` with the new file. |
| A copy that was started from the source code | No: there is nothing to replace | Update the source code with Git. |

## Steps: update by hand

1. In the update dialog, click *Open release page*, or open the release page yourself.
2. Under *Assets*, download the file for your system.
3. Quit Snotra Agent.
4. Install it the way you installed the first time: on macOS drag the app onto *Applications* and confirm *Replace*; on Windows extract the `.zip` over the old folder or into a new one and delete the old one; on Linux install the `.deb` again, or replace the AppImage or the folder.
5. Start Snotra Agent. Your chats, settings and keys are still there: they are kept in the [profile folder](../../getting-started/install/#what-happens), not in the app.

## What happens

The new version starts with everything you had. The dialog stops offering the version once you run it.

## macOS asks for the keychain

After an update on macOS the system may ask once whether *Snotra Agent* may use the keychain item **Snotra AI Safe Storage**. That is where Snotra keeps the key that encrypts your API keys and your chat history; the item carries the platform's name, Snotra AI. It happens when the signature of the app has changed, as when an older version was replaced by a signed one.

Enter your Mac's password and choose **Always Allow**. *Allow* alone asks again at every start; *Deny* leaves Snotra without its key: it reports *Encrypted storage is not available*, the models disappear from the chat and chats are not saved. Quit Snotra, start it again and allow it when the question appears.

## Old versions

A few older versions need a manual step once. After that, the self-update works as described above.

- **Windows up to version 1.13.2.** The self-update closed the app but left the old version in place, with a folder `.snotra-new-…` next to it. Quit Snotra, rename the app folder (to `Snotra-Agent.old`, say), extract the new `.zip` under the old folder name and start it. Delete the leftover folders afterwards.
- **Windows and the Linux tarball, version 1.16.0 and older.** They cannot install the renamed package *Snotra Agent*. Update by hand once, in the same way; shortcuts to `Snotra AI.exe` have to be created again.
- **macOS, from Snotra AI to Snotra Agent.** The self-update replaces `Snotra AI.app` with `Snotra Agent.app`; add the new app to the Dock again. If you installed by hand from the disk image, delete the old `Snotra AI.app` afterwards.
- **The AppImage and the `.deb` package** carry on as before.

## If it doesn't work

- **The update dialog offers only *Open release page*.** That is the case for the installations in the table above; its text names the reason that applies to yours.
- **Windows: the old version still starts after the update.** You are on one of the old versions above, or a window still had the app folder open. Close it and try again, or update by hand.
