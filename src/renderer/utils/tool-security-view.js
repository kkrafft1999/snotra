/**
 * Settings › Tools › Security as the interface shows it (#1119): the list of
 * workspaces on the left, the details of the chosen one — or of everything
 * that applies in every workspace — on the right, and the one line on
 * Tools › Autonomy that leads there.
 *
 * Pure functions over what main sends (`getSandboxOverview`, the security
 * overview), so the page, the line and the tests say the same. Decided on
 * 2026-10-18 from the mockup of #1119: navigation B, layout 2.
 */
import { t, tPlural } from '../i18n.js';
import { describeSandboxStatus } from './sandbox-status-view.js';
import { tildePath } from './program-allowance-view.js';

/** The selection key of "All workspaces"; a workspace is selected by its root. */
export const ALL_WORKSPACES = '*';

/** Last segment of a root, whichever separator it uses. */
export function folderName(root) {
  if (typeof root !== 'string' || !root) return '';
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || root;
}

/**
 * A platform without a sandbox — Windows (#990) — has nothing to switch and
 * nothing to allow. The platform register says so (#1149), and the sandbox's
 * state carries the same reason.
 */
export function hasNoSandbox(overview) {
  return overview?.platformCapabilities?.executionSandbox === false || overview?.sandbox?.reason === 'platform';
}

/** "2 programs · 1 host", or '' when there is nothing. */
export function countsText(programs, hosts) {
  const parts = [];
  if (programs > 0) parts.push(tPlural('toolSecurity.meta.programs', programs, { count: programs }));
  if (hosts > 0) parts.push(tPlural('toolSecurity.meta.hosts', hosts, { count: hosts }));
  return parts.join(' · ');
}

function workspacesOf(overview) {
  return Array.isArray(overview?.workspaces) ? overview.workspaces.filter((ws) => ws && typeof ws.root === 'string' && ws.root) : [];
}

function globalOf(overview) {
  return {
    programs: Array.isArray(overview?.global?.programs) ? overview.global.programs : [],
    hosts: Array.isArray(overview?.global?.hosts) ? overview.global.hosts : [],
  };
}

/**
 * The name each workspace goes by in the list: its folder name, and where
 * two share one, the folder above it as well.
 */
function listNames(workspaces) {
  const count = new Map();
  for (const ws of workspaces) count.set(folderName(ws.root), (count.get(folderName(ws.root)) || 0) + 1);
  return new Map(workspaces.map((ws) => {
    const name = folderName(ws.root);
    if (count.get(name) < 2) return [ws.root, name];
    const parts = ws.root.split(/[\\/]+/).filter(Boolean);
    return [ws.root, parts.slice(-2).join('/')];
  }));
}

/** The workspace selected when the page opens: the open one, or All workspaces (#1119). */
export function defaultSelection(overview) {
  const open = workspacesOf(overview).find((ws) => ws.open);
  return open ? open.root : ALL_WORKSPACES;
}

/** A selection that still exists, or the default. */
export function validSelection(overview, selected) {
  if (selected === ALL_WORKSPACES) return selected;
  return workspacesOf(overview).some((ws) => ws.root === selected) ? selected : defaultSelection(overview);
}

/**
 * The list: All workspaces first, then every workspace with its state in
 * shape and words — shield and counts, "Sandbox on · nothing extra", or the
 * struck-through amber shield with "Sandbox off".
 */
