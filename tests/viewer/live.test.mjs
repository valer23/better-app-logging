// The live view's toolbar (viewer/assets/js/live.js, roadmap P4b). ALV.livePure runs with shell.js in an
// EMPTY vm context; the DOM side runs on the fake page with the page's real toolbar and sidebar markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModules } from './_load.mjs';
import { texts, mount, shellPage } from './_fake.mjs';

const ALV = loadPureModules('shell.js', 'live.js');
const L = ALV.livePure;
const T = ' ';

test('live.js loads after shell.js in an empty context and exposes its pure helpers', () => {
  assert.equal(typeof L.streamBadge, 'function');
  assert.equal(typeof ALV.createLive, 'function');
});

test('status-bar copy: line count, Retained with the #45 note, drops (singular / plural) and the drop detail', () => {
  assert.equal(L.lineCount(47106, 48310), `47${T}106 of 48${T}310 lines`);
  assert.equal(L.retainedText(48310, 500000, 0, false), `Retained 48${T}310 of 500${T}000`);
  assert.equal(L.retainedText(90, 100, 60, false), 'Retained 90 of 100 · 60 older discarded');
  assert.equal(L.retainedText(5, 100, 11, true), 'Retained 5 of 100 · 11 discarded, resume skips to newest');
  assert.equal(L.retainedText(5, Infinity, 0, false), 'Retained 5', 'no cap (MAX_RETAINED = Infinity from the console)');
  assert.deepEqual([L.retainedNote(0, false), L.retainedNote(60, false), L.retainedNote(11, true), L.retainedNote(1234, false)],
    ['', '60 older discarded', '11 discarded, resume skips to newest', `1${T}234 older discarded`], 'the note alone: the #45 wording after the count');
  assert.deepEqual([L.dropsText(1), L.dropsText(312)], ['1 line dropped', '312 lines dropped']);
  assert.deepEqual({ ...L.dropDetail(312, 'iPhone 15', 2700) }, {
    title: '312 lines dropped from iPhone 15',
    desc: 'The viewer fell behind at 2.7k lines/s, so the bridge dropped the oldest unsent lines. Exports will have the same gap. Resets on Clear.',
  });
  assert.equal(L.dropDetail(1, 'Pixel 8 Pro', 0).desc, 'The viewer fell behind, so the bridge dropped the oldest unsent lines. Exports will have the same gap. Resets on Clear.');
  assert.deepEqual(['streaming', 'connecting', 'stalled', 'ready', 'disconnected', 'driver', 'error'].map(s => L.deviceRate(s, 842)),
    ['842/s', 'connecting…', 'stalled', 'stopped', 'stopped', 'stopped', 'stopped']);
});

test('streamBadge: the spec states, File and Paused winning over Streaming', () => {
  const b = o => ({ ...L.streamBadge({ kind: 'live', paused: false, streaming: false, rate: 0, buffered: 0, lines: 0, ...o }) });
  assert.deepEqual(b({ streaming: true, rate: 2700 }), { tone: 'ok', pulse: true, text: 'Streaming · 2.7k/s' });
  assert.deepEqual(b({ paused: true, streaming: true, buffered: 3402 }), { tone: 'warn', pulse: false, text: `Paused · 3${T}402 buffered` });
  assert.deepEqual(b({ lines: 48310 }), { tone: 'idle', pulse: false, text: `Stopped · 48${T}310 lines` });
  assert.deepEqual(b({ kind: 'file', paused: true, streaming: true, lines: 12044 }), { tone: 'idle', pulse: false, text: `File · 12${T}044 lines` });
});

// The shell and the live chrome on one fake page, with the toolbar and the More menu's surface mounted.
const LIVE_FILES = ['prefs.js', 'dom.js', 'keys.js', 'ui.js', 'shell.js', 'live.js'];
function livePage(o = {}) {
  const page = shellPage({ files: LIVE_FILES, ...o, st: { paused: false, buffered: 0, ...(o.st || {}) } });
  const { p, shell, state, prefs, calls } = page;
  for (const id of ['toolbar', 'moreSurface', 'statusBar', 'dropsPopover']) mount(p, id);
  const act = new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) });
  const live = p.ALV.createLive({ doc: p.doc, win: p.win, dom: p.dom, ui: p.ui, keys: p.keys, prefs, shell, state: () => state, actions: act });
  live.sync();
  return { ...page, live };
}
const tipText = (p, el) => texts(p.byId[el.getAttribute('aria-describedby')]);

