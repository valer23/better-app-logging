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
// P4b: #stats became the filter bar's #filterCount ("N of M lines") and the status bar's #retainedText
// ("Retained N of MAX" with the #45 note; the long explanation is its title). The drops moved from the live
// bar's pills to the status bar's #dropsBtn (the total) and its popover (per platform).

const NAMES = ['handleWsMsg', 'flushBatch', 'togglePause', 'toggleAutoScroll', 'clearLogs', 'handleFile', 'updateNewerPill', 'doExport', 'openLogFile'];
const frame = i => JSON.stringify({
  type: 'log', ts: `2026 Oct 14 15:53:43.${String(i).padStart(6, '0')}`,
  pid: 57, tid: 0, tag: 'SpringBoard', app: '', lvl: 'INFO', msg: `line ${i}`,
});
const fileText = n => Array.from({ length: n },
  (_, i) => `Oct 14 15:53:43.${String(i).padStart(6, '0')} SpringBoard(FrontBoard)[57] <Notice>: file ${i}`).join('\n');

const display = (v, id) => v.doc.getElementById(id).style.display;

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

test('#45: past MAX_RETAINED the oldest live lines go, and the Retained text says how many', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(150); v.api.flushBatch();
  assert.equal(v.get('liveAll').length, 90);
  assert.equal(v.get('liveAll')[0].msg, 'line 60');
  assert.equal(v.get('liveDiscarded'), 60);
  assert.equal(v.text('filterCount'), '90 of 90 lines');
  assert.equal(v.text('retainedText'), 'Retained 90 of 100 · 60 older discarded');
  assert.equal(v.title('retainedText'), 'Live view keeps the newest 100 lines; older lines are discarded to bound memory.');
  assert.equal(v.text('retainedNote'), '60 older discarded', 'the note alone: what the narrow status-bar tier shows instead of the count');
  assert.equal(v.title('retainedNote'), v.title('retainedText'));
});

test('#45: while paused the backlog is capped, the Retained text says resume skips to newest, and Resume drains the rest', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(5); v.api.flushBatch();        // lines shown before the pause: Resume drops them (skip to newest)
  v.api.togglePause();
  v.send(101, 5);
  assert.equal(v.run('pendingBatch.length'), 90);
  assert.equal(v.get('liveDiscarded'), 11);
  assert.equal(v.text('retainedText'), 'Retained 5 of 100 · 11 discarded, resume skips to newest');
  assert.equal(v.text('retainedNote'), '11 discarded, resume skips to newest');
  assert.match(v.title('retainedText'), /^The paused backlog exceeded 100 lines/);
  v.api.togglePause();
  assert.equal(v.get('liveAll').length, 90);
  assert.equal(v.get('liveAll')[0].msg, 'line 16');
  assert.equal(v.get('liveDiscarded'), 16);
  assert.equal(v.text('retainedText'), 'Retained 90 of 100 · 16 older discarded');
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
  assert.equal(v.text('filterCount'), '0 of 0 lines');
});

test('#45: Clear resets the discarded count, so the Retained text stops reporting older discarded lines', () => {
  const v = boot();
  v.run('MAX_RETAINED = 100');
  v.send(150); v.api.flushBatch();
  assert.equal(v.get('liveDiscarded'), 60);
  v.api.clearLogs();
  assert.equal(v.get('liveDiscarded'), 0);
  assert.equal(v.text('retainedText'), 'Retained 0 of 100');
  assert.equal(v.text('retainedNote'), '', 'no note left: the narrow tier shows nothing');
});

