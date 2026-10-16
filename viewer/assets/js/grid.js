/* The log grid (roadmap P5; spec "Log grid", "Accessibility requirements"). Classic script, loaded after
   live.js. ALV.gridPure is pure (the tests run it in an empty vm context): the time cell, the row classes and
   the column resize steps. buildRow (legacy script) builds the rows with them. */
(function (g) {
  'use strict';

  // ---- Pure ----

  // The time cell (spec "15:54:26.290"): the last space-separated field when it reads HH:MM:SS, cut to
  // milliseconds (iOS sends microseconds). Anything else is shown whole. No regex: it runs for every built row.
  function timeOf(ts) {
    const s = ts == null ? '' : String(ts);
    const t = s.slice(s.lastIndexOf(' ') + 1);
    return t.length >= 8 && t[2] === ':' && t[5] === ':' ? t.slice(0, 12) : s;
  }

  // A row's class: its level (tint, stripe and letter colour in grid.css) and its platform (the badge). One
  // className write per row, as before P5; the names are not foundation classes, so no foundation rule is tried
  // on a row. ASSERT shows as F (spec D8); exports keep their own 'A'.
  const LEVEL_CLASS = { VERBOSE: 'l-v', DEBUG: 'l-d', INFO: 'l-i', WARN: 'l-w', ERROR: 'l-e', ASSERT: 'l-f' };
  const ROW_CLASS = {};
  for (const [lvl, c] of Object.entries(LEVEL_CLASS)) ROW_CLASS[lvl] = Object.freeze({ android: `${c} p-a`, ios: `${c} p-i` });
  Object.freeze(ROW_CLASS);
  function rowClass(lvl, platform) {
    const r = ROW_CLASS[lvl] || ROW_CLASS.VERBOSE;
    return platform === 'ios' ? r.ios : r.android;
  }

  // Column resize handles (spec "Log grid"): a 24 px separator on each boundary after Time, Lvl, Tag,
  // App / Device and PID–TID, value 40–400 px. ←/→ 8 px, ⇧ 32 px; Enter or Home resets the column to its
  // default (the ch width in grid.css, which follows the log text size).
  const COL_MIN = 40;
  const COL_MAX = 400;
  const RESIZABLE = Object.freeze([['ts', 'Time'], ['lvl', 'Lvl'], ['tag', 'Tag'], ['app', 'App / Device'], ['pid', 'PID–TID']]);
  function clampCol(px) { return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(Number(px) || 0))); }
  // → a step in px, 'reset', or null (not a resize key).
  function resizeKey(key, shift) {
    if (key === 'ArrowLeft') return shift ? -32 : -8;
    if (key === 'ArrowRight') return shift ? 32 : 8;
    if (key === 'Enter' || key === 'Home') return 'reset';
    return null;
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.gridPure = Object.freeze({ timeOf, rowClass, ROW_CLASS, LEVEL_CLASS: Object.freeze(LEVEL_CLASS), RESIZABLE, COL_MIN, COL_MAX, clampCol, resizeKey });
})(typeof window !== 'undefined' ? window : globalThis);
