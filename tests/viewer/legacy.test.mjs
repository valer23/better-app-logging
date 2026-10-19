// Tests that run the legacy inline script (the last <script> of viewer/applogs-viewer.html) in a vm
// context with stubbed browser globals: its wiring to ALV.prefs, and characterization tests that pin
// today's behaviour of its pure functions so the region PRs (P2 session model, P11 formats.js) can
// prove parity. Deleted with the legacy inline script in P13 (P11 moves the parser tests first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacy, pageScriptSrcs, stickyDocument } from './_load.mjs';

process.env.TZ = 'UTC';   // formatTs formats in local time

const BENCH_BINDINGS = [
  'flushBatch', 'handleWsMsg', 'pendingBatch', 'MAX_RETAINED', 'iosLive', 'liveSession', 'cur',
  'toggleAutoScroll', 'togglePause', 'refreshLiveView', 'FOLLOW_DOM_CAP', 'LIVE_DOM_CAP',
  'fileSession', 'selectSession', 'discardBacklog',
];
// dev-bench.js assigns these top-level bindings, so none of them may be `const`.
const BENCH_REASSIGNED = ['flushBatch', 'iosLive', 'MAX_RETAINED'];

const { api, run } = loadLegacy([
  'setLogZoom',
  'csvCell', 'formatTs', 'parseIosText', 'parseCsvRows', 'doExport', 'handleFile',
  ...BENCH_BINDINGS,
]);
const prefs = run('ALV.prefs');

test('Ctrl+Shift+L (the shell\'s view.theme) cycles Dark, Light, System through ALV.prefs on the page', () => {
  const keys = run('ALV.keys');
  const press = () => keys.dispatch({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, preventDefault() {} }, null);
  prefs.set('theme', 'dark');
  assert.equal(press(), 'view.theme');
  assert.equal(prefs.get('theme'), 'light');
  press();
  assert.equal(prefs.get('theme'), 'system');
  press();
  assert.equal(prefs.get('theme'), 'dark');
});

test('setLogZoom steps the log size within 10..20 and resets to 13 through ALV.prefs', () => {
  api.setLogZoom(0);
  assert.equal(prefs.get('logFontSize'), 13);
  api.setLogZoom(1);
  assert.equal(prefs.get('logFontSize'), 14);
  prefs.set('logFontSize', 20);
  api.setLogZoom(1);
  assert.equal(prefs.get('logFontSize'), 20);
  prefs.set('logFontSize', 10);
  api.setLogZoom(-1);
  assert.equal(prefs.get('logFontSize'), 10);
});

test('the legacy bindings dev-bench.js uses exist and the reassigned ones are not const', () => {
  for (const name of BENCH_BINDINGS) {
    assert.notEqual(api[name], undefined, `${name} is not defined by the legacy script`);
  }
  for (const name of BENCH_REASSIGNED) {
    assert.doesNotThrow(() => run(`${name} = ${name}`), `${name} must be reassignable (not const)`);
  }
});

test('pageScriptSrcs lists the <script src> files in page order and skips inline scripts', () => {
  const html = '<head><script src="assets/js/a.js"></script></head><body><script>x()</script><script src="assets/js/b.js"></script></body>';
  assert.deepEqual(pageScriptSrcs(html), ['assets/js/a.js', 'assets/js/b.js']);
  assert.equal(pageScriptSrcs()[0], 'assets/js/prefs.js');
});

test('a sticky document hands out one stub per id, keeps what the legacy script writes, and has a writable hidden flag', () => {
  const doc = stickyDocument();
  assert.equal(doc.getElementById('stats'), doc.getElementById('stats'));
  assert.equal(doc.getElementById('search').value, '');
  assert.equal(doc.hidden, true);
  doc.hidden = false;
  assert.equal(doc.hidden, false);
  const { run } = loadLegacy([], { document: doc });
  run('updateStats()');
  assert.equal(doc.getElementById('filterCount').textContent, '0 of 0 lines');
});

