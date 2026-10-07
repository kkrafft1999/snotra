'use strict';

// Zentrale Identitaet der App fuer den Main-Prozess. Der Renderer erhaelt
// den Namen nicht von hier, sondern statisch aus index.html bzw. FileTree.js
// (shared-Module gelangen nur ueber das esbuild-Bundle in den Renderer).
//
// LEGACY_APP_NAME ist der Name bis v1.0.4; er bestimmt den alten
// userData-Ordner, aus dem beim ersten Start migriert wird
// (services/userdata-migration.js).
const APP_NAME = 'Snotra Agent';
const LEGACY_APP_NAME = 'Weyouze Anything';

// The platform the app belongs to (#795). Snotra Agent is a product on Snotra
// AI, and what it stores belongs to the platform: Electron derives the
// userData folder and the safeStorage key (the keychain item "Snotra AI Safe
// Storage" on macOS, libsecret on Linux) from the name the app carries when
// it starts, and keeps both even when the name changes afterwards. index.js
// therefore starts under this name and takes APP_NAME once it is ready, so
// the rename moved no data and left every stored key readable.
const STORAGE_NAME = 'Snotra AI';

// Muss mit `config.forge.packagerConfig.appBundleId` in package.json
// uebereinstimmen. Das Selbst-Update prueft damit, dass im geladenen Paket
// wirklich diese App steckt, bevor es die installierte ersetzt.
const APP_BUNDLE_ID = 'dev.snotra-ai.app';

// Every name a package of this app may carry (#794). The app is renamed from
// Snotra AI to Snotra Agent (#795); the updater accepts both, so the release
// that renames it installs over one that does not, and the other way round.
const PRODUCT_NAMES = Object.freeze(['Snotra AI', 'Snotra Agent']);

module.exports = { APP_NAME, STORAGE_NAME, LEGACY_APP_NAME, APP_BUNDLE_ID, PRODUCT_NAMES };
