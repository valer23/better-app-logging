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
  fileAll: 'liveSession.all',           // the buffer the File tab shows (still the one buffer)
  toFile: "switchMode('file')",
  toLive: "switchMode('live')",
};
// Behaviour P2 changes on purpose (Task 8 flips these).
const PINNED = {
  dropTooltipEnd: 'Resets on Clear or when a file is loaded.',
};

const NAMES = ['handleWsMsg', 'flushBatch', 'togglePause', 'toggleAutoScroll', 'clearLogs', 'handleFile', 'updateNewerPill'];
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

test('#55 as shipped before P2: a file load discards the paused live backlog and the drop counts', () => {
  const v = boot();
  v.send(3); v.api.flushBatch();
  v.drop('ios', 4);
  v.api.togglePause();
  v.send(10, 3);
  v.go('toFile');
  v.api.handleFile({ text: fileText(4) });
  assert.equal(v.run('pendingBatch.length'), 0);
  assert.equal(v.get('liveDropped').ios, 0);
  assert.equal(v.get('fileAll').length, 4);
});

test('a live flush while the File tab is shown leaves the file buffer alone (known bug, fixed in P2 Task 8)', { todo: 'P2 Task 8' }, () => {
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
