'use strict';

// Zentrale Identitaet der App fuer den Main-Prozess. Der Renderer erhaelt
// den Namen nicht von hier, sondern statisch aus index.html bzw. FileTree.js
// (shared-Module gelangen nur ueber das esbuild-Bundle in den Renderer).
//
// LEGACY_APP_NAME ist der Name bis v1.0.4; er bestimmt den alten
// userData-Ordner, aus dem beim ersten Start migriert wird
// (services/userdata-migration.js).
const APP_NAME = 'Snotra AI';
const LEGACY_APP_NAME = 'Weyouze Anything';

// Muss mit `config.forge.packagerConfig.appBundleId` in package.json
// uebereinstimmen. Das Selbst-Update prueft damit, dass im geladenen Paket
// wirklich diese App steckt, bevor es die installierte ersetzt.
const APP_BUNDLE_ID = 'dev.snotra-ai.app';

module.exports = { APP_NAME, LEGACY_APP_NAME, APP_BUNDLE_ID };
