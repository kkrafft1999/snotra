'use strict';

/**
 * New workspaces without the sandbox (#1119): when a folder is opened, the
 * policy store decides whether it is new while that default is off, and if
 * so writes its sandbox off. The renderer then reads the permission state
 * again, so the shield next to the folder name and the mode pill show it at
 * once. Nothing to do while the default is on.
 *
 * @param {object} deps
 * @param {{ noteWorkspaceOpened: (root: string) => Promise<{changed?: boolean}> }} deps.toolPolicyStore
 * @param {() => void} [deps.onChanged]
 * @param {{ warn?: Function }} [deps.log]
 * @returns {(root: string|null) => Promise<void>} never rejects
 */
function createWorkspaceSandboxDefault({ toolPolicyStore, onChanged = () => {}, log = console }) {
  return async function noteWorkspaceOpened(root) {
    try {
      const result = await toolPolicyStore.noteWorkspaceOpened(root);
      if (result?.changed) onChanged();
    } catch (error) {
      log?.warn?.(`[tool-policy] The new workspace could not be noted: ${error?.message || error}`);
    }
  };
}

module.exports = { createWorkspaceSandboxDefault };
