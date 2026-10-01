const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

// Issue #97: Die Meldung lag im Panel "Modelle". Auf jedem anderen Tab ist
// dieses Panel `hidden` — der Nutzer klickte "Übernehmen" und sah nichts.
test('die Speicher-Fehlermeldung steht in der Dialog-Fußzeile, nicht in einem Tab-Panel (#97)', () => {
  const occurrences = html.split('id="modal-save-error"').length - 1;
  assert.equal(occurrences, 1, 'die Meldung gibt es genau einmal');

  const errorAt = html.indexOf('id="modal-save-error"');
  const footerStart = html.indexOf('<footer class="settings-dialog__footer');
  const footerEnd = html.indexOf('</footer>', footerStart);
  assert.ok(footerStart !== -1 && footerEnd !== -1, 'die Fußzeile des Einstellungsdialogs existiert');
  assert.ok(
    errorAt > footerStart && errorAt < footerEnd,
    'die Meldung muss neben "Übernehmen" in der Fußzeile stehen'
  );

  const lastPanelAt = html.lastIndexOf('class="settings-panel"');
  assert.ok(errorAt > lastPanelAt, 'die Meldung darf in keinem der ausblendbaren Tab-Panels liegen');
});

test('die Speicher-Fehlermeldung wird Screenreadern angesagt (#97)', () => {
  const errorAt = html.indexOf('id="modal-save-error"');
  const tagStart = html.lastIndexOf('<p', errorAt);
  const tag = html.slice(tagStart, html.indexOf('>', errorAt) + 1);
  assert.match(tag, /role="alert"/);
});

// Issue #104: Der Dialog zeigte ganze Absaetze, bevor man den ersten Schalter
// sah. Erklaertext gehoert jetzt hinter einen Aufklapper — wie im Tool-Katalog.
test('lange Erklaertexte stehen hinter einem Aufklapper mit Kurzsatz (#104)', () => {
  const notes = html.match(/<details[^>]*class="settings-note[^"]*"/g) || [];
  assert.ok(notes.length >= 10, `zu wenige Aufklapper gefunden: ${notes.length}`);

  const summaries = html.match(/<summary class="settings-note__summary"/g) || [];
  assert.equal(summaries.length, notes.length, 'jeder Aufklapper hat genau eine sichtbare Zeile');

  // Seit Epic #277 traegt der Textkoerper zusaetzlich `data-i18n-html`.
  const bodies = html.match(/<div class="settings-note__body"/g) || [];
  assert.equal(bodies.length, notes.length, 'jeder Aufklapper hat genau einen Textkoerper');
});

test('die sichtbare Zeile eines Hinweises bleibt ein kurzer Satz (#104)', () => {
  const matches = [...html.matchAll(/<summary class="settings-note__summary">([\s\S]*?)<\/summary>/g)];
  assert.ok(matches.length > 0, 'es gibt Aufklapper mit Kurzsatz');
  for (const [, inner] of matches) {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 0, 'die Kurzzeile ist nicht leer');
    assert.ok(text.length <= 130, `Kurzzeile zu lang (${text.length} Zeichen): ${text}`);
  }
});

// Issue #103: Snotra liest keine .claude-Verzeichnisse mehr — die
// Skills-Beschreibung im Dialog darf sie nicht als Quelle nennen.
test('der Skills-Bereich nennt .claude nicht mehr als Quelle (#103)', () => {
  assert.equal(html.includes('.claude/skills'), false);
  assert.ok(html.includes('.agents/skills'), 'die verbleibende Quelle steht im Dialog');
});

// Issue #251: Der Hinweistext soll den neuen Standardort nennen — samt dem
// Umstand, dass ~/.snotra Snotras eigenes Benutzerverzeichnis ist und der
// Alt-Ort weiterhin gelesen wird.
test('der Skills-Bereich nennt ~/.snotra/skills als Standardort (#251)', () => {
  assert.ok(html.includes('~/.snotra/skills'), 'der neue Standardort steht im Dialog');
  assert.ok(html.includes('~/.agents/skills'), 'der Alt-Ort steht weiterhin im Dialog');
  assert.match(html, /own user directory/, '~/.snotra ist als eigenes Verzeichnis beschrieben');
});

