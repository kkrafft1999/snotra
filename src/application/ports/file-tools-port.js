/**
 * FileTools port (#982): the file tools as the tool registry calls them —
 * listing, reading, searching, writing and patching inside the open folder,
 * the skill folders and what a card opened outside it. The rules of a tool
 * (its schema, its risk, when it is offered) are the registry's, in the core;
 * how a path is resolved and a file is read or written safely is the file
 * service's (`src/main/services/fs-service.js`), reached through
 * `src/main/adapters/file-tools-adapter.js`.
 *
 * Every run answers with the JSON text the model gets; a refusal is in that
 * text too, never thrown.
 */

/**
 * @typedef {(args: import('./tool-port').ToolArguments, workspaceRoot: string | null | undefined,
 *   options?: import('./tool-port').ToolHandlerContext) => Promise<string>} FileToolRun
 */

/**
 * What writing an image the model generated gives back (#85).
 *
 * @typedef {{ error: string, code?: string }
 *   | { relative_path: string, created: boolean, overwritten: boolean, bytes_written: number,
 *       recovery_copy_in_trash?: string, error?: undefined }} FileWriteResult
 */

/**
 * A tool path resolved against its root, or refused (#792).
 *
 * @typedef {{ error: string, code?: string, absPath?: string, root?: undefined, prefix?: undefined,
 *     skillName?: undefined, outside?: undefined }
 *   | { error?: undefined, absPath: string, root: string, prefix: string, skillName: string | null,
 *     outside?: true }} ResolvedToolPath
 */

/**
 * @typedef {Object} FileToolsPort
 * @property {FileToolRun} runListDirectoryTool
 * @property {FileToolRun} runListDirectoryTreeTool
 * @property {FileToolRun} runReadFileTextTool
 * @property {FileToolRun} runReadFileLinesTool
 * @property {FileToolRun} runSearchInFilesTool
 * @property {FileToolRun} runFindFilesTool
 * @property {FileToolRun} runStatPathTool
 * @property {FileToolRun} runOutlineFileTool
 * @property {FileToolRun} runLoadSkillTool
 * @property {FileToolRun} runWriteFileTextTool
 * @property {FileToolRun} runEditFileTool
 * @property {FileToolRun} runApplyPatchTool
 * @property {(args: import('./tool-port').ToolArguments | null | undefined) => string[] | { error: string }} listApplyPatchTargets
 *   the paths an `apply_patch` call would write, for the planner to check first (#66)
 * @property {(workspaceRoot: string | null | undefined, relativePath: unknown) => Promise<ResolvedToolPath>} resolveToolPath
 *   the working folder of a command, checked like a tool path (#102)
 * @property {(relativePath: unknown, bytes: Buffer, workspaceRoot: string | null | undefined,
 *   options?: import('./tool-port').ToolHandlerContext) => Promise<FileWriteResult>} writeBinaryFileForTool
 */

module.exports = {};
