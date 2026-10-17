---
title: Connect an MCP server
description: Bring in tools from other systems — an issue tracker, a wiki, a database — through the Model Context Protocol.
sidebar:
  order: 7
---

Through the **Model Context Protocol (MCP)** Snotra gets tools from other systems: Jira and Confluence, GitHub, a database, an internal service. An MCP server offers such tools, and Snotra passes them on to the model. It is either a small program that Snotra starts on your computer, or a service somewhere else that Snotra reaches by its address.

## What you need

For a **local server** — one that runs as a process on your computer:

- The start command of the server, from its documentation — for example `npx -y @modelcontextprotocol/server-github`.
- Whatever it needs to log in, usually a token as an environment variable.
- The program behind the command on your computer, such as Node.js for `npx` or Docker for `docker`.

[since 1.25] For a **remote server** — one that is only reachable over the network:

- Its address, usually ending in `/mcp` — for example `https://mcp.example.com/mcp`.
- Whatever it needs to log in, usually an API key or a token that goes into a header such as `Authorization`.

Snotra speaks the current remote transport of MCP, *Streamable HTTP*. The older one, *HTTP+SSE*, and a sign-in through OAuth are not supported; a service that offers an API key or a token works.

An MCP server is someone else's code. A local one runs on your computer with your rights; a remote one receives whatever the model sends it. Only add servers you trust.

## Add a server

1. Open *Settings › Tool setup* and click *Add server* under *MCP servers*.
2. Under *Connection*, choose *Local process (stdio)* or *Remote (HTTP)*, and fill in the form; the fields are explained below.
3. Click *Save*, then *Test connection*. It connects once and shows the tools the server offers — or the error, with what the server sent along.

![The dialog of an MCP server: identifier github, display name GitHub, the connection choice set to "Local process (stdio)", command npx, arguments "-y @modelcontextprotocol/server-github", an empty working directory, the button "Add variable", and at the bottom "Remove server", "Test connection", "Cancel" and "Save".](screenshots/mcp-server.webp)

| Field | What goes in |
| --- | --- |
| *Identifier* | Lower-case letters, digits, `.`, `-` and `_`. It becomes part of the tool names and cannot be changed later. |
| *Display name* | Any name, for the list. |
| *Connection* | *Local process (stdio)* for a server Snotra starts, *Remote (HTTP)* for one it reaches by its address. |
| *Command* and *Arguments* | Local only. What is started, for example `npx` and `-y @modelcontextprotocol/server-github`. |
| *Working directory* | Local only, and optional; empty means your home folder. |
| *Environment variables* | Local only. *Add variable* for each one. |
| *Server URL* | Remote only. The address of the server. It has to start with `https://`; plain `http://` works only for a server on your own computer (`localhost`). |
| *Headers* | Remote only. *Add header* for each one, for example `Authorization` with the value `Bearer` and your token, or `X-API-Key` with a key. |

**Environment variables and headers are secret by default:** stored encrypted, and not shown again once saved — only replaced or deleted. Untick *secret* for a value that may stay readable, such as `LANG=en_GB` or a team name.

Headers go only to the address you entered. If the server sends Snotra on to another address, Snotra stops and says so instead of taking your token along.

## Change the address of a remote server

When you save a new *Server URL* — or switch a server between *Local process* and *Remote* — Snotra **switches the server off and forgets its list of tools**. The dialog says so before you save. Whatever you allowed for the old address does not carry over to a new one. Click *Test connection* to see what the new address offers, then switch the server on in the list.

## Import from another app

If you use MCP servers in Claude Desktop, Claude Code or Cursor already, click *Import* and paste their `mcpServers` block. Snotra shows what it recognised: each server with its start command or its address, the values it will keep secret, placeholders not filled in yet, and servers that would replace one you have. [since 1.25] Entries with a `url` are imported as remote servers, together with their `headers`; a value such as `${GITHUB_TOKEN}` counts as a placeholder, because Snotra does not fill it in. Entries that cannot work — an *HTTP+SSE* server, say — are listed with the reason. Untick what you do not want, then import.

Imported servers start **switched off**. Snotra reads only what you paste, never another app's configuration files.

## What happens

- The server's tools appear under *Settings › Tools & security*, in the row *External services*, grouped by server. Each one can be switched off on its own, and each group says how its server is doing: connected with its number of tools, not connected yet, switched off, or failed, with the reason.
- In the chat, a tool shows where it comes from: `mcp__github__create_issue`. A tool of a remote server looks and behaves the same as one of a local server.
- An MCP tool always counts as running a program **and** reaching an external service, so in *Smart* Snotra asks before every call. A server that marks a tool as destructive makes it stricter still: the tool then also counts as *Overwrite with no way back*.
- A server is connected only when it is needed. It remembers the tools it reported last time, so you can switch one off before the model is ever offered it.
- A remote server that has forgotten its session — after a restart of the service, say — is connected again on its own, and the tool call goes through.

A server that does not start, cannot be reached or crashes does not break the chat; the error is reported and everything else carries on.

## If it doesn't work

- ***… could not be started …*** — the command of a local server is not found or exits at once. *Test connection* shows what the server printed; often the program behind the command (Node.js, Docker) is missing, or a token is.
- ***… not authorised (401) …*** — the token in the headers is missing, wrong or expired. Enter it again under *Headers*.
- ***… asks for a sign-in (OAuth) …*** — the service wants an OAuth sign-in, which Snotra does not support yet. Look in its documentation for an API key or a personal token.
- ***… refused access (403) …*** — the token is valid but lacks the rights, or the service does not accept requests from your network.
- ***… not as an MCP server …*** or ***There is no MCP endpoint at … (404)*** — the address points at a web page, not at the MCP endpoint. It usually ends in `/mcp`.
- ***… does not accept MCP requests (405)*** — often an older *HTTP+SSE* server. Look for its Streamable HTTP address.
- ***The secure connection to … failed …*** — the certificate is self-signed, expired or issued for another name. A service inside a company network may need its certificate installed by your IT.
- ***The host … was not found*** or ***… could not be reached in time*** — check the address, and whether the service is only reachable over a VPN.
- ***The server URL has to use https …*** — plain `http://` is only allowed on your own computer, because a token sent over it could be read on the way.
- ***Test connection uses the saved configuration — save your changes first.*** Click *Save*, then test.
- **A tool is missing.** Tool names longer than 64 characters together with the server's identifier are left out; the list under the servers names them. A shorter identifier helps.
