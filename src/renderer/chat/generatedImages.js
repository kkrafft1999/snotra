/**
 * Images the agent generated, under the line of changed files (#85).
 *
 * The image was paid for and is there to be looked at, so it is shown where
 * it was made — not only if the model happens to embed it in its answer. The
 * card comes from the tool trace, which is stored with the chat: it stands
 * again when the chat is opened later, loaded from the workspace like every
 * other image in the chat (#244), with a placeholder when the file is gone.
 * A click opens the file in the preview column.
 */

import { t } from '../i18n.js';
import { normalizeChanges } from './fileChanges.js';
import { applyWorkspaceImages } from './workspaceImages.js';

const IMAGE_TOOL = 'generate_image';

const FORMAT_LABELS = Object.freeze({ png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP' });

function baseNameOf(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/);
  return parts[parts.length - 1] || String(relativePath || '');
}

function formatLabelOf(relativePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(relativePath || ''));
  return match ? FORMAT_LABELS[match[1].toLowerCase()] || '' : '';
}

/**
 * The images one assistant message generated, once per path, in the order
 * they were first made. `changeIds` names the writes, so a path drawn again
 * is drawn again on screen as well.
 */
export function generatedImagesOf(toolTrace) {
  const images = new Map();
  for (const entry of Array.isArray(toolTrace) ? toolTrace : []) {
    if (entry?.tool !== IMAGE_TOOL) continue;
    for (const change of normalizeChanges(entry.changes) || []) {
      const key = change.relativePath;
      if (!images.has(key)) images.set(key, { relativePath: key, changeIds: [] });
      images.get(key).changeIds.push(change.id || '');
    }
  }
  return [...images.values()];
}

function keyOf(images) {
  return images.map((image) => `${image.relativePath}#${image.changeIds.join(',')}`).join('|');
}

function buildFigure(image, onOpen) {
  const figure = document.createElement('figure');
  figure.className = 'chat-image';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-image-open chat-image-open--loading';
  button.title = image.relativePath;
  button.setAttribute('aria-label', t('chat.images.open', { path: image.relativePath }));
  const img = document.createElement('img');
  img.setAttribute('data-md-src', image.relativePath);
  img.alt = baseNameOf(image.relativePath);
  button.append(img);
  button.addEventListener('click', () => onOpen?.(image.relativePath));

  const caption = document.createElement('figcaption');
  caption.className = 'chat-image-caption';
  const pathEl = document.createElement('span');
  pathEl.className = 'chat-image-path';
  pathEl.textContent = image.relativePath;
  const meta = document.createElement('span');
  meta.className = 'chat-image-meta';
  meta.textContent = formatLabelOf(image.relativePath);
  const separator = document.createElement('span');
  separator.className = 'chat-image-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '·';
  caption.append(pathEl, separator, meta);

  figure.append(button, caption);
  return figure;
}

/**
 * Settles one figure once its image is decided on: the size goes into the
 * caption, and a placeholder (file gone, folder switched) stops being a
 * button — there is nothing to open.
 */
function settleFigure(figure) {
  const button = figure.querySelector('.chat-image-open');
  if (!button) return;
  button.classList.remove('chat-image-open--loading');
  const img = button.querySelector('img.chat-md-image-img');
  const meta = figure.querySelector('.chat-image-meta');
  if (!img) {
    const box = document.createElement('div');
    box.className = 'chat-image-missing';
    box.append(...button.childNodes);
    button.replaceWith(box);
    return;
  }
  const showSize = () => {
    if (!meta || !img.naturalWidth || !img.naturalHeight) return;
    const format = meta.dataset.format ?? meta.textContent;
    meta.dataset.format = format;
    meta.textContent = [`${img.naturalWidth} × ${img.naturalHeight}`, format].filter(Boolean).join(' · ');
  };
  if (img.complete) showSize();
  else img.addEventListener('load', showSize, { once: true });
}

/**
 * Puts the images under the line of changed files of `messageEl` — under the
 * tool log when there is no such line — or takes them away. The same set is
 * left standing, so a redraw of the message does not reload what is shown.
 *
 * @param {Element|null} messageEl
 * @param {Array<{ relativePath: string, changeIds: string[] }>} images
 * @param {{ api: object, workspaceRoot: string|null, onOpen: (relativePath: string) => void }} options
 */
export function syncGeneratedImages(messageEl, images, { api, workspaceRoot, onOpen } = {}) {
  if (!messageEl) return Promise.resolve();
  const old = messageEl.querySelector(':scope > .chat-images');
  const log = messageEl.querySelector(':scope > .chat-tool-log');
  const list = Array.isArray(images) ? images : [];
  const key = `${workspaceRoot || ''}::${keyOf(list)}`;
  if (!log || list.length === 0) {
    old?.remove();
    return Promise.resolve();
  }
  if (old && old.dataset.key === key) {
    // Still in its place: the line of changed files may have been redrawn.
    const anchor = messageEl.querySelector(':scope > .chat-changes') || messageEl.querySelector(':scope > .chat-sandbox-blocked') || log;
    if (anchor.nextElementSibling !== old) anchor.after(old);
    return Promise.resolve();
  }

  const box = document.createElement('div');
  box.className = 'chat-images';
  if (list.length > 1) box.classList.add('chat-images--grid');
  box.dataset.key = key;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('chat.images.label'));
  for (const image of list) box.append(buildFigure(image, onOpen));
  if (old) old.replaceWith(box);
  else (messageEl.querySelector(':scope > .chat-changes') || messageEl.querySelector(':scope > .chat-sandbox-blocked') || log).after(box);

  return applyWorkspaceImages(box, { api, workspaceRoot }).then(() => {
    box.querySelectorAll('.chat-image').forEach(settleFigure);
  });
}
