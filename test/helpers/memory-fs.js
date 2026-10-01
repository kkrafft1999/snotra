'use strict';

/**
 * A small in-memory stand-in for `fs/promises`, for the adapters that read and
 * write `AGENTS.md` and `memory.md` through `embedded-text-file.js` (#534).
 *
 * `files` maps absolute paths to their text — or to an `Error`, which every
 * access to that path throws. There are no symlinks: a path is its own real
 * path. A folder exists when a file lies below it, when it was created with
 * `mkdir`, or when it is named in `dirs`. The behaviour around real symlinks
 * is tested against the real file system (`embedded-text-file.test.js`).
 */

const path = require('path');

function enoent(target) {
  const error = new Error(`ENOENT: ${target}`);
  error.code = 'ENOENT';
  return error;
}

function createMemoryFs(files = {}, { dirs = [] } = {}) {
  const made = [];
  const knownDirs = new Set(dirs.map((dir) => path.resolve(dir)));

  function isDir(target) {
    if (knownDirs.has(target)) return true;
    const prefix = target.endsWith(path.sep) ? target : `${target}${path.sep}`;
    return Object.keys(files).some((file) => file.startsWith(prefix));
  }

  function entry(target) {
    const hit = files[target];
    if (hit instanceof Error) throw hit;
    return hit;
  }

  return {
    files,
    made,
    async realpath(target) {
      if (entry(target) !== undefined || isDir(target)) return target;
      throw enoent(target);
    },
    async stat(target) {
      const hit = entry(target);
      if (hit === undefined && !isDir(target)) throw enoent(target);
      const isFile = hit !== undefined;
      return {
        isFile: () => isFile,
        isDirectory: () => !isFile,
        size: isFile ? Buffer.byteLength(hit, 'utf8') : 0,
        mode: 0o100644,
      };
    },
    async open(target) {
      const hit = entry(target);
      if (hit === undefined) throw enoent(target);
      const bytes = Buffer.from(hit, 'utf8');
      return {
        async read(buffer, offset, length, position) {
          const bytesRead = bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
          return { bytesRead, buffer };
        },
        async close() {},
      };
    },
    async readFile(target) {
      const hit = entry(target);
      if (hit === undefined) throw enoent(target);
      return hit;
    },
    async writeFile(target, content) {
      files[target] = content;
    },
    async rename(from, to) {
      const hit = entry(from);
      if (hit === undefined) throw enoent(from);
      files[to] = hit;
      delete files[from];
    },
    async unlink(target) {
      delete files[target];
    },
    async mkdir(dir) {
      made.push(dir);
      knownDirs.add(dir);
    },
  };
}

module.exports = { createMemoryFs };
