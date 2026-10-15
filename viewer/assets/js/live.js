/* The live view's toolbar and status bar (roadmap P4b; spec "Toolbar", "Status bar"). Classic script,
   loaded after shell.js. ALV.livePure is pure (the tests run it with shell.js in an empty vm context).
   ALV.createLive wires #toolbar and #statusBar to the page; the legacy script calls it once, right after
   createShell, and it refreshes on the shell's tick and on shellSync(). */
(function (g) {
  'use strict';

  const sp = () => g.ALV.shellPure;   // shell.js loads first

  // ---- Pure ----

  // The toolbar's stream badge (spec "Toolbar"). b: { kind: 'live' | 'file', paused, streaming (a device
  // streams), rate (lines/s over every streaming device), buffered (the paused backlog), lines }.
  function streamBadge(b) {
    const { num, fmtRate } = sp();
    if (b.kind === 'file') return { tone: 'idle', pulse: false, text: `File · ${num(b.lines)} lines` };
    if (b.paused) return { tone: 'warn', pulse: false, text: `Paused · ${num(b.buffered)} buffered` };
    if (b.streaming) return { tone: 'ok', pulse: true, text: `Streaming · ${fmtRate(b.rate)}` };
    return { tone: 'idle', pulse: false, text: `Stopped · ${num(b.lines)} lines` };
  }

  // ---- DOM ----

  // createLive({ doc, win, dom, ui, keys, prefs, shell, state, actions }) → { sync(), closeMenus() }. state() is the legacy
  // shellState(); actions are legacy functions: togglePause, toggleAutoScroll, clear, zoom(delta), openFile,
  // setGlass(on).
  function createLive({ doc, ui, keys, prefs, shell, state, actions }) {
    const { setText, setAttr, setHidden } = sp();
    const $ = id => doc.getElementById(id);
    const onClick = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    const tip = (id, o) => ($(id) ? ui.tooltip($(id), o) : null);
    const usable = id => $(id).getAttribute('aria-disabled') !== 'true';

    // ---- Toolbar (spec): Pause, Follow, the log text size group, Export (its legacy controller), More, Clear.
    // Space (Pause) and End (Follow) are bound in P5, and Clear's ⌘⌫ with its Undo in P12: until then their
    // tooltips show no key. ----
    onClick('pauseBtn', () => actions.togglePause());
    onClick('autoScrollBtn', () => actions.toggleAutoScroll());
    onClick('clearBtn', () => actions.clear());
    onClick('zoomOutBtn', () => { if (usable('zoomOutBtn')) actions.zoom(-1); });
    onClick('zoomResetBtn', () => actions.zoom(0));
    onClick('zoomInBtn', () => { if (usable('zoomInBtn')) actions.zoom(1); });
    const pauseTip = tip('pauseBtn', { text: 'Pause stream' });
    tip('autoScrollBtn', { text: 'Follow newest lines' });
    // ⌘= / ⌘− / ⌘0 stay on the legacy keydown listener (reserved in keys.js until P13), so they are labels.
    tip('zoomOutBtn', { text: 'Smaller log text', shortcut: { combo: 'Mod+-' } });
    tip('zoomResetBtn', { text: 'Reset', shortcut: { combo: 'Mod+0' } });
    tip('zoomInBtn', { text: 'Larger log text', shortcut: { combo: 'Mod+=' } });
    tip('moreBtn', { text: 'More' });
    tip('clearBtn', { text: 'Clear view' });
    function syncZoom(ps) {
      setText($('zoomResetBtn'), `${ps.logFontSize} px`);
      setAttr($('zoomOutBtn'), 'aria-disabled', ps.logFontSize <= prefs.LOG_FS.min ? 'true' : null);
      setAttr($('zoomInBtn'), 'aria-disabled', ps.logFontSize >= prefs.LOG_FS.max ? 'true' : null);
    }
    prefs.onChange(syncZoom);
    syncZoom(prefs.state());

    // More (spec, interim): "Open log file…" and, on macOS, the Glass material until P14's Settings takes it
    // (parity row "Liquid Glass switch"). Glass is a menuitemcheckbox: choosing it keeps the menu open.
    const mac = prefs.state().platform === 'mac';
    setHidden($('moreGlass'), !mac);
    setHidden($('moreGlassSep'), !mac);
    setText($('moreOpenKbd'), keys.label('session.open'));
    const menus = [];   // the toolbar's and the status bar's menu controllers, for closeMenus()
    if ($('moreBtn')) {
      menus.push(ui.menu($('moreBtn'), $('moreSurface'), {
        onOpen: () => setAttr($('moreGlass'), 'aria-checked', String(prefs.get('material') === 'glass')),
        onSelect: it => {
          const what = it.getAttribute('data-act');
          if (what === 'open') actions.openFile();
          else if (what === 'glass') actions.setGlass(it.getAttribute('aria-checked') === 'true');
        },
      }));
    }

    function syncToolbar(st) {
      const dev = shell.devices();
      const rate = ['android', 'ios'].reduce((sum, p) => sum + (st.live[p] && dev[p] ? dev[p].rate : 0), 0);
      const b = streamBadge({ kind: st.cur.kind, paused: st.paused, streaming: st.live.android || st.live.ios, rate, buffered: st.buffered, lines: st.cur.all.length });
      setText($('sessionTitle'), st.cur.name);
      setAttr($('streamBadge'), 'class', `badge status-${b.tone}`);
      setAttr($('streamDot'), 'class', b.pulse ? 'dot pulse' : 'dot');
      setText($('streamBadgeText'), b.text);
      setText($('pauseLabel'), st.paused ? 'Resume' : 'Pause');   // the label carries the state: no aria-pressed
      setAttr($('pauseIcon'), 'href', `#i-${st.paused ? 'play' : 'pause'}`);
      if (pauseTip) pauseTip.setText(st.paused ? 'Resume stream' : 'Pause stream');
      setAttr($('autoScrollBtn'), 'aria-pressed', String(st.cur.follow));
    }

    function sync() { syncToolbar(state()); }
    // The legacy setup and stall modals call this as they open (a stall arrives in a frame, with no press to
    // light-dismiss): #overlayRoot (z 200) would paint an open menu above them. Focus stays where it is.
    function closeMenus() { for (const m of menus) m.close({ restoreFocus: false }); }
    shell.onTick(sync);
    return { sync, closeMenus };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.livePure = Object.freeze({ streamBadge });
  ALV.createLive = createLive;
})(typeof window !== 'undefined' ? window : globalThis);
