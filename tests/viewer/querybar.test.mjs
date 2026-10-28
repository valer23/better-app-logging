// The query region (viewer/assets/js/querybar.js, roadmap P6b) on the fake page with the page's #filterbar mounted: the
// bar applies typing after 100 ms and everything else at once, keeps the last valid filter on an invalid query and says
// why in the alert line, the chips read their pressed state back from the applied query and rewrite it, and the numbers
// are written on a 250 ms interval, diffed. setQuery is the real compile (ALV.query.build) on a fake page state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageScriptSrcs } from './_load.mjs';
import { fakePage, mount, texts } from './_fake.mjs';

const T = ' ';
function barPage() {
  const p = fakePage({ files: ['dom.js', 'keys.js', 'ui.js', 'shell.js', 'live.js', 'query.js', 'querybar.js'] });
  mount(p, 'filterbar');
  const $ = id => p.byId[id];
  $('queryInput').value = '';
  const Q = p.ALV.query;
  const devices = { android: { id: 'R5CT', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } };
  const st = { cur: { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: [] }, filter: Q.build('', {}, devices).q, devices, tag: '' };
  const calls = [];
  const ticks = [];
  const shell = { onTick: fn => ticks.push(fn), devices: () => ({ android: { name: 'Pixel 8 Pro' }, ios: { name: '' } }) };
  let bar = null;
  const actions = {
    setQuery(text, opts) {
      calls.push(['setQuery', text, { ...opts }]);
      const r = Q.build(text, opts, devices);
      if (r.error) return r.error;
      if (r.q.key !== st.filter.key) st.filter = r.q;
      return null;
    },
    sync() { calls.push(['sync']); bar.sync(); },
  };
  bar = p.ALV.createQueryBar({ doc: p.doc, win: p.win, dom: p.dom, ui: p.ui, keys: p.keys, shell, state: () => st, actions });
  const type = text => { $('queryInput').value = text; $('queryInput').fire('input'); };
  const pressed = group => $(group).children.map(b => b.getAttribute('aria-pressed') === 'true');
  return { p, $, st, calls, bar, type, pressed, ticks, Q };
}

test('querybar.js loads after grid.js; it builds six level chips (badge, name, count) and a chip per platform, all pressed', () => {
  const srcs = pageScriptSrcs();
  assert.equal(srcs.indexOf('assets/js/querybar.js'), srcs.indexOf('assets/js/grid.js') + 1);
  const { $, pressed } = barPage();
  const lv = $('levelChips').children;
  assert.deepEqual(lv.map(b => b.className), ['chip lv-v', 'chip lv-d', 'chip lv-i', 'chip lv-w', 'chip lv-e', 'chip lv-f']);
  assert.deepEqual(lv[0].children.map(c => [c.className, texts(c)]), [['lv-badge lv-v', 'V'], ['lv-name', 'Verbose'], ['count', '0']]);
  assert.deepEqual(lv.map(b => b.getAttribute('aria-label')), ['Verbose, 0 lines', 'Debug, 0 lines', 'Info, 0 lines', 'Warning, 0 lines', 'Error, 0 lines', 'Fatal, 0 lines']);
  assert.deepEqual([...pressed('levelChips'), ...pressed('deviceChips')], Array(8).fill(true));
  assert.deepEqual($('deviceChips').children.map(texts), ['APixel 8 Pro', 'iiPhone'], 'the badge and the name; "iPhone" while no iPhone is known');
  assert.deepEqual([$('queryClearBtn').hidden, $('queryResetBtn').hidden, $('queryError').hidden, $('queryKbd').hidden], [true, true, true, true]);
});

