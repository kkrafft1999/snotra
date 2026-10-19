// A system without encrypted storage, from the first line of main on (#1156).
//
// Loaded into the Electron main process with `electron -r <this>` (`launchApp`'s
// `mainPreload`), so it runs before the app's own code. Main reads
// `safeStorage.isEncryptionAvailable()` once at start for the platform register
// the window shows (src/main/platforms/running-platform.js); switching it off
// after the start, as the manual scripts did before #1156, reaches the guards
// but no longer the window. This is what a Linux desktop without a keyring
// looks like from the first frame.

'use strict';

const { safeStorage } = require('electron');

safeStorage.isEncryptionAvailable = () => false;
