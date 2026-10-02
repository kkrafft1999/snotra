// Why a file is not shown as text (CR-B18-09, #641).
//
// `fs:readFile` answers a failed read with a reason code next to its message
// (`filesystem-ipc-adapter.js`). The message is for the log: it is the
// system's own wording, in English, with the full path in it. What the user
// reads is chosen here, from the catalogue, in the interface language — on the
// info card (`host.js`) and in the source pane of an SVG (`image-view.js`).

/** The codes of the main process, plus the one the renderer adds itself. */
export const READ_FAILURES = Object.freeze({
  // The path check said no: outside the folder, a link out of it.
  REFUSED: 'refused',
  MISSING: 'missing',
  PERMISSION: 'permission',
  TOO_LARGE: 'too-large',
  FAILED: 'failed',
  // Read fine, but the view failed to mount — the cause is in the console.
  VIEW_FAILED: 'view-failed',
});

const MESSAGE_KEYS = Object.freeze({
  [READ_FAILURES.REFUSED]: 'fileView.notShown.refused',
  [READ_FAILURES.MISSING]: 'fileView.notShown.missing',
  [READ_FAILURES.PERMISSION]: 'fileView.notShown.permission',
  [READ_FAILURES.TOO_LARGE]: 'fileView.notShown.tooLarge',
  [READ_FAILURES.FAILED]: 'fileView.notShown.failed',
  [READ_FAILURES.VIEW_FAILED]: 'fileView.notShown.viewFailed',
});

/** The reason of a failed `fs:readFile`; one main does not name is a plain failure. */
export function readFailureOf(result) {
  return Object.hasOwn(MESSAGE_KEYS, result?.reason) ? result.reason : READ_FAILURES.FAILED;
}

/** Catalogue key of the sentence that says why. */
export function readFailureMessageKey(reason) {
  return MESSAGE_KEYS[reason] ?? MESSAGE_KEYS[READ_FAILURES.FAILED];
}