test('updateStats (every flush) writes the line count and the Retained text only when they change (P4b)', () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  const writes = run(`(() => {
    const seen = { filterCount: 0, retainedText: 0 }, get = document.getElementById;
    const els = { filterCount: { set textContent(v) { seen.filterCount++; } }, retainedText: { title: '', set textContent(v) { seen.retainedText++; } } };
    document.getElementById = id => els[id] || get(id);
    updateStats(); updateStats(); updateStats();
    liveSession.all.push({}); liveSession.filtered.push({});
    updateStats();
    document.getElementById = get;
    return JSON.stringify(seen);
  })()`);
  assert.equal(writes, '{"filterCount":2,"retainedText":2}', 'one write per change, none for a repeat');
});

test('the page wires both window drag bands through the shell: one mousedown and one dblclick listener each', () => {
  const doc = stickyDocument();
  loadLegacy([], { document: doc });
  for (const id of ['sidebarHeader', 'toolbar']) {
    for (const type of ['mousedown', 'dblclick']) assert.equal((doc.listeners.get(`${id}:${type}`) || []).length, 1, `${id}:${type}`);
  }
});

test('csvCell quotes only cells with a comma, quote or newline', () => {
  assert.equal(api.csvCell('plain'), 'plain');
  assert.equal(api.csvCell('a,b'), '"a,b"');
  assert.equal(api.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(api.csvCell('two\nlines'), '"two\nlines"');
  assert.equal(api.csvCell(42), '42');
});

test('formatTs renders a logcat {seconds, nanos} timestamp in local time', () => {
  assert.equal(api.formatTs({ seconds: 1760449423, nanos: 120000000 }), '2025-10-14 13:43:43.120');
  assert.equal(api.formatTs({ seconds: 1760449423 }), '2025-10-14 13:43:43.000');
  assert.equal(api.formatTs(null), '');
});

test('parseIosText strips ANSI colours, maps levels and takes the year from the clock', () => {
  const text = [
    '\x1b[32mOct 14 15:53:43.120456 SpringBoard(FrontBoard)[57] <Notice>: Hello world\x1b[0m',
    '[connected:00008110-000A1B2C3D4E5F60]',
    '',
    'not a syslog line',
    'Oct  4 09:01:02.000001 Bragi AI Dev[812] <Fault>: crash',
    'Oct 14 15:53:44 kernel[0]: no level',
  ].join('\n');
  assert.deepEqual(JSON.parse(JSON.stringify(api.parseIosText(text))), [
    { ts: '2026 Oct 14 15:53:43.120456', pid: 57, tid: 0, tag: 'SpringBoard(FrontBoard)', app: '', lvl: 'INFO', msg: 'Hello world', platform: 'ios' },
    { ts: '2026 Oct  4 09:01:02.000001', pid: 812, tid: 0, tag: 'Bragi AI Dev', app: '', lvl: 'ASSERT', msg: 'crash', platform: 'ios' },
    { ts: '2026 Oct 14 15:53:44', pid: 0, tid: 0, tag: 'kernel', app: '', lvl: 'INFO', msg: 'no level', platform: 'ios' },
  ]);
});

test('parseCsvRows handles quotes, embedded commas and newlines, CRLF and a trailing newline', () => {
  const rows = api.parseCsvRows('a,b,c\r\n"x,1","say ""hi""","two\nlines"\n');
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [['a', 'b', 'c'], ['x,1', 'say "hi"', 'two\nlines']]);
});

const IOS = [
  { ts: '2026 Oct 14 15:53:43.120456', pid: 57, tid: 0, tag: 'SpringBoard(FrontBoard)', app: 'com.apple.springboard', lvl: 'INFO', msg: 'Hello  world, "quoted"', platform: 'ios' },
  { ts: '2026 Oct 14 15:53:43.200001', pid: 812, tid: 0, tag: 'Bragi AI Dev', app: '', lvl: 'ERROR', msg: 'pairing dropped', platform: 'ios' },
];
const ANDROID = [
  { ts: '2026-10-14 15:53:43.120', pid: 4242, tid: 4250, tag: 'BluetoothGatt', app: 'com.bragi.app', lvl: 'WARN', msg: 'onConnectionStateChange status=133', platform: 'android' },
];

