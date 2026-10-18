// The rules the feedback form and main share (#1045), and the prefilled
// GitHub form that is the way round the endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/shared/contracts');

const { feedbackLength, isFeedbackEmail, formatFeedbackDiagnostics, buildFeedbackIssueUrl, FEEDBACK_PREFILL_MAX } = contracts;

const DIAG = { appVersion: '1.25.0', os: 'macOS 15.1', arch: 'arm64', provider: 'openai' };

function paramsOf(url) {
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/kkrafft1999/snotra/issues/new');
  return parsed.searchParams;
}

test('length counts what a person counts, after trimming (#1045)', () => {
  assert.equal(feedbackLength('  abc  '), 3);
  assert.equal(feedbackLength('😀😀'), 2);
  assert.equal(feedbackLength(null), 0);
});

test('an address is checked the way the endpoint checks it (#1045)', () => {
  assert.equal(isFeedbackEmail('du@example.com'), true);
  assert.equal(isFeedbackEmail('du@example'), false);
  assert.equal(isFeedbackEmail('du example@x.de'), false);
  assert.equal(isFeedbackEmail(`${'a'.repeat(250)}@x.de`), false);
});

test('the diagnostics read as one line, missing values left out (#1045)', () => {
  assert.equal(formatFeedbackDiagnostics(DIAG), 'Snotra 1.25.0 · macOS 15.1 · arm64 · openai');
  assert.equal(formatFeedbackDiagnostics({ ...DIAG, provider: '' }), 'Snotra 1.25.0 · macOS 15.1 · arm64');
  assert.equal(formatFeedbackDiagnostics(null), '');
});

test('a bug opens the bug template, prefilled (#1045)', () => {
  const params = paramsOf(buildFeedbackIssueUrl({ kind: 'bug', message: ' It crashed. ', diagnostics: DIAG }));
  assert.equal(params.get('template'), 'bug_report.yml');
  assert.equal(params.get('description'), 'It crashed.');
  assert.equal(params.get('version'), '1.25.0');
  assert.equal(params.get('logs'), 'Snotra 1.25.0 · macOS 15.1 · arm64 · openai');
});

test('an idea opens the feature template, praise a blank issue (#1045)', () => {
  const idea = paramsOf(buildFeedbackIssueUrl({ kind: 'idea', message: 'Dark icons', diagnostics: null }));
  assert.equal(idea.get('template'), 'feature_request.yml');
  assert.equal(idea.get('problem'), 'Dark icons');

  const praise = paramsOf(buildFeedbackIssueUrl({ kind: 'praise', message: 'Love it\nreally', diagnostics: DIAG }));
  assert.equal(praise.get('template'), null);
  assert.equal(praise.get('title'), 'Love it');
  assert.equal(praise.get('body'), 'Love it\nreally\n\n---\nSnotra 1.25.0 · macOS 15.1 · arm64 · openai');
});

test('a long text is cut, so the address stays short enough (#1045)', () => {
  const url = buildFeedbackIssueUrl({ kind: 'idea', message: 'x'.repeat(5000) });
  const problem = paramsOf(url).get('problem');
  assert.ok(problem.startsWith('x'.repeat(FEEDBACK_PREFILL_MAX)));
  assert.ok(problem.endsWith('[…]'));
  assert.ok(url.length < 8000, `address is ${url.length} characters`);
});
