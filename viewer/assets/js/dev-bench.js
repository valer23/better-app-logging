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
   Query: ?bench=<lines/s>[&burst=<lines/s during 1 s of every 5 s>][&scenario=follow|read|paused|behind|switch|refilter][&secs=<5..120>]
          [&q=<query text, URL-encoded>[&case=1][&re=1]][&cap=<lines>][&slow=1][&rq=<q1|q2|…>]
     q       a filter applied before the run through the query bar when it has set() (P7a: the bar then shows it), else setQuery
             (case and re set Aa and .*), e.g. three active tokens:
             &q=level%3AI%2B%20tag%3Ao%20%22bench%22 (level:I+ tag:o "bench", about two thirds of the lines pass).
     cap     MAX_RETAINED for the run, so a 15 s run trims (the counts' trim path); paused sets its own 50 000.
     follow  Follow on (auto-scroll), the default.
     read    Follow off after 2 s with the table scrolled to the middle (frozen reading window, #54).
             readPhaseP50Ms, readPhaseP95Ms and readPhaseFlushes cover only the flushes after the switch: the
             overall p95 also samples the follow-mode second before it.
     paused  Pause on from the start, MAX_RETAINED lowered to 50 000 so the backlog overflows.
     behind  A 50 000-line file session is shown (scrolled to the middle, one line selected) while
             live streams into the detached live session (P2). Records how many rows of the file
             table changed (must be 0), then switches Live and File five times each and records
             the slowest switch, the live rows after each return, whether the live tail ends at the
             newest line, and whether the file view came back at the same row with its selection.
     switch  P7a: Live is prefilled to MAX_RETAINED (default 500 000) and keeps streaming; a 50 000-line file is shown at 1.5 s
             (after the warm-up's &q landed on Live). Five cycles, 2 s apart: change File's filter, switch to Live 1 s later
             (switchLiveMs; Live's refilters counted), back to File 0.5 s later (switchFileMs). Records whether Live kept its
             query and kept filtering while away, and whether its level counts equal a recount at the end.
     refilter P7a: Live is prefilled to MAX_RETAINED and shown, following. From 2 s, every 1.5 s, one query is applied through the
             bar (or setQuery on main) and timed with its refilter and render (ms), and on head with the guard alone (guardMs):
             q3, q3n, a regex, '/time ?out/', '', three words under .* and three quantified regex terms. &slow=1 adds
             '/\s.*.*.*z/', '/(.*){2}z/', '/\w+\w+z/' (head only: main would freeze). &rq=<q1|q2|…> replaces the list (a
             '.*:' prefix applies the rest with .* on).
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
  const scenario = ['follow', 'read', 'paused', 'behind', 'switch', 'refilter'].includes(q.get('scenario')) ? q.get('scenario') : 'follow';
  const slow = q.get('slow') === '1';
  // The same file runs on main (one shared query: activeQuery, filterGen) and on P7a (one per session): the A/B baseline.
  const keyOf = s => (s.filter ? s.filter.key : activeQuery.key);
  const STALE = typeof filterGen === 'number' ? -1 : null;   // a file not filtered yet
  const applyText = (text, o) => (typeof queryBar !== 'undefined' && queryBar && queryBar.set ? queryBar.set(text, o) : setQuery(text, o));
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
  let readFrom = 0;     // scenario=read: when Follow went off (the reading phase's flushes start after it)
  const flushes = [];   // [startedAt, ms]
  const feeds = [];     // [startedAt, ms]
  let maxGap = 0, maxPending = 0, maxRows = 0, maxLiveRows = 0, sent = 0, carry = 0;
  let fileMutations = 0, fileObserver = null;
  // flushBatch is a top-level function declaration, so every call site (timer, inline flush,
  // requeue, visibilitychange) resolves it through the global object and picks up this wrapper.
  // refilterSession is a top-level function declaration too: every caller (applyFilters, restoreView) picks this wrapper up.
  let liveRefilters = 0;
  const realRefilter = refilterSession;
  refilterSession = function benchRefilter(s) { if (s === liveSession) liveRefilters++; return realRefilter.apply(this, arguments); };
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

  // The p-quantile of the samples that started at or after `from` (default: the end of the warm-up).
  function pct(samples, p, from = start + WARMUP_MS) {
    const v = samples.filter(([t]) => t >= from).map(([, ms]) => ms).sort((a, b) => a - b);
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
      readFrom = performance.now();   // after the switch's own work: what follows is reading
    }
    if (scenario === 'switch') switchTick(elapsed);
    if (scenario === 'refilter') refilterTick(elapsed);
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

  // scenario=switch: File is shown at 1.5 s (after the warm-up's &q landed on Live), then five cycles at 2 s + 2k s.
  const FILE_QUERIES = ['level:W+', '/bench line \\d+ x+$/', 'tag:kernel -zzzz'];
  // keptFiltering: Live's filtered list gained a line that arrived after File's filter changed. A trim shrinks the list, so its
  // length cannot tell; the newest filtered line's seq can. seqAway is the seq of the last line FLUSHED into Live at the change
  // (a line still in pendingBatch is not filtered yet); the check waits until Live has flushed a later one, so a loaded machine
  // that lags the drain cannot read as "stopped filtering". On main the stale drain stops filtering: no such line.
  const flushedSeq = () => { const a = liveSession.all; return a.length ? a[a.length - 1].seq : -1; };
  // fileChanges: the cycles whose apply really changed File's filter (fileQueryKept alone cannot say: it compares with the key read
  // after the apply). fileSetErrors: every refusal of one (the guard, on a loaded machine); such a cycle measured a switch with no change.
  const sw = { k: -1, phase: 0, liveKey0: null, fileKey: null, liveMs: [], fileMs: [], setMs: [], seqAway: 0, liveKept: true, fileKept: true, keptFiltering: true, tailOk: true,
    fileChanges: 0, fileSetErrors: [] };
  function switchTick(elapsed) {
    const t = document.getElementById('logTable');
    if (sw.liveKey0 === null) {
      if (elapsed >= 1500) { sw.liveKey0 = keyOf(liveSession); liveRefilters = 0; selectSession(fileSession); }
      return;
    }
    const k = Math.floor((elapsed - 2000) / 2000), at = (elapsed - 2000) % 2000;
    if (k < 0 || k > 4) return;
    if (k !== sw.k) {                                  // change File's filter
      sw.k = k; sw.phase = 0;
      const keyBefore = keyOf(fileSession), t0 = performance.now();
      const err = applyText(FILE_QUERIES[k % 3], {});
      sw.setMs.push(performance.now() - t0);
      sw.fileKey = keyOf(fileSession);
      if (err) sw.fileSetErrors.push(`${FILE_QUERIES[k % 3]}: ${err.msg || err}`);
      else if (sw.fileKey !== keyBefore) sw.fileChanges++;
      sw.seqAway = flushedSeq();
    } else if (sw.phase === 0 && at >= 1000 && flushedSeq() > sw.seqAway) {   // to Live, once a later line was flushed into it
      sw.phase = 1;
      const newest = liveSession.filtered[liveSession.filtered.length - 1];
      if (!newest || !(newest.seq > sw.seqAway)) sw.keptFiltering = false;   // no line that arrived while File was shown
      const t0 = performance.now();
      selectSession(liveSession); void t.scrollHeight;
      sw.liveMs.push(performance.now() - t0);
      if (keyOf(liveSession) !== sw.liveKey0) sw.liveKept = false;
      const rows = liveSession.tbody.rows, last = liveSession.filtered[liveSession.filtered.length - 1];
      if (!rows.length || rows[rows.length - 1]._message !== last) sw.tailOk = false;
    } else if (sw.phase === 1 && at >= 1500) {         // back to File
      sw.phase = 2;
      const t0 = performance.now();
      selectSession(fileSession); void t.scrollHeight;
      sw.fileMs.push(performance.now() - t0);
      if (keyOf(fileSession) !== sw.fileKey) sw.fileKept = false;
    }
  }
  function switchResult() {
    const med = a => (a.length ? +[...a].sort((x, y) => x - y)[a.length >> 1].toFixed(1) : null);
    const max = a => (a.length ? +Math.max(...a).toFixed(1) : null);
    const s = liveSession, gate = s.query && typeof s.query === 'object' ? s.query.gate : null;
    const want = gate ? ALV.counts.recount(ALV.counts.create(), s.all, gate).lvl : null;
    return {
      cycles: sw.liveMs.length, switchLiveMsMax: max(sw.liveMs), switchLiveMsMed: med(sw.liveMs), switchFileMsMax: max(sw.fileMs),
      fileSetQueryMsMax: max(sw.setMs), fileChanges: sw.fileChanges, fileSetErrors: sw.fileSetErrors, liveRefilters, liveQueryKept: sw.liveKept, fileQueryKept: sw.fileKept,
      liveKeptFiltering: sw.keptFiltering, liveTailOk: sw.tailOk,
      liveCountsOk: want ? want.every((n, i) => n === s.counts.lvl[i]) : null,   // null on main (no per-session query)
    };
  }

  // scenario=refilter: one query every 1.5 s from 2 s, applied as the user would and timed with its refilter and render.
  // '.*:' applies the rest with .* on: every word is then a regex term (the guard skips those without a quantifier).
  const REFILTER_QUERIES = (q.get('rq') ? q.get('rq').split('|')
    : ['level:I+ tag:o "bench"', 'level:I+ tag:o -zzzz', '/bench line \\d+ x+$/', '/time ?out/', '', '.*:error timeout disconnect',
      '/bench\\w*/ /line\\s+\\d+/ /x+$/'].concat(slow ? ['/\\s.*.*.*z/', '/(.*){2}z/', '/\\w+\\w+z/'] : []))
    .map(t => (t.startsWith('.*:') ? [t.slice(3), true] : [t, false]));
  // guardMs: the guard's own share of the apply (head only; main has no guard: 0). ALV.query is frozen, so the wrapper
  // replaces the object (ALV itself is not frozen), as the page tests do.
  let guardMs = 0;
  if (ALV.query.slowRegex) {
    const realGuard = ALV.query.slowRegex;
    ALV.query = Object.freeze(Object.assign({}, ALV.query, { slowRegex(...a) { const t0 = performance.now(); try { return realGuard(...a); } finally { guardMs += performance.now() - t0; } } }));
  }
  const rf = { i: 0, out: [], keyKept: true };
  function refilterTick(elapsed) {
    if (rf.i >= REFILTER_QUERIES.length || elapsed < 2000 + rf.i * 1500) return;
    const [text, re] = REFILTER_QUERIES[rf.i++], before = keyOf(liveSession);
    guardMs = 0;
    const t0 = performance.now();
    const err = applyText(text, { regex: re });
    const ms = performance.now() - t0;
    if (err && keyOf(liveSession) !== before) rf.keyKept = false;
    rf.out.push({ q: text, re, ms: +ms.toFixed(1), guardMs: +guardMs.toFixed(1), error: err ? err.msg : null, kept: liveSession.filtered.length,
      nsPerLine: +((ms - guardMs) * 1e6 / Math.max(1, liveSession.all.length)).toFixed(0) });
  }
  function refilterResult() {
    const ok = rf.out.filter(x => !x.error), bad = rf.out.filter(x => x.error);
    return { refilter: rf.out, liveKeyKeptAfterRefusals: rf.keyKept,
      refilterMsMax: ok.length ? Math.max(...ok.map(x => x.ms)) : null, guardMsMax: bad.length ? Math.max(...bad.map(x => x.ms)) : null };
  }

  function finish() {
    clearInterval(timer);
    const behind = scenario === 'behind' ? switchChecks() : {};
    const result = {
      scenario, rate, burst, secs, sent, query, queryError, cap: MAX_RETAINED,
      flushes: flushes.length,
      flushP50Ms: pct(flushes, 0.5), flushP95Ms: pct(flushes, 0.95), flushMaxMs: pct(flushes, 1),
      ...(scenario === 'read' ? {
        // null, not 0, when the read switch never happened: p2-compare fails on null (follow-up 10).
        readPhaseFlushes: readFrom ? flushes.filter(([t]) => t >= readFrom).length : null,
        readPhaseP50Ms: readFrom ? pct(flushes, 0.5, readFrom) : null, readPhaseP95Ms: readFrom ? pct(flushes, 0.95, readFrom) : null,
      } : {}),
      feedP95Ms: pct(feeds, 0.95),
      maxRafGapMs: +maxGap.toFixed(1),
      maxPending, finalPending: pendingBatch.length,
      maxDomRows: maxRows, maxLiveRows, followDomCap: FOLLOW_DOM_CAP, liveDomCap: LIVE_DOM_CAP,
      retained: liveSession.all.length, discarded: liveSession.discarded,
      ...behind,
      ...(scenario === 'switch' ? switchResult() : {}), ...(scenario === 'refilter' ? refilterResult() : {}),
      barText: document.getElementById('queryInput') ? document.getElementById('queryInput').value : null,
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
    const err = applyText(query, { case: q.get('case') === '1', regex: q.get('re') === '1' });
    if (err) { queryError = err.msg; console.warn(`dev-bench: q not applied: ${err.msg}`); }
  }
  const cap = parseInt(q.get('cap'), 10);
  if (cap > 0) MAX_RETAINED = cap;
  if (scenario === 'paused') { MAX_RETAINED = 50000; togglePause(); }
  if (scenario === 'behind' || scenario === 'switch') {
    const lines = [];
    for (let i = 0; i < 50000; i++) {
      lines.push({ ts: `2026 Oct 14 15:5${i % 10}:00.${String(i).padStart(6, '0')}`, pid: 50 + (i % 9), tid: 0,
        tag: TAGS[i % TAGS.length], app: '', lvl: LEVELS[i % LEVELS.length], msg: `file line ${i}`, platform: 'ios' });
    }
    discardBacklog(fileSession);              // what handleFile does with a parsed file
    resetLines(fileSession, lines);
    fileSession.query = STALE;
  }
  if (scenario === 'behind') {
    selectSession(fileSession);               // refilters and renders the first page
    const t = document.getElementById('logTable');
    t.scrollTop = Math.floor(t.scrollHeight / 2);
    fileSession.tbody.rows[Math.floor(fileSession.tbody.rows.length / 2)].click();   // select a line mid-window
    fileObserver = new MutationObserver(recs => { for (const r of recs) fileMutations += r.addedNodes.length + r.removedNodes.length; });
    fileObserver.observe(fileSession.tbody, { childList: true });
  }
  // switch, refilter: Live holds MAX_RETAINED lines before the run, through the real ingest (seq, counts and trims are real);
  // not measured. 10 000 frames a chunk, each drained by the real flush.
  if (scenario === 'switch' || scenario === 'refilter') {
    for (let left = MAX_RETAINED; left > 0; left -= 10000) {
      const n = Math.min(10000, left);
      for (let i = 0; i < n; i++) handleWsMsg({ data: pool[(sent + i) & 63] }, 'ios');
      sent += n;
      while (pendingBatch.length) realFlush();
    }
  }
  start = performance.now();
  lastTick = start;
  requestAnimationFrame(frame);
  timer = setInterval(tick, TICK_MS);
})();
