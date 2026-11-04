// The page side of the query (roadmap P6): the legacy script compiles the query (setQuery) and runs it in the drain,
// keeps every session's counts with it (flush, trim, Clear, file load, refilter) and keeps the last valid filter on an
// invalid query. Run on the legacy inline script with a sticky document (tests/viewer/_load.mjs), document.hidden true:
// the drain takes its data path only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadLegacy, stickyDocument, read, ASSETS, rng } from './_load.mjs';

const LV = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ASSERT'];
const TAGS = ['bt_stack', 'BluetoothGatt', 'chatty', 'kernel'];
const frame = (i, o = {}) => JSON.stringify({ type: 'log', ts: `2026 Oct 14 15:53:43.${String(i).padStart(6, '0')}`, pid: 50 + (i % 3), tid: 0,
  tag: TAGS[i % 4], app: i % 3 ? '' : 'com.x', lvl: LV[i % 6], msg: `line ${i}`, ...o });

function boot() {
  const doc = stickyDocument();
  const { api, run } = loadLegacy(['handleWsMsg', 'flushBatch', 'clearLogs', 'handleFile', 'selectSession', 'togglePause'], { document: doc });
  // The regex guard times real regexes on a real clock; the drain's flush budget keeps the sandbox's frozen performance.now.
  run('globalThis').__realNow = () => performance.now();
  run('guardClock = () => __realNow()');
  let n = 0;
  return {
    api, run, doc,
    send(count, platform = 'ios') { for (let i = 0; i < count; i++, n++) api.handleWsMsg({ data: frame(n) }, platform); },
    // Text typed into the query bar and applied (what the 100 ms debounce runs).
    bar(text) { doc.getElementById('queryInput').value = text; run('queryBar.apply()'); },
    // The session's counts, and a full recount of its lines under the active query (null levels while it is stale).
    counts(s = 'liveSession') {
      const plain = c => ({ lvl: [...c.lvl], tags: Array.from(c.tags).map(([k, v]) => `${k}=${v}`).sort(), apps: Array.from(c.apps).map(([k, v]) => `${k}=${v}`).sort() });
      // The counts follow the query `filtered` was built with (P7a): s.query, shown or not; null (a file before its first
      // refilter) counts no level. No stale exemption: a session's counts are always exact for its own query.
      const got = plain(run(`${s}.counts`));
      const want = plain(run(`ALV.counts.recount(ALV.counts.create(), ${s}.all, ${s}.query === null ? null : ${s}.query.gate)`));
      return [got, want];
    },
  };
}

test('setQuery refilters only when the compiled filter changed, and an invalid query changes nothing', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  // P7a: no filterGen; the shown session's filter key says whether a call applied a new filter, and it is never stale after one.
  const key = () => v.run('cur.filter.key'), fresh = () => v.run('cur.query === cur.filter');
  const key0 = key();
  assert.equal(v.run('setQuery(\'"line 1"\')'), null);
  const key1 = key();
  assert.notEqual(key1, key0);
  assert.equal(fresh(), true);
  assert.deepEqual(v.run('liveSession.filtered.map(m => m.msg)').join(','), 'line 1,line 10,line 11,line 12,line 13,line 14,line 15,line 16,line 17,line 18,line 19');
  v.run('setQuery(\'"line 1"  \')');
  assert.equal(key(), key1, 'the same filter compiles to the same key: no refilter');
  assert.equal(fresh(), true);
  v.run('setQuery(\'/line 1/\', { regex: true })');
  const key2 = key();
  assert.notEqual(key2, key1);
  assert.equal(fresh(), true);
  v.run('setQuery(\'/line 1/ -level:V\')');
  assert.equal(v.run('liveSession.filtered.length'), 9, 'line 1 and 10-19 without the VERBOSE ones (12, 18)');
  assert.equal(v.run('setQuery("tag:bt")'), null);
  assert.equal(v.run('liveSession.filtered.length'), 8, 'setQuery replaces the whole filter: tag bt_stack, every level');
  assert.equal(v.run("liveSession.filtered.filter(m => m.lvl === 'VERBOSE').length"), 3);
  assert.match(v.run('setQuery("tg:bt").msg'), /^Unknown field 'tg'/);
  assert.match(v.run('setQuery("line (2", { regex: true }).msg'), /^Invalid regex: /);
  assert.deepEqual([key() === v.run("ALV.query.build('tag:bt', {}, deviceInfo).q.key"), v.run('liveSession.filtered.length'), fresh()], [true, 8, true], 'an invalid query changes nothing');
});

