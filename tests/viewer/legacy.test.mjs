// Tests that run the legacy inline script (the last <script> of viewer/applogs-viewer.html) in a vm
// context with stubbed browser globals: its wiring to ALV.prefs, and characterization tests that pin
// today's behaviour of its pure functions so the region PRs (P2 session model, P11 formats.js) can
// prove parity. Deleted with the legacy inline script in P13 (P11 moves the parser tests first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacy } from './_load.mjs';

process.env.TZ = 'UTC';   // formatTs formats in local time

const BENCH_BINDINGS = [
  'flushBatch', 'handleWsMsg', 'pendingBatch', 'MAX_RETAINED', 'iosLive', 'autoScroll',
  'toggleAutoScroll', 'togglePause', 'refreshLiveView', 'FOLLOW_DOM_CAP', 'LIVE_DOM_CAP',
  'allMessages', 'discardedCount',
];
// dev-bench.js assigns these top-level bindings, so none of them may be `const`.
const BENCH_REASSIGNED = ['flushBatch', 'iosLive', 'MAX_RETAINED'];

const { api, run } = loadLegacy([
  'toggleTheme', 'setLogZoom',
  'firstIndexWhere', 'csvCell', 'formatTs', 'parseIosText', 'parseCsvRows', 'doExport', 'handleFile',
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
