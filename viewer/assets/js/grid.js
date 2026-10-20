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

  // Rows in one screenful of the grid (spec "Sizes": a row is max(18px, log size × 1.6), × 1.4 when Compact): the
  // arrival highlight's limit. 0 while the grid has no height (hidden), so nothing is highlighted then.
  function rowPx(fs, density) { return Math.max(18, fs * (density === 'compact' ? 1.4 : 1.6)); }
  function screenRows(height, fs, density) { return height > 0 ? Math.ceil(height / rowPx(fs, density)) : 0; }

  // The arrival highlight's budget. The spec's rule is per flush: a flush above one screenful lights nothing, and any
  // flush up to a screenful lights. A row's fade lasts ARRIVAL_MS (= --t-arrival), longer than the gap between two
  // flushes, so on top of that rule one leaky bucket bounds how many rows fade at once, in constant time (a level and a
  // timestamp, no array, no layout read): capacity is one screenful and it refills a screenful per ARRIVAL_MS. A flush
  // above the capacity is skipped and spends nothing, which is the spec's rule; the rows lit within any ARRIVAL_MS window
  // never exceed the capacity plus its refill, two screenfuls. Ordinary streams are untouched: on a 37-row screen every
  // 150 ms flush of up to about 60 lines/s glows; a sustained rate above the refill (a screenful per 600 ms) is thinned
  // to it. st = { level, at } is mutated; `now` and ARRIVAL_MS are in ms.
  const ARRIVAL_MS = 600;
  function arrive(st, n, now, screen) {
    if (!(n > 0) || n > screen) return false;
    const level = Math.max(0, st.level - Math.max(0, now - st.at) * screen / ARRIVAL_MS);
    if (level + n > screen) return false;
    st.level = level + n; st.at = now;
    return true;
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

  // The grid's empty state (spec "Log grid", empty states), or null while it shows rows. e: { kind, all, shown,
  // stale (cur.filtered is out of date: the session's filter generation lags, as after a file open until its render),
  // cleared (no line since a Clear), paused, levelsOff, devicesOff, tag (the tag filter), query (the search or PID /
  // App field filters), waiting: [the names of the devices streaming], gone: [the names of the devices whose stream is
  // open but whose phone the bridge reported gone (noDevice)] }. → { key, say, icon, spin, title, desc, fix, fixLabel,
  // reset, skeleton }: key changes when anything shown changes, say (the announcement) only when the state or its
  // cause does. fix is what the fix button resets: 'levels' | 'devices' | 'tag' | null. An empty file session shows
  // the dropzone, and an empty live session with no open stream the device panel (refreshLiveView, #70): no tile.
  function emptyView(e) {
    const { num } = g.ALV.shellPure;
    // A stale session's filtered list says nothing about matches: the render or restoreView refilters it and calls
    // updateNewerPill, which settles the tile. Saying "no match" now would announce a state that is not true.
    if (e.shown > 0 || e.stale) return null;
    const none = { fix: null, fixLabel: '', reset: false, skeleton: false, desc: '' };
    if (e.all > 0) {
      const [cause, fix, fixLabel] = e.levelsOff ? ['All levels are turned off.', 'levels', 'Turn levels back on']
        : e.devicesOff ? ['Both devices are hidden.', 'devices', 'Show both devices']
          : e.tag ? [`No retained line matches tag:${e.tag}.`, 'tag', `Remove tag:${e.tag}`]
            // The search or PID / App field filters too: the chips are not the cause, and the spec's query causes
            // (NOT tag, tag:x chips) are P6's, so the tile shows the count and Reset filter only.
            : e.query ? ['', null, '']
              : ['No retained line matches the level and device chips.', null, ''];
      const tail = cause ? ` ${cause}` : '';
      const desc = `0 of ${num(e.all)} lines in view.${tail}`;
      return { ...none, key: `match|${desc}`, say: `No lines match this filter.${tail}`, icon: 'search-x', spin: false,
        title: 'No lines match this filter', desc, fix, fixLabel, reset: true };
    }
    if (e.kind !== 'live') return null;
    // Every open stream's phone is gone (noDevice: the sidebar row reads Disconnected, the badge is idle): the spec's
    // Disconnected copy, without the time it was unplugged (not recorded). No button: the bridge resumes by itself.
    if (e.gone.length && !e.waiting.length) {
      const title = `${e.gone.join(' and ')} ${e.gone.length > 1 ? 'were' : 'was'} unplugged`;
      return { ...none, key: `gone|${title}`, say: `${title}.`, icon: 'unplug', spin: false, title,
        desc: `Plug ${e.gone.length > 1 ? 'them' : 'it'} back in to continue.` };
    }
    // After Clear, while a device streams. With nothing streaming, Clear shows the device panel instead (#70).
    if (e.cleared && e.waiting.length) {
      return { ...none, key: 'cleared', say: 'Waiting for new lines…', icon: 'loader', spin: true, title: 'Waiting for new lines…',
        desc: 'The view was cleared. New lines appear here as they arrive.' };
    }
    if (e.waiting.length && !e.paused) {
      const title = `Waiting for the first lines from ${e.waiting.join(' and ')}…`;
      return { ...none, key: `wait|${title}`, say: title, icon: 'loader', spin: true, title, skeleton: true };
    }
    return null;
  }

  // ---- DOM ----

  // createGrid({ doc, win, dom, ui, keys, prefs, shell, state, actions }) → { sync(), syncEmpty(), screenRows, arrive(n),
  // clearArrival(tbody) }. Adds a resize separator on each RESIZABLE boundary of #headerRow, makes the scroller the
  // shortcut registry's grid root, binds the stream keys, keeps aria-rowcount current, shows the empty states and
  // keeps the arrival highlight's screenful. state() is the legacy shellState(); actions are legacy functions:
  // jumpToEnd, jumpToOldest, togglePause, toggleAutoScroll, updateNewerPill, resetFilter(what).
  function createGrid({ doc, win, dom, ui, keys, prefs, shell, state, actions }) {
    const { setAttr, setText, setHidden } = g.ALV.shellPure;   // shell.js loads first
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
    // All four wait while the grid is hidden (the device cards, the dropzone, loading) or a legacy modal is over it:
    // keys.setModal does not cover the setup guide or the stall modal, which leave focus on the table (Space and F
    // would pause or flip Follow behind the sheet, unseen) and scroll with End and Home.
    const shown = () => !!state().gridShown;
    keys.register({ id: 'stream.latest', keys: ['End', 'Mod+ArrowDown'], when: shown, run: () => actions.jumpToEnd() });
    keys.register({ id: 'stream.oldest', keys: ['Home', 'Mod+ArrowUp'], when: shown, run: () => actions.jumpToOldest() });
    keys.register({ id: 'stream.pause', keys: 'Space', scope: 'grid', when: () => onLive() && shown(), run: () => actions.togglePause() });
    keys.register({ id: 'stream.follow', keys: 'F', scope: 'grid', when: () => onLive() && shown(), run: () => actions.toggleAutoScroll() });
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

    // ---- Empty states (spec): no matches (with the cause and its fix), after Clear, a device streaming but silent.
    // updateNewerPill (once per flush) and sync call this; it writes only when the tile changes and announces only
    // when the state or its cause does (ui.announce: at most once per 5 s). ----
    let emptyKey = null;
    let emptySaid = '';
    let emptyFix = null;
    const fixBtn = $('gridEmptyFix');
    if (fixBtn) fixBtn.addEventListener('click', () => { if (emptyFix) actions.resetFilter(emptyFix); });
    if ($('gridEmptyReset')) $('gridEmptyReset').addEventListener('click', () => actions.resetFilter('all'));
    const focusAt = el => { if (el) el.focus({ preventScroll: true }); };
    function syncEmpty() {
      const st = state();
      const dev = shell.devices();
      const name = p => (dev[p] && dev[p].name) || (p === 'ios' ? 'iPhone' : 'Android device');
      // An open stream whose phone the bridge reported gone (noDevice) is not streaming: the toolbar badge and the
      // sidebar row say the same (#70).
      const open = ['android', 'ios'].filter(p => st.live[p]);
      const waiting = open.filter(p => !st.noDevice[p]).map(name);
      const gone = open.filter(p => st.noDevice[p]).map(name);
      const v = emptyView({ kind: st.cur.kind, all: st.cur.all.length, shown: st.cur.filtered.length, stale: !!st.stale, cleared: st.cleared, paused: st.paused,
        levelsOff: st.levels === 0, devicesOff: st.enabled.size === 0, tag: st.tag, query: !!st.query, waiting, gone });
      const key = v ? v.key : '';
      if (key === emptyKey) return;
      emptyKey = key;
      // Hiding the button that has focus would drop it on <body> (updateNewerPill guards the pill the same way): park it
      // on the control that takes over, the Reset filter button when only the fix goes, else the grid showing the lines.
      const active = doc.activeElement;
      if (active && active === fixBtn && !(v && v.fix)) focusAt(v && v.reset ? $('gridEmptyReset') : table);
      else if (active && active === $('gridEmptyReset') && !(v && v.reset)) focusAt(table);
      setHidden($('gridEmpty'), !v);
      if (!v) { emptySaid = ''; return; }
      setAttr($('gridEmptyIcon'), 'class', v.spin ? 'icon spin' : 'icon');
      setAttr($('gridEmptyUse'), 'href', `#i-${v.icon}`);
      setText($('gridEmptyTitle'), v.title);
      setText($('gridEmptyDesc'), v.desc);
      setHidden($('gridEmptyDesc'), !v.desc);
      emptyFix = v.fix;
      setText(fixBtn, v.fixLabel);
      setHidden(fixBtn, !v.fix);
      setHidden($('gridEmptyReset'), !v.reset);
      setHidden($('gridEmptySkel'), !v.skeleton);
      if (v.say !== emptySaid) { emptySaid = v.say; ui.announce(v.say); }
    }

    // ---- aria-rowcount (spec): the shown session's filtered lines plus the header row. Written on shellSync and the
    // shell's tick (twice a second), never from the drain, and only when it changed. The tick also refreshes the
    // paused pill's count (a paused stream runs no flush) and the empty state. ----
    function sync() {
      setAttr(table, 'aria-rowcount', String(state().cur.filtered.length + 1));
      ring();
      actions.updateNewerPill();
      syncEmpty();
    }
    shell.onTick(sync);

    // ---- Arrival highlight (spec "Log grid"): the rows a flush appended while following, while the rows lit within
    // one fade stay within a screenful (arrive). renderLiveTail asks api.arrive(n); the screenful is kept here from the
    // scroller's height (a ResizeObserver) and the row height (log size, density): nothing is measured per flush. A row's is-new class
    // goes when its animation ends; a tbody hidden mid-flight (selectSession) is cleared, or it would replay. ----
    const api = { sync, syncEmpty, screenRows: 0, arrive: arriveRows, clearArrival };
    const budget = { level: 0, at: 0 };
    const clock = () => (win.performance ? win.performance.now() : Date.now());
    // renderLiveTail: may the n rows this flush appends glow? Spends the budget only when it says yes.
    function arriveRows(n) { return arrive(budget, n, clock(), api.screenRows); }
    let viewH = 0;
    function recount() {
      const ps = prefs.state();
      api.screenRows = screenRows(viewH, ps.logFontSize, ps.settings.density);
    }
    if (win.ResizeObserver) new win.ResizeObserver(entries => { viewH = entries[entries.length - 1].contentRect.height; recount(); }).observe(scroller);
    prefs.onChange(recount);
    recount();
    scroller.addEventListener('animationend', e => { if (e.animationName === 'row-in' && e.target.classList) e.target.classList.remove('is-new'); });
    function clearArrival(tbody) { for (const tr of tbody.querySelectorAll('tr.is-new')) tr.classList.remove('is-new'); }
    return api;
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.gridPure = Object.freeze({ timeOf, rowClass, ROW_CLASS, LEVEL_CLASS: Object.freeze(LEVEL_CLASS), RESIZABLE, COL_MIN, COL_MAX, clampCol, resizeKey, pillView, emptyView, rowPx, screenRows, arrive, ARRIVAL_MS });
  ALV.createGrid = createGrid;
})(typeof window !== 'undefined' ? window : globalThis);
