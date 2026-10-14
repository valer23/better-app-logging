// Live-buffer behaviour the P2 session refactor must keep (#45, #46, #54, #55, #57), pinned on the
// legacy inline script with a sticky document (tests/viewer/_load.mjs). Tests reach legacy state only
// through VIEW, so each refactor task edits VIEW and the PINNED constants, never a test body.
// document.hidden is true unless a test says otherwise: the drain then runs its data path only.
// Deleted with the legacy inline script in P13.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacy, stickyDocument } from './_load.mjs';

// Where each piece of state lives, as an expression in the legacy script's global scope.
const VIEW = {
  liveAll: 'liveSession.all',
  liveRenderedEnd: 'liveSession.renderedEnd',
  liveDiscarded: 'liveSession.discarded',
  liveDropped: 'liveSession.dropped',
  fileAll: 'fileSession.all',           // the buffer the File tab shows
  toFile: 'selectSession(fileSession)',
  toLive: 'selectSession(liveSession)',
};
// Behaviour P2 changed on purpose: a loaded file no longer resets the live drop counts.
const PINNED = {
  dropTooltipEnd: 'Resets on Clear.',
};

const NAMES = ['handleWsMsg', 'flushBatch', 'togglePause', 'toggleAutoScroll', 'clearLogs', 'handleFile', 'updateNewerPill', 'doExport'];
const frame = i => JSON.stringify({
  type: 'log', ts: `2026 Oct 14 15:53:43.${String(i).padStart(6, '0')}`,
  pid: 57, tid: 0, tag: 'SpringBoard', app: '', lvl: 'INFO', msg: `line ${i}`,
});
const fileText = n => Array.from({ length: n },
  (_, i) => `Oct 14 15:53:43.${String(i).padStart(6, '0')} SpringBoard(FrontBoard)[57] <Notice>: file ${i}`).join('\n');

function boot() {
  const doc = stickyDocument();
  const { api, run } = loadLegacy(NAMES, { document: doc });
  return {
    api, run, doc,
    get: key => run(VIEW[key]),
    go: key => run(VIEW[key]),
    send(n, from = 0, platform = 'ios') { for (let i = 0; i < n; i++) api.handleWsMsg({ data: frame(from + i) }, platform); },
    drop(platform, count) { api.handleWsMsg({ data: JSON.stringify({ type: 'dropped', count }) }, platform); },
    text: id => doc.getElementById(id).textContent,
    title: id => doc.getElementById(id).title,
  };
}

test('#45: past MAX_RETAINED the oldest live lines go, and #stats says how many', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(150); v.api.flushBatch();
  assert.equal(v.get('liveAll').length, 90);
  assert.equal(v.get('liveAll')[0].msg, 'line 60');
  assert.equal(v.get('liveDiscarded'), 60);
  assert.equal(v.text('stats'), '90 / 90 lines, 60 older discarded');
  assert.equal(v.title('stats'), 'Live view keeps the newest 100 lines; older lines are discarded to bound memory.');
});

test('#45: while paused the backlog is capped, #stats says resume skips to newest, and Resume drains the rest', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(5); v.api.flushBatch();        // lines shown before the pause: Resume drops them (skip to newest)
  v.api.togglePause();
  v.send(101, 5);
  assert.equal(v.run('pendingBatch.length'), 90);
  assert.equal(v.get('liveDiscarded'), 11);
  assert.equal(v.text('stats'), '5 / 5 lines, 11 discarded, resume skips to newest');
  assert.match(v.title('stats'), /^The paused backlog exceeded 100 lines/);
  v.api.togglePause();
  assert.equal(v.get('liveAll').length, 90);
  assert.equal(v.get('liveAll')[0].msg, 'line 16');
  assert.equal(v.get('liveDiscarded'), 16);
  assert.equal(v.text('stats'), '90 / 90 lines, 16 older discarded');
});

test('#55: Clear while paused discards the backlog, so Resume adds nothing', () => {
  const v = boot();
  v.send(5); v.api.flushBatch();
  v.api.togglePause();
  v.send(20, 5);
  v.api.clearLogs();
  assert.equal(v.run('pendingBatch.length'), 0);
  v.api.togglePause();
  assert.equal(v.get('liveAll').length, 0);
  assert.equal(v.text('stats'), '0 / 0 lines');
});

test('#45: Clear resets the discarded count, so #stats stops reporting older discarded lines', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(150); v.api.flushBatch();
  assert.equal(v.get('liveDiscarded'), 60);
  v.api.clearLogs();
  assert.equal(v.get('liveDiscarded'), 0);
  assert.equal(v.text('stats'), '0 / 0 lines');
});

