// The query region (viewer/assets/js/querybar.js, roadmap P6b) on the fake page with the page's #filterbar mounted: the
// bar applies typing after 100 ms and everything else at once, keeps the last valid filter on an invalid query and says
// why in the alert line, the chips read their pressed state back from the applied query and rewrite it, and the numbers
// are written on a 250 ms interval, diffed. setQuery is the real compile (ALV.query.build) on a fake page state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageScriptSrcs } from './_load.mjs';
import { fakePage, mount, texts } from './_fake.mjs';

const T = ' ';
// refuse: a text the fake setQuery refuses as the page's regex guard would (it compiles, but is "too slow"), or a function
// (text, opts) → boolean for a guard that looks at the modes too (the page's slowRegex only runs under regex mode).
function barPage({ refuse = null } = {}) {
  const p = fakePage({ files: ['dom.js', 'keys.js', 'ui.js', 'shell.js', 'live.js', 'query.js', 'querybar.js'] });
  mount(p, 'filterbar');
  p.byId.ovPopovers.appendChild(mount(p, 'tokenPop'));   // the "N filters" popover, in the popover layer as on the page
  const $ = id => p.byId[id];
  $('queryInput').value = '';
  const Q = p.ALV.query;
  const devices = { android: { id: 'R5CT', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } };
  const NO = Object.freeze({ case: false, regex: false });
  const session = name => { const f = Q.build('', NO, devices).q; return { name, counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: [], filter: f, query: f, queryText: '', queryOpts: NO }; };
  const live = session('live'), file = session('file');
  const st = { cur: live, get filter() { return st.cur.filter; }, get stale() { return st.cur.query !== st.cur.filter; }, devices, tag: '' };
  const calls = [];
  const ticks = [];
  const shell = { onTick: fn => ticks.push(fn), devices: () => ({ android: { name: 'Pixel 8 Pro' }, ios: { name: '' } }) };
  let bar = null;
  const actions = {
    setQuery(text, opts) {
      calls.push(['setQuery', text, { ...opts }]);
      if (typeof refuse === 'function' ? refuse(text, opts) : text === refuse) return { start: 0, end: text.length, msg: 'Invalid regex: It would take about 99 ms on one of these lines and can freeze the viewer. The last valid filter is still applied.' };
      const s = st.cur, o = Object.freeze({ case: !!opts.case, regex: !!opts.regex });
      const r = Q.build(text, o, devices);
      if (r.error) return r.error;
      if (r.q.key !== s.filter.key) s.filter = s.query = r.q;
      s.queryText = text; s.queryOpts = o;
      return null;
    },
    recompile() { calls.push(['recompile']); },
    sync() { calls.push(['sync']); bar.sync(); },
  };
  bar = p.ALV.createQueryBar({ doc: p.doc, win: p.win, dom: p.dom, ui: p.ui, keys: p.keys, shell, state: () => st, actions });
  const type = text => { $('queryInput').value = text; $('queryInput').fire('input'); };
  const pressed = group => $(group).children.map(b => b.getAttribute('aria-pressed') === 'true');
  return { p, $, st, calls, bar, type, pressed, ticks, Q, live, file };
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
  assert.deepEqual([$('queryClearBtn').hidden, $('queryResetBtn').hidden, $('queryError').hidden, $('queryKbd').hidden], [true, true, true, false], 'the ⌘F hint: unfocused and empty');
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
  // P7a: each sync also asks the page to recompile dev: names (syncChips → actions.recompile), after the 'sync' entry.
  assert.equal(calls.filter(c => c[0] !== 'recompile').at(-1)[0], 'sync', 'the sidebar rows and the status bar sync after each change');
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

test('a dev: name resolves against the devices known now: a sync asks the page to recompile (every session), never setQuery', () => {
  const { p, st, bar, type, calls } = barPage();
  type('dev:pixel');
  p.advance(100);
  assert.equal(st.filter.plats, 1, 'the Pixel is the Android device');
  calls.length = 0;
  st.devices.android = { id: 'R9XY', name: 'Galaxy S24' };   // the Pixel unplugged, a Galaxy in its place
  bar.sync();
  assert.deepEqual(calls.filter(c => c[0] === 'recompile' || c[0] === 'setQuery').map(c => c[0]), ['recompile'],
    'the page recompiles every session (recompileDevNames); query-page covers what that does');
});

test('the last valid filter keeps the modes it compiled under: toggling Aa or .* while the text is invalid, then a sync, leaves it alone', () => {
  const { p, $, st, bar, type, ticks } = barPage();
  type('dev:pixel a.b');
  p.advance(100);
  const valid = st.filter;
  assert.equal(valid.usesDevNames, true);
  type('dev:pixel a.b tg:x');
  p.advance(100);
  $('queryRegexBtn').click();
  $('queryCaseBtn').click();
  assert.equal($('queryError').hidden, false, 'still invalid');
  st.devices.android = { id: 'R5CT', name: 'Pixel 9' };   // the devices change: dev:pixel still names the Android device
  bar.sync();
  for (const t of ticks) t();
  assert.equal(st.filter.key, valid.key, 'the filter keeps its literal, case-insensitive semantics');
  assert.equal($('queryErrorText').textContent.length > 0 && $('queryError').hidden, false, 'the alert still says the last valid filter is applied');
  // A chip click applies explicitly, under the modes now on.
  $('levelChips').children[0].click();
  assert.equal($('queryInput').value, 'level:D+ dev:pixel a.b');
  assert.equal($('queryError').hidden, true);
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
  // P7a: st.cur is a session (filter, query, queryText, queryOpts): change its numbers, not the object.
  Object.assign(st.cur, { counts: { lvl: [12950, 0, 1, 0, 0, 0] }, filtered: new Array(13), all: new Array(48310) });
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
  Object.assign(st.cur, { counts: { lvl: [5, 0, 0, 0, 0, 0] }, filtered: new Array(5), all: new Array(5) });
  p.advance(250);
  assert.deepEqual([count(), $('filterCount').textContent], ['5', '5 of 5 lines']);
  // P7a: stale is a getter (cur.query !== cur.filter); a file before its first refilter has query null, as on the page.
  Object.assign(st.cur, { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: new Array(9), query: null });
  p.advance(250);
  $('levelChips').children[0].fire('focus');
  assert.deepEqual([count(), $('filterCount').textContent, $('levelChips').children[0].getAttribute('aria-label')], ['5', '5 of 5 lines', 'Verbose, 5 lines'], 'kept until the refilter');
  st.cur.query = st.cur.filter;   // refiltered: no longer stale
  st.cur.counts.lvl[0] = 9;
  st.cur.filtered = new Array(9);
  p.advance(250);
  assert.deepEqual([count(), $('filterCount').textContent], ['9', '9 of 9 lines']);
});

test('a filter change announces the result count (at most once per 5 s); an unchanged or invalid query announces nothing', () => {
  const { p, $, st, type } = barPage();
  Object.assign(st.cur, { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: new Array(5), all: new Array(9) });   // P7a: st.cur is a session
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

test('one token is a chip (NOT, key, value, a 24 px × "Remove filter NOT tag:chatty"); two or more collapse into "N filters" and its popover', () => {
  const { p, $, type } = barPage();
  type('level:W+ -tag:chatty');
  p.advance(100);
  const one = $('tokenOne').children;
  assert.deepEqual([$('tokenChips').hidden, $('tokenDiv').hidden, $('tokenMore').hidden, one.length], [false, false, true, 1]);
  assert.equal(one[0].className, 'chip token neg', 'a negation: NOT and a dashed border');
  const [body, x] = one[0].children;
  assert.deepEqual(body.children.map(c => [c.className, texts(c)]), [['not', 'NOT'], ['k', 'tag:'], ['v', 'chatty']]);
  assert.deepEqual([x.className, x.getAttribute('aria-label')], ['chip-x', 'Remove filter NOT tag:chatty']);
  assert.equal(body.getAttribute('title'), 'NOT tag:chatty', 'the full token stays available when its value is cut short');
  type('level:W+ -tag:chatty "time out" /a b/ pid:7');
  p.advance(100);
  assert.deepEqual([$('tokenOne').children.length, $('tokenMore').hidden, texts($('tokenMoreText'))], [0, false, '4 filters']);
  assert.deepEqual($('tokenList').children.map(c => c.children[1].getAttribute('aria-label')),
    ['Remove filter NOT tag:chatty', 'Remove filter "time out"', 'Remove filter /a b/', 'Remove filter pid:7']);
  $('tokenMore').click();
  assert.equal($('tokenMore').getAttribute('aria-expanded'), 'true', 'the popover opens');
  type('');
  p.advance(100);
  assert.deepEqual([$('tokenChips').hidden, $('tokenDiv').hidden, $('tokenMore').getAttribute('aria-expanded')], [true, true, 'false'], 'no token: no chip, the popover closed');
});

test('a chip\'s × removes its token from the field and applies; its body puts the caret at the end of its token (Open item 6)', () => {
  const { p, $, st, type } = barPage();
  let sel = null;
  $('queryInput').setSelectionRange = (a, b) => { sel = [a, b]; };
  type('tag:a  -tag:"b c"  word');
  p.advance(100);
  $('tokenList').children[1].children[0].click();
  assert.deepEqual([p.doc.activeElement, sel], [$('queryInput'), [17, 17]], 'after -tag:"b c"');
  $('tokenList').children[1].children[1].click();
  assert.equal($('queryInput').value, 'tag:a  word');
  assert.equal(st.filter.tags.length, 1, 'applied at once');
  assert.equal(p.doc.activeElement, $('queryInput'), 'the chip is gone: focus in the field');
  type('tag:a  word x');            // typed, not applied yet: a chip's × finds its token in the text as it is now
  $('tokenList').children[0].children[1].click();
  assert.equal($('queryInput').value, 'word x');
  type('tag:a tag:b');              // an invalid edit never blocks a chip (must-keep 3): its × works on base(), the last applied text
  p.advance(100);
  type('tag:a tag:b tg:x');
  p.advance(100);
  $('tokenList').children[0].children[1].click();
  assert.deepEqual([$('queryInput').value, st.filter.tags.length, $('queryError').hidden], ['tag:b', 1, true], 'the invalid edit is dropped, the chip goes');
});

test('token chips are text only (XSS): markup in a value stays a Text node', () => {
  const { p, $, type } = barPage();
  type('tag:<img/src=x/onerror=alert(1)>');
  p.advance(100);
  const v = $('tokenOne').children[0].children[0].children.find(c => c.className === 'v');
  assert.equal(texts(v), '<img/src=x/onerror=alert(1)>');
  assert.equal(v.children.length, 0, 'no element was parsed out of it');
});

test('⇧⌘F keeps focus out of <body>: from a control the reset hides or removes it lands in the field; from outside the region it is left alone', () => {
  const ev = o => ({ preventDefault() {}, ...o });
  const reset = { key: 'f', code: 'KeyF', metaKey: true, shiftKey: true };
  const from = (pick) => {
    const { p, $, st, type } = barPage();
    type('tag:a "b c"');
    p.advance(100);
    const el = pick($);
    p.focus(el);
    assert.equal(p.keys.dispatch(ev(reset), el), 'filter.reset');
    assert.equal($('queryInput').value, '');
    assert.equal(st.filter.levels, 63);
    return [p, $];
  };
  for (const [name, pick] of [
    ['Reset', $ => $('queryResetBtn')],
    ['Clear filter', $ => $('queryClearBtn')],
    ['"N filters"', $ => $('tokenMore')],
    ['a chip in the popover', $ => $('tokenList').children[0].children[1]],
  ]) { const [p, $] = from(pick); assert.equal(p.doc.activeElement, $('queryInput'), name); }
  { // a single token chip's body and ×
    for (const i of [0, 1]) {
      const { p, $, type } = barPage();
      type('tag:a');
      p.advance(100);
      const el = $('tokenOne').children[0].children[i];
      p.focus(el);
      p.keys.dispatch(ev(reset), el);
      assert.equal(p.doc.activeElement, $('queryInput'), `single chip ${i ? '×' : 'body'}`);
    }
  }
  const { p, $, type } = barPage();
  type('tag:a');
  p.advance(100);
  const other = p.doc.createElement('input');
  other.setAttribute('type', 'text');
  p.focus(other);
  p.keys.dispatch(ev(reset), other);
  assert.equal(p.doc.activeElement, other, 'focus outside the region stays where it was');
  assert.equal($('queryInput').value, '');
});

test('keys: ⌘F (a text field too) and / (the grid) focus the bar and select it; ⇧⌘F resets; ⌥C, ⌥R, ⌥V…⌥F toggle; the ⌘F hint', () => {
  const { p, $, st, type, pressed } = barPage();
  const grid = p.doc.createElement('div');
  p.keys.setGridRoot(grid);
  let selected = 0;
  $('queryInput').select = () => { selected++; };
  const ev = o => ({ preventDefault() {}, ...o });
  const other = p.doc.createElement('input');
  other.setAttribute('type', 'text');
  assert.equal(p.keys.dispatch(ev({ key: 'f', code: 'KeyF', metaKey: true }), other), 'filter.focus', '⌘F from another field');
  assert.deepEqual([p.doc.activeElement, selected], [$('queryInput'), 1]);
  assert.equal(p.keys.dispatch(ev({ key: '/', code: 'Slash' }), grid), 'filter.slash');
  assert.equal(p.keys.dispatch(ev({ key: '/', code: 'Slash' }), other), null, '/ types in a field');
  assert.equal(p.keys.dispatch(ev({ key: 'ç', code: 'KeyC', altKey: true }), grid), 'filter.case', 'macOS Option+C types ç: matched on the physical key');
  assert.equal(p.keys.dispatch(ev({ key: '®', code: 'KeyR', altKey: true }), grid), 'filter.regex');
  assert.deepEqual([$('queryCaseBtn').getAttribute('aria-pressed'), $('queryRegexBtn').getAttribute('aria-pressed')], ['true', 'true']);
  assert.equal(p.keys.dispatch(ev({ key: '√', code: 'KeyV', altKey: true }), grid), 'filter.level.V');
  assert.equal(p.keys.dispatch(ev({ key: 'ƒ', code: 'KeyF', altKey: true }), grid), 'filter.level.F');
  assert.deepEqual(pressed('levelChips'), [false, true, true, true, true, false]);
  assert.equal(p.keys.dispatch(ev({ key: 'ç', code: 'KeyC', altKey: true }), $('queryInput')), null, 'in the field Option types: the Aa button and its tooltip remain');
  type('tag:x');
  assert.equal(p.keys.dispatch(ev({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true }), $('queryInput')), 'filter.reset');
  assert.deepEqual([$('queryInput').value, st.filter.levels], ['', 63]);
  assert.deepEqual([$('queryInput').getAttribute('aria-keyshortcuts'), $('queryCaseBtn').getAttribute('aria-keyshortcuts'), $('levelChips').children[3].getAttribute('aria-keyshortcuts')],
    ['Meta+F /', 'Alt+C', 'Alt+W']);
  p.focus(other);
  $('queryInput').fire('blur');
  assert.deepEqual([$('queryKbd').hidden, texts($('queryKbd'))], [false, '⌘F'], 'unfocused and empty: the hint shows');
  p.focus($('queryInput'));
  $('queryInput').fire('focus');
  assert.equal($('queryKbd').hidden, true);
});

test('the empty tile\'s fixes rewrite the query: levels, devices, the named tag, the named NOT tag, and Reset filter', () => {
  const { p, $, st, bar, type } = barPage();
  type('level:none dev:ios tag:bt -tag:chatty x');
  st.tag = 'bt';
  st.notTag = 'chatty';
  const steps = ['levels', 'devices', 'notTag', 'tag'].map(what => { bar.fix(what); return $('queryInput').value; });
  assert.deepEqual(steps, ['dev:ios tag:bt -tag:chatty x', 'tag:bt -tag:chatty x', 'tag:bt x', 'x']);
  bar.fix('all');
  assert.deepEqual([$('queryInput').value, st.filter.levels, st.filter.plats], ['', 63, 3]);
  // An invalid edit in the bar is dropped: a fix rewrites the last applied text, so "Turn levels back on" and
  // "Remove tag:bt" always apply.
  type('level:none tag:bt');
  p.advance(100);
  type('level:none tag:bt tg:x');
  p.advance(100);
  bar.fix('levels');
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, st.filter.levels], ['tag:bt', true, 63]);
  type('tag:bt tg:x');
  p.advance(100);
  bar.fix('tag');
  assert.deepEqual([$('queryInput').value, $('queryError').hidden], ['', true]);
});

test('a chip, a device chip, a token × and a tile fix apply the text they rewrite under the modes it was applied under, even when .* was turned on over it (F1)', () => {
  const { p, $, st, bar, type, pressed } = barPage();
  // `a(` is a fine literal; .* makes it an unterminated group, so the toggle fails and the literal filter stays.
  const turnOnRegex = text => {
    type(text);
    p.advance(100);
    $('queryRegexBtn').click();
    assert.equal($('queryError').hidden, false, `${text}: the regex toggle is refused`);
    assert.equal(st.filter.levels, 63);
  };
  turnOnRegex('a(');
  $('levelChips').children[0].click();
  assert.deepEqual([$('queryInput').value, st.filter.levels, $('queryError').hidden, $('queryRegexBtn').getAttribute('aria-pressed')], ['level:D+ a(', 62, true, 'false'],
    'the level chip works; the refused toggle is dropped with the invalid edit');
  $('queryRegexBtn').click();
  assert.equal($('queryError').hidden, false);
  $('deviceChips').children[1].click();
  assert.deepEqual([$('queryInput').value, st.filter.plats, $('queryError').hidden], ['dev:android level:D+ a(', 1, true]);
  $('queryRegexBtn').click();
  bar.fix('levels');
  assert.deepEqual([$('queryInput').value, st.filter.levels, $('queryError').hidden], ['dev:android a(', 63, true], 'the tile\'s fix');
  bar.fix('devices');
  assert.deepEqual([$('queryInput').value, st.filter.plats], ['a(', 3]);
  // The nested-quantifier refusal is the same case: `(a+)+` is a valid literal, then .* is turned on.
  type('tag:x (a+)+');
  p.advance(100);
  $('queryRegexBtn').click();
  assert.equal($('queryError').hidden, false);
  $('tokenList').children[0].children[1].click();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, st.filter.tags.length], ['(a+)+', true, 0], 'the × works');
  assert.deepEqual(pressed('levelChips'), Array(6).fill(true));
});

