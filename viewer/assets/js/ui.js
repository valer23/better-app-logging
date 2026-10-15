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

  // Toasts: at most `max` visible, the rest wait in FIFO order and their timers start only once shown.
  // 5 s, 10 s with an action, errors never expire. pause/resume keep the remaining time (hover, focus).
  // A toast with a `key` replaces the one with the same key and restarts its timer (a paused one stays paused).
  // When every visible slot holds a sticky toast (an error), a new toast evicts the oldest visible one.
  const TOAST_MS = 5000;
  const TOAST_ACTION_MS = 10000;
  function toastTimeout(spec) { return spec.kind === 'error' ? Infinity : spec.action ? TOAST_ACTION_MS : TOAST_MS; }
  function createToastQueue({ max = 3 } = {}) {
    let seq = 0;
    const visible = [];
    const pending = [];
    const start = (t, now) => { t.startedAt = now; t.paused = false; };
    const promote = now => { while (visible.length < max && pending.length) { const t = pending.shift(); start(t, now); visible.push(t); } };
    const find = id => visible.find(t => t.id === id) || pending.find(t => t.id === id);
    return {
      add(spec, now) {
        const prev = spec.key == null ? null : visible.concat(pending).find(t => t.spec.key === spec.key);
        if (prev) {
          prev.spec = spec;
          prev.remaining = toastTimeout(spec);
          // A paused toast stays paused (the pointer or focus is still on it) and gets the full new time
          // when it resumes; only a running visible toast restarts its clock.
          if (visible.includes(prev) && !prev.paused) start(prev, now);
          return prev.id;
        }
        seq += 1;
        pending.push({ id: seq, spec, remaining: toastTimeout(spec), startedAt: 0, paused: false });
        promote(now);
        // Policy: sticky toasts (errors) never expire, so when every visible slot is sticky a newcomer
        // would wait forever and never be announced. Evict the oldest visible one instead, until nothing waits.
        while (pending.length && visible.length >= max && visible.every(t => toastTimeout(t.spec) === Infinity)) {
          visible.shift();
          promote(now);
        }
        return seq;
      },
      dismiss(id, now) {
        for (const list of [visible, pending]) {
          const i = list.findIndex(t => t.id === id);
          if (i >= 0) { list.splice(i, 1); promote(now); return true; }
        }
        return false;
      },
      pause(id, now) {
        const t = visible.find(x => x.id === id);
        if (!t || t.paused) return;
        t.remaining -= now - t.startedAt;
        t.paused = true;
      },
      resume(id, now) {
        const t = visible.find(x => x.id === id);
        if (t && t.paused) start(t, now);
      },
      due: now => visible.filter(t => !t.paused && now - t.startedAt >= t.remaining).map(t => t.id),
      nextDeadline(now) {
        let d = Infinity;
        for (const t of visible) if (!t.paused) d = Math.min(d, t.startedAt + t.remaining - now);
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
