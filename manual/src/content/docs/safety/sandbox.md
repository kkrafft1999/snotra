---
title: Run commands in the sandbox
description: Let Snotra run shell commands and Python, see whether they run isolated, and give a single folder or program more room when it needs it.
sidebar:
  order: 5
---

Snotra can run shell commands and Python code: `git status`, a build, a test run, a script that sorts your data. Both are off until you switch them on. On macOS and Linux every run then happens in a sandbox, which keeps a command inside your project folder.

## What you need

- **macOS:** nothing; the sandbox is built in.
- **Linux:** the packages `bubblewrap`, `socat` and `ripgrep`. The `.deb` installs them; with the AppImage or the tarball run `sudo apt install bubblewrap socat ripgrep`.
- **Windows:** there is no sandbox yet. Every command and every Python run has your full rights — it can read and write anywhere, reach the network and start programs. Snotra says so on every card, and the card shows you the complete command before it runs.

## Switch on commands and Python

1. Open *Settings › Tools & security* and open the row *Execute*.
2. Switch on *Allow shell commands*, *Allow Python execution*, or both.

Commands run in your login shell on macOS and Linux (zsh, bash …), with the `PATH` from your shell profile, and in PowerShell or `cmd.exe` on Windows. Python is looked for automatically; to use a particular interpreter — a virtual environment with the packages you need, say — set it under *Settings › Tool setup*.

## What the sandbox allows

A command or a Python run in the sandbox

- writes only in the project folder and a temporary folder,
- cannot read your keys, cloud credentials, shell histories or browser data,
- reaches the network only for the domains the call names. You approve them on the card; in *Auto* they are not asked about. `pip install` and `npm install` get their package registry automatically.

What it does not do: it does not stop a run from *reading* your other files, and what it read can reach a domain you allowed. Snotra also blocks recursive forced deletion such as `rm -rf`, disk operations and rewriting Git history — an extra safeguard, not complete protection, since a script in between gets around any list of patterns.

## See whether a run is isolated

**On the card.** A card for a command carries the badge *Isolated* or, in amber, *Not isolated* with the reason and a link to the sandbox setting. It also lists the shell, the working folder and the network access.

![An approval card titled "Confirm execution" with the badge "Isolated": Snotra wants to run a command in zsh. Below it the shell, the working folder, network "No access", the reason and the mode, the note that the run writes only in the project folder and a temporary folder, the command node src/calendar.js, and the buttons "Allow once", "Always allow this command" and "Deny".](screenshots/shell-approval.webp)

**Next to the folder name.** While commands or Python are switched on, a shield stands next to the name of the folder at the top of the sidebar: a plain shield while runs in this folder are isolated, a struck-through amber one while they are not. Click it to get to the sandbox setting.

![The top left of the window: the shield next to the folder name garden-planner, above the file tree.](screenshots/sandbox-shield.webp)

## Switch the sandbox off for one folder

When the sandbox gets in the way of something legitimate in one project — writing to a sibling repository, a tool that needs the network, an older `pip` in a virtual environment:

1. In *Settings › Tools & security*, open the row *Execute*.
2. Under *Sandbox for this workspace*, switch it off.
3. The operating system asks: *Run without sandbox in this workspace?* Confirm with *Run without sandbox*.

It applies to that one folder only, never to all of them, and it is stored with your permissions, not in the folder. From then on every card in the folder says *Not isolated*, the model is told so as well, and in *Auto* the mode pill reads *Auto · not isolated*. *Reset workspace rules* switches the sandbox back on.

## Give one program more room

Often it is a single program that needs more — a tool whose login has to be refreshed, or `gh` and `terraform` on macOS, which cannot reach the network inside the sandbox. Give that program an allowance instead of switching the sandbox off:

1. In the row *Execute*, under *Program allowances*, click *Add program*.
2. Under *Program*, enter its name as you type it in the terminal, or its full path. Snotra shows which file it found.
3. Add the *Domains it may reach*, one per line, and under *Folders it may also write in* any folder it keeps its data in.
4. On macOS, tick *Check certificates through macOS* for programs written in Go, such as `gh` and `terraform`. It weakens the isolation a little; the dialog says how.
5. Click *Save* and confirm in the system dialog.

The allowance applies in every folder, but only when a command runs that program on its own — without chaining, pipes or redirection — and only to the very file you chose, not to a file of the same name in a project. The card names the allowance, or says why it does not apply.

## If it doesn't work

- **Linux: the card says the sandbox needs packages.** Install `bubblewrap`, `socat` and `ripgrep` and restart Snotra.
- **Linux: *the sandbox does not start on this system*.** Ubuntu 24.04 and later restrict unprivileged user namespaces, which the sandbox needs. Lifting that is a system-wide decision and yours to make:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  It lasts until the next reboot; to keep it, put the same setting into a file under `/etc/sysctl.d/`. An AppArmor profile that grants user namespaces to `bwrap` works as well. Restart Snotra afterwards.
- **macOS: `gh`, `terraform` or another Go program cannot reach the network.** Give it a program allowance with *Check certificates through macOS*.
- ***Sandbox for this workspace* cannot be switched off.** That needs the system's encrypted storage; where there is none, the setting stays on and says why.
