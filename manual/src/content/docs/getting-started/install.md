---
title: Install Snotra Agent
description: Download Snotra Agent for macOS, Windows or Linux and install it.
sidebar:
  order: 1
---

Snotra Agent is a desktop app for macOS, Windows and Linux. There is no account to create: you download one file, install it and start it.

## What you need

- **macOS:** a Mac with Apple silicon (M1 or later) and macOS 13 Ventura or later.
- **Windows:** 64-bit Windows 10 or 11.
- **Linux:** a 64-bit (x64) distribution. The `.deb` package fits Debian, Ubuntu, Linux Mint, Pop!_OS and their relatives; the other two variants run anywhere.
- **For chatting, later on:** an API key from OpenAI, Anthropic or Google, or a language model running on your own computer. [Connect a model](../connect-a-model/) explains both.

## Download

Every version is on the [releases page on GitHub](https://github.com/kkrafft1999/snotra/releases/latest). Under *Assets*, pick the file for your system:

| System | File |
| --- | --- |
| macOS (Apple silicon) | `Snotra-Agent-<version>-mac-arm64.dmg` |
| Windows (x64) | `Snotra-Agent-<version>-win-x64.zip` |
| Linux (x64) | `Snotra-Agent-<version>-linux-x64.deb` (recommended), `.AppImage` or `.tar.gz` |

## Install on macOS

1. Open the downloaded `.dmg`.
2. In the window that opens, drag *Snotra Agent* onto the *Applications* folder.
3. Eject the disk image, then start Snotra Agent from *Applications* or Launchpad.
4. macOS asks once whether you want to open an app downloaded from the internet. Confirm with *Open*.

The app is signed by its developer and notarised by Apple, so this one question is all macOS asks.

## Install on Windows

1. Right-click the downloaded `.zip` and choose *Extract All…*. Pick a place inside your user folder, for example `C:\Users\<you>\Snotra Agent`.
2. Open that folder and start `Snotra Agent.exe`.
3. Windows SmartScreen warns that it does not recognise the app, because the Windows build is not signed yet. Click *More info*, then *Run anyway*. Windows asks this only on the first start.

Keep the app in a folder you can write to — not in `C:\Program Files`. Snotra updates itself by replacing its own folder, and it cannot do that where Windows asks for administrator rights. To start it from the Start menu or the taskbar later, pin `Snotra Agent.exe` there with a right-click.

## Install on Linux

There are three variants. Use the `.deb` if your distribution takes it.

**`.deb` — recommended** for Debian, Ubuntu, Linux Mint, Pop!_OS and their relatives:

```bash
sudo apt install ./Snotra-Agent-<version>-linux-x64.deb
```

Snotra Agent then appears in your application menu. The package also installs `bubblewrap`, `socat` and `ripgrep`, which Snotra needs to run shell commands and Python in a sandbox. It is the only variant in which the app's own sandbox comes fully set up. A `.deb` installation does not update itself: install the next version the same way.

**AppImage** — one file, no installation, no administrator rights:

```bash
chmod +x Snotra-Agent-<version>-linux-x64.AppImage
./Snotra-Agent-<version>-linux-x64.AppImage
```

The file loses its execute permission on the way through the browser, which is why `chmod +x` is needed once.

**Tarball** — the fallback if neither of the others fits:

```bash
tar -xzf Snotra-Agent-<version>-linux-x64.tar.gz
cd snotra-agent-<version>-linux-x64
./"Snotra Agent"
```

With the AppImage or the tarball, install the sandbox packages yourself: `sudo apt install bubblewrap socat ripgrep`, or the equivalent for your distribution.

## What happens

Snotra Agent opens an empty window: no folder, no model yet. [The first start](../first-start/) shows what you see there and what to do next.

Settings and chats are kept in a profile folder of their own, outside the app: `~/Library/Application Support/Snotra AI` on macOS, `%APPDATA%\Snotra AI` on Windows and `~/.config/Snotra AI` on Linux. It carries the name of the platform, Snotra AI, and stays in place when you update or reinstall the app. Later versions install themselves after you confirm; [Update Snotra Agent](../../updating/update-snotra/) shows how.

## If it doesn't work

- **Windows offers no *Run anyway*.** The button only appears after you click *More info*. On a computer managed by an organisation, a policy may block unsigned apps altogether; then only your IT department can allow it.
- **Linux, tarball: the app does not start and reports** *The SUID sandbox helper binary was found, but is not configured correctly.* Some distributions, Ubuntu 24.04 and later among them, restrict what the browser engine inside Snotra needs. Fix it once inside the extracted folder:

  ```bash
  cd snotra-agent-<version>-linux-x64
  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
  ```

- **Linux, AppImage: the app does not start on Ubuntu 24.04 or later.** Same cause as above, but the fix does not work inside an AppImage, which is mounted read-only. Use the `.deb` instead.
