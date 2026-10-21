const { registerToolPermissionHandlers } = require('../../src/main/ipc/tool-permission-handlers');
const { createToolPermissionService } = require('../../src/main/services/tool-permission-service');

/**
 * Registers the permission channels the way the composition root does: the
 * service built from the same collaborators, the handlers on top (#1006).
 */
function registerToolPermissionsForTest(deps) {
  const permissions = createToolPermissionService(deps);
  registerToolPermissionHandlers({ ...deps, permissions });
  return permissions;
}

module.exports = { registerToolPermissionsForTest };
