// The pure side of the UI primitives (viewer/assets/js/ui.js, ALV.uiPure): placement (parity with
// the legacy positionExportMenu), the menu roving index and typeahead, the toast queue (timeouts,
// pause/resume, max 3 + FIFO, replace by key, errors yield after 5 s only when a toast waits and no
// unheld timed toast is on screen, a clock that steps backwards, and a seeded model test of the queue
// invariants), the live-region throttle and the focus-trap step.
// ui.js loads in an EMPTY vm context, so its DOM side must not run at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';
import { fakePage, texts } from './_fake.mjs';

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

test('toast timeouts: 5 s, 10 s with an action, errors stay while nothing waits', () => {
  assert.equal(U.toastTimeout({ kind: 'success', title: 'Copied 10 lines' }), 5000);
  assert.equal(U.toastTimeout({ kind: 'info', title: 'View cleared', action: { label: 'Undo', run() {} } }), 10000);
  assert.equal(U.toastTimeout({ kind: 'error', title: 'Export failed', action: { label: 'Retry', run() {} } }), Infinity);
  const q = U.createToastQueue();
  const a = q.add({ kind: 'success', title: 'a' }, 0);
  const b = q.add({ kind: 'info', title: 'b', action: { label: 'Undo', run() {} } }, 0);
  const e = q.add({ kind: 'error', title: 'e' }, 0);
  assert.equal(q.nextDeadline(0), 5000);
  assert.deepEqual(ids(q.tick(4999)), []);
  assert.deepEqual(ids(q.tick(5000)), [a], 'tick returns the ids that left');
  assert.deepEqual(ids(q.visible()), [b, e]);
  assert.equal(q.nextDeadline(5000), 5000);
  assert.deepEqual(ids(q.tick(10000)), [b]);
  assert.deepEqual(ids(q.tick(1e9)), []);
  assert.deepEqual(ids(q.visible()), [e]);
  assert.equal(q.nextDeadline(1e9), Infinity, 'an error with nothing waiting has no deadline');
  assert.throws(() => U.createToastQueue({ max: 0 }), /max/, 'a queue with no slot would never show anything');
});

test('toast queue: at most 3 visible, the rest wait FIFO and their timers start when shown', () => {
  const q = U.createToastQueue({ max: 3 });
  const t = ['1', '2', '3', '4', '5'].map((title, i) => q.add({ kind: 'success', title }, i * 1000));
  assert.deepEqual(ids(q.visible()), t.slice(0, 3));
  assert.deepEqual(ids(q.pending()), t.slice(3));
  assert.equal(q.dismiss(t[1], 4500), true);
  assert.deepEqual(ids(q.visible()), [t[0], t[2], t[3]]);
  assert.deepEqual(ids(q.tick(5000)), [t[0]]);
  assert.deepEqual(ids(q.visible()), [t[2], t[3], t[4]], 'the expired slot goes to the next waiting toast');
  assert.deepEqual(ids(q.tick(9499)), [t[2]]);
  assert.deepEqual(ids(q.tick(9500)), [t[3]], 'toast 4 was shown at 4.5 s, so it expires at 9.5 s');
  assert.equal(q.dismiss(999, 9500), false, 'dismissing an unknown id is a no-op');
  const q1 = U.createToastQueue({ max: 1 });
  const x = q1.add({ kind: 'success', title: 'x' }, 0);
  const y = q1.add({ kind: 'success', title: 'y' }, 0);
  assert.equal(q1.dismiss(y, 100), true, 'a waiting toast can be dismissed');
  assert.deepEqual([ids(q1.visible()), ids(q1.pending())], [[x], []]);
});

test('toast queue: hover/focus pause keeps the remaining time; resume restarts the clock', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 10 lines' }, 0);
  q.pause(id, 3000);
  assert.deepEqual(ids(q.tick(60000)), [], 'held toasts never expire');
  assert.equal(q.nextDeadline(60000), Infinity);
  q.pause(id, 60000);   // a second pause changes nothing
  q.resume(id, 60000);
  assert.deepEqual(ids(q.tick(61999)), []);
  assert.deepEqual(ids(q.tick(62000)), [id], '2 s were left when it was paused');
});

test('toast queue: a key replaces the toast in place and restarts its timer; get returns the current spec', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 1 line', key: 'copy' }, 0);
  const again = q.add({ kind: 'success', title: 'Copied 2 lines', key: 'copy' }, 4000);
  assert.equal(again, id);
  assert.equal(q.get(id).title, 'Copied 2 lines');
  assert.deepEqual(ids(q.visible()), [id]);
  assert.deepEqual(ids(q.tick(8999)), []);
  assert.deepEqual(ids(q.tick(9000)), [id]);
  assert.equal(q.get(12345), null);
  // a waiting keyed toast keeps its id and its place in line, and its clock starts when it is shown
  const q1 = U.createToastQueue({ max: 1 });
  q1.add({ kind: 'success', title: 'v' }, 0);
  const k = q1.add({ kind: 'info', title: 'k1', key: 'k' }, 0);
  const b = q1.add({ kind: 'info', title: 'b' }, 0);
  assert.equal(q1.add({ kind: 'info', title: 'k2', key: 'k' }, 100), k);
  assert.deepEqual(ids(q1.pending()), [k, b]);
  assert.equal(q1.get(k).title, 'k2');
  q1.tick(5000);
  assert.deepEqual(ids(q1.visible()), [k]);
  assert.equal(q1.nextDeadline(5000), 5000);
});

test('toast queue: replacing a held keyed toast keeps it held with the full new time (review round 1)', () => {
  const q = U.createToastQueue();
  const id = q.add({ kind: 'success', title: 'Copied 1 line', key: 'copy' }, 0);
  q.pause(id, 1000);
  assert.equal(q.add({ kind: 'success', title: 'Copied 2 lines', key: 'copy' }, 2000), id);
  assert.equal(q.get(id).title, 'Copied 2 lines');
  assert.deepEqual(ids(q.tick(9000)), [], 'still held: the pointer or focus is still on it');
  assert.equal(q.nextDeadline(9000), Infinity);
  q.resume(id, 10000);
  assert.deepEqual(ids(q.tick(14999)), []);
  assert.deepEqual(ids(q.tick(15000)), [id], 'a full 5 s from the resume');
});

test('toast queue: while a toast waits, the oldest error on screen for 5 s yields its slot (review round 1)', () => {
  const q = U.createToastQueue({ max: 3 });
  const e = [1, 2, 3].map(n => q.add({ kind: 'error', title: 'Export failed ' + n }, 0));
  assert.equal(q.nextDeadline(0), Infinity, 'errors stay while nothing waits');
  const e4 = q.add({ kind: 'error', title: 'Export failed 4' }, 100);
  assert.deepEqual(ids(q.visible()), e, 'an error stays on screen for at least 5 s');
  assert.deepEqual(ids(q.pending()), [e4]);
  assert.equal(q.nextDeadline(100), 4900, 'the oldest error yields 5 s after it was shown');
  assert.deepEqual(ids(q.tick(5000)), [e[0]], 'one error yields: one toast waits');
  assert.deepEqual(ids(q.visible()), [e[1], e[2], e4]);
  assert.equal(q.get(e[0]), null);
  const ok = q.add({ kind: 'success', title: 'Copied' }, 6000);
  assert.deepEqual(ids(q.visible()), [e[2], e4, ok], 'an error already shown for 5 s yields at once');
  assert.deepEqual(ids(q.tick(11000)), [ok], 'the newcomer still times out normally');
  assert.deepEqual(ids(q.visible()), [e[2], e4], 'and the remaining errors stay');
});

test('toast queue: an error keeps its slot while an unheld timed toast will free one anyway (review round 5)', () => {
  const q = U.createToastQueue({ max: 3 });
  const e1 = q.add({ kind: 'error', title: 'Export failed', action: { label: 'Retry', run() {} } }, 0);
  const [s1, s2, s3] = [10000, 10001, 10002].map((t, i) => q.add({ kind: 'success', title: 's' + (i + 1) }, t));
  assert.deepEqual([ids(q.visible()), ids(q.pending())], [[e1, s1, s2], [s3]], 'e1 has been on screen for 10 s, but s1 and s2 are timed');
  assert.equal(q.get(e1).title, 'Export failed');
  assert.equal(q.nextDeadline(10002), 4998, 'the next change is s1 expiring, not e1 yielding');
  assert.deepEqual(ids(q.tick(15000)), [s1]);
  assert.deepEqual([ids(q.visible()), ids(q.pending())], [[e1, s2, s3], []], 'the expired slot goes to s3; the error is still there');
  // the yield is for when no unheld timed toast can free a slot: hold the only timed toast and it applies
  const q1 = U.createToastQueue({ max: 2 });
  const h = q1.add({ kind: 'error', title: 'h' }, 0);
  const t = q1.add({ kind: 'success', title: 't' }, 0);
  q1.pause(t, 1000);
  const w = q1.add({ kind: 'success', title: 'w' }, 6000);
  assert.deepEqual([ids(q1.visible()), ids(q1.pending())], [[t, w], []], 'nothing timed is running, so h yields');
  assert.equal(q1.get(h), null);
  // an unheld error yields as soon as the last unheld timed toast is held
  const q2 = U.createToastQueue({ max: 2 });
  const e = q2.add({ kind: 'error', title: 'e' }, 0);
  const u = q2.add({ kind: 'info', title: 'u' }, 1000);
  const v = q2.add({ kind: 'info', title: 'v' }, 1000);
  assert.deepEqual(ids(q2.visible()), [e, u]);
  q2.pause(u, 7000);
  assert.deepEqual([ids(q2.visible()), ids(q2.pending())], [[u, v], []], 'u is held now, so the waiting toast takes the error\'s slot');
});

