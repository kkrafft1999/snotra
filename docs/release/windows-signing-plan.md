# Signing the Windows build

Issue [#19](https://github.com/kkrafft1999/snotra/issues/19). The macOS
counterpart is [`macos-signing-plan.md`](./macos-signing-plan.md).

## The decision (2026-10-12)

`Snotra Agent.exe` is signed through the **SignPath Foundation**, which signs
open-source projects for free. Windows then names *SignPath Foundation* as the
publisher, not Snotra's author. A certificate in the author's own name is
tracked for later in [#911](https://github.com/kkrafft1999/snotra/issues/911).

What was ruled out, and why:

| Option | Why not (now) |
| --- | --- |
| Azure Artifact Signing | Individual developers must be located in the US or Canada; EU access is for organisations only, and Snotra has no legal entity behind it ([quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart), checked 2026-10-12). |
| OV certificate with cloud HSM | Costs money every year and needs a CA whose cloud HSM works unattended in CI. Kept as #911. |
| EV certificate | Expensive, and since 2024 it no longer earns immediate SmartScreen reputation. |

Signing does not make SmartScreen silent on day one. Reputation still builds
up through downloads, but it builds up on the certificate rather than on every
single file hash, so it carries over from one release to the next.

## How it works

The `build-windows` job in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml):

1. packages the app (`npm run package:win`) and checks its contents,
2. uploads the unsigned folder as the workflow artifact `windows-unsigned`,
3. submits a signing request with `signpath/github-action-submit-signing-request`,
4. **waits for a manual approval** in SignPath (up to five hours),
5. gets the folder back with `Snotra Agent.exe` signed,
6. checks with `Get-AuthenticodeSignature` that the signature is valid,
   timestamped and issued to SignPath Foundation,
7. zips the signed folder as `Snotra-Agent-<version>-win-x64.zip`.

What gets signed is defined in
[`.signpath/windows-package.xml`](../../.signpath/windows-package.xml): only
`Snotra Agent.exe`, and only when its version resource says *Snotra Agent* at
the version of the tag. The Electron DLLs next to it stay unsigned. The
foundation signs a project's own binaries only, and those are Electron's,
shipped unchanged.

Steps 2 to 6 run only when the repository variable `SIGNPATH_ORGANIZATION_ID`
is set. Until then the job prints a warning and ships the unsigned build as
before. Once it is set, a failed or rejected signing request fails the
release: there is no silent fallback to an unsigned build.

## Setting it up

Everything below is done by hand, by the project owner.

### 1. Meet the foundation's conditions

The [SignPath Foundation terms](https://signpath.org/terms) ask, among other
things, for:

- [x] an OSI-approved licence without commercial dual-licensing: Apache-2.0,
- [x] no proprietary components in what is signed,
- [x] a released product whose functions are documented: README and
      [docs.snotra-ai.dev](https://docs.snotra-ai.dev),
- [x] an automated build from the public repository on GitHub-hosted runners,
- [x] a **code signing policy** on the home page and the download page, with
      the free-signing attribution, the team roles and a privacy statement.
      The README carries it. The website needs it too, see the promotion
      repository.
- [ ] **MFA** for every team member, on GitHub and on SignPath,
- [ ] a disclosure of everything the app sends over the network, with a way
      to switch it off. The privacy statement in the README covers the update
      check and the model providers. Whether the foundation also wants a
      switch for the automatic update check at start, which Snotra does not
      have yet, is the open question of the application.

### 2. Apply

Apply at [signpath.org](https://signpath.org) with the repository URL. The
foundation reviews the project and reserves the right to decline it.

### 3. Configure the SignPath project

Once the application is accepted:

| Setting | Value |
| --- | --- |
| Project slug | `snotra` |
| Trusted build system | the predefined *GitHub.com* build system, linked to the project |
| Artifact configuration | slug `windows-package`, content copied from `.signpath/windows-package.xml` |
| Signing policy | slug `release-signing`, certificate from the foundation, **manual approval** by the approver |
| Approver | `kkrafft1999` |

The policy decides which refs may be signed. Release tags `v*` have to be
allowed. Prerelease tags from a branch are only signed if the policy allows
them as well; otherwise their release run fails at the signing step.

### 4. Connect GitHub

In the repository settings, *Secrets and variables › Actions*:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | API token of a SignPath user with *submitter* rights on the project |
| Variable | `SIGNPATH_ORGANIZATION_ID` | the organisation ID shown in SignPath |

Setting the variable is the switch that activates signing.

### 5. Try it on a prerelease

Push a prerelease tag (`vX.Y.Z-rc.1`), approve the request in SignPath and
check:

- the job log shows *Signed by: … SignPath Foundation* and a timestamp,
- on a Windows machine, the properties of `Snotra Agent.exe` show a valid
  digital signature,
- `product-version` matched. Electron writes the version from
  `package.json` into the version resource; if SignPath compares it as
  `X.Y.Z.0`, the parameter in the release job needs that form.

### 6. Tell the users

After the first signed release, in the same pull request:

- README (`README.md`, `README.de.md`): the Windows bullet under *Download*
  and the "What Snotra doesn't have yet" line,
- user manual: *Getting started › Install* (English and German), the
  SmartScreen step,
- the website's download page.

## Later

- The in-app updater on Windows replaces the folder without checking the new
  executable's signature. With signed builds it could refuse an update whose
  `Snotra Agent.exe` is not signed by the expected publisher.
- [#911](https://github.com/kkrafft1999/snotra/issues/911): a certificate in
  the author's own name.