test('#46: server drops are counted per platform on the live bar and reset by Clear', () => {
  const v = boot();
  v.drop('android', 5);
  v.drop('ios', 1);
  v.drop('ios', -3);   // not a positive integer: ignored
  assert.deepEqual({ ...v.get('liveDropped') }, { android: 5, ios: 1 });
  assert.equal(v.text('liveBarAndroidDroppedText'), '⚠ 5 lines dropped');
  assert.equal(v.text('liveBarIosDroppedText'), '⚠ 1 line dropped');
  assert.ok(v.title('liveBarIosDropped').endsWith(PINNED.dropTooltipEnd), v.title('liveBarIosDropped'));
  v.api.clearLogs();
  assert.deepEqual({ ...v.get('liveDropped') }, { android: 0, ios: 0 });
  assert.equal(v.text('liveBarAndroidDroppedText'), '⚠ 0 lines dropped');
});

test('#55 per session: a file load keeps the paused live backlog and drop counts; Clear on Live still discards them', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.drop('ios', 4);
  v.api.togglePause();
  v.send(10, 3);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  assert.equal(v.run('pendingBatch.length'), 10);
  assert.equal(v.get('liveDropped').ios, 4);
  assert.equal(v.get('fileAll').length, 4);
  v.go('toLive');
  v.api.togglePause();                     // Resume drains the backlog into the live session
  assert.equal(v.get('liveAll').length, 13);
  v.api.togglePause();
  v.send(5, 13);
  v.api.clearLogs();                       // Clear on Live (#55)
  assert.equal(v.run('pendingBatch.length'), 0);
  assert.equal(v.get('liveDropped').ios, 0);
  assert.equal(v.get('liveAll').length, 0);
  assert.equal(v.get('fileAll').length, 4, 'Clear on Live leaves the file session alone');
});

test('a live flush while the File tab is shown leaves the file buffer alone', () => {
  const v = boot();
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.send(6); v.api.flushBatch();
  assert.equal(v.get('fileAll').length, 4);
  assert.ok(v.get('fileAll').every(m => m.seq === undefined));
  assert.equal(v.get('liveAll').length, 6);
});

test('#54 and #57: with Follow off the window stays put and the pill counts the lines below it', () => {
  const v = boot();
  v.doc.hidden = false;                 // render the first lines (into stubs)
  v.send(5); v.api.flushBatch();
  v.api.toggleAutoScroll();             // Follow off: reading
  v.doc.hidden = true;                  // no layout in a stub: keep the window from sliding
  v.send(7, 5); v.api.flushBatch();
  assert.equal(v.get('liveRenderedEnd'), 5);
  v.doc.hidden = false;
  v.api.updateNewerPill();
  assert.equal(v.text('newerPillCount'), '7 lines below');
});

test('#57: lines that arrive while the file session is shown count as lines below on return', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(5); v.api.flushBatch();
  v.api.toggleAutoScroll();
  v.doc.hidden = true;
  v.go('toFile');
  v.send(9, 5); v.api.flushBatch();
  v.go('toLive');
  assert.equal(v.get('liveRenderedEnd'), 5);
  v.doc.hidden = false;
  v.api.updateNewerPill();
  assert.equal(v.text('newerPillCount'), '9 lines below');
});

test('the retention cap trims the live session while the file session is shown, and never the file', () => {
  const v = boot();
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.run('MAX_RETAINED = 100');
  v.send(150); v.api.flushBatch();
  assert.equal(v.get('liveAll').length, 90);
  assert.equal(v.get('liveDiscarded'), 60);
  assert.equal(v.get('fileAll').length, 4);
  assert.equal(v.run('fileSession.discarded'), 0);
});

test('a filter change while the file session is shown leaves live stale; showing live refilters it', () => {
  const v = boot();
  v.send(4); v.api.flushBatch();
  v.go('toFile');
  v.doc.getElementById('search').value = 'line 1';
  v.run('queryChanged()');
  v.send(10, 4); v.api.flushBatch();
  assert.equal(v.run('liveSession.filtered.length'), 4, 'not filtered while stale');
  assert.notEqual(v.run('liveSession.query'), v.run('filterGen'));
  assert.equal(v.run('fileSession.query'), v.run('filterGen'));
  v.go('toLive');
  assert.equal(v.run('liveSession.query'), v.run('filterGen'));
  assert.deepEqual([...v.run('liveSession.filtered.map(m => m.msg)')], ['line 1', 'line 10', 'line 11', 'line 12', 'line 13']);
});

test('a switch does not reset the live selection or Follow; a file session never follows', () => {
  const v = boot();
  v.send(5); v.api.flushBatch();
  v.run('liveSession.sel = liveSession.all[2]; liveSession.follow = false;');
  v.go('toFile');
  assert.equal(v.run('cur === fileSession'), true);
  assert.equal(v.run('fileSession.follow'), false);
  v.go('toLive');
  assert.equal(v.run('cur === liveSession'), true);
  assert.equal(v.run('liveSession.sel === liveSession.all[2]'), true);
  assert.equal(v.run('liveSession.follow'), false);
});

