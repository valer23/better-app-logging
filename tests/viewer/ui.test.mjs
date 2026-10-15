// The pure side of the UI primitives (viewer/assets/js/ui.js, ALV.uiPure): placement (parity with
// the legacy positionExportMenu), the menu roving index and typeahead, the toast queue (timeouts,
// pause/resume, max 3 + FIFO, replace by key), the live-region throttle and the focus-trap step.
// ui.js loads in an EMPTY vm context, so its DOM side must not run at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';

const ALV = loadPureModule('ui.js');
const U = ALV.uiPure;
const ids = a => [...a];   // vm-realm arrays → this realm, for deepEqual

test('ui.js loads in an empty context and only exposes the pure helpers there', () => {
  assert.equal(typeof U.place, 'function');
  assert.equal(ALV.ui, undefined);
});

// The arithmetic of the legacy positionExportMenu() (viewer/applogs-viewer.html before P3), verbatim.
function legacyPosition(rect, mw, mh, vw, vh) {
  const PAD = 8;
  let left = rect.right - mw;
  let top = rect.bottom + 6;
  left = Math.max(PAD, Math.min(left, vw - mw - PAD));
  if (top + mh + PAD > vh) top = Math.max(PAD, rect.top - mh - 6);
  return { left, top };
}
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('place with its defaults reproduces positionExportMenu on every case', () => {
  const cases = [
    [rect(1200, 60, 80, 28), 240, 260, 1400, 900],   // normal: under the button, right-aligned
    [rect(10, 60, 80, 28), 240, 260, 1400, 900],     // button at the far left (wrapped toolbar): clamped to 8
    [rect(1320, 60, 80, 28), 240, 260, 1400, 900],   // right edge: clamped to vw - w - 8
    [rect(1200, 800, 80, 28), 240, 260, 1400, 900],  // no room below: flips above
    [rect(1200, 100, 80, 28), 240, 900, 1400, 900],  // taller than the viewport: flip clamps to 8
    [rect(40, 60, 80, 28), 240, 260, 250, 900],      // viewport narrower than menu + pads
    [rect(1200, 606, 80, 28), 240, 260, 1400, 900],  // 640 + 260 + 8 = 908 > 900: flips
    [rect(1200, 598, 80, 28), 240, 260, 1400, 900],  // 632 + 260 + 8 = 900: stays below
  ];
  for (const [r, w, h, vw, vh] of cases) {
    const got = U.place(r, { w, h }, { vw, vh });
    assert.deepEqual({ left: got.left, top: got.top }, legacyPosition(r, w, h, vw, vh), JSON.stringify([r, w, h, vw, vh]));
  }
  assert.equal(U.place(rect(1200, 800, 80, 28), { w: 240, h: 260 }, { vw: 1400, vh: 900 }).side, 'top');
});

test('place: start/center alignment, top side flipping below, custom gap and pad', () => {
  const r = rect(100, 300, 40, 20);
  assert.deepEqual({ ...U.place(r, { w: 60, h: 24 }, { vw: 800, vh: 600 }, { align: 'center' }) }, { left: 90, top: 326, side: 'bottom' });
  assert.equal(U.place(r, { w: 60, h: 24 }, { vw: 800, vh: 600 }, { align: 'start' }).left, 100);
  assert.deepEqual({ ...U.place(r, { w: 60, h: 24 }, { vw: 800, vh: 600 }, { side: 'top', gap: 4 }) }, { left: 80, top: 272, side: 'top' });
  assert.deepEqual({ ...U.place(rect(100, 10, 40, 20), { w: 60, h: 24 }, { vw: 800, vh: 600 }, { side: 'top' }) }, { left: 80, top: 36, side: 'bottom' });
  assert.equal(U.place(rect(0, 10, 40, 20), { w: 60, h: 24 }, { vw: 800, vh: 600 }, { pad: 16 }).left, 16);
});

test('moveIndex: arrows wrap, Home/End and PageUp/PageDown jump, nothing active starts at an end', () => {
  assert.equal(U.moveIndex(5, 0, 'ArrowDown'), 1);
  assert.equal(U.moveIndex(5, 4, 'ArrowDown'), 0);
  assert.equal(U.moveIndex(5, 0, 'ArrowUp'), 4);
  assert.equal(U.moveIndex(5, -1, 'ArrowDown'), 0);
  assert.equal(U.moveIndex(5, -1, 'ArrowUp'), 4);
  assert.equal(U.moveIndex(5, 3, 'Home'), 0);
  assert.equal(U.moveIndex(5, 1, 'End'), 4);
  assert.equal(U.moveIndex(5, 3, 'PageUp'), 0);
  assert.equal(U.moveIndex(5, 1, 'PageDown'), 4);
  assert.equal(U.moveIndex(5, 2, 'x'), 2);
  assert.equal(U.moveIndex(0, -1, 'ArrowDown'), -1);
});