test('#46: server drops are counted per platform in the status bar and reset by Clear', () => {
  const v = boot();
  v.drop('android', 5);
  v.drop('ios', 1);
  v.drop('ios', -3);   // not a positive integer: ignored
  assert.deepEqual({ ...v.get('liveDropped') }, { android: 5, ios: 1 });
  assert.equal(v.text('dropsText'), '6 lines dropped');
  assert.equal(v.text('dropsAndroidTitle'), '5 lines dropped from Android device');
  assert.equal(v.text('dropsIosTitle'), '1 line dropped from iPhone');
  assert.ok(v.text('dropsIosDesc').endsWith(PINNED.dropTooltipEnd), v.text('dropsIosDesc'));
  v.api.clearLogs();
  assert.deepEqual({ ...v.get('liveDropped') }, { android: 0, ios: 0 });
  assert.equal(v.text('dropsText'), '0 lines dropped');
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
  v.drop('ios', 4);
  v.api.togglePause();
  v.send(5, 3);                            // a paused backlog and a drop count that Clear on File must not touch
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  assert.equal(display(v, 'clearBtn'), '', 'Clear is shown on the File tab');
  v.api.clearLogs();
  assert.equal(v.get('fileAll').length, 0);
  assert.equal(display(v, 'dropzone'), '', 'Clear on File brings the dropzone back');
  assert.equal(v.get('liveAll').length, 3, 'Clear on File leaves live alone');
  assert.equal(v.run('pendingBatch.length'), 5, 'the paused live backlog survives');
  assert.equal(v.get('liveDropped').ios, 4, 'so do the #46 drop counts');
  assert.equal(v.run('liveSession.discarded'), 0);
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

// The stub fires 'change' on every pick, so this pins the clearing itself, not the browser rule.
test('Browse clears the file input after each pick, so the same file can be picked again after Clear on File', () => {
  const v = boot();
  const io = deferFileIo(v);
  v.go('toFile');
  const input = v.doc.getElementById('fileInput');
  const pick = () => {
    input.files = [{ text: fileText(3) }];
    input.value = 'C:\\fakepath\\same.log';
    for (const fn of v.doc.listeners.get('fileInput:change')) fn({ target: input });
  };
  pick(); io.finishRead(0); io.runTimers();
  assert.equal(v.get('fileAll').length, 3);
  assert.equal(input.value, '', 'cleared, so picking the same file fires change again');
  v.api.clearLogs();
  pick(); io.finishRead(1); io.runTimers();
  assert.equal(v.get('fileAll').length, 3);
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

// Change 1: the File tab shows only the loaded file, so the line count and Export count and write only it.
test('File tab: the line count and Export cover only the file; Live keeps its own counts', async () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.run('setTimeout = f => (f(), 0)');          // the file render timer runs at once
  v.run('globalThis.__saved = null; legacyDownload = (name, content) => { __saved = content; }');
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  assert.equal(v.text('filterCount'), '4 of 4 lines');
  assert.equal(v.text('retainedText'), '', 'Retained is about the live session');
  assert.equal(display(v, 'exportWrap'), '');
  for (const scope of ['all', 'filtered']) {
    v.doc.querySelector = sel => (assert.equal(sel, '#exportMenu [aria-checked="true"]'), { value: scope });
    v.run('__saved = null');
    await v.api.doExport('txt');
    const lines = v.run('__saved').split('\n');
    assert.equal(lines.length, 4, `export (${scope}) writes the 4 file lines`);
    assert.ok(lines.every(l => l.includes('file ')) && !lines.some(l => l.includes('line ')), `export (${scope}) holds no live line`);
  }
  v.go('toLive');
  assert.equal(v.text('filterCount'), '3 of 3 lines');
  v.run('__saved = null');
  await v.api.doExport('txt');
  assert.equal(v.run('__saved').split('\n').length, 3, 'on Live, Export writes the live lines');
  v.go('toFile');
  v.api.clearLogs();                            // Clear on File: nothing left to export there
  assert.equal(v.text('filterCount'), '0 of 0 lines');
  assert.equal(display(v, 'exportWrap'), 'none');
  v.go('toLive');
  assert.equal(display(v, 'exportWrap'), '', 'live still has lines to export');
});

// Change 4: each tab keeps its own selection and Follow. The delegated row click on #logTable reads the
// shown session (_load.mjs records the listeners the page registers), so a click on File cannot touch Live.
// P5a: the selection is the row's aria-selected (the grid's state), not a class. Returns the row's attributes.
// `td` is the cell the click lands in ({ className }); `attrs` carries the row's attributes across clicks.
function clickRow(v, message, { td = null, attrs = new Map() } = {}) {
  const tr = {
    _message: message,
    parentElement: { querySelector: () => null },
    setAttribute: (k, val) => attrs.set(k, String(val)), removeAttribute: k => attrs.delete(k),
  };
  for (const fn of v.doc.listeners.get('logTable:click')) fn({ target: { closest: sel => (sel === 'td' ? td : tr) }, detail: 1 });
  return attrs;
}

test('a row click on File selects in the file session and leaves live Follow and selection alone', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  assert.equal(v.run('liveSession.follow'), true);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  const msg = v.run('fileSession.all[1]');
  assert.equal(clickRow(v, msg).get('aria-selected'), 'true');
  assert.equal(v.run('fileSession.sel === fileSession.all[1]'), true);
  assert.equal(v.run('liveSession.sel'), null);
  assert.equal(v.run('liveSession.follow'), true, 'the click stopped no live auto-scroll');
  assert.equal(clickRow(v, msg).has('aria-selected'), false, 'a second click deselects');
  assert.equal(v.run('fileSession.sel'), null);
});

test('a row click on Live selects in the live session and turns its Follow off; File is untouched', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  v.go('toLive');
  clickRow(v, v.run('liveSession.all[2]'));
  assert.equal(v.run('liveSession.sel === liveSession.all[2]'), true);
  assert.equal(v.run('liveSession.follow'), false);
  assert.equal(v.run('fileSession.sel'), null);
});

test('the frozen-row guard reads the shown session: a trimmed live row is ignored on Live', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  const msg = v.run('liveSession.all[0]');
  v.run('liveSession.seqFloor = 100');       // every retained row is below the floor: frozen rows of trimmed lines
  clickRow(v, msg);
  assert.equal(v.run('liveSession.sel'), null);
  assert.equal(v.run('liveSession.follow'), true);
});