test('switching back mid-drain resets the drain marker, and the next flush drains the rest', () => {
  const v = boot();
  v.send(5000);
  v.run('performance.now = (() => { let t = 0; return () => (t += 30); })()');   // 50 ms budget runs out at frame 4096
  v.api.flushBatch();
  assert.equal(v.run('pendingBatch.length'), 904);
  assert.ok(v.run('liveSession.renderFrom') >= 0, 'a drain is in progress');
  v.go('toFile');
  v.go('toLive');
  assert.equal(v.run('liveSession.renderFrom'), -1);
  v.api.flushBatch();
  assert.equal(v.run('pendingBatch.length'), 0);
  assert.equal(v.get('liveAll').length, 5000);
  assert.equal(v.run('liveSession.renderFrom'), -1);
});

test('Clear on File empties only the file session, and a second file can be loaded', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.api.clearLogs();
  assert.equal(v.get('fileAll').length, 0);
  assert.equal(v.get('liveAll').length, 3, 'Clear on File leaves live alone');
  v.api.handleFile({ text: fileText(2) });
  assert.equal(v.get('fileAll').length, 2);
});

// offscreen(s) is `s !== cur || document.hidden`. These tests keep the window visible (hidden = false),
// so only the `s !== cur` half can gate the render paths: a path that reads document.hidden instead
// renders live rows into whichever tbody the session holds.
test('offscreen gate: a live flush with another session shown keeps the DOM untouched and marks it stale', () => {
  const v = boot();
  v.doc.hidden = false;
  v.run("cur = ALV.session.create('file', 'f'); cur.tbody = document.getElementById('x')");
  v.send(3); v.api.flushBatch();
  assert.equal(v.run('liveSession.domStale'), true);
  assert.equal(v.run('liveSession.renderedEnd'), 3);
  assert.equal(v.run('liveSession.filtered.length'), 3);
});

test('offscreen gate: the same flush with the live session shown renders it (control)', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(3); v.api.flushBatch();
  assert.equal(v.run('liveSession.domStale'), false);
  assert.equal(v.run('liveSession.renderedEnd'), 3);
});

test('offscreen gate: dropTrimmedRows on an off-screen followed session defers to the next render', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(3); v.api.flushBatch();
  v.run("liveSession.tbody = { rows: [{ _message: { seq: 0 } }, { _message: { seq: 1 } }, { _message: { seq: 2 } }] }");
  v.run("cur = ALV.session.create('file', 'f'); cur.tbody = document.getElementById('x')");
  v.run('dropTrimmedRows(liveSession, 2)');
  assert.equal(v.run('liveSession.domStale'), true);
  assert.equal(v.run('liveSession.tbody.rows.length'), 3, 'rows untouched');
});

// A file load is async: FileReader finishes later, then a 50 ms timer renders. These tests hold both
// back so Clear (shown on File since change 8) or a second drop can land in between.
function deferFileIo(v) {
  v.run(`globalThis.__readers = []; globalThis.__timers = [];
    FileReader = class { readAsText(file) { this.file = file; __readers.push(this); } };
    setTimeout = f => (__timers.push(f), 0);`);
  return {
    finishRead: i => v.run(`__readers[${i}].onload({ target: { result: __readers[${i}].file.text } })`),
    runTimers: () => v.run('__timers.splice(0).forEach(f => f())'),
  };
}
const display = (v, id) => v.doc.getElementById(id).style.display;

test('Clear on File while a file is still being read cancels that load', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.api.clearLogs();
  io.finishRead(0); io.runTimers();
  assert.equal(v.get('fileAll').length, 0, 'the cancelled read does not repopulate the session');
  assert.equal(display(v, 'dropzone'), '', 'the dropzone is the only way to load a file, so it stays');
  assert.equal(display(v, 'logWrapper'), 'none');
});

test('Clear on File between the read and the 50 ms render leaves the dropzone showing', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  io.finishRead(0);
  v.api.clearLogs();
  io.runTimers();
  assert.equal(v.get('fileAll').length, 0);
  assert.equal(display(v, 'dropzone'), '');
  assert.equal(display(v, 'logWrapper'), 'none');
});

test('Clear then a second drop: the cancelled first read cannot replace the second file', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  v.api.handleFile({ text: fileText(5) });   // big
  v.api.clearLogs();
  v.api.handleFile({ text: fileText(2) });   // small
  io.finishRead(1); io.runTimers();
  io.finishRead(0); io.runTimers();          // the cancelled read finishes last
  assert.equal(v.get('fileAll').length, 2);
  assert.match(v.get('fileAll')[0].msg, /^file 0/);
  assert.equal(display(v, 'logWrapper'), '');
});