test('a toggle turned on over text that is still valid under it is kept by a chip (the modes now on win when the applied text compiles under them)', () => {
  const { p, $, type } = barPage();
  type('a.b');
  p.advance(100);
  type('a.b tg:x');
  p.advance(100);
  $('queryRegexBtn').click();
  $('levelChips').children[0].click();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, $('queryRegexBtn').getAttribute('aria-pressed')], ['level:D+ a.b', true, 'true']);
});

test('a filter change that leaves the no-match tile up announces no count of its own: the tile\'s cause is the announcement and the count must not displace it (F5)', () => {
  const { p, $, st, type } = barPage();
  Object.assign(st.cur, { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: new Array(9) });   // P7a: st.cur is a session
  type('a');
  p.advance(100);
  assert.equal($('announcer').textContent, '', 'no "0 of 9 lines": grid.js says "No lines match this filter" and its cause');
  Object.assign(st.cur, { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: new Array(4), all: new Array(9) });
  type('ab');
  p.advance(100);
  assert.equal($('announcer').textContent, '4 of 9 lines', 'lines match again: the count is announced');
  Object.assign(st.cur, { counts: { lvl: [0, 0, 0, 0, 0, 0] }, filtered: [], all: [] });
  p.advance(6000);
  type('abc');
  p.advance(100);
  assert.equal($('announcer').textContent, '0 of 0 lines', 'nothing retained at all: no tile, so the count says it');
});

