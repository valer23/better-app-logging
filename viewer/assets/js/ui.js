/* UI primitives (roadmap P3; spec "Toasts", "Menus, popovers and tooltips", "Accessibility requirements").
   Classic script. The decisions are pure functions on ALV.uiPure (placement, roving index, typeahead,
   the toast queue, the announcement throttle, the focus-trap step), so the tests run them in an empty
   vm context. The DOM side (ALV.createUi, ALV.ui in the page) wires them to the overlay root. */
(function (g) {
  'use strict';

  // ---- Pure ----

  // Where a surface of `size` {w, h} goes next to `anchor` (a DOMRect-like {left, top, right, bottom,
  // width}) inside `viewport` {vw, vh}. side 'bottom' flips above when it does not fit below; 'top' flips
  // below. align 'end' right-aligns with the anchor (the Export menu), 'start' left-aligns, 'center'
  // centres (tooltips). Left is clamped to `pad` from both edges. The defaults reproduce the legacy
  // positionExportMenu() exactly.
  function place(anchor, size, viewport, opts = {}) {
    const { side = 'bottom', align = 'end', gap = 6, pad = 8 } = opts;
    const { w, h } = size;
    const { vw, vh } = viewport;
    let left = align === 'start' ? anchor.left : align === 'center' ? anchor.left + (anchor.width - w) / 2 : anchor.right - w;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    let top;
    let used = side;
    if (side === 'top') {
      top = anchor.top - h - gap;
      if (top < pad) { used = 'bottom'; top = anchor.bottom + gap; }
    } else {
      top = anchor.bottom + gap;
      if (top + h + pad > vh) { used = 'top'; top = Math.max(pad, anchor.top - h - gap); }
    }
    return { left, top, side: used };
  }

  // Roving index for a list of `len` items (menus): arrows wrap, Home/End and PageUp/PageDown jump.
  // i = -1 means nothing is active yet. Returns -1 for an empty list.
  function moveIndex(len, i, key) {
    if (!len) return -1;
    switch (key) {
      case 'ArrowDown': return i < 0 ? 0 : (i + 1) % len;
      case 'ArrowUp': return i < 0 ? len - 1 : (i - 1 + len) % len;
      case 'Home': case 'PageUp': return 0;
      case 'End': case 'PageDown': return len - 1;
      default: return i;
    }
  }

  // Menu typeahead: printable keys typed within `timeout` ms build a prefix matched case-insensitively
  // against the start of each label; repeating one character cycles through the items it starts.
  function createTypeahead(timeout = 500) {
    let buf = '';
    let last = -Infinity;
    return function find(labels, current, ch, now) {
      buf = now - last > timeout ? ch : buf + ch;
      last = now;
      const q = buf.toLowerCase();
      const cycling = [...q].every(c => c === q[0]);
      const needle = cycling ? q[0] : q;
      const from = cycling ? current + 1 : Math.max(current, 0);
      for (let k = 0; k < labels.length; k++) {
        const j = (from + k) % labels.length;
        if (labels[j].trim().toLowerCase().startsWith(needle)) return j;
      }
      return -1;
    };
  }

  // Toasts (spec "Toasts"). At most `max` are visible; the rest wait in FIFO order, and a toast's clock
  // starts only when it is shown. Timed toasts expire after 5 s, or 10 s with an action. Errors are
  // sticky: they stay while there is room, and while a toast waits but an unheld timed toast is on screen
  // (it frees a slot within 10 s anyway). Only when a toast waits and every unheld visible toast is an
  // error does the oldest error that has been on screen for 5 s yield its slot. Hover or focus holds a
  // toast (pause): a held toast never expires and never yields, and resume gives it back its remaining
  // time (an error gets a fresh 5 s). A toast with a `key` updates the queued toast with that key in
  // place (same id, same position) and restarts its clock unless it is held. Every mutation takes `now`
  // and ends in settle(now), which restores the invariants below (checked after every step by the seeded
  // model test in ui.test.mjs). `now` is clamped to the latest value the queue has seen, so a clock that
  // steps backwards (NTP, a manual change) cannot strand a toast.
  //   I1 visible.length <= max.
  //   I2 if a toast waits, visible.length === max.
  //   I3 ids are unique and never reused; keys are unique across visible and pending.
  //   I4 visible ++ pending keeps its order, a new toast joins the end, and nothing returns to pending.
  //   I5 a held toast leaves only through dismiss().
  //   I6 nothing is overdue: every unheld timed toast expires after now and, while a toast waits and every
  //      unheld visible toast is an error, every unheld error yields after now, so nextDeadline(now) > 0.
  //   I7 no stuck queue: while a toast waits, nextDeadline(now) is finite unless every visible toast is held.
  //   I8 a toast leaves visible only through dismiss() or after at least 5 s on screen: every promoted
  //      toast is still visible when the call that promoted it returns (the DOM shows and announces it
  //      exactly once), and a waiting toast leaves pending only by being shown or dismissed.
  //   I9 an error yields only to a waiting toast, which takes the freed slot in the same call, and only
  //      while a toast waits and every unheld visible toast is an error.
  const TOAST_MS = 5000;
  const TOAST_ACTION_MS = 10000;
  const TOAST_YIELD_MS = TOAST_MS;
  function toastTimeout(spec) { return spec.kind === 'error' ? Infinity : spec.action ? TOAST_ACTION_MS : TOAST_MS; }
  function createToastQueue({ max = 3 } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('createToastQueue: max must be an integer >= 1');
    let seq = 0;
    const visible = [];   // on screen, oldest first: { id, spec, remaining, startedAt, paused }
    const pending = [];   // waiting, FIFO: never paused, clock not started
    const sticky = t => toastTimeout(t.spec) === Infinity;
    const find = id => visible.find(t => t.id === id) || pending.find(t => t.id === id);
    const timedRuns = () => visible.some(t => !t.paused && !sticky(t));   // an unheld timed toast will free a slot
    let last = -Infinity;
    const clock = now => { last = Math.max(last, now); return last; };   // never earlier than a time already seen

    // The one place a toast leaves the queue other than dismiss(). Returns the removed ids, in order.
    function settle(now) {
      const removed = [];
      for (let i = 0; i < visible.length;) {
        const t = visible[i];
        if (!t.paused && !sticky(t) && now - t.startedAt >= t.remaining) { visible.splice(i, 1); removed.push(t.id); }
        else i += 1;
      }
      for (;;) {
        while (visible.length < max && pending.length) {
          const t = pending.shift();
          t.startedAt = now;
          visible.push(t);
        }
        if (!pending.length) return removed;
        // Full and a toast waits. An unheld timed toast frees a slot within 10 s, so errors stay. Otherwise
        // the oldest unheld error on screen for TOAST_YIELD_MS gives up its slot. A toast promoted just
        // above has now - startedAt === 0, so it never yields in the same call.
        if (timedRuns()) return removed;
        const i = visible.findIndex(t => !t.paused && sticky(t) && now - t.startedAt >= TOAST_YIELD_MS);
        if (i < 0) return removed;
        removed.push(visible.splice(i, 1)[0].id);
      }
    }

    return {
      add(spec, now) {
        now = clock(now);
        let t = spec.key == null ? null : visible.find(x => x.spec.key === spec.key) || pending.find(x => x.spec.key === spec.key);
        if (t) {
          // Keyed replace: same id, same place. A held toast stays held with the full new time, which
          // starts on resume; otherwise the clock restarts now (a waiting toast's when it is shown).
          t.spec = spec;
          t.remaining = toastTimeout(spec);
          if (!t.paused) t.startedAt = now;
        } else {
          seq += 1;
          t = { id: seq, spec, remaining: toastTimeout(spec), startedAt: now, paused: false };
          pending.push(t);
        }
        settle(now);
        return t.id;
      },
      dismiss(id, now) {
        now = clock(now);
        let hit = false;
        for (const list of [visible, pending]) {
          const i = list.findIndex(t => t.id === id);
          if (i >= 0) { list.splice(i, 1); hit = true; break; }
        }
        settle(now);
        return hit;
      },
      pause(id, now) {
        now = clock(now);
        const t = visible.find(x => x.id === id);
        if (t && !t.paused) { t.remaining -= now - t.startedAt; t.paused = true; }
        settle(now);
      },
      resume(id, now) {
        now = clock(now);
        const t = visible.find(x => x.id === id);
        if (t && t.paused) { t.startedAt = now; t.paused = false; }
        settle(now);
      },
      // Time passed: expire what ran out, show what waits, let overdue errors yield. The DOM calls it when
      // its nextDeadline() timer fires. Returns the ids that left; the DOM reconciles from visible().
      tick: now => settle(clock(now)),
      // ms until a tick() would change something (<= 0: overdue); Infinity when no clock is running.
      nextDeadline(now) {
        now = clock(now);
        const errorsYield = pending.length > 0 && !timedRuns();
        let d = Infinity;
        for (const t of visible) {
          if (t.paused) continue;
          const span = sticky(t) ? (errorsYield ? TOAST_YIELD_MS : Infinity) : t.remaining;
          d = Math.min(d, t.startedAt + span - now);
        }
        return d;
      },
      visible: () => visible.map(t => t.id),
      pending: () => pending.map(t => t.id),
      get: id => { const t = find(id); return t ? t.spec : null; },
    };
  }

  // Live-region throttle: at most one announcement per `interval` ms; while throttled the newest text
  // waits and is spoken when the window ends (older waiting texts are dropped).
  function createThrottle(interval = 5000) {
    let lastAt = -Infinity;
    let queued = null;
    return {
      push(text, now) {
        if (now - lastAt >= interval) { lastAt = now; queued = null; return text; }
        queued = text;
        return null;
      },
      wait: now => (queued === null ? Infinity : Math.max(0, lastAt + interval - now)),
      flush(now) {
        if (queued === null || now - lastAt < interval) return null;
        const t = queued;
        queued = null;
        lastAt = now;
        return t;
      },
    };
  }

  // Focus trap step for Tab in a modal: the index to focus instead of the browser's default, -1 to let
  // the browser move focus (it stays inside), -2 when nothing inside is focusable (focus the panel).
  function trapTarget(len, i, shift) {
    if (!len) return -2;
    if (i < 0) return shift ? len - 1 : 0;
    if (shift && i === 0) return len - 1;
    if (!shift && i === len - 1) return 0;
    return -1;
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.uiPure = Object.freeze({ place, moveIndex, createTypeahead, createToastQueue, createThrottle, trapTarget, toastTimeout });
})(typeof window !== 'undefined' ? window : globalThis);
