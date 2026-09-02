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

module.exports = { APP_NAME, LEGACY_APP_NAME };
