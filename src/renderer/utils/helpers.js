const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'json', 'html', 'htm', 'css',
  'scss', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'sh', 'bash', 'zsh', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'swift', 'kt', 'scala', 'php', 'sql', 'r',
  'vue', 'svelte', 'astro', 'env', 'gitignore', 'dockerfile',
  'makefile', 'cmake', 'gradle', 'properties', 'log', 'csv', 'svg',
  'lock', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc',
]);

export function getExtension(filename) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return filename.slice(dotIndex + 1).toLowerCase();
}

export function isTextFile(filename) {
  const ext = getExtension(filename);
  if (!ext) {
    const lower = filename.toLowerCase();
    return ['makefile', 'dockerfile', 'readme', 'license', 'changelog'].some(
      (n) => lower === n || lower.startsWith(n + '.')
    );
  }
  return TEXT_EXTENSIONS.has(ext);
}

export function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Protokolle, die im Chat als Link stehen bleiben duerfen. Der Klick-Handler
 * in ChatStream muss dieselbe Liste verwenden, sonst zeigt der Chat Links an,
 * die nichts tun (Issue #82).
 */
export const ALLOWED_LINK_PROTOS = /^(https?|mailto):/i;
let domPurifyConfigured = false;

function configureDomPurify() {
  if (domPurifyConfigured || typeof DOMPurify === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      const href = node.getAttribute('href') || '';
      if (!ALLOWED_LINK_PROTOS.test(href)) {
        node.removeAttribute('href');
      }
    }
  });
  domPurifyConfigured = true;
}

export function markdownToSafeHtml(raw) {
  const text = String(raw ?? '');
  if (typeof marked !== 'undefined' && typeof marked.parse === 'function' && typeof DOMPurify !== 'undefined') {
    configureDomPurify();
    const html = marked.parse(text, { breaks: true, gfm: true });
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'form'],
      FORBID_ATTR: ['style', 'srcset'],
    });
  }
  const esc = document.createElement('div');
  esc.textContent = text;
  return esc.innerHTML.replace(/\n/g, '<br>');
}

export function svgChevron() {
  return `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M3 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function svgFolder() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`;
}

export function svgFile(filename) {
  const ext = getExtension(filename);
  const colorMap = {
    js: '#f1e05a', ts: '#3178c6', jsx: '#61dafb', tsx: '#3178c6',
    json: '#a8d08d', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
    py: '#3572A5', rb: '#cc342d', java: '#b07219', go: '#00ADD8',
    rs: '#dea584', md: '#519aba', svg: '#ff9900', xml: '#e44b23',
    yaml: '#cb171e', yml: '#cb171e', sh: '#89e051', sql: '#e38c00',
  };
  const color = colorMap[ext] || '#888';

  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="${color}">
    <path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0H4zM9 1v3.5a.5.5 0 0 0 .5.5H13L9 1zM4 1h4v4h5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/>
  </svg>`;
}

// Gemeinsames Outside-Click-Muster für Menüs/Drawer (Review 2026-05-23, G1):
// schließt das Element bei Klicks außerhalb, solange isOpen() true liefert.
// ownsTarget entscheidet, welche Klicks als "innen" gelten (z. B. Menü +
// zugehöriger Toggle-Button).
export function dismissOnOutsideClick({ isOpen, ownsTarget, onDismiss }) {
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (ownsTarget?.(e.target)) return;
    onDismiss();
  });
}
