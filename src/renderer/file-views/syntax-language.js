// Which grammar colours a text file in the preview (#745).
//
// Decided by the file name alone, never by the content: a file never flips
// between languages from one write to the next. What has no grammar here —
// `txt`, `log`, `lock`, `csv`, `conf`, an unknown extension — stays plain
// text, and so does anything this table does not name.
//
// DOM-free and free of Prism, so that it can be tested on its own. The values
// are Prism's language ids; every one of them has to be in the vendored
// bundle (`PRISM_LANGUAGES` in scripts/sync-renderer-vendor.js).

import { getExtension } from '../utils/helpers.js';

const BY_EXTENSION = new Map(Object.entries({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  // Prism has no grammar of their own; as markup, the tags are coloured and
  // a `<script>` or `<style>` block gets JavaScript or CSS.
  vue: 'markup', svelte: 'markup', astro: 'markup',
  css: 'css', scss: 'scss', less: 'less',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', editorconfig: 'ini', properties: 'properties',
  sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash',
  py: 'python', rb: 'ruby', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', scala: 'scala',
  php: 'php', sql: 'sql', r: 'r',
  dockerfile: 'docker', makefile: 'makefile', cmake: 'cmake', gradle: 'groovy',
  md: 'markdown',
  gitignore: 'ignore',
  // These hold JSON far more often than YAML; a YAML one is still readable,
  // only coloured less well.
  prettierrc: 'json', eslintrc: 'json', babelrc: 'json',
}));

// Names that carry no extension, or whose extension says nothing (`CMakeLists.txt`).
const BY_NAME = new Map(Object.entries({
  makefile: 'makefile', gnumakefile: 'makefile',
  dockerfile: 'docker', containerfile: 'docker',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'ignore', '.dockerignore': 'ignore', '.npmignore': 'ignore',
  '.prettierignore': 'ignore', '.eslintignore': 'ignore',
  '.editorconfig': 'ini', '.gitconfig': 'ini', '.npmrc': 'ini',
  '.prettierrc': 'json', '.eslintrc': 'json', '.babelrc': 'json',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.bash_profile': 'bash',
}));

// `.env`, `.env.local`, `.env.production` …: the `.env` in front decides, as
// in isTextFile().
const ENV_FILE = /^\.env(\.|$)/;

/** The Prism language id for a file name, or null for plain text. */
export function syntaxLanguageFor(name) {
  if (typeof name !== 'string' || !name) return null;
  const lower = name.toLowerCase();
  if (ENV_FILE.test(lower)) return 'bash';
  if (BY_NAME.has(lower)) return BY_NAME.get(lower);
  // `Dockerfile.dev`, `Makefile.am`: the name in front decides.
  const stem = lower.split('.')[0];
  if (stem === 'dockerfile' || stem === 'containerfile') return 'docker';
  if (stem === 'makefile') return 'makefile';
  return BY_EXTENSION.get(getExtension(name)) ?? null;
}

/** Every language id the table can return — the bundle has to contain each. */
export const SYNTAX_LANGUAGES = Object.freeze([...new Set([
  ...BY_EXTENSION.values(), ...BY_NAME.values(), 'bash', 'docker', 'makefile',
])]);
