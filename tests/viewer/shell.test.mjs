// The app shell (viewer/assets/js/shell.js, roadmap P4). ALV.shellPure runs in an EMPTY vm context: the
// thin-space number format, the rate format and meter, the device status line and the theme button view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';
import { fakePage, texts, shellPage, DARK } from './_fake.mjs';

const ALV = loadPureModule('shell.js');
const S = ALV.shellPure;
const T = ' ';   // thin space (spec conventions: "48 310")

test('shell.js loads in an empty context and exposes its pure helpers', () => {
  for (const f of ['num', 'fmtRate', 'createRateMeter', 'deviceStatus', 'themeView']) assert.equal(typeof S[f], 'function', f);
});

test('num groups thousands with a thin space; negatives, fractions and garbage are safe', () => {
  const cases = [[0, '0'], [999, '999'], [1000, `1${T}000`], [48310, `48${T}310`], [500000, `500${T}000`],
    [1234567, `1${T}234${T}567`], [12.6, '13'], [-5, '0'], [NaN, '0'], [undefined, '0'], ['3402', `3${T}402`]];
  for (const [n, want] of cases) assert.equal(S.num(n), want, String(n));
});

test('fmtRate writes lines per second as the spec does: 842/s, 1.9k/s, 27k/s', () => {
  const cases = [[0, '0/s'], [842, '842/s'], [999.4, '999/s'], [999.6, '1.0k/s'], [1900, '1.9k/s'], [2700, '2.7k/s'],
    [9949, '9.9k/s'], [9950, '10k/s'], [27000, '27k/s'], [-3, '0/s'], [NaN, '0/s']];
  for (const [n, want] of cases) assert.equal(S.fmtRate(n), want, String(n));
});

test('rate meter: frames per second per platform over the newest sample at least 1 s old', () => {
  const m = S.createRateMeter(1000);
  assert.deepEqual({ ...m.sample(0, { android: 0, ios: 0 }) }, { android: 0, ios: 0 }, 'one sample: no rate yet');
  assert.deepEqual({ ...m.sample(500, { android: 0, ios: 400 }) }, { android: 0, ios: 800 });
  assert.deepEqual({ ...m.sample(1000, { android: 10, ios: 900 }) }, { android: 10, ios: 900 });
  assert.deepEqual({ ...m.sample(1500, { android: 10, ios: 1000 }) }, { android: 10, ios: 600 }, 'measured from t=500, the newest sample 1 s old');
  assert.deepEqual({ ...m.sample(4000, { android: 10, ios: 1000 }) }, { android: 0, ios: 0 }, 'a quiet stream reads 0');
});

test('deviceStatus: every spec status line, its state shape and tone, and the drops line', () => {
  const base = { live: false, state: 'disconnected', text: 'Disconnected', detected: false, driverMissing: false, stalledFor: -1, rate: 0, dropped: 0 };
  const st = o => ({ ...S.deviceStatus({ ...base, ...o }) });
  assert.deepEqual(st({ live: true, rate: 842 }), { state: 'streaming', tone: 'ok', text: 'Streaming · 842/s', drops: '' });
  assert.deepEqual(st({ live: true, rate: 2700, stalledFor: 15.2 }), { state: 'stalled', tone: 'warn', text: 'Stalled 15 s', drops: '' });
  assert.deepEqual(st({ state: 'connecting', text: 'Connecting…' }), { state: 'connecting', tone: 'info', text: 'Connecting…', drops: '' });
  assert.deepEqual(st({ state: 'error', text: 'No device' }), { state: 'error', tone: 'err', text: 'No device', drops: '' }, 'the bridge text');
  assert.equal(st({ state: 'error', text: '' }).text, 'Error');
  assert.deepEqual(st({ driverMissing: true, detected: true }), { state: 'driver', tone: 'err', text: 'Driver missing', drops: '' });
  assert.deepEqual(st({ detected: true }), { state: 'ready', tone: 'idle', text: 'Ready · stopped', drops: '' });
  assert.deepEqual(st({}), { state: 'disconnected', tone: 'idle', text: 'Disconnected', drops: '' });
  assert.equal(st({ live: true, rate: 10, dropped: 312 }).drops, '312 dropped');
  assert.equal(st({ dropped: 1200 }).drops, `1${T}200 dropped`, 'drops stay visible after a disconnect, until Clear');
});