// Export through the real doExport (saveFile captured), import through the real handleFile.
async function roundTrip(fmt, messages) {
  run(`liveSession.all = ${JSON.stringify(messages)};
       saveFile = async (name, content) => { globalThis.__saved = { name, content }; };`);
  await api.doExport(fmt);
  const saved = run('globalThis.__saved');
  run('ALV.session.reset(fileSession, []);');   // an unrecognised file leaves the file session as it was
  api.handleFile({ text: saved.content });
  return { name: saved.name, content: saved.content, parsed: JSON.parse(JSON.stringify(run('fileSession.all'))) };
}

test('TXT export of iOS lines re-imports unchanged', async () => {
  const { name, parsed } = await roundTrip('txt', IOS);
  assert.equal(name, 'device_logs_2026-10-14T13-53-43.txt');
  assert.deepEqual(parsed, IOS);
});

test('CSV export re-imports unchanged, both platforms', async () => {
  const { content, parsed } = await roundTrip('csv', [...IOS, ...ANDROID]);
  assert.equal(content.split('\n')[0], 'timestamp,platform,pid,tid,level,tag,app,message');
  assert.deepEqual(parsed, [...IOS, ...ANDROID]);
});

test('JSON export re-imports unchanged, both platforms', async () => {
  const { content, parsed } = await roundTrip('json', [...IOS, ...ANDROID]);
  const doc = JSON.parse(content);
  assert.equal(doc.source, 'device-log-viewer');
  assert.equal(doc.totalLines, 3);
  assert.deepEqual(parsed, [...IOS, ...ANDROID]);
});

test('known gap, fixed in P11: a TXT export of Android lines does not re-import', async () => {
  const { parsed } = await roundTrip('txt', ANDROID);
  assert.deepEqual(parsed, []);   // EXPORTED_TXT_RE only accepts the iOS timestamp shape
});

test('togglePlatform hides and shows one platform\'s lines and keeps the filter bar button in step (P4 sidebar rows)', () => {
  const doc = stickyDocument();
  const { run } = loadLegacy([], { document: doc });
  run('togglePlatform("ios")');
  assert.deepEqual([run('enabledPlatforms.has("ios")'), run('enabledPlatforms.has("android")'), run('filterGen')], [false, true, 1]);
  run('togglePlatform("ios")');
  assert.deepEqual([run('enabledPlatforms.has("ios")'), run('filterGen')], [true, 2]);
});

const LOG = '{"type":"log","ts":"2026 Oct 14 15:53:43","pid":1,"tid":0,"lvl":"INFO","tag":"t","app":"","msg":"m"}';
const DEVICES = '{"type":"devices","data":"[connected:00008110-000A1B2C3D4E5F60]"}';
const STALL = '{"type":"error","data":"iOS log stream stalled — restarting idevicesyslog. Unlock the iPhone."}';
const OTHER_ERROR = '{"type":"error","data":"ios bridge error: spawn idevicesyslog"}';
const DROPPED = '{"type":"dropped","count":3}';

test('the WebSocket handlers count log lines only, and pass every frame on to handleWsMsg unchanged (P4)', () => {
  const doc = stickyDocument();
  const { run } = loadLegacy([], { document: doc });
  run(`document.getElementById('androidDeviceSelect').value = 'a1'; document.getElementById('iosDeviceSelect').value = 'u1';
       globalThis.__seen = []; handleWsMsg = (e, p) => __seen.push([p, e.data]); openAndroid(); openIos();`);
  const frames = [['android', LOG], ['ios', LOG], ['ios', DEVICES], ['ios', LOG], ['ios', OTHER_ERROR], ['ios', DROPPED], ['android', DEVICES]];
  for (const [p, data] of frames) run(`${p === 'ios' ? 'wsIos' : 'wsAndroid'}.onmessage({ data: ${JSON.stringify(data)} })`);
  run('wsIos.onmessage({ data: {} })');   // not text: ignored by the counter
  assert.deepEqual([run('wsLines.android'), run('wsLines.ios')], [1, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(run('__seen'))).slice(0, frames.length), frames, 'handleWsMsg got every frame');
});

