const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'src', 'renderer', 'vendor');
const fontsDir = path.join(vendor, 'fonts');

fs.mkdirSync(vendor, { recursive: true });
fs.mkdirSync(fontsDir, { recursive: true });

// Sandboxed preload cannot load sibling modules from disk — bundle into one file.
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'preload', 'index.js')],
  bundle: true,
  platform: 'node',
  external: ['electron'],
  outfile: path.join(root, 'src', 'preload', 'bundle.js'),
});

// ── Contract-Schicht als ESM fuer den Renderer bereitstellen ────────────────
// Die Verträge (src/shared/contracts, CommonJS) sind die Single Source of Truth
// für Main und Renderer. Der Renderer lädt native ES-Module ohne Bundler, kann
// CommonJS also nicht direkt importieren — daher hier ein ESM-Bundle erzeugen
// (analog zum Preload-Bundle). esbuild wrappt CJS als Default-Export, der
// Renderer importiert entsprechend `import contracts from '…/contracts.js'`.
const generatedDir = path.join(root, 'src', 'renderer', 'generated');
fs.mkdirSync(generatedDir, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'shared', 'contracts', 'index.js')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: path.join(generatedDir, 'contracts.js'),
});

// ── Message catalogues as ESM for the renderer ──────────────────────────────
// Same reasoning as for the contracts (epic #277): `src/shared/i18n` is
// CommonJS and is used by main *and* renderer. The renderer gets an ESM bundle
// out of it instead of a second, diverging copy of the strings.
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'shared', 'i18n', 'index.js')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: path.join(generatedDir, 'i18n.js'),
});

// ── Front matter parser for the renderer ────────────────────────────────────
// The Markdown viewer (#344) reads the YAML head of a file with the same
// parser the skills use (`src/shared/runtime/skill-frontmatter.js`, CommonJS)
// rather than with a second one that would drift apart from it.
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'shared', 'runtime', 'skill-frontmatter.js')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: path.join(generatedDir, 'skill-frontmatter.js'),
});

// ── JS-Vendor-Bibliotheken ──────────────────────────────────────────────────
fs.copyFileSync(
  path.join(root, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
  path.join(vendor, 'marked.umd.js')
);
fs.copyFileSync(
  path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js'),
  path.join(vendor, 'purify.min.js')
);

// ── Inter-Webfont (doubleSlash UI-Design) ───────────────────────────────────
// Wir vendoren nur die tatsaechlich benoetigten Subsets/Weights, um das Bundle
// klein zu halten. Latin + Latin-Ext deckt Deutsch (Umlaute) ab.
//   400 = Body
//   500 = Medium (Welcome-CTA, Chips, Sekundaer-Buttons — Phase 5)
//   600 = Bold (Headlines, Pills, App-Brand)
//   700 = Heavy (Welcome-Headline H1 — Phase 5, fuer Hero-Wirkung)
const interSrc = path.join(root, 'node_modules', '@fontsource', 'inter');
const interFiles = [
  'inter-latin-400-normal.woff2',
  'inter-latin-500-normal.woff2',
  'inter-latin-600-normal.woff2',
  'inter-latin-700-normal.woff2',
  'inter-latin-ext-400-normal.woff2',
  'inter-latin-ext-500-normal.woff2',
  'inter-latin-ext-600-normal.woff2',
  'inter-latin-ext-700-normal.woff2',
];
for (const file of interFiles) {
  fs.copyFileSync(
    path.join(interSrc, 'files', file),
    path.join(fontsDir, file)
  );
}
// Lizenz mitliefern (OFL-1.1 verlangt das bei Weiterverbreitung).
fs.copyFileSync(
  path.join(interSrc, 'LICENSE'),
  path.join(fontsDir, 'inter-LICENSE.txt')
);