// P5a: the selected row is the only one that wraps its message, so it is where a long line is read and copied.
// A click that ends a text selection (a drag, the second click of a double click) and a plain click in the open
// row's message must leave it open: deselecting collapses the row under the cursor and loses the selection.
test('a click in the selected row\'s message cell keeps it selected; any other cell of it still deselects', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  const msg = v.run('liveSession.all[1]');
  const attrs = clickRow(v, msg);
  assert.equal(attrs.get('aria-selected'), 'true');
  clickRow(v, msg, { td: { className: 'c-msg' }, attrs });
  assert.equal(attrs.get('aria-selected'), 'true', 'the first click of a double or triple click');
  assert.equal(v.run('liveSession.sel === liveSession.all[1]'), true);
  clickRow(v, msg, { td: { className: 'c-tag' }, attrs });
  assert.equal(attrs.has('aria-selected'), false, 'a click on another cell of the row toggles it off');
  assert.equal(v.run('liveSession.sel'), null);
  const other = clickRow(v, msg, { td: { className: 'c-msg' } });
  assert.equal(other.get('aria-selected'), 'true', 'the message cell of a row that is not selected still selects it');
});

test('a click that ends a text selection selects and deselects nothing', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  const msg = v.run('liveSession.all[1]');
  v.run('window.getSelection = () => ({ isCollapsed: false })');
  const attrs = clickRow(v, msg, { td: { className: 'c-tag' } });
  assert.equal(attrs.has('aria-selected'), false, 'a drag-select inside a row does not select it');
  assert.equal(v.run('liveSession.sel'), null);
  assert.equal(v.run('liveSession.follow'), true, 'and does not stop Follow');
  v.run('window.getSelection = () => ({ isCollapsed: true })');
  const on = clickRow(v, msg, { td: { className: 'c-tag' } });
  assert.equal(on.get('aria-selected'), 'true', 'a collapsed selection is a plain click');
  v.run('window.getSelection = () => ({ isCollapsed: false })');
  clickRow(v, msg, { td: { className: 'c-tag' }, attrs: on });
  assert.equal(on.get('aria-selected'), 'true', 'a drag that ends on the selected row does not close it');
  assert.equal(v.run('liveSession.sel === liveSession.all[1]'), true);
});