test('toolbar: session title and stream badge follow the shown session, its devices and Pause', () => {
  const { p, live, shell, state, $ } = livePage();
  assert.deepEqual([$('sessionTitle').textContent, $('streamBadgeText').textContent, $('streamBadge').getAttribute('class')], ['Live session', 'Stopped · 0 lines', 'badge status-idle']);
  state.live.ios = true;
  state.devices.ios = { id: 'u1', name: 'iPhone 15' };
  p.advance(500);
  state.lines.ios = 1350;
  p.advance(500);
  assert.deepEqual([$('streamBadgeText').textContent, $('streamBadge').getAttribute('class'), $('streamDot').getAttribute('class')],
    ['Streaming · 2.7k/s', 'badge status-ok', 'dot pulse'], 'the badge follows the tick');
  state.paused = true;
  state.buffered = 3402;
  live.sync();
  assert.equal($('streamBadgeText').textContent, `Paused · 3${T}402 buffered`);
  state.cur = state.sessions[1];
  state.sessions[1].name = 'pixel-crash-0412.logcat';
  state.sessions[1].all = new Array(12044);
  shell.sync(); live.sync();
  assert.deepEqual([$('sessionTitle').textContent, $('streamBadgeText').textContent], ['pixel-crash-0412.logcat', `File · 12${T}044 lines`]);
});

test('toolbar: Pause swaps its label, icon and tooltip (not a toggle button), Follow is a toggle button (aria-pressed); both call the legacy functions', () => {
  const { p, live, state, calls, $ } = livePage();
  // APG: a button either swaps its label or is a toggle (aria-pressed), never both ("Resume, toggle button, pressed").
  assert.deepEqual([$('pauseBtn').getAttribute('aria-pressed'), $('pauseLabel').textContent, $('pauseIcon').getAttribute('href'), tipText(p, $('pauseBtn'))],
    [null, 'Pause', '#i-pause', 'Pause stream']);
  $('pauseBtn').click();
  $('autoScrollBtn').click();
  $('clearBtn').click();
  assert.deepEqual(calls.map(c => c[0]), ['togglePause', 'toggleAutoScroll', 'clear']);
  state.paused = true;
  state.cur.follow = false;
  live.sync();
  assert.deepEqual([$('pauseBtn').getAttribute('aria-pressed'), $('pauseLabel').textContent, $('pauseIcon').getAttribute('href'), tipText(p, $('pauseBtn'))],
    [null, 'Resume', '#i-play', 'Resume stream']);
  assert.equal($('autoScrollBtn').getAttribute('aria-pressed'), 'false');
  assert.deepEqual([tipText(p, $('autoScrollBtn')), tipText(p, $('clearBtn')), $('clearBtn').getAttribute('aria-label')], ['Follow newest lines', 'Clear view', 'Clear view']);
});

test('toolbar: the log text size group shows the size, its ends are aria-disabled at 10 and 20, and its tooltips carry ⌘− ⌘0 ⌘=', () => {
  const { p, prefs, calls, $ } = livePage();
  assert.deepEqual([$('zoomGroup').getAttribute('role'), $('zoomGroup').getAttribute('aria-label'), $('zoomResetBtn').textContent], ['group', 'Log text size', '13 px']);
  assert.deepEqual([tipText(p, $('zoomOutBtn')), tipText(p, $('zoomResetBtn')), tipText(p, $('zoomInBtn'))], ['Smaller log text⌘−', 'Reset⌘0', 'Larger log text⌘=']);
  $('zoomOutBtn').click();
  $('zoomResetBtn').click();
  $('zoomInBtn').click();
  assert.deepEqual(calls.map(c => c.join(':')), ['zoom:-1', 'zoom:0', 'zoom:1']);
  prefs.set('logFontSize', 20);
  assert.deepEqual([$('zoomResetBtn').textContent, $('zoomInBtn').getAttribute('aria-disabled'), $('zoomOutBtn').getAttribute('aria-disabled')], ['20 px', 'true', null]);
  $('zoomInBtn').click();
  assert.equal(calls.length, 3, 'an aria-disabled end does nothing');
  prefs.set('logFontSize', 10);
  assert.deepEqual([$('zoomInBtn').getAttribute('aria-disabled'), $('zoomOutBtn').getAttribute('aria-disabled')], [null, 'true']);
});