export function describeWorkspaceList(overview, selected) {
  const none = hasNoSandbox(overview);
  const global = globalOf(overview);
  const workspaces = workspacesOf(overview);
  const names = listNames(workspaces);
  const items = [{
    key: ALL_WORKSPACES,
    kind: 'global',
    tone: 'global',
    name: t('toolSecurity.all'),
    open: false,
    meta: countsText(global.programs.length, global.hosts.length) || t('toolSecurity.meta.nothing'),
    title: t('toolSecurity.all.sub'),
    selected: selected === ALL_WORKSPACES,
  }];
  for (const ws of workspaces) {
    const programs = Array.isArray(ws.programs) ? ws.programs.length : 0;
    const hosts = Array.isArray(ws.hosts) ? ws.hosts.length : 0;
    let tone = 'on';
    let meta = countsText(programs, hosts) || t('toolSecurity.meta.onNothing');
    if (ws.missing) {
      tone = 'missing';
      meta = t('toolSecurity.meta.missing');
    } else if (none) {
      tone = 'off';
      meta = t('toolSecurity.meta.noSandbox');
    } else if (ws.sandboxOff) {
      tone = 'off';
      meta = t('toolSecurity.meta.off');
    }
    items.push({
      key: ws.root,
      kind: 'workspace',
      tone,
      name: names.get(ws.root),
      open: ws.open === true,
      meta,
      title: tildePath(ws.root, overview?.homeDir || ''),
      selected: selected === ws.root,
    });
  }
  return items;
}

/**
 * The sandbox tile of one workspace (#543): its state as title, what that
 * means as text, the switch. On Windows it says there is none and offers no
 * switch. Without `safeStorage` switching off cannot be stored, so it is not
 * offered while the switch is on (CR-B14-09).
 */
export function describeSandboxTile(overview, ws, { autoLabel = '' } = {}) {
  if (hasNoSandbox(overview)) {
    return {
      tone: 'unavailable',
      title: t('toolSecurity.tile.windows'),
      body: t('toolSecurity.tile.windowsBody', { mode: autoLabel }),
      note: '',
      checked: false,
      switchable: false,
      offBlocked: false,
    };
  }
  if (ws.sandboxOff) {
    // What applies here rests as well — the workspace's own and what applies everywhere.
    const global = globalOf(overview);
    const resting = (ws.programs?.length || 0) + (ws.hosts?.length || 0) + global.programs.length + global.hosts.length > 0;
    return {
      tone: 'off',
      title: t('settings.sandbox.workspace.tile.off'),
      body: t('settings.sandbox.workspace.off', { mode: autoLabel }),
      note: resting ? t('toolSecurity.tile.offNote') : '',
      checked: false,
      switchable: true,
      offBlocked: false,
    };
  }
  const offBlocked = overview?.encryptionAvailable === false;
  const base = {
    checked: true,
    switchable: true,
    offBlocked,
    note: offBlocked ? t('settings.sandbox.workspace.needsEncryption') : '',
  };
  const sandbox = overview?.sandbox;
  const unavailable = !!sandbox && sandbox.isolated === false
    && sandbox.status !== 'unknown' && sandbox.status !== 'testing';
  if (unavailable) {
    return {
      ...base,
      tone: 'unavailable',
      title: t('settings.sandbox.workspace.tile.unavailable'),
      body: describeSandboxStatus(sandbox, true)?.text || '',
    };
  }
  return {
    ...base,
    tone: 'on',
    title: t('settings.sandbox.workspace.tile.on'),
    body: t('toolSecurity.tile.onBody', { mode: autoLabel }),
  };
}

/** What a workspace's page shows (#1119). Null for a root not in the overview. */
export function describeWorkspaceDetail(overview, root, { autoLabel = '' } = {}) {
  const ws = workspacesOf(overview).find((entry) => entry.root === root);
  if (!ws) return null;
  const none = hasNoSandbox(overview);
  const global = globalOf(overview);
  const programs = Array.isArray(ws.programs) ? ws.programs : [];
  const hosts = Array.isArray(ws.hosts) ? ws.hosts : [];
  return {
    root: ws.root,
    rootLabel: tildePath(ws.root, overview?.homeDir || ''),
    open: ws.open === true,
    missing: ws.missing === true,
    sub: ws.open ? t('toolSecurity.ws.sub') : t('toolSecurity.ws.notOpen'),
    noSandbox: none,
    tile: describeSandboxTile(overview, ws, { autoLabel }),
    // Its allowances rest while the sandbox is off: there is nothing to widen.
    resting: !none && ws.sandboxOff === true,
    programs,
    inheritedPrograms: global.programs,
    hosts,
    inheritedHosts: global.hosts,
    // Only for the open workspace: the chats that hold them run there.
    sessionGrants: ws.open && Array.isArray(overview?.sessionGrants) ? overview.sessionGrants : null,
  };
}

