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
  // A token chip's parts (spec "Active filters"): the key in --text-2 ('tag:', none for text), the value, and the name its
  // remove button reads: "NOT tag:chatty", "\"time out\"", "/a b/".
  function chipName(t) {
    const k = t.k === 'word' || t.k === 'phrase' || t.k === 'regex' ? '' : `${t.k}:`;
    const v = t.k === 'phrase' ? `"${t.v}"` : t.k === 'regex' ? `/${t.v}/` : t.v;
    return { k, v, full: `${t.neg ? 'NOT ' : ''}${k}${v}` };
  }

  // ---- DOM ----

  // createQueryBar({ doc, win, dom, ui, keys, shell, state, actions }) → { sync(), numbers(), apply(), text(), focus(),
  // toggleLevel(k), toggleDevice(platform), reset(), fix(what), closeMenus() }. state() is the legacy shellState() (cur, filter: the
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
    let appliedOpts = { case: false, regex: false }; // and the Aa / .* modes it compiled under: the text means nothing without them
    const opts = () => ({ case: mc, regex: rx });

    // Applies the text now (a chip, a toggle, Clear, Reset, the end of the debounce). An invalid query keeps the last
    // valid filter (setQuery leaves it alone) and says why under the bar, in a role="alert" line written only when the
    // message changes. A filter change announces the new count (ui.announce: at most once per 5 s).
    function apply() {
      pending++;
      const before = state().filter;
      const err = actions.setQuery(input.value, opts());
      if (!err) { applied = input.value; appliedOpts = opts(); }
      box.classList.toggle('invalid', !!err);
      setAttr(input, 'aria-invalid', err ? 'true' : null);
      setText($('queryErrorText'), err ? err.msg : '');
      setHidden($('queryError'), !err);
      if (!err) drawTokens(input.value);
      actions.sync();
      const st = state();
      if (st.filter !== before) ui.announce(lineCount(st.cur.filtered.length, st.cur.all.length));
    }
    // Writes `text` into the bar and applies it at once.
    function rewrite(text) { input.value = text; apply(); }
    // What a chip, row or tile fix rewrites: the bar's text when it compiles, else the last applied text (the invalid edit is dropped, so the fix always applies).
    // The text and the modes it compiles under travel together: the bar's text with the modes now on, or the applied text with the modes it was applied under.
    function basis() { return Q.build(input.value, opts(), state().devices).q ? { text: input.value, o: opts() } : { text: applied, o: appliedOpts }; }
    function base() { return basis().text; }
    function current() { const b = basis(); return Q.build(b.text, b.o, state().devices).q || state().filter; }
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

    // ---- Token chips (spec "Active filters"): one token is a chip with its own 24 px ×; two or more collapse into one
    // "N filters" chip whose popover lists each with its own remove button. A chip's body puts the caret at the end of its
    // token in the field (Open item 6). Drawn from the applied text, again only when its tokens change; a click finds its
    // token in the field's text as it is now (the user may have typed since). Text only: chipName's parts go into Text nodes. ----
    const CHIP_KEYS = new Set(['level', 'dev', 'plat']);
    const more = $('tokenMore');
    const pop = ui.popover(more, $('tokenPop'), { align: 'start' });
    let drawn = null;
    function tokenChip(t, tag) {
      const name = chipName(t);
      const body = dom.el('button', { type: 'button', class: 'chip-body', title: name.full },
        t.neg ? dom.el('span', { class: 'not', text: 'NOT' }) : null, name.k ? dom.el('span', { class: 'k', text: name.k }) : null, dom.el('span', { class: 'v', text: name.v }));
      body.addEventListener('click', () => caretOn(t));
      const x = dom.el('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove filter ${name.full}` }, dom.icon('x'));
      x.addEventListener('click', () => removeChip(t));
      return dom.el(tag, { class: t.neg ? 'chip token neg' : 'chip token' }, body, x);
    }
    function caretOn(t) {
      pop.close({ restoreFocus: false });
      const tok = Q.parse(input.value).tokens[Q.indexOf(input.value, t)];
      input.focus();
      if (tok && input.setSelectionRange) input.setSelectionRange(tok.end, tok.end);
    }
    function removeChip(t) {
      pop.close({ restoreFocus: false });
      const b = base();   // the field's text when it compiles, else the last applied text: an invalid edit never blocks a chip (must-keep 3)
      const i = Q.indexOf(b, t);
      if (i >= 0) rewrite(Q.removeToken(b, i));
      input.focus();   // the chip is gone
    }
    function drawTokens(text) {
      const toks = Q.parse(text).tokens.filter(t => !CHIP_KEYS.has(t.k));
      const key = Q.serialize(toks);
      if (key === drawn) return;
      drawn = key;
      for (const box of [$('tokenOne'), $('tokenList')]) for (const c of Array.from(box.children)) c.remove();
      setHidden($('tokenDiv'), !toks.length);
      setHidden($('tokenChips'), !toks.length);
      setHidden(more, toks.length < 2);
      if (toks.length < 2) pop.close({ restoreFocus: false });
      if (toks.length === 1) $('tokenOne').appendChild(tokenChip(toks[0], 'span'));
      if (toks.length > 1) {
        setText($('tokenMoreText'), `${toks.length} filters`);
        for (const t of toks) $('tokenList').appendChild(tokenChip(t, 'div'));
      }
    }

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
      if (state().filter.usesDevNames) actions.setQuery(applied, appliedOpts);
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

    // ---- Keys (spec "Keyboard map", Filter): ⌘F (in a text field too) and /† focus the bar and select its text; ⌥C and
    // ⌥R toggle Aa and .*; ⌥V … ⌥F toggle a level chip; ⇧⌘F resets. In a text field macOS Option types a character, so
    // there the ⌥ keys do nothing (keys.js) and the buttons remain; Windows Alt works in the field too. ----
    function focus() { input.focus(); if (input.select) input.select(); }
    keys.register({ id: 'filter.focus', keys: 'Mod+F', inText: true, run: focus });
    keys.register({ id: 'filter.slash', keys: '/', scope: 'grid', run: focus });
    keys.register({ id: 'filter.case', keys: 'Alt+C', inText: true, run: () => caseBtn.click() });
    keys.register({ id: 'filter.regex', keys: 'Alt+R', inText: true, run: () => regexBtn.click() });
    [...LETTERS].forEach((L, k) => keys.register({ id: `filter.level.${L}`, keys: `Alt+${L}`, inText: true, run: () => toggleLevel(k) }));
    // Reset hides the controls it was pressed from (Reset, Clear, the token chips, "N filters" and its popover): when focus is
    // inside the region it moves to the field, as the click path does; focus elsewhere (the grid, another field) stays put.
    keys.register({
      id: 'filter.reset', keys: 'Shift+Mod+F', inText: true,
      run: () => {
        const a = doc.activeElement;
        const inside = !!a && a !== input && ($('filterbar').contains(a) || $('tokenPop').contains(a));
        reset();
        if (inside) input.focus();
      },
    });
    setAttr(input, 'aria-keyshortcuts', `${keys.aria('filter.focus')} ${keys.aria('filter.slash')}`);
    setAttr(caseBtn, 'aria-keyshortcuts', keys.aria('filter.case'));
    setAttr(regexBtn, 'aria-keyshortcuts', keys.aria('filter.regex'));
    setAttr(resetBtn, 'aria-keyshortcuts', keys.aria('filter.reset'));
    levels.forEach(({ b }, k) => setAttr(b, 'aria-keyshortcuts', keys.aria(`filter.level.${LETTERS[k]}`)));

    drawTokens('');
    sync();
    return {
      sync, numbers, apply, toggleLevel, toggleDevice, reset, fix,
      text: () => input.value,
      focus,
      // A legacy modal is about to open over the page: the popover lives in #overlayRoot (z 200), above it.
      closeMenus() { pop.close({ restoreFocus: false }); },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.queryBarPure = Object.freeze({ levelLabel, chipName, LEVEL_NAMES, DEBOUNCE_MS, NUMBERS_MS });
  ALV.createQueryBar = createQueryBar;
})(typeof window !== 'undefined' ? window : globalThis);