test('an invalid edit in the bar never blocks a level chip, a sidebar row or a tile fix: each rewrites the last valid text and applies', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  const shown = () => [v.run('liveSession.filtered.length'), v.doc.getElementById('queryInput').value, v.doc.getElementById('queryError').hidden];
  v.bar('/line ./ tag:bt -level:V');
  assert.deepEqual(shown(), [5, '/line ./ tag:bt -level:V', true], 'tag bt_stack (8 lines) minus its 3 VERBOSE ones');
  v.bar('/line (/');
  assert.deepEqual(shown(), [5, '/line (/', false], 'the last valid filter stays');
  assert.deepEqual([v.run('shellState().levels'), v.run('shellState().query')], [5, true], 'the empty-state causes read the applied filter');
  v.run('queryBar.toggleLevel(0)');
  assert.deepEqual(shown(), [8, '/line ./ tag:bt', true], 'a level chip applies');
  v.bar('pid:abc');
  v.run("togglePlatform('ios')");
  assert.deepEqual(shown(), [0, 'dev:android /line ./ tag:bt', true], 'a sidebar row applies (every line here is ios)');
  v.bar('tg:x');
  v.run("resetFilter('devices')");
  assert.deepEqual(shown(), [8, '/line ./ tag:bt', true], 'the empty-state fix applies');
});

test('a dev:<name> query follows deviceInfo (q.usesDevNames): a device picked or gone recompiles it on the next shellSync', () => {
  const v = boot();
  v.send(4, 'android'); v.send(4, 'ios'); v.api.flushBatch();
  v.run("deviceInfo.android = { id: 'R5CT', name: 'Pixel 8 Pro' }");
  v.bar('dev:pixel');
  assert.deepEqual([v.run('liveSession.filter.usesDevNames'), v.run('liveSession.filter.plats'), v.run('liveSession.filtered.length')], [true, 1, 4]);
  v.run("deviceInfo.android = { id: 'R9XY', name: 'Galaxy S24' }; shellSync()");   // the device picker (the shell tick does the same)
  assert.deepEqual([v.run('liveSession.filter.plats'), v.run('liveSession.filtered.length')], [0, 0], 'dev:pixel names no device now');
  v.run("deviceInfo.ios = { id: '0000', name: 'Pixel phone' }; shellSync()");
  assert.deepEqual([v.run('liveSession.filter.plats'), v.run('liveSession.filtered.length')], [2, 4]);
  v.bar('dev:ios');
  v.run('__f = liveSession.filter');
  v.run("deviceInfo.ios = { id: '', name: '' }; shellSync()");
  assert.equal(v.run('liveSession.filter === __f'), true, 'no device name in the query: nothing recompiles');
});