test('a sync (the shell\'s, a dropped frame\'s) writes no number: the 250 ms interval and a filter change do (F11)', () => {
  const { p, $, st, bar, type } = barPage();
  const count = $('filterCount');
  let writes = 0;
  let text = count.textContent;
  Object.defineProperty(count, 'textContent', { get: () => text, set(v) { writes++; text = v; } });
  Object.assign(st.cur, { counts: { lvl: [3, 0, 0, 0, 0, 0] }, filtered: new Array(3), all: new Array(9) });   // the same session grows: no switch
  bar.sync();
  bar.sync();
  assert.equal(writes, 0, 'shellSync runs at WS-frame rate: it leaves the numbers to the interval');
  p.advance(250);
  assert.deepEqual([writes, text], [1, '3 of 9 lines']);
  Object.assign(st.cur, { counts: { lvl: [2, 0, 0, 0, 0, 0] }, filtered: new Array(2), all: new Array(9) });   // P7a: st.cur is a session
  type('a');
  p.advance(100);
  assert.deepEqual([writes, text], [2, '2 of 9 lines'], 'a filter change shows its result at once, not on the next tick');
});

test('sync() writes the numbers at once only when the shown session changed (selectSession stays untouched; sync notices the switch)', () => {
  const { $, st, bar, file } = barPage();
  const count = $('filterCount');
  let writes = 0;
  let text = count.textContent;
  Object.defineProperty(count, 'textContent', { get: () => text, set(v) { writes++; text = v; } });
  bar.sync();
  assert.equal(writes, 0, 'same cur: no number');
  Object.assign(file, { counts: { lvl: [4, 0, 0, 0, 0, 0] }, filtered: new Array(4), all: new Array(7) });   // P7a: a session with its own query
  st.cur = file;
  bar.sync();
  assert.deepEqual([writes, text], [1, '4 of 7 lines'], 'another cur: its numbers at once');
  bar.sync();
  assert.equal(writes, 1, 'and only once for that switch');
});