// The legacy half of the shell adapter: "Open log file…" (the SESSIONS row and ⌘O) and the row's file name.
function spyFileInputClicks(v) {
  const input = v.doc.getElementById('fileInput');
  let clicks = 0;
  input.click = () => { clicks++; };
  return () => clicks;
}

test('openLogFile does nothing over the legacy setup or stall modal: cur stays Live and the picker stays closed', () => {
  const v = boot();
  const clicks = spyFileInputClicks(v);
  v.doc.getElementById('stallModal').classList.add('modal-overlay', 'visible');
  v.api.openLogFile();
  assert.equal(v.run('cur === liveSession'), true);
  assert.equal(clicks(), 0);
});

test('openLogFile selects the file session, then opens the picker', () => {
  const v = boot();
  const clicks = spyFileInputClicks(v);
  v.doc.getElementById('stallModal').classList.add('modal-overlay');   // present but not visible
  v.api.openLogFile();
  assert.equal(v.run('cur === fileSession'), true);
  assert.equal(clicks(), 1);
});

test('a loaded file names its SESSIONS row and shows it', () => {
  const v = boot();
  v.go('toFile');
  v.api.handleFile({ name: 'x.logcat', text: fileText(3) });
  assert.equal(v.text('sessFileName'), 'x.logcat');
  assert.equal(v.doc.getElementById('sessFileItem').hidden, false);
  assert.equal(v.text('sessFileCount'), '3');
});

// ---- The live session keeps its grid after Stop (user report: Stop showed the device panel over 166 727 lines) ----
// Streams through the real connect/disconnect paths: the page's WebSocket is kept per platform so a test can
// fire onopen / onerror / onclose the way the browser would.
function streamPage() {
  const v = boot();
  v.run(`globalThis.__ws = {}; WebSocket = function (url) { const ws = { url, close() {} }; __ws[url.endsWith(':8765') ? 'android' : 'ios'] = ws; return ws; };
    document.getElementById('androidDeviceSelect').value = 'a1'; document.getElementById('iosDeviceSelect').value = 'u1';`);
  return { ...v,
    open(p) { v.run(`${p === 'android' ? 'openAndroid' : 'openIos'}(); __ws.${p}.onopen()`); },
    view: () => ['livePanel', 'logWrapper'].filter(id => display(v, id) === '').join(),
  };
}

test('Stop keeps the recorded lines on screen; an empty live session with nothing streaming shows the device panel', () => {
  const p = streamPage();
  assert.equal(p.view(), 'livePanel', 'first launch: no lines, no stream');
  p.open('android'); p.open('ios');
  p.send(3, 0, 'android'); p.send(3, 3, 'ios'); p.api.flushBatch();
  p.run('toggleAndroid()');
  assert.equal(p.view(), 'logWrapper', 'iOS still streams');
  p.run('toggleIos()');
  assert.equal(p.view(), 'logWrapper', 'both stopped: the recorded lines stay readable');
  assert.equal(p.get('liveAll').length, 6);
  assert.equal(p.text('streamBadgeText'), 'Stopped · 6 lines');
  const q = streamPage();
  q.open('ios'); q.run('disconnectIos()');
  assert.equal(q.view(), 'livePanel', 'Stop with no line received');
});

test('Clear on Live: the panel when nothing streams, the emptied grid while a device streams', () => {
  const p = streamPage();
  p.open('ios'); p.send(2); p.api.flushBatch();
  p.api.clearLogs();
  assert.equal(p.view(), 'logWrapper', 'streaming: the grid refills');
  p.send(2, 2); p.api.flushBatch(); p.run('disconnectIos()');
  assert.equal(p.view(), 'logWrapper');
  p.api.clearLogs();
  assert.equal(p.view(), 'livePanel');
});

