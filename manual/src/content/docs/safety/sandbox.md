---
title: Run commands in the sandbox
description: Let Snotra run shell commands and Python, see whether they run isolated, and set up the sandbox per workspace — a folder, a program or a host more room when it needs it.
sidebar:
  order: 5
---

Snotra can run shell commands and Python code: `git status`, a build, a test run, a script that sorts your data. Both are off until you switch them on. On macOS and Linux every run then happens in a sandbox, which keeps a command inside your project folder.

## What you need

- **macOS:** nothing; the sandbox is built in.
- **Linux:** the packages `bubblewrap`, `socat` and `ripgrep`. The `.deb` installs them; with the AppImage or the tarball run `sudo apt install bubblewrap socat ripgrep`.
- **Windows:** there is no sandbox yet. Every command and every Python run has your full rights — it can read and write anywhere, reach the network and start programs. Snotra says so on every card, and the card shows you the complete command before it runs.

## Switch on commands and Python

1. Open *Settings › Tools › Autonomy* and open the row *Execute*.
2. Switch on *Allow shell commands*, *Allow Python execution*, or both.
3. [since 1.28] A dialog of your operating system asks *Switch on shell_execute?* or *Switch on run_python?* and says what the tool may then do — on Windows, that there is no sandbox. Choose *Switch on*. *Cancel* leaves the switch off.

Switching off never asks.

Commands run in your login shell on macOS and Linux (zsh, bash …), with the `PATH` from your shell profile, and in PowerShell or `cmd.exe` on Windows. Python is looked for automatically; to use a particular interpreter — a virtual environment with the packages you need, say — set it under *Settings › Tools › Setup*.

## Set up the sandbox

[since 1.26] Everything about the sandbox is on one page: *Settings › Tools › Security*. The shield next to the folder name, the *Not isolated* link on a card and the box *The sandbox blocked …* under an answer lead there as well, with the open folder chosen.

![Settings › Tools › Security: on the left the list — All workspaces with 1 program and 1 host, then the workspaces garden-planner (open, 1 program · 2 hosts), invoice-tool (Sandbox off, struck-through amber shield) and old-project (Folder missing). On the right garden-planner: the tile "Sandbox active" with its switch, below it "Programs with more room".](screenshots/tool-security.webp)

**The list on the left** starts with *All workspaces*, followed by every folder that has a sandbox setting or an allowance of its own, and the open one, marked *open*. Each entry says how it stands, in shape and in words: a shield with what it allows beyond the sandbox (*1 program · 2 hosts*, or *Sandbox on · nothing extra*), the struck-through amber shield with *Sandbox off*, or *Folder missing* for a folder that is no longer there. A folder that is not open can be checked and changed all the same; a change applies the next time a run starts there.

**A workspace** shows, from top to bottom:

- the sandbox switch, as a tile that says whether runs there are isolated,
- *Programs with more room*: its own, and those for all workspaces, marked *All workspaces*,
- *Hosts kept open*: its own, and those for all workspaces, marked the same way,
- *Reset sandbox for this workspace*,
- for the open workspace only, *This session*: what cards allowed *For this session* in its chats.

What applies everywhere is shown in every workspace, but changed only under *All workspaces*: the marker *All workspaces* next to it leads there. While the sandbox of a workspace is off, its allowances rest, and the page says so.

**All workspaces** holds what is not tied to one folder: whether new workspaces start with the sandbox, the programs and hosts for every folder, what the sandbox always does on this computer, and *Reset the sandbox everywhere*. With no folder open, the page starts there.

## What the sandbox allows

A command or a Python run in the sandbox

- writes only in the project folder and a temporary folder,
- cannot read your keys, cloud credentials, shell histories or browser data,
- reaches the network only for the domains the call names. You approve them on the card; in *Auto* they are not asked about. `pip install` and `npm install` get their package registry automatically. [since 1.18] A connection to any other host waits until you allow or deny it.

What it does not do: it does not stop a run from *reading* your other files, and what it read can reach a domain you allowed. Snotra also blocks recursive forced deletion such as `rm -rf`, disk operations and rewriting Git history — an extra safeguard, not complete protection, since a script in between gets around any list of patterns.

## See whether a run is isolated

**On the card.** A card for a command carries the badge *Isolated* or, in amber, *Not isolated* with the reason and a link to the sandbox setting on *Settings › Tools › Security*. It also lists the shell, the working folder and the network access.

![An approval card titled "Confirm execution" with the badge "Isolated": Snotra wants to run a command in zsh. Below it the shell, the working folder, network "No access", the reason and the mode, the note that the run writes only in the project folder and a temporary folder, the command node src/calendar.js, and the buttons "Allow once", "Always allow this command" and "Deny".](screenshots/shell-approval.webp)