test('per session: a switch shows the other session\'s applied text, Aa and .* modes and token chips; switching back restores the first', () => {
  const { p, $, st, bar, type, live, file } = barPage();
  type('tag:bt "x y"'); p.advance(100);
  $('queryCaseBtn').click();
  st.cur = file; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryCaseBtn').getAttribute('aria-pressed'), $('queryRegexBtn').getAttribute('aria-pressed')], ['', 'false', 'false']);
  type('level:E'); p.advance(100);
  $('queryRegexBtn').click();
  assert.deepEqual([file.queryText, file.queryOpts.regex, live.queryText, live.queryOpts.case], ['level:E', true, 'tag:bt "x y"', true]);
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryCaseBtn').getAttribute('aria-pressed'), $('queryRegexBtn').getAttribute('aria-pressed')], ['tag:bt "x y"', 'true', 'false']);
  assert.equal($('tokenMoreText').textContent, '2 filters', 'the token chips are Live\'s again');
});

test('a debounce armed for one session never applies to the other; a valid edit cut by a switch applies to its own session on return', () => {
  const { p, $, st, bar, type, live, file, calls } = barPage();
  type('tag:bt');
  p.advance(50);
  st.cur = file; bar.sync();
  p.advance(200);
  assert.deepEqual([file.queryText, live.queryText, $('queryInput').value], ['', '', ''], 'the timer armed on Live applied to neither');
  st.cur = live; bar.sync();
  assert.equal($('queryInput').value, 'tag:bt', 'the draft comes back');
  p.advance(100);
  assert.equal(live.queryText, 'tag:bt', 'and applies to Live after the usual quiet');
  assert.equal(calls.filter(c => c[0] === 'setQuery').length, 1);
});

