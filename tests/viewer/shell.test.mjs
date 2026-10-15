// The app shell (viewer/assets/js/shell.js, roadmap P4). ALV.shellPure runs in an EMPTY vm context: the
// thin-space number format, the rate format and meter, the device status line and the theme button view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';

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