// Issue #102: Die Shell-Ausfuehrung ist die weitreichendste Einstellung der
// App — sie braucht einen eigenen Bereich mit sichtbarer Warnung.
test('die Tool-Einstellungen haben eine Karte für Shell-Befehle mit Warnhinweis (#102)', () => {
  assert.equal(html.split('id="settings-shell-card"').length - 1, 1);
  assert.equal(html.split('id="input-shell-enabled"').length - 1, 1);
  assert.equal(html.split('id="settings-shell-status"').length - 1, 1);

  // The card ends where the next slot of the Security page begins — sliced
  // further, the assertions below would also pass on the sandbox card's text.
  const cardStart = html.indexOf('id="settings-shell-card"');
  const cardEnd = html.lastIndexOf('<div', html.indexOf('id="settings-sandbox-card"'));
  assert.ok(cardEnd > cardStart, 'the sandbox slot follows the shell card');
  const card = html.slice(cardStart, cardEnd);
  assert.ok(!card.includes('class="settings-security-slot'), 'the slice holds one card only');
  assert.match(card, /settings-note--warning/, 'die Warnung ist als solche ausgezeichnet');
  assert.match(card, /shell_execute/);
  // Since #329 the warning names the scope per operating system: isolated on
  // macOS and Linux, full rights on Windows.
  assert.match(card, /isolated on macOS and Linux, with your full rights on Windows/);
  assert.match(card, /<code>bubblewrap<\/code>, <code>socat<\/code> and\s+<code>ripgrep<\/code>/);
  // The isolation line sits next to the status and stays hidden until there is something to say.
  assert.match(card, /id="settings-shell-sandbox"[^>]*role="status"[^>]*hidden/);
});

test('the Python card names the sandbox scope and has an isolation line (#329)', () => {
  // One card under that id: SecurityPanel.js moves it into its row by id.
  assert.equal(html.split('id="settings-python-card"').length - 1, 1, 'the id is duplicated');
  const cardStart = html.indexOf('id="settings-python-card"');
  const cardEnd = html.indexOf('id="settings-shell-card"');
  assert.ok(cardEnd > cardStart, 'the shell slot follows the Python card');
  const card = html.slice(cardStart, cardEnd);
  assert.match(card, /isolated on macOS and Linux, with your full rights on Windows/);
  assert.match(card, /id="settings-python-sandbox"[^>]*role="status"[^>]*hidden/);
});

// Issue #138: Der Schalter steht im Bereich „Allgemein“ neben dem
// System-Prompt — er betrifft genau den, nicht die Tools. Und er muss sagen,
// dass der absolute Pfad den Anbieter erreicht; sonst ist er eine Falle.
test('der Bereich „Allgemein“ hat einen Schalter für Umgebungsinformationen (#138)', () => {
  assert.equal(html.split('id="input-environment-info"').length - 1, 1);

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  assert.ok(panel.includes('id="input-environment-info"'), 'der Schalter liegt im Allgemein-Panel');

  const toggleAt = panel.indexOf('id="input-environment-info"');
  assert.ok(
    toggleAt > panel.indexOf('id="input-global-system-prompt"'),
    'er steht hinter dem System-Prompt, den er ergänzt'
  );

  const hintAt = panel.indexOf('id="hint-environment-info"');
  assert.ok(hintAt > -1, 'zum Schalter gehört ein Erklärtext');
  assert.match(panel.slice(toggleAt, hintAt + 400), /aria-describedby="hint-environment-info"/);
  const hint = panel.slice(hintAt, panel.indexOf('</details>', hintAt));
  assert.match(hint, /absolute[rn]? Pfad|absolute<\/strong>|<strong>absolute/i);
  assert.match(hint, /user name/, 'die Preisgabe wird benannt');
  assert.match(hint, /provider/, 'und wohin sie geht');
});

