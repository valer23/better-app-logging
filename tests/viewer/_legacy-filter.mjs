// The filter bar's filter as it was before P6, the parity oracle of tests/viewer/legacy-parity.test.mjs. The three
// functions between the markers are copied verbatim from viewer/applogs-viewer.html at df8eacc (its "── Filtering ──"
// section); only their inputs changed: the fields they read from the page (the search, Tag and PID / App boxes, the
// regex button) and the globals they use (searchCaseSensitive, searchRegexMode, enabledLevels, enabledPlatforms,
// currentSearch, searchRegex) are built from `st` = { search, case, regex, tag, pid, levels, plats }. P6 deletes them
// from the page; this copy stays as the record of what "the old filters" meant.
export function legacyFilter(st) {
  const fields = { tagFilter: { value: st.tag }, pidFilter: { value: st.pid }, searchRegexBtn: { classList: { add() {}, remove() {} } } };
  const document = { getElementById: id => fields[id] };
  const searchCaseSensitive = st.case;
  const searchRegexMode = st.regex;
  const enabledLevels = new Set(st.levels);
  const enabledPlatforms = new Set(st.plats);
  const currentSearch = st.search;

  // ---- verbatim from df8eacc ----
  function _compileSearchRegex(query) {
    // Returns RegExp or null. Sets `error` class on regex button when invalid.
    if (!query) return null;
    const flags = searchCaseSensitive ? 'g' : 'gi';
    const btn = document.getElementById('searchRegexBtn');
    try {
      let re;
      if (searchRegexMode) {
        re = new RegExp(query, flags);
      } else {
        const escQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(escQ, flags);
      }
      if (btn) btn.classList.remove('error');
      return re;
    } catch (e) {
      if (btn && searchRegexMode) btn.classList.add('error');
      return null;
    }
  }

  function msgMatches(msg, query) {
    if (!query) return true;
    if (searchRegex) {
      searchRegex.lastIndex = 0;
      return searchRegex.test(msg);
    }
    // searchRegex compilation failed (invalid user regex) — match nothing.
    return false;
  }

  // Factory so batch callers (flushBatch, applyFilters) read the DOM inputs once
  // per pass instead of once per message.
  function makeFilter() {
    const s = currentSearch;
    const t = document.getElementById('tagFilter').value;
    const p = document.getElementById('pidFilter').value;
    // Tag/PID filters stay simple case-insensitive substrings — matches typical log-tool UX.
    const tLow = t.toLowerCase();
    const pLow = p.toLowerCase();
    return m => {
      if (!enabledLevels.has(m.lvl) || !enabledPlatforms.has(m.platform)) return false;
      if (s && !msgMatches(m.msg, s))                                          return false;
      if (t && !m.tag.toLowerCase().includes(tLow))                            return false;
      if (p && !String(m.pid).includes(p) && !m.app.toLowerCase().includes(pLow)) return false;
      return true;
    };
  }
  // ---- end verbatim ----

  // refilterSession compiled the search once per pass, then filtered with makeFilter().
  const searchRegex = _compileSearchRegex(currentSearch);
  return makeFilter();
}
