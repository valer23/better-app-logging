// The log grid (roadmap P5): ALV.gridPure in an empty vm context, and the DOM side (createGrid) on the fake page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModules, pageScriptSrcs, loadLegacy, stickyDocument, read, HTML_PATH } from './_load.mjs';
import { fakePage, mount } from './_fake.mjs';

const G = loadPureModules('shell.js', 'grid.js').gridPure;

test('grid.js loads after live.js in an empty context and exposes its pure helpers', () => {
  const srcs = pageScriptSrcs();
  assert.equal(srcs.indexOf('assets/js/grid.js'), srcs.indexOf('assets/js/live.js') + 1);
  for (const k of ['timeOf', 'rowClass', 'clampCol', 'resizeKey']) assert.equal(typeof G[k], 'function', k);
  assert.ok(Object.isFrozen(G) && Object.isFrozen(G.ROW_CLASS));
});

test('timeOf: the time of every timestamp shape the viewer reads, to the millisecond; anything else whole', () => {
  const cases = [
    ['2026-10-14 15:54:26.290', '15:54:26.290'],         // Android live (logcat -v year) and a .logcat file (formatTs)
    ['2026 Oct 14 15:54:26.290123', '15:54:26.290'],     // iOS live and idevicesyslog text: microseconds cut to ms
    ['2026 Oct  4 15:54:26.290123', '15:54:26.290'],     // a padded day
    ['2026 Oct 14 15:54:26', '15:54:26'],                // no fraction
    ['15:54:26.290', '15:54:26.290'],                    // no date at all
    ['', ''], [null, ''], [undefined, ''],
    ['garbage', 'garbage'], ['2026-10-14', '2026-10-14'], ['a b:c', 'a b:c'],
  ];
  for (const [ts, want] of cases) assert.equal(G.timeOf(ts), want, String(ts));
});

test('rowClass: level and platform in one class string; ASSERT is the F class; unknown levels read as Verbose', () => {
  assert.equal(G.rowClass('ERROR', 'ios'), 'l-e p-i');
  assert.equal(G.rowClass('WARN', 'android'), 'l-w p-a');
  assert.equal(G.rowClass('ASSERT', 'android'), 'l-f p-a');
  assert.equal(G.rowClass('NOPE', 'ios'), 'l-v p-i');
  assert.equal(G.rowClass('INFO', undefined), 'l-i p-a', 'a line without a platform shows the Android badge, as before');
  assert.deepEqual(Object.values(G.LEVEL_CLASS), ['l-v', 'l-d', 'l-i', 'l-w', 'l-e', 'l-f']);
});

test('resize steps: ←/→ 8 px, ⇧ 32 px, Enter and Home reset, other keys are not resize keys; widths stay within 40–400', () => {
  assert.deepEqual(['ArrowLeft', 'ArrowRight'].map(k => G.resizeKey(k, false)), [-8, 8]);
  assert.deepEqual(['ArrowLeft', 'ArrowRight'].map(k => G.resizeKey(k, true)), [-32, 32]);
  assert.deepEqual(['Enter', 'Home'].map(k => G.resizeKey(k, false)), ['reset', 'reset']);
  assert.deepEqual(['End', 'ArrowUp', ' ', 'a'].map(k => G.resizeKey(k, false)), [null, null, null, null]);
  assert.deepEqual([G.COL_MIN, G.COL_MAX], [40, 400]);
  assert.deepEqual([12, 40, 101.6, 400, 999, NaN].map(G.clampCol), [40, 40, 102, 400, 400, 40]);
  assert.deepEqual(Array.from(G.RESIZABLE, ([k]) => k), ['ts', 'lvl', 'tag', 'app', 'pid'], 'every boundary but the fixed platform badge column and the last');
});

// ---- buildRow (legacy script) on a document that builds countable nodes; _load.mjs stubs everything else ----
function rowKit() {
  const doc = stickyDocument();
  const { api, run } = loadLegacy(['buildRow', 'doExport'], { document: doc });
  const text = data => ({ nodeType: 3, data, childNodes: [] });
  doc.createTextNode = text;
  doc.createDocumentFragment = () => ({ nodeType: 11, childNodes: [], appendChild(c) { this.childNodes.push(c); return c; } });
  doc.createElement = tag => ({
    nodeType: 1, tagName: tag.toUpperCase(), className: '', attrs: {}, childNodes: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { if (c.nodeType === 11) { this.childNodes.push(...c.childNodes); c.childNodes = []; } else this.childNodes.push(c); return c; },
    set textContent(v) { this.childNodes = v === '' ? [] : [text(String(v))]; },
    get textContent() { return this.childNodes.map(c => (c.nodeType === 3 ? c.data : c.textContent)).join(''); },
  });
  const count = n => 1 + n.childNodes.reduce((a, c) => a + count(c), 0);
  return { api, run, doc, count };
}
const line = (o = {}) => ({ ts: '2026 Oct 14 15:53:43.000123', pid: 57, tid: 12, tag: 'SpringBoard', app: 'com.example.headset',
  lvl: 'ERROR', msg: 'pairing failed', platform: 'ios', seq: 1, ...o });

