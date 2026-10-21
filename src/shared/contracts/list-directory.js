'use strict';

/**
 * Upper bound of `list_directory`, shared by the tool that does the listing
 * (`fs-service.js`) and the tool description that tells the model about it
 * (`workspace-tool-registry.js`). Cut after filtering and sorting, so the model
 * sees folders first and a stable first page.
 */
const LIST_DIRECTORY_MAX_ENTRIES = 1000;

module.exports = { LIST_DIRECTORY_MAX_ENTRIES };
