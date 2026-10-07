// Turns the plain-Markdown marker `[since 1.16]` (German pages: `[seit 1.16]`)
// into a small badge. The source stays plain Markdown on purpose: the in-app
// help planned in #777 renders the same files with `marked`, where the marker
// simply shows as text.
const MARKER = /\[(since|seit) (\d+\.\d+(?:\.\d+)?)\]/gi;

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function splitText(value) {
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(MARKER)) {
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) });
    const word = match[1].toLowerCase() === 'seit' ? 'Seit' : 'Since';
    parts.push({
      type: 'html',
      value: `<span class="since-marker">${escapeHtml(`${word} ${match[2]}`)}</span>`,
    });
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return null;
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}

function walk(node) {
  if (!Array.isArray(node.children)) return;
  // Code spans and code blocks are leaves without children, so a marker
  // written inside backticks stays literal.
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitText(child.value) ?? [child];
    walk(child);
    return [child];
  });
}

export default function remarkSinceMarker() {
  return (tree) => walk(tree);
}