test('counts equal a full recount after a seeded sequence of frames, flushes, trims, a resume after overflow, Clear, filter and level changes and a session switch', () => {
  const v = boot();
  v.run('MAX_RETAINED = 120');
  const fl = i => ({ ts: '', pid: 1, tid: 0, tag: TAGS[i % 4], app: i % 3 ? '' : 'com.x', lvl: LV[i % 6], msg: `line ${i}`, platform: i % 2 ? 'ios' : 'android' });
  v.run(`resetLines(fileSession, ${JSON.stringify(Array.from({ length: 40 }, (_, i) => fl(i)))}); fileSession.query = null`);
  const r = rng(5);
  const ran = new Array(12).fill(0);   // a generator that skips ops would pass vacuously, so every op is tallied and asserted below
  const seen = { liveLines: 0, awayFlushes: 0, awayTrims: 0, fileFilterChanges: 0, clears: 0, resumes: 0, fileSteps: 0 };
  for (let step = 0; step < 3000; step++) {
    const op = r(12);
    ran[op]++;
    const awayBefore = v.run('cur !== liveSession'), fileFilterBefore = v.run('fileSession.filter'), discardedBefore = v.run('liveSession.discarded'), lenBefore = v.run('liveSession.all.length');
    if (op < 5) v.send(1 + r(60), r(2) ? 'ios' : 'android');
    else if (op === 5) v.api.flushBatch();
    else if (op === 6) v.bar([['', 'tag:bt', 'tag:kernel', 'tag:x'][r(4)], ['', '"line 1"', '2'][r(3)]].join(' '));   // typed text, applied (the level and dev: tokens go with it)
    else if (op === 7) v.run(`togglePlatform('${r(2) ? 'ios' : 'android'}')`);
    else if (op === 8) v.run(`queryBar.toggleLevel(${r(6)})`);   // a level chip
    else if (op === 9) { if (r(3) === 0) { v.api.clearLogs(); seen.clears++; } }
    else if (op === 10) v.api.selectSession(v.run(r(2) ? 'fileSession' : 'liveSession'));
    else if (op === 11) {
      v.api.togglePause(); v.send(150); v.run('trimPausedBacklog(liveSession)');
      if (v.run('liveSession.overflowed')) seen.resumes++;
      v.api.togglePause();
    }
    if (v.run('liveSession.all.length') > 0) seen.liveLines++;
    if (v.run('cur') !== v.run('liveSession')) seen.fileSteps++;
    if (awayBefore && v.run('liveSession.all.length') > lenBefore) seen.awayFlushes++;
    if (awayBefore && v.run('liveSession.discarded') > discardedBefore) seen.awayTrims++;
    assert.equal(v.run('liveSession.query === liveSession.filter'), true, `step ${step}: Live is never stale`);
    if (v.run('fileSession.filter') !== fileFilterBefore && v.run('liveSession.all.length') > 0) seen.fileFilterChanges++;
    for (const s of ['liveSession', 'fileSession']) {
      const [got, want] = v.counts(s);
      assert.deepEqual(got, want, `step ${step}, op ${op}: ${s} counts`);
      // filtered equals a full refilter of all under the query it follows (in order, same objects); null: not filtered yet
      assert.equal(v.run(`(() => { const s = ${s}; if (s.query === null) return true;
        const w = s.all.filter(m => { const k = s.query.gate(m); return k >= 0 && s.query.lvOk[k]; });
        return w.length === s.filtered.length && w.every((m, i) => m === s.filtered[i]); })()`), true, `step ${step}, op ${op}: ${s} filtered`);
    }
  }
  v.api.selectSession(v.run('liveSession'));
  v.api.flushBatch();
  for (const s of ['liveSession', 'fileSession']) {
    const [got, want] = v.counts(s);
    assert.deepEqual(got, want, `back on Live, refiltered: ${s} counts`);
    assert.equal(v.run(`(() => { const s = ${s}; if (s.query === null) return true;
      const w = s.all.filter(m => { const k = s.query.gate(m); return k >= 0 && s.query.lvOk[k]; });
      return w.length === s.filtered.length && w.every((m, i) => m === s.filtered[i]); })()`), true, `back on Live: ${s} filtered`);
  }
  assert.ok(v.run('liveSession.discarded') > 0, 'the sequence trimmed');
  for (let op = 0; op < 12; op++) assert.ok(ran[op] >= 150, `op ${op} ran ${ran[op]} times`);
  assert.ok(seen.liveLines >= 1000, `the live session held lines at ${seen.liveLines} steps`);
  assert.ok(seen.awayFlushes >= 5, `lines ingested while the live session was away: ${seen.awayFlushes}`);
  assert.ok(seen.awayTrims >= 20, `a trim dropped lines while the live session was away: ${seen.awayTrims}`);
  assert.ok(seen.fileFilterChanges >= 50, `File's filter changed while Live held lines at ${seen.fileFilterChanges} steps`);
  assert.ok(seen.clears >= 20, `Clear ran ${seen.clears} times`);
  assert.ok(seen.resumes >= 100, `Resume after a backlog overflow ran ${seen.resumes} times`);
  assert.ok(seen.fileSteps >= 500, `a file session was on screen at ${seen.fileSteps} steps`);
});

test('a file load counts its tags and apps at once and its levels when rendered; Clear on it empties every count', () => {
  const v = boot();
  const text = Array.from({ length: 6 }, (_, i) => `Oct 14 15:53:43.00000${i} ${i % 2 ? 'bluetoothd' : 'SpringBoard'}(X)[57] <${i % 3 ? 'Notice' : 'Error'}>: file ${i}`).join('\n');
  v.api.selectSession(v.run('fileSession'));
  v.api.handleFile({ name: 'a.log', text });
  assert.deepEqual(Array.from(v.run('fileSession.counts.tags')).map(([k, n]) => `${k}=${n}`).sort(), ['SpringBoard(X)=3', 'bluetoothd(X)=3']);
  v.run('applyFilters()');
  assert.deepEqual([...v.run('fileSession.counts.lvl')], [0, 0, 4, 0, 2, 0]);
  v.api.clearLogs();
  assert.deepEqual([[...v.run('fileSession.counts.lvl')], v.run('fileSession.counts.tags.size')], [[0, 0, 0, 0, 0, 0], 0]);
});