test('toast queue: a clock that steps backwards never makes toasts outlive their time (review round 5)', () => {
  const q = U.createToastQueue({ max: 3 });
  const id = q.add({ kind: 'success', title: 'Copied' }, 1e6);
  const back = 1e6 - 3.6e6;
  assert.equal(q.nextDeadline(back), 5000, 'the deadline is measured from the latest time the queue has seen');
  assert.deepEqual(ids(q.tick(back + 4000)), [], 'still earlier than the add');
  assert.deepEqual(ids(q.visible()), [id]);
  assert.deepEqual(ids(q.tick(1e6 + 4999)), []);
  assert.deepEqual(ids(q.tick(1e6 + 5000)), [id], 'expires on time relative to the latest time seen');
  const k = q.add({ kind: 'success', title: 'k' }, 2e6);
  q.pause(k, back);
  q.resume(k, back + 1);
  assert.equal(q.nextDeadline(back + 2), 5000, 'pause and resume with a stale now behave as at the latest time');
});

test('toast queue: a held error never yields; a queue held everywhere waits for the release', () => {
  const q = U.createToastQueue({ max: 3 });
  const [a, b, c] = ['a', 'b', 'c'].map(title => q.add({ kind: 'error', title, action: { label: 'Retry', run() {} } }, 0));
  q.pause(a, 1000);   // focus on its Retry button
  const late = q.add({ kind: 'success', title: 'late' }, 6000);
  assert.deepEqual(ids(q.visible()), [a, c, late], 'b yields; the held a keeps its slot and its focus');
  assert.equal(q.get(b), null);
  // only reachable with max < 3 or a hold the DOM never released: nothing is pushed out, nothing is lost
  const q1 = U.createToastQueue({ max: 1 });
  const h = q1.add({ kind: 'error', title: 'h' }, 0);
  q1.pause(h, 0);
  const w = q1.add({ kind: 'success', title: 'w' }, 10000);
  assert.deepEqual(ids(q1.pending()), [w]);
  assert.equal(q1.nextDeadline(10000), Infinity, 'no clock runs until the hold ends');
  q1.resume(h, 20000);
  assert.equal(q1.nextDeadline(20000), 5000, 'after the hold the error gets 5 s, then yields');
  assert.deepEqual(ids(q1.tick(25000)), [h]);
  assert.deepEqual(ids(q1.visible()), [w]);
});

test('toast queue: a timeout or a dismissal never leaves a toast stuck behind a row of errors (review rounds 2 and 3)', () => {
  const build = () => {
    const q = U.createToastQueue({ max: 3 });
    const e1 = q.add({ kind: 'error', title: 'e1' }, 0);
    const e2 = q.add({ kind: 'error', title: 'e2' }, 0);
    const s = q.add({ kind: 'success', title: 's' }, 0);
    const e3 = q.add({ kind: 'error', title: 'e3' }, 1);
    const s2 = q.add({ kind: 'success', title: 's2' }, 2);
    assert.deepEqual([ids(q.visible()), ids(q.pending())], [[e1, e2, s], [e3, s2]]);
    return { q, e1, e2, s, e3, s2 };
  };
  // round 2: s times out at 5 s; e3 takes its slot, then e1 (on screen for 5 s) yields to s2
  const r2 = build();
  assert.deepEqual(ids(r2.q.tick(5000)), [r2.s, r2.e1]);
  assert.deepEqual([ids(r2.q.visible()), ids(r2.q.pending())], [[r2.e2, r2.e3, r2.s2], []]);
  assert.equal(r2.q.nextDeadline(5000), 5000, 's2 has a running timer');
  // round 3: s is dismissed early; e3 fills the last slot and s2 waits on a deadline, not forever
  const r3 = build();
  assert.equal(r3.q.dismiss(r3.s, 100), true);
  assert.deepEqual([ids(r3.q.visible()), ids(r3.q.pending())], [[r3.e1, r3.e2, r3.e3], [r3.s2]]);
  assert.equal(r3.q.nextDeadline(100), 4900, 'e1 yields 5 s after it was shown');
  r3.q.tick(5000);
  assert.deepEqual([ids(r3.q.visible()), ids(r3.q.pending())], [[r3.e2, r3.e3, r3.s2], []]);
});

test('toast queue: a keyed replace that turns the last timed toast into an error settles too (review round 4)', () => {
  const q = U.createToastQueue({ max: 3 });
  const e1 = q.add({ kind: 'error', title: 'e1' }, 0);
  const e2 = q.add({ kind: 'error', title: 'e2' }, 0);
  const s = q.add({ kind: 'info', title: 'Exporting…', key: 'k' }, 0);
  const p = q.add({ kind: 'success', title: 'p' }, 0);
  assert.equal(q.add({ kind: 'error', title: 'Export failed', key: 'k' }, 10), s);
  assert.deepEqual([ids(q.visible()), ids(q.pending())], [[e1, e2, s], [p]]);
  assert.equal(q.nextDeadline(10), 4990, 'the row is all errors now: e1 yields at 5 s');
  q.tick(5000);
  assert.deepEqual([ids(q.visible()), ids(q.pending())], [[e2, s, p], []]);
});

test('toast queue: a burst of errors is shown in arrival order, none dropped unseen', () => {
  const q = U.createToastQueue({ max: 3 });
  const s = q.add({ kind: 'success', title: 's' }, 0);
  const errs = [1, 2, 3, 4, 5, 6].map(n => q.add({ kind: 'error', title: 'e' + n }, n));
  const p = q.add({ kind: 'success', title: 'p' }, 7);
  let now = 7;
  const firstSeen = [...ids(q.visible())];
  for (let i = 0; i < 50 && q.pending().length; i++) {
    now += q.nextDeadline(now);
    q.tick(now);
    for (const id of ids(q.visible())) if (!firstSeen.includes(id)) firstSeen.push(id);
  }
  assert.deepEqual(ids(q.pending()), []);
  assert.deepEqual(firstSeen, [s, ...errs, p], 'every toast was on screen when a call returned, in arrival order');
});

// ---- Toast queue model test: random operations, every invariant checked after every step ----

