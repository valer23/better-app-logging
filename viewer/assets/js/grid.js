/* The log grid (roadmap P5; spec "Log grid", "Accessibility requirements"). Classic script, loaded after
   live.js. ALV.gridPure is pure (the tests run it in an empty vm context): the time cell, the row classes and
   the column resize steps. buildRow (legacy script) builds the rows with them. ALV.createGrid wires the grid's
   header to the page; the legacy script calls it once, right after createLive. Nothing here runs per row or per
   flush. */
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

  // The jump pill and the paused pill (spec "States", "Follow, pause and the jump pill"): Paused wins over new lines.
  // → null (hidden) or { mode, icon, pre, num, unit, action, key }: "<pre><b>num</b><unit>" and a primary button
  // `action` with the kbd of binding `key`. Numbers use the thin-space grouping (shellPure.num, loaded first).
  function pillView({ paused, buffered, overflowed, below }) {
    const { num } = g.ALV.shellPure;
    if (paused) {
      const base = { mode: 'paused', icon: 'pause', action: 'Resume', key: 'stream.pause' };
      if (overflowed) return { ...base, pre: 'Buffer full · resuming skips to the newest lines', num: '', unit: '' };
      return { ...base, pre: 'Resume to see ', num: num(buffered), unit: buffered === 1 ? ' buffered line' : ' buffered lines' };
    }
    if (below > 0) return { mode: 'newer', icon: 'arrow-down-to-line', pre: '', num: num(below), unit: below === 1 ? ' line below' : ' lines below', action: 'Jump to latest', key: 'stream.latest' };
    return null;
  }

  // ---- DOM ----

  // createGrid({ doc, dom, keys, shell, state, actions }) → { sync() }. Adds a resize separator on each RESIZABLE
  // boundary of #headerRow, makes the scroller the shortcut registry's grid root, binds the stream keys and keeps
  // aria-rowcount current. state() is the legacy shellState(); actions are legacy functions: jumpToEnd,
  // jumpToOldest, togglePause, toggleAutoScroll, updateNewerPill.
  function createGrid({ doc, dom, keys, shell, state, actions }) {
    const { setAttr, setText } = g.ALV.shellPure;   // shell.js loads first
    const $ = id => doc.getElementById(id);
    const table = $('logTableEl');
    const scroller = $('logTable');
    // Grid-scoped keys (P5b: Space, F) fire while focus is on the table, the grid's one Tab stop (rows are never
    // focusable until P9). A resize separator inside it owns its unmodified keys (keys.js OWNING_ROLES).
    keys.setGridRoot(scroller);

    // ---- Stream keys (spec "Keyboard map", "Follow, pause and the jump pill"). End / ⌘↓ turn Follow on at the newest
    // line and Home / ⌘↑ go to the oldest retained line, from anywhere but a text field or a control that owns the
    // key; Space† pauses and F† toggles Follow while the grid has focus, on the live session only. ----
    const onLive = () => state().cur.kind === 'live';
    // End and Home are global, so they wait while the grid is hidden (the device cards, the dropzone, loading) or a
    // legacy modal is over it: keys.setModal does not cover the setup guide or the stall modal, which scroll with them.
    const shown = () => !!state().gridShown;
    keys.register({ id: 'stream.latest', keys: ['End', 'Mod+ArrowDown'], when: shown, run: () => actions.jumpToEnd() });
    keys.register({ id: 'stream.oldest', keys: ['Home', 'Mod+ArrowUp'], when: shown, run: () => actions.jumpToOldest() });
    keys.register({ id: 'stream.pause', keys: 'Space', scope: 'grid', when: onLive, run: () => actions.togglePause() });
    keys.register({ id: 'stream.follow', keys: 'F', scope: 'grid', when: onLive, run: () => actions.toggleAutoScroll() });
    // The toolbar buttons carry their keys (spec: aria-keyshortcuts on toolbar buttons) and show them from the
    // 1 320 px toolbar tier (shell.css); their tooltips name them always (live.js).
    setAttr($('pauseBtn'), 'aria-keyshortcuts', keys.aria('stream.pause'));
    setAttr($('autoScrollBtn'), 'aria-keyshortcuts', keys.aria('stream.latest'));
    setText($('pauseKbd'), keys.label('stream.pause'));
    setText($('followKbd'), keys.label('stream.latest'));
    // ---- Column resize. Layout is read only on a user action (focus, a key, a press), never per flush. ----
    const ths = Array.from($('headerRow').children);
    const cols = Array.from($('colgroup').children);
    for (const [key, label] of RESIZABLE) {
      const i = ths.findIndex(th => th.getAttribute('data-col') === key);
      if (i < 0 || !ths[i + 1]) continue;
      const th = ths[i];
      const col = cols[i];
      // The handle sits on the boundary, in the NEXT header cell: each sticky th paints over the one before it,
      // so a handle reaching right out of its own cell would be half covered.
      const sep = dom.el('span', { class: 'col-sep', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
        'aria-label': `Resize ${label} column`, 'aria-valuemin': String(COL_MIN), 'aria-valuemax': String(COL_MAX) });
      const width = () => Math.round(th.offsetWidth);
      const show = () => sep.setAttribute('aria-valuenow', String(width()));
      const set = px => { col.style.width = px === null ? '' : `${clampCol(px)}px`; show(); };
      sep.addEventListener('focus', show);
      sep.addEventListener('keydown', e => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const step = resizeKey(e.key, e.shiftKey);
        if (step === null) return;
        e.preventDefault();   // the shortcut registry skips a handled key: Home here never jumps the stream (P5b)
        set(step === 'reset' ? null : width() + step);
      });
      sep.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const x0 = e.clientX;
        const w0 = width();
        if (sep.setPointerCapture) sep.setPointerCapture(e.pointerId);
        sep.setAttribute('data-drag', '');
        // A move only writes the width: reading it back (show()) would lay out the whole table, up to 6 000 rows, on
        // every pointermove, and WKWebView can deliver several a frame. The value is read once, on release.
        const move = ev => { col.style.width = `${clampCol(w0 + ev.clientX - x0)}px`; };
        const up = () => {
          sep.removeEventListener('pointermove', move);
          sep.removeEventListener('pointerup', up);
          sep.removeEventListener('pointercancel', up);
          sep.removeAttribute('data-drag');
          show();
        };
        sep.addEventListener('pointermove', move);
        sep.addEventListener('pointerup', up);
        sep.addEventListener('pointercancel', up);
      });
      // A columnheader is named from its content, and that would include the separator's aria-label ("Lvl Resize Time
      // column", read for every cell). Name the host from its visible text first; a name the markup gives is kept.
      const host = ths[i + 1];
      if (host.getAttribute('aria-label') === null) {
        const h = host.querySelector('.h');
        host.setAttribute('aria-label', (h || host).textContent.trim());
      }
      host.appendChild(sep);
    }

    // ---- The focus ring (spec: 2 px --ring, inset, visible inside scroll regions). The table is up to 6 000 rows tall
    // and can be wider than its scroller, so a ring on it has its edges off screen; #logWrapper does not scroll, and
    // grid.css paints the ring on its ::after while it has this class. Read on focus, blur and a key (Chromium may
    // start matching :focus-visible on a table focused by a press when a key follows) and on every tick, so a grid that
    // was hidden while focused keeps no stale ring. A write only when it changed. ----
    const wrapper = $('logWrapper');
    const ring = () => {
      const on = table.matches(':focus-visible');
      if (wrapper.classList.contains('grid-focus') !== on) wrapper.classList.toggle('grid-focus', on);
    };
    table.addEventListener('focus', ring);
    table.addEventListener('blur', () => wrapper.classList.remove('grid-focus'));
    table.addEventListener('keydown', ring);

    // ---- The full timestamp, with its date, as the time cell's title: set on the first hover, never in buildRow. ----
    scroller.addEventListener('pointerover', e => {
      const td = e.target && e.target.closest ? e.target.closest('td') : null;
      if (!td || td.className !== 'c-ts' || td.title) return;
      const tr = td.closest('tr');
      if (tr && tr._message && tr._message.ts) td.title = String(tr._message.ts);
    });

    // ---- aria-rowcount (spec): the shown session's filtered lines plus the header row. Written on shellSync and the
    // shell's tick (twice a second), never from the drain, and only when it changed. The tick also refreshes the
    // paused pill's count: a paused stream runs no flush. ----
    function sync() {
      setAttr(table, 'aria-rowcount', String(state().cur.filtered.length + 1));
      ring();
      actions.updateNewerPill();
    }
    shell.onTick(sync);
    return { sync };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.gridPure = Object.freeze({ timeOf, rowClass, ROW_CLASS, LEVEL_CLASS: Object.freeze(LEVEL_CLASS), RESIZABLE, COL_MIN, COL_MAX, clampCol, resizeKey, pillView });
  ALV.createGrid = createGrid;
})(typeof window !== 'undefined' ? window : globalThis);