test('typeahead: prefix within 500 ms, a new search after, one repeated letter cycles, no match is -1', () => {
  const labels = ['Plain Text Terminal-style, easy to share', 'CSV Open in Excel / Numbers', 'JSON Re-import into this viewer',
    'Filtered view (3 lines)', 'All logs (3 lines)'];
  const find = U.createTypeahead(500);
  assert.equal(find(labels, 0, 'c', 1000), 1);
  assert.equal(find(labels, 1, 'j', 1600), 2, 'after 500 ms a key starts a new search');
  assert.equal(find(labels, 2, 'a', 2200), 4);
  assert.equal(find(labels, 4, 'p', 2800), 0);
  assert.equal(find(labels, 0, 'z', 3400), -1);
  const fruit = ['Apple', 'Avocado', 'Banana', 'apricot'];
  const f2 = U.createTypeahead(500);
  assert.equal(f2(fruit, -1, 'a', 0), 0);
  assert.equal(f2(fruit, 0, 'a', 100), 1, 'the same letter again moves to the next match');
  assert.equal(f2(fruit, 1, 'a', 200), 3, 'case-insensitive');
  assert.equal(f2(fruit, 3, 'a', 300), 0, 'and wraps');
  const f3 = U.createTypeahead(500);
  assert.equal(f3(fruit, 0, 'a', 0), 1);
  assert.equal(f3(fruit, 1, 'v', 100), 1, '"av" stays on Avocado');
  assert.equal(f3(fruit, 1, 'x', 200), -1);
});

test('toast timeouts: 5 s, 10 s with an action, errors never expire', () => {
  assert.equal(U.toastTimeout({ kind: 'success', title: 'Copied 10 lines' }), 5000);
  assert.equal(U.toastTimeout({ kind: 'info', title: 'View cleared', action: { label: 'Undo', run() {} } }), 10000);
  assert.equal(U.toastTimeout({ kind: 'error', title: 'Export failed', action: { label: 'Retry', run() {} } }), Infinity);
  const q = U.createToastQueue();
  const a = q.add({ kind: 'success', title: 'a' }, 0);
  const b = q.add({ kind: 'info', title: 'b', action: { label: 'Undo', run() {} } }, 0);
  const e = q.add({ kind: 'error', title: 'e' }, 0);
  assert.deepEqual(ids(q.due(4999)), []);
  assert.deepEqual(ids(q.due(5000)), [a]);
  q.dismiss(a, 5000);
  assert.equal(q.nextDeadline(5000), 5000);
  assert.deepEqual(ids(q.due(10000)), [b]);
  q.dismiss(b, 10000);
  assert.deepEqual(ids(q.due(1e9)), []);
  assert.deepEqual(ids(q.visible()), [e]);
  assert.equal(q.nextDeadline(1e9), Infinity);
});

test('toast queue: at most 3 visible, the rest wait FIFO and their timers start when shown', () => {
  const q = U.createToastQueue({ max: 3 });
  const t = ['1', '2', '3', '4', '5'].map((title, i) => q.add({ kind: 'success', title }, i * 1000));
  assert.deepEqual(ids(q.visible()), t.slice(0, 3));
  assert.deepEqual(ids(q.pending()), t.slice(3));
  assert.equal(q.dismiss(t[1], 6000), true);
  assert.deepEqual(ids(q.visible()), [t[0], t[2], t[3]]);
  assert.equal(ids(q.due(10999)).includes(t[3]), false, 'toast 4 became visible at 6 s, so it is due at 11 s');
  assert.equal(ids(q.due(11000)).includes(t[3]), true);
  assert.equal(q.dismiss(999, 0), false, 'dismissing an unknown id is a no-op');
  assert.equal(q.dismiss(t[4], 6000), true, 'a pending toast can be dismissed');
  assert.deepEqual(ids(q.pending()), []);
});

test('toast queue: hover/focus pause keeps the remaining time; resume restarts the clock', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 10 lines' }, 0);
  q.pause(id, 3000);
  assert.deepEqual(ids(q.due(60000)), [], 'paused toasts never expire');
  assert.equal(q.nextDeadline(60000), Infinity);
  q.pause(id, 50000);   // a second pause changes nothing
  q.resume(id, 60000);
  assert.deepEqual(ids(q.due(61999)), []);
  assert.deepEqual(ids(q.due(62000)), [id], '2 s were left when it was paused');
});

