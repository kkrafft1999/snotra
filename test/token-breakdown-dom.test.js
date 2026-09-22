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

function groupHead(panel, group) {
  return panel.querySelector(`.token-breakdown__group-head[data-group="${group}"]`);
}

function expandAll(panel) {
  for (const head of panel.querySelectorAll('.token-breakdown__group-head')) click(head);
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
  assert.deepEqual(groups, ['System prompt', 'Skills', 'Tool definitions', 'History']);
  expandAll(panel);
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

  assert.ok(panel.textContent.includes('10,000 tokens prompt'));
  assert.ok(panel.textContent.includes('200 tokens answer'));
  assert.match(panel.querySelector('.token-breakdown__note').textContent, /from the provider.*estimated/s);
});

test('der Cache-Anteil steht bei den echten Zahlen, nicht in der Schätzung (#179)', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200, cached: 8704 },
  });
  click(trigger);

  const cache = panel.querySelector('.token-breakdown__cache');
  assert.ok(cache, 'ohne Zeile bleibt unsichtbar, ob Caching ueberhaupt greift');
  // Intl setzt vor das Prozentzeichen ein schmales geschuetztes Leerzeichen.
  assert.match(cache.textContent, /of which 8,704 from the cache \(87\s?%\)/u);
  // Im Kopf, ueber der Trennlinie — also bei promptTokens und nicht zwischen
  // den geschaetzten Zeilen.
  assert.equal(cache.closest('.token-breakdown__header') !== null, true);
});

test('„100 %" heißt alles — fast alles rundet nicht dorthin (#179)', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 14052, completion: 312, total: 14364, cached: 13998 },
  });
  click(trigger);

  // 13.998 von 14.052 sind 99,6 % — „100 %" waere die Behauptung, es sei
  // nichts frisch gerechnet worden.
  assert.match(panel.querySelector('.token-breakdown__cache').textContent, /\(>\s?99\s?%\)/u);
});

test('ohne Cache-Treffer bleibt die Zeile weg (#179)', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200, cached: 0 },
  });
  click(trigger);
  assert.equal(panel.querySelector('.token-breakdown__cache'), null);
});

test('ohne Tokenzahl des Anbieters sagt die Fläche, dass alles geschätzt ist', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(0),
    usage: { prompt: 0, completion: 0, total: 0 },
  });
  click(trigger);
  assert.match(panel.querySelector('.token-breakdown__note').textContent, /reported no token count/);
});

test('ohne Anfrage erklärt die Fläche, dass noch nichts vorliegt', async () => {
  const { trigger, panel } = await mount();
  click(trigger);

  const empty = panel.querySelector('.token-breakdown__empty');
  assert.ok(empty, 'leerer Zustand ist keine leere Fläche');
  assert.match(empty.textContent, /No request sent yet/);
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
    /A request is running/
  );
});

test('eine Skill-Zeile führt zu ihrem Schalter in den Einstellungen', async () => {
  const opened = [];
  const { trigger, panel } = await mount(
    { breakdown: demoBreakdown(), usage: { prompt: 10000, completion: 200, total: 10200 } },
    { onOpenSkillSettings: (name) => opened.push(name) }
  );
  click(trigger);
  click(groupHead(panel, 'skills'));

  const rows = [...panel.querySelectorAll('.token-breakdown__row')];
  const skillRow = rows.find((row) => row.dataset.skillName === 'grosser-skill');
  assert.equal(skillRow.tagName, 'BUTTON');
  assert.match(skillRow.getAttribute('aria-label'), /open the skill in the settings/);
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

test('die Gruppen starten zugeklappt — erst die Summen, dann die Einzelposten', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  const heads = [...panel.querySelectorAll('.token-breakdown__group-head')];
  assert.equal(heads.length, 4, 'jede Gruppe ist ein Schalter');
  for (const head of heads) {
    assert.equal(head.tagName, 'BUTTON', 'kein <div> mit onclick');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    // Was der Schalter auf- und zuklappt, steht in aria-controls.
    const rows = panel.querySelector(`#${head.getAttribute('aria-controls')}`);
    assert.ok(rows, 'aria-controls zeigt auf eine echte Liste');
    assert.equal(rows.hidden, true, 'die Einzelposten sind zunächst verborgen');
  }
  // Die Summe je Gruppe muss auch zugeklappt lesbar sein.
  assert.ok(panel.textContent.includes('Skills'));
  assert.ok(panel.textContent.includes('2 items'), 'zugeklappt sagt die Zeile, wie viel dahintersteckt');
});

test('ein Klick auf die Gruppe klappt auf und wieder zu', async () => {
  const { trigger, panel } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);

  const head = groupHead(panel, 'skills');
  const rows = panel.querySelector(`#${head.getAttribute('aria-controls')}`);

  click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(rows.hidden, false);
  assert.equal(
    head.parentElement.classList.contains('token-breakdown__group--open'),
    true,
    'die spitze Klammer dreht sich über die Klasse'
  );
  // Nur die angeklickte Gruppe geht auf.
  assert.equal(groupHead(panel, 'tools').getAttribute('aria-expanded'), 'false');

  click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(rows.hidden, true);
});

test('aufgeklappte Gruppen bleiben es — auch nach neuer Antwort und erneutem Öffnen', async () => {
  const { trigger, panel, current, api } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);
  click(groupHead(panel, 'skills'));

  // Neue Zahlen zeichnen die Fläche neu.
  current.breakdown = demoBreakdown(12000);
  api.refresh();
  assert.equal(groupHead(panel, 'skills').getAttribute('aria-expanded'), 'true');

  // Und auch Zu- und Wieder-Aufmachen vergisst den Zustand nicht.
  click(trigger);
  click(trigger);
  assert.equal(groupHead(panel, 'skills').getAttribute('aria-expanded'), 'true');
  assert.equal(groupHead(panel, 'history').getAttribute('aria-expanded'), 'false');
});

test('ein Klick auf die Gruppe schließt die Fläche nicht', async () => {
  const { trigger, panel, api } = await mount({
    breakdown: demoBreakdown(),
    usage: { prompt: 10000, completion: 200, total: 10200 },
  });
  click(trigger);
  click(groupHead(panel, 'tools'));
  assert.equal(api.isOpen(), true);
});