test('themeView: icon, aria-label and tooltip for each theme, System naming what it resolves to', () => {
  assert.deepEqual({ ...S.themeView('dark', 'dark', 'light') }, { icon: 'moon', label: 'Theme: Dark. Switch to Light', tip: 'Theme: Dark' });
  assert.deepEqual({ ...S.themeView('light', 'light', 'system') }, { icon: 'sun', label: 'Theme: Light. Switch to System', tip: 'Theme: Light' });
  assert.deepEqual({ ...S.themeView('system', 'dark', 'dark') }, { icon: 'monitor', label: 'Theme: System. Switch to Dark', tip: 'Theme: System (Dark)' });
  assert.equal(S.themeView('system', 'light', 'dark').tip, 'Theme: System (Light)');
});

// ---- DOM side: the window drag bands (initDragBand) on the fake page ----

const SHELL_FILES = ['dom.js', 'keys.js', 'ui.js', 'shell.js'];
// A fake Tauri window that counts the IPC calls the bands make.
function fakeTauri() {
  const calls = [];
  const w = { startDragging() { calls.push('drag'); }, toggleMaximize() { calls.push('max'); } };
  return { calls, api: { window: { getCurrentWindow: () => w } } };
}
function bandPage(tauri) {
  const p = fakePage({ files: SHELL_FILES, tauri: tauri && tauri.api });
  for (const id of ALV.shellPure.DRAG_BANDS) p.doc.body.appendChild(p.dom.el('div', { id }));
  const ctl = p.dom.el('button', { text: 'A+' });
  p.byId.topbar.appendChild(ctl);
  p.ALV.createShell({ doc: p.doc, win: p.win, dom: p.dom });
  const move = (x, y) => p.win.listeners.mousemove.forEach(fn => fn({ clientX: x, clientY: y }));
  const up = () => p.win.listeners.mouseup.forEach(fn => fn({}));
  return { p, ctl, move, up };
}

test('drag bands: the sidebar header and the top bar; one window listener pair for both', () => {
  assert.deepEqual([...ALV.shellPure.DRAG_BANDS], ['sidebarHeader', 'topbar']);
  const { p } = bandPage(fakeTauri());
  assert.deepEqual([p.win.listeners.mousemove.length, p.win.listeners.mouseup.length], [1, 1]);
  for (const id of ALV.shellPure.DRAG_BANDS) assert.deepEqual([p.byId[id].listeners.mousedown.length, p.byId[id].listeners.dblclick.length], [1, 1], id);
});

