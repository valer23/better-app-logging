/* Live-drain throughput bench. Loaded ONLY when the page URL has ?bench=N (see the last statement
   of the legacy inline script); a normal launch never fetches this file.
   Feeds synthetic iOS-shaped frames as {data: JSON string} through handleWsMsg, so JSON.parse is
   part of the measured cost, and records:
     - flush p50 / p95 / max (flushBatch is wrapped),
     - feed p95 (time per 10 ms tick spent inside handleWsMsg),
     - the largest gap between animation frames (a frozen UI shows up here),
     - the largest and final pendingBatch depth,
     - the largest DOM row count, next to FOLLOW_DOM_CAP and LIVE_DOM_CAP.
   Query: ?bench=<lines/s>[&burst=<lines/s during 1 s of every 5 s>][&scenario=follow|read|paused][&secs=<5..120>]
     follow  Follow on (auto-scroll), the default.
     read    Follow off after 2 s with the table scrolled to the middle (frozen reading window, #54).
     paused  Pause on from the start, MAX_RETAINED lowered to 50 000 so the backlog overflows.
   The first second is warm-up and is not counted. Results: the overlay, window.__benchResult and
   the console. Reload the page before the next run. */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const rate = parseInt(q.get('bench'), 10);
  if (!(rate > 0)) {
    console.warn(`dev-bench: not running, ?bench=${q.get('bench')} is not a positive lines/s rate`);
    return;
  }
  const burst = Math.max(0, parseInt(q.get('burst'), 10) || 0);
  const scenario = ['follow', 'read', 'paused'].includes(q.get('scenario')) ? q.get('scenario') : 'follow';
  const secs = Math.min(120, Math.max(5, parseInt(q.get('secs'), 10) || 15));
  const WARMUP_MS = 1000;
  const TICK_MS = 10;

  const LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
  const TAGS = ['SpringBoard(FrontBoard)', 'bluetoothd', 'Bragi AI Dev(com.bragi.sdk)', 'kernel', 'locationd(CoreLocation)'];
  const pool = [];
  for (let i = 0; i < 64; i++) {
    pool.push(JSON.stringify({
      type: 'log',
      ts: `2026 Oct 14 15:53:${String(10 + (i % 50)).padStart(2, '0')}.${String(100000 + i * 7919).slice(0, 6)}`,
      pid: 50 + (i % 9), tid: 0, lvl: LEVELS[i % LEVELS.length], tag: TAGS[i % TAGS.length],
      app: i % 3 ? 'com.bragi.app' : '',
      msg: `bench line ${i} `.padEnd(40 + ((i * 37) % 160), 'x'),
    }));
  }

  const out = document.createElement('pre');
  out.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:1000;margin:0;padding:8px 10px;max-width:460px;'
    + 'white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;background:#000c;color:#fff;border-radius:6px;pointer-events:none';
  out.textContent = `bench: ${scenario} at ${rate} lines/s${burst ? `, bursts of ${burst}` : ''}, ${secs} s…`;
  document.body.appendChild(out);

  let start = 0;
  const flushes = [];   // [startedAt, ms]
  const feeds = [];     // [startedAt, ms]
  let maxGap = 0, maxPending = 0, maxRows = 0, sent = 0, carry = 0;
  // flushBatch is a top-level function declaration, so every call site (timer, inline flush,
  // requeue, visibilitychange) resolves it through the global object and picks up this wrapper.
  const realFlush = flushBatch;
  flushBatch = function benchFlushBatch() {
    const t0 = performance.now();
    try { return realFlush.apply(this, arguments); } finally { flushes.push([t0, performance.now() - t0]); }
  };

  let lastFrame = 0;
  function frame(t) {
    if (lastFrame && t - start > WARMUP_MS) maxGap = Math.max(maxGap, t - lastFrame);
    lastFrame = t;
    if (start) requestAnimationFrame(frame);
  }

  function pct(samples, p) {
    const v = samples.filter(([t]) => t - start >= WARMUP_MS).map(([, ms]) => ms).sort((a, b) => a - b);
    if (!v.length) return 0;
    return +v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(2);
  }

  let lastTick = 0;
  let timer = 0;
  function tick() {
    const now = performance.now();
    const elapsed = now - start;
    const inBurst = burst > 0 && elapsed % 5000 < 1000;
    carry += (inBurst ? burst : rate) * (now - lastTick) / 1000;
    lastTick = now;
    const n = Math.floor(carry);
    carry -= n;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) handleWsMsg({ data: pool[(sent + i) & 63] }, 'ios');
    feeds.push([t0, performance.now() - t0]);
    sent += n;
    if (elapsed > WARMUP_MS) {
      maxPending = Math.max(maxPending, pendingBatch.length);
      maxRows = Math.max(maxRows, cur.tbody.rows.length);
    }
    if (scenario === 'read' && cur.follow && elapsed > 2000) {
      toggleAutoScroll();
      const t = document.getElementById('logTable');
      t.scrollTop = Math.floor(t.scrollHeight / 2);
    }
    if (elapsed >= secs * 1000) finish();
  }

  function finish() {
    clearInterval(timer);
    const result = {
      scenario, rate, burst, secs, sent,
      flushes: flushes.length,
      flushP50Ms: pct(flushes, 0.5), flushP95Ms: pct(flushes, 0.95), flushMaxMs: pct(flushes, 1),
      feedP95Ms: pct(feeds, 0.95),
      maxRafGapMs: +maxGap.toFixed(1),
      maxPending, finalPending: pendingBatch.length,
      maxDomRows: maxRows, followDomCap: FOLLOW_DOM_CAP, liveDomCap: LIVE_DOM_CAP,
      retained: liveSession.all.length, discarded: liveSession.discarded,
      userAgent: navigator.userAgent,
    };
    start = 0;   // stops the rAF loop
    window.__benchResult = result;
    out.textContent = 'bench done\n' + JSON.stringify(result, null, 2);
    console.log('[bench]', JSON.stringify(result));
  }

  iosLive = true;          // show the live table without a device
  refreshLiveView();
  if (scenario === 'paused') { MAX_RETAINED = 50000; togglePause(); }
  start = performance.now();
  lastTick = start;
  requestAnimationFrame(frame);
  timer = setInterval(tick, TICK_MS);
})();
