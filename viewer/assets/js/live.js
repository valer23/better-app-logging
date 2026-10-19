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

  const lines = n => (n === 1 ? 'line' : 'lines');
  // The filter count (the filter bar until P6's chip row): "47 106 of 48 310 lines".
  function lineCount(shown, all) { return `${sp().num(shown)} of ${sp().num(all)} lines`; }
  // The #45 discard note (the legacy stats wording): what the status bar keeps at its narrow tier, where the
  // plain Retained count gives way. '' when nothing was discarded.
  function retainedNote(discarded, overflowed) {
    if (!discarded) return '';
    return overflowed ? `${sp().num(discarded)} discarded, resume skips to newest` : `${sp().num(discarded)} older discarded`;
  }
  // The status bar's Retained text with the #45 discard note (spec "Status bar"). max is MAX_RETAINED;
  // Infinity (no cap, set from the console) leaves "of …" out.
  function retainedText(n, max, discarded, overflowed) {
    const { num } = sp();
    const head = Number.isFinite(max) ? `Retained ${num(n)} of ${num(max)}` : `Retained ${num(n)}`;
    return discarded ? `${head} · ${retainedNote(discarded, overflowed)}` : head;
  }
  // The drops button and its popover (spec "Status bar"). The spec's "the log shows a gap row where it
  // happened" and "Jump to gap" wait for P10's gap rows. rate: the device's rate when the drop was counted.
  function dropsText(n) { return `${sp().num(n)} ${lines(n)} dropped`; }
  function dropDetail(n, name, rate) {
    const at = rate > 0 ? ` at ${sp().fmtRate(rate).slice(0, -2)} lines/s` : '';
    return {
      title: `${sp().num(n)} ${lines(n)} dropped from ${name}`,
      desc: `The viewer fell behind${at}, so the bridge dropped the oldest unsent lines. Exports will have the same gap. Resets on Clear.`,
    };
  }
  // A status-bar device button's rate (spec): "842/s", "connecting…", "stalled" or "stopped", then " · quiet"
  // while Quiet system noise filters it (shell.js decides when: QUIET_STATES).
  function deviceRate(state, rate, quiet) {
    const r = state === 'streaming' ? sp().fmtRate(rate) : state === 'connecting' ? 'connecting…' : state === 'stalled' ? 'stalled' : 'stopped';
    return quiet ? `${r} · quiet` : r;
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
      // The name starts with the visible text (WCAG 2.5.3) and tells the size to a screen reader.
      setText($('zoomResetBtn'), `${ps.logFontSize} px`);
      setAttr($('zoomResetBtn'), 'aria-label', `${ps.logFontSize} px, reset log text size to ${prefs.LOG_FS.def} px`);
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
      // A platform streams while its socket is open AND the bridge has not reported the phone gone (noDevice): the row
      // says Disconnected then, so the badge must not stay green on "Streaming · 0/s".
      const on = ['android', 'ios'].filter(p => st.live[p] && !st.noDevice[p]);
      const rate = on.reduce((sum, p) => sum + (dev[p] ? dev[p].rate : 0), 0);
      const b = streamBadge({ kind: st.cur.kind, paused: st.paused, streaming: on.length > 0, rate, buffered: st.buffered, lines: st.cur.all.length });
      setText($('sessionTitle'), st.cur.name);
      setAttr($('streamBadge'), 'class', `badge status-${b.tone}`);
      setAttr($('streamDot'), 'class', b.pulse ? 'dot pulse' : 'dot');
      setText($('streamBadgeText'), b.text);
      setText($('pauseLabel'), st.paused ? 'Resume' : 'Pause');   // the label carries the state: no aria-pressed
      setAttr($('pauseIcon'), 'href', `#i-${st.paused ? 'play' : 'pause'}`);
      if (pauseTip) pauseTip.setText(st.paused ? 'Resume stream' : 'Pause stream');
      setAttr($('autoScrollBtn'), 'aria-pressed', String(st.cur.follow));
    }

    // ---- Status bar (spec): a button per device, the drops button and its popover, then (right) the #58
    // hint and the Retained text that the legacy script writes, and Following. ----
    const PLAT = [['android', 'sbAndroid'], ['ios', 'sbIos']];
    for (const [p, id] of PLAT) onClick(id, () => actions.togglePlatform(p));
    const dropsCtl = $('dropsBtn') ? ui.popover($('dropsBtn'), $('dropsPopover'), { side: 'top', align: 'start' }) : null;
    if (dropsCtl) menus.push(dropsCtl);   // closeMenus() closes it too
    const dropSeen = { android: 0, ios: 0 };
    const dropRate = { android: 0, ios: 0 };
    // Spec: Following / Not following has a tooltip that carries the Retained text.
    const followTip = $('followState') ? ui.tooltip($('followState'), { text: '' }) : null;
    let followTipText = '';
    function syncStatus(st) {
      const dev = shell.devices();
      let total = 0;
      let grew = false;   // a per-platform block of the drops popover appeared or went away
      for (const [p, id] of PLAT) {
        const d = dev[p] || { state: 'disconnected', rate: 0, name: '' };
        setText($(`${id}Name`), d.name);
        setText($(`${id}Rate`), deviceRate(d.state, d.rate, !!d.quiet));
        setAttr($(id), 'data-state', d.state);
        setAttr($(id), 'aria-pressed', String(st.enabled.has(p)));
        const n = st.dropped[p];
        if (n > dropSeen[p]) dropRate[p] = d.rate;   // the rate when this platform last dropped lines
        else if (n < dropSeen[p]) dropRate[p] = 0;   // Clear
        dropSeen[p] = n;
        total += n;
        const box = p === 'android' ? 'dropsAndroid' : 'dropsIos';
        if ($(box) && $(box).hidden !== (n === 0)) grew = true;
        setHidden($(box), n === 0);
        if (n) {
          const detail = dropDetail(n, d.name, dropRate[p]);
          setText($(`${box}Title`), detail.title);
          setText($(`${box}Desc`), detail.desc);
        }
      }
      setText($('dropsText'), dropsText(total));
      setHidden($('dropsBtn'), total === 0);
      // No drops left: close. Otherwise: ui.popup places a surface on open and on resize only, and side 'top'
      // fixes its top edge from the height at that moment, so a block that appears while it is open would grow
      // it down over #dropsBtn and out of the window. One layout read per change of a block, never per tick
      // (reposition() is a no-op while closed).
      if (dropsCtl) {
        if (!total) dropsCtl.close({ restoreFocus: false });
        else if (grew) dropsCtl.reposition();
      }
      const showFollow = st.cur.kind === 'live';
      setHidden($('followState'), !showFollow);
      setAttr($('followState'), 'data-on', String(!!st.cur.follow));
      setText($('followText'), st.cur.follow ? 'Following' : 'Not following');
      const kept = showFollow ? retainedText(st.cur.all.length, st.maxRetained, st.cur.discarded, st.cur.overflowed) : '';
      if (followTip && kept !== followTipText) { followTipText = kept; followTip.setText(kept); }
    }

    function sync() { const st = state(); syncToolbar(st); syncStatus(st); }
    // The legacy setup and stall modals call this as they open (a stall arrives in a frame, with no press to
    // light-dismiss): #overlayRoot (z 200) would paint an open menu above them. Focus stays where it is.
    function closeMenus() { for (const m of menus) m.close({ restoreFocus: false }); }
    shell.onTick(sync);
    // ⌘B and the toggle move the status bar's left group (248 px sidebar <-> 52 px rail) while a non-modal popover
    // may be open on its button; ui.popup places a surface on open and on resize only. (reposition() is a
    // no-op while closed; the toolbar's controls are right-anchored and the menus there do not move.)
    shell.onSidebar(() => { if (dropsCtl) dropsCtl.reposition(); });
    return { sync, closeMenus };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.livePure = Object.freeze({ streamBadge, lineCount, retainedText, retainedNote, dropsText, dropDetail, deviceRate });
  ALV.createLive = createLive;
})(typeof window !== 'undefined' ? window : globalThis);