/**
 * The line "On this computer" under "What the sandbox always does": the
 * system and whether its sandbox works.
 */
export function describeSystemLine(overview) {
  if (hasNoSandbox(overview)) return t('toolSecurity.system.windows');
  const sandbox = overview?.sandbox;
  if (overview?.platform === 'darwin' && (!sandbox || sandbox.isolated !== false || sandbox.status === 'unknown' || sandbox.status === 'testing')) {
    return t('toolSecurity.system.mac');
  }
  if (!sandbox || sandbox.status === 'unknown' || sandbox.status === 'testing') return t('toolSecurity.system.pending');
  if (sandbox.isolated === true) return overview?.platform === 'darwin' ? t('toolSecurity.system.mac') : t('toolSecurity.system.linux');
  return describeSandboxStatus(sandbox, true)?.text || '';
}

/** What "All workspaces" shows (#1119). */
export function describeGlobalDetail(overview) {
  const global = globalOf(overview);
  return {
    noSandbox: hasNoSandbox(overview),
    noWorkspace: !workspacesOf(overview).some((ws) => ws.open),
    newWorkspaceSandbox: overview?.newWorkspaceSandbox !== false,
    // Off cannot be stored without encrypted storage; it is not offered then.
    newWorkspaceOffBlocked: overview?.encryptionAvailable === false && overview?.newWorkspaceSandbox !== false,
    programs: global.programs,
    hosts: global.hosts,
    system: describeSystemLine(overview),
  };
}

/**
 * The line on Tools › Autonomy, in the row Execute (#1119): the state of the
 * open folder in one line, leading to Tools › Security. `overview` is the
 * security overview of that page.
 */
export function describeSandboxLink(overview) {
  const execution = overview?.execution || {};
  const sandbox = execution.sandbox;
  const root = typeof overview?.workspace?.root === 'string' ? overview.workspace.root : '';
  const name = overview?.workspace?.name || folderName(root);
  if (sandbox?.reason === 'platform') {
    return { tone: 'off', title: t('security.sandboxLink.off'), body: t('security.sandboxLink.windowsBody') };
  }
  if (!root) {
    return { tone: 'neutral', title: t('security.sandboxLink.noWs'), body: t('security.sandboxLink.noWsBody') };
  }
  if (execution.workspaceSandboxDisabled) {
    return { tone: 'off', title: t('security.sandboxLink.off'), body: t('security.sandboxLink.offBody', { root: name }) };
  }
  if (sandbox && sandbox.isolated === false && sandbox.status !== 'unknown' && sandbox.status !== 'testing') {
    return { tone: 'off', title: t('security.sandboxLink.off'), body: describeSandboxStatus(sandbox, true)?.text || '' };
  }
  const own = countsText(
    Array.isArray(execution.workspacePrograms) ? execution.workspacePrograms.length : 0,
    Array.isArray(execution.workspaceHosts) ? execution.workspaceHosts.length : 0,
  );
  const everywhere = countsText(
    Array.isArray(execution.programAllowances) ? execution.programAllowances.length : 0,
    Array.isArray(execution.globalHosts) ? execution.globalHosts.length : 0,
  );
  const body = [
    own ? t('security.sandboxLink.own', { root: name, counts: own }) : t('security.sandboxLink.ownNone', { root: name }),
    everywhere ? t('security.sandboxLink.global', { counts: everywhere }) : '',
  ].filter(Boolean).join(' ');
  if (!sandbox || sandbox.status === 'unknown' || sandbox.status === 'testing') {
    return { tone: 'neutral', title: t('security.sandboxLink.pending'), body };
  }
  return { tone: 'on', title: t('security.sandboxLink.on'), body };
}
