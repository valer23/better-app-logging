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
  p.byId.ovPopovers.appendChild(mount(p, 'tokenPop'));   // the "N filters" popover, in the popover layer as on the page
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