test('a socket ending on its own keeps the grid while the session holds lines', () => {
  const p = streamPage();
  p.open('android'); p.send(2, 0, 'android'); p.api.flushBatch();
  p.run('__ws.android.onerror(); __ws.android.onclose()');   // device unplugged, bridge gone
  assert.deepEqual([p.view(), p.run('androidLive')], ['logWrapper', false]);
  const q = streamPage();
  q.open('android'); q.run('__ws.android.onclose()');
  assert.equal(q.view(), 'livePanel');
});

test('a paused backlog counts as lines: Stop keeps the grid and Resume drains into it', () => {
  const p = streamPage();
  p.open('ios'); p.api.togglePause(); p.send(3);
  p.run('disconnectIos()');
  assert.equal(p.view(), 'logWrapper');
  p.api.togglePause();
  assert.deepEqual([p.get('liveAll').length, p.view()], [3, 'logWrapper']);
});

test('File <-> Live brings back the right live view', () => {
  const p = streamPage();
  p.open('ios'); p.send(2); p.api.flushBatch(); p.run('disconnectIos()');
  p.go('toFile');
  assert.equal(display(p, 'dropzone'), '', 'the empty File session');
  p.go('toLive');
  assert.equal(p.view(), 'logWrapper');
  p.api.clearLogs(); p.go('toFile'); p.go('toLive');
  assert.equal(p.view(), 'livePanel');
});

// P5b: Home and End (assets/js/grid.js binds them to these).
test('Home (jumpToOldest): Follow off, the window rebuilt at the oldest retained line, the drain marker reset (#58 invariant)', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(1200); v.api.flushBatch();
  v.run('liveSession.renderFrom = 7');   // as if a drain were in progress: the rebuild owns the DOM from here, as applyFilters
  v.run('jumpToOldest()');
  assert.equal(v.run('liveSession.follow'), false);
  assert.equal(v.run('liveSession.renderedEnd'), 500, 'PAGE rows from the head: the tbody is filtered[0, 500)');
  assert.equal(v.run('liveSession.renderFrom'), -1);
  assert.equal(v.run('liveSession.domStale'), false);
  v.doc.hidden = true;                  // no layout in a stub: keep the window from sliding
  v.send(10, 1200); v.api.flushBatch();
  assert.equal(v.run('liveSession.renderedEnd'), 500, 'reading: the window stays put while lines arrive (#54)');
});

test('End (jumpToEnd): Follow back on at the newest line; a file session moves its window to its last lines', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(1200); v.api.flushBatch();
  v.run('jumpToOldest()');
  v.run('jumpToEnd()');
  assert.deepEqual([v.run('liveSession.follow'), v.run('liveSession.renderedEnd')], [true, 1200]);
  v.run('setTimeout = f => (f(), 0)');
  v.go('toFile');
  v.api.handleFile({ text: fileText(1200) });
  assert.equal(v.run('fileSession.renderedEnd'), 500, 'a loaded file shows its first page');
  v.run('jumpToEnd()');
  assert.deepEqual([v.run('fileSession.renderedEnd'), v.run('fileSession.follow')], [1200, false], 'the last lines; a file never follows');
});

test('End (jumpToEnd) with Follow already on re-pins a window that slid back off the tail (#58 pinned scroll-back)', () => {
  const v = boot();
  v.doc.hidden = false;
  v.send(1200); v.api.flushBatch();
  v.api.togglePause();
  v.run('dropBottomRows(liveSession.tbody, 100)');   // prependOlderRows with Follow on trims the bottom: renderedEnd falls below filtered.length
  assert.deepEqual([v.run('liveSession.follow'), v.run('liveSession.renderedEnd') < v.run('liveSession.filtered.length')], [true, true], 'precondition: pinned, window short of the tail');
  v.run('jumpToEnd()');
  assert.equal(v.run('liveSession.follow'), true);
  assert.equal(v.run('liveSession.renderedEnd'), v.run('liveSession.filtered.length'), 'End reaches the newest line, not the bottom of the slid-back window');
});
