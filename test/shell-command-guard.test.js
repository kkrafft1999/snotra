// Gesperrte Wirkungen fuer shell_execute (Issue #102, Konzept §9).
//
// Der Guard ist die zweite Verteidigungslinie hinter der Freigabe, kein
// Schutzversprechen — die Tests halten deshalb beides fest: was er faengt und
// wo er bewusst aufhoert.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkShellCommand, BLOCK_REASONS } = require('../src/shared/runtime/shell-command-guard');

function blocked(command) {
  return checkShellCommand(command).blocked;
}

test('gewöhnliche Befehle laufen durch', () => {
  for (const command of [
    'git status --short',
    'npm run build',
    'ls -la',
    'rm build/alt.txt',
    'rm -r build',
    'git push origin main',
    'git push --set-upstream origin feature',
    'docker ps',
    'echo "rm -rf /"',
  ]) {
    assert.equal(blocked(command), false, command);
  }
});

test('rekursives Zwangslöschen ist gesperrt — in jeder Schreibweise', () => {
  for (const command of [
    'rm -rf /',
    'rm -fr ~',
    'rm -r -f build',
    'rm --recursive --force build',
    'rm -Rf build',
  ]) {
    assert.equal(blocked(command), true, command);
  }
  assert.equal(checkShellCommand('rm -rf /').reason, BLOCK_REASONS.RECURSIVE_DELETE);
});

test('Wrapper und vorangestellte Variablen verstecken den Befehl nicht', () => {
  assert.equal(blocked('sudo rm -rf /'), true);
  assert.equal(blocked('env FOO=1 rm -rf /'), true);
  assert.equal(blocked('FOO=1 BAR=2 rm -rf /'), true);
  assert.equal(blocked('nohup nice rm -rf /'), true);
  assert.equal(blocked('/bin/rm -rf /'), true);
});

test('zusammengesetzte Befehle werden Teil für Teil geprüft', () => {
  assert.equal(blocked('npm test && rm -rf node_modules'), true);
  assert.equal(blocked('echo a; rm -rf b'), true);
  assert.equal(blocked('echo a || rm -rf b'), true);
  assert.equal(blocked('cat liste | xargs rm -rf'), true);
  assert.equal(blocked('echo eins\nrm -rf zwei'), true);
});

test('Windows-Entsprechungen sind ebenfalls gesperrt', () => {
  assert.equal(blocked('del /s /q C:\\temp'), true);
  assert.equal(blocked('rd /s /q C:\\temp'), true);
  assert.equal(blocked('rmdir /S C:\\temp'), true);
  assert.equal(blocked('Remove-Item -Recurse -Force C:\\temp'), true);
  assert.equal(blocked('Remove-Item C:\\temp\\datei.txt'), false);
});

test('Datenträgeroperationen sind gesperrt', () => {
  for (const command of [
    'mkfs.ext4 /dev/sda1',
    'mkfs -t ext4 /dev/sda1',
    'fdisk /dev/sda',
    'parted /dev/sda mklabel gpt',
    'diskutil eraseDisk JHFS+ Leer disk2',
    'dd if=/dev/zero of=/dev/disk2 bs=1m',
    'shred -u geheim.txt',
    'Format-Volume -DriveLetter D',
    'diskpart',
  ]) {
    assert.equal(blocked(command), true, command);
  }
  assert.equal(checkShellCommand('fdisk /dev/sda').reason, BLOCK_REASONS.DISK);
  // Eine Datei schreiben ist keine Datentraegeroperation.
  assert.equal(blocked('dd if=quelle.img of=kopie.img'), false);
});

test('das Umschreiben der Git-Historie ist gesperrt', () => {
  for (const command of [
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease origin main',
    'git filter-branch --tree-filter x HEAD',
    'git filter-repo --path src',
  ]) {
    assert.equal(blocked(command), true, command);
  }
  assert.equal(checkShellCommand('git push -f').reason, BLOCK_REASONS.GIT_HISTORY);
});

test('leere Eingaben und Unsinn führen nicht zu einer Sperre', () => {
  assert.equal(blocked(''), false);
  assert.equal(blocked('   '), false);
  assert.equal(blocked(null), false);
  assert.equal(blocked(undefined), false);
  assert.equal(blocked(42), false);
});

test('die Sperre ist ausdrücklich kein vollständiger Schutz', () => {
  // Festgehalten, damit niemand sie für eine Sandbox haelt: ein Interpreter
  // oder ein Skript dazwischen genügt. Der Schutz ist der sichtbare Befehl
  // plus Freigabe, nicht diese Liste (Konzept §9).
  assert.equal(blocked('bash entfernen.sh'), false);
  assert.equal(blocked('echo cm0gLXJmIC8K | base64 -d | sh'), false);
});
