---
name: traffic
description: >-
  Pulls the traffic report for snotra-ai.dev from the Firebase Hosting logs (via
  gcloud), prints it, and always builds an HTML report with the charts out of
  it — nothing else, no prose interpretation and no follow-up actions. Triggers
  on sentences like "wie läuft die Website", "Traffic-Report", "wie viele
  Besucher hatte die Seite", "Zugriffszahlen", "Website-Statistik", "wer war auf
  snotra-ai.dev", "schau mal, was auf der Seite los ist", "Besucher letzte
  Woche", "Traffic-Chart", "Diagramm zum Traffic", "how is the website doing",
  "traffic report", "how many visitors did the site have", "website stats" or
  "traffic chart". Only makes sense in this repository (snotra).
---

# Traffic report for snotra-ai.dev

This skill does two things: pull the report and print it (steps 1–2), and build
an HTML report with the charts out of it (step 3). Nothing else — no prose
interpretation of the numbers, no anomaly check, no creating issues, no
cross-checking against the live site. There is no mandate for that unless the
user explicitly asks for it in the message at hand.

The machinery behind it is
[`scripts/traffic-report.js`](../../../scripts/traffic-report.js); the
background is in issue
[#115](https://github.com/kkrafft1999/snotra/issues/115).

## Step 1 — determine the period

Derive it from what the user said, don't ask:

- "heute", "gerade", "aktuell", "today", "right now" → `--tage=1`
- "diese Woche", "letzte Woche", "this week", "last week", nothing said →
  `--tage=7` (the default)
- "diesen Monat", "insgesamt", "seit dem Start", "this month", "overall",
  "since launch" → `--tage=30`

**There is nothing beyond 30 days.** Cloud Logging keeps the entries for 30 days
in the standard bucket, and logging has only been on since **2026-09-13** — the
day it was enabled. Nothing exists before that, and it cannot be recovered. Say
so plainly when somebody asks for earlier numbers, instead of showing an empty
evaluation.

## Step 2 — pull the report

```sh
npm run traffic -- --tage=7
```

It takes roughly 10 to 30 seconds, because `gcloud` fetches the logs page by
page.

If the call fails, the script itself says what to do. The two common cases:

- **"Die gcloud-Anmeldung ist abgelaufen"** — the user has to run
  `gcloud auth login` themselves. Do **not** sign in for them and do not enter
  any credentials; pass the command on.
- **"Keine Leserechte auf das Projekt snotra-ai"** — usually the wrong account
  is active. Two are signed in on this machine; the one needed is the
  **private** account, not the doubleSlash one. Check with `gcloud auth list`,
  switch with `gcloud config set account <account>`.

Pass the script's output on unchanged — don't rephrase it, don't interpret it,
don't comment on it, don't derive follow-up actions from it.

For the HTML report in step 3, pull the same evaluation in machine-readable form
and write it out right away, so that no numbers have to be typed over:

```sh
mkdir -p out/traffic && node scripts/traffic-report.js --json --tage=7 > out/traffic/report.json
```

Do **not** pass `--ohne-downloads`: the release downloads are a fixed part of
the report.

Your own visits can be filtered out:
`npm run traffic -- --eigene-ips=1.2.3.4`, or through `TRAFFIC_EIGENE_IPS`.

## Step 3 — build the HTML report

**Always, without the user having to ask for it.** The HTML report is the
outcome of this skill; the terminal output from step 2 stays alongside it, but
does not replace it.

### Where it goes

A single, self-contained HTML file:

```
out/traffic/traffic-<YYYY-MM-DD>-<days>t.html
```

`out/` is gitignored — the report is **not** committed. The file has to live
**inside the project**, otherwise the preview pane renders it statically,
without JavaScript. Don't publish an artifact: the log data is not something
that belongs outside, unless the user explicitly asks for it.

No external CSS, no CDN script, no build steps — styles and, where needed, the
script inline. Build the charts as plain HTML/CSS or inline SVG from the
numbers; no charting library is needed for that.

### What goes in it

1. **The header** — the title "Traffic-Report snotra-ai.dev", the period
   **actually covered**, from `zeitraum.von`/`zeitraum.bis` (not the one that
   was asked for), and the total number of requests.
2. **The key figures** — sessions, page views and requests by real visitors as
   highlighted numbers right at the top.
3. **Requests by category** — a horizontal bar chart across every category in
   `kategorien` (Echte Besucher, Abrufe ohne Mitladen, KI-Crawler,
   Suchmaschinen, Link-Vorschau, Eigene CI und Tests, Zertifikats-Prüfung,
   Scanner und Angriffsversuche, Fehlende Standarddatei). Labelled directly with
   the count and the share. The categories are disjoint and add up to `gesamt`.
4. **Real visitors in detail** — sessions, page views and the pages that were
   opened (`besucher.seiten`), plus countries and external referrers where
   present. That is the number this is about; it drowns in the big bar chart
   otherwise.
5. **The daily trend** — `proTag` as a small bar or line chart, when the period
   covers more than one day.
6. **Release downloads** — `downloads` from the JSON output, **always**, as a
   section of its own with the version, the date and the count per release, plus
   a total. Along with the note that this is the **total since publication** and
   not the downloads within the evaluated period — those two numbers are not to
   be read side by side. If `downloads` is empty or `null` (which means `gh api`
   didn't work), say so in a short sentence inside the section instead of
   dropping it.
7. **Further tables**, only when they aren't empty: `kiBots`, `suchBots`,
   `scannerZiele`, `fehlend`, `fehler`.

### The rules

- Highlight **real visitors** visually; the other categories still stay
  individually distinguishable, don't collapse them into an "other" bucket.
- Only carry over numbers from the report. No IP addresses, no invented trends,
  no comparisons with periods that weren't queried.
- Leave empty sections out rather than filling them with zeros — except the
  release downloads, which always stay.
- Readable in light and dark (`prefers-color-scheme`), tables with their own
  `overflow-x: auto`, and the page itself never scrolls sideways.
- The report carries a visible heading and a creation stamp with the date, the
  model and the reasoning effort.

### Showing it

After writing the file, open it in the browser pane (`preview_start` with the
`file://` URL of the generated file) and name the path in the conversation.
Don't add a summary of the report afterwards.
