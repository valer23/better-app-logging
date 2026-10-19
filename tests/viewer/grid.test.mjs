// The log grid (roadmap P5): ALV.gridPure in an empty vm context, and the DOM side (createGrid) on the fake page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModules, pageScriptSrcs, loadLegacy, stickyDocument, read, HTML_PATH, memoryStorage, fakeMatchMedia, fakeRoot } from './_load.mjs';
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

test('pillView: Paused wins over new lines, singular and plural, thin-space grouping, Buffer full; nothing to show is null', () => {
  const v = o => G.pillView({ paused: false, buffered: 0, overflowed: false, below: 0, ...o });
  const text = x => (x ? `${x.pre}${x.num}${x.unit} | ${x.action} ${x.key}` : null);
  assert.equal(text(v({ below: 1284 })), '1\u2009284 lines below | Jump to latest stream.latest', 'a thin space (spec conventions)');
  assert.equal(text(v({ below: 1 })), '1 line below | Jump to latest stream.latest');
  assert.equal(text(v({ paused: true, buffered: 3402, below: 50 })), 'Resume to see 3\u2009402 buffered lines | Resume stream.pause');
  assert.equal(text(v({ paused: true, buffered: 1 })), 'Resume to see 1 buffered line | Resume stream.pause');
  assert.equal(text(v({ paused: true, buffered: 9, overflowed: true })), 'Buffer full · resuming skips to the newest lines | Resume stream.pause');
  assert.deepEqual([v({ below: 3 }).mode, v({ below: 3 }).icon, v({ paused: true }).mode, v({ paused: true }).icon], ['newer', 'arrow-down-to-line', 'paused', 'pause']);
  assert.equal(v({}), null);
  assert.equal(v({ below: -2 }), null);
});

test('emptyView: no matches with each spec cause in order and its fix; after Clear; streaming but silent; the phone gone; otherwise none', () => {
  const v = o => G.emptyView({ kind: 'live', all: 0, shown: 0, cleared: false, paused: false, levelsOff: false, devicesOff: false, tag: '', query: false, waiting: [], gone: [], ...o });
  const m = v({ all: 48310 });
  assert.deepEqual([m.title, m.desc, m.fix, m.reset, m.icon, m.spin], ['No lines match this filter', '0 of 48\u2009310 lines in view. No retained line matches the level and device chips.', null, true, 'search-x', false]);
  assert.deepEqual([v({ all: 5, levelsOff: true, devicesOff: true, tag: 'x' }).fix, v({ all: 5, levelsOff: true }).fixLabel], ['levels', 'Turn levels back on'], 'levels first');
  assert.deepEqual([v({ all: 5, devicesOff: true, tag: 'x' }).fix, v({ all: 5, devicesOff: true }).desc], ['devices', '0 of 5 lines in view. Both devices are hidden.']);
  assert.deepEqual([v({ all: 5, tag: 'bt_stack' }).desc, v({ all: 5, tag: 'bt_stack' }).fixLabel], ['0 of 5 lines in view. No retained line matches tag:bt_stack.', 'Remove tag:bt_stack']);
  assert.deepEqual([v({ all: 5, query: true }).desc, v({ all: 5, query: true }).fix, v({ all: 5, query: true }).reset, v({ all: 5, query: true }).say, v({ all: 5, tag: 'x', query: true }).fix],
    ['0 of 5 lines in view.', null, true, 'No lines match this filter.', 'tag'], 'the search or PID / App field filters: the count and Reset filter, no invented cause; a tag still names itself');
  assert.equal(v({ all: 5, shown: 1 }), null, 'rows show: no tile');
  assert.equal(v({ kind: 'file' }), null, 'an empty file session shows the dropzone');
  assert.equal(v({ kind: 'file', all: 3 }).title, 'No lines match this filter', 'a filtered-out file still says why');
  const c = v({ cleared: true, waiting: ['Pixel 8 Pro'] });
  assert.deepEqual([c.title, c.desc, c.icon, c.spin, c.skeleton], ['Waiting for new lines…', 'The view was cleared. New lines appear here as they arrive.', 'loader', true, false], 'Clear wins over waiting');
  const w = v({ waiting: ['Pixel 8 Pro', 'iPhone 15'] });
  assert.deepEqual([w.title, w.desc, w.skeleton, w.reset], ['Waiting for the first lines from Pixel 8 Pro and iPhone 15…', '', true, false]);
  assert.equal(v({ waiting: ['iPhone 15'], paused: true }), null, 'paused: the lines are buffered, the paused pill says so');
  assert.equal(v({ cleared: true }), null, 'Clear with nothing streaming: the device panel shows instead (#70)');
  const g = v({ gone: ['iPhone 15'] });
  assert.deepEqual([g.title, g.desc, g.icon, g.spin, g.skeleton, g.reset, g.say], ['iPhone 15 was unplugged', 'Plug it back in to continue.', 'unplug', false, false, false, 'iPhone 15 was unplugged.'],
    'the open stream\'s phone is gone (noDevice, #70): the spec\'s Disconnected copy');
  const g2 = v({ gone: ['Pixel 8 Pro', 'iPhone 15'] });
  assert.deepEqual([g2.title, g2.desc], ['Pixel 8 Pro and iPhone 15 were unplugged', 'Plug them back in to continue.']);
  assert.equal(v({ gone: ['iPhone 15'], cleared: true }).title, 'iPhone 15 was unplugged', 'gone wins over Clear: nothing arrives until it is back');
  assert.equal(v({ gone: ['iPhone 15'], waiting: ['Pixel 8 Pro'] }).title, 'Waiting for the first lines from Pixel 8 Pro…', 'one device still streams');
  assert.equal(v({}), null, 'no device and no lines: the device cards (P8: "No logs yet")');
  assert.equal(v({ all: 9 }).key === v({ all: 10 }).key, false, 'the count is shown, so it is in the key');
  assert.equal(v({ all: 9 }).say, v({ all: 10 }).say, 'but not in the announcement');
});

