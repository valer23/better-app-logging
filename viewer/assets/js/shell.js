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

  // Frames per second per platform from cumulative counters sampled by a timer: measured from the newest
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
  // s: { live, state, text (setStatus), detected, driverMissing, stalledFor (s, or -1), rate, dropped }
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
  const DRAG_BANDS = ['sidebarHeader', 'topbar'];
  const DRAG_THRESHOLD_PX = 4;

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

  // createShell({ doc, win, dom, ui, keys, state, actions, now }) → { sync(), markStalled(platform) }. Called
  // once, by the legacy script, before its first selectSession. state() returns what the shell shows (the
  // legacy shellState()); actions are the legacy functions it calls. Without `state` only the drag bands are
  // wired (the drag tests).
  function createShell({ doc, win, dom, ui, keys, state, actions, now = () => win.performance.now() }) {
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
    const rows = {};
    const meter = createRateMeter(1000);
    let rates = { android: 0, ios: 0 };
    const seen = { android: { frames: 0, at: now() }, ios: { frames: 0, at: now() } };   // last frame count change
    const stalled = { android: false, ios: false };
    function act(p, what) {
      if (what === 'stream') actions.toggleStream(p);
      else if (what === 'repair') actions.repair(p);
      else if (what === 'setup') actions.setup(p);
    }
    function buildRow(p, dev, key) {
      const P = PLATFORM[p];
      const name = dev.name || P.fallback;
      const r = { key, name, tips: [] };
      r.status = dom.el('span', { class: 'side-label' });
      r.dropsText = dom.el('span');
      r.drops = dom.el('span', { class: 'dev-drops', hidden: true }, dom.icon('triangle-alert'), r.dropsText);
      r.main = dom.el('button', { type: 'button', class: 'nav-item dev-main', on: { click: () => actions.togglePlatform(p) } },
        dom.el('span', { class: P.cls, 'aria-hidden': 'true', text: P.badge }),
        dom.el('span', { class: 'dev-text' },
          dom.el('span', { class: 'dev-name side-label', text: name }),
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
      r.tips.push(r.startTip, ui.tooltip(r.more, { text: `More for ${name}` }));
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
    function stalledFor(p, live, t) {
      if (!live) stalled[p] = false;
      return stalled[p] ? (t - seen[p].at) / 1000 : -1;
    }
    function syncDevices(st, t) {
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
          driverMissing: p === 'ios' && st.driverMissing, stalledFor: stalledFor(p, live, t), rate: rates[p], dropped: st.dropped[p] });
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

    function render(st, t) {
      if (deviceList) syncDevices(st, t);
      syncSessions(st);
    }
    function sync() { render(state(), now()); }
    // Twice a second, off the drain: sample the frame counters for the rates, notice frames arriving (which
    // ends a stall), then refresh the rows and counts. Skipped while the window is hidden.
    function tick() {
      if (doc.hidden) return;
      const st = state();
      const t = now();
      rates = meter.sample(t, st.frames);
      for (const p of PLATFORMS) {
        if (st.frames[p] !== seen[p].frames) { seen[p] = { frames: st.frames[p], at: t }; stalled[p] = false; }
      }
      render(st, t);
    }
    win.setInterval(tick, TICK_MS);
    return {
      sync,
      // The iOS bridge reported a stall (showStallModal): the row says "Stalled N s" until frames move again.
      // The stall arrives as an error frame that onmessage has already counted, so that count is absorbed
      // here; seen.at stays the time frames last moved.
      markStalled(p) { const st = state(); seen[p] = { frames: st.frames[p], at: seen[p].at }; stalled[p] = true; sync(); },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.shellPure = Object.freeze({ num, fmtRate, createRateMeter, deviceStatus, themeView, DRAG_BANDS, setText, setAttr, setHidden });
  ALV.createShell = createShell;
})(typeof window !== 'undefined' ? window : globalThis);
