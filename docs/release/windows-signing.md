# Signing the Windows build

## How Snotra does it (#911, 2026-10-21)

| Item | Value |
| --- | --- |
| What is signed | `Snotra Agent.exe` in the packaged folder, before it is zipped — nothing else |
| Certificate | SSL.com *Personal ID Code Signing*, individual validation, in the author's name |
| Subject / publisher | `CN=Konrad Krafft` — what Windows shows as the publisher |
| Issuer | SSL.com Code Signing Intermediate CA RSA R1 |
| SSL.com order | `co-3211d91k803` |
| Certificate expiry | **2027-10-19** — renew before, see below |
| Key storage | eSigner, SSL.com's cloud HSM; there is no `.pfx` and no hardware token |
| Timestamp | added by eSigner, so signatures stay valid after the certificate expires |

Why SSL.com and not the SignPath Foundation, Certum or Azure: see #911 and #19.

**Where it happens.** The job `Build Windows (x64)` in
`.github/workflows/release.yml` packages the app, finds `Snotra Agent.exe`,
signs it in place with SSL.com's action
[`sslcom/esigner-codesign`](https://github.com/SSLcom/esigner-codesign)
(pinned by commit), and checks the result with `Get-AuthenticodeSignature`:
status `Valid`, a timestamp, and `Konrad Krafft` as the signer. Only then is
the folder zipped.

**The switch.** With none of the four secrets set the build stays unsigned and
the job leaves a warning. With all four set, every release is signed and a
failed signing or a failed check fails the release — there is no fallback to an
unsigned build. Some but not all of them set is treated as a mistake and fails
the job.

**Secrets** (GitHub Actions, repository level):

| Secret | What it is |
| --- | --- |
| `ES_USERNAME` | SSL.com account username |
| `ES_PASSWORD` | SSL.com account password — a password of the SSL.com account itself, see below |
| `ES_CREDENTIAL_ID` | the certificate's eSigner credential ID (a UUID) |
| `ES_TOTP_SECRET` | the eSigner TOTP secret: the text shown next to the QR code when the eSigner PIN is set |

All four, and the eSigner PIN, are kept in the owner's password manager.

## Cost

Checked 2026-10-18; details and the comparison in #911.

- Certificate: $129 a year.
- eSigner Tier 1: $20 a month for 20 signings, $1 for every further signing;
  the annual plan is 25 % cheaper. One release is one signing.
- At the release pace of autumn 2026 (about 57 releases a month) that is
  roughly $750–810 a year in total. Fewer patch releases are the lever.

## Checking a signed build

On a Windows machine: right-click `Snotra Agent.exe` › *Properties* ›
*Digital Signatures* — `Konrad Krafft`, with a timestamp. In PowerShell:

```powershell
Get-AuthenticodeSignature '.\Snotra Agent.exe' | Format-List Status, SignerCertificate, TimeStamperCertificate
```

A test build comes from a prerelease tag (`vX.Y.Z-something`): the tag check
in `release.yml` lets those through from any branch, and the app never offers a
prerelease as an update.

## SmartScreen

SmartScreen reputation belongs to the certificate and starts at zero. The
first signed releases can still show the "Windows protected your PC" dialog —
now with the publisher's name instead of "Unknown publisher" — until enough
downloads have built reputation. A new certificate (another CA, or a re-key)
starts from zero again.

## Renewal

- The certificate expires on **2027-10-19**. Renew it at SSL.com a few weeks
  before; since 2026 a code signing certificate lasts at most about 460 days,
  so this is a yearly task whatever the term bought.
- A renewed certificate gets a new eSigner credential: update
  `ES_CREDENTIAL_ID`, and `ES_TOTP_SECRET` if a new QR code is issued.
- The eSigner subscription has to stay active. When it lapses, signing fails
  and so does the release.

## Pitfalls met on the way

- **IV, not OV.** SSL.com issues OV only to registered businesses. For an
  individual the order must not carry an organisation; an order that showed
  validation level *IV+OV* asked for articles of incorporation and a Dun &
  Bradstreet entry.
- **Social login.** An SSL.com account created through Google sign-in has no
  SSL.com password; eSigner needs one. Set it through *change password* or the
  password reset on secure.ssl.com. Never put the Google password into a
  secret.
- **Password characters.** The action passes the password to CodeSignTool in
  double quotes on a command line. A long password of letters and digits only
  avoids quoting trouble.
- **QR code.** Resetting the eSigner QR code replaces the TOTP secret; the
  old one in `ES_TOTP_SECRET` stops working.
- **Account 2FA** for the SSL.com login is separate from the eSigner TOTP.
  Turn it on only after a signed release has gone through, and check the next
  one still does.