test('an invalid draft stays with its session: it comes back with its error line, and nothing applies', () => {
  const { p, $, st, bar, type, live, file } = barPage();
  type('tag:bt'); p.advance(100);
  type('tag:bt tg:x'); p.advance(100);
  st.cur = file; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, $('queryInput').getAttribute('aria-invalid')], ['', true, null]);
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, $('queryErrorText').textContent], ['tag:bt tg:x', false, "Unknown field 'tg'. Did you mean tag:?"]);
  p.advance(300);
  assert.equal(live.queryText, 'tag:bt', 'the last valid filter is still applied');
});

test('a draft keeps only the error of its own text: an edit fixed inside the debounce comes back valid and applies', () => {
  const { p, $, st, bar, type, live, file } = barPage();
  type('tag:bt'); p.advance(100);
  type('tag:bt tg:x'); p.advance(100);   // applied and refused: the error line shows
  assert.equal($('queryError').hidden, false);
  type('tag:bt tag:x'); p.advance(50);   // fixed, still inside the debounce
  st.cur = file; bar.sync();
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, $('queryInput').getAttribute('aria-invalid')], ['tag:bt tag:x', true, null],
    'the draft comes back without the stale error');
  p.advance(100);
  assert.equal(live.queryText, 'tag:bt tag:x', 'and applies to Live after the usual quiet');
});

