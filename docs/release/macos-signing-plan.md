# A plan for signing and shipping a macOS app

## Goal

The app is to be signed, notarised and published as a DMG or PKG for
distribution outside the Mac App Store. The aim is that macOS Gatekeeper treats
the app as trustworthy and users can open it without warnings about an unknown
source.

> This plan covers a classic macOS app with a **Developer ID**. The Mac App
> Store adds App Store Connect, provisioning and sandbox requirements on top.

## 1. Decisions and prerequisites

- [ ] Decide the distribution channel:
  - [ ] DMG with a `.app` for direct downloads
  - [ ] PKG for installations with an installer or a privileged helper
  - [ ] Mac App Store, if required
- [ ] Decide the bundle identifier, e.g. `com.example.product`.
- [ ] Decide the minimum macOS version and the supported architectures:
  - [ ] Apple Silicon (`arm64`)
  - [ ] Intel (`x86_64`)
  - [ ] a universal binary, if both are supported
- [ ] Define the release and version scheme, e.g.
      `CFBundleShortVersionString = 1.4.0` and `CFBundleVersion = 1400`.
- [ ] Check membership in the Apple Developer Program and access to the team.
- [ ] Name the people responsible for certificates, notarisation and the release.

## 2. Set up Apple certificates and keys

Provide the following identities in the Apple developer account or in Xcode:

- [ ] **Developer ID Application** for signing the app and its embedded
      components.
- [ ] **Developer ID Installer**, only if a signed PKG is published.
- [ ] When using Xcode: select the matching team and signing configuration for
      the release.
- [ ] Keep private keys safe in the keychain or in a CI secret store.
- [ ] Never commit certificates to the repository.
- [ ] Document the expiry date and the renewal process.
- [ ] Use a dedicated release certificate or a dedicated build machine for CI.

For automated notarisation:

- [ ] Create an App Store Connect API key for the responsible user, or a
      suitable Apple ID / keychain configuration.
- [ ] Store the `issuer ID`, the `key ID` and the private `.p8` file securely.
- [ ] Keep the permissions to the necessary minimum.

## 3. Prepare the project for signing

- [ ] Configure a unique bundle identifier in every target, extension, XPC
      service and helper app.
- [ ] Enable the **hardened runtime**.
- [ ] Enable only the hardened-runtime entitlements you need, for example:
  - [ ] JIT, if technically required
  - [ ] unsigned executable memory, if technically required
  - [ ] Apple Events, if the app drives other apps
  - [ ] network, file or hardware permissions only as far as actually needed
- [ ] Keep entitlement files under version control and justify them.
- [ ] Check that no sensitive permission is enabled unnecessarily.
- [ ] Decide the sandbox and privacy configuration, if the app is sandboxed or
      distributed through the Mac App Store.
- [ ] Identify every third-party framework, dylib, plug-in, login item, service
      and helper as a component that has to be signed.
- [ ] Keep unnecessary executables, debug symbols and test data out of the
      release bundle.

## 4. Produce a reproducible release build

- [ ] Use the release configuration, never publish a debug build.
- [ ] Build in a clean environment with pinned toolchain versions.
- [ ] Lock the dependencies and install them reproducibly.
- [ ] Check the architecture and the minimum operating system in the build.
- [ ] Run the unit, integration and UI tests.
- [ ] For universal apps, test the binary separately for both architectures.
- [ ] Label build artifacts with the version number, the commit hash and the
      build date.
- [ ] Change no files inside the app bundle after this point, before signing.

An example with Xcode:

```bash
xcodebuild \
  -workspace MyApp.xcworkspace \
  -scheme MyApp \
  -configuration Release \
  -archivePath build/MyApp.xcarchive \
  archive

xcodebuild -exportArchive \
  -archivePath build/MyApp.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export
```

The concrete export options have to match the distribution channel and the
targets in use.

## 5. Signing

### The recommended order

When signing manually, always sign from the inside out:

1. dylibs and frameworks
2. plug-ins and helper executables
3. XPC services and login items
4. the app bundle
5. the DMG or PKG as the distribution container

Xcode can take these steps over with a correctly configured archive and export
setup. The result still has to be verified independently.

An example of signing an app manually:

```bash
codesign --force --options runtime \
  --entitlements MyApp.entitlements \
  --sign "Developer ID Application: Example Corp (TEAMID)" \
  "build/export/MyApp.app"
```

Where embedded components exist, make sure every executable component has been
signed with the right identity and the matching entitlements. Never copy
placeholders or certificate names into a production script unchecked.

## 6. Verify the signature locally

- [ ] Verify the signature completely and against the expected certificate:

```bash
codesign --verify --deep --strict --verbose=4 "build/export/MyApp.app"
codesign --display --verbose=4 "build/export/MyApp.app"
codesign -d --entitlements :- "build/export/MyApp.app"
```

- [ ] Check that Gatekeeper authorises the whole app:

```bash
spctl --assess --type execute --verbose=4 "build/export/MyApp.app"
```

- [ ] Check every nested executable component for a correct signature.
- [ ] Check that no resource was modified after signing.
- [ ] Test the app on a clean Mac or in a clean VM, ideally one without a prior
      developer installation.
