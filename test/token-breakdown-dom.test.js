// Aufschlüsselung hinter der Token-Anzeige (Issue #174).
//
// Das Markup kommt aus der echten index.html — faellt eine ID weg, faellt
// dieser Test und nicht erst die App. Geprueft wird die Verdrahtung: was ein
// Klick am Baum aendert, was die Tastatur kann, und ob „echt" und
// „geschaetzt" auseinandergehalten werden.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');
const {
  CONTEXT_PART_GROUPS,
  CONTEXT_CONTENT_KINDS,
  createContextBreakdown,
} = require('../src/shared/contracts/context-breakdown');

function demoBreakdown(promptTokens = 10000) {
  return createContextBreakdown({
    promptTokens,
    parts: [
      {
        id: 'system:base',
        group: CONTEXT_PART_GROUPS.SYSTEM,
        label: 'Eigener System-Prompt',
        chars: 400,
      },
      {
        id: 'skill:grosser-skill',
        group: CONTEXT_PART_GROUPS.SKILLS,
        label: 'grosser-skill',
        detail: 'vollständige Anleitung im Prompt',
        chars: 8000,
        contentKind: CONTEXT_CONTENT_KINDS.MARKDOWN,
        skillName: 'grosser-skill',
      },
      {
        id: 'skill:kleiner-skill',
        group: CONTEXT_PART_GROUPS.SKILLS,
        label: 'kleiner-skill',
        detail: 'nur Kurzbeschreibung',
        chars: 120,
        skillName: 'kleiner-skill',
      },
      {
        id: 'tools:mcp:atlassian',
        group: CONTEXT_PART_GROUPS.TOOLS,
        label: 'MCP · atlassian',
        detail: '2 Schemas',
        chars: 4000,
        contentKind: CONTEXT_CONTENT_KINDS.JSON,
        count: 2,
      },
      {
        id: 'history:messages',
        group: CONTEXT_PART_GROUPS.HISTORY,
        label: 'Nachrichten',
        chars: 300,
      },
    ],
  });
}

async function mount(state = {}, { onOpenSkillSettings } = {}) {
  const dom = setupRendererDom();
  const { initTokenBreakdownPanel } = await importRenderer('components', 'TokenBreakdownPanel.js');
  const trigger = dom.document.getElementById('chat-token-usage');
  const panel = dom.document.getElementById('chat-token-breakdown');
  const current = {
    breakdown: null,
    usage: { prompt: 0, completion: 0, total: 0 },
    inFlight: false,
    ...state,
  };
  const api = initTokenBreakdownPanel({
    trigger,
    panel,
    getState: () => current,
    onOpenSkillSettings,
  });
  return { dom, api, trigger, panel, current };
}

function click(node) {
  node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

function rowLabels(panel) {
  return [...panel.querySelectorAll('.token-breakdown__row-label')].map((n) => n.textContent);
}

test('die Anzeige ist ein Schalter mit Dialog-Semantik und richtigem Zustand', async () => {
  const { api, trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });

  assert.equal(trigger.tagName, 'BUTTON', 'kein <div> mit onclick');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('aria-controls'), panel.id);
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.classList.contains('hidden'), true);

  click(trigger);
  assert.equal(api.isOpen(), true);
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  // Der Titel, auf den aria-labelledby zeigt, muss auch wirklich da sein.
  assert.equal(panel.querySelector(`#${panel.getAttribute('aria-labelledby')}`).tagName, 'H2');

  click(trigger);
  assert.equal(api.isOpen(), false);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('jeder Skill steht einzeln, teuerster zuerst, mit Gruppen darüber', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  const groups = [...panel.querySelectorAll('.token-breakdown__group-label')].map((n) => n.textContent);
  assert.deepEqual(groups, ['System-Prompt', 'Skills', 'Tool-Definitionen', 'Verlauf']);
  assert.deepEqual(rowLabels(panel), [
    'Eigener System-Prompt',
    'grosser-skill',
    'kleiner-skill',
    'MCP · atlassian',
    'Nachrichten',
  ]);
  assert.ok(
    panel.textContent.includes('vollständige Anleitung im Prompt'),
    'die Zeile sagt, ob der Skill voll im Prompt steht'
  );
  assert.ok(panel.textContent.includes('2 Schemas'));
});

test('die Gesamtzahl gilt als echt, die Anteile als Schätzung', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  assert.ok(panel.textContent.includes('10.000 Tokens Prompt'));
  assert.ok(panel.textContent.includes('200 Tokens Antwort'));
  assert.match(panel.querySelector('.token-breakdown__note').textContent, /vom Anbieter.*geschätzt/s);
});

test('ohne Tokenzahl des Anbieters sagt die Fläche, dass alles geschätzt ist', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(0),
    usage: { prompt: 0, completion: 0, total: 0 },
  });
  click(trigger);
  assert.match(panel.querySelector('.token-breakdown__note').textContent, /keine Tokenzahl gemeldet/);
});

test('ohne Anfrage erklärt die Fläche, dass noch nichts vorliegt', async () => {
  const { trigger, panel } = await mount();
  click(trigger);

  const empty = panel.querySelector('.token-breakdown__empty');
  assert.ok(empty, 'leerer Zustand ist keine leere Fläche');
  assert.match(empty.textContent, /Noch keine Anfrage gestellt/);
  assert.equal(panel.querySelector('.token-breakdown__list'), null);
});

test('während einer laufenden Anfrage steht dran, woher die Werte stammen', async () => {
  const { trigger, panel, current, api } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);
  assert.equal(panel.querySelector('.token-breakdown__note--live'), null);

  current.inFlight = true;
  api.refresh();
  assert.match(
    panel.querySelector('.token-breakdown__note--live').textContent,
    /Anfrage läuft/
  );
});

test('eine Skill-Zeile führt zu ihrem Schalter in den Einstellungen', async () => {
  const opened = [];
  const { trigger, panel } = await mount(
    { breakdown: demoBreakdown(), usage: { prompt: 10000, completion: 200, total: 10200 } },
    { onOpenSkillSettings: (name) => opened.push(name) }
  );
  click(trigger);

  const rows = [...panel.querySelectorAll('.token-breakdown__row')];
  const skillRow = rows.find((row) => row.dataset.skillName === 'grosser-skill');
  assert.equal(skillRow.tagName, 'BUTTON');
  assert.match(skillRow.getAttribute('aria-label'), /Skill in den Einstellungen öffnen/);
  // Zeilen ohne Skill sind keine Schalter — sie führen nirgendwohin.
  const toolRow = rows.find((row) => row.textContent.includes('MCP · atlassian'));
  assert.equal(toolRow.tagName, 'DIV');

  click(skillRow);
  assert.deepEqual(opened, ['grosser-skill']);
  assert.equal(panel.classList.contains('hidden'), true, 'der Sprung schließt die Fläche');
});

test('Escape schließt und gibt den Fokus an die Anzeige zurück', async () => {
  const { dom, trigger, panel, api } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  panel.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  assert.equal(api.isOpen(), false);
  assert.equal(dom.document.activeElement, trigger);
});

test('ein Klick daneben schließt, einer in der Fläche nicht', async () => {
  const { dom, trigger, panel, api } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  click(panel.querySelector('.token-breakdown__title'));
  assert.equal(api.isOpen(), true, 'innerhalb der Fläche bleibt offen');

  click(dom.document.getElementById('chat-messages'));
  assert.equal(api.isOpen(), false);
});