test('the iOS stall frame marks the sidebar row stalled whether or not the stream is paused; no other frame does (P4)', () => {
  const doc = stickyDocument();
  const { run } = loadLegacy([], { document: doc });
  run(`document.getElementById('iosDeviceSelect').value = 'u1'; globalThis.__stalls = []; shell = { markStalled: p => __stalls.push(p), sync() {} };
       handleWsMsg = () => {}; openIos(); openAndroid();`);
  const send = (p, data) => run(`${p === 'ios' ? 'wsIos' : 'wsAndroid'}.onmessage({ data: ${JSON.stringify(data)} })`);
  for (const data of [LOG, DEVICES, OTHER_ERROR, DROPPED]) send('ios', data);
  send('android', STALL);
  assert.deepEqual(JSON.parse(JSON.stringify(run('__stalls'))), [], 'only the iOS stall hint counts');
  send('ios', STALL);
  run('livePaused = true');
  send('ios', STALL);
  assert.deepEqual(JSON.parse(JSON.stringify(run('__stalls'))), ['ios', 'ios']);
  assert.equal(run('wsLines.ios'), 1, 'the stall hint is not a line');
});

const NO_DEVICE_IOS = '{"type":"error","data":"No device found. Plug in a device or pass UDID with -u to wait for device to become available."}';
const EXITED_IOS = '{"type":"error","data":"ios bridge error: idevicesyslog exited (EOF)"}';
const UNPLUGGED_IOS = '{"type":"devices","data":"disconnected:00008110-000A1B2C3D4E5F60"}';
const REPLUGGED_IOS = '{"type":"devices","data":"connected:00008110-000A1B2C3D4E5F60"}';
const WAITING_ANDROID = '{"type":"error","data":"- waiting for device -"}';
test('while streaming, the bridge reporting the phone gone sets noDevice (no stall, no stall sheet) until it is back', async () => {
  const p = startPage();
  p.devices('ios', [{ id: 'u1', name: 'iPhone 15' }]); p.devices('android', [{ id: 'a1', name: 'Pixel 8' }]);
  p.run('toggleIos(); toggleAndroid()'); await settle();
  p.run(`wsIos.onopen(); wsAndroid.onopen(); globalThis.__stalls = [];
    shell = { markStalled: q => __stalls.push(q), sync() {}, closeMenus() {} }; liveUi = { sync() {}, closeMenus() {} };`);
  const send = (q, data) => p.run(`${q === 'ios' ? 'wsIos' : 'wsAndroid'}.onmessage({ data: ${JSON.stringify(data)} })`);
  const gone = () => JSON.parse(JSON.stringify(p.run('noDevice')));
  const stalls = () => JSON.parse(JSON.stringify(p.run('__stalls')));
  const sheet = () => p.run(`document.getElementById('stallModal').classList.contains('visible')`);
  send('ios', LOG); send('ios', NO_DEVICE_IOS); send('ios', EXITED_IOS); send('ios', NO_DEVICE_IOS);
  assert.deepEqual([gone().ios, p.run('iosLive')], [true, true], 'the socket stays open');
  send('ios', STALL);
  assert.deepEqual([stalls(), sheet()], [[], false], 'not a stale pair record');
  send('ios', LOG);
  assert.equal(gone().ios, false, 'lines flow again');
  send('ios', STALL);
  assert.deepEqual([stalls(), sheet()], [['ios'], true], 'a real stall still reports');
  send('ios', UNPLUGGED_IOS); assert.equal(gone().ios, true);
  send('ios', REPLUGGED_IOS); assert.equal(gone().ios, false);
  send('android', LOG); send('android', WAITING_ANDROID);
  assert.deepEqual(gone(), { android: true, ios: false });
  send('android', LOG); assert.equal(gone().android, false);
  send('ios', NO_DEVICE_IOS); p.run('toggleIos()');
  assert.deepEqual([p.run('iosLive'), p.sockets().length], [false, 2], 'Stop still stops');
  p.run('toggleIos()'); await settle();
  assert.equal(gone().ios, false, 'a new stream starts clean');
});