// WCAG 2.5.3 Label in Name: the Reset button's visible label is the current size ("15 px"), so its accessible
// name must contain it (Voice Control: "click 15 px"), and the group is where a screen reader learns the size.
test('toolbar: the Reset button\'s accessible name starts with its visible size and says what it does (review F8)', () => {
  const { prefs, $ } = livePage();
  const reset = $('zoomResetBtn');
  const nameHas = () => reset.getAttribute('aria-label').toLowerCase().includes(reset.textContent.toLowerCase());
  assert.deepEqual([reset.textContent, reset.getAttribute('aria-label')], ['13 px', '13 px, reset log text size to 13 px']);
  prefs.set('logFontSize', 15);
  assert.deepEqual([reset.textContent, reset.getAttribute('aria-label'), nameHas()], ['15 px', '15 px, reset log text size to 13 px', true]);
  prefs.set('logFontSize', 10);
  assert.ok(nameHas() && reset.getAttribute('aria-label').startsWith('10 px'));
});

test('toolbar: More holds "Open log file…" (⌘O) and, on macOS only, the Glass checkbox that sets the material', () => {
  const { p, prefs, calls, $ } = livePage();
  assert.deepEqual([$('moreGlass').hidden, $('moreOpenKbd').textContent, tipText(p, $('moreBtn'))], [false, '⌘O', 'More']);
  $('moreBtn').click();
  assert.equal($('moreGlass').getAttribute('aria-checked'), 'false');
  $('moreGlass').click();
  assert.deepEqual(calls.at(-1), ['setGlass', true]);
  prefs.set('material', 'glass');
  $('moreBtn').click();
  $('moreBtn').click();
  assert.equal($('moreGlass').getAttribute('aria-checked'), 'true', 're-read from prefs on open');
  p.doc.listeners.pointerdown[0]({ target: p.byId.filterbar });
  $('moreBtn').click();
  $('moreMenu').children[0].click();
  assert.deepEqual(calls.at(-1), ['openFile']);
  const pc = livePage({ platform: 'other' });
  assert.deepEqual([pc.$('moreGlass').hidden, pc.$('moreGlassSep').hidden, pc.$('moreOpenKbd').textContent], [true, true, 'Ctrl+O'], 'Glass is macOS only');
});

test('toolbar: closeMenus() closes the More menu without moving focus (showStallModal and showSetup call it)', () => {
  const { p, live, $ } = livePage();
  $('moreBtn').click();
  assert.deepEqual([$('moreBtn').getAttribute('aria-expanded'), p.keys.escDepth()], ['true', 1]);
  const before = p.doc.activeElement;
  live.closeMenus();
  assert.deepEqual([$('moreBtn').getAttribute('aria-expanded'), $('moreSurface').hidden, p.keys.escDepth(), p.doc.activeElement === before],
    ['false', true, 0, true], '#overlayRoot (z 200) would paint it above the legacy modal');
  assert.doesNotThrow(() => live.closeMenus(), 'nothing open: a no-op');
});

// ---- Status bar ----