test('dev-bench applies &q (with &case and &re) and &cap before the run and reports them; an invalid &q is reported, not applied', () => {
  const bench = search => {
    const v = boot();
    v.run('globalThis').URLSearchParams = URLSearchParams;   // the loader's sandbox has no URL API of its own
    v.run(`location.search = ${JSON.stringify(search)}`);
    v.run(read(path.join(ASSETS, 'js', 'dev-bench.js')));
    return v;
  };
  const v = bench('?bench=2000&q=level%3AI%2B%20tag%3Ao%20%22bench%22&case=1&cap=100000');
  assert.equal(v.run('liveSession.filter.key'), v.run(`ALV.query.build('level:I+ tag:o "bench"', { case: true }, deviceInfo).q.key`));
  assert.equal(v.run('MAX_RETAINED'), 100000);
  const bad = bench('?bench=2000&q=%2Ftime(%2F&scenario=paused&cap=7');
  assert.equal(bad.run('liveSession.filter.key'), bad.run("ALV.query.build('', {}, deviceInfo).q.key"), 'the invalid query left the filter alone');
  assert.equal(bad.run('MAX_RETAINED'), 50000, 'the paused scenario sets its own cap after &cap');
  assert.match(read(path.join(ASSETS, 'js', 'dev-bench.js')), /\bquery, queryError, cap: MAX_RETAINED,/, 'the result reports them');
});

test('the no-match tile\'s tag causes come from the tag counts: NOT tag:x on every retained line, tag:x on none; never while lines match', () => {
  const v = boot();
  v.send(8); v.api.flushBatch();             // tags bt_stack, BluetoothGatt, chatty, kernel, twice each
  const causes = text => { v.run(`setQuery(${JSON.stringify(text)})`); return [v.run('shellState().notTag'), v.run('shellState().tag')]; };
  assert.deepEqual(causes('tag:zzz'), ['', 'zzz'], 'no retained line matches tag:zzz');
  assert.deepEqual(causes('tag:zzz tag:kernel level:none'), ['', ''], 'kernel lines exist: the tag is not why nothing shows (the levels are)');
  assert.deepEqual(causes('tag:zzz tag:yyy'), ['', 'zzz'], 'no retained line carries either positive tag: the first is named');
  assert.deepEqual(causes('tag:kernel level:none'), ['', ''], 'the levels are the cause');
  v.run("liveSession.all.forEach(m => { m.tag = 'chatty'; }); ALV.counts.recount(liveSession.counts, liveSession.all, liveSession.query.gate)");
  assert.deepEqual(causes('-tag:chatty'), ['chatty', ''], 'every retained line carries it');
  assert.deepEqual(causes('-tag:kernel x'), ['', ''], 'lines without kernel exist');
  assert.deepEqual(causes('-tag:chat'), ['chat', '']);
  v.run("setQuery('')");
  assert.deepEqual([v.run('shellState().notTag'), v.run('shellState().tag')], ['', ''], 'lines show: nothing to explain');
});

test('dev-bench read scenario: readPhaseP50Ms and readPhaseP95Ms count only the flushes after Follow goes off; flushP95Ms counts every one', () => {
  const v = boot();
  const g = v.run('globalThis');
  g.URLSearchParams = URLSearchParams;
  const clock = { t: 0 };
  let tick = null;
  g.__clock = clock;
  g.__cost = 0;
  g.performance = { now: () => clock.t };
  g.setInterval = fn => { tick = fn; return 1; };
  v.run('location.search = "?bench=1&scenario=read&secs=5"');
  v.run('flushBatch = function () { __clock.t += __cost; }');   // a flush that takes __cost ms; the bench wraps it
  v.run(read(path.join(ASSETS, 'js', 'dev-bench.js')));          // starts at t = 0; the first second is warm-up
  const flushAt = (t, cost) => { clock.t = t; g.__cost = cost; v.run('flushBatch()'); };
  for (let t = 1100; t < 2000; t += 150) flushAt(t, 30);   // Follow on: flushes that build rows
  clock.t = 2100; tick();                                  // Follow goes off (a flush the switch causes costs 30 ms too)
  for (let t = 2200; t < 5000; t += 150) flushAt(t, 1);    // the reading phase
  clock.t = 5000; tick();                                  // secs reached: the result
  const r = v.run('window.__benchResult');
  assert.deepEqual([r.flushP95Ms, r.readPhaseP50Ms, r.readPhaseP95Ms], [30, 1, 1], 'the follow-mode second is in p95, not in the read phase');
  assert.ok(r.readPhaseFlushes >= 19 && r.readPhaseFlushes < r.flushes, `read-phase flushes: ${r.readPhaseFlushes} of ${r.flushes}`);
  assert.deepEqual([r.query, r.queryError, r.cap], [null, null, 500000], 'the result reports the query and the cap');
});

