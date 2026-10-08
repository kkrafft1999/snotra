---
title: Create, rename, move and delete
description: Manage the files of the open folder right in the tree, and take in files from Finder or Explorer.
sidebar:
  order: 4
---

You can do the everyday work on files without leaving Snotra: create a file or folder, rename it, move it, delete it, or bring in files from elsewhere.

## What you need

An open folder.

## Create a file or folder

1. Right-click a folder and choose *New File…* or *New Folder…*. On a file, the new entry goes next to it; on the empty space below the rows, into the open folder itself. The same two entries are in the `⋯` menu at the top of the tree, for the folder you selected.
2. A name field appears in the tree. Type the name and press `Enter`. `Esc`, or a click elsewhere, cancels.

A new file is selected and shown in the preview.

## Rename

1. Right-click the row and choose *Rename…*, or press `F2` on the focused row.
2. The name becomes a field, with the part before the extension selected. Type the new name and press `Enter`; `Esc` leaves it as it was.

A renamed file stays on show under its new name; in a renamed folder, the open subfolders and the file on show stay as they were. Changing only the case — `readme.md` to `README.md` — works on every system.

## Move

Drag a file or folder onto a folder row to move it there, or onto the free space below the rows to move it to the top of the open folder. If the name is already taken there, the moved entry is called `name (2).ext`.

## Delete

Right-click the row, choose *Delete…* and confirm. The file or folder goes to the trash, so you can still bring it back from there.

## Take in files from outside

Drag files or folders from Finder or Explorer onto a folder row in the tree, or onto the free space for the open folder. They are **copied**; the originals stay where they are. Several at once work, and a name that is taken becomes `name (2).ext`.

Before a folder, or 20 files or 10 MB and more, Snotra asks first, with the count, the size and the target in plain words and *Cancel* preselected. Files that look like credentials — `.env`, `*.pem`, `id_*`, anything under `.ssh/` — are not taken in: the model could read them later. Copy those yourself if you must.

## What happens

Nothing is ever overwritten: a name that is taken is refused or numbered, never replaced. The tree, the `@` list and the filter show the change at once.

## If it doesn't work

- **The name field says what is wrong while you type.** A name can be taken (*… already exists here*), can contain `/` or `\`, or can be something Windows does not allow — `:`, `?`, a name like `con`, a trailing dot. Snotra refuses those on every system, so the folder stays usable everywhere.
- ***No permission to write in this folder.*** The folder is read-only for you; change that in your file manager.
- **A drop is refused as a whole.** More than 2,000 entries or 200 MB at once are refused rather than copied in part. Copy smaller pieces, or use your file manager.
