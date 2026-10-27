/* Live-drain throughput bench. Loaded ONLY when the page URL has ?bench=N (see the last statement
   of the legacy inline script); a normal launch never fetches this file.
   Feeds synthetic iOS-shaped frames as {data: JSON string} through handleWsMsg, so JSON.parse is
   part of the measured cost, and records:
     - flush p50 / p95 / max (flushBatch is wrapped),
     - feed p95 (time per 10 ms tick spent inside handleWsMsg),
     - the largest gap between animation frames (a frozen UI shows up here),
     - the largest and final pendingBatch depth,
     - the largest DOM row count of the shown table and of the live session's own tbody, next to
       FOLLOW_DOM_CAP and LIVE_DOM_CAP.
   Query: ?bench=<lines/s>[&burst=<lines/s during 1 s of every 5 s>][&scenario=follow|read|paused|behind][&secs=<5..120>]
          [&q=<query text, URL-encoded>[&case=1][&re=1]][&cap=<lines>]
     q       a filter applied before the run (setQuery, P6; case and re set Aa and .*), e.g. three active tokens:
             &q=level%3AI%2B%20tag%3Ao%20%22bench%22 (level:I+ tag:o "bench", about two thirds of the lines pass).
     cap     MAX_RETAINED for the run, so a 15 s run trims (the counts' trim path); paused sets its own 50 000.
     follow  Follow on (auto-scroll), the default.
     read    Follow off after 2 s with the table scrolled to the middle (frozen reading window, #54).
     paused  Pause on from the start, MAX_RETAINED lowered to 50 000 so the backlog overflows.
     behind  A 50 000-line file session is shown (scrolled to the middle, one line selected) while
             live streams into the detached live session (P2). Records how many rows of the file
             table changed (must be 0), then switches Live and File five times each and records
             the slowest switch, the live rows after each return, whether the live tail ends at the
             newest line, and whether the file view came back at the same row with its selection.
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
  const scenario = ['follow', 'read', 'paused', 'behind'].includes(q.get('scenario')) ? q.get('scenario') : 'follow';
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
  let maxGap = 0, maxPending = 0, maxRows = 0, maxLiveRows = 0, sent = 0, carry = 0;
  let fileMutations = 0, fileObserver = null;
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
    if (typeof wsLines !== 'undefined') wsLines.ios += n;   // P4: the sidebar and status-bar rate meter, as onmessage would
    sent += n;
    if (elapsed > WARMUP_MS) {
      maxPending = Math.max(maxPending, pendingBatch.length);
      maxRows = Math.max(maxRows, cur.tbody.rows.length);
      maxLiveRows = Math.max(maxLiveRows, liveSession.tbody.rows.length);
    }
    if (scenario === 'read' && cur.follow && elapsed > 2000) {
      toggleAutoScroll();
      const t = document.getElementById('logTable');
      t.scrollTop = Math.floor(t.scrollHeight / 2);
    }
    if (elapsed >= secs * 1000) finish();
  }

  // The first row of the shown table in view, and its offset from the top of the scroller.
  function firstVisible() {
    const t = document.getElementById('logTable'), top = t.getBoundingClientRect().top;
    for (const r of cur.tbody.rows) {
      const b = r.getBoundingClientRect();
      if (b.bottom > top) return { msg: r._message, off: b.top - top };
    }
    return { msg: null, off: 0 };
  }

  // scenario=behind: switch Live and File five times each and check what comes back.
  function switchChecks() {
    fileObserver.disconnect();
    const t = document.getElementById('logTable');
    const before = firstVisible(), sel = fileSession.sel;
    let switchLiveMsMax = 0, switchFileMsMax = 0, liveRowsAfterReturn = 0, liveTailOk = true;
    for (let k = 0; k < 5; k++) {
      let t0 = performance.now();
      selectSession(liveSession); void t.scrollHeight;   // include the layout the switch forces
      switchLiveMsMax = Math.max(switchLiveMsMax, performance.now() - t0);
      const rows = liveSession.tbody.rows, last = liveSession.filtered[liveSession.filtered.length - 1];
      liveRowsAfterReturn = Math.max(liveRowsAfterReturn, rows.length);
      if (!rows.length || rows[rows.length - 1]._message !== last) liveTailOk = false;
      t0 = performance.now();
      selectSession(fileSession); void t.scrollHeight;
      switchFileMsMax = Math.max(switchFileMsMax, performance.now() - t0);
    }
    const after = firstVisible(), selRow = fileSession.tbody.querySelector('tr[aria-selected="true"]');
    return {
      fileRowsMutated: fileMutations, fileLines: fileSession.all.length,
      fileHasLiveLines: fileSession.all.some(m => m.seq !== undefined),
      switchLiveMsMax: +switchLiveMsMax.toFixed(1), switchFileMsMax: +switchFileMsMax.toFixed(1),
      liveRowsAfterReturn, liveTailOk,
      restoreOk: sel !== null && after.msg === before.msg && Math.abs(after.off - before.off) <= 1
        && selRow !== null && selRow._message === sel,
    };
  }

  function finish() {
    clearInterval(timer);
    const behind = scenario === 'behind' ? switchChecks() : {};
    const result = {
      scenario, rate, burst, secs, sent, query, queryError, cap: MAX_RETAINED,
      flushes: flushes.length,
      flushP50Ms: pct(flushes, 0.5), flushP95Ms: pct(flushes, 0.95), flushMaxMs: pct(flushes, 1),
      feedP95Ms: pct(feeds, 0.95),
      maxRafGapMs: +maxGap.toFixed(1),
      maxPending, finalPending: pendingBatch.length,
      maxDomRows: maxRows, maxLiveRows, followDomCap: FOLLOW_DOM_CAP, liveDomCap: LIVE_DOM_CAP,
      retained: liveSession.all.length, discarded: liveSession.discarded,
      ...behind,
      userAgent: navigator.userAgent,
    };
    start = 0;   // stops the rAF loop
    window.__benchResult = result;
    out.textContent = 'bench done\n' + JSON.stringify(result, null, 2);
    console.log('[bench]', JSON.stringify(result));
  }

  iosLive = true;          // show the live table without a device
  refreshLiveView();
  const query = q.get('q');
  let queryError = null;
  if (query !== null) {
    const err = setQuery(query, { case: q.get('case') === '1', regex: q.get('re') === '1' });
    if (err) { queryError = err.msg; console.warn(`dev-bench: q not applied: ${err.msg}`); }
  }
  const cap = parseInt(q.get('cap'), 10);
  if (cap > 0) MAX_RETAINED = cap;
  if (scenario === 'paused') { MAX_RETAINED = 50000; togglePause(); }
  if (scenario === 'behind') {
    const lines = [];
    for (let i = 0; i < 50000; i++) {
      lines.push({ ts: `2026 Oct 14 15:5${i % 10}:00.${String(i).padStart(6, '0')}`, pid: 50 + (i % 9), tid: 0,
        tag: TAGS[i % TAGS.length], app: '', lvl: LEVELS[i % LEVELS.length], msg: `file line ${i}`, platform: 'ios' });
    }
    discardBacklog(fileSession);              // what handleFile does with a parsed file
    resetLines(fileSession, lines);
    fileSession.query = -1;
    selectSession(fileSession);               // refilters and renders the first page
    const t = document.getElementById('logTable');
    t.scrollTop = Math.floor(t.scrollHeight / 2);
    fileSession.tbody.rows[Math.floor(fileSession.tbody.rows.length / 2)].click();   // select a line mid-window
    fileObserver = new MutationObserver(recs => { for (const r of recs) fileMutations += r.addedNodes.length + r.removedNodes.length; });
    fileObserver.observe(fileSession.tbody, { childList: true });
  }
  start = performance.now();
  lastTick = start;
  requestAnimationFrame(frame);
  timer = setInterval(tick, TICK_MS);
})();