// Loads dev-bench.js with `search`, a scripted clock that also advances with real time (the guard measures real costs),
// and the bench's tick captured; ticks every 10 ms of scripted time until the result is set.
function runBench(search, before = null) {
  const v = boot();
  const g = v.run('globalThis');
  g.URLSearchParams = URLSearchParams;
  const real = () => performance.now(), base = real(), clock = { t: 0 };
  let tick = null;
  g.performance = { now: () => clock.t + (real() - base) };
  g.setInterval = fn => { tick = fn; return 1; };
  v.run(`location.search = ${JSON.stringify(search)}`);
  v.run(read(path.join(ASSETS, 'js', 'dev-bench.js')));
  if (before) before(v);
  for (clock.t = 10; clock.t <= 30000 && !v.run('window.__benchResult'); clock.t += 10) tick();
  return v.run('window.__benchResult');
}

test('dev-bench scenario=switch: Live keeps its query while File\'s filter changes five times; no Live refilter; the documented fields', () => {
  const r = runBench('?bench=2000&scenario=switch&secs=14&cap=3000&q=tag%3Ao');
  assert.equal(r.scenario, 'switch');
  assert.deepEqual([r.cycles, r.liveRefilters, r.liveQueryKept, r.fileQueryKept, r.liveKeptFiltering, r.liveCountsOk], [5, 0, true, true, true, true]);
  for (const f of ['switchLiveMsMax', 'switchLiveMsMed', 'switchFileMsMax', 'fileSetQueryMsMax', 'maxLiveRows', 'liveTailOk']) assert.ok(f in r, f);
});

test('dev-bench scenario=refilter: one entry per query with ms, guardMs, error and kept; &slow=1 adds the refused ones', () => {
  // The guard runs on a real clock: up to 3 runs, so a refusal of an accepted query that does not repeat (the machine,
  // not the regex) cannot fail the test.
  let r = null;
  for (let i = 0; i < 3 && !(r && r.refilter.slice(0, 7).every(x => x.error === null)); i++) {
    r = runBench('?bench=2000&scenario=refilter&secs=17&cap=3000&slow=1');
    for (const x of r.refilter.slice(0, 7)) if (x.error !== null) console.log(`refilter smoke: run ${i + 1} refused an accepted query (the machine, not the regex): ${x.q} -> ${x.error}`);
  }
  // Array.from: a test-realm array (r.refilter.map would build one in the sandbox realm, which a strict deepEqual rejects).
  assert.deepEqual(Array.from(r.refilter, x => [x.q, x.re]), [['level:I+ tag:o "bench"', false], ['level:I+ tag:o -zzzz', false],
    ['/bench line \\d+ x+$/', false], ['/time ?out/', false], ['', false], ['error timeout disconnect', true], ['/bench\\w*/ /line\\s+\\d+/ /x+$/', false],
    ['/\\s.*.*.*z/', false], ['/(.*){2}z/', false], ['/\\w+\\w+z/', false]]);
  for (const x of r.refilter.slice(0, 7)) assert.deepEqual([x.error, typeof x.ms, typeof x.guardMs, typeof x.nsPerLine], [null, 'number', 'number', 'number'], x.q);
  assert.equal(r.refilter[5].guardMs, 0, 'plain words under .* have no quantifier: not timed');
  for (const x of r.refilter.slice(7)) assert.match(x.error, /^Invalid regex: It /, x.q);
  assert.equal(r.liveKeyKeptAfterRefusals, true);
});

test('dev-bench: readPhase* are null when the read switch never happens, and &q lands in the query bar', () => {
  const rd = runBench('?bench=2000&scenario=read&secs=5', v => v.run('liveSession.follow = false'));   // already reading: no switch
  assert.deepEqual([rd.readPhaseP50Ms, rd.readPhaseP95Ms, rd.readPhaseFlushes], [null, null, null]);
  const r = runBench('?bench=2000&scenario=follow&secs=5&q=tag%3Ao');
  assert.equal(r.barText, 'tag:o');
});

