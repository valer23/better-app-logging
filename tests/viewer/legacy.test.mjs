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
  'toggleTheme', 'setLogZoom',
  'csvCell', 'formatTs', 'parseIosText', 'parseCsvRows', 'doExport', 'handleFile',
  ...BENCH_BINDINGS,
]);
const prefs = run('ALV.prefs');

test('toggleTheme cycles Dark, Light, System through ALV.prefs', () => {
  prefs.set('theme', 'dark');
  api.toggleTheme();
  assert.equal(prefs.get('theme'), 'light');
  api.toggleTheme();
  assert.equal(prefs.get('theme'), 'system');
  api.toggleTheme();
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
  assert.equal(doc.getElementById('stats').textContent, '0 / 0 lines');
});

test('the page wires both window drag bands through the shell: one mousedown and one dblclick listener each', () => {
  const doc = stickyDocument();
  loadLegacy([], { document: doc });
  for (const id of ['sidebarHeader', 'topbar']) {
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