test('toast queue: a key replaces the toast and restarts its timer; get returns the current spec', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 1 line', key: 'copy' }, 0);
  const again = q.add({ kind: 'success', title: 'Copied 2 lines', key: 'copy' }, 4000);
  assert.equal(again, id);
  assert.equal(q.get(id).title, 'Copied 2 lines');
  assert.deepEqual(ids(q.visible()), [id]);
  assert.deepEqual(ids(q.due(8999)), []);
  assert.deepEqual(ids(q.due(9000)), [id]);
  assert.equal(q.get(12345), null);
});

test('toast queue: replacing a paused keyed toast keeps it paused with the full new time', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 1 line', key: 'copy' }, 0);
  q.pause(id, 1000);
  assert.equal(q.add({ kind: 'success', title: 'Copied 2 lines', key: 'copy' }, 2000), id);
  assert.equal(q.get(id).title, 'Copied 2 lines');
  assert.deepEqual(ids(q.due(1e9)), [], 'still paused: the pointer or focus is still on it');
  assert.equal(q.nextDeadline(1e9), Infinity);
  q.resume(id, 10000);
  assert.deepEqual(ids(q.due(14999)), []);
  assert.deepEqual(ids(q.due(15000)), [id], 'a full 5 s from the resume');
});

test('toast queue: when every visible slot is a sticky error, a new toast evicts the oldest visible one', () => {
  const q = U.createToastQueue({ max: 3 });
  const e = [1, 2, 3].map(n => q.add({ kind: 'error', title: 'Export failed ' + n }, 0));
  assert.deepEqual(ids(q.visible()), e);
  const e4 = q.add({ kind: 'error', title: 'Export failed 4' }, 100);
  assert.deepEqual(ids(q.visible()), [e[1], e[2], e4], 'the newest error is shown, the oldest is evicted');
  assert.deepEqual(ids(q.pending()), [], 'nothing waits behind sticky toasts');
  assert.equal(q.get(e[0]), null);
  const ok = q.add({ kind: 'success', title: 'Copied' }, 200);
  assert.deepEqual(ids(q.visible()), [e[2], e4, ok]);
  assert.deepEqual(ids(q.due(5200)), [ok], 'the evicting toast still times out normally');
  // a non-sticky visible toast means nothing is evicted: the newcomer waits its turn
  const q2 = U.createToastQueue({ max: 3 });
  const a = q2.add({ kind: 'error', title: 'a' }, 0);
  const b = q2.add({ kind: 'error', title: 'b' }, 0);
  const s = q2.add({ kind: 'success', title: 's' }, 0);
  const late = q2.add({ kind: 'success', title: 'late' }, 100);
  assert.deepEqual(ids(q2.visible()), [a, b, s]);
  assert.deepEqual(ids(q2.pending()), [late]);
});

test('announcement throttle: one per 5 s, the newest waiting text is spoken when the window ends', () => {
  const th = U.createThrottle(5000);
  assert.equal(th.push('12 lines match', 0), '12 lines match');
  assert.equal(th.push('11 lines match', 1000), null);
  assert.equal(th.push('10 lines match', 2000), null);
  assert.equal(th.wait(2000), 3000);
  assert.equal(th.flush(4999), null);
  assert.equal(th.flush(5000), '10 lines match', 'older waiting texts are dropped');
  assert.equal(th.flush(5000), null);
  assert.equal(th.wait(5000), Infinity);
  assert.equal(th.push('9 lines match', 9000), null, '5 s after the last spoken one');
  assert.equal(th.flush(10000), '9 lines match');
  assert.equal(th.push('8 lines match', 15000), '8 lines match');
});

test('focus trap: Tab wraps last → first, Shift+Tab wraps first → last, the middle is left to the browser', () => {
  assert.equal(U.trapTarget(3, 2, false), 0);
  assert.equal(U.trapTarget(3, 0, true), 2);
  assert.equal(U.trapTarget(3, 1, false), -1);
  assert.equal(U.trapTarget(3, 1, true), -1);
  assert.equal(U.trapTarget(3, -1, false), 0, 'focus on the panel itself: Tab goes to the first control');
  assert.equal(U.trapTarget(3, -1, true), 2);
  assert.equal(U.trapTarget(0, -1, false), -2, 'nothing focusable: keep focus on the panel');
});