test('buildRow: seven cells in the D14 order, the level and platform in the row class, 14 nodes (17 before P5)', () => {
  const k = rowKit();
  const tr = k.api.buildRow(line(), false);
  assert.equal(tr.className, 'l-e p-i');
  assert.deepEqual(tr.childNodes.map(td => td.className), ['c-plat', 'c-ts', 'c-lvl', 'c-tag', 'c-app', 'c-pid', 'c-msg']);
  assert.deepEqual(tr.childNodes.map(td => td.textContent), ['', '15:53:43.000', 'E', 'SpringBoard', 'com.example.headset', '57-12', 'pairing failed']);
  assert.equal(k.count(tr), 14, 'tr + 7 cells + 6 text nodes: the badge is CSS');
  assert.deepEqual(tr.attrs, {}, 'no attribute on an unselected row: no tabindex, title, role or aria-selected');
  assert.equal(tr._message.msg, 'pairing failed');
  assert.equal(k.api.buildRow(line(), true).className, 'l-e p-i is-new', 'isNew stays the arrival flag (P5b styles it)');
});

test('buildRow: ASSERT reads F on screen while a TXT export keeps A; the selected line gets aria-selected', async () => {
  const k = rowKit();
  const m = line({ lvl: 'ASSERT', platform: 'android', tid: 0 });
  const tr = k.api.buildRow(m, false);
  assert.deepEqual([tr.className, tr.childNodes[2].textContent, tr.childNodes[5].textContent], ['l-f p-a', 'F', '57']);
  k.run('cur').sel = m;
  assert.equal(k.api.buildRow(m, false).attrs['aria-selected'], 'true');
  assert.equal(k.api.buildRow(line(), false).attrs['aria-selected'], undefined);
  k.run("globalThis.__saved = null; legacyDownload = (name, content) => { __saved = content; }");
  k.run('cur').all = [m];
  k.doc.querySelector = () => ({ value: 'all' });
  await k.api.doExport('txt');
  assert.match(k.run('__saved'), / {2}🤖 {2}\s+57-\s+0 {2}A {2}SpringBoard /u, 'the export letter is unchanged, so files round-trip');
});

test('buildRow: log text stays text (XSS), and no row of any shape exceeds 14 nodes without a search hit', () => {
  const k = rowKit();
  const evil = k.api.buildRow(line({ msg: '<img src=x onerror=alert(1)>', tag: '<b>', app: '"><script>' }), false);
  assert.deepEqual(evil.childNodes.slice(3).map(td => td.childNodes.map(c => c.nodeType)), [[3], [3], [3], [3]], 'one Text node each, no element');
  assert.equal(evil.childNodes[6].textContent, '<img src=x onerror=alert(1)>');
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const LV = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ASSERT', 'BOGUS'];
  for (let i = 0; i < 300; i++) {
    const m = line({ lvl: LV[rnd(7)], platform: rnd(2) ? 'ios' : 'android', app: rnd(2) ? '' : 'app', tid: rnd(2), tag: rnd(3) ? 'T' : '',
      msg: 'x'.repeat(rnd(400)), ts: rnd(4) ? '2026-10-14 15:54:26.290' : 'odd' });
    const tr = k.api.buildRow(m, false);
    assert.ok(k.count(tr) <= 14, `row ${i}: ${k.count(tr)} nodes`);
    assert.match(tr.className, /^l-[vdiwef] p-[ai]$/);
  }
});