// mulberry32: a tiny seeded PRNG, so a failure names a seed that replays exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Drives one queue with `steps` random operations, then releases every hold and runs the clock out.
// The test keeps only what the queue cannot report itself: which toasts are held (from the pause and
// resume calls), when each toast was first on screen, and which ids are gone. The rest is public API.
function runToastModel(seed, steps) {
  const rnd = mulberry32(seed);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const max = 1 + (seed % 4);
  const q = U.createToastQueue({ max });
  let now = 0;
  const created = [];
  const held = new Set();
  const shownAt = new Map();
  const gone = new Set();
  const dismissedWaiting = new Set();
  const trace = [];
  let seen = -1;   // the latest time the queue has been given
  const fail = msg => assert.fail(`seed ${seed} (max ${max}) t=${now}: ${msg}\n  last ops: ${trace.slice(-12).join(' | ')}`);
  const snap = () => {
    const vis = ids(q.visible());
    const pen = ids(q.pending());
    return { vis, pen, spec: new Map([...vis, ...pen].map(id => [id, q.get(id)])) };
  };
  const isError = (s, id) => s.spec.get(id).kind === 'error';

  function check(b, a, op, ret) {
    const all = [...a.vis, ...a.pen];
    const before = [...b.vis, ...b.pen];
    if (a.vis.length > max) fail(`I1: ${a.vis.length} visible`);
    if (a.pen.length && a.vis.length !== max) fail(`I2: ${a.pen.length} waiting beside a free slot`);
    if (new Set(all).size !== all.length) fail(`I3: duplicate id in [${all}]`);
    const keys = all.map(id => a.spec.get(id).key).filter(k => k != null);
    if (new Set(keys).size !== keys.length) fail(`I3: duplicate key in [${keys}]`);
    for (const id of all) if (gone.has(id)) fail(`I3: id ${id} came back after it left`);
    const fresh = all.filter(id => !b.spec.has(id));
    const kept = before.filter(id => a.spec.has(id));
    if (String(all) !== String(kept.concat(fresh))) fail(`I4: order [${before}] became [${all}]`);
    for (const id of a.pen) if (b.vis.includes(id)) fail(`I4: ${id} went back to pending`);
    if (op.type === 'add') {
      const owner = op.spec.key == null ? undefined : [...b.spec].find(([, s]) => s.key === op.spec.key);
      if (owner ? ret !== owner[0] || fresh.length : fresh.length !== 1 || ret !== fresh[0]) fail(`add returned ${ret}, new ids [${fresh}]`);
      if (q.get(ret) !== op.spec) fail(`get(${ret}) is not the spec just added`);
      if (fresh.length) created.push(fresh[0]);
    } else if (fresh.length) fail(`${op.type} created [${fresh}]`);
    const target = op.type === 'dismiss' ? op.id : null;
    const promoted = a.vis.filter(id => !b.vis.includes(id));
    let yielded = 0;
    for (const id of before) {
      if (a.spec.has(id) || id === target) continue;
      if (b.pen.includes(id)) fail(`I8: waiting toast ${id} left without being shown`);
      if (held.has(id)) fail(`I5: held toast ${id} left`);
      if (now - shownAt.get(id) < 5000) fail(`I8: toast ${id} left after ${now - shownAt.get(id)} ms on screen`);
      if (isError(b, id)) yielded += 1;
    }
    if (yielded > promoted.length) fail(`I9: ${yielded} errors yielded for ${promoted.length} shown toasts`);
    if (yielded && b.vis.some(id => a.spec.has(id) && !held.has(id) && !isError(a, id))) fail('I9: an error yielded while an unheld timed toast stayed on screen');
    for (const id of before) {
      if (a.spec.has(id)) continue;
      gone.add(id);
      held.delete(id);
      if (id === target && b.pen.includes(id)) dismissedWaiting.add(id);
    }
    for (const id of a.vis) if (!shownAt.has(id)) shownAt.set(id, now);
    const nd = q.nextDeadline(now);
    if (!(nd > 0)) fail(`I6: overdue, nextDeadline ${nd}`);
    const unheld = a.vis.filter(id => !held.has(id));
    const running = unheld.some(id => !isError(a, id) || a.pen.length > 0);
    if (running !== Number.isFinite(nd)) fail(`I6/I7: nextDeadline ${nd} but a clock ${running ? 'runs' : 'does not run'}`);
    if (a.pen.length && !Number.isFinite(nd) && unheld.length) fail('I7: toasts wait and no timer will fire');
  }

  function apply(op) {
    trace.push(`${now}:${op.type}${op.id ? ' ' + op.id : ''}${op.spec ? ' ' + op.spec.kind + (op.spec.action ? '+a' : '') + (op.spec.key ? ' ' + op.spec.key : '') : ''}`);
    const b = snap();
    // One call in ten carries a clock that stepped backwards, once the queue has seen `now` (the checks
    // below query it at `now`): it must act as at the latest time seen, so every invariant still holds.
    const at = seen === now && rnd() < 0.1 ? now - 1 - Math.floor(rnd() * 3.6e6) : now;
    let ret;
    if (op.type === 'add') ret = q.add(op.spec, at);
    else if (op.type === 'dismiss') {
      ret = q.dismiss(op.id, at);
      if (ret !== b.spec.has(op.id)) fail(`dismiss(${op.id}) returned ${ret}`);
    } else if (op.type === 'pause') { q.pause(op.id, at); if (b.vis.includes(op.id)) held.add(op.id); }
    else if (op.type === 'resume') { q.resume(op.id, at); held.delete(op.id); }
    else ret = q.tick(at);
    check(b, snap(), op, ret);
    seen = now;   // check() asked for nextDeadline(now)
  }

  const kinds = ['success', 'info', 'error'];
  for (let step = 0; step < steps; step++) {
    const dt = pick([0, 0, 1, 7, 250, 1000, 2500, 4999, 5000, 5001, 9999, 10000, 'deadline', 'deadline']);
    if (dt === 'deadline') { const nd = q.nextDeadline(now); if (Number.isFinite(nd)) now += nd; } else now += dt;
    const live = [...ids(q.visible()), ...ids(q.pending())];
    const someId = () => (live.length && rnd() < 0.85 ? pick(live) : 1 + Math.floor(rnd() * (created.length + 2)));
    const spec = () => {
      const s = { kind: pick(kinds), title: 'toast ' + step };
      if (rnd() < 0.3) s.action = { label: 'Act', run() {} };
      if (rnd() < 0.35) s.key = pick(['k1', 'k2', 'k3']);
      return s;
    };
    const r = rnd();
    if (r < 0.38) apply({ type: 'add', spec: spec() });
    else if (r < 0.50) apply({ type: 'dismiss', id: someId() });
    else if (r < 0.64) apply({ type: 'pause', id: someId() });
    else if (r < 0.78) apply({ type: 'resume', id: held.size && rnd() < 0.7 ? pick([...held]) : someId() });
    else apply({ type: 'tick' });
  }
  // Liveness: once nothing is held, every waiting toast is shown and every timed toast leaves on its own.
  for (const id of [...held]) apply({ type: 'resume', id });
  for (let guard = 0; ; guard++) {
    if (guard > 500) fail('the clock never ran out');
    const nd = q.nextDeadline(now);
    if (!Number.isFinite(nd)) break;
    now += nd;
    apply({ type: 'tick' });
  }
  const end = snap();
  if (end.pen.length) fail(`liveness: [${end.pen}] still waiting with nothing held`);
  if (end.vis.some(id => !isError(end, id))) fail('liveness: a timed toast never expired');
  for (const id of created) if (!shownAt.has(id) && !dismissedWaiting.has(id)) fail(`I8: toast ${id} was never on screen`);
}