test('status bar: one button per device (name, rate or state, aria-pressed) that toggles it in the filter', () => {
  const { p, live, shell, state, calls, $ } = livePage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  assert.deepEqual([$('sbAndroidName').textContent, $('sbAndroidRate').textContent, $('sbAndroid').getAttribute('data-state'), $('sbAndroid').getAttribute('aria-pressed')],
    ['Pixel 8 Pro', 'stopped', 'ready', 'true']);
  assert.deepEqual([$('sbIosName').textContent, $('sbIosRate').textContent], ['iPhone', 'stopped']);
  state.live.android = true;
  p.advance(500);
  state.lines.android = 421;
  p.advance(500);
  assert.deepEqual([$('sbAndroidRate').textContent, $('sbAndroid').getAttribute('data-state')], ['842/s', 'streaming']);
  state.status.ios = { state: 'connecting', text: 'Connecting…' };
  state.enabled = new Set(['android']);
  shell.sync(); live.sync();   // as shellSync() does
  assert.deepEqual([$('sbIosRate').textContent, $('sbIos').getAttribute('aria-pressed')], ['connecting…', 'false']);
  $('sbIos').click();
  assert.deepEqual(calls.at(-1), ['togglePlatform', 'ios']);
});

// As the sidebar rows (P4a): the toggle is named by the device alone and the rate describes it. The rate is
// rewritten twice a second, and a focused button whose name changed would be re-announced at that pace.
test('status bar: a device button is named by the device alone; the rate (rewritten at 2 Hz) only describes it', () => {
  const { p, live, state, $ } = livePage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  for (const [id, name] of [['sbAndroid', 'Pixel 8 Pro'], ['sbIos', 'iPhone']]) {
    const b = $(id);
    const labelledby = b.getAttribute('aria-labelledby');
    const describedby = b.getAttribute('aria-describedby');
    assert.deepEqual([labelledby, describedby], [`${id}Name`, `${id}Rate`], 'attributes name the two spans');
    assert.equal(p.byId[labelledby].textContent, name);
    assert.ok(!p.byId[labelledby].textContent.includes(p.byId[describedby].textContent), 'the name excludes the rate');
    assert.notEqual(labelledby, describedby);
  }
  state.live.android = true;
  p.advance(500);
  state.lines.android = 421;
  p.advance(500);
  assert.equal($('sbAndroidRate').textContent, '842/s');
  assert.equal($('sbAndroidName').textContent, 'Pixel 8 Pro', 'the name does not change with the rate');
});

