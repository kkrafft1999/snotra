# Results

## 2026-10-06 — did the cuts of #182–#185 cost accuracy?

Model `gpt-6-luna` · `medium`, OpenAI Responses API, task set `tasks.js` as of
this commit (135 tasks, 36 negative). Three runs started at the same time:
`current` twice (A/A), `uncut` once (A/B). The run files are not in the
repository.

**Answer: no measurable loss.** Both arms got 91.1 % of the tasks right. The
cut arm is cheaper and, if anything, smoother: fewer rounds, fewer rejected
calls, fewer aborts.

### Per run

| | current (aa-1) | current (aa-2) | uncut |
|---|---|---|---|
| correct overall | 91.1 % | 90.4 % | 91.1 % |
| right tool (positives) | 98.0 % | 96.0 % | 98.0 % |
| right arguments, given the tool | 89.7 % | 90.5 % | 89.7 % |
| negatives clean | 100 % | 100 % | 100 % |
| unexpected writes | 0 | 0 | 0 |
| aborted | 1 | 1 | 4 |
| rounds per task | 3.01 | 2.96 | 3.24 |
| failed calls per task | 0.31 | 0.36 | 0.47 |
| prompt tokens per task | 12,959 | 12,706 | 18,283 |
| prompt tokens, first round | 3,723 | 3,723 | 4,575 |

### Noise (A/A)

Two runs of the same arm disagreed on **1 of 135** tasks overall (flip rate
0.7 %), on 2 of 99 positives for the tool choice, and on 2 tasks for
aborts. Rounds per task moved by 0.05, prompt tokens by about 250 per task.
The provider sends neither `temperature` nor `seed`, so this is the floor any
A/B difference has to clear.

### A/B, `uncut` against `current` (aa-1)

| metric | current | uncut | only current right | only uncut right | p (McNemar) |
|---|---|---|---|---|---|
| correct overall | 91.1 % | 91.1 % | 1 | 1 | 1.000 |
| right tool (positives) | 98.0 % | 98.0 % | 1 | 1 | 1.000 |
| tasks aimed at a cut sentence | 78.3 % | 78.3 % | 1 | 1 | 1.000 |
| negatives clean | 100 % | 100 % | 0 | 0 | 1.000 |
| not aborted | 99.3 % | 97.0 % | 4 | 1 | 0.375 |

Paired differences, uncut minus current: **+0.23 rounds**, **+0.16 failed
calls** and **+5,300 prompt tokens per task** (+41 %), +852 tokens in the
first round alone. Against aa-2 the picture is the same (+0.28 rounds,
+5,600 tokens).

With 135 pairs and one discordant pair on each side, a loss of more than about
3 percentage points would very likely have shown; smaller effects are below
what this set can resolve.

### What else the runs showed

- **A real bug, independent of the cuts — #766.** The OpenAI transport sends
  the tools without `strict: false`, so the Responses API treats them as
  strict and the model fills in every optional parameter. `read_file_lines`
  then gets a line *and* a byte range, `apply_patch` gets `patch` *and*
  `edits: []`, and both refuse. The four line/byte tasks failed in every run;
  with `strict: false` they passed 4 of 4 on the first call. This also explains
  part of the uncut arm's extra rounds: its descriptions say "cannot be
  combined", the model cannot comply, and it retries more.
- **One cut sentence did matter for the format.** In the current arm 7 of 23
  `patch` arguments came in OpenAI's own `*** Begin Patch` format, which
  `apply_patch` does not read; in the uncut arm, whose parameter text spells
  out the unified diff format, none of 15 did. The tasks still mostly ended
  correct because the model fell back to `edit_file`. Worth one sentence back
  in the `patch` description once #766 is fixed and the benchmark can show it
  cleanly.
- **Weak spots of the set.** `python-regex-check` never triggered a tool in any
  run — checking a four-character regex in the head is a fair choice, so the
  task measures little. The `run_python` stub prints the same number for every
  program, which sent a few data tasks into retries and the round limit
  (equally in both arms).

### Re-run after #766

Once #766 is fixed, a second A/A + A/B run gives a cleaner comparison: the
strict-mode retries currently add noise to rounds, failed calls and aborts.

## 2026-10-06 — apply_patch tolerance (#771)

Same model, after #766 (`strict: false`). The five `patch-*` tasks, three
repetitions each, three versions run at the same time:

| | before | tolerant parser | tolerant parser + hunk grammar in the description |
|---|---|---|---|
| correct | 73.3 % | 86.7 % | 86.7 % |
| failed calls per task | 0.53 | 0 | 0 |
| rounds per task | 4.00 | 3.47 | 3.13 |
| prompt tokens per task | 16,610 | 14,444 | 12,590 |
| `*** Begin Patch` / bare `@@` / unified | 6 / 1 / 3 | 7 / 3 / 0 | 4 / 0 / 3 |

The parser now reads a bare `@@`, hunk counts that do not match the body and
OpenAI's `*** Begin Patch` format, and every patch call went through. The
remaining misses are the model choosing two `edit_file` calls over one
`apply_patch` — the file ends up right.

The hunk grammar sentence saved rounds almost only on one task
(`patch-cross-file`, 5.0 → 3.0) in three repetitions, and would cost about 26
tokens on every request. Left out.
