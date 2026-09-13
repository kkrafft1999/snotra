// VORÜBERGEHEND — Diagnose, kein Dauertest. Wird nach der Auswertung entfernt.
// Protokolliert, was `fs.watch` auf der laufenden Plattform beim Entfernen
// eines beobachteten Verzeichnisbaums tatsächlich liefert.
const test = require('node:test');
const fsp = require('fs/promises');
const { watch, existsSync } = require('fs');
const os = require('os');
const path = require('path');

test('DIAGNOSE: rohe fs.watch-Ereignisse beim Entfernen', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'diag-'));
  const root = await fsp.realpath(base);
  const agents = path.join(root, '.agents');
  const skills = path.join(agents, 'skills');
  await fsp.mkdir(path.join(skills, 'demo'), { recursive: true });
  await fsp.writeFile(path.join(skills, 'demo', 'SKILL.md'), 'x');

  const log = [];
  const mk = (dir, recursive, label) => {
    try {
      const w = watch(dir, { recursive }, (e, f) => log.push(`${label}: ${e} ${f}`));
      w.on('error', (err) => log.push(`${label}: ERROR ${err.code || err.message}`));
      return w;
    } catch (err) {
      log.push(`${label}: WATCH-WIRFT ${err.code || err.message}`);
      return null;
    }
  };
  const wSkills = mk(skills, true, 'skills(rec)');
  const wAgents = mk(agents, false, '.agents(flach)');
  const wRoot = mk(root, false, 'root(flach)');

  await new Promise((r) => setTimeout(r, 300));
  let rmFehler = 'keiner';
  try {
    await fsp.rm(agents, { recursive: true, force: true });
  } catch (err) {
    rmFehler = `${err.code || err.message}`;
  }
  await new Promise((r) => setTimeout(r, 2000));

  console.log('=== DIAGNOSE plattform=' + process.platform + ' ===');
  console.log('rm-Fehler:', rmFehler);
  console.log('.agents existiert noch:', existsSync(agents));
  console.log('Ereignisse:', log.length === 0 ? '(KEINE)' : '');
  for (const zeile of log) console.log('  ', zeile);
  console.log('=== DIAGNOSE ENDE ===');

  for (const w of [wSkills, wAgents, wRoot]) w?.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});
