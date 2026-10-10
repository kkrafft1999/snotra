# Tool-accuracy benchmark

Measures whether the model still picks the right tool with the right arguments
when the tool definitions change. Built for
[#186](https://github.com/kkrafft1999/snotra/issues/186): the cuts of #182–#185
promised to cost "at most X % accuracy", and nothing could check that promise.

A run sends every task of the set once through the real chat engine and scores
what the model did. Two runs over the same tasks are compared pair by pair.

## What it measures

Per task and run:

| metric | meaning |
|---|---|
| right tool | a positive task called the tool (or one of the tools) that serves it |
| right arguments | …with the expected arguments, and the tool did not reject them |
| files | for write tasks, the file looks as asked afterwards |
| negatives clean | a negative task did not call what it must not call |
| unexpected write | a write tool was called on a task that asked for no write |
| failed calls | calls the tool answered with `{ "error": … }` |
| rounds | provider rounds of the turn — the extra round is the costliest damage |
| aborted | the turn ended in an error (round limit, cut-off answer, API error) |
| prompt tokens | as the provider reports them (`usage.prompt`), summed over the rounds |

`compare.js` pairs two runs by task and reports, per binary metric, both rates,
how many tasks only one side got right, the flip rate and an exact McNemar
p-value, plus the paired differences in rounds, failed calls and tokens.

## The arms

- **`current`** — the app as it ships.
- **`uncut`** — the same tools with what #190 (#182, #183) and #192 (#184) took
  out put back in: the deleted sentences of descriptions and parameter
  descriptions (translated, since the schemas went English only later, #279),
  limits as prose instead of `default`/`maximum` keywords, and the old prose
  tool list instead of the conventions block. What changed after the cuts stays
  in both arms. The details and the reasoning are in [`arms.js`](arms.js).

`node bench/tool-accuracy/run.js --arm <arm> --print-prompt` prints the system
prompt and the tools of an arm without calling a model.

## The tasks

[`tasks.js`](tasks.js): 135 tasks, 36 of them negative (27 %), in German and
English. Positive targets are derived from the sentences the cuts removed —
`probes` names the one a task aims at. Negative tasks are ones where the right
answer is *no* call (or no write, no command, no network); without them
over-triggering of the write tools would never show.

Every task runs in a fresh copy of [`fixture/`](fixture), a small Node project
with hidden files, a `.gitignore` and ignored folders. Two of its files are
stored under other names and restored in the copy: `dot-gitignore`, so it does
not hide the fixture from git, and `dot-package.json`, so Dependabot does not
raise alerts for packages the fixture names but never installs (#841).

## How the engine is wired

[`harness.js`](harness.js) drives `createChatEngine` headless — no Electron:

- **Policy and approvals are real.** Mode `smart`, and every approval card is
  answered "allow once". Without that every write is denied, and a denied call
  would still count as the right tool.
- **The file tools run for real** on the fixture copy.
- **Tools that would leave the machine, cost money or need a sandbox are stubbed**
  (`run_python`, `shell_execute`, `web_search`, `fetch_url`,
  `extract_document_text`, `generate_image`, `remember`): they answer with a
  fixed result. The benchmark is about the choice and the arguments, not the
  outcome. A stub can mislead the model into an extra round, but equally in
  both arms.
- No skills, memory, environment block or AGENTS.md — the same in both arms.

## Running it

Needs a valid OpenAI key in a file outside the repository, mode `0600`:

```sh
# ~/env/openai/.env
OPENAI_API_KEY=sk-proj-…
```

```sh
node --env-file=$HOME/env/openai/.env bench/tool-accuracy/run.js --arm current --label aa-1
node --env-file=$HOME/env/openai/.env bench/tool-accuracy/run.js --arm current --label aa-2
node --env-file=$HOME/env/openai/.env bench/tool-accuracy/run.js --arm uncut --label ab-uncut
node bench/tool-accuracy/compare.js out/bench/tool-accuracy/<aa-1>.jsonl out/bench/tool-accuracy/<aa-2>.jsonl
node bench/tool-accuracy/compare.js out/bench/tool-accuracy/<aa-1>.jsonl out/bench/tool-accuracy/<ab-uncut>.jsonl --verbose
```

Options: `--model` (default `gpt-6-luna`), `--effort` (default `medium`),
`--only id,id`, `--repeat n`, `--concurrency n`. Runs land in
`out/bench/tool-accuracy/` and stay out of git. Run the arms at the same time —
provider load drifts over the day.

**First the A/A run.** The OpenAI provider sends neither `temperature` nor
`seed`, so two runs of the same arm differ. Their flip rate is the noise floor;
an A/B difference only means something where it clearly exceeds it.

A run of 135 tasks costs about 2 million prompt tokens (roughly two thirds
cached) and 55,000 completion tokens on `gpt-6-luna · medium`, measured on the
probe run of 2026-10-06.

## Results

See [`results.md`](results.md).
