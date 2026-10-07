// Copies the app icon into public/ as the favicon. The icon's source of truth
// is assets/icon/ at the repository root; the copy is git-ignored.
import { copyFileSync, mkdirSync } from 'node:fs';

const target = new URL('../public/favicon.svg', import.meta.url);
mkdirSync(new URL('.', target), { recursive: true });
copyFileSync(new URL('../../assets/icon/icon-windows.svg', import.meta.url), target);
