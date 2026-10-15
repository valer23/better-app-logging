// The pure session module (viewer/assets/js/session.js): one shape for every session, the retention
// trim, the paused-backlog cap and the resets, each scoped to the session it is given. Loaded in an
// EMPTY vm context, so any page, storage or timer use at load throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ASSETS, HTML_PATH, read, loadPureModule, pageScriptSrcs, inlineScripts } from './_load.mjs';

const SRC = read(path.join(ASSETS, 'js', 'session.js'));
const S = loadPureModule('session.js').session;

// n live lines with seq from..from+n-1; odd seqs are INFO (they pass `info`), even ones DEBUG.
const lines = (n, from = 0) => Array.from({ length: n },
  (_, i) => ({ seq: from + i, lvl: (from + i) % 2 ? 'INFO' : 'DEBUG', msg: `l${from + i}` }));
const info = m => m.lvl === 'INFO';
function liveWith(n) {
  const s = S.create('live', 'Live session');
  s.all = lines(n);
  s.filtered = s.all.filter(info);
  return s;
}

test('session.js loads in an empty context and names no page, storage or timer API', () => {
  assert.equal(typeof S.create, 'function');
  assert.doesNotMatch(SRC, /\b(document|localStorage|sessionStorage|setTimeout|setInterval|requestAnimationFrame)\b/);
});

test('the page loads session.js synchronously, after prefs.js and before the legacy script', () => {
  const html = read(HTML_PATH);
  assert.deepEqual(pageScriptSrcs(html), ['assets/js/prefs.js', 'assets/js/session.js', 'assets/js/dom.js']);
  const tag = html.indexOf('<script src="assets/js/session.js"></script>');
  assert.ok(tag > 0 && tag < html.lastIndexOf('<script>'), 'session.js comes before the legacy inline script');
});

test('create: live and file sessions share one shape (same keys, same order) with their own defaults', () => {
  const live = S.create('live', 'Live session'), file = S.create('file', 'trace.log');
  assert.deepEqual(Object.keys(live), Object.keys(file));
  assert.deepEqual(Object.keys(live), ['id', 'kind', 'name', 'all', 'filtered', 'renderedEnd', 'renderFrom',
    'domStale', 'follow', 'sel', 'query', 'scroll', 'discarded', 'overflowed', 'seqFloor', 'dropped',
    'markers', 'gaps', 'tbody']);
  assert.equal(live.follow, true);
  assert.equal(file.follow, false);
  assert.equal(live.renderFrom, -1);
  assert.notEqual(live.id, file.id);
  assert.notEqual(live.all, file.all);
  assert.notEqual(live.dropped, file.dropped);
  assert.deepEqual({ ...live.dropped }, { android: 0, ios: 0 });
  assert.throws(() => S.create('remote', 'x'), /session kind/);
});

test('firstIndexWhere finds the first index where a monotone predicate holds', () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(S.firstIndexWhere(a, 0, x => x >= 3), 2);
  assert.equal(S.firstIndexWhere(a, 0, x => x > 9), 5);
  assert.equal(S.firstIndexWhere(a, 0, () => true), 0);
  assert.equal(S.firstIndexWhere(a, 3, x => x >= 1), 3);
  assert.equal(S.firstIndexWhere([], 0, () => true), 0);
  assert.equal(S.firstIndexWhere({ length: 3, 0: 1, 1: 5, 2: 9 }, 0, x => x > 4), 1);   // array-like (tbody.rows)
});

test('trim: no-op under the cap, and NaN or Infinity means no cap', () => {
  for (const max of [200, NaN, Infinity]) {
    const s = liveWith(150), all = s.all, filtered = s.filtered;
    assert.equal(S.trim(s, max, 0.1, false, 150), -1);
    assert.equal(s.all, all);
    assert.equal(s.all.length, 150);
    assert.equal(s.filtered, filtered);
    assert.equal(s.discarded, 0);
    assert.equal(s.seqFloor, 0);
  }
});

