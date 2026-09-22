# Project language: English inside, bilingual towards the user

Convention from 2026-09-22 (issue #280).

The conversation language and the project language are two different things.
Konrad talks to Claude Code, ChatGPT and any other agent in German, and that
stays that way — answers come back in German. **What the agent writes into the
repository, into an issue or onto the website is English.** Translating is part
of the job, not something to ask about first: the German sentence in the chat
is the input, the English text is the result.

The one place where this turns around is the product itself. Wherever an end
user meets Snotra, the project stays **bilingual**.

## English — everything the project says to itself

No German, regardless of the language it was dictated in:

- **GitHub issues and pull requests** — title, body, comments, checklists.
- **Commit messages**, including the ones squashed onto `main`.
- **`docs/`** — architecture, security concept, release documentation, and the
  labels inside the diagrams that belong to them.
- **`.claude/rules/` and `.claude/skills/`** — this file included. The German
  trigger phrases in a skill's `description` are the exception: they are matched
  against what the user says, and the user says it in German. Keep them and add
  English ones next to them.
- **Code** — identifiers, comments, log output, error messages that only ever
  reach a developer, test names and fixtures.

## Bilingual — everything the user meets

**English is the source version, German is derived from it**, and both are held
to the same standard: same content, same completeness, same care. A German
version that lags behind the English one is a defect, not a detail.

- **The app UI** — labels, buttons, empty states, and every message that is
  shown to the user rather than logged.
- **User-facing documentation** — `README.md` describes the app from the user's
  side and counts as user-facing. Everything under `docs/` does not.
- **The website** no longer lives here. It moved to its own private repository
  together with the rest of the promotion (#299) and carries this rule with it,
  including the exception in the other direction: `impressum.html` and
  `datenschutz.html` are legally binding in German, so the German version
  governs there and an English one is informational only.

German texts address the reader as **du**, never **Sie**.

## What this rule does not say

- **It does not change the chat.** Answers, explanations, questions back to the
  user stay in the language the user is speaking.
- **It does not rewrite history.** Existing commits and existing issues stay
  German. They are a record, and a record is not retrofitted.
- **It is not word-for-word translation.** Write the English a developer would
  have written — not a German sentence with English words in it.
- **It does not touch quoted material.** A user's own words, a third-party error
  message, a tool's output, the text inside a screenshot: quoted as they are.
  Only what is written around them is translated.

## State of the migration (2026-09-22)

The rule is younger than the repository, so most of it is still German:

- The internal documents, rules and skills are being translated in **#281**.
  Until that is done, German neighbours are expected — new files are English
  anyway. Translating an unrelated file on the side does not belong in a pull
  request that was opened for something else.
- On the user-facing side `README.md` is still German only. **#282** carries
  that as an epic and splits it up; its website part went with the website to
  the promotion repository.

Related rules: [`task-management.md`](./task-management.md) for where issues go,
[`git-workflow.md`](./git-workflow.md) for what a pull request looks like.
