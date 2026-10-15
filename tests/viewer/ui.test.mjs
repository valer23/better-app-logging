// The pure side of the UI primitives (viewer/assets/js/ui.js, ALV.uiPure): placement (parity with
// the legacy positionExportMenu), the menu roving index and typeahead, the toast queue (timeouts,
// pause/resume, max 3 + FIFO, replace by key, errors yield after 5 s when a toast waits, and a seeded
// model test of the queue invariants), the live-region throttle and the focus-trap step.
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
    let ret;
    if (op.type === 'add') ret = q.add(op.spec, now);
    else if (op.type === 'dismiss') {
      ret = q.dismiss(op.id, now);
      if (ret !== b.spec.has(op.id)) fail(`dismiss(${op.id}) returned ${ret}`);
    } else if (op.type === 'pause') { q.pause(op.id, now); if (b.vis.includes(op.id)) held.add(op.id); }
    else if (op.type === 'resume') { q.resume(op.id, now); held.delete(op.id); }
    else ret = q.tick(now);
    check(b, snap(), op, ret);
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