test('trim: drops the oldest lines to 90 % of the cap, in place, and keeps the window indexes in step', () => {
  const s = liveWith(150), all = s.all, filtered = s.filtered;   // filtered = the 75 odd seqs
  s.renderedEnd = 75;
  s.renderFrom = 70;
  assert.equal(S.trim(s, 100, 0.1, false, 150), 60);
  assert.equal(s.all, all, 'spliced in place: a hoisted reference stays valid');
  assert.equal(s.filtered, filtered);
  assert.equal(s.all.length, 90);
  assert.equal(s.all[0].seq, 60);
  assert.equal(s.filtered.length, 45);
  assert.equal(s.filtered[0].seq, 61);
  assert.equal(s.renderedEnd, 45);
  assert.equal(s.renderFrom, 40);
  assert.equal(s.seqFloor, 60);
  assert.equal(s.discarded, 60);
});

test('trim: an index inside the dropped run snaps to its start; renderFrom -1 stays -1', () => {
  const s = liveWith(150);
  s.renderedEnd = 10;
  assert.equal(S.trim(s, 100, 0.1, false, 150), 60);
  assert.equal(s.renderedEnd, 0);
  assert.equal(s.renderFrom, -1);
});

test('trim: clears the selection only when its line was dropped', () => {
  const a = liveWith(150);
  a.sel = a.all[59];
  S.trim(a, 100, 0.1, false, 150);
  assert.equal(a.sel, null);
  const b = liveWith(150), kept = b.all[60];
  b.sel = kept;
  S.trim(b, 100, 0.1, false, 150);
  assert.equal(b.sel, kept);
});

test('trim: dropAll drops every live line and the floor becomes nextSeq', () => {
  const s = liveWith(20);
  assert.equal(S.trim(s, 100, 0.1, true, 20), 20);
  assert.equal(s.all.length, 0);
  assert.equal(s.filtered.length, 0);
  assert.equal(s.seqFloor, 20);
  assert.equal(s.discarded, 20);
  assert.equal(S.trim(S.create('live', 'empty'), 100, 0.1, true, 0), -1);
});

test('trim: lines without a seq stay pinned in front and are never counted', () => {
  const s = S.create('live', 'mixed');
  const pinned = [{ lvl: 'INFO', msg: 'f0' }, { lvl: 'INFO', msg: 'f1' }];
  s.all = [...pinned, ...lines(150)];
  s.filtered = s.all.filter(info);   // 2 pinned + the 75 odd seqs
  assert.equal(S.trim(s, 100, 0.1, false, 150), 60);
  assert.equal(s.all.length, 92);
  assert.equal(s.all[1], pinned[1]);
  assert.equal(s.all[2].seq, 60);
  assert.equal(s.filtered[1], pinned[1]);
  assert.equal(s.filtered[2].seq, 61);
  assert.equal(s.discarded, 60);
  const file = S.create('file', 'trace.log');   // only seq-less lines: nothing to trim
  file.all = lines(150).map(({ lvl, msg }) => ({ lvl, msg }));
  assert.equal(S.trim(file, 100, 0.1, false, 999), -1);
  assert.equal(file.all.length, 150);
});

test('trimPending caps a backlog at 90 % of the cap, oldest first, and marks its session overflowed', () => {
  const s = S.create('live', 'x'), pending = lines(101);
  assert.equal(S.trimPending(pending, s, 100, 0.1), 11);
  assert.equal(pending.length, 90);
  assert.equal(pending[0].seq, 11);
  assert.equal(s.discarded, 11);
  assert.equal(s.overflowed, true);
  assert.equal(S.trimPending(lines(50), s, 100, 0.1), 0);
  assert.equal(s.discarded, 11);
});

test('trimming, capping and discarding one session leave another session untouched', () => {
  const live = liveWith(150), file = S.create('file', 'trace.log');
  file.all = lines(150).map(({ lvl, msg }) => ({ lvl, msg }));
  file.filtered = file.all.slice();
  file.renderedEnd = 120;
  file.sel = file.all[3];
  const all = file.all, filtered = file.filtered;
  S.trim(live, 100, 0.1, false, 150);
  S.trimPending(lines(200), live, 100, 0.1);
  S.discard(live);
  assert.equal(file.all, all);
  assert.equal(file.all.length, 150);
  assert.equal(file.filtered, filtered);
  assert.equal(file.filtered.length, 150);
  assert.equal(file.renderedEnd, 120);
  assert.equal(file.sel, file.all[3]);
  assert.equal(file.discarded, 0);
  assert.equal(file.overflowed, false);
  assert.equal(file.seqFloor, 0);
});

