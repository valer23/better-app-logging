/* Incremental counts (roadmap P6; spec "Performance constraints" → Counts, "Query region" → level chips). Classic
   script and pure: no page, storage or timer access, so the tests run it in an empty vm context.

   One counts object per session, c = { lvl, tags, apps }:
   - lvl[k]: the session's lines of level k that pass the rest of the query (text, tag, app, pid and device filters)
     whatever the level filter says, i.e. gate(m) === k (query.js). The level chips show them.
   - tags, apps: every retained line by tag and by app (an empty app is not counted), whatever the query says. The
     empty-state causes (P6b) and autocomplete (P7) read them.
   The drain adds each line once (add, plus lvl[gate(m)]++), a retention trim removes the run it drops (remove, before
   the splice), and a reset rebuilds them (recount). Nothing rescans the buffer per flush. */
(function (g) {
  'use strict';

  function create() { return { lvl: [0, 0, 0, 0, 0, 0], tags: new Map(), apps: new Map() }; }

  // The line's tag and app, once per line in the drain. The level count is the caller's: it knows the gate.
  function add(c, m) {
    const tags = c.tags;
    const tag = m.tag;
    tags.set(tag, (tags.get(tag) || 0) + 1);
    const app = m.app;
    if (app) { const apps = c.apps; apps.set(app, (apps.get(app) || 0) + 1); }
  }
  function dec(map, k) { const n = map.get(k); if (n > 1) map.set(k, n - 1); else map.delete(k); }

  // The lines all[from, to) leave the session (a retention trim calls this before its splice). gate is the session's
  // query gate when its level counts are current, else null: they are rebuilt when the session is refiltered.
  function remove(c, all, from, to, gate) {
    const lv = c.lvl;
    for (let i = from; i < to; i++) {
      const m = all[i];
      dec(c.tags, m.tag);
      if (m.app) dec(c.apps, m.app);
      if (gate !== null) { const k = gate(m); if (k >= 0) lv[k]--; }
    }
  }

  function clear(c) { c.lvl.fill(0); c.tags.clear(); c.apps.clear(); }

  // Rebuilds every count from `lines`: the maps always, the level counts through gate (null leaves them at 0).
  function recount(c, lines, gate) {
    clear(c);
    const lv = c.lvl;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i];
      add(c, m);
      if (gate !== null) { const k = gate(m); if (k >= 0) lv[k]++; }
    }
    return c;
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.counts = Object.freeze({ create, add, remove, clear, recount });
})(typeof window !== 'undefined' ? window : globalThis);
