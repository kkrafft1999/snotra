'use strict';

/**
 * Domains under which unrelated parties get their own host names: a
 * country's second level, and hosting and storage platforms. "Every host of
 * this domain" would mean every customer of the platform there, not one
 * program's servers (#792).
 */
const SHARED_DOMAINS = new Set([
  'amazonaws.com', 'cloudfront.net', 'azurewebsites.net', 'azureedge.net', 'azurestaticapps.net', 'cloudapp.net',
  'windows.net', 'appspot.com', 'googleusercontent.com', 'googleapis.com', 'firebaseapp.com', 'web.app',
  'github.io', 'githubusercontent.com', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev',
  'workers.dev', 'r2.dev', 'fly.dev', 'onrender.com', 'ngrok.io', 'ngrok-free.app', 'digitaloceanspaces.com',
  'blogspot.com', 'readthedocs.io', 'surge.sh', 'glitch.me',
]);
const COUNTRY_SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|or|ne|go|gv|nic|ltd|plc)\.[a-z]{2}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Every host of the domain one level above a blocked host, for "allow a
 * little wider" (#792): `*.pytorch.org` for `download.pytorch.org`. Null for
 * an address, a host directly under a top-level domain (`*.org` is not a
 * program's domain) and the shared domains above.
 *
 * @param {unknown} host
 * @returns {string|null}
 */
function widerHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || IPV4.test(h) || h.includes(':')) return null;
  const labels = h.split('.');
  if (labels.length < 3) return null;
  const parent = labels.slice(1).join('.');
  if (COUNTRY_SECOND_LEVEL.test(parent)) return null;
  for (const shared of SHARED_DOMAINS) {
    if (parent === shared || parent.endsWith(`.${shared}`)) return null;
  }
  return `*.${parent}`;
}

/**
 * A host a sandbox card may open the proxy for (#792): a name, `*.` plus a
 * domain, or an IPv4 address — each with or without a port. The card shows
 * the address itself, so unlike a domain the model declares, an address is
 * no way around what the user sees.
 */
const GRANT_HOST = /^(?:(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/;
const MAX_GRANTED_HOSTS = 20;

/**
 * What of a list of hosts a run may be given (#792). A wildcard only as the
 * card offers it: one level above a host, never a shared domain.
 *
 * @param {unknown} list
 * @returns {string[]}
 */
function grantedHosts(list) {
  /** @type {string[]} */
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().toLowerCase();
    if (!GRANT_HOST.test(value) || out.includes(value)) continue;
    if (value.startsWith('*.') && widerHost(`x.${value.slice(2)}`) !== value) continue;
    out.push(value);
    if (out.length >= MAX_GRANTED_HOSTS) break;
  }
  return out;
}

module.exports = { widerHost, grantedHosts };
