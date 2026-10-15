/* Per-session view state for the log table (roadmap P2). Classic script and pure: no page, storage
   or timer access, so the tests run it in an empty vm context. The page loads it synchronously just
   before the legacy inline script, which holds `liveSession`, `fileSession` and `cur` (the session
   on screen).

   A session is one buffer the table can show: the live session (fed by both WebSockets, and still
   ingesting while another session is shown) or a loaded file. Everything needed to bring a session
   back lives on it: the buffer and its filtered view, the reading window, the selection, Follow, the
   saved scroll position, the loss counters (#45, #46) and its own <tbody> (set by the page). */
(function (g) {
  'use strict';

  let nextId = 1;

  // One factory with a fixed key order, so every session has the same hidden class and the drain
  // loop and buildRow see monomorphic property loads. Never add or delete a key after create().
  function create(kind, name) {
    if (kind !== 'live' && kind !== 'file') throw new TypeError(`session kind must be 'live' or 'file', not ${kind}`);
    return {
      id: nextId++,
      kind,
      name: String(name),
      all: [],                    // retained lines, in arrival order
      filtered: [],               // the lines of `all` that pass the query generation `query`
      renderedEnd: 0,             // the tbody holds filtered[renderedEnd - rows, renderedEnd)
      renderFrom: -1,             // first new filtered index of an in-progress drain; -1 = none
      domStale: false,            // the tbody lags `filtered`; the next on-screen render rebuilds it
      follow: kind === 'live',    // auto-scroll; a file session never follows
      sel: null,                  // the selected line, kept across filter changes and switches
      query: 0,                   // filter generation `filtered` was built with (P6: the compiled query)
      scroll: { top: 0, left: 0, anchor: null, anchorTop: 0 },   // saved while another session is shown
      discarded: 0,               // lines dropped by the retention cap or the paused-backlog cap (#45)
      overflowed: false,          // the paused backlog dropped frames newer than every retained line
      seqFloor: 0,                // seq of the oldest retained live line; rows below it were trimmed
      dropped: { android: 0, ios: 0 },   // frames the server dropped for this client (#46)
      markers: [],                // reserved for P10
      gaps: [],                   // reserved for P10
      tbody: null,                // the session's <tbody>; attached to the table only while shown
    };
  }

  // First index in [lo, arr.length) where pred holds; pred must be monotone (false…false, true…true).
  // Works on arrays and on array-likes such as tbody.rows.
  function firstIndexWhere(arr, lo, pred) {
    let hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pred(arr[mid])) hi = mid; else lo = mid + 1; }
    return lo;
  }

  // Retention cap (#45) for one session. `all` and `filtered` are both [lines without a seq, pinned]
  // [live lines, ascending seq], so the oldest live lines are one run in each, found by binary search
  // and removed with one splice each, in place (callers may hold the arrays). Drops down to
  // (1 - frac) * max, or every live line with dropAll (resume after a backlog overflow), and moves
  // the window indexes, the selection and the counters with them. Returns the seq of the first kept
  // line (table rows below it must go), or -1 when nothing was dropped. NaN or Infinity: no cap.
  function trim(s, max, frac, dropAll, nextSeq) {
    const all = s.all;
    if (!dropAll && !(all.length > max)) return -1;
    const base = firstIndexWhere(all, 0, m => m.seq !== undefined);
    const live = all.length - base;
    if (!dropAll && live <= max) return -1;
    const keep = dropAll ? 0 : Math.max(0, Math.floor(max * (1 - frac)));
    const drop = live - keep;
    if (drop <= 0) return -1;
    const cut = base + drop;
    const cutoff = cut < all.length ? all[cut].seq : nextSeq;   // seq of the first kept line
    s.seqFloor = cutoff;
    all.splice(base, drop);
    const filtered = s.filtered;
    const fa = firstIndexWhere(filtered, 0, m => m.seq !== undefined);
    const fb = firstIndexWhere(filtered, fa, m => m.seq >= cutoff);
    const fDrop = fb - fa;
    if (fDrop) {
      filtered.splice(fa, fDrop);
      const fix = i => i < fa ? i : Math.max(fa, i - fDrop);   // shift past the run, snap inside it
      if (s.renderFrom >= 0) s.renderFrom = fix(s.renderFrom);
      s.renderedEnd = fix(s.renderedEnd);
    }
    if (s.sel && s.sel.seq < cutoff) s.sel = null;
    s.discarded += drop;
    return cutoff;
  }

  // Paused-backlog cap: drops the oldest frames of `pending` down to (1 - frac) * max and marks `s`
  // overflowed (its retained lines are now older than the dropped frames). Returns the number dropped.
  function trimPending(pending, s, max, frac) {
    const drop = pending.length - Math.max(0, Math.floor(max * (1 - frac)));
    if (drop <= 0) return 0;
    pending.splice(0, drop);
    s.discarded += drop;
    s.overflowed = true;
    return drop;
  }

  // What a reset of `s` (Clear, or a new file loaded into it) forgets besides its lines: the drain in
  // progress and the loss counters. `dropped` is zeroed in place; the page's drop pill reads it.
  // seqFloor stays: it still guards clicks on rows of lines trimmed before the reset.
  function discard(s) {
    s.renderFrom = -1;
    s.discarded = 0;
    s.overflowed = false;
    s.dropped.android = 0;
    s.dropped.ios = 0;
  }

  // Replaces the lines of `s` and empties its view: no filtered lines, no window, no selection, no
  // saved scroll. Follow, the query generation and the counters are the caller's business.
  function reset(s, lines) {
    s.all = lines;
    s.filtered = [];
    s.renderedEnd = 0;
    s.renderFrom = -1;
    s.domStale = false;
    s.sel = null;
    s.scroll.top = 0;
    s.scroll.left = 0;
    s.scroll.anchor = null;
    s.scroll.anchorTop = 0;
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.session = Object.freeze({ create, firstIndexWhere, trim, trimPending, discard, reset });
})(typeof window !== 'undefined' ? window : globalThis);
