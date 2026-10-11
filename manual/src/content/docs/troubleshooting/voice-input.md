---
title: When dictation doesn't work
description: How to tell whether the live text works, what Snotra does when it doesn't, and what to do when no text comes at all.
sidebar:
  order: 5
---

Dictation has two ways of turning speech into text [since 1.20]. Normally the text appears while you speak: that is OpenAI's **live transcription**. When it can't be reached, or breaks off, Snotra keeps recording and, when you stop, has the rest transcribed in one piece by OpenAI's **Whisper** — the way dictation worked before. Either way the text ends up in the input field; the second way you only see it at the end.

Both need an OpenAI key under *Settings › Models*. Without one there is no dictation at all.

## What you need

A recording that did not go as you expected. The line next to the microphone says what happened — read it before anything else.

## How to tell what is happening

| What you see | What it means |
| --- | --- |
| The text appears while you speak, grey and slanted. Next to the microphone: *Recording …*, a red level and a clock. | Live text works. |
| *Recording without live text — the text follows when you stop.* | The live transcription failed. Snotra goes on recording; what was already written stays. Keep talking. |
| After the stop, *Transcribing with Whisper …*, then *No live text (…). Transcribed with Whisper instead.* | The fallback did its job: the rest of the recording is in the field. The reason in brackets says why live text failed. |
| After the stop, *Error: …* | Whisper failed as well. What was in the field stays; the part of the recording that had no text yet is lost. |
| *Error: No OpenAI key stored (voice input needs one).* right after the click | There is no key, and the microphone did not even switch on. |
| The level next to the microphone stays flat while you speak. | The microphone hears nothing — see [If it doesn't work](#if-it-doesnt-work). |

## When the live text fails

The reason is in the brackets of *No live text (…)*.

| The reason | What it means | What to do |
| --- | --- | --- |
| *Could not reach OpenAI's speech recognition. Check the OpenAI key and the network.* | The live connection did not come about, or broke off. Most often a firewall, proxy or VPN lets ordinary requests to OpenAI through, but not the live connection (a WebSocket to `api.openai.com`). A key OpenAI refuses looks the same from here. | Nothing urgent — the fallback covers it. To get live text back: check the key under *Settings › Models*, try without the VPN, or ask whoever runs the network to allow WebSocket connections to `api.openai.com`. |
| An English sentence from OpenAI, such as *… does not exist or you do not have access to it* | Your OpenAI account may not use the live model, `gpt-live-transcribe`, yet. With OpenAI some models need a verified organisation. | Check the organisation and its limits in your OpenAI account. Until then the fallback transcribes every recording. |
| *Rate limit reached*, *insufficient_quota* | As with the chat: too many requests, or no credit left. | See [When the model reports an error](../provider-errors/). |

## When Whisper fails too

*Error: …* after the stop means neither way got through. The text in the field stays; say the missing part again once the cause is gone.

- ***Connection to the provider failed.***, ***fetch failed***, ***Timed out after … s.*** No network to OpenAI at all. Check the connection.
- ***Incorrect API key provided***, ***insufficient_quota***. The key or the account: see [When the model reports an error](../provider-errors/).
- ***No speech recognised.*** The recording was silent or too quiet — see below.

## What happens

Nothing you dictated is thrown away by a failure: whatever is in the input field stays there, as ordinary text, and you can change or send it. A failed live connection costs nothing extra; the fallback sends only the part of the recording that has no text yet.

## If it doesn't work

- ***Microphone access denied.*** Your system does not let Snotra use the microphone. On macOS switch on *Snotra Agent* under *System Settings › Privacy & Security › Microphone*; on Windows allow desktop apps under *Settings › Privacy & security › Microphone*. Then try again.
- **The level stays flat, and no text comes.** The microphone hears nothing. Snotra records from the system's default input: check in the sound settings that it is the microphone you speak into, and that it is not muted.
- **Sentences break in odd places.** A sentence ends at a pause of about 0.7 seconds. A long breath in the middle of one ends it there; nothing is lost, only the full stop may sit in the wrong place. Correct it in the field.
- **The recording stopped by itself.** A recording lasts five minutes at most; half a minute before, the line next to the microphone says so. Start a new one.
- **The recording ended when the window was minimised.** Hiding the window ends a recording, and the text so far stays. Keep the window open while you dictate.
- **`Cmd+D` / `Ctrl+D` does nothing.** The shortcut works while the Snotra window is in front.