test('discard resets the drain marker and the loss counters of its own session only', () => {
  const a = S.create('live', 'a'), b = S.create('live', 'b');
  for (const s of [a, b]) {
    s.renderFrom = 7; s.discarded = 5; s.overflowed = true; s.seqFloor = 9;
    s.dropped.android = 2; s.dropped.ios = 3;
  }
  const dropped = a.dropped;
  S.discard(a);
  assert.equal(a.renderFrom, -1);
  assert.equal(a.discarded, 0);
  assert.equal(a.overflowed, false);
  assert.deepEqual({ ...a.dropped }, { android: 0, ios: 0 });
  assert.equal(a.dropped, dropped, 'zeroed in place');
  assert.equal(a.seqFloor, 9, 'the floor still guards clicks on rows of trimmed lines');
  assert.equal(b.renderFrom, 7);
  assert.equal(b.discarded, 5);
  assert.equal(b.overflowed, true);
  assert.deepEqual({ ...b.dropped }, { android: 2, ios: 3 });
});

test('reset replaces the lines and empties the view; Follow, the query generation and the counters stay', () => {
  const s = liveWith(10);
  Object.assign(s, { renderedEnd: 10, renderFrom: 4, domStale: true, follow: false, query: 3, discarded: 2 });
  s.sel = s.all[1];
  Object.assign(s.scroll, { top: 500, left: 20, anchor: {}, anchorTop: 7 });
  const next = lines(3, 100);
  S.reset(s, next);
  assert.equal(s.all, next);
  assert.equal(s.filtered.length, 0);
  assert.equal(s.renderedEnd, 0);
  assert.equal(s.renderFrom, -1);
  assert.equal(s.domStale, false);
  assert.equal(s.sel, null);
  assert.deepEqual({ ...s.scroll }, { top: 0, left: 0, anchor: null, anchorTop: 0 });
  assert.equal(s.follow, false);
  assert.equal(s.query, 3);
  assert.equal(s.discarded, 2);
});

// How the legacy inline script uses the module (P2 structure; the behaviour is in session-parity.test.mjs).
const legacy = () => inlineScripts().at(-1).code;

test('retention lives in session.js only: the legacy script keeps no copy of the trim', () => {
  const code = legacy();
  assert.doesNotMatch(code, /function firstIndexWhere\(/);
  assert.match(code, /ALV\.session\.trim\(/);
  assert.match(code, /ALV\.session\.trimPending\(/);
  assert.match(code, /ALV\.session\.discard\(/);
});

test('each session renders into its own tbody: the legacy script looks #tbody up once, at start', () => {
  assert.equal(legacy().split("getElementById('tbody')").length - 1, 1);
});

test('dev-bench.js offers the behind scenario and reports its checks', () => {
  const src = read(path.join(ASSETS, 'js', 'dev-bench.js'));
  assert.match(src, /\['follow', 'read', 'paused', 'behind'\]/);
  for (const key of ['maxLiveRows', 'fileRowsMutated', 'fileHasLiveLines', 'switchLiveMsMax', 'switchFileMsMax',
    'liveRowsAfterReturn', 'liveTailOk', 'restoreOk']) assert.ok(src.includes(key), `result key ${key}`);
});

// Source of the top-level function `name` in the legacy script (from its `function` line to the closing brace at column 0).
function fnSource(name) {
  const code = legacy();
  const start = code.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `function ${name} exists`);
  return code.slice(start, code.indexOf('\n}\n', start));
}

test('document.hidden is read only by offscreen, the two position indicators and the visibilitychange listener', () => {
  const code = legacy();
  const owners = [];
  const re = /^function (\w+)\(|^document\.addEventListener\('(\w+)'|document\.hidden/gm;
  let owner = null, m;
  while ((m = re.exec(code))) {
    if (m[1] || m[2]) owner = m[1] || `listener:${m[2]}`;
    else owners.push(owner);
  }
  assert.deepEqual(owners.sort(),
    ['listener:visibilitychange', 'offscreen', 'updateNewerPill', 'updateReadingWindowHint']);
});

test('the render paths gate on offscreen(s), which also covers a session that is not shown', () => {
  assert.match(legacy(), /function offscreen\(s\) \{ return s !== cur \|\| document\.hidden; \}/);
  for (const name of ['flushBatch', 'renderLiveTail', 'extendReadingWindow', 'dropTrimmedRows', 'prependOlderRows']) {
    assert.match(fnSource(name), /offscreen\(/, `${name} calls offscreen(`);
  }
});
