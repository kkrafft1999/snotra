'use strict';

/**
 * Adressregeln fuer den Seitenabruf (Issue #95, Sicherheitskonzept §5).
 *
 * Ein Tool, das eine vom Modell gewaehlte Adresse abruft, ist ohne diese
 * Pruefung ein SSRF-Werkzeug gegen das eigene Netz: Router-Oberflaechen,
 * Datenbanken auf localhost, Cloud-Metadaten unter 169.254.169.254. Geprueft
 * wird deshalb nicht der Hostname, sondern die Adresse, zu der er aufloest —
 * und zwar nach jeder Weiterleitung erneut.
 *
 * Was hier bewusst offen bleibt: zwischen Pruefung und Verbindungsaufbau kann
 * ein Angreifer den DNS-Eintrag wechseln (DNS-Rebinding). Das schliesst erst
 * eine Verbindung auf die geprüfte IP mit mitgegebenem Host-Header; siehe
 * docs/sicherheitskonzept.md.
 */

/** Nur diese Schemata; alles andere traegt nichts in den Chat. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Hostnamen, die nie ins Netz zeigen. `.local` ist mDNS im eigenen LAN,
 * `.internal`/`.home.arpa` sind typische Heim- und Cloud-Zonen.
 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

function parseIpv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Adressbereiche, die den Rechner selbst oder das lokale Netz meinen.
 * 169.254.0.0/16 steht wegen der Cloud-Metadaten (169.254.169.254) mit drin,
 * 100.64.0.0/10 ist Carrier-NAT, 198.18.0.0/15 Benchmark-Netz.
 */
function isBlockedIpv4(octets) {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // Multicast und reservierte Bereiche
  return false;
}

function expandIpv6(value) {
  let raw = String(value).trim().replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (!raw.includes(':')) return null;
  if (raw.split('::').length > 2) return null; // „::" gibt es nur einmal

  // Eingebettete IPv4-Schreibweise (::ffff:127.0.0.1) belegt zwei Gruppen und
  // wird vorab in Hex umgeschrieben, damit die Zaehlung unten stimmt.
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (embedded) {
    const octets = parseIpv4(embedded[2]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    raw = `${embedded[1]}${high}:${low}`;
  }

  const [head, tail] = raw.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = raw.includes('::')
    ? (missing < 0 ? null : [...headGroups, ...Array(missing).fill('0'), ...tailGroups])
    : raw.split(':');
  if (!groups || groups.length !== 8) return null;
  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

function isBlockedIpv6(groups) {
  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) und IPv4-compatible: nach IPv4-Regeln pruefen
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((g) => g === 0);
  if (isMapped || isCompat) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return isBlockedIpv4(octets);
  }
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 Link Local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
  return false;
}

/** Ist die IP-Adresse (v4 oder v6) fuer den Abruf gesperrt? */
function isBlockedAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const octets = parseIpv4(value.trim());
  if (octets) return isBlockedIpv4(octets);
  const groups = expandIpv6(value);
  if (groups) return isBlockedIpv6(groups);
  return true; // Was sich nicht als Adresse lesen laesst, wird nicht abgerufen.
}

/** Hostname, der ohne Aufloesung schon feststeht (localhost, *.local, IP-Literal). */
function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return true;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // IP-Literale gehen direkt in die Adresspruefung, ohne DNS.
  if (host.startsWith('[') || parseIpv4(host) || expandIpv6(host)) return isBlockedAddress(host);
  return false;
}

/**
 * Liest eine vom Modell gelieferte Adresse. Liefert `{ url }` oder `{ error }`
 * mit Klartext; `error` ist bereits die Meldung fuer das Tool-Ergebnis.
 */
function parseHttpUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { error: 'Es wurde keine Adresse angegeben.' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `„${value}" ist keine gültige Adresse.` };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { error: `Nur http und https werden gelesen, nicht „${url.protocol.replace(':', '')}".` };
  }
  // Zugangsdaten in der Adresse: die wuerde das Tool mitschicken, ohne dass
  // der Nutzer sie je gesehen hat.
  if (url.username || url.password) {
    return { error: 'Adressen mit Benutzername oder Passwort werden nicht abgerufen.' };
  }
  return { url };
}

module.exports = {
  parseHttpUrl,
  isBlockedHostname,
  isBlockedAddress,
};