test('a {type:"dropped"} frame runs shellSync but writes no visible number: the 250 ms interval owns them (F11)', () => {
  const v = boot();
  v.send(10); v.api.flushBatch();
  v.run('queryBar.numbers()');
  const count = v.doc.getElementById('filterCount');
  assert.equal(count.textContent, '10 of 10 lines');
  v.send(5); v.api.flushBatch();
  for (let i = 0; i < 20; i++) v.api.handleWsMsg({ data: JSON.stringify({ type: 'dropped', count: 3 }) }, 'ios');
  assert.equal(count.textContent, '10 of 10 lines', 'twenty dropped frames, no write');
  v.run('queryBar.numbers()');
  assert.equal(count.textContent, '15 of 15 lines', 'the interval\'s write shows them');
});

test('a session switch shows the shown session\'s numbers at once (selectSession no longer asks for them: queryBar.sync notices the switch)', () => {
  const v = boot();
  v.send(10); v.api.flushBatch();
  v.run('queryBar.numbers()');
  const count = v.doc.getElementById('filterCount');
  v.api.selectSession(v.run('fileSession'));
  assert.equal(count.textContent, '0 of 0 lines');
  v.api.selectSession(v.run('liveSession'));
  assert.equal(count.textContent, '10 of 10 lines');
});

const fileLine = o => ({ ts: '', pid: 1, tid: 0, tag: 'x', app: '', lvl: 'INFO', msg: 'f', platform: 'ios', ...o });

test('setQuery changes only the shown session: a filter on File leaves Live\'s query, text and filtered list alone, and switching back refilters nothing', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  v.bar('tag:bt');
  v.run('__liveF = liveSession.filter; __liveFiltered = liveSession.filtered');
  v.run(`resetLines(fileSession, [${JSON.stringify(fileLine({ tag: 'kernel' }))}]); fileSession.query = null`);
  v.api.selectSession(v.run('fileSession'));
  v.bar('level:E');
  assert.equal(v.run('fileSession.queryText'), 'level:E');
  assert.deepEqual([v.run('liveSession.filter === __liveF'), v.run('liveSession.queryText'), v.run('liveSession.filtered === __liveFiltered')], [true, 'tag:bt', true]);
  v.run('__refilters = 0; __rf = refilterSession; refilterSession = s => { if (s === liveSession) __refilters++; return __rf(s); }');
  v.api.selectSession(v.run('liveSession'));
  assert.equal(v.run('__refilters'), 0, 'Live\'s own query did not change: no refilter on the switch');
});

test('a background live session keeps filtering and counting its new lines with its own query while File is shown', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.bar('tag:bt');
  v.run(`resetLines(fileSession, [${JSON.stringify(fileLine())}]); fileSession.query = null`);
  v.api.selectSession(v.run('fileSession'));
  v.bar('level:E');
  for (let k = 0; k < 6; k++) {
    const before = v.run('liveSession.filtered.length'), dropped = v.run('liveSession.discarded');
    v.send(40); v.api.flushBatch();
    assert.ok(v.run('liveSession.filtered.length') > before || v.run('liveSession.discarded') > dropped, `round ${k}: Live's filtered list grows (or a trim made room)`);
    assert.equal(v.run("liveSession.filtered.every(m => m.tag.toLowerCase().includes('bt'))"), true, 'filtered with Live\'s own query, not File\'s');
    const [got, want] = v.counts('liveSession');
    assert.deepEqual(got, want, `round ${k}: counts equal a recount under liveSession.query`);
  }
  assert.ok(v.run('liveSession.discarded') > 0, 'the trims ran (MAX_RETAINED 100)');
});

test('a file load leaves the File session stale (query null) until it renders, and keeps the File session\'s query', () => {
  const v = boot();
  v.api.selectSession(v.run('fileSession'));
  v.bar('level:W+');
  v.run('__f = fileSession.filter');
  v.run(`discardBacklog(fileSession); resetLines(fileSession, [${JSON.stringify(fileLine({ lvl: 'WARN' }))}, ${JSON.stringify(fileLine())}]); fileSession.query = null`);
  assert.deepEqual([v.run('shellState().stale'), v.run('fileSession.filter === __f')], [true, true]);
  v.run('applyFilters()');
  assert.deepEqual([v.run('shellState().stale'), v.run('fileSession.query === __f'), v.run('fileSession.filtered.length')], [false, true, 1]);
});

