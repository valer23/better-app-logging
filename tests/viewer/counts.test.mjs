// Incremental counts (viewer/assets/js/counts.js, roadmap P6 acceptance): after any sequence of appends, retention trims
// (session.trim with its onDrop hook), resume-after-overflow trims, clears, query changes and appends to a session whose
// query is stale, the counts equal a full recount. Loaded with session.js and query.js in one EMPTY vm context.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ASSETS, read, loadPureModules, pageScriptSrcs, rng } from './_load.mjs';

const ALV = loadPureModules('session.js', 'query.js', 'counts.js');
const { counts: C, session: S, query: Q } = ALV;
// A counts object as plain, comparable values: the level counts and the sorted map entries.
const entries = map => Array.from(map, ([k, v]) => [k, v]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const plain = c => ({ lvl: [...c.lvl], tags: entries(c.tags), apps: entries(c.apps) });

test('counts.js loads in an empty context, names no page API, and loads right after query.js', () => {
  assert.doesNotMatch(read(path.join(ASSETS, 'js', 'counts.js')), /\b(document|localStorage|setTimeout|setInterval|requestAnimationFrame)\b/);
  const srcs = pageScriptSrcs();
  assert.equal(srcs.indexOf('assets/js/counts.js'), srcs.indexOf('assets/js/query.js') + 1);
  assert.ok(Object.isFrozen(C));
});

test('add, remove and recount: tags and apps count every line, an empty app is not counted, a key at zero is deleted', () => {
  const c = C.create();
  const lines = [{ tag: 'a', app: '' }, { tag: 'a', app: 'x' }, { tag: 'b', app: 'x' }].map(m => ({ lvl: 'INFO', platform: 'ios', msg: '', pid: 1, ...m }));
  for (const m of lines) C.add(c, m);
  assert.deepEqual(plain(c), { lvl: [0, 0, 0, 0, 0, 0], tags: [['a', 2], ['b', 1]], apps: [['x', 2]] });
  const gate = Q.build('', {}, {}).q.gate;
  C.remove(c, lines, 0, 2, gate);
  assert.deepEqual(plain(c), { lvl: [0, 0, -2, 0, 0, 0], tags: [['b', 1]], apps: [['x', 1]] }, 'remove decrements the levels the gate passes');
  assert.deepEqual(plain(C.recount(c, lines, gate)), { lvl: [0, 0, 3, 0, 0, 0], tags: [['a', 2], ['b', 1]], apps: [['x', 2]] });
  assert.deepEqual(plain(C.recount(c, lines, null)).lvl, [0, 0, 0, 0, 0, 0], 'a null gate leaves the levels at 0');
  C.clear(c);
  assert.deepEqual(plain(c), { lvl: [0, 0, 0, 0, 0, 0], tags: [], apps: [] });
});

// The page's drain, refilter, trim and clear, reduced to what touches a session and its counts (applogs-viewer.html:
// flushBatch, refilterSession, trimRetained, clearLogs / resetLines).
function model() {
  const s = S.create('live', 'Live session');
  s.counts = C.create();
  let q = Q.build('', {}, {}).q;
  let stale = false;   // s.query !== filterGen: the session was away while the query changed
  let seq = 0;
  return {
    s,
    get q() { return q; },
    get stale() { return stale; },
    append(lines) {
      for (const m of lines) {
        m.seq = seq++;
        s.all.push(m);
        C.add(s.counts, m);
        if (!stale) { const k = q.gate(m); if (k >= 0) { s.counts.lvl[k]++; if (q.lvOk[k]) s.filtered.push(m); } }
      }
    },
    trim(max, dropAll) {
      S.trim(s, max, 0.1, dropAll, seq, (all, a, b) => C.remove(s.counts, all, a, b, stale ? null : q.gate));
    },
    clear() { S.reset(s, []); C.recount(s.counts, [], null); },
    query(text, away) { q = Q.build(text, {}, {}).q; if (away) stale = true; else this.refilter(); },
    refilter() {
      stale = false;
      const lv = s.counts.lvl;
      lv.fill(0);
      const out = [];
      for (const m of s.all) { const k = q.gate(m); if (k >= 0) { lv[k]++; if (q.lvOk[k]) out.push(m); } }
      s.filtered = out;
    },
  };
}

test('incremental counts equal a full recount after 2 000 seeded sequences of append, trim, dropAll, clear, query change and stale appends', () => {
  const r = rng(61);
  const LV = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ASSERT', 'BOGUS'];
  const TAG = ['bt', 'BluetoothGatt', 'chatty', 'kernel', ''];
  const QUERIES = ['', 'level:W+', 'tag:bt', '-tag:chatty line', 'dev:ios', 'pid:7 level:none', 'app:com.x', '/line [0-4]/'];
  const line = () => ({ ts: '', tid: 0, lvl: LV[r(7)], platform: r(2) ? 'ios' : 'android', tag: TAG[r(5)], app: r(3) ? '' : `com.x${r(3)}`, pid: r(9), msg: `line ${r(10)}` });
  const ran = new Array(10).fill(0);       // how often each op ran: a PRNG that skips ops would pass vacuously
  const away = { true: 0, false: 0 };
  let staleSteps = 0, trimmed = 0, platforms = new Set();
  for (let n = 0; n < 2000; n++) {
    const mdl = model();
    for (let step = 0; step < 12; step++) {
      const op = r(10);
      ran[op]++;
      if (op < 5) { const lines = Array.from({ length: r(40) }, line); for (const m of lines) platforms.add(m.platform); mdl.append(lines); }
      else if (op === 5) { const before = mdl.s.all.length; mdl.trim(20 + r(30), false); trimmed += before - mdl.s.all.length; }
      else if (op === 6) { const before = mdl.s.all.length; mdl.trim(0, true); trimmed += before - mdl.s.all.length; }
      else if (op === 7) mdl.clear();
      else if (op === 8) { const a = r(2) === 0; away[a]++; mdl.query(QUERIES[r(QUERIES.length)], a); }
      else if (mdl.stale) mdl.refilter();
      if (mdl.stale) staleSteps++;
      const want = C.recount(C.create(), mdl.s.all, mdl.stale ? null : mdl.q.gate);
      const got = plain(mdl.s.counts);
      if (mdl.stale) got.lvl = [0, 0, 0, 0, 0, 0];   // a stale session's level counts wait for its refilter
      assert.deepEqual(got, plain(want), `sequence ${n}, step ${step}, op ${op}`);
      if (!mdl.stale) assert.deepEqual(Array.from(mdl.s.filtered), Array.from(mdl.s.all).filter(m => { const k = mdl.q.gate(m); return k >= 0 && mdl.q.lvOk[k]; }), `sequence ${n}, step ${step}, op ${op}: filtered`);
    }
  }
  // Every op, both values of `away`, both platforms, stale steps and a real discard each happened many times.
  for (let op = 0; op < 10; op++) assert.ok(ran[op] >= 1000, `op ${op} ran ${ran[op]} times`);
  assert.ok(away.true >= 500 && away.false >= 500, `away took both values: ${JSON.stringify(away)}`);
  assert.ok(staleSteps >= 1000, `stale steps: ${staleSteps}`);
  assert.ok(trimmed >= 10000, `lines trimmed: ${trimmed}`);
  assert.equal(platforms.size, 2);
});