test('a draft switched away before its error showed comes back with the error at once, and nothing applies', () => {
  const { p, $, st, bar, type, live, file } = barPage();
  type('tag:bt'); p.advance(100);
  type('tag:bt tg:x'); p.advance(50);    // switched before the debounce applied it
  st.cur = file; bar.sync();
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryInput').value, $('queryError').hidden, $('queryErrorText').textContent], ['tag:bt tg:x', false, "Unknown field 'tg'. Did you mean tag:?"]);
  p.advance(300);
  assert.equal(live.queryText, 'tag:bt', 'the last valid filter is still applied');
  $('levelChips').children[0].click();   // and a chip rewrites the applied text, not the invalid draft
  assert.match(live.queryText, /^level:\S+ tag:bt$/);
});

test('a chip on a refused text rewrites the session\'s applied text, not the refused one', () => {
  const { p, $, type, live } = barPage({ refuse: '/slow/' });
  type('tag:bt'); p.advance(100);
  type('/slow/'); p.advance(100);
  assert.equal($('queryError').hidden, false, 'refused: the alert line shows');
  $('levelChips').children[0].click();   // Verbose off
  assert.match(live.queryText, /^level:\S+ tag:bt$/, 'rewritten over the applied text');
  assert.equal(live.filter.levels, 62);
});