test('handleWsMsg still shows the stall sheet for the stall frame unless the stream is paused (P4)', () => {
  const doc = stickyDocument();
  const { run } = loadLegacy([], { document: doc });
  run(`globalThis.__sheet = 0; showStallModal = () => { __sheet++; };`);
  run(`handleWsMsg({ data: ${JSON.stringify(STALL)} }, 'ios'); livePaused = true; handleWsMsg({ data: ${JSON.stringify(STALL)} }, 'ios');`);
  assert.equal(run('__sheet'), 1, 'paused: no sheet');
});

test('showStallModal and showSetup close the sidebar row menus and the toolbar / status-bar menus: #overlayRoot (z 200) would paint them above the modal (P4)', () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  run(`globalThis.__closed = []; shell = { closeMenus: () => { __closed.push('shell'); }, sync() {} }; liveUi = { closeMenus: () => { __closed.push('live'); }, sync() {} };`);
  run(`showStallModal('x')`);
  assert.equal(run('__closed.join()'), 'shell,live', 'the stall modal is opened by a frame, so no pointerdown light dismiss runs');
  run(`showSetup('ios')`);
  assert.equal(run('__closed.join()'), 'shell,live,shell,live');
});

// The legacy side of the shell adapter, against the real legacy code: the fields shellState() returns are what
// shell.js reads, so a typo here fails at runtime only.
const settle = () => new Promise(r => setImmediate(r));

test('shellState has the shape the shell reads: live, status, devices, driverMissing, lines, dropped and enabled', () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  const st = run('shellState()');
  assert.deepEqual(Object.keys(st).sort(), ['buffered', 'cur', 'devices', 'driverMissing', 'dropped', 'enabled', 'gridShown', 'lines', 'live', 'maxRetained', 'noDevice', 'paused', 'sessions', 'status']);
  assert.deepEqual([st.cur === run('liveSession'), st.sessions[0] === run('liveSession'), st.sessions[1] === run('fileSession')], [true, true, true]);
  assert.equal(st.dropped, run('liveSession.dropped'), 'the same object, so a drop shows without a copy');
  assert.equal(st.lines, run('wsLines'));
  assert.equal(st.noDevice, run('noDevice'));
  assert.equal(st.devices, run('deviceInfo'));
  assert.equal(st.status, run('liveStatus'));
  assert.equal(st.enabled, run('enabledPlatforms'));
  assert.deepEqual(JSON.parse(JSON.stringify(st.live)), { android: false, ios: false });
  assert.equal(st.driverMissing, false);
  run('androidLive = true; iosLive = true');
  assert.deepEqual(JSON.parse(JSON.stringify(run('shellState().live'))), { android: true, ios: true }, 'read fresh on each call');
});

test('setStatus feeds the status the rows show; drops land in shellState().dropped', () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  run(`setStatus('ios', 'connecting', 'Connecting…'); setStatus('android', 'error', 'No device');`);
  assert.deepEqual(JSON.parse(JSON.stringify(run('shellState().status'))),
    { android: { state: 'error', text: 'No device' }, ios: { state: 'connecting', text: 'Connecting…' } });
  run(`handleWsMsg({ data: ${JSON.stringify(DROPPED)} }, 'ios');`);
  assert.deepEqual(JSON.parse(JSON.stringify(run('shellState().dropped'))), { android: 0, ios: 3 });
});

