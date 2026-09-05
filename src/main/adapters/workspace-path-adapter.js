'use strict';

function createNodeWorkspacePathAdapter({ path: pathMod }) {
  return {
    resolveRoot(rawRoot) {
      if (typeof rawRoot !== 'string' || !rawRoot.trim()) return null;
      return pathMod.resolve(rawRoot.trim());
    },
    resolveSelection(root, selectedPath, selectedIsDirectory) {
      if (!root || typeof selectedPath !== 'string' || !selectedPath.trim()) return null;
      const trimmed = selectedPath.trim();
      const absolutePath = pathMod.isAbsolute(trimmed)
        ? pathMod.resolve(trimmed)
        : pathMod.resolve(root, trimmed);
      const relativePath = pathMod.relative(root, absolutePath);
      if (relativePath.startsWith('..') || pathMod.isAbsolute(relativePath)) return null;
      // Posix-Schreibweise wie bei Tool-Pfaden und @-Referenzen, auch unter Windows.
      const relativePosix = relativePath.split(pathMod.sep).join('/');
      return {
        relativePath: relativePosix || '.',
        isDirectory: !!selectedIsDirectory,
      };
    },
    basename(absPath) {
      return pathMod.basename(absPath);
    },
  };
}

module.exports = {
  createNodeWorkspacePathAdapter,
};
