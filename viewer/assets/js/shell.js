/* App shell (roadmap P4; spec "Window frame and sidebar", "Status bar", "Window chrome (Tauri)"). Classic
   script. ALV.shellPure is pure, so the tests run it in an empty vm context: the number and rate formats,
   the per-platform rate meter, the device status line and the theme button. ALV.createShell wires the
   sidebar and the drag bands to the page; the legacy script calls it once and passes what it reads. */
(function (g) {
  'use strict';

  // ---- Pure ----

  // 48310 → "48 310" with a thin space (spec conventions). Rounds; negative or not a number → '0'.
  function num(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  // Lines per second as the spec writes them: 842/s, 1.9k/s, 27k/s.
  function fmtRate(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v < 999.5) return `${Math.round(v)}/s`;
    if (v < 9950) return `${(v / 1000).toFixed(1)}k/s`;
    return `${Math.round(v / 1000)}k/s`;
  }

  // Log lines per second per platform from cumulative counters sampled by a timer: measured from the newest
  // sample at least `windowMs` old (or the oldest kept), so a rate settles within a window.
  function createRateMeter(windowMs = 1000) {
    const samples = [];
    return {
      sample(t, counts) {
        samples.push({ t, android: counts.android, ios: counts.ios });
        while (samples.length > 2 && t - samples[1].t >= windowMs) samples.shift();
        const a = samples[0];
        const b = samples[samples.length - 1];
        const dt = b.t - a.t;
        if (!(dt > 0)) return { android: 0, ios: 0 };
        return { android: (b.android - a.android) * 1000 / dt, ios: (b.ios - a.ios) * 1000 / dt };
      },
    };
  }

  // The status line of a sidebar device row (spec "Window frame and sidebar"), in spec copy.
  // s: { live, state, text (setStatus), detected, driverMissing, stalledFor (the stall threshold in s, or -1), rate, dropped }
  // → { state: the shape the row shows, tone, text, drops: the second line or '' }
  function deviceStatus(s) {
    let state;
    let tone;
    let text;
    if (s.live && s.stalledFor >= 0) { state = 'stalled'; tone = 'warn'; text = `Stalled ${Math.round(s.stalledFor)} s`; }
    else if (s.live) { state = 'streaming'; tone = 'ok'; text = `Streaming · ${fmtRate(s.rate)}`; }
    else if (s.state === 'connecting') { state = 'connecting'; tone = 'info'; text = 'Connecting…'; }
    else if (s.state === 'error') { state = 'error'; tone = 'err'; text = s.text || 'Error'; }
    else if (s.driverMissing) { state = 'driver'; tone = 'err'; text = 'Driver missing'; }
    else if (s.detected) { state = 'ready'; tone = 'idle'; text = 'Ready · stopped'; }
    else { state = 'disconnected'; tone = 'idle'; text = 'Disconnected'; }
    return { state, tone, text, drops: s.dropped > 0 ? `${num(s.dropped)} dropped` : '' };
  }

  // The sidebar footer's theme button (spec): the chosen theme's icon, aria-label "Theme: Dark. Switch to
  // Light", tooltip "Theme: Dark" or "Theme: System (Dark)". resolved: what System shows now; next: the
  // theme a click picks (ALV.prefs.nextTheme).
  const THEME_NAME = { dark: 'Dark', light: 'Light', system: 'System' };
  const THEME_ICON = { dark: 'moon', light: 'sun', system: 'monitor' };
  function themeView(theme, resolved, next) {
    const name = THEME_NAME[theme] || THEME_NAME.dark;
    return {
      icon: THEME_ICON[theme] || THEME_ICON.dark,
      label: `Theme: ${name}. Switch to ${THEME_NAME[next] || THEME_NAME.dark}`,
      tip: theme === 'system' ? `Theme: System (${THEME_NAME[resolved] || THEME_NAME.dark})` : `Theme: ${name}`,
    };
  }

  // ---- DOM ----

  // The window drag bands (spec "Window chrome (Tauri)"). The page is served by axum on :8780, where
  // data-tauri-drag-region does not work, and CSS app-region needs a Tauri feature flag we do not enable,
  // so drag is wired by hand: a press on a band's background arms, 4 px of movement calls startDragging(),
  // and a double-click on the background toggles maximise. Arming on movement keeps double-clicks working:
  // starting the OS drag on the first press would swallow the second click. A press on anything matching
  // ALV.dom.INTERACTIVE never drags. Every control in a band is static markup, so the drag lint in
  // tests/viewer/static.test.mjs (which reads this literal) covers it.
  const DRAG_BANDS = ['sidebarHeader', 'toolbar'];
  const DRAG_THRESHOLD_PX = 4;

  // The iOS bridge calls a stream stalled after this many seconds of silence (STREAM_STALL_TIMEOUT_SECS in
  // src-tauri/src/bridge/ios.rs). The row says exactly this: spec "Stalled 15 s", not a running timer.
  const STALL_SECONDS = 15;
  const TICK_MS = 500;   // the counts and rates refresh twice a second (spec: at most 4 times), off the drain

  // Diffed writes for the shell and the status bar (live.js): they refresh twice a second, so an unchanged
  // text, attribute or hidden flag is never written again. null removes the attribute.
  function setText(node, s) { if (node && node._shellText !== s) { node._shellText = s; node.textContent = s; } }
  function setAttr(node, k, v) {
    if (!node) return;
    if (v === null) { if (node.getAttribute(k) !== null) node.removeAttribute(k); } else if (node.getAttribute(k) !== v) node.setAttribute(k, v);
  }
  function setHidden(node, h) { if (node && node.hidden !== h) node.hidden = h; }

  const PLATFORMS = ['android', 'ios'];
  const PLATFORM = {
    android: { badge: 'A', cls: 'plat plat-a', fallback: 'Android device' },
    ios: { badge: 'i', cls: 'plat plat-i', fallback: 'iPhone' },
  };

  // createShell({ doc, win, dom, ui, keys, prefs, state, actions, now }) → { sync(), markStalled(platform), closeMenus() }.
  // Called once, by the legacy script, before its first selectSession. state() returns what the shell shows
  // (the legacy shellState()); actions are the legacy functions it calls. Without `state` only the drag
  // bands are wired (the drag tests).
  function createShell({ doc, win, dom, ui, keys, prefs, state, actions, now = () => win.performance.now() }) {
    const warn = (msg, err) => { if (g.console) g.console.warn(msg, err); };
    const $ = id => doc.getElementById(id);
    // window.__TAURI__ exists only in the app (withGlobalTauri); a browser tab has nothing to drag.
    function windowCall(name) {
      const t = win.__TAURI__;
      if (!t || !t.window) return;
      try { t.window.getCurrentWindow()[name](); } catch (err) { warn(`${name} failed`, err); }
    }
    let armed = null;   // { x, y } of the press while a drag is pending
    function initDragBand(el) {
      if (!el) return;
      el.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest(dom.INTERACTIVE) || e.detail >= 2) return;   // detail 2: a double-click's second press
        armed = { x: e.clientX, y: e.clientY };
      });
      el.addEventListener('dblclick', e => {
        if (e.target.closest(dom.INTERACTIVE)) return;
        armed = null;
        windowCall('toggleMaximize');
      });
    }
    win.addEventListener('mousemove', e => {
      if (!armed) return;
      if (Math.abs(e.clientX - armed.x) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - armed.y) < DRAG_THRESHOLD_PX) return;
      armed = null;
      windowCall('startDragging');
    });
    win.addEventListener('mouseup', () => { armed = null; });
    for (const id of DRAG_BANDS) initDragBand(doc.getElementById(id));
    if (!state) return { sync() {} };

    // ---- Section headers: each folds its list ----
    for (const head of [$('devHead'), $('sessHead')]) {
      if (!head) continue;
      head.addEventListener('click', () => {
        const open = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', String(open));
        setHidden($(head.getAttribute('aria-controls')), !open);
      });
    }

    // ---- The collapsed rail (⌘B). prefs keeps it (data-sidebar on <html>); a rail item's tooltip shows only
    // while collapsed, on the right (spec). ----
    const rail = () => prefs.get('sidebar') === 'collapsed';
    const railTip = (el, text) => (el ? ui.tooltip(el, { text, side: 'right', when: rail }) : null);
    const toggle = $('sidebarToggle');
    const toggleSidebar = () => prefs.set('sidebar', rail() ? 'expanded' : 'collapsed');
    // Not over the legacy setup or stall modal (the rule ⌘E and ⌘O follow): collapsing moves focus to the
    // toggle behind the modal.
    const modalOpen = () => !!doc.querySelector('.modal-overlay.visible');
    keys.register({ id: 'view.sidebar', keys: 'Mod+B', inText: true, when: () => !modalOpen(), run: toggleSidebar });
    const toggleTip = toggle ? ui.tooltip(toggle, { text: 'Hide sidebar', shortcut: 'view.sidebar' }) : null;
    if (toggle) toggle.addEventListener('click', toggleSidebar);
    railTip($('cmdTrigger'), 'Search actions');
    railTip($('sessLive'), 'Live session');
    // The DEVICES rows by platform (filled below). Declared here: syncSidebar runs now, at creation.
    const rows = {};
    function syncSidebar() {
      const collapsed = rail();
      const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
      setAttr(toggle, 'aria-label', label);
      setAttr(toggle, 'aria-expanded', String(!collapsed));
      if (toggleTip) toggleTip.setText(label);
      if (!collapsed) return;
      // Focus on something the rail hides (a row's Start/Stop or More, or its open menu) would be lost: it
      // goes to the toggle (one element, never moved), and a row menu anchored to a hidden More closes.
      const f = doc.activeElement;
      const inRowMenu = PLATFORMS.some(p => rows[p] && f && rows[p].surface.contains(f));
      for (const p of PLATFORMS) if (rows[p]) rows[p].menu.close({ restoreFocus: false });
      const hidden = f && $('sidebar') && $('sidebar').contains(f) && f.closest('[data-rail-hide], .side-sec-h, .dev-actions');
      if (toggle && (inRowMenu || hidden)) toggle.focus();
    }
    prefs.onChange(syncSidebar);
    syncSidebar();

    // ---- SESSIONS: "Live session" first, the opened file, "Open log file…" (spec) ----
    keys.register({ id: 'session.open', keys: 'Mod+O', inText: true, run: () => actions.openFile() });
    setText($('openFileKbd'), keys.label('session.open'));
    const onClick = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    onClick('sessLive', () => actions.selectSession(state().sessions[0]));
    onClick('sessFile', () => actions.selectSession(state().sessions[1]));
    onClick('openFileBtn', () => actions.openFile());
    function syncSessions(st) {
      const [live, file] = st.sessions;
      const showFile = file.all.length > 0 || st.cur === file;   // an empty file session is listed while shown (dropzone)
      setAttr($('sessLive'), 'aria-current', st.cur === live ? 'page' : null);
      setAttr($('sessFile'), 'aria-current', st.cur === file ? 'page' : null);
      setText($('sessLiveCount'), num(live.all.length));
      setText($('sessFileCount'), num(file.all.length));
      setText($('sessFileName'), file.name);
      setHidden($('sessFileItem'), !showFile);
      setText($('sessCount'), showFile ? '2' : '1');
    }

    // ---- DEVICES: one row per platform's device (spec). The backend streams one device per platform, so
    // the row is the device the platform's picker holds; a new device gets a new row (key: platform, id and
    // name), and the old row's menu and tooltips are destroyed with it. ----
    const deviceList = $('deviceList');
    const meter = createRateMeter(1000);
    let rates = { android: 0, ios: 0 };
    // The log-line counter as the last tick (or markStalled) saw it. A stall ends only when it moves: devices,
    // error and dropped frames are not lines (the bridge respawns idevicesyslog after a stall, and the
    // respawn's "[connected:UDID]" arrives as a devices frame while the stream is still dead).
    const seen = { android: 0, ios: 0 };
    const stalled = { android: false, ios: false };
    const devState = { android: null, ios: null };   // what each row shows, for the status bar (live.js)
    const tickFns = [];
    function act(p, what) {
      if (what === 'stream') actions.toggleStream(p);
      else if (what === 'repair') actions.repair(p);
      else if (what === 'setup') actions.setup(p);
    }
    function buildRow(p, dev, key) {
      const P = PLATFORM[p];
      const name = dev.name || P.fallback;
      const r = { key, name, tips: [] };
      // The toggle is named by the device alone; the status and drops lines describe it. The rate changes
      // twice a second, and a focused button whose name changed would be re-announced at that pace.
      const nameId = dom.uid('devname');
      const statusId = dom.uid('devstatus');
      const dropsId = dom.uid('devdrops');
      r.status = dom.el('span', { class: 'side-label', id: statusId });
      r.dropsText = dom.el('span');
      r.drops = dom.el('span', { class: 'dev-drops', id: dropsId, hidden: true }, dom.icon('triangle-alert'), r.dropsText);
      r.main = dom.el('button', { type: 'button', class: 'nav-item dev-main', 'aria-labelledby': nameId, 'aria-describedby': `${statusId} ${dropsId}`,
        on: { click: () => actions.togglePlatform(p) } },
        dom.el('span', { class: P.cls, 'aria-hidden': 'true', text: P.badge }),
        dom.el('span', { class: 'dev-text' },
          dom.el('span', { class: 'dev-name side-label', id: nameId, text: name }),
          dom.el('span', { class: 'dev-status' }, dom.el('span', { class: 'dev-dot', 'aria-hidden': 'true' }), r.status),
          r.drops));
      r.startIcon = dom.icon('play');
      r.start = dom.el('button', { type: 'button', class: 'icon-btn sm', on: { click: () => { if (r.start.getAttribute('aria-disabled') !== 'true') act(p, 'stream'); } } }, r.startIcon);
      r.more = dom.el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `More for ${name}` }, dom.icon('ellipsis'));
      r.li = dom.el('li', { class: 'dev-row', dataset: { platform: p } }, r.main, dom.el('span', { class: 'dev-actions' }, r.start, r.more));
      const item = (what, text) => dom.el('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabindex: '-1', dataset: { act: what } }, text);
      r.streamItem = item('stream');
      r.surface = dom.portal(dom.el('div', { class: 'menu ov', hidden: true },
        dom.el('div', { role: 'menu', id: dom.uid('devmenu'), 'aria-label': `More for ${name}` },
          r.streamItem, p === 'ios' ? item('repair', 'Re-pair iPhone') : null, item('setup', 'Setup guide'))), 'popover');
      r.menu = ui.menu(r.more, r.surface, {
        onSelect: it => act(p, it.dataset.act),
        onOpen: () => r.li.setAttribute('data-menu', 'open'),
        onClose: () => r.li.removeAttribute('data-menu'),
      });
      r.startTip = ui.tooltip(r.start, { text: '' });
      r.tips.push(r.startTip, ui.tooltip(r.more, { text: `More for ${name}` }), railTip(r.main, name));
      return r;
    }
    // The old row goes: its menu and tooltips are destroyed, and focus that was in it (or in its open menu)
    // moves to the same control of the new row.
    function dropRow(old, next) {
      const f = doc.activeElement;
      const to = f === old.start ? next.start : f === old.main ? next.main : f === old.more || old.surface.contains(f) ? next.more : null;
      old.menu.destroy();
      for (const t of old.tips) t.destroy();
      old.li.remove();
      if (to) to.focus();
    }
    function stalledFor(p, live) {
      if (!live) stalled[p] = false;
      return stalled[p] ? STALL_SECONDS : -1;
    }
    function syncDevices(st) {
      let detected = 0;
      for (const p of PLATFORMS) {
        const dev = st.devices[p] || { id: '', name: '' };
        if (dev.id) detected += 1;
        const key = `${dev.id}\n${dev.name}`;
        let r = rows[p];
        if (!r || r.key !== key) {
          const next = buildRow(p, dev, key);
          deviceList.insertBefore(next.li, r ? r.li : null);
          if (r) dropRow(r, next);
          rows[p] = r = next;
        }
        const live = !!st.live[p];
        const busy = st.status[p].state === 'connecting';
        const s = deviceStatus({ live, state: st.status[p].state, text: st.status[p].text, detected: !!dev.id,
          driverMissing: p === 'ios' && st.driverMissing, stalledFor: stalledFor(p, live), rate: rates[p], dropped: st.dropped[p] });
        devState[p] = { state: s.state, rate: rates[p], name: r.name };
        setAttr(r.li, 'data-state', s.state);
        setAttr(r.li, 'data-tone', s.tone);
        setText(r.status, s.text);
        setText(r.dropsText, s.drops);
        setHidden(r.drops, !s.drops);
        const on = st.enabled.has(p);
        setAttr(r.main, 'aria-pressed', String(on));
        setAttr(r.main, 'aria-current', on && st.enabled.size === 1 ? 'true' : null);
        const verb = live ? 'Stop streaming' : 'Start streaming';
        setAttr(r.start, 'aria-label', `${verb} ${r.name}`);
        setAttr(r.start, 'aria-disabled', busy ? 'true' : null);
        setAttr(r.streamItem, 'aria-disabled', busy ? 'true' : null);
        r.startTip.setText(`${verb} ${r.name}`);
        setAttr(r.startIcon.children[0], 'href', `#i-${live ? 'square' : 'play'}`);
        setText(r.streamItem, verb);
      }
      setText($('devCount'), String(detected));
    }

    // ---- Footer: Settings and Keyboard shortcuts wait for P14 and P13; the theme cycle (spec) ----
    for (const [id, text] of [['settingsBtn', 'Settings'], ['shortcutsBtn', 'Keyboard shortcuts']]) if ($(id)) ui.tooltip($(id), { text, side: 'right' });
    const themeBtn = $('themeBtn');
    const cycleTheme = () => prefs.set('theme', prefs.nextTheme(prefs.get('theme')));
    keys.register({ id: 'view.theme', keys: 'Shift+Mod+L', inText: true, run: cycleTheme });
    const themeTip = themeBtn ? ui.tooltip(themeBtn, { text: '', shortcut: 'view.theme', side: 'right' }) : null;
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);
    let captionSent;   // what the Windows caption was last set to; undefined until the first call
    // prefs calls this on every change, including an OS appearance change while System is chosen.
    function syncTheme(ps) {
      const v = themeView(ps.theme, ps.themeResolved, prefs.nextTheme(ps.theme));
      setAttr($('themeIcon'), 'href', `#i-${v.icon}`);
      setAttr(themeBtn, 'aria-label', v.label);
      if (themeTip) themeTip.setText(v.tip);
      // Windows keeps its native caption bar (spec "Window chrome"); it follows the app theme, and null
      // follows the OS. macOS never calls it: its native material follows the OS (spec "Glass gating").
      if (ps.platform === 'mac') return;
      const want = ps.theme === 'system' ? null : ps.themeResolved;
      if (want === captionSent) return;
      captionSent = want;
      const tw = win.__TAURI__;
      if (!tw || !tw.window) return;
      try { Promise.resolve(tw.window.getCurrentWindow().setTheme(want)).catch(err => warn('setTheme failed', err)); } catch (err) { warn('setTheme failed', err); }
    }
    prefs.onChange(syncTheme);
    syncTheme(prefs.state());

    function render(st) {
      if (deviceList) syncDevices(st);
      syncSessions(st);
    }
    function sync() { render(state()); }
    // Twice a second, off the drain: sample the line counters for the rates, notice lines arriving (which
    // ends a stall), then refresh the rows and counts. Skipped while the window is hidden.
    function tick() {
      if (doc.hidden) return;
      const st = state();
      rates = meter.sample(now(), st.lines);
      for (const p of PLATFORMS) {
        if (st.lines[p] !== seen[p]) { seen[p] = st.lines[p]; stalled[p] = false; }
      }
      render(st);
      for (const fn of tickFns) fn();
    }
    win.setInterval(tick, TICK_MS);
    return {
      sync,
      // Each device row's { state, rate, name } after the last sync or tick (the toolbar and status bar).
      devices: () => devState,
      // Runs fn after every tick's refresh (the toolbar's badge and the status bar, live.js).
      onTick(fn) { tickFns.push(fn); },
      // The iOS bridge reported a stall (the legacy onmessage, paused or not): the row says "Stalled 15 s"
      // until the next log line. Lines that arrived before the report are not that line.
      markStalled(p) { seen[p] = state().lines[p]; stalled[p] = true; sync(); },
      // A legacy modal is about to open (the stall frame, not a press, opens it): a row menu is in #overlayRoot at
      // z 200, above the modal's z 100, and would keep focus. Closed without moving focus into the page behind.
      closeMenus() { for (const p of PLATFORMS) if (rows[p]) rows[p].menu.close({ restoreFocus: false }); },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.shellPure = Object.freeze({ num, fmtRate, createRateMeter, deviceStatus, themeView, DRAG_BANDS, STALL_SECONDS, setText, setAttr, setHidden });
  ALV.createShell = createShell;
})(typeof window !== 'undefined' ? window : globalThis);
