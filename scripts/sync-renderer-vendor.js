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

// ── pdf.js for the PDF view in the file preview (#346) ─────────────────────
// Only what the view uses: the library, its worker, and the data it asks for
// through its BinaryDataFactory — CMaps (CJK text), the standard fonts (PDFs
// that do not embed Helvetica & co.) and the image decoders for JBIG2 and
// JPEG 2000. The data files are read by the main process (`pdf:readAsset`),
// never fetched by the renderer. Left out on purpose: the viewer UI, the
// scripting sandbox (`pdf.sandbox`, `quickjs-eval`) — PDF JavaScript never
// runs — and the source maps.
const pdfjsSource = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjsTarget = path.join(vendor, 'pdfjs');
fs.rmSync(pdfjsTarget, { recursive: true, force: true });
fs.mkdirSync(pdfjsTarget, { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(pdfjsSource, 'build', file), path.join(pdfjsTarget, file));
}
fs.copyFileSync(path.join(pdfjsSource, 'LICENSE'), path.join(pdfjsTarget, 'LICENSE'));
const PDFJS_DATA = {
  cmaps: (name) => name.endsWith('.bcmap') || name === 'LICENSE',
  standard_fonts: (name) => /\.(pfb|ttf)$/.test(name) || name.startsWith('LICENSE'),
  wasm: (name) => !name.startsWith('quickjs'),
};
for (const [dir, keep] of Object.entries(PDFJS_DATA)) {
  fs.mkdirSync(path.join(pdfjsTarget, dir), { recursive: true });
  for (const name of fs.readdirSync(path.join(pdfjsSource, dir)).filter(keep)) {
    fs.copyFileSync(path.join(pdfjsSource, dir, name), path.join(pdfjsTarget, dir, name));
  }
}

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
