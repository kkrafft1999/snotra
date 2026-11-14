// One name for every comment Snotra writes (#1391): into a PDF (#1386) and
// into a Markdown file (#1388).
//
// The name set under *Settings › General › Name for comments* comes first.
// While that field is empty, the full name of the system account is used —
// the way macOS Preview and Acrobat sign theirs. Decided on 2026-11-14 in
// #1391: an empty field means "my account name", there is no separate way to
// comment without a name. Only when neither is there does a comment go out
// unsigned.
//
// The account name does not change while the app runs, so main is asked once
// per `api`. The setting is read every time: it may have changed since.

const accountNames = new WeakMap();

/** The system account's full name, or '' — asked of main once per `api`. */
export function accountName(api) {
  if (!api || typeof api !== 'object') return Promise.resolve('');
  let pending = accountNames.get(api);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => (typeof api.commentAccountName === 'function' ? api.commentAccountName() : ''))
      .then((name) => (typeof name === 'string' ? name.trim() : ''))
      .catch(() => {
        // No name from main: the setting still applies, and without one the
        // comment goes out unsigned rather than not at all.
        return '';
      });
    accountNames.set(api, pending);
  }
  return pending;
}

/** The name a new comment is signed with: the setting, else the account name, else ''. */
export async function commentAuthor(api) {
  let set = '';
  try {
    const prefs = await api?.getUIPrefs?.();
    set = typeof prefs?.commentAuthor === 'string' ? prefs.commentAuthor.trim() : '';
  } catch {
    // Unreadable prefs: fall back to the account name, as for an empty field.
    set = '';
  }
  return set || accountName(api);
}
