// The card on which the model proposes to switch a skill or tool for one
// chat (#774), as the interface shows it. Pure functions over the DTO from
// main, like sandbox-approval-view.js; the DOM is built in
// ToolApprovalCard.js. Laid out after the mockup decided on 2026-10-12
// (variant B, the compact card): name and description in the headline,
// risk or origin and "this chat only" below it, the model's reason folded.
//
// What the skill or tool does comes from Snotra's catalogue. The model's
// words are only the reason, and they are labelled as the model's.
import contracts from '../generated/contracts.js';
import { t } from '../i18n.js';
import { riskClassLabel } from './tool-approval-view.js';
import { settingsPath } from './chat-config-view.js';

const { APPROVAL_RESPONSES } = contracts;

/** The settings panel a proposal's lasting counterpart lives on. */
function panelOf(menu) {
  return menu === 'settings.skills' ? 'skills' : 'security';
}

function originLabel(origin) {
  if (origin === 'system') return t('approval.config.origin.system');
  if (origin === 'folder') return t('approval.config.origin.folder');
  return t('approval.config.origin.user');
}

/**
 * A built-in tool's description is the app's own sentence and follows the
 * interface language; anything else is the text main sent along.
 */
function descriptionOf(config) {
  if (config.descriptionKey) {
    const text = t(config.descriptionKey);
    if (text && text !== config.descriptionKey) return text;
  }
  return config.description || '';
}

/** The card's view, or `null` when the DTO is no proposal. */
export function buildConfigProposalCardView(dto) {
  const config = dto?.checkpoint === 'config' ? dto.config : null;
  if (!config || typeof config.name !== 'string' || !config.name) return null;
  const on = config.enable === true;
  const isSkill = config.kind === 'skill';

  const meta = [];
  if (isSkill) meta.push(originLabel(config.origin));
  else {
    for (const riskClass of config.riskClasses || []) meta.push(riskClassLabel(riskClass));
    if (config.mcpServer) meta.push(t('approval.config.mcp', { server: config.mcpServer }));
  }
  meta.push(t('approval.config.chatOnly'));

  const page = settingsPath(panelOf(config.settingsMenu));
  return {
    kind: 'config',
    title: on ? t('approval.config.title.on') : t('approval.config.title.off'),
    // The notification and the folded line read the headline; the name is
    // the slot rendered as code.
    headline: {
      template: on ? t('approval.config.notify.on') : t('approval.config.notify.off'),
      tool: config.name,
    },
    name: config.name,
    description: descriptionOf(config),
    // A folder or user skill, an MCP tool: somebody else's words.
    descriptionIsData: config.descriptionIsData === true,
    authorLabel: isSkill ? t('approval.config.authorText.skill') : t('approval.config.authorText.mcp'),
    meta,
    reason: config.reason || '',
    reasonLabel: t('approval.config.reasonLabel'),
    status: on ? t('approval.config.status.on', { page }) : t('approval.config.status.off'),
    actions: {
      once: {
        label: on ? t('approval.config.action.on') : t('approval.config.action.off'),
        response: APPROVAL_RESPONSES.ALLOW_ONCE,
        enabled: true,
      },
      deny: {
        label: on ? t('approval.config.action.decline') : t('approval.config.action.keep'),
        response: APPROVAL_RESPONSES.DENY,
        enabled: true,
      },
    },
    actionOrder: ['once', 'deny'],
  };
}

/**
 * How a proposal ended, in the words of its folded line. Lapsed and
 * cancelled cards say what every card says; `null` leaves those to it.
 */
export function describeConfigProposalOutcome({ response, invalidated, aborted } = {}, { enable = true } = {}) {
  if (aborted === true || invalidated === true) return null;
  if (response === APPROVAL_RESPONSES.ALLOW_ONCE) {
    return {
      status: 'allowed',
      label: enable ? t('approval.config.outcome.on') : t('approval.config.outcome.off'),
      detail: t('approval.config.outcome.acceptedDetail'),
    };
  }
  if (response === APPROVAL_RESPONSES.DENY) {
    return {
      status: 'denied',
      label: t('approval.config.outcome.declined'),
      detail: t('approval.config.outcome.declinedDetail'),
    };
  }
  return null;
}