test('two overlapping drops: the later drop wins even when the earlier read finishes last', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  v.api.handleFile({ text: fileText(5) });
  v.api.handleFile({ text: fileText(2) });
  io.finishRead(1); io.runTimers();
  io.finishRead(0); io.runTimers();
  assert.equal(v.get('fileAll').length, 2);
});

test('Clear on Live while a file is being read does not cancel the load', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.go('toLive');
  v.api.clearLogs();
  io.finishRead(0);
  assert.equal(v.get('fileAll').length, 4);
});

// Change 5: following Live comes back pinned to the newest line, also after the filter changed on File.
// More than PAGE lines, so a render from the head (a refilter's first page) and the re-pinned tail differ.
function followedLiveBehindAFilterChange(v, { sel = -1 } = {}) {
  v.doc.hidden = false;
  v.send(1200); v.api.flushBatch();
  if (sel >= 0) v.run(`liveSession.sel = liveSession.all[${sel}]`);   // Follow stays on (Jump to latest keeps the selection)
  v.go('toFile');
  v.doc.getElementById('search').value = 'line';
  v.run('queryChanged()');
  v.send(10, 1200); v.api.flushBatch();
}

test('Live followed behind a filter change on File comes back with its window at the newest line', () => {
  const v = boot();
  followedLiveBehindAFilterChange(v);
  v.go('toLive');
  assert.equal(v.run('liveSession.filtered.length'), 1210);
  assert.equal(v.run('liveSession.renderedEnd'), 1210);
  assert.equal(v.run('liveSession.follow'), true);
  assert.equal(v.run('liveSession.domStale'), false);
});

test('Live followed with a selection behind a filter change: no selection-centred render unpins the tail', () => {
  const v = boot();
  v.run('globalThis.__raf = []; requestAnimationFrame = f => (__raf.push(f), 0); globalThis.__built = 0');
  followedLiveBehindAFilterChange(v, { sel: 1195 });   // among the newest 300
  v.run('{ const real = buildRow; buildRow = (...a) => (__built++, real(...a)); }');
  v.run('__built = 0');
  v.go('toLive');
  assert.equal(v.run('__raf.length'), 0, 'a rAF would centre the selected row and leave the tail unpinned');
  assert.equal(v.run('__built'), 300, 'only the pinned FOLLOW_DOM_CAP tail is built, not a throwaway page around the selection');
  assert.equal(v.run('liveSession.renderedEnd'), 1210);
  assert.equal(v.run('liveSession.follow'), true);
});

test('Live reading (Follow off) behind a filter change still renders around its selection', () => {
  const v = boot();
  v.run('globalThis.__raf = []; requestAnimationFrame = f => (__raf.push(f), 0)');
  followedLiveBehindAFilterChange(v, { sel: 600 });
  v.run('liveSession.follow = false');
  v.run('__raf.length = 0');
  v.go('toLive');
  assert.equal(v.run('__raf.length'), 1, 'the reader is brought back to the selected row');
  assert.equal(v.run('liveSession.renderedEnd') < 1210, true);
});

// Change 1: the File tab shows only the loaded file, so #stats and Export count and write only it.
test('File tab: #stats and Export cover only the file; Live keeps its own counts', async () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.run('setTimeout = f => (f(), 0)');          // the file render timer runs at once
  v.run('globalThis.__saved = null; legacyDownload = (name, content) => { __saved = content; }');
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  assert.equal(v.text('stats'), '4 / 4 lines');
  assert.equal(display(v, 'exportWrap'), '');
  for (const scope of ['all', 'filtered']) {
    v.doc.querySelector = () => ({ value: scope });
    v.run('__saved = null');
    await v.api.doExport('txt');
    const lines = v.run('__saved').split('\n');
    assert.equal(lines.length, 4, `export (${scope}) writes the 4 file lines`);
    assert.ok(lines.every(l => l.includes('file ')) && !lines.some(l => l.includes('line ')), `export (${scope}) holds no live line`);
  }
  v.go('toLive');
  assert.equal(v.text('stats'), '3 / 3 lines');
  v.run('__saved = null');
  await v.api.doExport('txt');
  assert.equal(v.run('__saved').split('\n').length, 3, 'on Live, Export writes the live lines');
  v.go('toFile');
  v.api.clearLogs();                            // Clear on File: nothing left to export there
  assert.equal(v.text('stats'), '0 / 0 lines');
  assert.equal(display(v, 'exportWrap'), 'none');
  v.go('toLive');
  assert.equal(display(v, 'exportWrap'), '', 'live still has lines to export');
});