// ---- createGrid on the fake page, with the page's #logWrapper mounted ----
// The fake mount drops text between tags; `headerText` puts back the header texts the page's markup carries.
// `st` is what shellState() returns (only `cur` is read); `ticks` holds the shell.onTick callbacks.
function gridPage({ headerText = false } = {}) {
  const p = fakePage({ files: ['prefs.js', 'dom.js', 'keys.js', 'ui.js', 'shell.js', 'grid.js'] });
  mount(p, 'logWrapper');
  if (headerText) {
    const texts = [...read(HTML_PATH).match(/<tr id="headerRow">[\s\S]*?<\/tr>/)[0].matchAll(/<span class="h">([^<]*)<\/span>/g)].map(m => m[1]);
    const hs = p.byId.headerRow.children.map(th => th.children.find(c => c.className === 'h')).filter(Boolean);
    assert.equal(hs.length, texts.length);
    hs.forEach((h, i) => { h.textContent = texts[i]; });
  }
  const st = { cur: { filtered: [] } };
  const ticks = [];
  const shell = { onTick: fn => ticks.push(fn) };
  const grid = p.ALV.createGrid({ doc: p.doc, dom: p.dom, keys: p.keys, shell, state: () => st });
  const ths = p.byId.headerRow.children;
  const cols = p.byId.colgroup.children;
  const seps = ths.flatMap(th => th.children.filter(c => c.attrs.role === 'separator'));
  const key = (sep, k, o = {}) => {
    const ev = { key: k, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...o };
    for (const fn of sep.listeners.keydown || []) fn(ev);
    return ev;
  };
  return { p, grid, ths, cols, seps, key, st, ticks };
}

test('resize handles: one separator per boundary after Time, Lvl, Tag, App / Device and PID–TID, inside the next header cell', () => {
  const { ths, seps } = gridPage();
  assert.deepEqual(seps.map(s => s.attrs['aria-label']),
    ['Resize Time column', 'Resize Lvl column', 'Resize Tag column', 'Resize App / Device column', 'Resize PID–TID column']);
  assert.deepEqual(seps.map(s => ths.indexOf(s.parent)), [2, 3, 4, 5, 6], 'the handle of column n sits in header cell n + 1');
  for (const s of seps) {
    assert.deepEqual([s.className, s.attrs.tabindex, s.attrs['aria-orientation'], s.attrs['aria-valuemin'], s.attrs['aria-valuemax']],
      ['col-sep', '0', 'vertical', '40', '400']);
  }
});

test('resize handles: a header cell that hosts a separator keeps its own name, not the handle label', () => {
  const { ths, seps } = gridPage({ headerText: true });
  const hosts = seps.map(s => s.parent);
  assert.deepEqual(hosts.map(h => h.attrs['aria-label']), ['Lvl', 'Tag', 'App / Device', 'PID–TID', 'Message']);
  for (const h of hosts) {
    const text = h.children.find(c => c.className === 'h').textContent;
    assert.equal(h.attrs['aria-label'], text, 'the explicit name equals the visible header text');
  }
  assert.equal(ths[0].attrs['aria-label'], 'Platform', 'a name the markup already gives is kept');
});

test('resize handles: focus reports the width; ←/→ 8 px, ⇧ 32 px, clamped to 40–400; Enter and Home reset; modified keys pass', () => {
  const { ths, cols, seps, key } = gridPage();
  const tag = seps[2];
  const th = ths[3];
  th.offsetWidth = 150;
  for (const fn of tag.listeners.focus) fn({});
  assert.equal(tag.attrs['aria-valuenow'], '150', 'read on focus (a user action), never per flush');
  assert.equal(key(tag, 'ArrowRight').defaultPrevented, true);
  assert.equal(cols[3].style.width, '158px');
  key(tag, 'ArrowLeft', { shiftKey: true });
  assert.equal(cols[3].style.width, '118px');
  th.offsetWidth = 395;
  key(tag, 'ArrowRight', { shiftKey: true });
  assert.equal(cols[3].style.width, '400px');
  th.offsetWidth = 45;
  key(tag, 'ArrowLeft', { shiftKey: true });
  assert.deepEqual([cols[3].style.width, tag.attrs['aria-valuenow']], ['40px', '45'], 'aria-valuenow is the width the cell now has');
  assert.equal(key(tag, 'Home').defaultPrevented, true);
  assert.equal(cols[3].style.width, '', 'Home resets to the ch default in grid.css');
  key(tag, 'ArrowRight');
  key(tag, 'Enter');
  assert.equal(cols[3].style.width, '', 'so does Enter');
  for (const o of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) assert.equal(key(tag, 'ArrowRight', o).defaultPrevented, false, JSON.stringify(o));
  assert.equal(key(tag, 'End').defaultPrevented, false, 'End is not a resize key');
});