test('a regex the guard refuses changes nothing: setQuery returns the error, and the session\'s filter, text and filtered list stay', () => {
  const v = boot();
  v.send(60); v.api.flushBatch();
  v.bar('tag:bt');
  v.run('__f = cur.filter; __filtered = cur.filtered');
  const err = v.run("setQuery('/(.*){2}z/', {})");   // cubic: refused on any lines (the probe extrapolates to 1 024 chars)
  assert.match(err.msg, /^Invalid regex: It would take about [\d\u2009]+ ms on one of these lines and can freeze the viewer\. Make it more specific, for example with fewer \.\* or a \^ anchor\. The last valid filter is still applied\.$/);
  assert.deepEqual([v.run('cur.filter === __f'), v.run('cur.queryText'), v.run('cur.filtered === __filtered')], [true, 'tag:bt', true]);
  v.bar('/(.*){2}z/');
  // The sticky test document's getAttribute is a stub, its classList is real (tests/viewer/_load.mjs); querybar.test covers aria-invalid.
  assert.deepEqual([v.doc.getElementById('queryError').hidden, v.doc.getElementById('queryBox').classList.contains('invalid')], [false, true]);
  assert.match(v.doc.getElementById('queryErrorText').textContent, /^Invalid regex: It would take about /);
});

test('the guard runs only when the compiled filter changes: a trailing space costs no probe', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  v.run('__probes = 0; __sr = ALV.query.slowRegex; ALV.query = Object.assign({}, ALV.query, { slowRegex: (...a) => { __probes++; return __sr(...a); } })');
  v.bar('/line \\d/');
  v.bar('/line \\d/  ');
  v.bar('tag:bt');
  assert.equal(v.run('__probes'), 2, 'the regex filter and the tag filter: the trailing space compiles to the same key');
  assert.equal(v.run('cur.queryText'), 'tag:bt');
});

test('a file whose lines make the File session\'s regex too slow opens unfiltered, with a toast', () => {
  const v = boot();
  v.api.selectSession(v.run('fileSession'));
  v.run(`resetLines(fileSession, Array.from({ length: 10 }, (_, i) => (${JSON.stringify(fileLine())}))); applyFilters()`);
  // Quadratic in a word run: fine on short words, too slow on 8 000-character ones. A real clock on a shared machine: up
  // to 3 applies, so a refusal that does not repeat (the machine, not the regex) cannot fail the test.
  for (let i = 0; i < 3 && v.run('fileSession.queryText') !== '/\\w+@\\w+/'; i++) {
    // A retry here is logged, never hidden: a refusal that only passes on attempt 2 or 3 is the machine or a regression, and the log says which.
    if (i > 0) console.log(`# real clock: /\\w+@\\w+/ refused on short lines (${v.doc.getElementById('queryErrorText').textContent}); retry ${i}`);
    v.bar('/\\w+@\\w+/');
  }
  assert.equal(v.run('fileSession.queryText'), '/\\w+@\\w+/', 'accepted on short lines');
  const big = JSON.stringify(Array.from({ length: 50 }, () => fileLine({ msg: 'a'.repeat(8000) })));
  v.run(`__toasts = []; ALV.ui.toast = s => { __toasts.push(s); return { id: 0, dismiss() {} }; }; loadParsedFile('big.txt', ${big})`);
  assert.deepEqual([v.run('fileSession.queryText'), v.run('fileSession.filter.key') === v.run("ALV.query.build('', {}, deviceInfo).q.key")], ['', true]);
  // As JSON: the array is the sandbox realm's, and a strict deepEqual compares prototypes across realms.
  assert.equal(v.run('JSON.stringify(__toasts.map(t => [t.kind, t.title]))'), JSON.stringify([['info', 'Filter cleared on big.txt']]));
  assert.match(v.run('__toasts[0].desc'), /^It (would take|takes) about .+\. Showing all lines\. Make the regex more specific to filter this file\.$/);
});

