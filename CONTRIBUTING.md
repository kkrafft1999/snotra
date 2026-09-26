# Contributing to Snotra AI

Thanks for looking. Snotra AI is a personal hobby and experimentation project,
so interfaces, UI and configuration can change at any time — but issues, pull
requests and questions are welcome.

**English is the project language.** Issues, pull request titles and
descriptions, commit messages and release notes are written in English. German
is a fully supported *product* language: the application UI is bilingual
(English by default, German selectable under *Settings › General*), and
[`README.de.md`](./README.de.md) is maintained alongside the English README. Some documents under `docs/` are still German; they are being translated
gradually.

## First contribution

You don't need write access to this repository — outside contributions come in
through a fork. The whole path, from nothing to an open pull request:

1. **Pick an issue.** Issues labelled
   [`good first issue`](https://github.com/kkrafft1999/snotra/labels/good%20first%20issue)
   are self-contained and come with a *Getting started* section that names the
   files involved. Comment on the issue to say you're taking it, so two people
   don't do the same work.
2. **Fork** the repository on GitHub (*Fork* button, top right).
3. **Clone your fork** and add this repository as `upstream`:

   ```bash
   git clone https://github.com/<your-user>/snotra.git
   cd snotra
   git remote add upstream https://github.com/kkrafft1999/snotra.git
   ```

4. **Set up and run the tests** as described under
   [Prerequisites](#prerequisites) and [Tests](#tests).
5. **Branch off an up-to-date `main`:**

   ```bash
   git fetch upstream
   git switch -c fix/short-description upstream/main
   ```

6. **Commit, push to your fork and open the pull request** against
   `kkrafft1999/snotra:main`:

   ```bash
   git push -u origin fix/short-description
   ```

   GitHub then offers *Compare & pull request* on your fork. Put
   `Closes #N` in the description. What happens after that is described under
   [Branches and pull requests](#branches-and-pull-requests).

To bring your fork's branch up to date later, `git fetch upstream` and merge
`upstream/main` into it.

## Prerequisites

- **Node.js ≥ 24** (Active LTS). The version is pinned in
  [`.nvmrc`](./.nvmrc) — with nvm, `nvm use` picks it up. CI runs Node 24 on
  macOS, Windows and Linux.
- **npm** (ships with Node). Dependencies are installed with `npm install`
  locally and `npm ci` in CI.
- No global tooling is required. Building Linux installers additionally needs
  `dpkg`, `fakeroot` and `mksquashfs`; see the
  [README](./README.md#building--packaging-the-app).

```bash
git clone https://github.com/kkrafft1999/snotra.git   # or your fork, see above
cd snotra
nvm use          # or make sure node -v reports v24.x
npm install
npm start        # runs the app in development mode
```

## Tests

Two levels, both required to be green before a pull request is opened:

```bash
npm test         # unit and DOM tests (node --test, happy-dom)
npm run test:e2e # smoke test against the running Electron app (playwright-core)
```

`npm test` covers the wiring: the application core, the main-process adapters
and the renderer components against a `happy-dom` DOM. `npm run test:e2e`
launches the real Electron app against a fake OpenAI-compatible model server and
checks what a DOM stand-in cannot — sanitizing with the real DOMPurify, layout
and focus in the running window. It takes a few seconds and is **not** part of
`npm test`.

The e2e test opens a real window and therefore needs a display. On a headless
Linux machine or in a container, run it under Xvfb the way CI does:

```bash
xvfb-run --auto-servernum npm run test:e2e
```

(`xvfb-run` comes with the `xvfb` package, e.g. `sudo apt-get install xvfb`.)

Both run in CI on macOS, Windows and Linux ([`ci.yml`](./.github/workflows/ci.yml))
and are required status checks on `main`. Windows in particular catches things a
Mac does not (line endings, drive paths), so a green local run on one platform is
not a guarantee.

Optional:

```bash
npm run coverage # coverage with separate thresholds for core and renderer
```

Coverage is a local ratchet, not a merge condition — the thresholds in
`scripts/coverage.js` sit just below the measured state so that a regression
stands out. If you lower one, say why in the commit.

## Where tasks live

Everything that is due — bugs, individual features and larger topics — is a
**GitHub issue**: <https://github.com/kkrafft1999/snotra/issues>. There is no
roadmap file and no task list in the repository.

- Templates: 🐛 [Bug report](./.github/ISSUE_TEMPLATE/bug_report.yml) and
  💡 [Feature request](./.github/ISSUE_TEMPLATE/feature_request.yml).
- Progress is tracked on the
  [Snotra AI project board](https://github.com/users/kkrafft1999/projects/2):
  *Backlog* → *Ready* → *In progress* → *In review* → *Done*. The **Ready**
  column is what is next; the flat issue list shows everything as equally
  important, and the prioritisation lives on the board.

Please open an issue before starting on anything larger than a fix, so the
approach can be discussed before the work exists.

## Questions and ideas

Not everything is a task. Questions, half-formed ideas, feedback and "look what
I built with it" belong in
[GitHub Discussions](https://github.com/kkrafft1999/snotra/discussions):

- **Q&A** — how do I …, why does it …, is this a bug or am I holding it wrong.
- **Ideas** — something that might become a feature, before it is concrete
  enough for a feature request.
- **Show and tell** — skills, tools and setups you use Snotra AI with.

Once an idea is concrete, it moves into an issue; a discussion that turns out
to be a bug is converted into one.

## Branches and pull requests

`main` is protected by a repository ruleset: direct pushes are rejected, force
pushes and branch deletion are blocked, and the three `Tests (…)` contexts are
required. Every change goes through a pull request — no exceptions, including
release version bumps.

1. **Branch off `main`** — in your fork, if you don't have write access (see
   [First contribution](#first-contribution)). Name it after what it does, e.g.
   `fix/tree-drop-collision` or `feature/mcp-http-transport`.
2. **Commit in readable steps**, with messages in English. Present tense,
   imperative mood, one concern per commit.
3. **Run both test levels locally** and make sure they are green.
4. **Open a pull request** with `Closes #N` referencing the issue. The keyword
   has to be English — a German "Schließt #N" closes nothing.
5. **Wait for the pipeline.** All required checks green, no conflicts with
   `main`, no open review comments that need an answer. On a first-time
   contributor's pull request, GitHub holds the workflows until a maintainer
   approves them — if the checks show as waiting, nothing is broken; they start
   once the run is approved.
6. **Squash-merge** (done by a maintainer for pull requests from forks), so that `main` carries one commit per pull request with the
   PR number in the title, and delete the branch afterwards.

Keep the diff to the task at hand: no unrelated changes swept in, no credentials
or keys, and nothing touching the release process or the workflows under
`.github/` unless that is what the issue is about.

## Code conventions

There is no linter and no formatter in the repository; match the style of the
surrounding code.

- **Layering is enforced by tests, not by convention.** `src/application/`
  imports only from `src/application/` and `src/shared/` — no Electron, no
  provider implementations, no file system.
  `test/application-layer-imports.test.js` and
  `test/infrastructure-boundaries.test.js` fail if that slips.
  [`docs/architecture.md`](./docs/architecture.md) explains the layers, the
  ports and why they are cut the way they are — it is the entry point for
  contributors.
- **The renderer is presentation only.** DOM construction, Markdown rendering,
  local formatting. Anything that can be *decided* without touching a node
  belongs next to the component, where it can be tested on its own.
- **New behaviour comes with a test.** Prefer a plain `node:test` unit test;
  reach for the DOM helper (`test/helpers/dom.js`) when a component is involved,
  and for the e2e smoke test only when nothing else can cover it.
- **Security boundaries are not conveniences.** The workspace is the trust
  boundary of the file system; tool risk classes, the approval flow and the
  sensitive-path detection are described in
  [`docs/security-concept.md`](./docs/security-concept.md). If a
  change touches any of them, say so in the pull request.

## UI work

The project holds a high bar for UI, not just for "it works". A visible change
is finished when it also looks right: all states played through (empty, loading,
error, very long content, hover/focus/active/disabled, light **and** dark),
spacing and contrast set deliberately rather than approximated, keyboard
operation and visible focus intact, WCAG 2.1 AA. Look at the running app or a
mockup before calling it done.

## Reporting security issues

Please do not open a public issue for a vulnerability. Report it privately
through GitHub's security advisories on the repository, or by email to the
address on the maintainer's GitHub profile.

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](./LICENSE), like the rest of the project.
