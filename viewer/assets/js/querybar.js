/* The query region (roadmap P6b; spec "Query region", "Query grammar"). Classic script, loaded after grid.js.
   ALV.queryBarPure is pure: the level chips' accessible names. ALV.createQueryBar wires #filterbar, once, from the legacy
   script after createGrid: the query bar (Aa, .*, Clear filter, the ⌘F hint, the invalid line), the level and device
   chips, the line count and Reset. The bar owns the query text and the Aa / .* modes and applies them through
   actions.setQuery (the legacy script compiles and refilters); what the chips show is read back from the applied query
   (state().filter), so chips and text are one model. Nothing here runs per line or per flush: the numbers refresh on a
   250 ms interval and are written only when they changed. */
(function (g) {
  'use strict';

  const LEVEL_NAMES = Object.freeze(['Verbose', 'Debug', 'Info', 'Warning', 'Error', 'Fatal']);
  const LETTERS = 'VDIWEF';
  const LEVEL_CLASS = Object.freeze(['lv-v', 'lv-d', 'lv-i', 'lv-w', 'lv-e', 'lv-f']);
  // [platform, query bit, badge letter, badge class, name while no device is known] (the status bar's fallbacks).
  const DEVICES = Object.freeze([['android', 1, 'A', 'plat plat-a', 'Android device'], ['ios', 2, 'i', 'plat plat-i', 'iPhone']]);
  const DEBOUNCE_MS = 100;   // spec "Performance": typing re-filters after about 100 ms of quiet
  const NUMBERS_MS = 250;    // visible numbers: at most 4 times a second, by interval (never rAF, never per flush)

  // ---- Pure ----

  const plural = n => (n === 1 ? 'line' : 'lines');
  // A level chip's accessible name (spec): "Verbose, 12 950 lines".
  function levelLabel(k, n) { return `${LEVEL_NAMES[k]}, ${g.ALV.shellPure.num(n)} ${plural(n)}`; }

  // ---- DOM ----

  // createQueryBar({ doc, win, dom, ui, keys, shell, state, actions }) → { sync(), numbers(), apply(), text(), focus(),
  // toggleLevel(k), toggleDevice(platform), reset(), fix(what) }. state() is the legacy shellState() (cur, filter: the
  // applied compiled query, devices, tag); actions are legacy functions: setQuery(text, opts) → error | null, and sync()
  // (shellSync: the sidebar rows and the status bar read the applied query too).
  function createQueryBar({ doc, win, dom, ui, keys, shell, state, actions }) {
    const { num, setText, setAttr, setHidden } = g.ALV.shellPure;
    const Q = g.ALV.query;
    const lineCount = g.ALV.livePure.lineCount;
    const $ = id => doc.getElementById(id);
    const box = $('queryBox');
    const input = $('queryInput');
    const caseBtn = $('queryCaseBtn');
    const regexBtn = $('queryRegexBtn');
    const clearBtn = $('queryClearBtn');
    const kbd = $('queryKbd');
    const resetBtn = $('queryResetBtn');
    let mc = false;   // Aa
    let rx = false;   // .*
    let pending = 0;  // the debounce's generation: a timer that is not the newest does nothing
    let applied = ''; // the text of the filter applied last
    const opts = () => ({ case: mc, regex: rx });

    // Applies the text now (a chip, a toggle, Clear, Reset, the end of the debounce). An invalid query keeps the last
    // valid filter (setQuery leaves it alone) and says why under the bar, in a role="alert" line written only when the
    // message changes. A filter change announces the new count (ui.announce: at most once per 5 s).
    function apply() {
      pending++;
      const before = state().filter;
      const err = actions.setQuery(input.value, opts());
      if (!err) applied = input.value;
      box.classList.toggle('invalid', !!err);
      setAttr(input, 'aria-invalid', err ? 'true' : null);
      setText($('queryErrorText'), err ? err.msg : '');
      setHidden($('queryError'), !err);
      actions.sync();
      const st = state();
      if (st.filter !== before) ui.announce(lineCount(st.cur.filtered.length, st.cur.all.length));
    }
    // Writes `text` into the bar and applies it at once.
    function rewrite(text) { input.value = text; apply(); }
    // What a chip, row or tile fix rewrites: the bar's text when it compiles, else the last applied text (the invalid edit is dropped, so the fix always applies).
    function base() { return Q.build(input.value, opts(), state().devices).q ? input.value : applied; }
    function current() { return Q.build(base(), opts(), state().devices).q || state().filter; }
    function toggleLevel(k) { rewrite(Q.setLevels(base(), current().levels ^ (1 << k))); }
    function toggleDevice(p) { rewrite(Q.setDevices(base(), current().plats ^ (p === 'ios' ? 2 : 1))); }
    function reset() { rewrite(''); }

    input.addEventListener('input', () => {
      const id = ++pending;
      win.setTimeout(() => { if (id === pending) apply(); }, DEBOUNCE_MS);
      syncBar();
    });
    input.addEventListener('focus', syncBar);
    input.addEventListener('blur', syncBar);
    caseBtn.addEventListener('click', () => { mc = !mc; apply(); });
    regexBtn.addEventListener('click', () => { rx = !rx; apply(); });
    // Clear filter and Reset hide with the text: focus goes to the field, not to <body>.
    for (const b of [clearBtn, resetBtn]) b.addEventListener('click', () => { reset(); input.focus(); });
    ui.tooltip(caseBtn, { text: 'Match case', shortcut: 'filter.case', describe: false });
    ui.tooltip(regexBtn, { text: 'Treat text as regex', shortcut: 'filter.regex', describe: false });
    ui.tooltip(resetBtn, { text: 'Reset filter', shortcut: 'filter.reset' });

    // ---- Level and device chips (spec "Chip row"). Pressed = shown, read back from the applied query. ----
    const levels = LEVEL_NAMES.map((name, k) => {
      const count = dom.el('span', { class: 'count', 'aria-hidden': 'true' });
      const b = dom.el('button', { type: 'button', class: `chip ${LEVEL_CLASS[k]}`, 'aria-pressed': 'true', 'aria-label': levelLabel(k, 0) },
        dom.el('span', { class: `lv-badge ${LEVEL_CLASS[k]}`, 'aria-hidden': 'true', text: LETTERS[k] }),
        dom.el('span', { class: 'lv-name', 'aria-hidden': 'true', text: name }), count);
      b.addEventListener('click', () => toggleLevel(k));
      // The name is refreshed when the chip gets focus, never while it has it: a screen reader would read it again.
      b.addEventListener('focus', () => { if (!state().stale) setAttr(b, 'aria-label', levelLabel(k, state().cur.counts.lvl[k])); });
      ui.tooltip(b, { text: name, shortcut: `filter.level.${LETTERS[k]}`, describe: false });
      $('levelChips').appendChild(b);
      return { b, count };
    });
    const devices = DEVICES.map(([p, , badge, cls]) => {
      const name = dom.el('span', { class: 'dev-name' });
      const b = dom.el('button', { type: 'button', class: 'chip dev', 'aria-pressed': 'true' }, dom.el('span', { class: cls, 'aria-hidden': 'true', text: badge }), name);
      b.addEventListener('click', () => toggleDevice(p));
      $('deviceChips').appendChild(b);
      return { b, name };
    });

    function syncBar() {
      const has = input.value !== '';
      setHidden(clearBtn, !has);
      setHidden(resetBtn, !has);
      const k = keys.label('filter.focus');
      setText(kbd, k);
      setHidden(kbd, !k || has || doc.activeElement === input);   // spec: only while the bar is unfocused and empty
    }
    // "47 106 of 48 310 lines" and the level chips' counts: on the 250 ms interval and on sync. A stale session (a file
    // just opened, before its first refilter) has no level counts yet: unknown, not 0, so nothing is written until then.
    function numbers() {
      const st = state();
      if (st.stale) return;
      const s = st.cur;
      const lv = s.counts.lvl;
      levels.forEach(({ b, count }, k) => {
        setText(count, num(lv[k]));
        if (doc.activeElement !== b) setAttr(b, 'aria-label', levelLabel(k, lv[k]));
      });
      setText($('filterCount'), lineCount(s.filtered.length, s.all.length));
    }
    // The chips' pressed state, the device names, the toggles and the bar: on sync and on the shell's tick (twice a second).
    // No number is written here: the 250 ms interval owns them.
    function syncChips() {
      // A dev: name (dev:pixel) is resolved against the devices known when it compiled: when they change, the applied text
      // compiles to another filter, which setQuery applies (an equal one costs a parse; only while such a token is in use).
      if (state().filter.usesDevNames) actions.setQuery(applied, opts());
      const q = state().filter;
      levels.forEach(({ b }, k) => setAttr(b, 'aria-pressed', String((q.levels & (1 << k)) !== 0)));
      const dev = shell.devices();
      DEVICES.forEach(([p, bit, , , fallback], i) => {
        setAttr(devices[i].b, 'aria-pressed', String((q.plats & bit) !== 0));
        setText(devices[i].name, (dev[p] && dev[p].name) || fallback);
      });
      setAttr(caseBtn, 'aria-pressed', String(mc));
      setAttr(regexBtn, 'aria-pressed', String(rx));
      syncBar();
    }
    // A filter change or shellSync: everything, the numbers at once.
    function sync() { syncChips(); numbers(); }
    win.setInterval(() => { if (!doc.hidden) numbers(); }, NUMBERS_MS);
    shell.onTick(syncChips);

    // The empty tile's fixes (grid.js): 'levels' turns every level back on, 'devices' shows both, 'tag' removes the tag
    // the tile names (state().tag), 'all' (Reset filter) empties the query.
    function fix(what) {
      if (what === 'all') return reset();
      if (what === 'levels') return rewrite(Q.setLevels(base(), 63));
      if (what === 'devices') return rewrite(Q.setDevices(base(), 3));
      const i = Q.indexOf(base(), { k: 'tag', v: state().tag, neg: false });
      if (i >= 0) rewrite(Q.removeToken(base(), i));
      return undefined;
    }

    sync();
    return {
      sync, numbers, apply, toggleLevel, toggleDevice, reset, fix,
      text: () => input.value,
      focus() { input.focus(); if (input.select) input.select(); },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.queryBarPure = Object.freeze({ levelLabel, LEVEL_NAMES, DEBOUNCE_MS, NUMBERS_MS });
  ALV.createQueryBar = createQueryBar;
})(typeof window !== 'undefined' ? window : globalThis);
