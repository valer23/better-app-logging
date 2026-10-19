// The app shell (viewer/assets/js/shell.js, roadmap P4). ALV.shellPure runs in an EMPTY vm context: the
// thin-space number format, the rate format and meter, the device status line and the theme button view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule, read, HTML_PATH } from './_load.mjs';
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
  assert.deepEqual(st({ live: true, noDevice: true, stalledFor: 15, detected: true }), { state: 'disconnected', tone: 'idle', text: 'Disconnected', drops: '' }, 'phone gone: ahead of a stall');
  assert.equal(st({ noDevice: true, detected: true }).text, 'Ready · stopped', 'only an open stream');
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
  p.byId.toolbar.appendChild(ctl);
  p.ALV.createShell({ doc: p.doc, win: p.win, dom: p.dom });
  const move = (x, y) => p.win.listeners.mousemove.forEach(fn => fn({ clientX: x, clientY: y }));
  const up = () => p.win.listeners.mouseup.forEach(fn => fn({}));
  return { p, ctl, move, up };
}

test('drag bands: the sidebar header and the toolbar; one window listener pair for both', () => {
  assert.deepEqual([...ALV.shellPure.DRAG_BANDS], ['sidebarHeader', 'toolbar']);
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
  p.byId.toolbar.fire('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 20 });
  up();
  move(200, 20);
  assert.deepEqual(t.calls, ['drag'], 'mouseup disarms');
  ctl.fire('mousedown', { button: 0, detail: 1, clientX: 100, clientY: 20 });
  move(200, 20);
  p.byId.toolbar.fire('mousedown', { button: 2, detail: 1, clientX: 100, clientY: 20 });
  move(200, 20);
  p.byId.toolbar.fire('mousedown', { button: 0, detail: 2, clientX: 100, clientY: 20 });
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
    bare.p.byId.toolbar.fire('mousedown', { button: 0, detail: 1, clientX: 0, clientY: 0 });
    bare.move(50, 50);
    bare.p.byId.toolbar.fire('dblclick', {});
  });
});

