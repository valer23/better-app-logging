// Legacy parity (roadmap P6 acceptance): the filter bar's old search, Aa, .*, Tag, PID / App, level and platform
// filters equal compile() of their translation into query text (ALV.query.fromLegacy), line by line, on a corpus that
// covers both platforms, every level, unknown levels and platforms, empty apps, string pids, unicode and regex
// metacharacters. The oracle is df8eacc's code, verbatim (_legacy-filter.mjs). Three deviations are declared and
// asserted as their own rows: an invalid regex, a numeric PID / App value, and the iOS app rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';
import { legacyFilter } from './_legacy-filter.mjs';

const Q = loadPureModule('query.js').query;
const LEVELS = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ASSERT'];

const TAGS = ['BluetoothGatt', 'bt_stack', 'bluetoothd', 'Blue Tooth', 'SpringBoard', 'chatty', 'İstanbul', 'STRASSE', '', 'headset(Kit)'];
const APPS = ['', 'com.example.headset', 'system_server', 'com.x52', 'Bragi AI'];
const PIDS = [52, 1645, 57, '52', 0, 15200, 1520];
const MSGS = ['line 1', 'LINE 10', 'a.b', 'axb', '(x', 'ß', 'SS', 'İ', 'i̇', 'a"b\\', ' ', '', 'x/y', 'time out', 'TIME OUT', 'line 1 a.b x/y'];
const LVLS = [...LEVELS, 'BOGUS'];
const PLATS = ['android', 'ios', 'ios', 'android', 'windows', undefined];
const CORPUS = Array.from({ length: 240 }, (_, i) => ({
  ts: '', tid: 0, lvl: LVLS[i % 7], platform: PLATS[i % 6], tag: TAGS[(i * 7) % 10], app: APPS[(i * 3) % 5],
  pid: PIDS[(i * 5) % 7], msg: MSGS[(i * 11) % 16], seq: i,
}));
// The rows the declared deviations are about, so each one shows: an iOS line with no app whose tag names the app's last
// segment, and an Android app with digits in its name.
CORPUS.push({ ts: '', tid: 0, lvl: 'ERROR', platform: 'ios', tag: 'headset(Kit)', app: '', pid: 1645, msg: 'pairing failed', seq: 240 },
  { ts: '', tid: 0, lvl: 'INFO', platform: 'android', tag: 'x', app: 'com.x52', pid: 7, msg: 'm', seq: 241 });

// Every subset of a list, as arrays.
const subsets = list => Array.from({ length: 1 << list.length }, (_, mask) => list.filter((_, i) => mask & (1 << i)));
const state = o => ({ search: '', case: false, regex: false, tag: '', pid: '', levels: LEVELS, plats: ['android', 'ios'], ...o });
// The P6 path the page takes: translate, build, then gate and lvOk as the drain uses them. null when fromLegacy refuses.
function viaQuery(st) {
  const text = Q.fromLegacy(st);
  if (text === null) return null;
  const { q, error } = Q.build(text, { case: st.case }, {});
  assert.equal(error, null, `${JSON.stringify(st)} → ${text}: ${error && error.msg}`);
  return m => { const k = q.gate(m); return k >= 0 && q.lvOk[k]; };
}
function same(st, oracle = legacyFilter(st)) {
  const mine = viaQuery(st);
  assert.notEqual(mine, null, JSON.stringify(st));
  for (const m of CORPUS) assert.equal(mine(m), oracle(m), `${JSON.stringify(st)} on ${JSON.stringify(m)}`);
}

test('every level set × every platform set (64 × 4), with no search, a plain search and a regex search', () => {
  for (const levels of subsets(LEVELS)) {
    for (const plats of subsets(['android', 'ios'])) {
      for (const s of [{}, { search: 'line' }, { search: 'l.ne 1', regex: true }]) same(state({ levels, plats, ...s }));
    }
  }
});

test('search × Aa × .* × Tag, with three level sets and two platform sets: equal on every line', () => {
  const searches = ['', ' ', 'line 1', 'a.b', 'ß', 'İ', 'x/y', 'TIME OUT', 'a"b', 'b\\\\'];
  for (const search of searches) {
    for (const c of [false, true]) {
      for (const regex of [false, true]) {
        for (const tag of ['', 'blue', 'Blue Tooth', 'İ']) {
          for (const levels of [LEVELS, ['WARN', 'ERROR', 'ASSERT'], ['DEBUG']]) {
            for (const plats of [['android', 'ios'], ['ios']]) same(state({ search, case: c, regex, tag, levels, plats }));
          }
        }
      }
    }
  }
});

test('the translation: one token per control, in canonical form', () => {
  assert.equal(Q.fromLegacy(state({})), '');
  assert.equal(Q.fromLegacy(state({ levels: ['WARN', 'ERROR', 'ASSERT'], plats: ['ios'], tag: 'Blue "x"', pid: '52', search: 'a b' })),
    'level:W+ dev:ios tag:"Blue \\"x\\"" pid:52 "a b"');
  assert.equal(Q.fromLegacy(state({ levels: [], plats: [], pid: 'headset' })), 'level:none dev:none app:"headset"');
  assert.equal(Q.fromLegacy(state({ search: 'x/y\\/z', regex: true })), '/x\\/y\\/z/', 'every unescaped slash is escaped, escapes are kept');
});

test('declared deviation: an invalid regex. Legacy matched nothing; fromLegacy refuses it, so the page keeps the last valid filter', () => {
  for (const search of ['(x', 'a"b\\', '[']) {
    const st = state({ search, regex: true });
    assert.equal(Q.fromLegacy(st), null, search);
    assert.equal(CORPUS.filter(legacyFilter(st)).length, 0, `${search}: legacy showed nothing`);
    same(state({ search }), legacyFilter(state({ search })));   // the same text without .* is a plain search, equal as before
  }
});

test('declared deviations: PID / App. A number is an exact pid: (no substring, no app digits); other text is app: with the iOS tag rule', () => {
  const seg = v => v.slice(v.lastIndexOf('.') + 1);
  // The old filter with the PID / App clause replaced by the P6 rule; everything else verbatim.
  const p6 = st => {
    const rest = legacyFilter({ ...st, pid: '' });
    const p = st.pid.toLowerCase();
    return m => rest(m) && (/^\d+$/.test(st.pid) ? String(m.pid) === String(Number(st.pid))
      : m.app ? m.app.toLowerCase().includes(p) : m.platform === 'ios' && m.tag.toLowerCase().includes(seg(p)));
  };
  const diffs = {};
  for (const pid of ['52', '1645', '0', '152', 'headset', 'com.example.headset', 'SYSTEM', 'x52', 'bragi ai']) {
    for (const levels of [LEVELS, ['ERROR']]) {
      const st = state({ pid, levels });
      same(st, p6(st));
      const legacy = legacyFilter(st);
      const mine = viaQuery(st);
      diffs[pid] = (diffs[pid] || 0) + CORPUS.filter(m => legacy(m) !== mine(m)).length;
    }
  }
  assert.ok(diffs['52'] > 0 && diffs['152'] > 0, 'pid 1520 and 15200 no longer match 52 or 152, nor does app com.x52');
  assert.ok(diffs.headset > 0, 'iOS lines with no app match through their tag');
  assert.equal(diffs.SYSTEM, 0, 'an Android app match is unchanged');
});
