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
  for (const id of ['toolbar', 'moreSurface']) mount(p, id);
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