test('screenRows: rows in one screenful from the height, the log size and the density (spec "Sizes"); none while hidden', () => {
  assert.deepEqual([G.rowPx(13, 'comfortable'), G.rowPx(13, 'compact'), G.rowPx(10, 'compact'), G.rowPx(20, 'comfortable')], [20.8, 18.2, 18, 32]);
  assert.deepEqual([G.screenRows(500, 13, 'comfortable'), G.screenRows(500, 20, 'comfortable'), G.screenRows(500, 10, 'compact'), G.screenRows(0, 13, 'comfortable')], [25, 16, 28, 0]);
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
// `st` is what shellState() returns (`cur` and `gridShown` are read); `ticks` holds the shell.onTick callbacks; every
// action the grid calls is recorded in `calls`.
function gridPage({ headerText = false } = {}) {
  const p = fakePage({ files: ['prefs.js', 'dom.js', 'keys.js', 'ui.js', 'shell.js', 'grid.js'] });
  mount(p, 'toolbar');
  mount(p, 'logWrapper');
  if (headerText) {
    const texts = [...read(HTML_PATH).match(/<tr id="headerRow">[\s\S]*?<\/tr>/)[0].matchAll(/<span class="h">([^<]*)<\/span>/g)].map(m => m[1]);
    const hs = p.byId.headerRow.children.map(th => th.children.find(c => c.className === 'h')).filter(Boolean);
    assert.equal(hs.length, texts.length);
    hs.forEach((h, i) => { h.textContent = texts[i]; });
  }
  const st = { cur: { kind: 'live', all: [], filtered: [] }, live: { android: false, ios: false }, noDevice: { android: false, ios: false },
    enabled: new Set(['android', 'ios']), levels: 6, tag: '', query: false, cleared: false, paused: false, gridShown: true };
  const ticks = [];
  const calls = [];
  const shell = { onTick: fn => ticks.push(fn), devices: () => ({ android: { name: 'Pixel 8 Pro' }, ios: { name: 'iPhone 15' } }) };
  const actions = new Proxy({}, { get: (o, k) => (...a) => calls.push([k, ...a]) });
  const prefs = p.ALV.createPrefs({ storage: memoryStorage(), matchMedia: fakeMatchMedia(), userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  prefs.boot(fakeRoot());
  // A ResizeObserver whose callback the test fires: resize(h) reports a scroller content height of h px.
  let observed = null;
  p.win.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe(el) { observed = { fn: this.fn, el }; } };
  const resize = h => observed.fn([{ contentRect: { height: h } }]);
  const grid = p.ALV.createGrid({ doc: p.doc, win: p.win, dom: p.dom, ui: p.ui, keys: p.keys, prefs, shell, state: () => st, actions });
  const ths = p.byId.headerRow.children;
  const cols = p.byId.colgroup.children;
  const seps = ths.flatMap(th => th.children.filter(c => c.attrs.role === 'separator'));
  const key = (sep, k, o = {}) => {
    const ev = { key: k, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...o };
    for (const fn of sep.listeners.keydown || []) fn(ev);
    return ev;
  };
  return { p, grid, ths, cols, seps, key, st, ticks, calls, prefs, resize, observed: () => observed };
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

test('resize handles: Home on a handle resets the column and never reaches the stream\'s Home (the oldest line)', () => {
  const { p, seps, key, calls } = gridPage();
  const ev = key(seps[0], 'Home');
  assert.equal(p.keys.dispatch(ev, seps[0]), null, 'the handle handled it (defaultPrevented)');
  assert.equal(p.keys.dispatch({ key: 'Home', preventDefault() {} }, seps[0]), null, 'and a separator owns its keys anyway');
  assert.deepEqual(calls, []);
  assert.equal(p.keys.dispatch({ key: 'Home', preventDefault() {} }, p.byId.logTableEl), 'stream.oldest', 'control: from the table it is the stream\'s Home');
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
  st.cur = { kind: 'live', all: new Array(48310), filtered: new Array(48310) };
  grid.sync();
  assert.equal(t.attrs['aria-rowcount'], '48311');
  assert.equal(ticks.length, 1, 'the grid follows the shell tick (twice a second), not the drain');
  for (let i = 0; i < 10; i++) ticks[0]();
  assert.equal(writes, 1, 'unchanged: no write');
  st.cur = { kind: 'live', all: [], filtered: [] };
  ticks[0]();
  assert.deepEqual([t.attrs['aria-rowcount'], writes], ['1', 2]);
});

// The ring is drawn on #logWrapper (grid.css), a box that does not scroll: on the table itself it spans up to 6 000 rows
// and the full width of the scrolled table, so its edges are off screen.
test('the focus ring: #logWrapper carries grid-focus while the table is focus-visible, and only then', () => {
  const { p, ticks } = gridPage();
  const t = p.byId.logTableEl;
  const wrap = p.byId.logWrapper;
  const fire = type => { for (const fn of t.listeners[type] || []) fn({}); };
  const on = () => wrap.classList.contains('grid-focus');
  assert.equal(on(), false);
  p.setFocusVisible(true);
  fire('focus');
  assert.equal(on(), true, 'Tab into the grid');
  fire('blur');
  assert.equal(on(), false, 'Tab out of it');
  p.setFocusVisible(false);
  fire('focus');
  assert.equal(on(), false, 'a mouse press focuses the table without :focus-visible: no ring');
  p.setFocusVisible(true);
  fire('keydown');
  assert.equal(on(), true, 'a key pressed after that press shows it');
  p.setFocusVisible(false);
  ticks[0]();
  assert.equal(on(), false, 'a hidden or detached grid cannot keep a stale ring: the shell tick re-reads it');
  assert.equal(wrap.className, '', 'the class is the only thing written');
});

test('the grid tick also refreshes the pill (a paused stream runs no flush, so nothing else moves its count)', () => {
  const { grid, ticks, calls } = gridPage();
  ticks[0]();
  grid.sync();
  assert.deepEqual(calls.map(c => c[0]), ['updateNewerPill', 'updateNewerPill']);
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

// ---- Stream keys (P5b) ----
const press = (p, active, key, o = {}) => p.keys.dispatch({ key, code: o.code || '', preventDefault() {}, ...o }, active);

test('stream keys: End and ⌘↓ go to the newest line, Home and ⌘↑ to the oldest, from the grid or a toolbar button; never from a text field', () => {
  const { p, calls } = gridPage();
  const t = p.byId.logTableEl;
  assert.equal(press(p, t, 'End'), 'stream.latest');
  assert.equal(press(p, p.byId.clearBtn, 'End'), 'stream.latest', 'global: a button does not own End');
  assert.equal(press(p, null, 'ArrowDown', { metaKey: true }), 'stream.latest', '⌘↓ (Mod is Meta on macOS)');
  assert.equal(press(p, t, 'Home'), 'stream.oldest');
  assert.equal(press(p, null, 'ArrowUp', { metaKey: true }), 'stream.oldest');
  const field = p.doc.createElement('input');
  field.setAttribute('type', 'text');
  for (const [k, o] of [['End', {}], ['Home', {}], ['ArrowDown', { metaKey: true }]]) assert.equal(press(p, field, k, o), null, `${k} in a text field moves the caret`);
  assert.deepEqual(calls.map(c => c[0]), ['jumpToEnd', 'jumpToEnd', 'jumpToEnd', 'jumpToOldest', 'jumpToOldest']);
});

test('stream keys: End and Home wait while the grid is hidden or a legacy modal is over it (the setup guide scrolls with them)', () => {
  const { p, st, calls } = gridPage();
  const end = () => ({ key: 'End', code: 'End', preventDefault() {} });
  st.gridShown = false;   // the device cards, the dropzone or the loading view; or #setupModal / #stallModal open
  assert.equal(p.keys.dispatch(end(), p.doc.body), null, 'the key stays the page\'s: no preventDefault, no jump');
  assert.equal(press(p, p.doc.body, 'Home'), null);
  assert.equal(press(p, null, 'ArrowDown', { metaKey: true }), null);
  assert.deepEqual(calls, []);
  st.gridShown = true;
  assert.equal(p.keys.dispatch(end(), p.doc.body), 'stream.latest');
  assert.deepEqual(calls.map(c => c[0]), ['jumpToEnd']);
});

test('stream keys: Space pauses and F toggles Follow only with the grid focused, on the live session, and not with single keys off', () => {
  const { p, st, calls } = gridPage();
  const t = p.byId.logTableEl;
  assert.equal(press(p, t, ' ', { code: 'Space' }), 'stream.pause');
  assert.equal(press(p, t, 'f', { code: 'KeyF' }), 'stream.follow');
  assert.equal(press(p, p.byId.clearBtn, ' ', { code: 'Space' }), null, 'outside the grid Space is the focused control\'s');
  assert.equal(press(p, p.byId.filterbar, 'f', { code: 'KeyF' }), null, 'a single key never fires outside the grid (WCAG 2.1.4)');
  st.cur = { kind: 'file', all: [], filtered: [] };
  assert.equal(press(p, t, ' ', { code: 'Space' }), null, 'a file session has nothing to pause: Space scrolls');
  assert.equal(press(p, t, 'f', { code: 'KeyF' }), null);
  st.cur = { kind: 'live', all: [], filtered: [] };
  p.keys.setSingleKeys(false);
  assert.equal(press(p, t, ' ', { code: 'Space' }), null, 'single keys can be switched off (Settings → Shortcuts, P14)');
  assert.deepEqual(calls.map(c => c[0]), ['togglePause', 'toggleAutoScroll']);
});

test('stream keys: Pause and Follow carry aria-keyshortcuts and show their key in the toolbar kbd', () => {
  const { p } = gridPage();
  assert.deepEqual([p.byId.pauseBtn.getAttribute('aria-keyshortcuts'), p.byId.pauseKbd.textContent], ['Space', 'Space']);
  assert.deepEqual([p.byId.autoScrollBtn.getAttribute('aria-keyshortcuts'), p.byId.followKbd.textContent], ['End Meta+ArrowDown', 'End']);
  assert.equal(p.keys.label('stream.follow'), 'F');
});

// ---- Empty states (P5b) ----
test('empty tile: written only when it changes, announced only when its cause does; the fix and Reset filter call resetFilter', () => {
  const { p, grid, st, calls } = gridPage();
  const $ = id => p.byId[id];
  grid.syncEmpty();
  assert.equal($('gridEmpty').hidden, true, 'nothing to say: hidden');
  st.cur = { kind: 'live', all: new Array(500), filtered: [] };
  st.levels = 0;
  grid.syncEmpty();
  assert.deepEqual([$('gridEmpty').hidden, $('gridEmptyTitle').textContent, $('gridEmptyDesc').textContent, $('gridEmptyFix').textContent, $('gridEmptyFix').hidden, $('gridEmptyReset').hidden],
    [false, 'No lines match this filter', '0 of 500 lines in view. All levels are turned off.', 'Turn levels back on', false, false]);
  assert.deepEqual([$('gridEmptyUse').getAttribute('href'), $('gridEmptyIcon').getAttribute('class'), $('gridEmptySkel').hidden], ['#i-search-x', 'icon', true]);
  p.advance(6000);
  assert.equal($('announcer').textContent, 'No lines match this filter. All levels are turned off.');
  $('gridEmptyFix').click();
  $('gridEmptyReset').click();
  assert.deepEqual(calls.filter(c => c[0] === 'resetFilter'), [['resetFilter', 'levels'], ['resetFilter', 'all']]);
  let writes = 0;
  const title = $('gridEmptyTitle');
  const desc = Object.getOwnPropertyDescriptor(title, 'textContent');
  Object.defineProperty(title, 'textContent', { get: () => desc.value, set: x => { writes++; desc.value = x; } });
  for (let i = 0; i < 5; i++) grid.syncEmpty();
  assert.equal(writes, 0, 'unchanged: no write (it runs once per flush)');
  st.cur = { kind: 'live', all: [], filtered: [] };
  st.levels = 6;
  st.live = { android: false, ios: true };
  grid.syncEmpty();
  assert.deepEqual([$('gridEmptyTitle').textContent, $('gridEmptyDesc').hidden, $('gridEmptySkel').hidden, $('gridEmptyIcon').getAttribute('class'), $('gridEmptyFix').hidden, $('gridEmptyReset').hidden],
    ['Waiting for the first lines from iPhone 15…', true, false, 'icon spin', true, true]);
  st.noDevice = { android: false, ios: true };   // #70: the bridge reported the phone gone, the socket stays open
  grid.syncEmpty();
  assert.deepEqual([$('gridEmptyTitle').textContent, $('gridEmptyDesc').textContent, $('gridEmptyDesc').hidden, $('gridEmptySkel').hidden, $('gridEmptyUse').getAttribute('href'), $('gridEmptyIcon').getAttribute('class')],
    ['iPhone 15 was unplugged', 'Plug it back in to continue.', false, true, '#i-unplug', 'icon'], 'not "Waiting for the first lines": the sidebar row reads Disconnected');
  st.noDevice = { android: false, ios: false };
  st.cur = { kind: 'live', all: [1], filtered: [1] };
  grid.syncEmpty();
  assert.equal($('gridEmpty').hidden, true, 'the first line hides it');
});

test('empty tile: a stale session (its filtered list lags the filter) shows no tile and says nothing', () => {
  const { p, grid, st } = gridPage();
  st.cur = { kind: 'file', all: new Array(4), filtered: [] };
  st.stale = true;
  grid.syncEmpty();
  p.advance(6000);
  assert.deepEqual([p.byId.gridEmpty.hidden, p.byId.announcer.textContent || ''], [true, ''], 'stale: not a no-match state');
  st.stale = false;                       // the render refiltered it and nothing matches: now it is true
  grid.syncEmpty();
  assert.equal(p.byId.gridEmpty.hidden, false);
  assert.equal(p.byId.gridEmptyTitle.textContent, 'No lines match this filter');
  assert.match(p.byId.announcer.textContent, /^No lines match this filter/);
});

test('empty tile: focus moves off a button the tile hides (Reset filter, or the fix) onto the control that takes over', () => {
  const { p, grid, st } = gridPage();
  const $ = id => p.byId[id];
  st.cur = { kind: 'live', all: new Array(500), filtered: [] };
  st.levels = 0;
  grid.syncEmpty();                       // fix: Turn levels back on, plus Reset filter
  p.focus($('gridEmptyReset'));
  st.cur = { kind: 'live', all: new Array(500), filtered: [1] };
  grid.syncEmpty();                       // lines match: the whole tile goes
  assert.deepEqual([$('gridEmpty').hidden, p.doc.activeElement], [true, $('logTableEl')], 'Reset filter pressed: focus on the grid');
  st.cur = { kind: 'live', all: new Array(500), filtered: [] };
  st.levels = 0;
  grid.syncEmpty();
  p.focus($('gridEmptyFix'));
  st.levels = 6; st.query = true;         // the fix is no longer offered, Reset filter stays
  grid.syncEmpty();
  assert.deepEqual([$('gridEmpty').hidden, $('gridEmptyFix').hidden, p.doc.activeElement], [false, true, $('gridEmptyReset')], 'the fix goes: focus on Reset filter');
  st.query = false; st.levels = 0;
  grid.syncEmpty();
  p.focus($('gridEmptyFix'));
  st.cur = { kind: 'live', all: new Array(500), filtered: [1] };
  grid.syncEmpty();
  assert.equal(p.doc.activeElement, $('logTableEl'), 'the fix pressed and lines now match: focus on the grid');
  st.cur = { kind: 'live', all: new Array(500), filtered: [] };
  st.levels = 0;
  grid.syncEmpty();
  p.focus($('logTableEl'));
  st.cur = { kind: 'live', all: new Array(500), filtered: [1] };
  grid.syncEmpty();
  assert.equal(p.doc.activeElement, $('logTableEl'), 'focus elsewhere is not moved');
  p.focus($('search'));
  st.cur = { kind: 'live', all: new Array(500), filtered: [] };
  grid.syncEmpty();
  st.cur = { kind: 'live', all: new Array(500), filtered: [1] };
  grid.syncEmpty();
  assert.equal(p.doc.activeElement, $('search'), 'a focused control outside the tile keeps focus');
});

// ---- Arrival highlight (P5b) ----
test('arrival: screenRows follows the scroller\'s height, the log size and the density; animationend and clearArrival drop is-new', () => {
  const { p, grid, prefs, resize, observed } = gridPage();
  assert.equal(observed().el, p.byId.logTable, 'the scroller is observed');
  assert.equal(grid.screenRows, 0, 'no height yet: nothing is highlighted');
  resize(500);
  assert.equal(grid.screenRows, 25);
  prefs.set('logFontSize', 20);
  assert.equal(grid.screenRows, 16);
  prefs.patchSettings({ density: 'compact' });
  assert.equal(grid.screenRows, 18);
  const tr = p.doc.createElement('tr');
  tr.className = 'l-i p-a is-new';
  p.byId.tbody.appendChild(tr);
  tr.fire('animationend', { animationName: 'other' });
  assert.equal(tr.className, 'l-i p-a is-new', 'another animation leaves it');
  tr.fire('animationend', { animationName: 'row-in' });
  assert.equal(tr.className, 'l-i p-a', 'the highlight ran: the class goes, so a re-attached tbody does not replay it');
  const lit = { classList: { remove: c => { lit.gone = c; } } };
  grid.clearArrival({ querySelectorAll: sel => (assert.equal(sel, 'tr.is-new'), [lit]) });
  assert.equal(lit.gone, 'is-new');
});