test('toast queue: every invariant holds after every step of 300 seeded runs of 60 random operations', () => {
  for (let seed = 1; seed <= 300; seed++) runToastModel(seed, 60);
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

// ---- DOM side, against a small fake document and a manual clock ----
// fakePage() and texts() live in _fake.mjs (shell.test.mjs uses them too).

test('menu wires the trigger (aria-haspopup, -expanded, -controls) and opens, moves and closes through its keys', () => {
  const p = fakePage();
  const trigger = p.dom.el('button', { id: 'btn' });
  const list = p.dom.el('div', { role: 'menu', id: 'm' },
    p.dom.el('button', { role: 'menuitem', tabindex: '-1' }, 'Plain Text'),
    p.dom.el('button', { role: 'menuitemradio', 'aria-checked': 'true', tabindex: '-1' }, 'Filtered'),
    p.dom.el('button', { role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1' }, 'All logs'));
  const surface = p.dom.portal(p.dom.el('div', { hidden: true }, list), 'popover');
  let opened = 0;
  const ctl = p.ui.menu(trigger, surface, { onOpen: () => { opened++; } });
  assert.deepEqual([trigger.attrs['aria-haspopup'], trigger.attrs['aria-expanded'], trigger.attrs['aria-controls']], ['menu', 'false', 'm']);
  ctl.close();
  assert.equal(opened, 0, 'closing a closed menu is a no-op');
  trigger.fire('keydown', { key: 'ArrowDown' });
  assert.equal(ctl.isOpen(), true);
  assert.equal(opened, 1, 'onOpen refreshes the content before it is shown');
  assert.equal(trigger.attrs['aria-expanded'], 'true');
  assert.deepEqual([surface.style.left, surface.style.top], ['460px', '74px'], 'right-aligned 6 px under the trigger');
  assert.equal(p.doc.activeElement, list.children[0]);
  list.fire('keydown', { key: 'ArrowUp' });
  assert.equal(p.doc.activeElement, list.children[2], 'ArrowUp wraps to the last item');
  list.children[2].click();
  assert.deepEqual(list.children.slice(1).map(r => r.attrs['aria-checked']), ['false', 'true']);
  assert.equal(ctl.isOpen(), true, 'a radio item keeps the menu open');
  assert.equal(p.keys.dispatch({ key: 'Escape', preventDefault() {} }, p.doc.activeElement), 'esc');
  assert.equal(ctl.isOpen(), false);
  assert.equal(p.doc.activeElement, trigger, 'Esc returns focus to the trigger');
  assert.equal(p.keys.escDepth(), 0);
  ctl.open({ focus: 'first' });
  list.children[0].click();
  assert.equal(ctl.isOpen(), false, 'a menuitem closes the menu');
  ctl.open({ focus: 'first' });
  p.doc.listeners.pointerdown[0]({ target: p.byId.filterbar });
  assert.equal(ctl.isOpen(), false, 'a press outside closes it');
  ctl.open({ focus: 'first' });
  p.doc.listeners.pointerdown[0]({ target: list.children[1] });
  assert.equal(ctl.isOpen(), true, 'a press inside does not');
  list.fire('keydown', { key: 'Tab' });
  assert.equal(ctl.isOpen(), false);
  assert.equal(p.doc.activeElement, trigger, 'Tab leaves from the trigger');
});

test('menu opened by a shortcut gives focus back to where it was (returnFocus); opened from its button, to the button', () => {
  const p = fakePage();
  const search = p.dom.el('input', { id: 'search' });
  const trigger = p.dom.el('button', { id: 'btn' });
  p.byId.filterbar.appendChild(search);
  p.byId.filterbar.appendChild(trigger);
  const list = p.dom.el('div', { role: 'menu' }, p.dom.el('button', { role: 'menuitem', tabindex: '-1' }, 'Plain Text'));
  const surface = p.dom.portal(p.dom.el('div', { hidden: true }, list), 'popover');
  const ctl = p.ui.menu(trigger, surface);
  p.focus(search);
  ctl.open({ focus: 'first', returnFocus: p.doc.activeElement });
  assert.equal(p.doc.activeElement, list.children[0]);
  assert.equal(p.keys.dispatch({ key: 'Escape', preventDefault() {} }, p.doc.activeElement), 'esc');
  assert.equal(p.doc.activeElement, search, 'Esc returns to the search field');
  ctl.open({ focus: 'first', returnFocus: search });
  list.children[0].click();
  assert.equal(p.doc.activeElement, search, 'choosing an item returns there too');
  ctl.open({ focus: 'first' });
  p.keys.dispatch({ key: 'Escape', preventDefault() {} }, p.doc.activeElement);
  assert.equal(p.doc.activeElement, trigger, 'without returnFocus, focus goes back to the button');
});

test('popover: role=dialog wiring, initial focus, Tab/Shift+Tab leave via the trigger, Esc and outside press close', () => {
  const p = fakePage();
  const trigger = p.dom.el('button');
  p.byId.filterbar.appendChild(trigger);
  const a = p.dom.el('button', null, 'Android');
  const b = p.dom.el('button', null, 'iOS');
  const panel = p.dom.portal(p.dom.el('div', { hidden: true }, a, b), 'popover');
  panel.querySelectorAll = () => [a, b];   // focusables(panel)
  const ctl = p.ui.popover(trigger, panel);
  assert.deepEqual([trigger.attrs['aria-haspopup'], trigger.attrs['aria-expanded'], trigger.attrs['aria-controls'], panel.attrs.role],
    ['dialog', 'false', panel.id, 'dialog']);
  trigger.click();
  assert.equal(ctl.isOpen(), true);
  assert.equal(p.doc.activeElement, a, 'focus moves to the first control');
  let prevented = false;
  p.focus(b);
  panel.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.deepEqual([prevented, ctl.isOpen(), p.doc.activeElement === trigger], [false, false, true],
    'Tab from the last control: focus on the trigger, not prevented, so the browser moves on from there');
  trigger.click();
  panel.fire('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.deepEqual([prevented, ctl.isOpen(), p.doc.activeElement === trigger], [true, false, true], 'Shift+Tab from the first lands on the trigger');
  trigger.click();
  assert.equal(p.keys.dispatch({ key: 'Escape', preventDefault() {} }, a), 'esc');
  assert.deepEqual([ctl.isOpen(), p.doc.activeElement === trigger], [false, true], 'Esc closes and returns focus to the trigger');
  trigger.click();
  p.doc.listeners.pointerdown[0]({ target: p.byId.filterbar });
  assert.equal(ctl.isOpen(), false, 'a press outside closes it');
});

test('toasts: polite region for success/info, role=alert region for errors, max 3, timers, hover pause, dismiss', () => {
  const p = fakePage();
  const live = p.byId.toastLive;
  const alerts = p.byId.toastAlerts;
  const title = t => texts(t.children[1].children[0]);
  p.ui.toast({ kind: 'success', title: 'Copied 10 lines' });
  const err = p.ui.toast({ kind: 'error', title: 'Export failed', desc: 'Disk is full. Free some space and try again.' });
  assert.deepEqual(live.children.map(title), ['Copied 10 lines']);
  assert.deepEqual(alerts.children.map(title), ['Export failed']);
  assert.equal(alerts.children[0].attrs.role, 'alert');
  assert.equal(live.children[0].attrs.role, undefined);
  assert.equal(alerts.children[0].className, 'toast toast-error');
  const dismiss = alerts.children[0].children.at(-1);
  assert.equal(dismiss.attrs['aria-label'], 'Dismiss notification');
  assert.equal(dismiss.children[0].children[0].attrs.href, '#i-x');
  p.advance(4999);
  assert.equal(live.children.length, 1);
  p.advance(1);
  assert.equal(live.children.length, 0, 'gone after 5 s');
  p.advance(60000);
  assert.equal(alerts.children.length, 1, 'errors stay');
  err.dismiss();
  assert.equal(alerts.children.length, 0);
  for (const n of ['1', '2', '3', '4']) p.ui.toast({ kind: 'info', title: n });
  assert.deepEqual(live.children.map(title), ['1', '2', '3'], 'at most 3 at once');
  live.children[0].fire('pointerenter');
  p.advance(5000);
  assert.deepEqual(live.children.map(title), ['1', '4'], 'the hovered toast stays; the queued one shows');
  live.children[0].fire('pointerleave');
  p.advance(5000);
  assert.deepEqual(live.children.map(title), [], 'hover kept its remaining time');
  let ran = 0;
  p.ui.toast({ kind: 'info', title: 'View cleared · 3 lines', desc: 'Undo within 10 s', action: { label: 'Undo', run: () => { ran++; } } });
  p.advance(9999);
  assert.equal(live.children.length, 1, '10 s with an action');
  live.children[0].children[2].click();
  assert.equal(ran, 1);
  assert.equal(live.children.length, 0, 'the action dismisses the toast');
});

test('toasts: a keyed replace refills the same node, keeps its hold, and moves it to the alert region as an error', () => {
  const p = fakePage();
  const live = p.byId.toastLive;
  const alerts = p.byId.toastAlerts;
  const t1 = p.ui.toast({ kind: 'info', title: 'Exporting…', key: 'export' });
  const node = live.children[0];
  node.fire('pointerenter');
  p.advance(60000);
  assert.equal(live.children[0], node, 'held: still there');
  const t2 = p.ui.toast({ kind: 'info', title: 'Exporting… 50%', key: 'export' });
  assert.equal(t2.id, t1.id);
  assert.equal(live.children[0], node, 'the same node, refilled');
  assert.equal(texts(node.children[1].children[0]), 'Exporting… 50%');
  p.advance(60000);
  assert.equal(live.children.length, 1, 'still held after the replace');
  const dismissBtn = node.children.at(-1);
  p.focus(dismissBtn);
  node.fire('focusin');
  p.ui.toast({ kind: 'error', title: 'Export failed', desc: 'Disk is full.', key: 'export', action: { label: 'Retry', run() {} } });
  assert.deepEqual([live.children.length, alerts.children[0] === node], [0, true], 'moved to the alert region');
  assert.deepEqual([node.attrs.role, node.className], ['alert', 'toast toast-error']);
  assert.equal(node.children[0].children[0].attrs.href, '#i-circle-alert');
  assert.equal(p.doc.activeElement, dismissBtn, 'focus stays on the same button');
  assert.deepEqual([node.children[2].hidden, texts(node.children[2])], [false, 'Retry']);
  node.fire('pointerleave');
  p.advance(600000);
  assert.equal(alerts.children.length, 1, 'an error with nothing waiting stays');
});

test('toasts: an error that yields its slot leaves the DOM; a focused error keeps its slot', () => {
  const p = fakePage();
  const live = p.byId.toastLive;
  const alerts = p.byId.toastAlerts;
  const title = t => texts(t.children[1].children[0]);
  for (const n of ['e1', 'e2', 'e3']) p.ui.toast({ kind: 'error', title: n });
  alerts.children[0].fire('focusin');
  p.advance(1000);
  p.ui.toast({ kind: 'success', title: 'Copied' });
  assert.deepEqual([alerts.children.map(title), live.children.length], [['e1', 'e2', 'e3'], 0], 'every error stays 5 s');
  p.advance(4000);
  assert.deepEqual(alerts.children.map(title), ['e1', 'e3'], 'e2 yields at 5 s; the focused e1 stays');
  assert.deepEqual(live.children.map(title), ['Copied']);
  p.advance(5000);
  assert.equal(live.children.length, 0);
});

test('announce: the first text at once, then one per 5 s with the newest waiting text', () => {
  const p = fakePage();
  const a = p.byId.announcer;
  p.ui.announce('12 lines match');
  assert.equal(a.textContent, '12 lines match');
  p.advance(1000); p.ui.announce('11 lines match');
  p.advance(1000); p.ui.announce('10 lines match');
  assert.equal(a.textContent, '12 lines match');
  p.advance(3000);
  assert.equal(a.textContent, '10 lines match');
});

test('dialog: inert behind, focus inside, Tab wraps, Mod+Enter clicks the primary, Esc closes and restores focus', () => {
  const p = fakePage();
  const opener = p.dom.el('button');
  p.byId.filterbar.appendChild(opener);
  const a = p.dom.el('button', null, 'Cancel');
  const b = p.dom.el('button', { 'data-primary': true }, 'Copy');
  let clicked = 0;
  b.addEventListener('click', () => { clicked++; });
  const panel = p.dom.el('div', null, a, b);
  panel.querySelectorAll = () => [a, b];   // focusables(panel)
  let closed = null;
  const d = p.ui.dialog(panel, { label: 'Bug report', onClose: r => { closed = r; } });
  assert.deepEqual([panel.attrs.role, panel.attrs['aria-modal'], panel.attrs['aria-label']], ['dialog', undefined, 'Bug report']);
  assert.equal(d.isOpen(), false);
  p.focus(opener);
  d.open();
  assert.equal(p.byId.filterbar.inert, true, 'the page behind is inert');
  assert.equal(p.byId.overlayRoot.inert, false);
  assert.equal(p.doc.activeElement, a);
  let prevented = false;
  p.focus(b);
  panel.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(p.doc.activeElement, a, 'Tab from the last control wraps to the first');
  assert.equal(prevented, true);
  panel.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(p.doc.activeElement, b, 'Shift+Tab from the first wraps to the last');
  assert.equal(p.keys.dispatch({ key: 'e', metaKey: true, preventDefault() {} }, a), null);
  assert.equal(p.keys.dispatch({ key: 'Enter', metaKey: true, preventDefault() {} }, a), 'dialog.primary');
  assert.equal(clicked, 1);
  assert.equal(p.keys.dispatch({ key: 'Escape', preventDefault() {} }, a), 'esc');
  assert.equal(d.isOpen(), false);
  assert.equal(closed, 'esc');
  assert.equal(p.byId.filterbar.inert, false);
  assert.equal(p.doc.activeElement, opener, 'focus returns to the opener');
  assert.equal(p.keys.dispatch({ key: 'Enter', metaKey: true, preventDefault() {} }, a), null, 'no dialog, no dialog bindings');
});

test('tooltip: a role=tooltip element referenced by aria-describedby; 400 ms hover delay; Esc hides it', () => {
  const p = fakePage();
  p.keys.register({ id: 'export.menu', keys: 'Mod+E', inText: true, run() {} });
  const btn = p.dom.el('button', { 'aria-describedby': 'other' });
  p.byId.filterbar.appendChild(btn);
  const tipApi = p.ui.tooltip(btn, { text: 'Export', shortcut: 'export.menu' });
  const [, tipId] = btn.attrs['aria-describedby'].split(' ');
  const tip = p.byId[tipId];
  assert.equal(tip.attrs.role, 'tooltip');
  assert.equal(tip.parent, p.byId.ovTips);
  assert.equal(texts(tip), 'Export⌘E');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(399);
  assert.equal(tip.hidden, true);
  p.advance(1);
  assert.equal(tip.hidden, false);
  assert.equal(p.keys.dispatch({ key: 'Escape', preventDefault() {} }, btn), 'esc');
  assert.equal(tip.hidden, true);
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(500);
  assert.equal(tip.hidden, true, 'suppressed until the pointer leaves');
  btn.fire('pointerleave');
  btn.fire('pointerenter', { pointerType: 'touch' });
  p.advance(500);
  assert.equal(tip.hidden, true, 'touch does not show tooltips');
  tipApi.destroy();
  assert.equal(btn.attrs['aria-describedby'], 'other');
  assert.equal(tip.parent, null);
});

// ---- Task 5 review: dialog hosts menus, focus return, and the gaps mutation testing found ----

const esc = p => p.keys.dispatch({ key: 'Escape', preventDefault() {} }, p.doc.activeElement);
function simpleMenu(p, trigger, labels = ['Plain Text'], onSelect) {
  const list = p.dom.el('div', { role: 'menu' }, ...labels.map(t => p.dom.el('button', { role: 'menuitem', tabindex: '-1', text: t })));
  const surface = p.dom.portal(p.dom.el('div', { hidden: true }, list), 'popover');
  return { list, surface, ctl: p.ui.menu(trigger, surface, { onSelect }) };
}

test('dialog: a menu and a tooltip opened from a control inside it work, and close before the dialog', () => {
  const p = fakePage();
  const inner = p.dom.el('button', { text: 'More' });
  const panel = p.dom.el('div', null, inner);
  panel.querySelectorAll = () => [inner];
  const d = p.ui.dialog(panel, { label: 'Sheet' });
  const m = simpleMenu(p, inner, ['One', 'Two']);
  const tip = p.ui.tooltip(inner, { text: 'More' });
  p.focus(inner);
  d.open();
  assert.deepEqual([p.byId.ovPopovers.inert, p.byId.ovTips.inert], [false, false], 'the popover and tip layers stay live');
  m.ctl.open({ focus: 'first' });
  assert.equal(m.ctl.isOpen(), true);
  assert.equal(p.doc.activeElement, m.list.children[0], 'focus reaches the first item');
  assert.equal(p.byId.ovPopovers.inert, false);
  assert.equal(esc(p), 'esc');
  assert.deepEqual([m.ctl.isOpen(), d.isOpen()], [false, true], 'Esc closes the menu before the dialog');
  assert.equal(p.doc.activeElement, inner);
  inner.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.equal(p.byId[inner.attrs['aria-describedby']].hidden, false, 'a tooltip shows inside a dialog');
  assert.equal(esc(p), 'esc');
  assert.deepEqual([p.byId[inner.attrs['aria-describedby']].hidden, d.isOpen()], [true, true], 'Esc hides the tooltip before the dialog');
  assert.equal(esc(p), 'esc');
  assert.equal(d.isOpen(), false);
  tip.destroy();
});

test('dialog opened from a menu item: closing it puts focus back on the menu button', () => {
  const p = fakePage();
  const trigger = p.dom.el('button', { text: 'More' });
  p.byId.filterbar.appendChild(trigger);
  const ok = p.dom.el('button', { text: 'OK' });
  const panel = p.dom.el('div', null, ok);
  panel.querySelectorAll = () => [ok];
  const d = p.ui.dialog(panel, { label: 'Sheet' });
  const m = simpleMenu(p, trigger, ['Report a bug'], () => d.open());
  trigger.click();
  assert.equal(p.doc.activeElement, m.list.children[0]);
  m.list.children[0].click();
  assert.deepEqual([m.ctl.isOpen(), d.isOpen(), p.doc.activeElement], [false, true, ok]);
  // The menu item is hidden by now, as in a browser.
  m.surface.hidden = true;
  assert.equal(esc(p), 'esc');
  assert.equal(d.isOpen(), false);
  assert.equal(p.doc.activeElement, trigger, 'focus is on the menu button, not lost to <body>');
  assert.equal(p.keys.escDepth(), 0);
});

test('dialog: dismissible and dismissOnScrim gate the scrim and Esc; the opener, then returnFocus, get focus back', () => {
  const p = fakePage();
  const ok = p.dom.el('button', { text: 'OK' });
  const fallback = p.dom.el('button', { text: 'Fallback' });
  const opener = p.dom.el('button', { text: 'Open' });
  p.byId.filterbar.appendChild(fallback);
  p.byId.filterbar.appendChild(opener);
  const make = opts => {
    const panel = p.dom.el('div', null, ok);
    panel.querySelectorAll = () => [ok];
    const d = p.ui.dialog(panel, opts);
    return { d, scrim: panel.parent.children[0] };
  };
  let a = make({ dismissOnScrim: false });
  p.focus(opener);
  a.d.open();
  a.scrim.fire('click');
  assert.equal(a.d.isOpen(), true, 'dismissOnScrim:false ignores a scrim click');
  assert.equal(esc(p), 'esc');
  assert.equal(a.d.isOpen(), false, 'but Esc still closes it');
  a = make({ dismissible: false });
  p.focus(opener);
  a.d.open();
  a.scrim.fire('click');
  assert.equal(a.d.isOpen(), true, 'a non-dismissible dialog ignores the scrim');
  esc(p);
  assert.equal(a.d.isOpen(), true, 'and Esc');
  a.d.close();
  a = make({ returnFocus: fallback });
  p.focus(opener);
  a.d.open();
  a.d.close();
  assert.equal(p.doc.activeElement, opener, 'a shown opener wins over returnFocus');
  p.focus(opener);
  a.d.open();
  opener.hidden = true;
  a.d.close();
  assert.equal(p.doc.activeElement, fallback, 'a hidden opener falls back to returnFocus');
  a = make({});
  opener.hidden = false;
  p.focus(opener);
  a.d.open();
  a.scrim.fire('click');
  assert.equal(a.d.isOpen(), false, 'the default scrim click closes');
  assert.equal(p.keys.escDepth(), 0);
});

test('menu: ArrowUp on the trigger opens on the last item; Home/End and typeahead move inside; disabled items do nothing', () => {
  const p = fakePage();
  const trigger = p.dom.el('button');
  p.byId.filterbar.appendChild(trigger);
  const picked = [];
  const m = simpleMenu(p, trigger, ['Alpha', 'Beta', 'Gamma', 'Delta'], it => picked.push(it.textContent));
  m.list.children[1].setAttribute('aria-disabled', 'true');
  trigger.fire('keydown', { key: 'ArrowUp' });
  assert.equal(p.doc.activeElement, m.list.children[3], 'ArrowUp opens on the last item');
  m.list.fire('keydown', { key: 'Home' });
  assert.equal(p.doc.activeElement, m.list.children[0]);
  m.list.fire('keydown', { key: 'End' });
  assert.equal(p.doc.activeElement, m.list.children[3]);
  m.list.fire('keydown', { key: 'g' });
  assert.equal(p.doc.activeElement, m.list.children[2], 'typeahead jumps to Gamma');
  p.advance(600);
  m.list.fire('keydown', { key: 'a' });
  assert.equal(p.doc.activeElement, m.list.children[0], 'a new search after the pause');
  m.list.children[1].click();
  assert.deepEqual([picked, m.ctl.isOpen()], [[], true], 'an aria-disabled item neither selects nor closes');
  m.list.children[2].click();
  assert.deepEqual([picked, m.ctl.isOpen()], [['Gamma'], false]);
});

test('menu: returnFocus is ignored when hidden, inside the surface or <body>; the trigger gets focus instead', () => {
  const p = fakePage();
  const trigger = p.dom.el('button');
  const away = p.dom.el('button');
  p.byId.filterbar.appendChild(trigger);
  p.byId.filterbar.appendChild(away);
  const m = simpleMenu(p, trigger);
  away.hidden = true;
  m.ctl.open({ focus: 'first', returnFocus: away });
  m.ctl.close();
  assert.equal(p.doc.activeElement, trigger, 'a hidden returnFocus goes to the trigger');
  away.hidden = false;
  m.ctl.open({ focus: 'first', returnFocus: m.list.children[0] });
  m.ctl.close();
  assert.equal(p.doc.activeElement, trigger, 'a returnFocus inside the surface goes to the trigger');
  p.focus(away);
  m.ctl.open({ focus: 'first', returnFocus: p.doc.body });
  m.ctl.close();
  assert.equal(p.doc.activeElement, trigger, '<body> is not a place to return to');
});

test('tooltip: hiding or destroying it pops its Esc entry; it stays hidden while the trigger controls an open menu; keyboard focus shows it', () => {
  const p = fakePage();
  const btn = p.dom.el('button');
  p.byId.filterbar.appendChild(btn);
  const t = p.ui.tooltip(btn, { text: 'Export' });
  const tip = p.byId[btn.attrs['aria-describedby']];
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.deepEqual([tip.hidden, p.keys.escDepth()], [false, 1]);
  btn.fire('pointerleave');
  p.advance(100);
  assert.deepEqual([tip.hidden, p.keys.escDepth()], [true, 0], 'hiding pops the Esc entry');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  t.destroy();
  assert.equal(p.keys.escDepth(), 0, 'destroying a shown tooltip pops it too');
  const t2 = p.ui.tooltip(btn, { text: 'Export' });
  const tip2 = p.byId[btn.attrs['aria-describedby'].split(' ').pop()];
  btn.fire('focus');
  assert.equal(tip2.hidden, true, 'a mouse focus (not :focus-visible) does not show it');
  p.setFocusVisible(true);
  btn.fire('focus');
  assert.equal(tip2.hidden, false, 'keyboard focus shows it at once');
  btn.fire('blur');
  assert.deepEqual([tip2.hidden, p.keys.escDepth()], [true, 0]);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'true');
  btn.fire('focus');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(500);
  assert.equal(tip2.hidden, true, 'no tooltip while the trigger has its menu open');
  t2.destroy();
});

test('tooltip: a disclosure button (aria-expanded without aria-haspopup) keeps its tooltip while expanded; `side` may be a function read on each show', () => {
  const p = fakePage();
  const btn = p.dom.el('button', { 'aria-expanded': 'true' });
  p.byId.filterbar.appendChild(btn);
  let side = 'bottom';
  const t = p.ui.tooltip(btn, { text: 'Hide sidebar', side: () => side });
  const tip = p.byId[btn.attrs['aria-describedby']];
  const hover = () => { btn.fire('pointerenter', { pointerType: 'mouse' }); p.advance(400); const at = [tip.hidden, tip.style.left, tip.style.top]; btn.fire('pointerleave'); p.advance(100); return at; };
  const below = hover();
  assert.equal(below[0], false, 'expanded, not a popup trigger: the tooltip shows');
  side = 'right';
  const beside = hover();
  assert.deepEqual([beside[0], beside[1]], [false, '586px'], 'the function is resolved at show time: now to the right of the anchor');
  assert.notEqual(beside[1], below[1]);
  t.destroy();
});


// ---- P3 whole-diff review, round 1 ----

// What Chromium / WebView2 / WebKit do with aria-modal: while an open modal dialog exists, everything
// outside it leaves the accessibility tree, so a live region there is never announced. Inert does the
// same for the page behind, and also drops anything below an inert ancestor.
function hiddenFromAt(p, n) {
  const modals = [];
  const walk = x => { if (x.attrs && x.attrs['aria-modal'] === 'true') modals.push(x); x.children.forEach(walk); };
  walk(p.doc.body);
  if (modals.length && !modals.some(m => m.contains(n))) return true;
  for (let x = n; x; x = x.parent) if (x.inert) return true;
  return false;
}

test('dialog: the toast regions and #announcer stay announceable while a dialog is open (review F1)', () => {
  const p = fakePage();
  for (const id of ['ovDialogs', 'ovPopovers', 'toastAlerts', 'toastLive', 'ovTips', 'announcer']) p.byId.overlayRoot.appendChild(p.byId[id]);
  const ok = p.dom.el('button', { text: 'Copy' });
  const panel = p.dom.el('div', null, ok);
  panel.querySelectorAll = () => [ok];
  const d = p.ui.dialog(panel, { label: 'Bug report' });
  d.open();
  p.ui.toast({ kind: 'success', title: 'Bug report copied' });
  p.ui.toast({ kind: 'error', title: 'Export failed' });
  p.ui.announce('Stalled for 15 s');
  assert.equal(hiddenFromAt(p, p.byId.filterbar), true, 'the page behind the dialog is out of the accessibility tree');
  assert.equal(hiddenFromAt(p, panel), false, 'the dialog itself is reachable');
  for (const [name, n] of [['polite toast', p.byId.toastLive.children[0]], ['alert toast', p.byId.toastAlerts.children[0]], ['announcer', p.byId.announcer]]) {
    assert.equal(hiddenFromAt(p, n), false, `${name} is announced while the dialog is open`);
  }
  d.close();
});

// A fake toast's parts: [icon, body, action button, dismiss button].
const toastParts = node => ({ action: node.children[2], dismiss: node.children[3] });

test('toasts: dismissing the focused toast moves focus to the same control of the next one, else the previous, else back (review F2)', () => {
  const p = fakePage();
  const live = p.byId.toastLive;
  const alerts = p.byId.toastAlerts;
  const outside = p.dom.el('button', { text: 'Export' });
  p.byId.filterbar.appendChild(outside);
  let ran = 0;
  p.ui.toast({ kind: 'info', title: 'one', action: { label: 'Undo', run: () => { ran++; } } });
  p.ui.toast({ kind: 'info', title: 'two', action: { label: 'Undo', run() {} } });
  p.ui.toast({ kind: 'error', title: 'three' });
  const [n1, n2] = live.children;
  const n3 = alerts.children[0];
  const enter = (node, btn, from) => { p.focus(btn); node.fire('focusin', { relatedTarget: from }); };
  // Action button: the next toast's action button.
  enter(n1, toastParts(n1).action, outside);
  toastParts(n1).action.click();
  assert.equal(ran, 1, 'the action still runs');
  assert.deepEqual([live.children.length, p.doc.activeElement], [1, toastParts(n2).action], 'same control, next toast');
  // Dismiss button, last toast in order: the previous one (the error sits in the other region).
  enter(n3, toastParts(n3).dismiss, toastParts(n2).action);
  toastParts(n3).dismiss.click();
  assert.deepEqual([alerts.children.length, p.doc.activeElement], [0, toastParts(n2).dismiss], 'no next toast: the previous, same control (the error has no action: dismiss)');
  assert.notEqual(p.doc.activeElement, p.doc.body);
  // The last toast: focus goes back to where it was before it entered the toasts.
  enter(n2, toastParts(n2).dismiss, outside);
  toastParts(n2).dismiss.click();
  assert.deepEqual([live.children.length, p.doc.activeElement], [0, outside], 'back to the control focused before the toasts');
});

test('toasts: a dismissed focused toast with nowhere to return to leaves focus alone, and an unfocused one never moves it (review F2)', () => {
  const p = fakePage();
  const live = p.byId.toastLive;
  const other = p.dom.el('button', { text: 'Elsewhere' });
  p.byId.filterbar.appendChild(other);
  const a = p.ui.toast({ kind: 'info', title: 'a' });
  p.ui.toast({ kind: 'info', title: 'b' });
  p.focus(other);
  a.dismiss();
  assert.equal(p.doc.activeElement, other, 'dismissing a toast that has no focus does not move focus');
  const n = live.children[0];
  p.focus(toastParts(n).dismiss);
  n.fire('focusin', { relatedTarget: null });
  toastParts(n).dismiss.click();
  assert.equal(live.children.length, 0);
  assert.equal(p.doc.activeElement, toastParts(n).dismiss, 'no known previous element: nothing to move to');
});

test('menu: auto-repeated Enter / Space on an item is ignored, so holding Enter on the trigger picks nothing (review F5)', () => {
  const p = fakePage();
  const trigger = p.dom.el('button');
  p.byId.filterbar.appendChild(trigger);
  const m = simpleMenu(p, trigger, ['Plain Text', 'CSV']);
  trigger.fire('keydown', { key: 'ArrowDown' });
  const hit = (key, extra) => { let prevented = false; m.list.children[0].fire('keydown', { key, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  assert.equal(hit('Enter', { repeat: true }), true, 'a repeated Enter is default-prevented, so no click follows');
  assert.equal(hit(' ', { repeat: true }), true, 'and a repeated Space');
  assert.equal(hit('Enter'), false, 'the first Enter is left alone: it clicks the item');
  assert.equal(hit('ArrowDown', { repeat: true }), true, 'a held arrow key still roves');
  assert.equal(p.doc.activeElement, m.list.children[1]);
});

test('menu: modified arrows on the trigger (Cmd/Ctrl/Alt+Down/Up) do not open it and are not swallowed (review F8)', () => {
  const p = fakePage();
  const trigger = p.dom.el('button');
  p.byId.filterbar.appendChild(trigger);
  const m = simpleMenu(p, trigger);
  for (const mod of ['metaKey', 'ctrlKey', 'altKey']) {
    for (const key of ['ArrowDown', 'ArrowUp']) {
      let prevented = false;
      trigger.fire('keydown', { key, [mod]: true, preventDefault() { prevented = true; } });
      assert.deepEqual([mod, key, m.ctl.isOpen(), prevented], [mod, key, false, false]);
    }
  }
  trigger.fire('keydown', { key: 'ArrowDown', shiftKey: false });
  assert.equal(m.ctl.isOpen(), true, 'a plain arrow still opens it');
});

test('popups: opening one closes the open one and its tooltip; the Esc stack keeps one menu entry (review F17)', () => {
  const p = fakePage();
  const ta = p.dom.el('button', { text: 'A' });
  const tb = p.dom.el('button', { text: 'B' });
  p.byId.filterbar.appendChild(ta);
  p.byId.filterbar.appendChild(tb);
  const a = simpleMenu(p, ta, ['a1']);
  const b = simpleMenu(p, tb, ['b1']);
  const tip = p.ui.tooltip(tb, { text: 'B tip' });
  const tipEl = p.byId[tb.attrs['aria-describedby']];
  a.ctl.open({ focus: 'first' });
  p.setFocusVisible(true);
  tb.fire('focus');
  assert.equal(tipEl.hidden, false, 'precondition: the tooltip of B shows');
  b.ctl.open({ focus: 'first' });
  assert.deepEqual([a.ctl.isOpen(), b.ctl.isOpen(), ta.attrs['aria-expanded'], tb.attrs['aria-expanded']], [false, true, 'false', 'true'], 'only one menu is open');
  assert.equal(tipEl.hidden, true, 'opening a menu hides the tooltip');
  assert.equal(p.keys.escDepth(), 1, 'A gave back its Esc entry');
  p.doc.listeners.pointerdown[0]({ target: p.byId.filterbar });
  assert.deepEqual([b.ctl.isOpen(), p.keys.escDepth()], [false, 0], 'an outside press closes the one that is open');
  tip.destroy();
});

test('dialogs: a stacked dialog makes the lower one inert and keeps page shortcuts off until the last closes (review F17)', () => {
  const p = fakePage();
  const hits = [];
  p.keys.register({ id: 'page.e', keys: 'Mod+E', scope: 'global', run: () => hits.push('e') });
  const cmdE = () => p.keys.dispatch({ key: 'e', metaKey: true, preventDefault() {} }, p.doc.body);
  const mk = label => {
    const ok = p.dom.el('button', { text: label });
    const panel = p.dom.el('div', null, ok);
    panel.querySelectorAll = () => [ok];
    return { d: p.ui.dialog(panel, { label }), host: panel.parent, ok };
  };
  const one = mk('One');
  const two = mk('Two');
  p.byId.filterbar.appendChild(p.dom.el('button', { text: 'Open' }));
  one.d.open();
  assert.equal(cmdE(), null, 'page shortcuts are off behind dialog 1');
  assert.deepEqual([one.host.inert, p.byId.filterbar.inert], [false, true]);
  two.d.open(one.ok);
  assert.equal(one.host.inert, true, 'dialog 1 is inert behind dialog 2');
  assert.equal(two.host.inert, false);
  assert.equal(p.keys.escDepth(), 2);
  two.d.close();
  assert.equal(one.host.inert, false, 'and live again when dialog 2 closes');
  assert.equal(p.doc.activeElement, one.ok, 'focus returns into dialog 1');
  assert.equal(cmdE(), null, 'page shortcuts stay off while dialog 1 is still open');
  assert.equal(p.byId.filterbar.inert, true);
  one.d.close();
  assert.equal(p.byId.filterbar.inert, false);
  assert.equal(cmdE(), 'page.e', 'with no dialog left, the shortcut fires again');
  assert.deepEqual([hits, p.keys.escDepth()], [['e'], 0]);
});

// ---- P4: destroy() for owners that rebuild their triggers (sidebar device rows) ----

test('menu destroy(): closes without moving focus, removes the surface, the trigger listeners and its popup ARIA; idempotent', () => {
  const p = fakePage();
  const trigger = p.dom.el('button', { text: 'More' });
  p.byId.filterbar.appendChild(trigger);
  const m = simpleMenu(p, trigger, ['Start streaming', 'Setup guide']);
  m.ctl.open({ focus: 'first' });
  assert.equal(p.keys.escDepth(), 1);
  p.focus(p.byId.filterbar);
  m.ctl.destroy();
  assert.deepEqual([m.ctl.isOpen(), p.keys.escDepth(), m.surface.parent], [false, 0, null], 'closed, Esc entry popped, surface gone');
  assert.equal(p.doc.activeElement, p.byId.filterbar, 'focus outside the surface stays where it is');
  assert.deepEqual(['aria-haspopup', 'aria-expanded', 'aria-controls'].map(a => trigger.getAttribute(a)), [null, null, null]);
  assert.deepEqual([(trigger.listeners.click || []).length, (trigger.listeners.keydown || []).length], [0, 0], 'no listener left on the trigger');
  trigger.click();
  m.ctl.open({ focus: 'first' });
  assert.equal(m.ctl.isOpen(), false, 'a destroyed menu never opens again');
  assert.doesNotThrow(() => m.ctl.destroy());
});

test('menu destroy() with focus inside the surface puts focus on the trigger; a new menu can take the same trigger', () => {
  const p = fakePage();
  const trigger = p.dom.el('button', { text: 'More' });
  p.byId.filterbar.appendChild(trigger);
  const first = simpleMenu(p, trigger, ['Old']);
  first.ctl.open({ focus: 'first' });
  assert.equal(p.doc.activeElement, first.list.children[0]);
  first.ctl.destroy();
  assert.equal(p.doc.activeElement, trigger);
  const second = simpleMenu(p, trigger, ['New']);
  trigger.click();
  assert.deepEqual([second.ctl.isOpen(), trigger.getAttribute('aria-expanded'), p.keys.escDepth()], [true, 'true', 1], 'one click opens only the new menu');
  second.ctl.destroy();
});

test('popover destroy(): same contract as a menu', () => {
  const p = fakePage();
  const trigger = p.dom.el('button', { text: 'Drops' });
  p.byId.filterbar.appendChild(trigger);
  const btn = p.dom.el('button', { text: 'Jump to gap' });
  const panel = p.dom.portal(p.dom.el('div', { hidden: true }, btn), 'popover');
  panel.querySelectorAll = () => [btn];
  const ctl = p.ui.popover(trigger, panel);
  trigger.click();
  assert.equal(p.doc.activeElement, btn);
  ctl.destroy();
  assert.deepEqual([ctl.isOpen(), panel.parent, p.keys.escDepth(), p.doc.activeElement === trigger], [false, null, 0, true]);
  assert.deepEqual([trigger.getAttribute('aria-haspopup'), (trigger.listeners.click || []).length], [null, 0]);
});

test('dialog destroy(): closes an open dialog (onClose "destroy", page live again, focus back) and removes its host', () => {
  const p = fakePage();
  const opener = p.dom.el('button', { text: 'Open' });
  p.byId.filterbar.appendChild(opener);
  const ok = p.dom.el('button', { text: 'OK' });
  const panel = p.dom.el('div', null, ok);
  panel.querySelectorAll = () => [ok];
  const reasons = [];
  const d = p.ui.dialog(panel, { label: 'Sheet', onClose: r => reasons.push(r) });
  const host = panel.parent;
  p.focus(opener);
  d.open();
  assert.equal(p.byId.filterbar.inert, true);
  d.destroy();
  assert.deepEqual([d.isOpen(), host.parent, p.byId.filterbar.inert, p.keys.escDepth(), reasons], [false, null, false, 0, ['destroy']]);
  assert.equal(p.doc.activeElement, opener);
  d.open();
  assert.equal(d.isOpen(), false, 'a destroyed dialog never opens again');
  d.destroy();
  assert.deepEqual(reasons, ['destroy'], 'a second destroy does nothing');
  const closed = p.ui.dialog(p.dom.el('div'), { label: 'Never opened', onClose: r => reasons.push(r) });
  closed.destroy();
  assert.deepEqual(reasons, ['destroy'], 'destroying a closed dialog calls no onClose');
});

// ---- P4: the tooltip API the shell needs (P3 follow-ups b and d) ----

test('place: side right / left centres beside the anchor, flips at the viewport edge and clamps top', () => {
  const r = rect(10, 300, 32, 32);   // a rail button: right 42, vertical centre 316
  assert.deepEqual({ ...U.place(r, { w: 80, h: 24 }, { vw: 800, vh: 600 }, { side: 'right', gap: 6 }) }, { left: 48, top: 304, side: 'right' });
  assert.deepEqual({ ...U.place(rect(760, 300, 32, 32), { w: 80, h: 24 }, { vw: 800, vh: 600 }, { side: 'right' }) }, { left: 674, top: 304, side: 'left' });
  assert.deepEqual({ ...U.place(rect(20, 300, 32, 32), { w: 80, h: 24 }, { vw: 800, vh: 600 }, { side: 'left' }) }, { left: 58, top: 304, side: 'right' });
  assert.equal(U.place(rect(10, 2, 32, 8), { w: 80, h: 24 }, { vw: 800, vh: 600 }, { side: 'right' }).top, 8, 'top clamped to pad');
  assert.equal(U.place(rect(10, 590, 32, 8), { w: 80, h: 24 }, { vw: 800, vh: 600 }, { side: 'right' }).top, 568, 'and to the bottom');
});

test('tooltip: several shortcuts (binding ids and written combos), text after the kbds, a side, setText only re-renders on change', () => {
  const p = fakePage();
  p.keys.register({ id: 'stream.clear', keys: 'Mod+Backspace', run() {} });
  const btn = p.dom.el('button', { 'aria-label': 'Clear view' });
  p.byId.filterbar.appendChild(btn);
  const t = p.ui.tooltip(btn, { text: 'Clear view', shortcut: ['stream.clear', { combo: 'Mod+-' }, 'not.bound'], after: '(undo for 10 s)', side: 'right' });
  const tip = p.byId[btn.attrs['aria-describedby']];
  assert.deepEqual(tip.children.map(c => [c.className, c.textContent, c.hidden]), [
    ['', 'Clear view', false], ['kbd', '⌘⌫', false], ['kbd', '⌘−', false], ['kbd', '', true], ['', '(undo for 10 s)', false]],
    'one kbd per shortcut; an unbound id shows none');
  assert.equal(texts(tip), 'Clear view⌘⌫⌘−(undo for 10 s)');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.deepEqual([tip.hidden, tip.style.left, tip.style.top], [false, '586px', '34px'], 'placed to the right of the trigger (580 + 6), centred on it');
  let writes = 0;
  const label = tip.children[0];
  let value = label.textContent;
  Object.defineProperty(label, 'textContent', { get: () => value, set: v => { writes++; value = v; } });
  t.setText('Clear view');
  assert.equal(writes, 0, 'the same text writes nothing');
  t.setText('Clear');
  assert.deepEqual([writes, value], [1, 'Clear']);
  const plain = p.ui.tooltip(p.dom.el('button'), { text: 'Export' });
  assert.equal(p.byId.ovTips.children.at(-1).children.at(-1).hidden, true, 'no after text: its span stays hidden');
  t.destroy(); plain.destroy();
});

test('tooltip: shows on an aria-disabled trigger, and `when` keeps it hidden while false', () => {
  const p = fakePage();
  const btn = p.dom.el('button', { 'aria-disabled': 'true', 'aria-label': 'Settings' });
  p.byId.filterbar.appendChild(btn);
  let rail = false;
  const t = p.ui.tooltip(btn, { text: 'Settings', side: 'right', when: () => rail });
  const tip = p.byId[btn.attrs['aria-describedby']];
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.equal(tip.hidden, true, 'when() is false: no tooltip');
  btn.fire('pointerleave');
  rail = true;
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.equal(tip.hidden, false, 'aria-disabled does not stop the tooltip (WebKit gives a disabled button no pointer events)');
  t.destroy();
});

// A hidden element that aria-describedby points to still counts toward the description, so a tip that only
// repeats the control's name (a rail item's) must not be wired in: the name would be read twice (review F6).
test('tooltip: describe: false leaves aria-describedby alone, and the tip still shows', () => {
  const p = fakePage();
  const btn = p.dom.el('button', { 'aria-label': 'Live session' });
  const other = p.dom.el('button', { 'aria-describedby': 'status' });
  p.byId.filterbar.appendChild(btn);
  p.byId.filterbar.appendChild(other);
  const t = p.ui.tooltip(btn, { text: 'Live session', describe: false });
  const t2 = p.ui.tooltip(other, { text: 'Other', describe: false });
  assert.deepEqual([btn.getAttribute('aria-describedby'), other.getAttribute('aria-describedby')], [null, 'status'], 'nothing added, an existing description untouched');
  const tip = p.byId.ovTips.children.at(-2);
  assert.equal(texts(tip), 'Live session');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.equal(tip.hidden, false, 'it still shows on hover');
  t.destroy(); t2.destroy();
  assert.deepEqual([btn.getAttribute('aria-describedby'), other.getAttribute('aria-describedby')], [null, 'status'], 'destroy has nothing to remove');
});

test('Esc ranking: a hover tooltip waits for a keyboard-focused menu; a keyboard tooltip goes first (review follow-up d)', () => {
  const p = fakePage();
  const more = p.dom.el('button', { text: 'More' });
  const other = p.dom.el('button', { text: 'Clear' });
  p.byId.filterbar.appendChild(more);
  p.byId.filterbar.appendChild(other);
  const m = simpleMenu(p, more, ['Open log file…']);
  const tip = p.ui.tooltip(other, { text: 'Clear view' });
  const tipEl = p.byId[other.attrs['aria-describedby']];
  m.ctl.open({ focus: 'first' });
  other.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  assert.deepEqual([m.ctl.isOpen(), tipEl.hidden], [true, false], 'precondition: menu open, hover tooltip shown');
  assert.equal(esc(p), 'esc');
  assert.deepEqual([m.ctl.isOpen(), tipEl.hidden, p.doc.activeElement === more], [false, false, true], 'the first Esc closes the menu');
  assert.equal(esc(p), 'esc');
  assert.equal(tipEl.hidden, true, 'the second Esc hides the hover tooltip');
  other.fire('pointerleave');
  p.setFocusVisible(true);
  other.fire('focus');
  m.ctl.open({ focus: 'none' });
  other.fire('focus');
  assert.equal(tipEl.hidden, false);
  assert.equal(esc(p), 'esc');
  assert.deepEqual([tipEl.hidden, m.ctl.isOpen()], [true, true], 'a keyboard-focus tooltip still goes first');
  m.ctl.close();
  tip.destroy();
});

test('Esc ranking: a hover tooltip that then gets keyboard focus moves up to the keyboard level', () => {
  const p = fakePage();
  const btn = p.dom.el('button', { text: 'Clear' });
  p.byId.filterbar.appendChild(btn);
  const tip = p.ui.tooltip(btn, { text: 'Clear view' });
  const order = [];
  const popMenu = p.keys.pushEsc(() => order.push('menu'), 'menu');
  btn.fire('pointerenter', { pointerType: 'mouse' });
  p.advance(400);
  p.setFocusVisible(true);
  btn.fire('focus');
  assert.equal(p.keys.escDepth(), 2, 'still one tooltip entry');
  assert.equal(esc(p), 'esc');
  assert.deepEqual([p.byId[btn.attrs['aria-describedby']].hidden, order], [true, []], 'the tooltip, now keyboard-shown, goes before the menu');
  popMenu();
  tip.destroy();
});