test('loadDevices fills deviceInfo on the list, restore, empty and error paths; the iOS driver check fills driverMissing', async () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  run('globalThis.__answers = {}; fetch = url => __answers[url]();');
  const answer = (url, fn) => { run(`__answers[${JSON.stringify(url)}] = ${fn}`); };
  const info = () => JSON.parse(JSON.stringify(run('shellState().devices')));
  const NONE = { id: '', name: '' };
  answer('/devices/android', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'a1', name: 'Pixel 8 Pro' }, { id: 'a2' }] }) })`);
  await run('loadAndroidDevices()');
  assert.deepEqual(info().android, { id: 'a1', name: 'Pixel 8 Pro' }, 'the first device when nothing was picked');
  answer('/devices/android', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'a0', name: 'Old' }, { id: 'a2' }] }) })`);
  run(`document.getElementById('androidDevice' + 'Select').value = 'a2'`);
  await run('loadAndroidDevices()');
  assert.deepEqual(info().android, { id: 'a2', name: 'a2' }, 'the previous pick is restored, and a nameless device is named by its id');
  answer('/devices/android', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [] }) })`);
  await run('loadAndroidDevices()');
  assert.deepEqual(info().android, NONE, 'no device');
  answer('/devices/ios', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'u1', name: 'iPhone 15' }] }) })`);
  answer('/ios-driver-status', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ available: false }) })`);
  await run('loadIosDevices()');
  await settle();
  assert.deepEqual([info().ios, run('shellState().driverMissing')], [{ id: 'u1', name: 'iPhone 15' }, true]);
  answer('/ios-driver-status', `() => Promise.resolve({ ok: true, json: () => Promise.resolve({ available: true }) })`);
  await run('loadIosDevices()');
  await settle();
  assert.equal(run('shellState().driverMissing'), false);
  answer('/devices/ios', `() => Promise.resolve({ ok: false, status: 500 })`);
  answer('/ios-driver-status', `() => Promise.reject(new Error('older backend'))`);
  run('iosDriverMissing = true');
  await run('loadIosDevices()');
  await settle();
  assert.deepEqual([info().ios, run('shellState().driverMissing')], [NONE, false], 'a failed discovery clears the device; a missing endpoint fails open');
});

// ---- Start streaming detects when the picker holds no device (a device plugged in after launch) ----
function startPage() {
  const page = loadLegacy([], { document: stickyDocument() });
  page.run(`globalThis.__answers = {}; fetch = url => __answers[url]();
    globalThis.__sockets = []; WebSocket = function (url) { __sockets.push(url); return { close() {} }; };
    globalThis.__timers = []; setTimeout = (fn, ms) => { __timers.push([fn, ms]); return 0; };
    __answers['/ios-driver-status'] = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ available: true }) });
    document.getElementById('androidDeviceSelect').value = ''; document.getElementById('iosDeviceSelect').value = '';`);
  return { ...page,
    devices: (p, list) => page.run(`__answers['/devices/${p}'] = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: ${JSON.stringify(list)} }) })`),
    fire: ms => page.run(`__timers.filter(t => t[1] === ${ms}).forEach(t => t[0]())`),
    status: p => JSON.parse(JSON.stringify(page.run(`liveStatus.${p}`))),
    sockets: () => JSON.parse(JSON.stringify(page.run('__sockets'))) };
}

test('Start streaming with no device picked detects first, then connects an iPhone plugged in while Android streams', async () => {
  const p = startPage();
  p.run('androidLive = true');
  p.devices('ios', [{ id: 'u1', name: 'iPhone 15' }]);
  p.run('toggleIos()');                                 // the row's Start / More "Start streaming"
  assert.deepEqual(p.status('ios'), { state: 'connecting', text: 'Connecting…' }, 'detecting: the row is busy');
  assert.deepEqual(p.sockets(), [], 'no socket before a device is known');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('deviceInfo.ios'))), { id: 'u1', name: 'iPhone 15' });
  assert.deepEqual(p.sockets(), ['ws://localhost:8766']);
  assert.deepEqual([p.run('androidLive'), p.run('detecting.ios')], [true, null]);
});

test('Start streaming keeps "No device" when detection finds none or fails, and opens no socket', async () => {
  const p = startPage();
  p.devices('android', []);
  p.run('toggleAndroid()'); await settle();
  assert.deepEqual(p.status('android'), { state: 'error', text: 'No device' });
  assert.equal(p.run(`document.getElementById('androidBtn').disabled`), false, 'the legacy Connect is usable again');
  p.run(`__answers['/devices/ios'] = () => Promise.resolve({ ok: false, status: 500 })`);
  p.run('connectIos()'); await settle();
  assert.deepEqual([p.status('ios'), p.sockets()], [{ state: 'error', text: 'No device' }, []]);
  p.fire(1500);
  assert.deepEqual([p.status('android').state, p.status('ios').state], ['disconnected', 'disconnected']);
});

test('a second Start while detecting opens one socket; a Stop meanwhile drops it; a hung detection gives up', async () => {
  const p = startPage();
  p.run(`globalThis.__release = []; __answers['/devices/ios'] = () => new Promise(r => __release.push(() =>
    r({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'u1', name: 'iPhone 15' }] }) })));`);
  p.run('toggleIos(); toggleIos()');
  p.run(`document.getElementById('iosDeviceSelect').value = 'u1'; connectIos()`);   // a startup list lands, then Connect
  assert.deepEqual([p.run('__release.length'), p.sockets()], [1, []]);
  p.run('__release[0]()'); await settle();
  assert.deepEqual(p.sockets(), ['ws://localhost:8766'], 'exactly one socket');
  p.run(`wsIos = null; document.getElementById('iosDeviceSelect').value = ''; __release = []; connectIos(); disconnectIos();`);
  p.run('__release[0]()'); await settle();
  assert.deepEqual([p.sockets().length, p.status('ios').state], [1, 'disconnected'], 'a late answer after Stop connects nothing');
  p.run(`__timers = []; __release = []; document.getElementById('iosDeviceSelect').value = ''; connectIos();`);   // the late list above filled the picker
  p.fire(8000); await settle();
  assert.deepEqual([p.status('ios'), p.run('detecting.ios')], [{ state: 'error', text: 'No device' }, null]);
  p.run('__release[0]()'); await settle();
  assert.equal(p.sockets().length, 1, 'the late list fills the picker only');
});

test('Start streaming re-detects although the picker holds a device: unplugged, "No device" and no socket, the row drops the device; plugged, it connects', async () => {
  const p = startPage();
  p.run(`globalThis.__asked = []; (f => { fetch = url => { __asked.push(url); return f(url); }; })(fetch);
    document.getElementById('iosDeviceSelect').value = 'u1'; deviceInfo.ios = { id: 'u1', name: 'iPhone 15' };
    document.getElementById('androidDeviceSelect').value = 'a1'; deviceInfo.android = { id: 'a1', name: 'Pixel 8' };`);   // detected at launch, unplugged since
  p.devices('ios', []); p.devices('android', []);
  p.run('toggleIos()');
  assert.deepEqual([p.status('ios'), p.sockets()], [{ state: 'connecting', text: 'Connecting…' }, []], 'the picker is not trusted');
  await settle();
  assert.deepEqual([p.status('ios'), p.sockets()], [{ state: 'error', text: 'No device' }, []]);
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('deviceInfo.ios'))), { id: '', name: '' }, 'no stale "Ready · stopped"');
  p.fire(1500);
  assert.deepEqual(p.status('ios'), { state: 'disconnected', text: 'Disconnected' });
  p.run('connectAndroid()'); await settle();   // the legacy Connect: same path
  assert.deepEqual([p.status('android'), p.sockets()], [{ state: 'error', text: 'No device' }, []]);
  p.devices('ios', [{ id: 'u1', name: 'iPhone 15' }]);
  p.run('toggleIos()'); await settle();
  assert.deepEqual(p.sockets(), ['ws://localhost:8766'], 'plugged back in: it connects');
  assert.equal(p.run(`__asked.filter(u => u === '/devices/ios').length`), 2, 'one detection per Start');
});

// ---- The Liquid Glass switch moved into the toolbar's More menu (P4b): setGlass and its startup re-sync ----

// A fetch that records the requests and answers 200.
function glassPage(o) {
  const calls = [];
  const fetchImpl = (url, init) => { calls.push([url, init.method, init.headers['Content-Type'], init.body]); return Promise.resolve({ ok: true, status: 200 }); };
  const page = loadLegacy(['setGlass', 'postIosQuiet'], { document: stickyDocument(), fetchImpl, ...o });
  return { ...page, calls, prefs: page.run('ALV.prefs') };
}

test('setGlass stores the material and, on macOS, POSTs it to /window/glass-mode as {enabled}', () => {
  const { api, calls, prefs } = glassPage({ platform: 'mac' });
  assert.deepEqual(calls, [], 'solid at startup: nothing to sync');
  api.setGlass(true);
  assert.equal(prefs.get('material'), 'glass');
  assert.deepEqual(calls, [['/window/glass-mode', 'POST', 'application/json', '{"enabled":true}']]);
  api.setGlass(false);
  assert.equal(prefs.get('material'), 'solid');
  assert.deepEqual(calls.at(-1), ['/window/glass-mode', 'POST', 'application/json', '{"enabled":false}']);
  assert.equal(calls.length, 2);
});

test('setGlass never calls the window endpoint off macOS (the preference is still kept)', () => {
  const { api, calls, prefs } = glassPage({ platform: 'win32' });
  api.setGlass(true);
  assert.deepEqual([prefs.get('material'), calls], ['glass', []]);
});

test('a saved Glass material re-syncs the native window at startup on macOS only (the macOS conf starts with no effects)', () => {
  const saved = { stored: { 'applogs-viewer.material': 'glass' } };
  assert.deepEqual(glassPage({ platform: 'mac', ...saved }).calls, [['/window/glass-mode', 'POST', 'application/json', '{"enabled":true}']]);
  assert.deepEqual(glassPage({ platform: 'mac', stored: { 'applogs-viewer.material': 'solid' } }).calls, [], 'solid: nothing to sync');
  assert.deepEqual(glassPage({ platform: 'win32', ...saved }).calls, [], 'not macOS: no native effect');
});

test('Quiet system noise: a saved "on" is re-sent at startup (the bridge starts off); postIosQuiet POSTs {on} and rejects on an HTTP error', async () => {
  assert.deepEqual(glassPage({ stored: { 'applogs-viewer.settings': JSON.stringify({ iosQuiet: 'on' }) } }).calls,
    [['/ios/quiet', 'POST', 'application/json', '{"on":true}']]);
  const { api, calls } = glassPage({});
  assert.deepEqual(calls, [], 'off (the default): nothing to sync');
  await api.postIosQuiet(false);
  assert.deepEqual(calls, [['/ios/quiet', 'POST', 'application/json', '{"on":false}']]);
  const bad = loadLegacy(['postIosQuiet'], { document: stickyDocument(), fetchImpl: () => Promise.resolve({ ok: false, status: 403 }) });
  await assert.rejects(bad.api.postIosQuiet(true), /403/);
});

test('shellState().gridShown: true only while #logWrapper shows and no legacy modal is open (the stream keys wait otherwise)', () => {
  const { run } = loadLegacy([], { document: stickyDocument() });
  run("showOnly('livePanel')");
  assert.equal(run('shellState().gridShown'), false, 'the device cards');
  run("showOnly('logWrapper')");
  assert.equal(run('shellState().gridShown'), true);
  run("document.getElementById('setupModal').classList.add('modal-overlay', 'visible')");
  assert.equal(run('shellState().gridShown'), false, 'the setup guide scrolls with Home and End');
});