test('drag bands: a press on the background arms, 4 px of movement drags once; controls, other buttons and the 2nd click of a double-click never do', () => {
  const t = fakeTauri();
  const { p, ctl, move, up } = bandPage(t);
  p.byId.sidebarHeader.fire('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 20 });
  move(103, 23);
  assert.deepEqual(t.calls, [], '3 px is not a drag');
  move(104, 20);
  move(140, 20);
  assert.deepEqual(t.calls, ['drag'], 'startDragging once');
  p.byId.topbar.fire('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 20 });
  up();
  move(200, 20);
  assert.deepEqual(t.calls, ['drag'], 'mouseup disarms');
  ctl.fire('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 20 });
  move(200, 20);
  p.byId.topbar.fire('mousedown', { button: 2, detail: 1, clientX: 100, clientY: 20 });
  move(200, 20);
  p.byId.topbar.fire('mousedown', { button: 0, detail: 2, clientX: 100, clientY: 20 });
  move(200, 20);
  assert.deepEqual(t.calls, ['drag'], 'not from a control, a right button or a double-click');
});

test('drag bands: a double-click on the background toggles maximise, on a control it does not; no Tauri, no throw', () => {
  const t = fakeTauri();
  const { p, ctl } = bandPage(t);
  ctl.fire('dblclick', {});
  p.byId.sidebarHeader.fire('dblclick', {});
  assert.deepEqual(t.calls, ['max']);
  const bare = bandPage(null);
  assert.doesNotThrow(() => {
    bare.p.byId.topbar.fire('mousedown', { button: 0, detail: 1, clientX: 0, clientY: 0 });
    bare.move(50, 50);
    bare.p.byId.topbar.fire('dblclick', {});
  });
});

// ---- DOM side: the sidebar, built from the page's real markup (shellPage in _fake.mjs) ----

test('SESSIONS: Live session first and current, its line count; the file row appears once a file has lines', () => {
  const { shell, state, live, file, $ } = shellPage();
  assert.deepEqual([$('sessLive').getAttribute('aria-current'), $('sessFile').getAttribute('aria-current')], ['page', null]);
  assert.deepEqual([$('sessLiveCount').textContent, $('sessFileItem').hidden, $('sessCount').textContent], ['0', true, '1']);
  live.all = new Array(48310);
  file.all = new Array(12044);
  file.name = 'pixel-crash-0412.logcat';
  shell.sync();
  assert.deepEqual([$('sessLiveCount').textContent, $('sessFileCount').textContent, $('sessFileName').textContent, $('sessFileItem').hidden, $('sessCount').textContent],
    ['48 310', '12 044', 'pixel-crash-0412.logcat', false, '2']);
  state.cur = file;
  shell.sync();
  assert.deepEqual([$('sessLive').getAttribute('aria-current'), $('sessFile').getAttribute('aria-current')], [null, 'page']);
  file.all = [];
  shell.sync();
  assert.equal($('sessFileItem').hidden, false, 'an empty file session stays listed while it is shown (the dropzone)');
});

test('SESSIONS: the rows select their session; "Open log file…" and ⌘O open the picker; the kbd shows the platform label', () => {
  const { p, live, file, calls, $ } = shellPage();
  $('sessFile').click();
  $('sessLive').click();
  $('openFileBtn').click();
  assert.deepEqual(calls.map(c => c[0]), ['selectSession', 'selectSession', 'openFile']);
  assert.deepEqual([calls[0][1] === file, calls[1][1] === live], [true, true]);
  assert.equal(p.keys.dispatch({ key: 'o', code: 'KeyO', metaKey: true, preventDefault() {} }, p.byId.filterbar), 'session.open');
  assert.equal(calls.at(-1)[0], 'openFile');
  assert.equal($('openFileKbd').textContent, '⌘O');
  assert.equal(shellPage({ platform: 'other' }).$('openFileKbd').textContent, 'Ctrl+O');
});

test('SESSIONS: the counts follow the live session twice a second, never while the window is hidden', () => {
  const { p, live, $ } = shellPage();
  live.all = new Array(1500);
  p.advance(499);
  assert.equal($('sessLiveCount').textContent, '0');
  p.advance(1);
  assert.equal($('sessLiveCount').textContent, '1 500');
  p.doc.hidden = true;
  live.all = new Array(2000);
  p.advance(1000);
  assert.equal($('sessLiveCount').textContent, '1 500');
});

test('sections: the header button folds its list (aria-expanded) and unfolds it', () => {
  const { $ } = shellPage();
  const head = $('sessHead');
  assert.deepEqual([head.getAttribute('aria-expanded'), head.getAttribute('aria-controls'), $('sessionList').hidden], ['true', 'sessionList', false]);
  head.click();
  assert.deepEqual([head.getAttribute('aria-expanded'), $('sessionList').hidden], ['false', true]);
  head.click();
  assert.deepEqual([head.getAttribute('aria-expanded'), $('sessionList').hidden], ['true', false]);
});

// ---- DEVICES: one row per platform's device ----

const row = (p, plat) => p.byId.deviceList.children.find(li => li.dataset.platform === plat);
const parts = li => {
  const [main, actions] = li.children;
  const [, text] = main.children;
  const [name, status, drops] = text.children;
  const [start, more] = actions.children;
  return { main, name, status: status.children[1], drops, dropsText: drops.children[1], start, startUse: start.children[0].children[0], more };
};

test('DEVICES: a row per platform (Android, then iOS) with badge, name, spec status line and the shape state', () => {
  const { p, shell, state, $ } = shellPage();
  assert.deepEqual(p.byId.deviceList.children.map(li => li.dataset.platform), ['android', 'ios']);
  let a = parts(row(p, 'android'));
  assert.deepEqual([texts(a.main.children[0]), a.name.textContent, a.status.textContent, row(p, 'android').getAttribute('data-state')],
    ['A', 'Android device', 'Disconnected', 'disconnected']);
  assert.equal(texts(parts(row(p, 'ios')).main.children[0]), 'i');
  state.devices.android = { id: '3A091FDJH00ABC', name: 'Pixel 8 Pro' };
  shell.sync();
  a = parts(row(p, 'android'));
  assert.deepEqual([a.name.textContent, a.status.textContent, row(p, 'android').getAttribute('data-state'), $('devCount').textContent],
    ['Pixel 8 Pro', 'Ready · stopped', 'ready', '1']);
  state.status.android = { state: 'connecting', text: 'Connecting…' };
  shell.sync();
  assert.deepEqual([a.status.textContent, row(p, 'android').getAttribute('data-tone'), a.start.getAttribute('aria-disabled')], ['Connecting…', 'info', 'true'],
    'Start is aria-disabled while connecting, so it cannot open a second socket');
  state.status.android = { state: 'connected', text: 'Connected' };
  state.live.android = true;
  shell.sync();
  assert.deepEqual([a.status.textContent, row(p, 'android').getAttribute('data-state'), a.start.getAttribute('aria-disabled')], ['Streaming · 0/s', 'streaming', null]);
  state.driverMissing = true;
  shell.sync();
  assert.equal(parts(row(p, 'ios')).status.textContent, 'Driver missing');
});

test('DEVICES: the rate comes from the log-line counters on the tick', () => {
  const { p, state } = shellPage({ st: { live: { android: false, ios: true }, devices: { android: { id: '', name: '' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  const i = parts(row(p, 'ios'));
  p.advance(500);
  state.lines.ios = 421;
  p.advance(500);
  assert.equal(i.status.textContent, 'Streaming · 842/s', '421 lines in 0.5 s');
  state.lines.ios = 2121;
  p.advance(500);
  assert.equal(i.status.textContent, 'Streaming · 2.1k/s', 'measured from the newest sample 1 s old (t=500, 0 lines)');
});

test('DEVICES: a stall reads the fixed threshold "Stalled 15 s", not a timer, and only the next log line ends it', () => {
  const { p, shell, state } = shellPage({ st: { live: { android: false, ios: true }, devices: { android: { id: '', name: '' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  const i = parts(row(p, 'ios'));
  p.advance(500);
  state.lines.ios = 2121;
  p.advance(500);
  state.lines.ios += 3;   // lines that arrived just before the report are not the line that ends the stall
  shell.markStalled('ios');
  assert.deepEqual([i.status.textContent, row(p, 'ios').getAttribute('data-state')], ['Stalled 15 s', 'stalled'], 'at once, without waiting for a tick');
  for (let n = 0; n < 40; n++) p.advance(500);   // 20 s of ticks: the bridge's respawn sends devices and error frames, which are not lines
  assert.equal(i.status.textContent, 'Stalled 15 s', 'still the threshold after 20 s, not "Stalled 35 s"');
  assert.equal(row(p, 'ios').getAttribute('data-state'), 'stalled');
  state.lines.ios += 1;
  p.advance(500);
  assert.match(i.status.textContent, /^Streaming · /, 'a log line arrived: the stall is over');
  shell.markStalled('ios');
  state.live.ios = false;
  p.advance(500);
  state.live.ios = true;
  p.advance(500);
  assert.match(i.status.textContent, /^Streaming · /, 'a stopped stream is not stalled when it starts again');
});

test('DEVICES: the toggle is named by the device alone; the status and drops lines describe it', () => {
  const { p, state, shell } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const a = parts(row(p, 'android'));
  const labelledby = a.main.getAttribute('aria-labelledby');
  assert.equal(p.byId[labelledby].textContent, 'Pixel 8 Pro', 'the name span');
  assert.deepEqual(a.main.getAttribute('aria-describedby').split(' '), [a.status.getAttribute('id'), a.drops.getAttribute('id')]);
  assert.equal(p.byId[a.status.getAttribute('id')], a.status);
  assert.equal(p.byId[a.drops.getAttribute('id')], a.drops);
  state.status.android = { state: 'connecting', text: 'Connecting…' };
  state.dropped.android = 5;
  shell.sync();
  assert.deepEqual([a.main.getAttribute('aria-labelledby'), a.main.getAttribute('aria-label')], [labelledby, null], 'the name does not follow the status');
});

test('DEVICES: drops line, filter toggle (aria-pressed, aria-current when the only one shown), Start/Stop and the More menu', () => {
  const { p, shell, state, calls } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  const a = parts(row(p, 'android'));
  const i = parts(row(p, 'ios'));
  assert.equal(a.drops.hidden, true);
  state.dropped.android = 312;
  shell.sync();
  assert.deepEqual([a.drops.hidden, a.dropsText.textContent], [false, '312 dropped']);
  assert.deepEqual([a.main.getAttribute('aria-pressed'), a.main.getAttribute('aria-current')], ['true', null]);
  a.main.click();
  assert.deepEqual(calls.at(-1), ['togglePlatform', 'android']);
  state.enabled = new Set(['android']);
  shell.sync();
  assert.deepEqual([a.main.getAttribute('aria-current'), i.main.getAttribute('aria-pressed')], ['true', 'false']);
  assert.deepEqual([a.start.getAttribute('aria-label'), a.startUse.getAttribute('href')], ['Start streaming Pixel 8 Pro', '#i-play']);
  a.start.click();
  assert.deepEqual(calls.at(-1), ['toggleStream', 'android']);
  state.live.android = true;
  shell.sync();
  assert.deepEqual([a.start.getAttribute('aria-label'), a.startUse.getAttribute('href')], ['Stop streaming Pixel 8 Pro', '#i-square']);
  assert.equal(a.more.getAttribute('aria-label'), 'More for Pixel 8 Pro');
  a.more.click();
  const items = p.byId[a.more.getAttribute('aria-controls')].children;
  assert.deepEqual(items.map(texts), ['Stop streaming', 'Setup guide'], 'Android: no Re-pair');
  items[1].click();
  assert.deepEqual(calls.at(-1), ['setup', 'android']);
  i.more.click();
  const iosItems = p.byId[i.more.getAttribute('aria-controls')].children;
  assert.deepEqual(iosItems.map(texts), ['Start streaming', 'Re-pair iPhone', 'Setup guide']);
  iosItems[1].click();
  assert.deepEqual(calls.at(-1), ['repair', 'ios']);
  state.status.ios = { state: 'connecting', text: 'Connecting…' };
  shell.sync();
  i.start.click();
  i.more.click();
  iosItems[0].click();
  assert.notDeepEqual(calls.at(-1), ['toggleStream', 'ios'], 'neither Start nor the menu item acts while connecting');
});

test('DEVICES: a new device rebuilds its row and destroys the old menu and tooltips; focus moves to the same control (P3 follow-up a)', () => {
  const { p, shell, state } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const old = parts(row(p, 'android'));
  const popovers = p.byId.ovPopovers.children.length;
  const tips = p.byId.ovTips.children.length;
  old.more.click();
  assert.equal(p.keys.escDepth(), 1, 'the old menu is open');
  state.devices.android = { id: 'b2', name: 'Galaxy S24' };
  shell.sync();
  const fresh = parts(row(p, 'android'));
  assert.notEqual(fresh.main, old.main);
  assert.deepEqual([p.byId.deviceList.children.map(li => li.dataset.platform), fresh.name.textContent], [['android', 'ios'], 'Galaxy S24']);
  assert.deepEqual([p.byId.ovPopovers.children.length, p.byId.ovTips.children.length, p.keys.escDepth()], [popovers, tips, 0],
    'one menu and its tooltips per row: the old ones are gone, nothing left on the Esc stack');
  assert.equal(p.doc.activeElement, fresh.more, 'focus was in the old menu: it lands on the new More button');
  shell.sync();
  assert.equal(parts(row(p, 'android')).main, fresh.main, 'an unchanged device keeps its row');
});

// ---- Footer: the theme cycle (⇧⌘L) and the Windows caption ----

const tipOf = (p, btn) => p.byId[btn.getAttribute('aria-describedby')];

test('theme button: icon, aria-label and tooltip per theme; a click and ⇧⌘L cycle Dark → Light → System', () => {
  const { p, prefs, $ } = shellPage();
  const view = () => [$('themeIcon').getAttribute('href'), $('themeBtn').getAttribute('aria-label'), texts(tipOf(p, $('themeBtn')))];
  assert.deepEqual(view(), ['#i-moon', 'Theme: Dark. Switch to Light', 'Theme: Dark⇧⌘L']);
  $('themeBtn').click();
  assert.deepEqual([prefs.get('theme'), ...view()], ['light', '#i-sun', 'Theme: Light. Switch to System', 'Theme: Light⇧⌘L']);
  assert.equal(p.keys.dispatch({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true, preventDefault() {} }, p.byId.filterbar), 'view.theme');
  assert.deepEqual([prefs.get('theme'), ...view()], ['system', '#i-monitor', 'Theme: System. Switch to Dark', 'Theme: System (Dark)⇧⌘L']);
  p.keys.dispatch({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true, preventDefault() {} }, p.byId.filterbar);
  assert.equal(prefs.get('theme'), 'dark');
});

test('theme button: with System chosen, an OS appearance change updates the tooltip live (spec Open item 3)', () => {
  const { p, prefs, mm, $ } = shellPage();
  prefs.set('theme', 'system');
  assert.equal(texts(tipOf(p, $('themeBtn'))), 'Theme: System (Dark)⇧⌘L');
  mm.fire(DARK, false);
  assert.equal(texts(tipOf(p, $('themeBtn'))), 'Theme: System (Light)⇧⌘L');
});

test('Windows caption: setTheme follows the app theme (null = the OS for System), sent only on change; macOS never calls it', () => {
  const sent = [];
  const w = { setTheme: t => { sent.push(t); return Promise.resolve(); } };
  const tauri = { window: { getCurrentWindow: () => w } };
  const win = shellPage({ platform: 'other', tauri });
  assert.deepEqual(sent, ['dark'], 'sent once at start');
  win.prefs.set('theme', 'light');
  win.prefs.set('logFontSize', 15);
  win.prefs.set('theme', 'system');
  win.mm.fire(DARK, false);
  assert.deepEqual(sent, ['dark', 'light', null], 'nothing on an unrelated pref or an OS change while System follows the OS');
  assert.equal(win.$('themeBtn').getAttribute('aria-label'), 'Theme: System. Switch to Dark');
  const macSent = [];
  const mac = shellPage({ platform: 'mac', tauri: { window: { getCurrentWindow: () => ({ setTheme: t => macSent.push(t) }) } } });
  mac.prefs.set('theme', 'light');
  assert.deepEqual(macSent, [], 'the macOS material follows the OS, not the app (spec "Glass gating")');
  const failing = { window: { getCurrentWindow: () => ({ setTheme: () => Promise.reject(new Error('not allowed')) }) } };
  assert.doesNotThrow(() => shellPage({ platform: 'other', tauri: failing }).prefs.set('theme', 'light'), 'a refused permission only warns');
});

test('footer: Settings and Keyboard shortcuts are aria-disabled until P14 and P13, and still have their tooltips', () => {
  const { p, $ } = shellPage();
  for (const [id, name] of [['settingsBtn', 'Settings'], ['shortcutsBtn', 'Keyboard shortcuts']]) {
    assert.deepEqual([$(id).getAttribute('aria-disabled'), $(id).getAttribute('aria-label'), texts(tipOf(p, $(id)))], ['true', name, name]);
  }
});