test('typing applies after 100 ms of quiet, once; Aa and .* apply at once and read back pressed', () => {
  const { p, $, calls, type } = barPage();
  type('ti');
  p.advance(60);
  type('tim');
  p.advance(99);
  assert.equal(calls.filter(c => c[0] === 'setQuery').length, 0, 'still typing');
  assert.equal($('queryClearBtn').hidden, false, 'Clear filter shows with the first character');
  p.advance(1);
  assert.deepEqual(calls.filter(c => c[0] === 'setQuery'), [['setQuery', 'tim', { case: false, regex: false }]]);
  $('queryCaseBtn').click();
  $('queryRegexBtn').click();
  assert.deepEqual(calls.filter(c => c[0] === 'setQuery').slice(1), [['setQuery', 'tim', { case: true, regex: false }], ['setQuery', 'tim', { case: true, regex: true }]]);
  assert.deepEqual([$('queryCaseBtn').getAttribute('aria-pressed'), $('queryRegexBtn').getAttribute('aria-pressed')], ['true', 'true']);
});

test('an invalid query: the box turns red, the field aria-invalid, the alert line says why; the last valid filter stays', () => {
  const { p, $, st, type } = barPage();
  type('level:W+');
  p.advance(100);
  const valid = st.filter;
  type('level:W+ tg:x');
  p.advance(100);
  assert.equal(st.filter, valid, 'the last valid filter is still applied');
  assert.deepEqual([$('queryBox').className, $('queryInput').getAttribute('aria-invalid'), $('queryError').hidden, $('queryErrorText').textContent],
    ['query invalid', 'true', false, "Unknown field 'tg'. Did you mean tag:?"]);
  type('/time(/');
  p.advance(100);
  assert.equal($('queryErrorText').textContent, 'Invalid regex: Unterminated group. The last valid filter is still applied.');
  type('level:W+ tag:x');
  p.advance(100);
  assert.deepEqual([$('queryBox').className, $('queryInput').getAttribute('aria-invalid'), $('queryError').hidden, $('queryErrorText').textContent], ['query', null, true, '']);
});

test('level chips write one level token and read their pressed state back; device chips write dev:; both apply at once', () => {
  const { p, $, st, type, pressed, calls } = barPage();
  type('tag:x');                                // not applied yet: the chip rewrites the text in the field
  $('levelChips').children[0].click();
  assert.equal($('queryInput').value, 'level:D+ tag:x');
  assert.deepEqual(pressed('levelChips'), [false, true, true, true, true, true]);
  $('levelChips').children[2].click();
  assert.equal($('queryInput').value, 'level:D,W,E,F tag:x');
  $('levelChips').children[2].click();
  $('levelChips').children[0].click();
  assert.equal($('queryInput').value, 'tag:x', 'all six on: no level token');
  $('deviceChips').children[1].click();
  assert.equal($('queryInput').value, 'dev:android tag:x');
  assert.deepEqual(pressed('deviceChips'), [true, false]);
  $('deviceChips').children[0].click();
  assert.equal($('queryInput').value, 'dev:none tag:x');
  assert.equal(st.filter.plats, 0);
  assert.ok(calls.at(-1)[0] === 'sync', 'the sidebar rows and the status bar sync after each change');
  // An invalid edit in the bar is dropped: a chip rewrites the last applied text, so it always applies.
  type('tg:x');
  p.advance(100);
  $('levelChips').children[0].click();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, st.filter.levels, st.filter.plats], ['level:D+ dev:none tag:x', true, 62, 0]);
  type('tg:x');
  p.advance(100);
  $('deviceChips').children[1].click();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, st.filter.levels, st.filter.plats], ['level:D+ dev:ios tag:x', true, 62, 2]);
});

test('a dev: name resolves against the devices known now: when they change, the filter follows on the next sync', () => {
  const { p, st, bar, type } = barPage();
  type('dev:pixel');
  p.advance(100);
  assert.equal(st.filter.plats, 1, 'the Pixel is the Android device');
  st.devices.android = { id: 'R9XY', name: 'Galaxy S24' };   // the Pixel unplugged, a Galaxy in its place
  bar.sync();
  assert.equal(st.filter.plats, 0, 'dev:pixel names no device now: nothing shows');
  const key = st.filter.key;
  bar.sync();
  assert.equal(st.filter.key, key, 'devices unchanged: the same filter');
});