**Next to the folder name.** While commands or Python are switched on, a shield stands next to the name of the folder at the top of the sidebar: a plain shield while runs in this folder are isolated, a struck-through amber one while they are not. Click it to get to the sandbox switch of this folder on *Settings › Tools › Security*.

![The top left of the window: the shield next to the folder name garden-planner, above the file tree.](screenshots/sandbox-shield.webp)

## When the sandbox blocks something

[since 1.18] Sometimes a command needs more than the sandbox allows: a build tool writes its cache under `~/Library/Caches`, a tool reads its login from `~/.config/gcloud`, `pip` wants a host the call did not name. The sandbox refuses it, and Snotra shows you what was refused instead of leaving the model to guess.

**What you see.** Right under the tool steps of the answer, a box lists what was blocked — a write, a read of a protected location or a connection — with the path or host and why. The raw lines of the sandbox are folded away underneath. The box stays with the chat when you open it again later. [since 1.26] Its link *Sandbox settings for this workspace* opens *Settings › Tools › Security*.

**Allow a write or a read.** For a write outside the project folder or a read of a protected location, a card appears right after the run — in every mode, *Auto* included:

1. Check what was blocked, how the run went and what the command reported.
2. Under *Allow writing in*, choose exactly what was blocked or the folder one level up — the program's cache rather than the subfolder of one version.
3. Under *How long*, choose *Only this run* or *For this session*.
4. Click *Allow and run again*, or *Deny*. *Esc* denies as well.

**What happens.** Allowed, the command runs a second time, from the start, with exactly that path opened; the sandbox stays on for everything else. Whatever the command already did the first time happens again. The box then says how the second run went. Allowed *for this session*, later commands and Python runs in the same chat get the path without asking; it is listed among the session allowances — under *Settings › Tools › Autonomy*, and with the folder under *Settings › Tools › Security*, *This session* — where you can revoke it, and it ends with the chat, a change of mode or a restart. Denied or not answered, the command does not run again, and the model is told to tell you what was blocked instead of working around it.

**Allow a connection.** [since 1.18] When a command connects to a host outside the network domains of its call, the connection waits, and a card *Sandbox · connection waiting* appears while the command is still running — in every mode, *Auto* included:

1. Check the host, how long the connection has been waiting, which hosts are open already and what the command has printed so far.
2. Under *Allow connections to*, choose exactly this host or every host of its domain — `*.pytorch.org` instead of `download.pytorch.org:443`. A domain that many unrelated sites share, such as `amazonaws.com` or `github.io`, is offered host by host only.
3. Under *How long*, choose *Only this run*, *For this session* or — for a host this folder needs again and again — *For this workspace*.
4. Click *Allow connection*, or *Deny*. *Esc* denies as well.

**What happens then.** Allowed, the connection goes through and the command simply carries on; nothing runs twice. Allowed *for this session*, later commands in the same chat reach the host without asking, listed among the session allowances like a path. Denied, the connection stays closed and the command fails on its own; it is not asked about any further host, and the model is told not to work around it. If the command gives up before you decide — `pip` does after 15 seconds — the card says *Stopped waiting*, and a second card after the run offers the host with *Allow and run again*.

