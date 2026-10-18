// The feedback form end to end (#1045): the sidebar's button opens it, main
// sends it to the endpoint — a fake one on a loopback port, through
// SNOTRA_FEEDBACK_ENDPOINT — and a failure keeps the text and offers GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat } from './helpers/app.mjs';

/** A fake endpoint answering with the given statuses in turn; it records each body. */
async function startFakeEndpoint(statuses) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      bodies.push({ method: req.method, contentType: req.headers['content-type'], body: JSON.parse(raw) });
      const status = statuses[Math.min(bodies.length - 1, statuses.length - 1)];
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status === 201
        ? { id: 'f1', issueUrl: 'https://github.com/kkrafft1999/snotra/issues/4242' }
        : { error: 'upstream_failed' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/feedback`,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('feedback goes through main to the endpoint; a failure keeps the text and offers GitHub (#1045)', { timeout: 180000 }, async (t) => {
  const endpoint = await startFakeEndpoint([502, 201]);
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-feedback-ws-');
  const userDataDir = await makeTempDir('snotra-feedback-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const snotra = await launchApp({ userDataDir, env: { SNOTRA_FEEDBACK_ENDPOINT: endpoint.url } });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await endpoint.close();
  });
  const { app, page } = snotra;
  await waitForFolderChat(page);
  // No browser opens from a test: record what would have been opened.
  await app.evaluate(({ shell }) => {
    globalThis.__snotraOpened = [];
    shell.openExternal = async (url) => { globalThis.__snotraOpened.push(url); };
  });

  await page.click('#btn-sidebar-feedback');
  await poll(
    () => page.evaluate(() => document.getElementById('feedback-diagnostics-values').textContent.startsWith('Snotra ')),
    { what: 'feedback form with its diagnostics' },
  );
  await page.fill('#feedback-message', 'The tree forgets its scroll position after a rename.');
  await page.evaluate(() => { document.querySelector('input[name="feedback-kind"][value="bug"]').click(); });

  // First attempt: the endpoint fails as when GitHub does not take the issue.
  await page.click('#feedback-send');
  await poll(() => page.evaluate(() => !document.getElementById('feedback-fallback').hidden), { what: 'fallback after a failure' });
  assert.equal(await page.inputValue('#feedback-message'), 'The tree forgets its scroll position after a rename.');
  await page.click('#feedback-github');
  const opened = await poll(async () => {
    const urls = await app.evaluate(() => globalThis.__snotraOpened);
    return urls.length ? urls : null;
  }, { what: 'the GitHub issue form opened' });
  const prefilled = new URL(opened[0]);
  assert.equal(prefilled.pathname, '/kkrafft1999/snotra/issues/new');
  assert.equal(prefilled.searchParams.get('template'), 'bug_report.yml');
  assert.equal(prefilled.searchParams.get('description'), 'The tree forgets its scroll position after a rename.');

  // Second attempt goes through.
  await page.click('#feedback-send');
  await poll(() => page.evaluate(() => !document.getElementById('feedback-sent').hidden), { what: 'the thank-you view' });
  assert.match(await page.textContent('#feedback-sent-body'), /#4242/);

  assert.equal(endpoint.bodies.length, 2);
  const [, sent] = endpoint.bodies;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.contentType, 'application/json');
  assert.equal(sent.body.kind, 'bug');
  assert.equal(sent.body.message, 'The tree forgets its scroll position after a rename.');
  assert.deepEqual(Object.keys(sent.body.diagnostics).filter((key) => !['appVersion', 'os', 'arch', 'provider'].includes(key)), []);
  assert.match(sent.body.diagnostics.appVersion, /^\d+\.\d+\.\d+/);
  assert.equal('email' in sent.body, false);
  // Nothing beyond what the contract allows, and no path from this machine.
  assert.deepEqual(Object.keys(sent.body).filter((key) => !['kind', 'message', 'diagnostics', 'locale'].includes(key)), []);
  assert.ok(!JSON.stringify(sent.body).includes(workspace), 'the workspace path must not be sent');
});
