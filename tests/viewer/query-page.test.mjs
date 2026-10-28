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
  let n = 0;
  return {
    api, run, doc,
    send(count, platform = 'ios') { for (let i = 0; i < count; i++, n++) api.handleWsMsg({ data: frame(n) }, platform); },
    // Text typed into the query bar and applied (what the 100 ms debounce runs).
    bar(text) { doc.getElementById('queryInput').value = text; run('queryBar.apply()'); },
    // The session's counts, and a full recount of its lines under the active query (null levels while it is stale).
    counts(s = 'liveSession') {
      const plain = c => ({ lvl: [...c.lvl], tags: Array.from(c.tags).map(([k, v]) => `${k}=${v}`).sort(), apps: Array.from(c.apps).map(([k, v]) => `${k}=${v}`).sort() });
      const stale = run(`${s}.query !== filterGen`);
      const got = plain(run(`${s}.counts`));
      const want = plain(run(`ALV.counts.recount(ALV.counts.create(), ${s}.all, ${stale} ? null : activeQuery.gate)`));
      if (stale) got.lvl = want.lvl;
      return [got, want];
    },
  };
}

test('setQuery refilters only when the compiled filter changed, and an invalid query changes nothing', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  assert.equal(v.run('setQuery(\'"line 1"\')'), null);
  assert.equal(v.run('filterGen'), 1);
  assert.deepEqual(v.run('liveSession.filtered.map(m => m.msg)').join(','), 'line 1,line 10,line 11,line 12,line 13,line 14,line 15,line 16,line 17,line 18,line 19');
  v.run('setQuery(\'"line 1"  \')');
  assert.equal(v.run('filterGen'), 1, 'the same filter compiles to the same key: no refilter');
  v.run('setQuery(\'/line 1/\', { regex: true })');
  assert.equal(v.run('filterGen'), 2);
  v.run('setQuery(\'/line 1/ -level:V\')');
  assert.equal(v.run('liveSession.filtered.length'), 9, 'line 1 and 10-19 without the VERBOSE ones (12, 18)');
  assert.equal(v.run('setQuery("tag:bt")'), null);
  assert.equal(v.run('liveSession.filtered.length'), 8, 'setQuery replaces the whole filter: tag bt_stack, every level');
  assert.equal(v.run("liveSession.filtered.filter(m => m.lvl === 'VERBOSE').length"), 3);
  assert.match(v.run('setQuery("tg:bt").msg'), /^Unknown field 'tg'/);
  assert.match(v.run('setQuery("line (2", { regex: true }).msg'), /^Invalid regex: /);
  assert.deepEqual([v.run('filterGen'), v.run('liveSession.filtered.length')], [4, 8], 'an invalid query changes nothing');
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
  assert.deepEqual([v.run('activeQuery.usesDevNames'), v.run('activeQuery.plats'), v.run('liveSession.filtered.length')], [true, 1, 4]);
  v.run("deviceInfo.android = { id: 'R9XY', name: 'Galaxy S24' }; shellSync()");   // the device picker (the shell tick does the same)
  assert.deepEqual([v.run('activeQuery.plats'), v.run('liveSession.filtered.length')], [0, 0], 'dev:pixel names no device now');
  v.run("deviceInfo.ios = { id: '0000', name: 'Pixel phone' }; shellSync()");
  assert.deepEqual([v.run('activeQuery.plats'), v.run('liveSession.filtered.length')], [2, 4]);
  v.bar('dev:ios');
  const gen = v.run('filterGen');
  v.run("deviceInfo.ios = { id: '', name: '' }; shellSync()");
  assert.equal(v.run('filterGen'), gen, 'no device name in the query: nothing recompiles');
});

test('counts equal a full recount after a seeded sequence of frames, flushes, trims, a resume after overflow, Clear, filter and level changes and a session switch', () => {
  const v = boot();
  v.run('MAX_RETAINED = 120');
  const r = rng(5);
  const ran = new Array(12).fill(0);   // a generator that skips ops would pass vacuously, so every op is tallied and asserted below
  const seen = { liveLines: 0, staleTrims: 0, staleFlushes: 0, clears: 0, resumes: 0, fileSteps: 0 };
  for (let step = 0; step < 3000; step++) {
    const op = r(12);
    ran[op]++;
    const staleBefore = v.run('liveSession.query !== filterGen'), discardedBefore = v.run('liveSession.discarded'), lenBefore = v.run('liveSession.all.length');
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
    if (staleBefore && v.run('liveSession.all.length') > lenBefore) seen.staleFlushes++;
    if (staleBefore && v.run('liveSession.discarded') > discardedBefore) seen.staleTrims++;
    const [got, want] = v.counts();
    assert.deepEqual(got, want, `step ${step}, op ${op}`);
  }
  v.api.selectSession(v.run('liveSession'));
  v.api.flushBatch();
  const [got, want] = v.counts();
  assert.deepEqual(got, want, 'back on Live, refiltered');
  assert.ok(v.run('liveSession.discarded') > 0, 'the sequence trimmed');
  for (let op = 0; op < 12; op++) assert.ok(ran[op] >= 150, `op ${op} ran ${ran[op]} times`);
  assert.ok(seen.liveLines >= 1000, `the live session held lines at ${seen.liveLines} steps`);
  assert.ok(seen.staleFlushes >= 5, `lines ingested while the live session was stale: ${seen.staleFlushes}`);
  assert.ok(seen.staleTrims >= 20, `a trim dropped lines while the live session was stale: ${seen.staleTrims}`);
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
  assert.equal(v.run('activeQuery.key'), v.run(`ALV.query.build('level:I+ tag:o "bench"', { case: true }, deviceInfo).q.key`));
  assert.equal(v.run('MAX_RETAINED'), 100000);
  const bad = bench('?bench=2000&q=%2Ftime(%2F&scenario=paused&cap=7');
  assert.equal(bad.run('filterGen'), 0, 'the invalid query left the filter alone');
  assert.equal(bad.run('MAX_RETAINED'), 50000, 'the paused scenario sets its own cap after &cap');
  assert.match(read(path.join(ASSETS, 'js', 'dev-bench.js')), /\bquery, queryError, cap: MAX_RETAINED,/, 'the result reports them');
});

test('the no-match tile\'s tag causes come from the tag counts: NOT tag:x on every retained line, tag:x on none; never while lines match', () => {
  const v = boot();
  v.send(8); v.api.flushBatch();             // tags bt_stack, BluetoothGatt, chatty, kernel, twice each
  const causes = text => { v.run(`setQuery(${JSON.stringify(text)})`); return [v.run('shellState().notTag'), v.run('shellState().tag')]; };
  assert.deepEqual(causes('tag:zzz'), ['', 'zzz'], 'no retained line matches tag:zzz');
  assert.deepEqual(causes('tag:zzz tag:kernel'), ['', ''], 'kernel lines exist: the tag is not why nothing shows');
  assert.deepEqual(causes('tag:kernel level:none'), ['', ''], 'the levels are the cause');
  v.run("liveSession.all.forEach(m => { m.tag = 'chatty'; }); ALV.counts.recount(liveSession.counts, liveSession.all, activeQuery.gate)");
  assert.deepEqual(causes('-tag:chatty'), ['chatty', ''], 'every retained line carries it');
  assert.deepEqual(causes('-tag:kernel x'), ['', ''], 'lines without kernel exist');
  assert.deepEqual(causes('-tag:chat'), ['chat', '']);
  v.run("setQuery('')");
  assert.deepEqual([v.run('shellState().notTag'), v.run('shellState().tag')], ['', ''], 'lines show: nothing to explain');
});
