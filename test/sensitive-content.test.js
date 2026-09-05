// Erkennung sensibler Inhalte (Issue #66, Konzept §4): Private-Key-Header,
// Token-Präfixe, Credential-Zuweisungen, Bearer-Token, Maskierung, eigene
// Secrets. Die Testwerte sind erfunden und folgen nur den Formaten.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SENSITIVE_CONTENT_RULES_VERSION,
  scanSensitiveContent,
  maskSensitiveContent,
  containsOwnSecret,
  looksLikeSecretValue,
} = require('../src/shared/runtime/sensitive-content');

function rules(text) {
  return scanSensitiveContent(text).findings.map((f) => f.rule);
}

test('Regelsatz ist versioniert', () => {
  assert.equal(SENSITIVE_CONTENT_RULES_VERSION, 1);
});

test('Private-Key-Header werden erkannt', () => {
  assert.deepEqual(rules('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), ['private-key-header']);
  assert.deepEqual(rules('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private-key-header']);
  assert.deepEqual(rules('-----BEGIN PRIVATE KEY-----'), ['private-key-header']);
  assert.deepEqual(rules('-----BEGIN PUBLIC KEY-----'), [], 'öffentliche Schlüssel sind kein Inhaltsbefund');
});

// Die Beispielwerte sind erfunden und werden zur Laufzeit zusammengesetzt,
// damit Secret-Scanner (z. B. GitHub Push Protection) sie nicht für echte
// Schlüssel halten.
const fake = (...parts) => parts.join('');

test('bekannte Token-Präfixe werden erkannt', () => {
  const samples = {
    'github-token': fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123'),
    'openai-style-key': fake('sk-proj-', 'abcdefghijklmnopqrstuvwxyz'),
    'slack-token': fake('xoxb-', '1234567890-abcdefghij'),
    'aws-access-key-id': fake('AKIA', 'IOSFODNN7EXAMPLE'),
    'google-api-key': fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuv'),
    'gitlab-token': fake('glpat-', 'abcdefghijklmnopqrstuvwxyz'),
    'huggingface-token': fake('hf_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    'npm-token': fake('npm_', 'a'.repeat(36)),
    'stripe-key': fake('sk_', 'live_', 'abcdefghijklmnopqrstuvwxyz'),
    'bearer-token': fake('Authorization: Bearer ', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.abc123'),
  };
  for (const [rule, text] of Object.entries(samples)) {
    assert.ok(rules(`x ${text} y`).includes(rule), `${rule}: ${text}`);
  }
});

test('nichtleere Credential-Zuweisungen treffen, Platzhalter und Code nicht', () => {
  const positive = [
    'api_key = "abcdefgh12345678"',
    '"password": "correct-horse-battery"',
    'export SECRET_KEY=abcdefgh1234',
    fake('OPENAI_API_KEY=', 'sk-nope-but-long-enough-1'),
    "client_secret: 'q1w2e3r4t5y6'",
    'access-token = a1b2c3d4e5f6g7h8',
  ];
  for (const text of positive) assert.ok(rules(text).includes('credential-assignment'), text);

  const negative = [
    'API_KEY=<your-key>',
    'password: ""',
    'password=${PASSWORD}',
    'token: your-token-here',
    'secret_key: changeme-please',
    'const secret = process.env.SECRET;',
    'const token = getToken();',
    'password = user.password',
    'OPENAI_API_KEY=',
    'normal text about tokens and passwords',
    'api_key: example-key',
    'password: xxxxxxxxxx',
  ];
  for (const text of negative) assert.deepEqual(rules(text), [], text);
});

test('looksLikeSecretValue: Anführungszeichen machen Werte glaubhaft, nackte Werte brauchen Ziffern oder Länge', () => {
  assert.equal(looksLikeSecretValue('short', { quoted: true }), false);
  assert.equal(looksLikeSecretValue('longenough', { quoted: true }), true);
  assert.equal(looksLikeSecretValue('longenough', { quoted: false }), false);
  assert.equal(looksLikeSecretValue('longenough1', { quoted: false }), true);
  assert.equal(looksLikeSecretValue('averyveryverylongvalue', { quoted: false }), true);
  assert.equal(looksLikeSecretValue('process.env.SECRET_KEY_1', { quoted: false }), false);
  assert.equal(looksLikeSecretValue('<placeholder-1>', { quoted: true }), false);
});

test('Befunde nennen Regel und Zeile, aber nie den Wert', () => {
  const result = scanSensitiveContent('zeile 1\nzeile 2\napi_key = "abcdefgh12345678"\n');
  assert.equal(result.sensitive, true);
  assert.deepEqual(result.findings, [{ rule: 'credential-assignment', line: 3 }]);
  assert.equal(JSON.stringify(result).includes('abcdefgh12345678'), false);
});

test('zu große oder nicht-textuelle Eingaben gelten als nicht prüfbar', () => {
  assert.deepEqual(scanSensitiveContent('x'.repeat(50), { maxChars: 10 }), { sensitive: false, findings: [], scannable: false });
  assert.equal(scanSensitiveContent(Buffer.from('a')).scannable, false);
  assert.equal(scanSensitiveContent('').scannable, true);
});

test('Maskierung ersetzt Werte, lässt Struktur und harmlosen Code stehen', () => {
  const masked = maskSensitiveContent(
    'api_key = "abcdefgh12345678"; PASSWORD=hunter2hunter2; token = getToken();\n' +
      fake('Authorization: Bearer ', 'abcdefghijklmnopqrstuvwxyz ', 'ghp_', 'abcdefghijklmnopqrstuvwxyz0123\n') +
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----'
  );
  assert.equal(masked.includes('abcdefgh12345678'), false);
  assert.equal(masked.includes('hunter2hunter2'), false);
  assert.equal(masked.includes(fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123')), false);
  assert.equal(masked.includes('MIIEsecret'), false);
  assert.match(masked, /api_key = "\[maskiert\]"/);
  assert.match(masked, /token = getToken\(\);/);
  assert.match(masked, /Bearer \[maskiert\]/);
  assert.match(masked, /-----BEGIN RSA PRIVATE KEY-----\n\[maskiert\]\n-----END RSA PRIVATE KEY-----/);
  assert.equal(maskSensitiveContent(''), '');
});

test('containsOwnSecret vergleicht nur ausreichend lange, wörtliche Treffer', () => {
  assert.equal(containsOwnSecret('config: sk-own-provider-key-123456', ['sk-own-provider-key-123456']), true);
  assert.equal(containsOwnSecret('nichts', ['sk-own-provider-key-123456']), false);
  assert.equal(containsOwnSecret('abc', ['abc']), false, 'zu kurz, um als Geheimnis zu gelten');
  assert.equal(containsOwnSecret('x', null), false);
  assert.equal(containsOwnSecret(null, ['sk-own-provider-key-123456']), false);
});