**Keep a host open for the folder.** [since 1.22] *For this workspace* is the answer for a server you work with every day. The operating system asks you to confirm it first, naming the host and the folder. From then on every command and Python run in this folder reaches the host — in every chat and every mode, also after a restart — and no card asks about it again; everything else stays inside the sandbox. The host is listed under *Settings › Tools › Security*, *Hosts kept open*, where you can close it again — see [Keep a host open](#keep-a-host-open); *Reset sandbox for this workspace* closes all of them. The choice is offered only for connections, not in *Always ask*, and only where Snotra can store it encrypted. Cancelling the system dialog leaves the card open.

**Once you have answered.** [since 1.21] When the command is through, the card gives way to the box under the tool steps. If you answered everything it asked, the box folds to a single line — for example *The sandbox blocked 1 resource · denied · Command “cat ~/.aws/config” run* — and a click opens it: what was blocked and why, what you decided and what that opened, how the second run went, and the raw lines of the sandbox. A box with something nobody answered, or with a refusal on the second run, stays open. A card the command gave up on (*Stopped waiting*) stays as it is. The output of the first run, which the card showed, is not kept.

**What cannot be allowed.** A connection a program makes directly instead of through the sandbox's proxy — `psql`, or `ssh` and `scp` called on their own — can only be shown: the sandbox cannot open a single host for it. Snotra's own storage, your home folder as a whole and the files the sandbox always keeps closed, such as `.bashrc` or `.git/hooks`, are never offered.

## Use Git over SSH

[since 1.21.1] On macOS, `git fetch`, `git pull`, `git push` and `git ls-remote` reach an SSH remote such as `git@gitlab.example.com:team/app.git` from inside the sandbox. Snotra sends Git's SSH connection through the sandbox's proxy, so it follows the same rules as any other connection, and the sandbox stays on.

### What you need

- **The host in `~/.ssh/known_hosts`.** Inside the sandbox SSH cannot ask whether to trust a new host. Connect to it once from a terminal — `ssh -T git@gitlab.example.com` — and accept its key.
- **Your key in the ssh-agent.** The sandbox keeps your private key files closed; SSH signs in through the agent instead. Load the key once with `ssh-add --apple-use-keychain ~/.ssh/<key>`, or add `AddKeysToAgent yes` and `UseKeychain yes` to `~/.ssh/config` so that SSH loads it the next time you use it in a terminal.

To check both, run `ssh-keygen -F gitlab.example.com`: it prints the host's key if the host is in `known_hosts`. `ssh-add -l` lists the keys the agent holds; if it prints *The agent has no identities*, load the key first.

### Steps

1. Ask for the Git command as usual and approve it on the card.
2. If the host is not among the network domains of the call, the card *Sandbox · connection waiting* asks about it, for example `gitlab.example.com:22`. Allow it for *Only this run* or *For this session* — see [Allow a connection](#when-the-sandbox-blocks-something).
3. For a remote you use every day, choose *For this workspace* on that card: from then on Git reaches the host from this folder without asking. If you need it from every folder, give `git` a [program allowance](#give-one-program-more-room) with the host under *Domains it may reach* instead.

### What happens

Git reaches the host through the proxy. SSH may read `known_hosts`, `config` and the public keys (`*.pub`) in `~/.ssh`, and talk to the ssh-agent; the private keys stay closed, and SSH's attempts to read them are not shown as blocked. A command in the sandbox can use the agent to sign in to the hosts the run may reach, but it cannot read or copy a key. `git push` writes to the remote and is a command you approve like any other.

Only Git's SSH takes this route. `ssh` or `scp` called on their own still connect directly, which the sandbox cannot open for a single host. On Linux, Git over SSH cannot sign in inside the sandbox yet: use the HTTPS address of the repository, or switch the sandbox off for the folder.

## Switch the sandbox off for one folder

When the sandbox gets in the way of something legitimate in one project — writing to a sibling repository, a tool that needs the network, an older `pip` in a virtual environment:

1. Open *Settings › Tools › Security* and choose the folder in the list. The open folder is chosen already.
2. Switch off the tile *Sandbox active*.
3. The operating system asks: *Run without sandbox in this workspace?*, naming the folder. Confirm with *Run without sandbox*.

It applies to that one folder only, never to all of them, and it is stored with your permissions, not in the folder. From then on every card in the folder says *Not isolated*, the model is told so as well, and in *Auto* the mode pill reads *Auto · not isolated*. The list shows the folder with the struck-through amber shield and *Sandbox off*. Switching it back on asks nothing; *Reset sandbox for this workspace* does it as well.

## Start new folders without the sandbox

[since 1.26] New workspaces start with the sandbox on. If you would rather decide for each folder yourself:

1. Open *Settings › Tools › Security* and choose *All workspaces*.
2. Under *New workspaces*, switch off *Sandbox on in new workspaces*.
3. The operating system asks: *Start new workspaces without sandbox?* Confirm with *Start without sandbox*.

Every folder you open for the first time from then on runs without the sandbox, and the shield next to its name says so. Folders Snotra already knows keep their setting — those you opened before, and those that have a sandbox setting. Switched back on, the default applies to new folders again; folders that started without the sandbox in the meantime keep that until you switch it on for them.

## Give one program more room

Often it is a single program that needs more — a tool whose login has to be refreshed, or `gh` and `terraform` on macOS, which cannot reach the network inside the sandbox. Give that program an allowance instead of switching the sandbox off:

1. In *Settings › Tools › Security*, choose the folder — or *All workspaces* — and click *Add program* under *Programs with more room*.
2. Under *Program*, enter its name as you type it in the terminal, or its full path. Snotra shows which file it found.
3. [since 1.26] Under *Applies to*, keep *This workspace* — the usual choice — or choose *All workspaces* for a tool you trust in every folder. Without an open folder, only *All workspaces* is possible; from *All workspaces*, it is chosen already.
4. Add the *Domains it may reach*, one per line, and under *Folders it may also write in* any folder it keeps its data in.
5. On macOS, tick *Check certificates through macOS* for programs written in Go, such as `gh` and `terraform`. It weakens the isolation a little; the dialog says how.
6. Click *Save* and confirm in the system dialog, which names the folder or says *in any workspace*.

The allowance applies only when a command runs that program on its own — without chaining, pipes or redirection — and only to the very file you chose, not to a file of the same name in a project. The card names the allowance, or says why it does not apply. Where a program has an allowance for all workspaces and one for this workspace, they add up there: every domain and folder of either.

Program allowances made before 1.26 apply in all workspaces, as they did; move one to a single workspace with *Edit* under *All workspaces* and *Applies to*.

## Keep a host open

A host every run in a folder needs — your Git server, a package mirror — can be kept open, so that no card asks about it:

- **For one workspace** [since 1.22]: choose *For this workspace* on the connection card, see [Allow a connection](#when-the-sandbox-blocks-something). [since 1.26] Or, in *Settings › Tools › Security*, choose the folder and click *Add host* under *Hosts kept open*.
- **For all workspaces** [since 1.26]: choose *All workspaces* and click *Add host* under *Hosts open everywhere*. Only this page offers it, never a card: opening a host for every folder is a decision for the settings, not for the middle of a run.

Enter the host with its port, such as `api.example.com:443`, or as `*.example.com` for every host one level below. A domain that many unrelated sites share, such as `github.io`, is accepted host by host only. Click *Keep open* and confirm in the system dialog. The trash button next to a host closes it again, without a dialog.

## Clean up

- ***Reset sandbox for this workspace*** switches the sandbox of the chosen folder back on and removes its own programs and hosts. What applies in all workspaces stays. It asks nothing, since it only takes rights away.
- ***Reset the sandbox everywhere***, under *All workspaces*, switches the sandbox back on in every workspace and for new ones, and removes every program and host allowance, those for all workspaces included. It asks in a system dialog first.
- **A folder that is gone** stays in the list as *Folder missing* while settings for it are stored. Choose it and click *Remove settings*.

## If it doesn't work

- **A command fails, and its output does not say why.** Look under the tool log of the answer: the box *The sandbox blocked …* lists what the run tried to reach and was refused — see [Follow what Snotra does](../../chatting/follow-the-work/). A write, a protected read or a connection through the proxy can be allowed on a card; for anything else, a program allowance or, for this one folder, switching the sandbox off gives it the room.
- **There is a box, but no card.** What was blocked cannot be allowed on a card: a direct connection, Snotra's storage or a file the sandbox always keeps closed — or you denied a connection of the same command while it ran. When a program needs it regularly, give it a program allowance, or switch the sandbox off for the folder.
- **The second run is blocked again.** The box shows what the second run ran into; a program often needs a second place, such as a config file next to its cache. Allow that one on the next run.
- **Linux: the card says the sandbox needs packages.** Install `bubblewrap`, `socat` and `ripgrep` and restart Snotra.
- **Linux: *the sandbox does not start on this system*.** Ubuntu 24.04 and later restrict unprivileged user namespaces, which the sandbox needs. Lifting that is a system-wide decision and yours to make:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  It lasts until the next reboot; to keep it, put the same setting into a file under `/etc/sysctl.d/`. An AppArmor profile that grants user namespaces to `bwrap` works as well. Restart Snotra afterwards.
- **Git over SSH: *Permission denied (publickey)*.** The key is not loaded in the ssh-agent, so SSH has nothing to sign in with. Load it with `ssh-add --apple-use-keychain ~/.ssh/<key>` and run the command again — see [Use Git over SSH](#use-git-over-ssh).
- **Git over SSH: *Host key verification failed*.** The host is not in `~/.ssh/known_hosts` yet. Connect to it once from a terminal and accept its key.
- **macOS: `gh`, `terraform` or another Go program cannot reach the network.** Give it a program allowance with *Check certificates through macOS*.
- **The sandbox of a workspace cannot be switched off.** That needs the system's encrypted storage; where there is none, the switch stays on and the tile says why. The same holds for programs, hosts and *Sandbox on in new workspaces*.
- **Windows: *Settings › Tools › Security* has nothing to set up.** There is no sandbox on Windows yet, so there is nothing to widen; the page says so for every workspace.
- **An allowance does not apply in one folder.** Its sandbox is off there — the allowances rest while it is, and the page marks them — or the allowance belongs to another workspace. Choose the folder in the list to see what applies there.
