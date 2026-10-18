'use strict';

/**
 * The native sheet that lets a phone in as the mobile remote (#1114), worded
 * in the interface language. It goes through the user-confirmation port
 * (#980), so only a click in the operating system's dialog counts.
 *
 * The six words themselves are never translated (docs/remote-protocol.md §7):
 * a German desktop and an English phone show the same ones, numbered 1 to 6,
 * three to a line.
 */

const { createTranslator } = require('../../shared/i18n');

/**
 * @param {() => string} getLocale
 * @returns {(input: { words: string[], replacing: boolean }) =>
 *   import('../../application/ports/user-confirmation-port').ConfirmationPrompt}
 */
function pairingPrompt(getLocale) {
  return ({ words, replacing }) => {
    const t = createTranslator(getLocale());
    const numbered = words.map((word, index) => `${index + 1} ${word}`);
    const lines = `${numbered.slice(0, 3).join(' · ')}\n${numbered.slice(3).join(' · ')}`;
    const detail = [t('remote.pairing.confirm.detail', { words: lines })];
    if (replacing) detail.push(t('remote.pairing.confirm.replacing'));
    return {
      type: 'question',
      message: t('remote.pairing.confirm.message'),
      detail: detail.join('\n\n'),
      // Deny is the default and the Escape answer: Enter lets no phone in.
      buttons: [t('remote.pairing.confirm.allow'), t('remote.pairing.confirm.deny')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
  };
}

module.exports = { pairingPrompt };