test('status bar: the drops button sums both platforms; its popover says how many, from which device, at what rate', () => {
  const { p, live, state, $ } = livePage({ st: { live: { android: false, ios: true }, devices: { android: { id: '', name: '' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  assert.equal($('dropsBtn').hidden, true);
  p.advance(500);
  state.lines.ios = 1350;
  p.advance(500);
  state.dropped.ios = 312;
  live.sync();
  assert.deepEqual([$('dropsBtn').hidden, $('dropsText').textContent], [false, '312 lines dropped']);
  assert.deepEqual([$('dropsIos').hidden, $('dropsIosTitle').textContent, $('dropsAndroid').hidden], [false, '312 lines dropped from iPhone 15', true]);
  assert.match($('dropsIosDesc').textContent, /^The viewer fell behind at 2\.7k lines\/s, so the bridge/, 'the rate when the drop was counted');
  state.dropped.android = 1;
  live.sync();
  assert.deepEqual([$('dropsText').textContent, $('dropsAndroidTitle').textContent], ['313 lines dropped', '1 line dropped from Android device']);
  assert.equal($('dropsBtn').getAttribute('aria-haspopup'), 'dialog');
  $('dropsBtn').click();
  assert.equal($('dropsPopover').hidden, false, 'the popover opens');
  state.dropped.android = 0;
  state.dropped.ios = 0;
  live.sync();
  assert.deepEqual([$('dropsBtn').hidden, $('dropsText').textContent], [true, '0 lines dropped'], 'Clear resets them');
});

// ui.popup places a surface on open and on resize; with side 'top' its top edge comes from its height at that
// moment. A platform that starts dropping while it is open un-hides a block and grows it.
test('status bar: the open drops popover is repositioned when a platform block appears or goes away, and not otherwise', () => {
  const { p, live, state, $ } = livePage();
  const pop = $('dropsPopover');
  const blocks = () => ['dropsAndroid', 'dropsIos'].filter(id => !$(id).hidden).length;
  Object.defineProperty(pop, 'offsetHeight', { get: () => 40 + 60 * blocks(), configurable: true });
  $('dropsBtn').getBoundingClientRect = () => ({ left: 500, top: 700, right: 580, bottom: 728, width: 80, height: 28 });
  const top = () => Number.parseFloat(pop.style.top);
  state.dropped.ios = 312;
  live.sync();
  $('dropsBtn').click();
  assert.equal(pop.hidden, false);
  const one = top();
  assert.equal(one, 700 - 100 - 6, 'one block: its bottom edge sits 6 px above the button');
  state.dropped.ios = 400;
  live.sync();
  assert.equal(top(), one, 'a count change that keeps the blocks does not re-place it');
  state.dropped.android = 1;
  live.sync();
  assert.equal(blocks(), 2);
  assert.equal(top(), 700 - 160 - 6, 'the second block appeared: still 6 px above the button, grown upwards');
  state.dropped.ios = 0;
  live.sync();
  assert.equal(blocks(), 1);
  assert.equal(top(), one, 'a block went away: placed again');
  live.closeMenus();
  const closed = pop.style.top;
  state.dropped.ios = 5;
  live.sync();
  assert.equal(pop.style.top, closed, 'closed: nothing is placed');
});

test('status bar: Following / Not following for the live session, nothing for a file; its tooltip carries the Retained text', () => {
  const { p, live, state, $ } = livePage({ st: { maxRetained: 100 } });
  assert.deepEqual([$('followText').textContent, $('followState').getAttribute('data-on'), $('followState').hidden], ['Following', 'true', false]);
  state.cur.all = new Array(90);
  state.cur.discarded = 60;
  live.sync();
  assert.equal(tipText(p, $('followState')), 'Retained 90 of 100 · 60 older discarded', 'the #45 note, also where the narrow tier hides #retainedText');
  state.cur.follow = false;
  live.sync();
  assert.deepEqual([$('followText').textContent, $('followState').getAttribute('data-on')], ['Not following', 'false']);
  state.cur = state.sessions[1];
  live.sync();
  assert.equal($('followState').hidden, true);
});

test('status bar: closeMenus() also closes the drops popover, without moving focus', () => {
  const { p, live, state, $ } = livePage();
  state.dropped.ios = 3;
  live.sync();
  $('dropsBtn').click();
  assert.equal($('dropsPopover').hidden, false);
  const before = p.doc.activeElement;
  live.closeMenus();
  assert.deepEqual([$('dropsPopover').hidden, $('dropsBtn').getAttribute('aria-expanded'), p.doc.activeElement === before], [true, 'false', true]);
});

// The 2 Hz tick and every flush (shellSync from refreshLiveView) run live.sync(): with nothing changed it must
// not write a text, an attribute or a hidden flag (the diffed writers; P4a judge, perf budget).
test('live.sync() with nothing changed writes nothing to the toolbar, the status bar or the drops popover', () => {
  const { p, live, state, $ } = livePage({ st: { live: { android: true, ios: false }, devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  state.dropped.android = 2;
  p.advance(1000);
  live.sync();
  let writes = [];
  const watch = n => {
    if (!n || !n.attrs) return;
    const set = n.setAttribute, rm = n.removeAttribute;
    n.setAttribute = function (k, v) { writes.push(`${n.id || n.tagName} @${k}`); return set.call(this, k, v); };
    n.removeAttribute = function (k) { writes.push(`${n.id || n.tagName} -${k}`); return rm.call(this, k); };
    for (const prop of ['textContent', 'hidden']) {
      let v = n[prop];
      Object.defineProperty(n, prop, { get: () => v, set: x => { writes.push(`${n.id || n.tagName} .${prop}`); v = x; }, configurable: true });
    }
    n.children.forEach(watch);
  };
  for (const id of ['toolbar', 'statusBar', 'dropsPopover']) watch($(id));
  live.sync();
  p.advance(500);   // the shell's tick runs live.sync() too
  assert.deepEqual(writes, []);
  state.paused = true;
  live.sync();
  assert.ok(writes.length > 0, 'the watch sees a real change');
});
