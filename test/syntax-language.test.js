// Which grammar colours a file in the preview (#745): by name only, and
// plain text for everything the table does not name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importRenderer } = require('./helpers/dom.js');

const load = () => importRenderer('file-views', 'syntax-language.js');

test('extensions pick their grammar, whatever the case', async () => {
  const { syntaxLanguageFor } = await load();
  const expected = {
    'app.js': 'javascript', 'View.JSX': 'jsx', 'types.ts': 'typescript', 'App.tsx': 'tsx',
    'package.json': 'json', 'index.html': 'markup', 'logo.svg': 'markup', 'pom.xml': 'markup',
    'App.vue': 'markup', 'styles.css': 'css', 'theme.scss': 'scss', 'ci.yml': 'yaml',
    'config.yaml': 'yaml', 'Cargo.toml': 'toml', 'setup.cfg': 'ini', 'deploy.sh': 'bash',
    'main.py': 'python', 'Main.java': 'java', 'lib.rs': 'rust', 'main.go': 'go',
    'Program.cs': 'csharp', 'query.sql': 'sql', 'README.md': 'markdown', 'build.gradle': 'groovy',
    'app.properties': 'properties', 'prod.env': 'bash',
  };
  for (const [name, language] of Object.entries(expected)) {
    assert.equal(syntaxLanguageFor(name), language, name);
  }
});

test('names without a telling extension are recognised by the name', async () => {
  const { syntaxLanguageFor } = await load();
  const expected = {
    Makefile: 'makefile', 'Makefile.am': 'makefile', GNUmakefile: 'makefile',
    Dockerfile: 'docker', 'Dockerfile.dev': 'docker', Containerfile: 'docker',
    'CMakeLists.txt': 'cmake',
    '.gitignore': 'ignore', '.dockerignore': 'ignore', '.npmignore': 'ignore',
    '.editorconfig': 'ini', '.npmrc': 'ini', '.prettierrc': 'json', '.eslintrc': 'json',
    '.zshrc': 'bash', '.env': 'bash', '.env.local': 'bash', '.env.production': 'bash',
  };
  for (const [name, language] of Object.entries(expected)) {
    assert.equal(syntaxLanguageFor(name), language, name);
  }
});

test('what has no grammar stays plain — no guessing by content', async () => {
  const { syntaxLanguageFor } = await load();
  for (const name of ['notes.txt', 'server.log', 'package-lock.lock', 'data.csv', 'nginx.conf',
    'README', 'LICENSE', 'CHANGELOG', '.nvmrc', 'archive.xyz', 'noextension', '', null, undefined]) {
    assert.equal(syntaxLanguageFor(name), null, String(name));
  }
});

test('every language the table can return is in the vendored bundle', async () => {
  const { SYNTAX_LANGUAGES } = await load();
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync-renderer-vendor.js'), 'utf8');
  const bundled = JSON.parse(script.match(/const PRISM_LANGUAGES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const language of SYNTAX_LANGUAGES) {
    assert.ok(bundled.includes(language), `${language} is missing from PRISM_LANGUAGES`);
  }
});

test('the vendored Prism compiles no code from strings (CSP: script-src \'self\')', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'prism', 'prism.js'), 'utf8');
  assert.doesNotMatch(bundle, /\bnew Function\s*\(/);
  assert.doesNotMatch(bundle, /(^|[^.\w$])eval\s*\(/);
});