test('a chip after the page refused a mode flip rewrites the applied text under its applied modes, never the refused edit again (R2 #2)', () => {
  const { p, $, type, calls, live } = barPage({ refuse: (text, o) => o.regex && text === 'a.b.c' });
  type('a.b.c'); p.advance(100);   // applied as a literal: .* is off
  assert.deepEqual([live.queryText, live.queryOpts.regex], ['a.b.c', false]);
  $('queryRegexBtn').click();      // the guard refuses this text under regex mode
  assert.equal($('queryError').hidden, false, 'refused: the alert line shows');
  calls.length = 0;
  $('levelChips').children[0].click();   // Verbose off
  const sets = calls.filter(c => c[0] === 'setQuery');
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0][2], { case: false, regex: false }, 'applied under the modes it was applied under, not the refused ones');
  assert.equal(sets[0][1], 'level:D+ a.b.c');
  assert.deepEqual([live.queryText, live.queryOpts.regex, live.filter.levels], ['level:D+ a.b.c', false, 62], 'the chip applied');
  assert.deepEqual([$('queryInput').value, $('queryRegexBtn').getAttribute('aria-pressed'), $('queryError').hidden], ['level:D+ a.b.c', 'false', true], 'the bar shows what was applied');
});

// Records the role of #queryError at every write of its text and every unhide, so a test can prove what the line was when a screen reader would
// have seen the write (a live region announces what is written into it, or unhidden, while it has role="alert").
function watchAlert($) {
  // Clearing writes ('') are not logged: an empty write into a hidden line announces nothing.
  const line = $('queryError'), text = $('queryErrorText'), log = [];
  let t = text.textContent, h = line.hidden;
  Object.defineProperty(text, 'textContent', { get: () => t, set(v) { t = v; if (v) log.push(['text', line.getAttribute('role'), v]); } });
  Object.defineProperty(line, 'hidden', { get: () => h, set(v) { if (h && !v) log.push(['unhide', line.getAttribute('role')]); h = v; } });
  return log;
}