// Issue #212: Derselbe Platz, dieselbe Begruendungspflicht — der Schalter
// entscheidet, ob fremde Anweisungen aus einem geoeffneten Ordner wirken.
test('der Bereich „Allgemein“ hat einen Schalter für AGENTS.md (#212)', () => {
  assert.equal(html.split('id="input-project-instructions"').length - 1, 1);

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panelEnd = html.indexOf('</section>', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  const toggleAt = panel.indexOf('id="input-project-instructions"');
  assert.ok(toggleAt > -1, 'der Schalter liegt im Allgemein-Panel');
  assert.ok(
    toggleAt > panel.indexOf('id="input-global-system-prompt"'),
    'er steht hinter dem System-Prompt, den er ergänzt'
  );

  const hintAt = panel.indexOf('id="hint-project-instructions"');
  assert.ok(hintAt > -1, 'zum Schalter gehört ein Erklärtext');
  assert.match(
    panel.slice(toggleAt, hintAt + 400),
    /aria-describedby="hint-project-instructions"/
  );
  const hint = panel.slice(hintAt, panel.indexOf('</details>', hintAt));
  // Alle drei Quellen müssen dort stehen — sonst sucht der Nutzer die Datei
  // an der falschen Stelle.
  for (const pfad of ['&lt;folder&gt;/AGENTS.md', '~/.snotra/AGENTS.md', '~/.agents/AGENTS.md']) {
    assert.ok(hint.includes(pfad), `der Erklärtext nennt ${pfad}`);
  }
  assert.ok(!hint.includes('&lt;folder&gt;/.agents/AGENTS.md'), 'the old project location is gone');
  // Whoever still has a file under `.agents/` should not have to guess why it
  // does nothing (#432).
  assert.match(hint, /directly in the folder root/);
  assert.match(hint, /under <code>\.agents\/<\/code> is\s+<strong>not<\/strong> read/);
  assert.match(hint, /add to each other/,
    'der Text behauptet keine Rangfolge, sondern sagt, dass alles gemeinsam gilt');
  assert.match(hint, /instruction, not data|instruction<\/strong>, not data/,
    'und sagt, dass der Inhalt das Verhalten ändert');
});

// Der Umschalter fuer hell/dunkel sass bis v1.7.3 als Knopf in der
// Titelleiste. Er steht jetzt unter „Allgemein" — und nur dort, sonst gaebe es
// zwei Bedienstellen fuer eine Einstellung.
test('das Erscheinungsbild wird unter „Allgemein“ gewählt, nicht in der Titelleiste', () => {
  assert.equal(html.split('id="choice-app-theme"').length - 1, 1);
  assert.ok(!html.includes('id="theme-toggle"'), 'in der Titelleiste steht kein Knopf mehr');

  const panelStart = html.indexOf('id="panel-settings-general"');
  const panel = html.slice(panelStart, html.indexOf('</section>', panelStart));
  const groupAt = panel.indexOf('id="choice-app-theme"');
  assert.ok(groupAt > -1, 'die Auswahl liegt im Allgemein-Panel');

  const group = panel.slice(groupAt, panel.indexOf('</div>', panel.indexOf('value="dark"')));
  assert.match(group, /value="light"/);
  assert.match(group, /value="dark"/);

  // Segment statt Auswahlliste (#297): eine Gruppe echter Radios, deren Name
  // fuer den Screenreader an der sichtbaren Ueberschrift haengt.
  assert.match(group, /role="radiogroup"/);
  assert.equal(group.split('type="radio"').length - 1, 2);
  assert.match(group, /aria-labelledby="label-app-theme"/);
  assert.match(panel.slice(0, groupAt), /id="label-app-theme"[^>]*>\s*Appearance/);
});

test('die Sofort-Schalter sind echte Schalter, keine Kaestchen (#297)', () => {
  // A checkbox says "chosen, saved later" — these save on the spot, so they
  // carry role="switch" and a label that points at them by id.
  for (const id of [
    'input-environment-info',
    'input-project-instructions',
    'input-python-enabled',
    'input-shell-enabled',
    'input-memory-self',
  ]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > -1, `${id} fehlt`);
    const tag = html.slice(html.lastIndexOf('<input', at), html.indexOf('>', at) + 1);
    assert.match(tag, /role="switch"/, `${id} ist kein Schalter`);
    assert.match(tag, /class="ds-switch"/, id);
    assert.match(html, new RegExp(`for="${id}"`), `${id} hat kein verbundenes Label`);
  }

  // Und die Rueckmeldung „Gespeichert" steht als Live-Region daneben.
  for (const id of [
    'status-environment-info',
    'status-project-instructions',
    'status-python-enabled',
    'status-shell-enabled',
    'status-memory-self',
    'status-app-theme',
    'status-app-locale',
  ]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > -1, `${id} fehlt`);
    assert.match(html.slice(at, html.indexOf('>', at) + 1), /role="status"/, id);
  }
});

// CR-B14-08: what the Add model popup reports ("Loading models …", "3 models
// found", an error, a duplicate) is announced without moving the focus.
test('the model status in the Add model popup is a status region (CR-B14-08)', () => {
  const at = html.indexOf('id="model-status"');
  assert.ok(at > -1);
  const tag = html.slice(html.lastIndexOf('<p', at), html.indexOf('>', at) + 1);
  assert.match(tag, /role="status"/);
});

// CR-B14-08: secondary text in the model list reaches 4.5:1 in both themes.
// `--ds-grey-muted` holds that only from 14 px, and an opacity on a row that
// stays usable pulls any colour below it.
test('the model list keeps its secondary text at 4.5:1 (CR-B14-08)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} is missing`);
    return css.slice(at, css.indexOf('}', at));
  };
  const hidden = rule(".settings-pref-row-inner[data-pref-menu-off='true']");
  assert.doesNotMatch(hidden, /opacity/);
  assert.match(hidden, /border-style:\s*dashed/, 'the hidden state stays visible by shape');
  for (const selector of ['.settings-pref-detail', '.settings-empty-hint']) {
    assert.match(rule(selector), /font-size:\s*var\(--ds-font-size-sm\)/, `${selector} is no longer small text`);
    assert.match(rule(selector), /color:\s*var\(--text-muted-strong\)/, selector);
  }
});