test('the bar shows the cleared query after a file load drops the File session\'s regex', () => {
  const v = boot();
  v.api.selectSession(v.run('fileSession'));
  v.run(`resetLines(fileSession, Array.from({ length: 10 }, (_, i) => (${JSON.stringify(fileLine())}))); applyFilters()`);
  // Quadratic in a word run: fine on short words, too slow on 8 000-character ones. A real clock on a shared machine: up
  // to 3 applies, so a refusal that does not repeat (the machine, not the regex) cannot fail the test.
  for (let i = 0; i < 3 && v.run('fileSession.queryText') !== '/\\w+@\\w+/'; i++) {
    // A retry here is logged, never hidden: a refusal that only passes on attempt 2 or 3 is the machine or a regression, and the log says which.
    if (i > 0) console.log(`# real clock: /\\w+@\\w+/ refused on short lines (${v.doc.getElementById('queryErrorText').textContent}); retry ${i}`);
    v.bar('/\\w+@\\w+/');
  }
  assert.equal(v.run('fileSession.queryText'), '/\\w+@\\w+/', 'accepted on short lines');
  const big = JSON.stringify(Array.from({ length: 50 }, () => fileLine({ msg: 'a'.repeat(8000) })));
  v.run(`__toasts = []; ALV.ui.toast = s => { __toasts.push(s); return { id: 0, dismiss() {} }; }; loadParsedFile('big.txt', ${big})`);
  assert.deepEqual([v.run('fileSession.queryText'), v.run('fileSession.filter.key') === v.run("ALV.query.build('', {}, deviceInfo).q.key")], ['', true]);
  // As JSON: the array is the sandbox realm's, and a strict deepEqual compares prototypes across realms.
  assert.equal(v.run('JSON.stringify(__toasts.map(t => [t.kind, t.title]))'), JSON.stringify([['info', 'Filter cleared on big.txt']]));
  assert.match(v.run('__toasts[0].desc'), /^It (would take|takes) about .+\. Showing all lines\. Make the regex more specific to filter this file\.$/);
  assert.equal(v.doc.getElementById('queryInput').value, '', 'the bar shows the cleared query');
});

test('dev:<name> on a background session: the recompile makes it stale, it refilters once when shown; back to its old key is not stale', () => {
  const v = boot();
  v.send(4, 'android'); v.send(4, 'ios'); v.api.flushBatch();
  v.run("deviceInfo.android = { id: 'R5CT', name: 'Pixel 8 Pro' }");
  v.bar('dev:pixel');
  v.run(`resetLines(fileSession, [${JSON.stringify(fileLine())}]); fileSession.query = null`);
  v.api.selectSession(v.run('fileSession'));
  v.run("deviceInfo.android = { id: 'R9XY', name: 'Galaxy' }; recompileDevNames()");
  assert.equal(v.run('liveSession.query !== liveSession.filter'), true, 'Live is stale: dev:pixel names no device now');
  const before = v.run('liveSession.filtered.length');
  v.send(4, 'android'); v.api.flushBatch();
  assert.equal(v.run('liveSession.filtered.length'), before + 4, 'until shown, Live follows the query its lines follow');
  v.run("deviceInfo.android = { id: 'R5CT', name: 'Pixel 8 Pro' }; recompileDevNames()");
  assert.equal(v.run('liveSession.query === liveSession.filter'), true, 'back to the key its lines follow: that query again, not stale');
  v.run("deviceInfo.android = { id: 'R9XY', name: 'Galaxy' }; recompileDevNames()");
  v.run('__n = 0; __rf = refilterSession; refilterSession = s => { __n++; return __rf(s); }');
  v.api.selectSession(v.run('liveSession'));
  assert.deepEqual([v.run('__n'), v.run('liveSession.filtered.length')], [1, 0]);
});

const countTagCause = v => v.run('__tc = 0; __t = ALV.query.tagCause; ALV.query = Object.assign({}, ALV.query, { tagCause: (...a) => { __tc++; return __t(...a); } })');

test('F7: one shellState() computes the tag causes once for notTag and tag; a new state object computes them again', () => {
  const v = boot();
  v.send(12); v.api.flushBatch();
  v.bar('tag:zzz');
  countTagCause(v);
  v.run('__st = shellState(); __st.notTag; __st.tag; __st.notTag');
  assert.equal(v.run('__tc'), 1);
  assert.equal(v.run('__st.tag'), 'zzz');
  v.run('shellState().tag');
  assert.equal(v.run('__tc'), 2);
});

test('F7 stale guard: while the shown session is stale (a file loaded, not rendered) the causes are empty and tagCause is never asked', () => {
  const v = boot();
  v.api.selectSession(v.run('fileSession'));
  v.bar('tag:zzz');
  v.run(`resetLines(fileSession, [${JSON.stringify(fileLine({ tag: 'kernel' }))}]); fileSession.query = null`);
  countTagCause(v);
  assert.deepEqual([v.run('shellState().notTag'), v.run('shellState().tag'), v.run('__tc')], ['', '', 0]);
  v.run('applyFilters()');
  assert.deepEqual([v.run('shellState().tag'), v.run('__tc')], ['zzz', 1], 'from the File session\'s own counts once it is current');
});