test('resize handles: Home on a handle never reaches the shortcut registry (P5b binds Home to the oldest line)', () => {
  const { p, seps, key } = gridPage();
  let ran = 0;
  p.keys.register({ id: 'test.home', keys: 'Home', run: () => { ran++; } });
  const ev = key(seps[0], 'Home');
  assert.equal(p.keys.dispatch(ev, seps[0]), null, 'the handle handled it (defaultPrevented)');
  assert.equal(p.keys.dispatch({ key: 'Home', preventDefault() {} }, seps[0]), null, 'and a separator owns its keys anyway');
  assert.equal(ran, 0);
});

test('resize handles: a drag sets the width from the press, clamped, and ends cleanly on release', () => {
  const { ths, cols, seps } = gridPage();
  const ts = seps[0];
  ths[1].offsetWidth = 106;
  ts.fire('pointerdown', { button: 0, clientX: 300, pointerId: 1 });
  assert.equal(ts.getAttribute('data-drag'), '');
  ts.fire('pointermove', { clientX: 344 });
  assert.equal(cols[1].style.width, '150px');
  assert.equal(ts.getAttribute('aria-valuenow'), null, 'a move only writes the width: no layout read per pointermove');
  ts.fire('pointermove', { clientX: 0 });
  assert.equal(cols[1].style.width, '40px');
  ts.fire('pointerup', {});
  assert.equal(ts.getAttribute('data-drag'), null);
  assert.equal(ts.getAttribute('aria-valuenow'), '106', 'the value is read once, on release');
  ts.fire('pointermove', { clientX: 500 });
  assert.equal(cols[1].style.width, '40px', 'no listener left after the release');
  ts.fire('pointerdown', { button: 2, clientX: 300 });
  assert.equal(ts.getAttribute('data-drag'), null, 'a right press does not start a drag');
});

test('the grid: one Tab stop (the table) with role grid, and the scroller is the registry\'s grid root', () => {
  const { p, seps } = gridPage();
  const t = p.byId.logTableEl;
  assert.deepEqual([t.attrs.role, t.attrs.tabindex, t.attrs['aria-label']], ['grid', '0', 'Log lines']);
  let ran = 0;
  p.keys.register({ id: 'test.grid', keys: 'G', scope: 'grid', run: () => { ran++; } });
  const g = active => p.keys.dispatch({ key: 'g', code: 'KeyG', preventDefault() {} }, active);
  assert.equal(g(t), 'test.grid', 'focus on the table');
  assert.equal(g(seps[0]), null, 'a resize separator owns its unmodified keys (keys.js OWNING_ROLES)');
  assert.equal(g(p.byId.filterbar), null, 'focus outside the grid: a grid-scoped single key never fires');
  assert.equal(ran, 1);
});

test('aria-rowcount: filtered lines plus the header row, written on sync and on the shell tick, only when it changed', () => {
  const { p, grid, st, ticks } = gridPage();
  const t = p.byId.logTableEl;
  let writes = 0;
  const real = t.setAttribute.bind(t);
  t.setAttribute = (k, v) => { if (k === 'aria-rowcount') writes++; real(k, v); };
  st.cur = { filtered: new Array(48310) };
  grid.sync();
  assert.equal(t.attrs['aria-rowcount'], '48311');
  assert.equal(ticks.length, 1, 'the grid follows the shell tick (twice a second), not the drain');
  for (let i = 0; i < 10; i++) ticks[0]();
  assert.equal(writes, 1, 'unchanged: no write');
  st.cur = { filtered: [] };
  ticks[0]();
  assert.deepEqual([t.attrs['aria-rowcount'], writes], ['1', 2]);
});

test('the time cell gets the full timestamp (with its date) as a title on its first hover, never before', () => {
  const { p } = gridPage();
  const tr = p.doc.createElement('tr');
  tr._message = { ts: '2026 Oct 14 15:53:43.000123' };
  const ts = p.doc.createElement('td');
  ts.className = 'c-ts';
  const msg = p.doc.createElement('td');
  msg.className = 'c-msg';
  tr.appendChild(ts);
  tr.appendChild(msg);
  p.byId.tbody.appendChild(tr);
  assert.equal(ts.title, undefined, 'buildRow sets no title');
  msg.fire('pointerover');
  assert.equal(msg.title, undefined, 'only the time cell');
  ts.fire('pointerover');
  assert.equal(ts.title, '2026 Oct 14 15:53:43.000123');
});
