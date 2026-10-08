---
title: Write a message
description: Send a message, stop an answer, attach a screenshot, dictate, and see what a request costs.
sidebar:
  order: 1
---

Everything you ask Snotra goes through the input field at the bottom of the chat. It also carries the model, the mode and the size of the last request.

## What you need

An open folder and a connected model — see [Open a folder](../../getting-started/open-a-folder/) and [Connect a model](../../getting-started/connect-a-model/).

## Send a message

1. Click into the input field and type your question or task.
2. Press `Enter` to send it. `Shift+Enter` starts a new line instead.

While Snotra answers, the send button turns into a stop button. Click it to cancel the answer; whatever the answer had done up to then stays done.

Point Snotra to a particular file with `@`: [Refer to a file](../refer-to-a-file/).

## Attach a screenshot

1. Copy an image to the clipboard — a screenshot, for example (`Cmd+Ctrl+Shift+4` on macOS, the Snipping Tool on Windows).
2. Click into the input field and paste it with `Cmd+V` / `Ctrl+V`.

The image appears above the input line with a preview, its size and a button to remove it. You can send it with a question or on its own. PNG, JPEG, GIF and WebP work, up to four images per message and 5 MB each; larger images are scaled down before they are sent.

Not every model understands images. OpenAI's models do; an OpenAI-compatible server only when *Allow image attachments* is switched on for it under *Settings › Models*. With any other model, Snotra says so instead of pasting. The image is part of the chat and comes back when you open it again from the history.

## Dictate

1. Click the microphone in the input field and speak.
2. Click it again to stop. Snotra transcribes what you said and adds it to the input field, where you can still change it before sending.

Dictation uses OpenAI's speech recognition and needs an OpenAI key under *Settings › Models*. A recording stops by itself after five minutes; half a minute before, the line under the input says so.

## See what a request costs

Next to the send button, the input field shows the size of the last request in tokens: everything the model received — the conversation, the instructions, the descriptions of the tools. Click it to see what it consists of: every skill, the tools, the rest of the instructions and the conversation. The total is the provider's own figure; the parts are estimates.

## If it doesn't work

- **The send button stays disabled.** No model is connected, or the connected one is missing its key: see [Connect a model](../../getting-started/connect-a-model/).
- **Pasting an image does nothing but show a note.** The model of this chat does not take images. Switch to one that does — [Switch the model](../model-and-reasoning/) — or switch on *Allow image attachments* for an OpenAI-compatible server whose model understands images.
- ***No OpenAI key stored (Whisper needs one).*** Dictation needs an OpenAI key, even when the chat runs on another provider.
