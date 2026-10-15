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

  // createShell({ doc, win, dom }) → the shell's controller. Called once, by the legacy script.
  function createShell({ doc, win, dom }) {
    const warn = (msg, err) => { if (g.console) g.console.warn(msg, err); };
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
    return {};
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.shellPure = Object.freeze({ num, fmtRate, createRateMeter, deviceStatus, themeView, DRAG_BANDS });
  ALV.createShell = createShell;
})(typeof window !== 'undefined' ? window : globalThis);