test('Clear filter and Reset show only with text; each empties the query, applies it, and leaves focus in the field', () => {
  const { p, $, st, type } = barPage();
  for (const id of ['queryClearBtn', 'queryResetBtn']) {
    type('level:E');
    p.advance(100);
    assert.deepEqual([$('queryClearBtn').hidden, $('queryResetBtn').hidden, st.filter.levels], [false, false, 16]);
    p.focus($(id));
    $(id).click();
    assert.deepEqual([$('queryInput').value, st.filter.levels, $('queryClearBtn').hidden, $('queryResetBtn').hidden, p.doc.activeElement], ['', 63, true, true, $('queryInput')], id);
  }
});

test('numbers: chip counts and "N of M lines" on the 250 ms interval, written only when changed, never while hidden; a focused chip keeps its name', () => {
  const { p, $, st, ticks } = barPage();
  let writes = 0;
  const count = $('filterCount');
  let text = count.textContent;
  Object.defineProperty(count, 'textContent', { get: () => text, set(v) { writes++; text = v; } });
  st.cur = { counts: { lvl: [12950, 0, 1, 0, 0, 0] }, filtered: new Array(13), all: new Array(48310) };
  p.advance(249);
  assert.equal(writes, 0, 'not before the interval');
  p.advance(1);
  assert.equal(text, `13 of 48${T}310 lines`);
  assert.deepEqual($('levelChips').children.map(b => b.getAttribute('aria-label')).slice(0, 3), [`Verbose, 12${T}950 lines`, 'Debug, 0 lines', 'Info, 1 line']);
  assert.equal(texts($('levelChips').children[0].children[2]), `12${T}950`);
  p.advance(1000);
  assert.equal(writes, 1, 'unchanged: no write');
  st.cur.filtered = new Array(14);
  for (const fn of ticks) fn();
  assert.equal(writes, 1, 'the shell\'s 500 ms tick writes no number: the interval alone does');
  p.advance(250);
  assert.equal(writes, 2);
  p.focus($('levelChips').children[0]);
  st.cur.counts.lvl[0] = 7;
  p.doc.hidden = true;
  p.advance(250);
  assert.equal(texts($('levelChips').children[0].children[2]), `12${T}950`, 'nothing while the window is hidden');
  p.doc.hidden = false;
  p.advance(250);
  assert.equal(texts($('levelChips').children[0].children[2]), '7');
  assert.equal($('levelChips').children[0].getAttribute('aria-label'), `Verbose, 12${T}950 lines`, 'not re-announced while focused');
  $('levelChips').children[0].fire('focus');
  assert.equal($('levelChips').children[0].getAttribute('aria-label'), 'Verbose, 7 lines', 'refreshed when it gets focus');
});

test('numbers: while the shown session is stale (a file before its first refilter) its counts are unknown: nothing is written, not 0', () => {
  const { p, $, st } = barPage();
  const count = () => texts($('levelChips').children[0].children[2]);
  st.cur = { counts: { lvl: [5, 0, 0, 0, 0, 0] }, filtered: new Array(5), all: new Array(5) };
  p.advance(250);
  assert.deepEqual([count(), $('filterCount').textContent], ['5', '5 of 5 lines']);
  st.cur = { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: new Array(9) };
  st.stale = true;
  p.advance(250);
  $('levelChips').children[0].fire('focus');
  assert.deepEqual([count(), $('filterCount').textContent, $('levelChips').children[0].getAttribute('aria-label')], ['5', '5 of 5 lines', 'Verbose, 5 lines'], 'kept until the refilter');
  st.stale = false;
  st.cur.counts.lvl[0] = 9;
  st.cur.filtered = new Array(9);
  p.advance(250);
  assert.deepEqual([count(), $('filterCount').textContent], ['9', '9 of 9 lines']);
});

test('a filter change announces the result count (at most once per 5 s); an unchanged or invalid query announces nothing', () => {
  const { p, $, st, type } = barPage();
  st.cur = { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: new Array(5), all: new Array(9) };
  type('a');
  p.advance(100);
  assert.equal($('announcer').textContent, '5 of 9 lines');
  $('announcer').textContent = '';
  type('a ');
  p.advance(6000);
  type('tg:x');
  p.advance(6000);
  assert.equal($('announcer').textContent, '', 'the same filter, then an invalid one');
});
