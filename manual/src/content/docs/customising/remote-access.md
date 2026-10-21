---
title: Follow your chats from your phone
description: Remote access — what it will be for, why it is not part of Snotra yet, and what the relay can see.
sidebar:
  order: 9
---

[since 1.28] With remote access you follow your chats from the Snotra app on your iPhone while you are away from this computer: you read them, write in them and answer approvals. The chats stay on this computer; the phone only shows them, end-to-end encrypted through a relay that cannot read them.

## Not there yet

Remote access comes with the Snotra app for iPhone, which is not out yet. Until then the settings have no section for it, no phone can be paired, and nothing connects to the relay. Once the app is out, *Settings › Remote access* appears, and this page describes how to pair your phone.

## What it is for

Once a phone is paired, it can:

- follow your chats while you are away from this computer,
- write in them and stop a running turn,
- answer approvals with *Allow once* or *Deny* — everything wider, like *for this session* or *always*, stays at this computer.

Snotra connects one phone per computer.

## Which folders the phone sees

Only the folders you open for it, each with the switch *Access from your phone* on *Settings › Tools › Security*. Every folder starts closed. See [Open a folder to your phone](../../safety/tools-and-security/#open-a-folder-to-your-phone).

## What the relay can see

The relay carries the messages between this computer and the phone. It sees that a connection exists, when each side is online, the size and time of each packet and both IP addresses — never what a chat says. Nothing connects and nothing goes to the relay until you pair a phone.