// A double-click is counted by the OS by time and position, not by DOM node: pressing the sidebar toggle twice
// changes the layout on the first click (248 px sidebar <-> 52 px rail), so the second press lands on whatever
// is under the pointer now (the toolbar's background, or the sidebar header's title) and the dblclick goes there.
test('drag bands: a double-click whose first press was on a control never maximises, even when the second press lands on a background (review F2)', () => {
  const t = fakeTauri();
  const { p, ctl } = bandPage(t);
  ctl.fire('mousedown', { button: 0, detail: 1, clientX: 225, clientY: 26 });
  p.byId.toolbar.fire('mousedown', { button: 0, detail: 2, clientX: 225, clientY: 26 });   // the layout moved: now over the toolbar background
  p.byId.toolbar.fire('dblclick', {});
  assert.deepEqual(t.calls, [], 'the first press was on a control: not a window double-click');
  // The other direction: the toolbar control is pressed, the second press lands in the sidebar header band.
  ctl.fire('mousedown', { button: 0, detail: 1, clientX: 26, clientY: 26 });
  p.byId.sidebarHeader.fire('mousedown', { button: 0, detail: 2, clientX: 26, clientY: 26 });
  p.byId.sidebarHeader.fire('dblclick', {});
  assert.deepEqual(t.calls, [], 'the guard is shared by both bands');
  // A new sequence on the background is a window double-click again.
  p.byId.toolbar.fire('mousedown', { button: 0, detail: 1, clientX: 400, clientY: 26 });
  p.byId.toolbar.fire('mousedown', { button: 0, detail: 2, clientX: 400, clientY: 26 });
  p.byId.toolbar.fire('dblclick', {});
  assert.deepEqual(t.calls, ['max']);
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

test('SESSIONS: a row is named by its label alone; the line count (rewritten twice a second) is aria-hidden, never part of the name', () => {
  const { p, live, file, $ } = shellPage();
  live.all = new Array(48310);
  file.all = new Array(12044);
  file.name = 'pixel-crash-0412.logcat';
  p.advance(500);
  for (const [btn, count, name] of [['sessLive', 'sessLiveCount', 'sessLiveName'], ['sessFile', 'sessFileCount', 'sessFileName']]) {
    const by = $(btn).getAttribute('aria-labelledby');
    assert.equal(by, name, `${btn} is named by its label span`);
    assert.notEqual(by, count);
    assert.ok($(btn).children.includes(p.byId[by]), `${btn}: the label is inside the button`);
    assert.equal($(count).getAttribute('aria-hidden'), 'true', `${count} stays out of the accessible name`);
  }
  assert.equal($('sessFileName').textContent, 'pixel-crash-0412.logcat', 'the file row is named by the file name');
  assert.match(read(HTML_PATH), /id="sessLiveName">Live session<\/span>/, 'the Live row is named "Live session"');
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

test('DEVICES: an open stream whose phone is gone reads "Disconnected" and keeps Stop until lines flow again', () => {
  const { p, state } = shellPage({ st: { live: { android: false, ios: true }, devices: { android: { id: '', name: '' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  const i = parts(row(p, 'ios'));
  state.noDevice.ios = true; p.advance(500);
  assert.deepEqual([i.status.textContent, row(p, 'ios').getAttribute('data-state'), i.start.getAttribute('aria-label')], ['Disconnected', 'disconnected', 'Stop streaming iPhone 15']);
  state.noDevice.ios = false; state.lines.ios += 1; p.advance(500);
  assert.match(i.status.textContent, /^Streaming · /);
});

test('DEVICES: the toggle is named by the device alone; the status and drops lines describe it', () => {
  const { p, state, shell } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const a = parts(row(p, 'android'));
  const labelledby = a.main.getAttribute('aria-labelledby');
  assert.equal(p.byId[labelledby].textContent, 'Pixel 8 Pro', 'the name span');
  assert.deepEqual(a.main.getAttribute('aria-describedby').split(' '), [a.status.getAttribute('id'), a.drops.getAttribute('id')], 'and nothing else: the rail tooltip repeats the name, so it is not a description (review F6)');
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
  assert.deepEqual(iosItems.map(texts), ['Start streaming', '', 'Quiet system noise', '', 'Re-pair iPhone', 'Setup guide'], 'iOS: Quiet system noise in its own group');
  iosItems[4].click();
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

test('DEVICES: closeMenus() closes an open row menu without moving focus (a modal opened by a frame must not sit under it)', () => {
  const { p, shell } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  const a = parts(row(p, 'android'));
  const i = parts(row(p, 'ios'));
  i.more.click();
  assert.deepEqual([i.more.getAttribute('aria-expanded'), p.keys.escDepth()], ['true', 1]);
  const before = p.doc.activeElement;
  shell.closeMenus();
  assert.deepEqual([i.more.getAttribute('aria-expanded'), p.keys.escDepth(), p.doc.activeElement === before], ['false', 0, true]);
  assert.equal(a.more.getAttribute('aria-expanded'), 'false');
  assert.doesNotThrow(() => shell.closeMenus(), 'nothing open: a no-op');
});

// ---- Footer: the theme cycle (⇧⌘L) and the Windows caption ----

const tipOf = (p, btn) => p.byId[btn.getAttribute('aria-describedby').split(' ').at(-1)];   // the tooltip is the last token

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

test('⌘O and ⇧⌘L work from inside a text field (inText), and an unmodified key does not', () => {
  const { p, prefs, calls } = shellPage();
  const field = p.doc.createElement('input');
  field.setAttribute('type', 'text');
  const ev = (o, ctx) => ({ preventDefault() {}, ...o, ...ctx });
  assert.equal(p.keys.dispatch(ev({ key: 'o', code: 'KeyO', metaKey: true }), field), 'session.open', '⌘O in the search box');
  assert.equal(calls.at(-1)[0], 'openFile');
  const was = prefs.get('theme');
  assert.equal(p.keys.dispatch(ev({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true }), field), 'view.theme', '⇧⌘L in the search box');
  assert.notEqual(prefs.get('theme'), was);
  assert.equal(p.keys.dispatch(ev({ key: 'o', code: 'KeyO' }), field), null, 'a plain "o" is typed, not a command');
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

// ---- The collapsed rail (⌘B; spec Open item 5 for macOS) ----

test('rail: the header toggle and ⌘B collapse and expand the sidebar through prefs; label, aria-expanded and tooltip follow', () => {
  const { p, prefs, $ } = shellPage();
  const t = $('sidebarToggle');
  assert.deepEqual([t.getAttribute('aria-label'), t.getAttribute('aria-expanded'), t.getAttribute('aria-controls'), texts(tipOf(p, t))],
    ['Hide sidebar', 'true', 'sidebarBody', 'Hide sidebar⌘B']);
  p.focus(t);
  t.click();
  assert.deepEqual([prefs.get('sidebar'), t.getAttribute('aria-label'), t.getAttribute('aria-expanded'), texts(tipOf(p, t))],
    ['collapsed', 'Show sidebar', 'false', 'Show sidebar⌘B']);
  assert.equal(p.doc.activeElement, t, 'one toggle element, so focus never jumps');
  assert.equal(p.keys.dispatch({ key: 'b', code: 'KeyB', metaKey: true, preventDefault() {} }, p.byId.filterbar), 'view.sidebar');
  assert.equal(prefs.get('sidebar'), 'expanded');
});

test('rail: focus on an item the rail hides moves to the toggle, from a row\'s Start/Stop or its open menu to its More; focus on a rail item stays', () => {
  const { p, prefs, $ } = shellPage();
  p.focus($('openFileBtn'));
  prefs.set('sidebar', 'collapsed');
  assert.equal(p.doc.activeElement, $('sidebarToggle'));
  prefs.set('sidebar', 'expanded');
  p.focus($('sessHead'));
  prefs.set('sidebar', 'collapsed');
  assert.equal(p.doc.activeElement, $('sidebarToggle'), 'section heads are not in the rail either');
  prefs.set('sidebar', 'expanded');
  p.focus($('sessLive'));
  prefs.set('sidebar', 'collapsed');
  assert.equal(p.doc.activeElement, $('sessLive'));
  prefs.set('sidebar', 'expanded');
  const a = parts(row(p, 'android'));
  p.focus(a.start);
  prefs.set('sidebar', 'collapsed');
  assert.equal(p.doc.activeElement, a.more, 'the rail hides the row\'s Start/Stop button: focus goes to its More, whose first item is Start/Stop');
  prefs.set('sidebar', 'expanded');
  a.more.click();
  assert.equal(p.keys.escDepth(), 1, 'the row menu is open, focus in it');
  prefs.set('sidebar', 'collapsed');
  assert.deepEqual([a.more.getAttribute('aria-expanded'), p.keys.escDepth(), p.doc.activeElement], ['false', 0, a.more],
    'the menu was placed against the expanded row: it closes, and its focus goes back to the More it belongs to');
});

test('rail: a device row\'s More stays in the rail: by keyboard it opens on Start / Stop streaming, which streams the device (P4b judge follow-up)', () => {
  const { p, shell, state, prefs, calls } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: 'u1', name: 'iPhone 15' } } } });
  prefs.set('sidebar', 'collapsed');
  const i = parts(row(p, 'ios'));
  assert.equal(i.start.className, 'icon-btn sm dev-start', 'shell.css hides the row\'s own Start/Stop in the rail, by this class');
  p.focus(i.more);
  i.more.fire('keydown', { key: 'ArrowDown' });
  const items = p.byId[i.more.getAttribute('aria-controls')].children;
  assert.deepEqual([i.more.getAttribute('aria-expanded'), p.doc.activeElement, texts(items[0])], ['true', items[0], 'Start streaming'],
    'ArrowDown (or Enter / Space, which click it) opens the menu on its first item');
  items[0].click();
  assert.deepEqual(calls.at(-1), ['toggleStream', 'ios']);
  assert.equal(p.doc.activeElement, i.more, 'choosing an item closes the menu and returns to More');
  state.live.ios = true;
  shell.sync();
  i.more.click();
  assert.equal(texts(items[0]), 'Stop streaming', 'the same menu stops a streaming device');
  prefs.set('theme', 'light');
  assert.equal(i.more.getAttribute('aria-expanded'), 'true', 'a preference change that is not a flip leaves the open menu alone');
  prefs.set('sidebar', 'expanded');
  assert.deepEqual([i.more.getAttribute('aria-expanded'), p.keys.escDepth()], ['false', 0], 'expanding moves More: the menu placed against the rail closes');
});

test('rail: the More tooltip follows the rail to the right, like every other rail item', () => {
  const { p, prefs } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const a = parts(row(p, 'android'));
  const tip = tipOf(p, a.more);
  prefs.set('sidebar', 'collapsed');
  a.more.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.deepEqual([tip.hidden, texts(tip), tip.style.left], [false, 'More for Pixel 8 Pro', '586px'], 'to the right of the 80 px fake anchor');
});

// The rail tip repeats the item's name (its visually hidden label), so it is not wired to aria-describedby: a
// hidden element a describedby points to still counts toward the description, and the expanded sidebar would
// read every name twice ("Live session, button, Live session"; review F6). The tip is found by its text.
const railTipFor = (p, text) => p.byId.ovTips.children.find(t => t.attrs.role === 'tooltip' && texts(t) === text);

test('rail: nav items and device rows get a tooltip on the right, shown only while collapsed', () => {
  const { p, prefs, $ } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const live = $('sessLive');
  const dev = parts(row(p, 'android')).main;
  for (const [el, text] of [[live, 'Live session'], [dev, 'Pixel 8 Pro']]) {
    el.fire('pointerenter', { pointerType: 'mouse' });
    p.advance(400);
    assert.equal(railTipFor(p, text).hidden, true, 'expanded: the label is visible, no tooltip');
    el.fire('pointerleave');
    p.advance(100);
  }
  prefs.set('sidebar', 'collapsed');
  for (const [el, text] of [[live, 'Live session'], [dev, 'Pixel 8 Pro'], [$('cmdTrigger'), 'Search actions']]) {
    const tip = railTipFor(p, text);
    el.fire('pointerenter', { pointerType: 'mouse' });
    p.advance(400);
    assert.deepEqual([tip.hidden, texts(tip), tip.style.left], [false, text, '586px'], `${text}: to the right`);
    el.fire('pointerleave');
    p.advance(100);
  }
});

test('rail: the rail tooltips are not descriptions, so the expanded sidebar reads each name once (review F6)', () => {
  const { p, $ } = shellPage({ st: { devices: { android: { id: 'a1', name: 'Pixel 8 Pro' }, ios: { id: '', name: '' } } } });
  const tipIds = new Set(p.byId.ovTips.children.map(t => t.attrs.id));
  const described = el => (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  for (const el of [$('sessLive'), $('cmdTrigger'), parts(row(p, 'android')).main, parts(row(p, 'ios')).main]) {
    assert.deepEqual(described(el).filter(id => tipIds.has(id)), [], `${el.getAttribute('id') || el.textContent}: no tooltip in its description`);
  }
  assert.equal($('sessLive').getAttribute('aria-describedby'), null);
  assert.deepEqual(described($('themeBtn')).filter(id => tipIds.has(id)).length, 1, 'a tooltip that adds information (the theme\'s) still describes its button');
});

// One rule for every sidebar-owned tooltip: expanded, it sits below its trigger (never beside it: in the
// footer row a right tip would cover the next button, and a tip is hoverable); collapsed, it sits to the right
// (spec). The toggle carries aria-expanded as a disclosure, so it must show in both states.
test('tooltips: the toggle and the footer buttons show in both states, below when expanded and to the right in the rail', () => {
  const { p, prefs, $ } = shellPage();
  const shownAt = btn => {
    btn.fire('pointerenter', { pointerType: 'mouse' });
    p.advance(400);
    const tip = tipOf(p, btn);
    const at = [tip.hidden, tip.style.left];
    btn.fire('pointerleave');
    p.advance(100);
    return at;
  };
  for (const [state, onRight] of [['expanded', false], ['collapsed', true]]) {
    prefs.set('sidebar', state);
    for (const id of ['sidebarToggle', 'settingsBtn', 'themeBtn']) {
      const [hidden, left] = shownAt($(id));
      assert.equal(hidden, false, `${state}: #${id} has a tooltip`);
      assert.equal(left === '586px', onRight, `${state}: #${id} ${onRight ? 'to the right' : 'not beside it'} (left ${left})`);
    }
  }
});

test('rail: ⌘B does nothing over the legacy setup or stall modal (collapsing would move focus behind it)', () => {
  const { p, prefs } = shellPage();
  const modal = p.doc.createElement('div');
  modal.className = 'modal-overlay visible';
  p.doc.body.appendChild(modal);
  const cmdB = () => p.keys.dispatch({ key: 'b', code: 'KeyB', metaKey: true, preventDefault() {} }, p.byId.filterbar);
  assert.deepEqual([cmdB(), prefs.get('sidebar')], [null, 'expanded']);
  modal.className = 'modal-overlay';
  assert.deepEqual([cmdB(), prefs.get('sidebar')], ['view.sidebar', 'collapsed'], 'a closed modal does not block it');
});

// ---- Quiet system noise (iOS) ----

const IOS = () => ({ live: { android: false, ios: true }, devices: { android: { id: '', name: '' }, ios: { id: 'u1', name: 'iPhone Val' } } });
const quietOf = (p, more) => p.byId[more.getAttribute('aria-controls')].children.find(n => n.getAttribute('role') === 'menuitemcheckbox');
const flush = () => new Promise(r => setImmediate(r));

test('deviceStatus: quiet adds "· quiet" while the iPhone streams, stalls or is ready, nowhere else', () => {
  const b = { live: true, state: 'connected', text: 'Connected', detected: true, driverMissing: false, stalledFor: -1, rate: 842, dropped: 0, quiet: true };
  assert.equal(S.deviceStatus(b).text, 'Streaming · 842/s · quiet');
  assert.equal(S.deviceStatus({ ...b, stalledFor: 15 }).text, 'Stalled 15 s · quiet');
  assert.equal(S.deviceStatus({ ...b, live: false }).text, 'Ready · stopped · quiet');
  assert.equal(S.deviceStatus({ ...b, live: false, state: 'connecting' }).text, 'Connecting…');
  assert.equal(S.deviceStatus({ ...b, live: false, state: 'error', text: 'No device' }).text, 'No device');
  assert.equal(S.deviceStatus({ ...b, live: false, driverMissing: true }).text, 'Driver missing');
  assert.equal(S.deviceStatus({ ...b, live: false, detected: false }).text, 'Disconnected');
  assert.equal(S.deviceStatus({ ...b, quiet: false }).text, 'Streaming · 842/s');
});

test('Quiet system noise: a checkbox between Start/Stop and Re-pair that stays open, persists, asks the bridge, shows "· quiet" and one keyed toast', () => {
  const { p, calls, prefs } = shellPage({ st: IOS() });
  const i = parts(row(p, 'ios'));
  i.more.click();
  const m = p.byId[i.more.getAttribute('aria-controls')];
  assert.deepEqual(m.children.map(n => n.getAttribute('role')), ['menuitem', 'separator', 'menuitemcheckbox', 'separator', 'menuitem', 'menuitem']);
  const q = quietOf(p, i.more);
  assert.deepEqual([texts(q), q.getAttribute('aria-checked'), calls.length], ['Quiet system noise', 'false', 0], 'nothing is sent until it changes');
  q.click();
  assert.deepEqual([i.more.getAttribute('aria-expanded'), q.getAttribute('aria-checked'), prefs.getSettings().iosQuiet, calls.at(-1)],
    ['true', 'true', 'on', ['setIosQuiet', true]]);
  assert.equal(i.status.textContent, 'Streaming · 0/s · quiet');
  assert.match(texts(p.byId.toastLive), /^Quiet system noise on/);
  q.click();
  assert.equal(p.byId.toastLive.children.length, 1, 'keyed: replaced, not stacked');
  assert.match(texts(p.byId.toastLive), /^Quiet system noise off/);
  assert.deepEqual([i.status.textContent, calls.at(-1)], ['Streaming · 0/s', ['setIosQuiet', false]]);
  const a = parts(row(p, 'android'));
  a.more.click();
  assert.equal(quietOf(p, a.more), undefined, 'Android: no Quiet system noise');
});

test('Quiet system noise: a failed request puts the choice back with a Retry error; an older failure never undoes a newer choice', async () => {
  let fail = true;
  const { p, prefs } = shellPage({ st: IOS(), actions: { setIosQuiet: on => (fail && on ? Promise.reject(new Error('down')) : Promise.resolve()) } });
  const i = parts(row(p, 'ios'));
  i.more.click();
  const q = quietOf(p, i.more);
  q.click();
  await flush();
  assert.deepEqual([prefs.getSettings().iosQuiet, q.getAttribute('aria-checked'), i.status.textContent], ['off', 'false', 'Streaming · 0/s']);
  const err = p.byId.toastAlerts.children[0];
  assert.deepEqual([err.getAttribute('role'), texts(err).startsWith('Quiet system noise did not change'), p.byId.toastLive.children.length],
    ['alert', true, 0], 'the keyed toast moved to the alert region');
  fail = false;
  err.children[2].click();   // Retry
  await flush();
  assert.deepEqual([prefs.getSettings().iosQuiet, q.getAttribute('aria-checked')], ['on', 'true']);
  fail = true;
  q.click();   // off: succeeds
  q.click();   // on: fails…
  q.click();   // …but off came after it
  await flush();
  assert.equal(prefs.getSettings().iosQuiet, 'off', 'the newest choice stands');
});

test('loud watch: once, when a 10 s window averages over 3 000/s while armed; bursts count, disarming restarts the window', () => {
  const w = S.createLoudWatch({ over: 3000, forMs: 10000 });
  // a steady 6 200/s: the count grows by 3 100 every 500 ms
  assert.deepEqual([w.step(0, 0, true), w.step(9500, 58900, true), w.step(10000, 62000, true), w.step(10500, 65100, true)], [false, false, true, false]);
  assert.equal(w.rate(), 6200);
  // bursty: 9 000 lines in one second, 1 000 in the next, and so on (5 000/s on average, a 1 s rate dips to 1 000)
  const b = S.createLoudWatch({ over: 3000, forMs: 10000 });
  const fired = [];
  for (let s = 0; s <= 10; s++) fired.push(b.step(s * 1000, Math.ceil(s / 2) * 9000 + Math.floor(s / 2) * 1000, true));
  assert.deepEqual([fired.slice(0, 10).includes(true), fired[10]], [false, true], 'fires on the window, not on a dip');
  // a quiet phone never fires, however long
  const q = S.createLoudWatch({ over: 3000, forMs: 10000 });
  assert.deepEqual([0, 20000, 40000, 60000].map(t => q.step(t, t / 10, true)), [false, false, false, false]);
  // disarmed: the window restarts
  const d = S.createLoudWatch({ over: 3000, forMs: 10000 });
  d.step(0, 0, true); d.step(5000, 31000, false);
  assert.equal(d.step(12000, 74000, true), false);
});

test('Quiet system noise hint: over 3 000 lines/s for 10 s with quiet off, once ever; Turn on enables it', () => {
  const { p, prefs, calls, state } = shellPage({ st: IOS() });
  for (let k = 0; k < 24; k++) { state.lines.ios += 3100; p.advance(500); }
  const t = p.byId.toastLive.children[0];
  assert.match(texts(t), new RegExp(`^iPhone Val is sending 6${T}200 lines/s`));
  assert.equal(prefs.getSettings().iosQuietHint, 'seen', 'stored before it shows');
  t.children[2].click();
  assert.deepEqual([prefs.getSettings().iosQuiet, calls.at(-1)], ['on', ['setIosQuiet', true]]);
  prefs.patchSettings({ iosQuiet: 'off' });
  for (let k = 0; k < 40; k++) { state.lines.ios += 3100; p.advance(500); }
  assert.ok(!texts(p.byId.toastLive).includes('is sending'), 'never twice');
});

test('Quiet system noise hint: a bursty iPhone and a viewer that drops lines still trigger it', () => {
  const bursty = shellPage({ st: IOS() });
  for (let k = 0; k < 30; k++) { bursty.state.lines.ios += k % 4 < 2 ? 8000 : 400; bursty.p.advance(500); }   // avg 2 100 per 500 ms: ~4 200/s, 1 s rate dips to 1 700
  assert.match(texts(bursty.p.byId.toastLive), /is sending/, 'bursts average over the window');
  const behind = shellPage({ st: IOS() });
  for (let k = 0; k < 30; k++) { behind.state.lines.ios += 1000; behind.state.dropped.ios += 2500; behind.p.advance(500); }   // 2 000 received/s, 5 000 dropped/s
  assert.match(texts(behind.p.byId.toastLive), new RegExp(`is sending 7${T}000 lines/s`), 'lines the backend dropped count');
  const calm = shellPage({ st: IOS() });
  for (let k = 0; k < 60; k++) { calm.state.lines.ios += 400; calm.p.advance(500); }   // 800/s
  assert.ok(!texts(calm.p.byId.toastLive).includes('is sending'), 'a calm phone gets no hint');
});

test('a stall on a Quiet iPhone says 60 s: the bridge waits longer while -q hides most lines', () => {
  assert.equal(S.STALL_SECONDS_QUIET, 60);
  const { p, shell, prefs } = shellPage({ st: IOS() });
  const i = parts(row(p, 'ios'));
  shell.markStalled('ios');
  assert.equal(i.status.textContent, 'Stalled 15 s');
  prefs.patchSettings({ iosQuiet: 'on' });
  shell.sync();
  assert.equal(i.status.textContent, 'Stalled 60 s · quiet');
});
