// Syntax highlighting in the plain-text view (#745), against the real Prism
// bundle: the text stays the file's text, nothing of the file becomes
// markup, and the size limits keep a large file from waiting on colours.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

// Queued behind the view's own step — a frame, then a timer — so it runs
// after the colours were applied, however slow the machine. A fixed wait was
// too short on the Windows runner.
const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function mountView(t, name, content) {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { plainTextView, COLOUR_AT_ONCE_LIMIT, COLOUR_LIMIT } = await importRenderer('file-views', 'plain-text-view.js');
  const hostEl = document.createElement('div');
  document.body.append(hostEl);
  const instance = plainTextView.mount(hostEl, { content, file: { name, path: `/ws/${name}` } });
  t.after(() => instance.unmount());
  const pre = hostEl.querySelector('#preview-content');
  return { instance, pre, COLOUR_AT_ONCE_LIMIT, COLOUR_LIMIT };
}

const roles = (pre) => [...new Set([...pre.querySelectorAll('span')].map((s) => s.className))].sort();

test('the bundle loads in manual mode: it never colours the document on its own', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { default: Prism } = await importRenderer('vendor', 'prism', 'prism.js');
  assert.equal(Prism.manual, true, 'otherwise it would rewrite the code blocks of the Markdown preview');
});

test('a JavaScript file is coloured, and its text is the file character for character', async (t) => {
  const content = '// note\r\nexport const total = (items) =>\r\n\titems.reduce((sum, x) => sum + x.price, 0);\r\nconst s = `a ${b}`; /* end */\r\n';
  const { pre } = await mountView(t, 'cart.js', content);
  assert.equal(pre.textContent, content);
  assert.equal(pre.dataset.language, 'javascript');
  assert.equal(pre.dataset.highlighted, 'true');
  const found = roles(pre);
  for (const role of ['syntax-comment', 'syntax-keyword', 'syntax-function', 'syntax-number', 'syntax-string', 'syntax-punctuation']) {
    assert.ok(found.includes(role), `${role} in ${found.join(', ')}`);
  }
  assert.deepEqual([...pre.querySelectorAll('*')].map((el) => el.tagName).filter((tag) => tag !== 'SPAN'), [], 'spans only');
});

test('a hostile file stays text: no element of its own reaches the DOM', async (t) => {
  const content = [
    '<p>hi</p></pre><script>window.__pwnedSyntax = 1</script>',
    '<img src="x" onerror="window.__pwnedSyntax = 2">',
    '<a href="javascript:alert(1)">x</a><!-- </span><b>bold</b> -->',
  ].join('\n');
  for (const name of ['evil.html', 'evil.md', 'evil.svg', 'evil.php', 'evil.vue']) {
    const { pre } = await mountView(t, name, content);
    assert.equal(pre.textContent, content, name);
    assert.equal(pre.querySelector('script, img, a, b, p'), null, name);
    assert.ok([...pre.querySelectorAll('*')].every((el) => el.tagName === 'SPAN' && /^syntax-[a-z]+$/.test(el.className)
      && el.attributes.length === 1), `${name}: spans with a class and nothing else`);
  }
  assert.equal(globalThis.__pwnedSyntax, undefined);
  assert.equal(window.__pwnedSyntax, undefined);
});

test('a code block in Markdown is coloured in its own language', async (t) => {
  const content = '# Install\n\nRun **this**:\n\n```js\nconst app = await import("./main.js");\n```\n';
  const { pre } = await mountView(t, 'README.md', content);
  assert.equal(pre.textContent, content);
  const keywords = [...pre.querySelectorAll('.syntax-keyword')].map((s) => s.textContent);
  assert.ok(keywords.includes('const') && keywords.includes('await'), keywords.join(','));
  assert.ok([...pre.querySelectorAll('.syntax-bold')].some((s) => s.textContent.includes('this')));
});

test('every grammar of the table keeps the text as it is', async (t) => {
  const { SYNTAX_LANGUAGES } = await importRenderer('file-views', 'syntax-language.js');
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { highlightToFragment } = await importRenderer('file-views', 'syntax-highlight.js');
  const sample = 'a = "b" # c\n<x y="1">{z}</x>\n<?php echo $a; ?>\nfn f(n: i32) -> i32 { n * 2 } // d\n\t[k]\nv: 1.5e3\n';
  for (const language of SYNTAX_LANGUAGES) {
    const fragment = highlightToFragment(sample, language);
    assert.ok(fragment, `${language} is in the bundle`);
    const holder = document.createElement('pre');
    holder.append(fragment);
    assert.equal(holder.textContent, sample, language);
  }
});

test('plain text, logs and unknown types stay plain', async (t) => {
  for (const name of ['notes.txt', 'server.log', 'data.csv', 'nginx.conf', 'LICENSE']) {
    const { pre } = await mountView(t, name, 'const a = 1; // not code here\n');
    assert.equal(pre.querySelector('span'), null, name);
    assert.equal(pre.dataset.language, undefined, name);
    assert.equal(pre.dataset.highlighted, 'false', name);
  }
});

test('an update colours the new text and keeps the scroll position', async (t) => {
  const lines = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const { instance, pre } = await mountView(t, 'values.js', lines);
  pre.scrollTop = 1234;
  pre.scrollLeft = 56;
  const next = `${lines}\nconst added = true;`;
  instance.update({ content: next });
  assert.equal(pre.textContent, next);
  assert.ok(pre.querySelectorAll('.syntax-keyword').length > 400);
  assert.equal(pre.scrollTop, 1234);
  assert.equal(pre.scrollLeft, 56);
});

test('a large file shows plain text first and its colours after the first paint', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { COLOUR_AT_ONCE_LIMIT } = await importRenderer('file-views', 'plain-text-view.js');
  dom.cleanup();
  const line = 'export function f(a, b) { return a + b; } // sum\n';
  const content = line.repeat(Math.ceil((COLOUR_AT_ONCE_LIMIT + 1024) / line.length));
  const { pre } = await mountView(t, 'big.js', content);
  assert.equal(pre.querySelector('span'), null, 'plain at first');
  assert.equal(pre.dataset.highlighted, 'false');
  assert.equal(pre.textContent, content);
  await afterPaint();
  assert.equal(pre.dataset.highlighted, 'true');
  assert.ok(pre.querySelector('.syntax-keyword'));
  assert.equal(pre.textContent, content);
});

test('colours still due are dropped with the view, or with newer text', async (t) => {
  const line = 'let x = 1;\n';
  const big = line.repeat(Math.ceil((64 * 1024 + 1024) / line.length));
  const { instance, pre } = await mountView(t, 'big.js', big);
  instance.unmount();
  await afterPaint();
  assert.equal(pre.querySelector('span'), null, 'nothing is drawn into an unmounted view');

  const second = await mountView(t, 'big2.js', big);
  second.instance.update({ content: 'let y = 2;\n' });
  await afterPaint();
  assert.equal(second.pre.textContent, 'let y = 2;\n', 'the late colours of the old text do not come back');
});

test('beyond the limit a file stays plain', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { COLOUR_LIMIT } = await importRenderer('file-views', 'plain-text-view.js');
  dom.cleanup();
  const line = 'const a = 1;\n';
  const content = line.repeat(Math.ceil((COLOUR_LIMIT + 1) / line.length));
  const { pre } = await mountView(t, 'huge.js', content);
  await afterPaint();
  assert.equal(pre.querySelector('span'), null);
  assert.equal(pre.dataset.highlighted, 'false');
  assert.equal(pre.dataset.language, 'javascript');
});