- [ ] Test the behaviour on first launch, on updates, when the quarantine flag
      is removed and when permissions are missing.

## 7. Notarisation with Apple

For direct distribution, the signed software has to be submitted to Apple's
notarisation service.

- [ ] Configure notarisation credentials in CI or locally.
- [ ] Pack the app as a ZIP that preserves the app bundle:

```bash
ditto -c -k --keepParent \
  "build/export/MyApp.app" \
  "build/notary/MyApp.zip"
```

- [ ] Submit the ZIP with `notarytool`:

```bash
xcrun notarytool submit "build/notary/MyApp.zip" \
  --key "$ASC_KEY_PATH" \
  --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID" \
  --wait
```

- [ ] On failure, fetch the log and read it:

```bash
xcrun notarytool log <SUBMISSION-ID> \
  --key "$ASC_KEY_PATH" \
  --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID"
```

- [ ] Publish the distribution artifact only after notarisation succeeded.

## 8. Build and seal the DMG or PKG

### DMG

- [ ] Put only the already signed and notarised app into the DMG.
- [ ] Make no changes to the app afterwards.
- [ ] Create the DMG, then sign the DMG itself with **Developer ID
      Application**:

```bash
hdiutil create -volname "MyApp" \
  -srcfolder "build/export/MyApp.app" \
  -ov -format UDZO \
  "build/release/MyApp.dmg"

codesign --force --sign \
  "Developer ID Application: Example Corp (TEAMID)" \
  "build/release/MyApp.dmg"
```

- [ ] Submit the DMG for notarisation, either together with the app or as the
      final distribution artifact.
- [ ] Staple the ticket once notarisation succeeded:

```bash
xcrun stapler staple "build/release/MyApp.dmg"
xcrun stapler validate "build/release/MyApp.dmg"
```

### PKG

- [ ] Sign the component PKG with **Developer ID Installer**.
- [ ] Submit the final PKG, then staple and validate it once it passes:

```bash
productbuild --component "build/export/MyApp.app" /Applications \
  --sign "Developer ID Installer: Example Corp (TEAMID)" \
  "build/release/MyApp.pkg"

xcrun notarytool submit "build/release/MyApp.pkg" --wait ...
xcrun stapler staple "build/release/MyApp.pkg"
xcrun stapler validate "build/release/MyApp.pkg"
```

The `...` placeholder has to be replaced by the configured credentials. With
complex installation scripts, pay particular attention to whether those are
signed as well and accepted by macOS.

## 9. Final integrity and functional tests

- [ ] Verify the signature of the final DMG/PKG:

```bash
codesign --verify --verbose=4 "build/release/MyApp.dmg"
pkgutil --check-signature "build/release/MyApp.pkg"  # PKG only
```

- [ ] Check the notarisation status and the stapling:

```bash
xcrun stapler validate "build/release/MyApp.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 \
  "build/release/MyApp.dmg"
```

- [ ] Download the artifact on a clean system and run it.
- [ ] Check the download over HTTPS, and that the file name and size are right.
- [ ] Publish a checksum if users are meant to verify the integrity themselves:

```bash
shasum -a 256 "build/release/MyApp.dmg"
```

- [ ] Test the first launch without Xcode, local development certificates or
      local build files.
- [ ] Test the upgrade from the previous version.
- [ ] Test uninstalling and installing again.
- [ ] Test privacy dialogs, keychain access, login items, updates and network
      access.

## 10. CI/CD and security

- [ ] Allow signing and notarisation only in a protected release job.
- [ ] Take certificates and API keys from secret management, not from plain-text
      files.
- [ ] Use short-lived or dedicated CI keys where possible.
- [ ] Check the logs for leaked certificates and secrets.
- [ ] Run build, signing, notarisation and publishing as separate steps with an
      approval gate.
- [ ] Archive the signed artifacts and their checksums.
- [ ] Record the commit hash, the Xcode version, the macOS version, the signing
      identity and the notarisation ID.
- [ ] Monitor certificate expiry and emergency rotation.
- [ ] If a key is compromised, revoke it immediately, rotate the CI secrets and
      publish a new version.

## 11. Release checklist

- [ ] Version number and release notes updated
- [ ] Release tests passed
- [ ] Every target and embedded component signed
- [ ] Hardened runtime active
- [ ] `codesign --verify` passed
- [ ] `spctl` check passed
- [ ] Notarisation succeeded
- [ ] Ticket stapled to the DMG/PKG and validated
- [ ] Clean installation and upgrade test passed
- [ ] Checksum created
- [ ] Download page and documentation updated
- [ ] Artifact, logs and notarisation ID archived
- [ ] Rollback to the previous version prepared

## The recommended order of implementation

1. Decide the bundle identifier, the targets, the architectures and the
   distribution channel.
2. Set up the Developer ID certificates and secure CI secrets.
3. Configure the hardened runtime and minimal entitlements.
4. Automate a reproducible release build.
5. Set up signing for every nested component.
6. Automate the local signature and Gatekeeper checks.
7. Integrate notarisation with `notarytool`.
8. Build, sign and staple the DMG/PKG.
9. Test a clean installation, an upgrade and the first launch on the supported
   macOS versions.
10. Document the approval process, the monitoring and the certificate rotation.
