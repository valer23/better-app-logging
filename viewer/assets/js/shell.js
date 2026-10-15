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

  const ALV = g.ALV || (g.ALV = {});
  ALV.shellPure = Object.freeze({ num, fmtRate, createRateMeter, deviceStatus, themeView });
})(typeof window !== 'undefined' ? window : globalThis);
