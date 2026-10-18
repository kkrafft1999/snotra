import { t } from '../i18n.js';

/**
 * How the interface names a settings page (#1119): the three tool pages sit
 * in the group Tools, so their name carries it — "Tools › Autonomy", as the
 * dialog's heading and the manual's menu paths say it. The other pages go by
 * their own name.
 */
const PAGE_GROUPS = Object.freeze({
  security: 'tools',
  sandbox: 'tools',
  tools: 'tools',
});

/** "Tools › Security", or "Models" for a page outside a group. */
export function settingsPageName(panel) {
  const name = t(`settings.nav.${panel}`);
  const group = PAGE_GROUPS[panel];
  return group ? `${t(`settings.nav.group.${group}`)} › ${name}` : name;
}

/** "Settings › Tools › Security". */
export function settingsMenuPath(panel) {
  return `${t('settings.title')} › ${settingsPageName(panel)}`;
}
