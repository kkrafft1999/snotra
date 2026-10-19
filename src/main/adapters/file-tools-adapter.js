'use strict';

/**
 * The file-tools port (#982) over `fs-service.js`: only the members the tool
 * registry calls, so the registry in the core sees nothing else of it.
 */

/**
 * @param {import('../services/fs-service').FsService} fsService
 * @returns {import('../../application/ports/file-tools-port').FileToolsPort}
 */
function createFileToolsAdapter(fsService) {
  return {
    runListDirectoryTool: fsService.runListDirectoryTool,
    runListDirectoryTreeTool: fsService.runListDirectoryTreeTool,
    runReadFileTextTool: fsService.runReadFileTextTool,
    runReadFileLinesTool: fsService.runReadFileLinesTool,
    runSearchInFilesTool: fsService.runSearchInFilesTool,
    runFindFilesTool: fsService.runFindFilesTool,
    runStatPathTool: fsService.runStatPathTool,
    runOutlineFileTool: fsService.runOutlineFileTool,
    runLoadSkillTool: fsService.runLoadSkillTool,
    runWriteFileTextTool: fsService.runWriteFileTextTool,
    runEditFileTool: fsService.runEditFileTool,
    runApplyPatchTool: fsService.runApplyPatchTool,
    listApplyPatchTargets: fsService.listApplyPatchTargets,
    resolveToolPath: fsService.resolveToolPath,
    writeBinaryFileForTool: fsService.writeBinaryFileForTool,
  };
}

module.exports = { createFileToolsAdapter };