test('a switch back to a draft with an error shows the red box, aria-invalid and the text, but not as an alert; a fresh error is an alert again (R2 #3, D8)', () => {
  const { p, $, st, bar, type, live, file } = barPage();
  const role = () => $('queryError').getAttribute('role');
  $('queryError').setAttribute('role', 'alert');   // as the page ships it
  type('tag:bt'); p.advance(100);
  type('tag:bt tg:x'); p.advance(100);
  assert.deepEqual([$('queryError').hidden, role()], [false, 'alert'], 'an error raised by typing is announced');
  const log = watchAlert($);
  log.length = 0;
  st.cur = file; bar.sync();
  assert.equal($('queryError').hidden, true);
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryBox').className, $('queryInput').getAttribute('aria-invalid'), $('queryError').hidden, $('queryErrorText').textContent],
    ['query invalid', 'true', false, "Unknown field 'tg'. Did you mean tag:?"], 'the error is shown again');
  assert.equal(role(), null, 'the switch does not make the line an alert: nothing is announced on a switch');
  st.cur = file; bar.sync();
  st.cur = live; bar.sync();
  assert.equal(role(), null, 'and again on the next switch back');
  assert.ok(log.some(e => e[0] === 'text' && e[2]) && log.some(e => e[0] === 'unhide'), 'the switch did write the text and unhide the line');
  assert.deepEqual(log.filter(e => e[1] !== null), [], 'every write and unhide during the switches happened while the line had no role');
  log.length = 0;
  type('tag:bt tga:y'); p.advance(100);   // a fresh error from typing (a different text: setText skips an unchanged one)
  assert.equal(role(), 'alert', 'a new error shown from typing is an alert');
  assert.ok(log.some(e => e[0] === 'text' && e[2].startsWith("Unknown field 'tga'")), 'the fresh error wrote its text');
  assert.deepEqual(log.filter(e => e[1] !== 'alert'), [], 'and every write and unhide for it happened while the line was an alert');
  assert.match($('queryErrorText').textContent, /^Unknown field 'tga'/);
});

test('a refusal by the page is restored on a switch without the alert role, as a parse error is (R2 #3)', () => {
  const { p, $, st, bar, type, live, file } = barPage({ refuse: '/slow/' });
  const role = () => $('queryError').getAttribute('role');
  $('queryError').setAttribute('role', 'alert');
  type('tag:bt'); p.advance(100);
  type('/slow/'); p.advance(100);   // refused by the page: kept with its error
  assert.equal(role(), 'alert');
  const log = watchAlert($);
  st.cur = file; bar.sync();
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryError').hidden, $('queryInput').getAttribute('aria-invalid'), role()], [false, 'true', null]);
  assert.match($('queryErrorText').textContent, /^Invalid regex: It would take about/);
  assert.ok(log.some(e => e[0] === 'text' && e[2]) && log.some(e => e[0] === 'unhide'), 'the switch did write the text and unhide the line');
  assert.deepEqual(log.filter(e => e[1] !== null), [], 'every write and unhide happened while the line had no role');
  // a draft cut by a switch before its error showed: the error is computed on return, and is not an alert either
  type('tag:bt tg:x'); p.advance(50);
  log.length = 0;
  st.cur = file; bar.sync();
  st.cur = live; bar.sync();
  assert.deepEqual([$('queryError').hidden, role()], [false, null]);
  assert.ok(log.some(e => e[0] === 'text' && e[2]), 'the computed error was written');
  assert.deepEqual(log.filter(e => e[1] !== null), [], 'with no role on the line at any write');
});

test('restore(s) drops the session\'s draft and shows its applied query (the page\'s file-load guard)', () => {
  const { p, $, bar, type, live } = barPage();
  type('tag:bt'); p.advance(100);
  type('tag:bt tg:'); p.advance(100);
  live.queryText = ''; live.filter = live.query = barPage().st.cur.filter;   // what the page's guard does: an empty query
  bar.restore(live);
  assert.deepEqual([$('queryInput').value, $('queryError').hidden], ['', true]);
});

test('set(text, opts) writes the bar and applies at once, returning the error or null (dev-bench &q; P7b presets)', () => {
  const { $, bar, live } = barPage();
  assert.equal(bar.set('tag:bt', { case: true }), null);
  assert.deepEqual([$('queryInput').value, live.queryText, live.queryOpts.case, $('queryCaseBtn').getAttribute('aria-pressed')], ['tag:bt', 'tag:bt', true, 'true']);
  assert.match(bar.set('tg:x').msg, /^Unknown field/);
});

test('the shell tick asks the page to recompile dev: names (every session), not setQuery', () => {
  const { calls, ticks } = barPage();
  calls.length = 0;   // the constructor's own syncChips() already asked once
  ticks.forEach(fn => fn());
  assert.deepEqual(calls.filter(c => c[0] === 'recompile' || c[0] === 'setQuery').map(c => c[0]), ['recompile']);
});
