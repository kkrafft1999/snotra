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

Whether an image goes along depends on the provider, not only on the model:

- *OpenAI* — yes.
- *OpenAI-compatible* — only when *Allow image attachments* is switched on for the entry under *Settings › Models*. Otherwise Snotra says that image attachments are switched off for this connection.
- *Anthropic (Claude)*, *Google (Gemini)*, *Ollama* — not yet. Claude and Gemini understand images, and so do some Ollama models, but Snotra cannot pass them on to these providers yet ([#90](https://github.com/kkrafft1999/snotra/issues/90), [#91](https://github.com/kkrafft1999/snotra/issues/91), [#92](https://github.com/kkrafft1999/snotra/issues/92)). Snotra says so instead of pasting.

The overview per provider is in [Models](../../customising/models/#the-providers).

The image is part of the chat and comes back when you open it again from the history.

## Dictate

1. Click the microphone in the input field, or press `Cmd+D` (`Ctrl+D` on Windows and Linux), and speak.
2. What you say appears in the input field while you speak, where the caret was — grey and slanted for as long as the recording runs [since 1.20]. A red level next to the microphone shows that it hears you, a clock how long it has been running.
3. Spot a misheard word? Correct it straight away: a sentence is finished as soon as you pause, and from then on you can change it while you go on speaking. Only the sentence you are still in can't be edited.
4. Click the microphone again, or press `Cmd+D` / `Ctrl+D`, to stop. Snotra finishes the last sentence, and everything turns into ordinary text, ready to change or send.

![The input field during a recording: a typed "Note for the sowing calendar:" and after it, grey and slanted, the dictated sentences. Below, the red microphone, a level, "Recording …" and the time.](screenshots/dictation.webp)

While you dictate, the pills next to the microphone and the token counter make room for the recording; they come back when you stop. Sending the message ends the recording, and what was dictated goes with it. The shortcut is also in the menu, *Edit › Voice Input*.

Dictation uses OpenAI's speech recognition: the recording goes to OpenAI, which is also what the microphone's tooltip says. It needs an OpenAI key under *Settings › Models*, even when the chat runs on another provider; OpenAI bills it by the minute. A recording stops by itself after five minutes; half a minute before, the line next to the microphone says so.

If the live text can't be had — a network that blocks the connection, say — the recording goes on without it, and the text comes when you stop. How to tell, and what to do: [When dictation doesn't work](../../troubleshooting/voice-input/).

## See what a request costs

Next to the send button, the input field shows the size of the last request in tokens: everything the model received — the conversation, the instructions, the descriptions of the tools. Click it to see what it consists of: every skill, the tools, the rest of the instructions and the conversation. The total is the provider's own figure; the parts are estimates.

## If it doesn't work

- **The send button stays disabled.** No model is connected, or the connected one is missing its key: see [Connect a model](../../getting-started/connect-a-model/).
- **Pasting an image does nothing but show a note.** The model of this chat does not take images. Switch to one that does — [Switch the model](../model-and-reasoning/) — or switch on *Allow image attachments* for an OpenAI-compatible server whose model understands images.
- ***Not sent*** next to the send button. Something went wrong inside Snotra before the message left. Your text and images are back in the input field; send them again. If it keeps happening, press `Cmd+Shift+D` / `Ctrl+Shift+D` right afterwards and attach the result to a report: [Find logs and report a problem](../../troubleshooting/logs-and-reports/).
- ***No OpenAI key stored (voice input needs one).*** Dictation needs an OpenAI key, even when the chat runs on another provider. Without one the microphone does not even switch on.
- **Dictation shows no text while you speak, or none at all.** See [When dictation doesn't work](../../troubleshooting/voice-input/).
