// The app's page is served from `snotra-app://app/`, not from `file:`
// (AR-37, #1012). Under `file:` the CSP's `script-src 'self'` covered every
// file on the disk; from the app's own scheme a script from the disk is
// refused, as a tag and as a module, and the page itself still runs.
//
// Two barriers hold now. Chromium refuses a `file:` resource to any page that
// is not itself on `file:` ("Not allowed to load local resource") before the
// CSP is asked, and the CSP's `'self'` no longer matches `file:` either. The
// first one leaves no violation event to see, so the CSP is checked with a
// script from elsewhere, which only it stops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { launchApp, makeTempDir } from './helpers/app.mjs';

test('the renderer comes from the app scheme, and the CSP refuses a script from the disk', { timeout: 120000 }, async (t) => {
  const userDataDir = await makeTempDir('snotra-origin-userdata-');
  const outside = await makeTempDir('snotra-origin-disk-');
  const script = path.join(outside, 'x.js');
  await writeFile(script, 'globalThis.__fromDisk = true;\n');
  const scriptUrl = pathToFileURL(script).href;

  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { page } = snotra;

  const origin = await page.evaluate(() => ({ href: location.href, origin: location.origin, secure: isSecureContext }));
  assert.equal(origin.href, 'snotra-app://app/index.html');
  assert.equal(origin.origin, 'snotra-app://app');
  assert.equal(origin.secure, true, 'the microphone and the audio worklet need a secure context');

  const result = await page.evaluate(async (url) => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({ blocked: event.blockedURI, directive: event.effectiveDirective });
    });
    const tag = await new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = () => resolve('loaded');
      el.onerror = () => resolve('refused');
      document.head.append(el);
    });
    const moduleImport = await import(url).then(() => 'loaded', () => 'refused');
    const remote = await new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = 'https://snotra-origin.invalid/x.js';
      el.onload = () => resolve('loaded');
      el.onerror = () => resolve('refused');
      document.head.append(el);
    });
    // The violation event may come a task after the error.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { tag, moduleImport, remote, ran: globalThis.__fromDisk === true, violations };
  }, scriptUrl);

  assert.equal(result.tag, 'refused');
  assert.equal(result.moduleImport, 'refused');
  assert.equal(result.ran, false, 'the script from the disk did not run');
  assert.equal(result.remote, 'refused');
  assert.ok(
    result.violations.some((v) => v.directive === 'script-src-elem' && URL.canParse(v.blocked) && new URL(v.blocked).host === 'snotra-origin.invalid'),
    `the CSP is in force: ${JSON.stringify(result.violations)}`,
  );
  assert.equal(result.violations.some((v) => v.blocked.startsWith('snotra-app:')), false, 'the app\'s own scripts pass');
});
