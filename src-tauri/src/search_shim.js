/* AppLogsViewer native-search shim.
 * Injected by `src/http_server.rs` before `</body>`. The HTML on disk
 * (viewer/logcat-viewer.html) is byte-identical; this shim is appended
 * at serve time only.
 *
 * Routes the search field through the native /search endpoint when
 * `allMessages` exceeds NATIVE_THRESHOLD rows. Below the threshold,
 * the original JS-side filter is fast enough.
 */
(function() {
  // Native /search path disabled: the indices it returns can race the JS
  // pendingBatch buffer (allMessages lags the Rust store by ~150ms), so some
  // hits mapped to undefined slots. JS-side filter scans all of allMessages
  // consistently and runs in ~50–80ms even at 80k rows.
  const NATIVE_THRESHOLD = Number.POSITIVE_INFINITY;
  const origApplyFilters = window.applyFilters;
  if (typeof origApplyFilters !== 'function') {
    console.warn('[applogs-shim] applyFilters not found — shim disabled');
    return;
  }

  let pending = 0; // generation counter to discard stale responses

  async function nativeSearch(query) {
    const gen = ++pending;
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, mode: 'plain' })
    });
    if (!res.ok) throw new Error('search ' + res.status);
    const data = await res.json();
    if (gen !== pending) return null; // newer query in flight
    return data;
  }

  window.applyFilters = function nativeApplyFilters() {
    const searchInput = document.getElementById('search');
    const query = (searchInput && searchInput.value) || '';
    currentSearch = query;

    const tagF = (document.getElementById('tagFilter') || {}).value || '';
    const pidF = (document.getElementById('pidFilter') || {}).value || '';

    // Use original filter when: no message query, small array, or
    // tag/pid filter active (native side scans msg only).
    if (!query || allMessages.length < NATIVE_THRESHOLD || tagF || pidF) {
      return origApplyFilters.apply(this, arguments);
    }

    nativeSearch(query)
      .then(function(data) {
        if (!data) return;
        const idx = data.indices;
        // Apply level/platform predicates that native does not know.
        filtered = [];
        for (let k = 0; k < idx.length; k++) {
          const m = allMessages[idx[k]];
          if (m && enabledLevels.has(m.lvl) && enabledPlatforms.has(m.platform)) {
            filtered.push(m);
          }
        }
        updateStats();
        renderedEnd = 0;
        document.getElementById('tbody').innerHTML = '';
        renderChunk(0);
        document.getElementById('logTable').scrollTop = 0;
        console.debug('[applogs-shim] native search: ' + idx.length + ' hits / ' + data.total + ' rows in ' + data.elapsed_ms + 'ms');
      })
      .catch(function(err) {
        console.warn('[applogs-shim] native search failed, falling back:', err);
        origApplyFilters.apply(this, arguments);
      });
  };

  console.info('[applogs-shim] native search shim active (threshold=' + NATIVE_THRESHOLD + ')');
})();
