// The page side of the query (roadmap P6): the legacy script compiles the filter bar into ALV.query and runs it in the
// drain, keeps every session's counts with it (flush, trim, Clear, file load, refilter), keeps the last valid filter on an
// invalid regex, and shows the counts in the level toggles' tooltips. Run on the legacy inline script with a sticky
// document (tests/viewer/_load.mjs), document.hidden true: the drain takes its data path only.
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
    field(id, value) { doc.getElementById(id).value = value; },
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

test('queryChanged turns the filter bar into query text; a filter that compiles the same refilters nothing', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  v.field('search', 'line 1');
  v.run('queryChanged()');
  assert.equal(v.run('filterGen'), 1);
  assert.deepEqual(v.run('liveSession.filtered.map(m => m.msg)').join(','), 'line 1,line 10,line 11,line 12,line 13,line 14,line 15,line 16,line 17,line 18,line 19');
  v.run('queryChanged()');
  assert.equal(v.run('filterGen'), 1, 'the same text compiles to the same key: no refilter');
  v.run('toggleSearchMod("regex")');
  assert.equal(v.run('filterGen'), 2, '.* turns the search into a /regex/');
  v.run("enabledLevels.delete('VERBOSE'); queryChanged()");
  assert.equal(v.run('liveSession.filtered.length'), 9, 'line 1 and 10-19 without the VERBOSE ones (12, 18)');
  assert.equal(v.run('setQuery("tag:bt")'), null);
  assert.equal(v.run('liveSession.filtered.length'), 8, 'setQuery replaces the whole filter: tag bt_stack, every level');
  assert.equal(v.run("liveSession.filtered.filter(m => m.lvl === 'VERBOSE').length"), 3);
  assert.match(v.run('setQuery("tg:bt").msg'), /^Unknown field 'tg'/);
  assert.equal(v.run('liveSession.filtered.length'), 8, 'an invalid query changes nothing');
});

test('an invalid regex search keeps the last valid filter applied and marks the .* button; a valid one clears the mark', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  v.run('toggleSearchMod("regex")');
  v.field('search', 'line 2.');
  v.run('queryChanged()');
  const gen = v.run('filterGen');
  assert.equal(v.run('liveSession.filtered.length'), 10, '/line 2./: line 20 to line 29');
  v.field('search', 'line (2');
  v.run('queryChanged()');
  assert.deepEqual([v.run('filterGen'), v.run('liveSession.filtered.length')], [gen, 10], 'the last valid filter stays');
  assert.equal(v.doc.getElementById('searchRegexBtn').classList.contains('error'), true);
  v.field('search', 'line (2)');
  v.run('queryChanged()');
  assert.equal(v.doc.getElementById('searchRegexBtn').classList.contains('error'), false);
  assert.equal(v.run('liveSession.filtered.length'), 11);
});

test('with an invalid regex in the box every other legacy control still applies; only the search term stays at its last valid value', () => {
  const v = boot();
  v.send(30); v.api.flushBatch();
  v.run('toggleSearchMod("regex")');
  v.field('search', 'line .');
  v.run('queryChanged()');
  assert.equal(v.run('liveSession.filtered.length'), 30);
  v.field('search', 'line (');
  v.run('queryChanged()');
  assert.equal(v.doc.getElementById('searchRegexBtn').classList.contains('error'), true);
  v.run("enabledLevels.delete('VERBOSE'); queryChanged()");
  assert.equal(v.run("liveSession.filtered.filter(m => m.lvl === 'VERBOSE').length"), 0, 'a level toggle applies');
  assert.equal(v.run('liveSession.filtered.length'), 25);
  v.run("togglePlatform('ios')");
  assert.equal(v.run("liveSession.filtered.filter(m => m.platform === 'ios').length"), 0, 'a platform toggle applies');
  v.field('tagFilter', 'bt');
  v.run('queryChanged()');
  assert.equal(v.run('liveSession.filtered.length'), 0, 'every line here is ios: nothing left');
  v.run("togglePlatform('ios')");
  assert.equal(v.run("liveSession.filtered.every(m => m.tag === 'bt_stack' && m.lvl !== 'VERBOSE')"), true, 'the Tag field applies');
  assert.equal(v.run('liveSession.filtered.length'), 5, 'tag bt_stack (8 lines) minus its 3 VERBOSE ones, still /line ./ (the last valid search)');
  assert.equal(v.doc.getElementById('searchRegexBtn').classList.contains('error'), true, 'the .* error mark stays');
  assert.deepEqual([v.run('shellState().levels'), v.run('shellState().tag')], [5, 'bt'], 'the empty-state causes read the applied filter');
  v.run("resetFilter('levels')");
  assert.equal(v.run("liveSession.filtered.some(m => m.lvl === 'VERBOSE')"), true, 'the empty-state fix applies');
  v.field('search', 'line (2)');
  v.run('queryChanged()');
  assert.equal(v.doc.getElementById('searchRegexBtn').classList.contains('error'), false);
  assert.equal(v.run("liveSession.filtered.every(m => /line (2)/.test(m.msg))"), true, 'a valid regex takes over again');
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
    else if (op === 6) { v.field('tagFilter', ['', 'bt', 'kernel', 'x'][r(4)]); v.field('search', ['', 'line 1', '2'][r(3)]); v.run('queryChanged()'); }
    else if (op === 7) v.run(`togglePlatform('${r(2) ? 'ios' : 'android'}')`);
    else if (op === 8) v.run(`{ const l = ${JSON.stringify(LV)}[${r(6)}]; enabledLevels.has(l) ? enabledLevels.delete(l) : enabledLevels.add(l); queryChanged(); }`);
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

test('the level toggles\' tooltips carry the counts: lines of each level that pass the rest of the filter', () => {
  const v = boot();
  v.send(12); v.api.flushBatch();
  v.field('tagFilter', 'bt');
  v.run("enabledLevels.delete('INFO'); queryChanged(); syncLevelTitles()");
  assert.equal(v.run('liveSession.filtered.length'), 2, 'bt_stack lines 0 (V) and 4 (E); line 8 (I) is hidden');
  assert.deepEqual([...v.run('levelBtns.map(b => b.title)')], ['Verbose, 1 line', 'Debug, 0 lines', 'Info, 1 line', 'Warning, 0 lines', 'Error, 1 line', 'Fatal, 0 lines'],
    'Info still counts its line: counts ignore the level filter');
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
