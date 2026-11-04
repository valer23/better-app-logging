/* The query grammar (roadmap P6; spec "Query grammar", "Query region"). Classic script and pure: no page, storage
   or timer access, so the tests run it in an empty vm context. The page loads it before the legacy inline script.

   parse(text) splits the query into tokens with their source ranges ({ k, v, neg, start, end }) and the errors the
   spec names; serialize(tokens) writes them back in canonical form; compile(tokens, opts, devices) turns them into
   the filter the drain runs once per line: gate(m) is the line's level index (0 V … 5 F) when it passes everything
   but the level filter, else -1, and lvOk[k] says whether level k is shown. Level counts ignore the level filter
   (spec "Level chips"), so the drain counts gate(m) and keeps the line when lvOk says so. build(text, opts, devices)
   is parse + compile: { q, error }, one of them null. */
(function (g) {
  'use strict';

  const KEYS = ['level', 'tag', 'app', 'pid', 'dev', 'plat'];
  const LETTERS = 'VDIWEF';
  // Level name → index. Lines carry the logcat names; a level outside this table is never shown (as before P6).
  const LV = Object.freeze({ VERBOSE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, ASSERT: 5 });
  const ALL_LEVELS = 63;
  const LEVEL_WORDS = new Map([['v', 0], ['verbose', 0], ['d', 1], ['debug', 1], ['i', 2], ['info', 2], ['w', 3], ['warn', 3],
    ['warning', 3], ['e', 4], ['error', 4], ['f', 5], ['fatal', 5], ['assert', 5]]);
  const PLAT_BIT = Object.freeze({ android: 1, ios: 2 });
  const BOTH = 3;
  const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ';

  // ---- Tokens ----

  // A double-quoted string from text[q] === '"': \" and \\ are escapes, any other backslash is kept. An unterminated
  // quote runs to the end of the input (the user is still typing it). → [value, end].
  function quoted(text, q) {
    let p = q + 1;
    let out = '';
    while (p < text.length) {
      const c = text[p];
      if (c === '\\' && (text[p + 1] === '"' || text[p + 1] === '\\')) { out += text[p + 1]; p += 2; continue; }
      if (c === '"') return [out, p + 1];
      out += c;
      p++;
    }
    return [out, p];
  }
  // The end of a /regex/ that starts at text[j] === '/': the next unescaped '/' followed by whitespace or the end of the
  // input, so the body may hold spaces and '/usr/lib' stays a bare word. -1 when there is none.
  function regexEnd(text, j) {
    for (let p = j + 1; p < text.length; p++) {
      if (text[p] === '\\') { p++; continue; }
      if (text[p] === '/' && (p + 1 === text.length || isWs(text[p + 1]))) return p;
    }
    return -1;
  }
  const wordEnd = (text, p) => { while (p < text.length && !isWs(text[p])) p++; return p; };

  // An unknown key that is a known key with one letter missing ('tg', 'pi', 'plt') or two neighbouring letters swapped
  // ('tga', 'pdi'), with the same first letter, is a typo the spec names ("Unknown field 'tg'. Did you mean tag:?").
  // Any other `word:` is a bare word, so 'Exception:', 'id:', URLs and log words one letter from a key ('pin:', 'pod:',
  // 'ppid:', 'apk:', 'apn:', 'dex:', 'play:') still search the message: a substituted or added letter is never a typo.
  function typoOf(a, b) {
    if (a[0] !== b[0]) return false;
    if (a.length === b.length - 1) {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(i) === b.slice(i + 1);
    }
    if (a.length !== b.length) return false;
    const d = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
    return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
  }
  const nearKey = k => KEYS.find(K => typoOf(k, K)) || null;
  // '/foo/i': a regex with flags, which the grammar does not have (case follows Aa). It is reported, not searched as the
  // word '/foo/i'. The flags are the ones people type after a regex: 1 to 3 distinct letters of g, i, m with a g or an i among
  // them (g, i, gi, im, gim). The others (s, u, y, or m alone) are letters of ordinary words, and the tail of a path or a URL
  // is one: '/api/msg', '/img/gui', '/home/my', '/v1/sum', '/data/u' stay words. The body has no unescaped '/' (so '/usr/lib',
  // '/a/b/c' stay words) but may hold spaces ('/time out/i'). flaggedRegex(text, j) for text[j] === '/': { body, end } when the
  // first unescaped '/' after it is followed by such flags and then whitespace or the end of the text, else null.
  function flaggedRegex(text, j) {
    for (let p = j + 1; p < text.length; p++) {
      if (text[p] === '\\') { p++; continue; }
      if (text[p] !== '/') continue;
      let e = p + 1;
      while (e < text.length && !isWs(text[e])) e++;
      const flags = text.slice(p + 1, e);
      const ok = p > j + 1 && /^[gim]{1,3}$/.test(flags) && /[gi]/.test(flags) && new Set(flags).size === flags.length;
      return ok ? { body: text.slice(j + 1, p), end: e } : null;
    }
    return null;
  }

  // level: values → a 6-bit mask (bit k = level k), -1 when the value lists nothing yet ('level:,'), or { bad } for
  // the first item that is no level. Items: a letter or name, optionally followed by '+' (that level and above), or none.
  function levelMask(v) {
    let mask = 0;
    let seen = false;
    for (const raw of String(v).split(',')) {
      const item = raw.trim();
      if (!item) continue;
      seen = true;
      let s = item.toLowerCase();
      const plus = s.length > 1 && s.endsWith('+');
      if (plus) s = s.slice(0, -1);
      if (s === 'none' && !plus) continue;
      const k = LEVEL_WORDS.get(s);
      if (k === undefined) return { bad: item };
      mask |= plus ? ALL_LEVELS & ~((1 << k) - 1) : 1 << k;
    }
    return seen ? mask : -1;
  }
  // The canonical level token for a mask (spec "Chips and text are one model"): '' when all six are on, 'level:none'
  // when none, 'level:W+' when the set runs contiguously up to F, else a list such as 'level:D,I,E'.
  function levelText(mask) {
    if (mask === ALL_LEVELS) return '';
    if (!mask) return 'level:none';
    for (let k = 1; k < 5; k++) if (mask === (ALL_LEVELS & ~((1 << k) - 1))) return `level:${LETTERS[k]}+`;
    return 'level:' + [...LETTERS].filter((_, i) => mask & (1 << i)).join(',');
  }

  // parse(text) → { tokens: [{ k, v, neg, start, end }], errors: [{ start, end, msg }] }. k is a key (level, tag, app,
  // pid, dev, plat) or word, phrase, regex; v is the value as typed (quotes and escapes removed); start/end are the
  // token's source range, the leading '-' included. A key with no value yet ('tag:' or 'tag:"') is still being typed:
  // it is neither applied nor an error. Keys are case-insensitive.
  function parse(text) {
    const src = String(text == null ? '' : text);
    const tokens = [];
    const errors = [];
    const err = (start, end, msg) => errors.push({ start, end, msg });
    let i = 0;
    while (i < src.length) {
      if (isWs(src[i])) { i++; continue; }
      const start = i;
      const neg = src[i] === '-' && i + 1 < src.length && !isWs(src[i + 1]);
      const j = neg ? i + 1 : i;
      if (src[j] === '"') {
        const [v, end] = quoted(src, j);
        if (neg) err(start, end, 'Negated phrases and regexes are not supported. Use -word or -key:value.');
        tokens.push({ k: 'phrase', v, neg, start, end });
        i = end;
        continue;
      }
      if (src[j] === '/') {
        const close = regexEnd(src, j);
        if (close > j) {
          const end = close + 1;
          if (neg) err(start, end, 'Negated phrases and regexes are not supported. Use -word or -key:value.');
          tokens.push({ k: 'regex', v: src.slice(j + 1, close), neg, start, end });
          i = end;
          continue;
        }
        const flagged = flaggedRegex(src, j);
        if (flagged) {
          err(start, flagged.end, `Regex flags are not supported. Use /${flagged.body}/, and Aa for match case.`);
          tokens.push({ k: 'word', v: src.slice(j, flagged.end), neg, start, end: flagged.end });
          i = flagged.end;
          continue;
        }
      }
      const key = /^([A-Za-z]+):/.exec(src.slice(j, j + 12));
      const k = key ? key[1].toLowerCase() : '';
      if (key && KEYS.includes(k)) {
        const at = j + key[0].length;
        let v;
        let end;
        if (src[at] === '"') [v, end] = quoted(src, at);
        else { end = wordEnd(src, at); v = src.slice(at, end); }
        i = end;
        if (v === '') continue;   // 'tag:' or 'tag:"' with no value yet: still being typed, so neither applied nor an error
        if (k === 'level') {
          const mask = levelMask(v);
          if (mask && mask.bad !== undefined) err(start, end, `Unknown level '${mask.bad}'. Use V, D, I, W, E or F, or W+ for W and above.`);
        } else if (k === 'pid' && !/^\d+$/.test(v)) err(start, end, `PID '${v}' is not a number.`);
        else if (k === 'plat' && !Object.prototype.hasOwnProperty.call(PLAT_BIT, v.toLowerCase())) err(start, end, `Unknown platform '${v}'. Use android or ios.`);
        tokens.push({ k, v, neg, start, end });
        continue;
      }
      const end = wordEnd(src, j);
      if (key && nearKey(k)) err(start, end, `Unknown field '${key[1]}'. Did you mean ${nearKey(k)}:?`);
      tokens.push({ k: 'word', v: src.slice(j, end), neg, start, end });
      i = end;
    }
    return { tokens, errors };
  }

  // Escape exactly what quoted() unescapes: a quote, and a backslash that precedes a quote, a backslash or the closing
  // quote. Any other backslash is written as it is, so '\/ ' inside a value stays '\/ ' and the regexEnd scan, which skips
  // the character after a backslash, sees the same pairs the parser did.
  const escQ = v => v.replace(/"|\\(?=["\\]|$)/g, '\\$&');
  // A value ending in '/', or in '/' plus one to three of g, i, m, is quoted too: unquoted, that '/' (with its flags) could close a
  // leading '/word' as a flagged regex when the text is re-parsed.
  const quoteIf = v => (/[\s"]/.test(v) || v === '' || v.endsWith('/') || /\/[gim]{1,3}$/.test(v) ? `"${escQ(v)}"` : v);
  // serialize(tokens) → the canonical text: one space between tokens, keys in lower case, a value quoted only when it
  // is empty, holds whitespace or a quote, ends in '/', or ends in '/' and 1-3 of g, i, m (a regex's close and its flags).
  // parse(serialize(tokens)) gives the same tokens (ranges aside).
  function serialize(tokens) {
    return tokens.map(t => {
      const body = t.k === 'word' ? t.v : t.k === 'phrase' ? `"${escQ(t.v)}"` : t.k === 'regex' ? `/${t.v}/` : `${t.k}:${quoteIf(t.v)}`;
      return (t.neg ? '-' : '') + body;
    }).join(' ');
  }

  // ---- Compile ----

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The reason of a SyntaxError from new RegExp, without the engine's "Invalid regular expression: /…/: " prefix.
  const reason = e => String(e && e.message || e).replace(/^.*?:\s*\/.*\/[a-z]*:\s*/, '').replace(/^Invalid regular expression:\s*/, '');
  // A regex term that can backtrack exponentially (or in high-degree polynomial time) on a long line (ReDoS). Its test
  // runs on every line, in the drain and on each trim's dropped run, so it is refused before it applies. Each group
  // carries two flags: U (its body holds an unbounded quantifier, directly or in a nested group) and M (that body is
  // already multiplied by an exact {2}). A group with U is refused when it is repeated without bound, as in
  // (a+)+, (x*)* or (?:a\d+){2,}, or by an exact {n} of 3 or more ((a*){25} ran 140 s on a 29-char line, (a+){4}$ 25 s
  // on a 201-char one). An exact {2} is O(n^2) and passes once, but it sets M on the enclosing group, and
  // a second multiplying repeat of a group with M is refused: ((a+){2}){2} is (a+){4}, ((a+){4}){4} is (a+){16}. Escapes
  // and character classes are skipped. Alternation overlap ((a|a)+) is refused by overlapRepeat below, and sibling terms
  // (\s.*.*z) are timed by slowRegex.
  function nestedQuantifier(src) {
    const U = 1, M = 2;
    const rep = i => src[i] === '*' || src[i] === '+' || (src[i] === '{' && /^\{\d+,\d*\}/.test(src.slice(i, i + 24)));
    const flags = [0];   // per open group
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') { i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
      if (c === '(') { flags.push(0); continue; }
      if (c === ')' && flags.length > 1) {
        const f = flags.pop();
        if (f & U) {
          if (rep(i + 1)) return true;
          const ex = /^\{(\d+)\}/.exec(src.slice(i + 1, i + 25));
          const n = ex ? Number(ex[1]) : 1;
          if (n >= 3 || (n === 2 && (f & M))) return true;
          flags[flags.length - 1] |= U | (n === 2 ? M : f & M);
        }
        continue;
      }
      if (rep(i)) flags[flags.length - 1] |= U;
    }
    return false;
  }
  // ---- The regex guard (P7a, follow-up F4) ----
  // nestedQuantifier (above) refuses exponential nesting. Two more shapes freeze a WebKit or V8 regex on one long line:
  // (1) a group repeated without bound, or often enough (see BOUNDED_LOG2_MAX), whose alternatives overlap (one is a prefix of another, atom by atom,
  //     under the term's own case flag) or can match '' ((a|aa)+, (\w|\d)+, (.|\s)*, (a|)+): exponential, so it is refused here,
  //     before anything runs (one RegExp.test cannot be interrupted). {n} and {n,m} count by their upper bound, multiplied by the bounds of the bounded repeats around the group
  //     (((a|aa){8}){8} is (a|aa){64}), unbounded when a group around it is, and added up across consecutive groups
  //     ((a|aa){7}(a|aa){7}z); and
  // (2) polynomial backtracking (\s.*.*.*z, \w+\w+z, (.*){2}z, a.*a.*z): its cost depends on the lines, so slowRegex below
  //     times it on the session's own lines when a filter is applied (the page injects the clock). A leading .* is not
  //     among them: compile drops it from the regex a line is tested with (below), so .*.*.*z runs as z.
  // Atoms are compared by the characters they match among ALPHA (every code unit U+0000 to U+00FF, which covers \0, \cX and
  // octal escapes, plus the line terminators U+2028 and U+2029 and U+4E2D) and every character the regex source writes: a
  // literal, an escaped character (\ü), or a \uXXXX, \u{...} or \xXX escape, decoded. That is exact for literals, escapes
  // and the dot, and for a class whenever it shares an end point or a listed character with the other atom; a character
  // matched by neither the source nor ALPHA is not compared. A group or a quantified atom inside an alternative is not
  // judged here; slowRegex times it.
  const ALPHA = (() => { const a = []; for (let c = 0; c < 0x100; c++) a.push(String.fromCharCode(c)); a.push('\u2028', '\u2029', '\u4e2d'); return a; })();
  const skipClass = (src, i, to) => { i++; if (src[i] === '^') i++; if (src[i] === ']') i++; while (i < to && src[i] !== ']') { if (src[i] === '\\') i++; i++; } return i; };
  // ALPHA plus every character src writes as a literal, with \uXXXX, \u{...} and \xXX decoded (UTF-16 code units, as the
  // regex engine reads a pattern without the u flag). Built once per overlapRepeat call.
  function alphaOf(src) {
    const a = new Set(ALPHA);
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== '\\') { a.add(src[i]); continue; }
      const rest = src.slice(i + 1, i + 12), m = /^u\{([0-9a-fA-F]{1,6})\}/.exec(rest) || /^u([0-9a-fA-F]{4})/.exec(rest) || /^x([0-9a-fA-F]{2})/.exec(rest);
      if (m) { const cp = parseInt(m[1], 16); if (cp <= 0x10ffff) for (const u of String.fromCodePoint(cp)) a.add(u); i += m[0].length; }
      else { if (i + 1 < src.length) a.add(src[i + 1]); i++; }
    }
    return [...a];
  }
  // The atom at src[i]: { end, set, opt, q } (set: the `alpha` characters it matches; opt: it can match ''; q: it has a
  // quantifier), or null for a group, an anchor or anything not judged here.
  function atomAt(src, i, flags, alpha) {
    const c = src[i];
    let j;
    if (c === '(' || c === '^' || c === '$' || c === '|' || c === ')') return null;
    if (c === '\\') { const n = src[i + 1]; j = i + (n === 'x' ? 4 : n === 'u' ? 6 : n === 'c' ? 3 : 2); }
    else if (c === '[') j = skipClass(src, i, src.length) + 1;
    else j = i + 1;
    let re;
    try { re = new RegExp(`^(?:${src.slice(i, j)})$`, flags); } catch (e) { return null; }
    const set = new Set(alpha.filter(ch => re.test(ch)));
    let k = j, opt = false, q = false;
    if (src[k] === '?' || src[k] === '*') { opt = true; q = true; k++; }
    else if (src[k] === '+') { q = true; k++; }
    else if (src[k] === '{') { const m = /^\{(\d+)(,\d*)?\}/.exec(src.slice(k, k + 24)); if (m) { q = true; opt = m[1] === '0'; k += m[0].length; } }
    if (q && src[k] === '?') k++;
    return { end: k, set, opt, q };
  }
  // The top-level alternatives of src[from, to), as [start, end] pairs.
  function alternatives(src, from, to) {
    const out = []; let d = 0, s = from;
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') { i = skipClass(src, i, to); continue; }
      if (c === '(') d++; else if (c === ')') d--; else if (c === '|' && d === 0) { out.push([s, i]); s = i + 1; }
    }
    out.push([s, to]);
    return out;
  }
  // Every atom optional (or none): the alternative can match ''. `atom(i)` is the memoized atomAt of overlapRepeat.
  function canBeEmpty(atom, [from, to]) {
    for (let i = from; i < to;) { const x = atom(i); if (!x || !x.opt) return false; i = x.end; }
    return true;
  }
  // Do two alternatives overlap? Atom by atom, every pair shares a character and one alternative runs out first: the repeat can split a
  // run two ways (AMBIG). Two atoms that share no character: they do not (CLEAR). Anything ambiguous() cannot compare, met before
  // either of those: a group or an anchor (atomAt is null), \b or \B (matches no character), or a quantified atom (a?a, ab?aa): UNKNOWN.
  // An unknown pair may well overlap ((a|aa|a?a){7}z), so overlapRepeat counts it once the group holds a definite overlap.
  const CLEAR = 0, AMBIG = 1, UNKNOWN = 2;
  function ambiguous(atom, a, b) {
    for (let i = a[0], j = b[0]; ;) {
      if (i >= a[1] || j >= b[1]) return AMBIG;
      const x = atom(i), y = atom(j);
      if (!x || !y || x.q || y.q || !x.set.size || !y.set.size) return UNKNOWN;
      let share = false;
      for (const ch of x.set) if (y.set.has(ch)) { share = true; break; }
      if (!share) return CLEAR;
      i = x.end; j = y.end;
    }
  }
  // Every group of src with its repeat bound (ub: how many times it can repeat, Infinity without bound, 0 when it is not
  // repeated), its enclosing group (up, -1 at the top), where it opens (o) and where it ends, quantifier included (e), in the
  // order they open. A group still open at the end has i = -1.
  function groupsOf(src) {
    const groups = [], open = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') { i = skipClass(src, i, src.length); continue; }
      if (c === '(') {
        let b = i + 1;
        if (src[b] === '?') { const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(src.slice(b, b + 40)); b += m ? m[0].length : 1; }
        open.push(groups.length);
        groups.push({ o: i, b, i: -1, e: -1, ub: 0, up: open.length > 1 ? open[open.length - 2] : -1 });
        continue;
      }
      if (c !== ')' || !open.length) continue;
      const g = groups[open.pop()], n = src[i + 1];
      g.i = i;
      g.e = i + 1;
      g.ub = n === '*' || n === '+' ? Infinity : 0;
      if (n === '*' || n === '+' || n === '?') g.e++;
      if (n === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i + 1, i + 25));
        // {n,} is unbounded; {n} and {n,m} count by their upper bound.
        if (m) { g.ub = m[2] !== undefined && m[3] === '' ? Infinity : Number(m[2] === undefined ? m[1] : m[3]); g.e += m[0].length; }
      }
      if (g.e > i + 1 && src[g.e] === '?') g.e++;   // a lazy quantifier
    }
    return groups;
  }
  function overlapRepeat(src, flags) {
    const groups = groupsOf(src);
    let alpha = null;
    const memo = new Map();
    // Each atom is judged once per call: its start index fixes it (src, flags and alpha do not change between pairs).
    const atom = i => { let x = memo.get(i); if (x === undefined) { x = atomAt(src, i, flags, alpha); memo.set(i, x); } return x; };
    // The paths a bounded group adds up, as ub * log2(k), k the number of its alternatives that overlap (that can match '', or are
    // ambiguous with another one; k counts as at least 2, which keeps the plain cut-off for a lone alternative that can match ''),
    // summed over the consecutive groups that start where the one before
    // ends (a plain term between two groups ends the run; a repeated group without overlap does not, it may match the same
    // characters: (a|aa){4}(a|b){2}(a|aa){4}z). The sum is compared with BOUNDED_LOG2_MAX. A group is judged as soon as its own
    // cost, or the run it is in, reaches it. The run is kept per enclosing group (runs: parent index -> { sum, end }), so a repeated
    // group inside an overlapping group does not end the run of that group's siblings: (a|a(?:a){1}){7}(a|aa){7}z is 7 + 7.
    const runs = new Map();
    for (const g of groups) {
      if (g.i < 0 || !g.ub) continue;
      // The repeats around the group multiply its bound: ((a|aa){8}){8} is (a|aa){64}. An enclosing group repeated without
      // bound makes it unbounded: ((a|aa){8})+ is judged as (a|aa)+ (it ran 16 261 ms on 34 a's).
      let ub = g.ub;
      for (let p = g.up; p >= 0 && ub !== Infinity; p = groups[p].up) {
        if (groups[p].ub === Infinity) ub = Infinity;
        else if (groups[p].ub > 1) ub *= groups[p].ub;
      }
      const alts = alternatives(src, g.b, g.i);
      let r = runs.get(g.up);
      if (!r || g.o !== r.end) runs.set(g.up, r = { sum: 0, end: -1 });
      r.end = g.e;
      if (!alpha) alpha = alphaOf(src);
      // k: the alternatives that take part in at least one overlap (one that can match '', or one ambiguous with another).
      // An alternative in a pair ambiguous() cannot judge (UNKNOWN: a group, an anchor, \b / \B or a quantified atom met before a
      // shared or a distinct character) joins too, but only once the group holds a definite overlap: (a|aa|(?:a)|(?:aa)){7}z ran
      // 5.8 s on 'a'x200, (a|aa|a?a|a?aa|a?a?a){7}z 68 s on 'a'x32. Without one it adds nothing ((a+|b){3}: slowRegex times it).
      const part = new Array(alts.length).fill(false), unk = new Array(alts.length).fill(false);
      for (let x = 0; x < alts.length; x++) {
        if (canBeEmpty(atom, alts[x])) part[x] = true;
        for (let y = x + 1; y < alts.length; y++) {
          const r = ambiguous(atom, alts[x], alts[y]);
          if (r === AMBIG) part[x] = part[y] = true;
          else if (r === UNKNOWN) unk[x] = unk[y] = true;
        }
      }
      if (part.includes(true)) for (let x = 0; x < alts.length; x++) if (unk[x]) part[x] = true;
      const k = part.filter(Boolean).length;
      if (!k) continue;
      r.sum += ub * Math.log2(Math.max(2, k));
      if (r.sum >= GUARD.BOUNDED_LOG2_MAX) return true;
    }
    return false;
  }

  // slowRegex(q, lines, now) → null | { start, end, msg, reason, cause }: times the regex terms of q (q.regexes) on `lines`
  // (the session's own; [] uses SYNTH) before the filter applies, with `now` the page's clock (ms). cause says what
  // happened, reason adds what to do next, msg is the spec's "Invalid regex: …" frame.
  // - Only a term with a quantifier is timed: without one (error, ^E\/, err|fail) a regex is linear in the line.
  // - A clock that never moves (a test sandbox) cannot time anything: accepted.
  // - Every timing is a sum of single calls, each timed from the clock read before it. A busy machine preempts this thread
  //   every 0.4–0.8 ms (median) for up to 10 ms (p90; measured with 8–16 CPU burners on 10 cores), so any 2 ms window holds
  //   a pause, and three windows in a row hold three: window-level confirmation cannot remove load. A call that reads over
  //   GAP (GAP_MS, or two steps of a coarse clock) is run again, up to RETRIES times, and counts at its cheapest: a pause
  //   rarely hits the same call twice, a slow regex is slow every time. So the load drops out of each timing, refusals
  //   included, with no window repeated. Only a reading that is believed slow counts once: over CONCLUSIVE_MS (a 500 ms call
  //   must not run three times), or twice over PAUSE_MS; a reading over PAUSE_MS runs once more first, and one over any size
  //   after a cheap reading of the same string is a pause (call()).
  // - A coarse clock (WebKit's may step 1 ms): a timing lasts TICK_MS or four steps, whichever is longer, and counts one
  //   step less than it read, so its error leans toward accepting (up to 4/3 of a threshold), not toward refusing.
  // - Worst line: the session's longest line, repeated to at least MIN_LEN chars, timed on prefixes doubling from START (8
  //   chars; the first doubling is predicted as degree 4). It accepts early once even a degree-4 growth from there stays under
  //   LINE_MS. Otherwise it reads the degree from each doubling (1 below NOISE_MS, at most 4), never runs a step it predicts
  //   over STEP_MS, and extrapolates to the full length: over LINE_MS is refused.
  // - Mean: SAMPLE evenly spaced lines, timed call by call. It stops at TICK_MS of timed calls, or as soon as the running
  //   mean is over MEAN_US (after TICK_MS), or the probe's own time is over MEAN_BUDGET_MS. Over MEAN_US a line is
  //   refused (what the drain can afford at 27k lines/s). The mean times this session's lines over TOTAL_MS is refused:
  //   that is the refilter this apply would run, and TOTAL_MS is the longest freeze a filter change may cost (Decision D4).
  //   Before that, every distinct sample line and the longest line are projected together (projectLines): a line of another shape
  //   may be arbitrarily slower than the longest one, and a line is never run whole unless the projection covered it.
  // - Worst case of one term, in calls: a call runs at most 1 + RETRIES = 3 times (call()): a reading over PAUSE_MS runs twice
  //   unless it is over CONCLUSIVE_MS (once), and after a cheap reading of the same string any later reading is retried. A slow
  //   regex is therefore never run more than 3 times on a string, a step is never run when it is predicted over STEP_MS, and
  //   the wall-clock stop below is checked after every call. The one call nothing predicts is a cliff just past a prefix
  //   (a slow part that starts there): the prefixes double, so that call is as long as the regex takes on twice the prefix.
  //   A refusal extrapolated from a prefix is confirmed by timing that prefix once more (the worst-line probe and the projection),
  //   so a call that reads up to CONCLUSIVE_MS can run up to 3 + 3 times in one term; the wall-clock stop bounds the sum.
  // - The probe stops at APPLY_MS per call, counted as the sum of the timings it keeps (the cheapest of each call's
  //   retries), so a load pause does not spend it: the term it reaches past that is refused. A wall-clock stop at
  //   4 × APPLY_MS bounds the worst wait: it is checked after every call, inside each timing, the projection and the mean, and the
  //   probe is refused with the same copy as soon as it is passed.
  // Once per filter change, never per line, per flush or per row. Not a linear engine (P16).
  // BOUNDED_LOG2_MAX: a group repeated {n} or {n,m} times with overlapping alternatives is refused when ub * log2(k) >= 8, that
  // is when k^ub >= 256 paths (ub: the upper bound, k: the number of overlapping alternatives; consecutive groups add their sums). The cost
  // is the paths per start position times the line length, not the paths alone: (a|aa){15}z ran 35 469 ms on 'a'x200, while
  // (a|aa){8}z ran 5 ms on 'a'x1024. Two alternatives keep a cut-off of 8, three start at 6, four at 4: (a|aa){40}z took 41 s
  // on 40 a's, (\w|\d|[0-9a-f]){15}x 8.7 s on 17 digits. Legit bounded repeats (\d{1,3}, (ab|cd){2,20}) have no overlapping
  // alternatives and are untouched. A heuristic, not a linear engine.
  const GUARD = Object.freeze({ BOUNDED_LOG2_MAX: 8, LINE_MS: 20, MEAN_US: 5, TOTAL_MS: 2000, STEP_MS: 8, SAMPLE: 256, MIN_LEN: 1024, START: 8,
    TICK_MS: 2, NOISE_MS: 0.02, GAP_MS: 0.25, PAUSE_MS: 10, CONCLUSIVE_MS: 100, RETRIES: 2, MEAN_BUDGET_MS: 30, APPLY_MS: 100, MAX_CALLS: 100000 });
  const SYNTH = 'D/BluetoothGatt( 1234): onClientConnectionState() status=0 clientIf=7 device=DE:AD:BE:EF:00:42 mtu 517 handle 0x002a '
    + 'payload {"id": 42, "name": "left bud", "rssi": -61, "path": "/data/user/0/com.example.headset/files/log.txt"} '
    + 'took 12 ms, retry 3 of 5, 0123456789abcdef0123456789abcdef, uuid 6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NEXT = 'Make it more specific, for example with fewer .* or a ^ anchor';
  const QUANT = /[*+?{]/;   // a quantifier (a (?: group or an escaped \* is timed too: harmless)
  const group = n => String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');   // as shellPure.num
  const msgOf = m => (m == null || m.msg == null ? '' : String(m.msg));
  const degree = (t1, t2, l1, l2) => (t1 < GUARD.NOISE_MS ? 1 : Math.min(4, Math.max(1, Math.log2(t2 / t1) / Math.log2(l2 / l1))));
  // The clock's step in ms (the smaller of its first two moves), or 0 when it never moves in MAX_CALLS reads.
  function clockStep(now) {
    let a = now(), step = 0;
    for (let i = 0, seen = 0; i < GUARD.MAX_CALLS && seen < 2; i++) { const b = now(); if (b !== a) { step = seen++ ? Math.min(step, b - a) : b - a; a = b; } }
    return step;
  }
  // The cost (ms) of one re.test(s), timed from the clock read before it (`at.t`), so a run of calls loses no clock step.
  // While it reads over `gap` it is run again, up to RETRIES times, and the cheapest counts. How far a reading is believed
  // depends on what is known of this string (`prior`: the cheapest reading of the same string so far, or Infinity):
  // - A reading within a plausible pause (up to PAUSE_MS, or `gap` when that is larger) is always run again.
  // - Over that, with no cheap reading of this string yet, it is slow or paused: it runs once more, and counts at its cheapest
  //   (a pause is at most about 10 ms at p90, so one in ten is longer, and a longer one must not refuse a linear regex). Over
  //   CONCLUSIVE_MS it is slow and counts once (a 500 ms call must not run three times).
  // - With a cheap reading of this very string (`prior` within PAUSE_MS), a reading over the cap is a pause whatever its size:
  //   the string costs `prior`, so it is run again.
  function call(re, s, now, gap, at, prior = Infinity) {
    const cap = Math.max(gap, GUARD.PAUSE_MS), known = prior <= cap;
    let best = Infinity;
    for (let k = 0; k <= GUARD.RETRIES; k++) {
      re.test(s);
      const t = now(), r = t - at.t;
      at.t = t;
      if (r < best) best = r;
      if (best <= gap) break;
      if (!known && (k === 0 ? r > GUARD.CONCLUSIVE_MS : best > cap)) break;
    }
    return best;
  }
  // The wall-clock stop (4 × APPLY_MS from the start of the probe), checked on the clock read after each call: it makes the
  // probe's loops end, and slowRegex refuses with the same copy as the per-term check.
  const walled = (clk, at) => clk.walled || (at.t - clk.began > 4 * GUARD.APPLY_MS && (clk.walled = true));
  // One timing (ms a call) of re.test(s): calls until `tick` of their own time (the clock's, unless the caller needs less), at most
  // MAX_CALLS; one clock step less than read counts (a coarse clock's error leans toward accepting). The calls run the same
  // string, so a call that reads over the pause cap after cheaper ones is a pause (call()'s `prior`).
  function timeOnce(re, s, now, clk, tick = clk.tick) {
    const at = { t: now() };
    let n = 0, t = 0, ref = Infinity;
    do { const c = call(re, s, now, clk.gap, at, ref); if (c < ref) ref = c; t += c; clk.spent += c; n++; } while (t < tick && n < GUARD.MAX_CALLS && !walled(clk, at));
    return Math.max(0, t - clk.step) / n;
  }
  // The ms the worst of `lines` is predicted to cost on its whole length (0 when it is cheap), or the sum of one round when a round
  // is itself over LINE_MS. All the distinct lines over START chars are timed together, level by level, on their first `len` chars
  // doubling from START (a line shorter than `len` runs whole at that level and drops out), so the work of timing is shared by
  // every line: a coarse clock needs two steps of calls for each level, once and not once a line. A level is timed as rounds of one
  // call of each line until the clock has moved two steps (timeOnce's rule), a call counting as call() says. The cost of a level
  // is the sum of its round: it bounds the cost of any single line from above, and it does not depend on a clock that reads 0
  // for a line that is cheap. The degree is read from the lines still live at the next level (their cost at the level before, and
  // now), 4 until a timing is over NOISE_MS, so a cliff past a cheap prefix (0.0001 ms at 128 chars, 0.3 ms at 512) is not read as
  // linear. A step is never run when it is predicted over STEP_MS: the prediction over the longest line left is returned, and it
  // is refused when it is over LINE_MS. No line is accepted from a prefix: its slow part may start past any char ('dump:' + 300
  // base64 chars + 1 200 spaces is cheap up to 300 chars), and the prefixes double so that a cliff just past one costs a step the
  // size of that prefix's own, not four times it. When a call on START chars already costs over MEAN_US on average (after TICK_MS),
  // every line costs more: the projection stops there and clk.mean says so, and the mean refuses with that cost.
  function projectLines(re, lines, now, clk) {
    const tick = 2 * clk.step;
    let live = [...new Set(lines)].filter(s => s.length > GUARD.START), len = GUARD.START, d = 4, prev = 0, prevLen = 0;
    // One level: rounds of one call of each line, until the clock has moved two steps (and four rounds when that was cheap, so that a
    // line a clock step crossed once or twice by chance does not read as dear). null when the wall-clock stop passed, or the first
    // level is already over MEAN_US a call.
    const level = strs => {
      const acc = new Array(strs.length).fill(0), seen = new Array(strs.length).fill(Infinity), at = { t: now() };
      let el = 0, rounds = 0, calls = 0;
      do {
        for (let i = 0; i < strs.length; i++) {
          const c = call(re, strs[i], now, clk.gap, at, seen[i]);
          if (c < seen[i]) seen[i] = c;
          acc[i] += c; el += c; clk.spent += c; calls++;
          if (walled(clk, at)) return null;
          if (len === GUARD.START && el >= clk.tick && (el - clk.step) * 1000 / calls > GUARD.MEAN_US) { clk.mean = (el - clk.step) * 1000 / calls; return null; }
        }
        rounds++;
      } while ((el < tick || (rounds < 4 && el < 4 * tick)) && rounds * strs.length < GUARD.MAX_CALLS);
      return { acc, rounds, el };
    };
    // The cost of the worst of the lines `ids` of a level, ms a call: the larger of their mean (the sum of a round is exact to one
    // clock step, which is taken off) and the dearest single line (two steps off, a line that merely crossed a step reads 0). A line
    // the clock cannot see costs under two steps over the rounds, and doubling it (degree 4) stays under LINE_MS.
    const worst = (r, ids) => {
      const sum = Math.max(0, r.el - clk.step) / r.rounds, scale = r.el > 0 ? sum * r.rounds / r.el : 0;
      let m = ids.length ? scale * ids.reduce((n, i) => n + r.acc[i], 0) / r.rounds / ids.length : 0;
      for (const i of ids) m = Math.max(m, Math.max(0, r.acc[i] - 2 * clk.step) / r.rounds);
      return m;
    };
    while (live.length) {
      const strs = live.map(x => x.slice(0, len));
      let r = level(strs);
      if (!r) return 0;
      const all = live.map((x, i) => i), cont = all.filter(i => live[i].length > len), top = cont.reduce((m, i) => Math.max(m, live[i].length), 0);
      const look = rr => {
        const here = worst(rr, all), sub = worst(rr, cont);
        return { here, sub, d: prev && prev >= GUARD.NOISE_MS ? degree(prev, here, prevLen, len) : 4 };
      };
      let o = look(r);
      if (o.here > GUARD.LINE_MS) return o.here;
      if (!cont.length) return 0;
      const to = Math.min(len * 2, top);
      if (o.sub * Math.pow(to / len, o.d) > GUARD.STEP_MS) {   // that step never runs: the line is extrapolated to its whole length
        let ms = o.sub * Math.pow(top / len, o.d);
        if (ms > GUARD.LINE_MS) {   // a refusal is confirmed by timing the level again (a pause or a clock step that inflated it drops out)
          r = level(strs);
          if (!r) return 0;
          const o2 = look(r);
          if (o2.sub < o.sub) { o = o2; ms = o.sub * Math.pow(top / len, o.d); }
        }
        return ms;
      }
      prev = o.sub; prevLen = len; live = cont.map(i => live[i]); len = to;
    }
    return 0;
  }
  // The mean cost of a line of `sample`, in µs (one clock step less than read, as timeOnce): call by call, stopping early. The
  // lines are projected (projectLines, with the longest line) before any runs whole: one predicted over LINE_MS is not run
  // (clk.slowLine = the prediction in ms; the mean stops there). It also stops at the wall-clock stop (clk.walled).
  function meanUs(re, sample, now, clk) {
    const ms = projectLines(re, sample.concat(clk.base), now, clk);
    if (ms > GUARD.LINE_MS) { clk.slowLine = ms; return 0; }
    if (clk.walled) return 0;
    if (clk.mean > GUARD.MEAN_US) return clk.mean;
    const at = { t: now() }, t0 = at.t, seen = new Array(sample.length).fill(Infinity);
    let calls = 0, el = 0;
    const lo = () => Math.max(0, el - clk.step) * 1000 / Math.max(1, calls);
    pass: for (;;) {
      for (let i = 0; i < sample.length; i++) {
        const c = call(re, sample[i], now, clk.gap, at, seen[i]);
        if (c < seen[i]) seen[i] = c;
        el += c; clk.spent += c; calls++;
        if (walled(clk, at) || at.t - t0 > GUARD.MEAN_BUDGET_MS || (el >= clk.tick && lo() > GUARD.MEAN_US)) break pass;
      }
      if (el >= clk.tick || calls >= GUARD.MAX_CALLS) break;
    }
    return lo();
  }
  function slowRegex(q, lines, now) {
    const terms = q && q.regexes ? q.regexes.filter(r => QUANT.test(r.re.source)) : [];
    if (!terms.length) return null;
    const step = clockStep(now);
    if (!step) return null;
    const clk = { step, gap: Math.max(GUARD.GAP_MS, 2 * step), tick: Math.max(GUARD.TICK_MS, 4 * step), spent: 0, began: now(), walled: false, slowLine: 0, mean: 0 };
    const n = lines.length;
    let longest = '';
    for (let i = 0; i < n; i++) { const s = msgOf(lines[i]); if (s.length > longest.length) longest = s; }
    const base = longest || SYNTH, L = Math.max(base.length, GUARD.MIN_LEN);
    clk.base = base;
    let long = base;
    while (long.length < L) long += ' ' + base;
    const k = Math.min(n, GUARD.SAMPLE), sample = [];
    for (let i = 0; i < k; i++) sample.push(msgOf(lines[Math.floor(i * n / k)]));
    if (!sample.length) sample.push(SYNTH);
    const refuse = (r, cause, next = NEXT) => {
      const reason = `${cause}. ${next}`;
      return { start: r.start, end: r.end, cause, reason, msg: `Invalid regex: ${reason}. The last valid filter is still applied.` };
    };
    const wall = r => refuse(r, `Its regex terms take over ${GUARD.APPLY_MS} ms to check on these lines`, 'Use fewer regex terms');
    for (const r of terms) {
      if (clk.spent > GUARD.APPLY_MS || clk.walled || now() - clk.began > 4 * GUARD.APPLY_MS) return wall(r);
      // 8 chars first, and the first doubling is predicted as degree 4: nothing is known of the growth yet, and a first timing on
      // more chars can itself cost seconds (\w*\w*\w*\w*\w*\w*\w*\w*z: about 5 s on 32 chars).
      let len = Math.min(GUARD.START, L), t = timeOnce(r.re, long.slice(0, len), now, clk), d = 4, early = false, tp = 0, lp = 0;
      while (len < L) {
        if (clk.walled) return wall(r);
        if (t * Math.pow(L / len, 4) <= GUARD.LINE_MS) { early = true; break; }   // even quartic growth stays under LINE_MS
        const next = Math.min(L, len * 2);
        if (t * Math.pow(next / len, d) > GUARD.STEP_MS) break;                  // never run a step predicted over STEP_MS
        const t2 = timeOnce(r.re, long.slice(0, next), now, clk);
        tp = t; lp = len;
        d = degree(t, t2, len, next); t = t2; len = next;
      }
      if (clk.walled) return wall(r);
      let ms = early ? 0 : t * Math.pow(L / len, d);
      // A refusal extrapolated from a prefix (the step after it was predicted over STEP_MS, so it never ran) is confirmed by timing
      // that prefix again (unless it read over CONCLUSIVE_MS, which is slow, not paused): a pause that inflated the timing, or the degree read from it ((L/8)^4 of one paused 8-char call is
      // millions of ms), drops out; a slow regex is as slow the second time.
      if (ms > GUARD.LINE_MS && len < L && t <= GUARD.CONCLUSIVE_MS) {
        const t3 = timeOnce(r.re, long.slice(0, len), now, clk);
        if (clk.walled) return wall(r);
        if (t3 < t) { t = t3; if (lp) d = degree(tp, t, lp, len); ms = t * Math.pow(L / len, d); }
      }
      if (ms > GUARD.LINE_MS) return refuse(r, `It would take about ${group(ms)} ms on one of these lines and can freeze the viewer`);
      clk.slowLine = 0; clk.mean = 0;
      const us = meanUs(r.re, sample, now, clk);
      if (clk.walled) return wall(r);
      if (clk.slowLine > GUARD.LINE_MS) return refuse(r, `It would take about ${group(clk.slowLine)} ms on one of these lines and can freeze the viewer`);
      if (us > GUARD.MEAN_US) return refuse(r, `It takes about ${us.toFixed(1)} µs a line, over the ${GUARD.MEAN_US} µs a line the viewer allows`);
      const total = us * n / 1000;
      if (total > GUARD.TOTAL_MS) return refuse(r, `It would take about ${(total / 1000).toFixed(1)} s to filter these ${group(n)} lines`);
    }
    return null;
  }

  // The <mark>'s matcher for a regex term (buildMessageNodes calls exec once per row): its first non-empty hit, as legacy
  // marked it. /x*/ or \d* match '' at offset 0 first, so the plain RegExp would mark nothing. Literal terms keep their
  // RegExp: an escaped non-empty literal never matches ''. The 'g' copy is reset on every call, so no row sees another's state.
  // The skip over empty hits is bounded, per row: a pattern that matches '' at every offset and scans on from each one (.*x|, a
  // half-typed alternation) would cost O(length^2) a row, at every flush. A row gets about MARK_STEPS characters' worth of
  // attempts (at least 8, at most 256); past that it marks nothing, which is what a plain RegExp did.
  const MARK_STEPS = 16384;
  function firstNonEmpty(re) {
    const all = new RegExp(re.source, re.flags + 'g');
    return Object.freeze({ source: re.source, flags: re.flags, global: false, exec(s) {
      all.lastIndex = 0;
      let left = Math.max(8, Math.min(256, Math.floor(MARK_STEPS / (s.length || 1))));
      for (let m = all.exec(s); m !== null; m = all.exec(s)) {
        if (m[0] !== '') return m;
        if (--left <= 0) return null;
        all.lastIndex++;
      }
      return null;
    } });
  }
  // dev: value → the platforms it names: 'none', a platform, or a substring of a device's id or name (spaces and case
  // ignored). devices is the page's deviceInfo ({ android: { id, name }, ios: { id, name } }).
  function devBits(v, devices) {
    const s = String(v).toLowerCase().replace(/\s+/g, '');
    if (s === 'none') return 0;
    if (Object.prototype.hasOwnProperty.call(PLAT_BIT, s)) return PLAT_BIT[s];
    let bits = 0;
    for (const p of ['android', 'ios']) {
      const d = devices && devices[p];
      if (!d) continue;
      const id = String(d.id || '').toLowerCase();
      const name = String(d.name || '').toLowerCase().replace(/\s+/g, '');
      if ((id && id.includes(s)) || (name && name.includes(s))) bits |= PLAT_BIT[p];
    }
    return bits;
  }
  // One predicate from many: a(m) && b(m) && …, built once per query change. null when there is nothing to test.
  function allOf(preds) {
    if (!preds.length) return null;
    let f = preds[preds.length - 1];
    for (let i = preds.length - 2; i >= 0; i--) { const a = preds[i]; const b = f; f = m => a(m) && b(m); }
    return f;
  }

  // compile(tokens, { case, regex }, devices) → { q, error }. Spec "Combination": the same key ORs, different keys AND,
  // every negation must not match, every text term must match. q = { key, gate, lvOk, levels, plats, rest, mark,
  // hasText, usesDevNames, tags, chipsOnly }: levels is the 6-bit level mask, plats the platform bits (1 android,
  // 2 ios), rest the non-level, non-platform tests (null when none), mark the first positive text term's RegExp for
  // the <mark> (null when none), tags the tag tokens as [value, negated], chipsOnly whether every token is a level,
  // dev or plat token. key changes exactly when the filter does: a recompile with an equal key needs no refilter.
  // regexes: every regex term ({ re, start, end }, negated ones included), what slowRegex times before the filter applies.
  function compile(tokens, opts, devices) {
    const mc = !!(opts && opts.case);
    const rx = !!(opts && opts.regex);
    let lvPos = 0; let lvAny = false; let lvNeg = 0;
    const plat = { dev: [0, false, 0], plat: [0, false, 0] };   // [positive bits, any positive, negative bits]
    const tag = [[], []]; const app = [[], []]; const pid = [[], []];   // [positive values, negative values]
    const text = [];   // [test RegExp, negated, from a regex (a /regex/ token, or a word under .*), the RegExp as typed]
    const regexes = [];   // { re, start, end } per regex term (slowRegex)
    const tagList = [];   // [value as typed, negated], for the empty tile's causes
    let usesDevNames = false;
    let hasWord = false;
    for (const t of tokens) {
      if (t.k === 'level') {
        const mask = levelMask(t.v);
        if (typeof mask !== 'number') return { q: null, error: { start: t.start, end: t.end, msg: `Unknown level '${mask.bad}'. Use V, D, I, W, E or F, or W+ for W and above.` } };
        if (mask < 0) continue;
        if (t.neg) lvNeg |= mask; else { lvPos |= mask; lvAny = true; }
      } else if (t.k === 'dev' || t.k === 'plat') {
        const bits = t.k === 'dev' ? devBits(t.v, devices) : PLAT_BIT[t.v.toLowerCase()] || 0;
        if (t.k === 'dev' && !['none', 'android', 'ios'].includes(t.v.toLowerCase().replace(/\s+/g, ''))) usesDevNames = true;
        const s = plat[t.k];
        if (t.neg) s[2] |= bits; else { s[0] |= bits; s[1] = true; }
      } else if (t.k === 'tag' || t.k === 'app') {
        (t.k === 'tag' ? tag : app)[t.neg ? 1 : 0].push(t.v.toLowerCase());
        if (t.k === 'tag') tagList.push([t.v, t.neg]);
      } else if (t.k === 'pid') {
        pid[t.neg ? 1 : 0].push(Number(t.v));
      } else {
        if (t.v === '') continue;   // "" and // test nothing
        const isRe = t.k === 'regex' || (t.k === 'word' && rx);
        const src = isRe ? t.v : escRe(t.v);
        if (t.k === 'word') hasWord = true;
        let re;
        try { re = new RegExp(src, mc ? '' : 'i'); } catch (e) {
          return { q: null, error: { start: t.start, end: t.end, msg: `Invalid regex: ${reason(e)}. The last valid filter is still applied.` } };
        }
        if (isRe && nestedQuantifier(src)) {
          return { q: null, error: { start: t.start, end: t.end, msg: 'Invalid regex: Nested quantifiers such as (a+)+ can freeze the viewer. The last valid filter is still applied.' } };
        }
        if (isRe && overlapRepeat(src, re.flags)) {
          return { q: null, error: { start: t.start, end: t.end, msg: 'Invalid regex: Repeated alternatives that overlap, such as (a|aa)+, can freeze the viewer. The last valid filter is still applied.' } };
        }
        // A leading .* (or .*?) changes nothing a test can see (/.*x/ matches a line exactly when /x/ does: .* may match
        // nothing), but the engine retries it from every offset, O(n²) a line. Lines are tested without it; the <mark>
        // keeps the pattern as typed. Anchored (^.*x) and .+ are different patterns and stay.
        const bare = isRe ? src.replace(/^(?:\.\*\??)+/, '') : src;
        const test = bare === src ? re : new RegExp(bare, re.flags);
        // The <mark> runs on every rendered row, and a run of leading .* (.*.*.*error) costs O(d^k) there, d the characters after
        // the last hit (944 ms on a 1 021-char row, and the strip above hides it from slowRegex). One .* gives the same leftmost
        // hit and is linear: a run of lazy .*? stays lazy, any greedy one makes it greedy. The rest of the pattern is as typed.
        const lead = isRe ? /^(?:\.\*\??)+/.exec(src) : null;
        const markSrc = lead && lead[0].length > 3 ? (/^(?:\.\*\?)+$/.test(lead[0]) ? '.*?' : '.*') + src.slice(lead[0].length) : src;
        if (isRe) regexes.push({ re: test, start: t.start, end: t.end });
        text.push([test, t.neg, isRe, markSrc === src ? re : new RegExp(markSrc, re.flags)]);
      }
    }
    const levels = (lvAny ? lvPos : ALL_LEVELS) & ~lvNeg;
    const side = s => (s[1] ? s[0] : BOTH) & ~s[2];
    const plats = side(plat.dev) & side(plat.plat);

    // The tests, cheapest first: pid, tag, app, then the message.
    const preds = [];
    if (pid[0].length || pid[1].length) {
      const [pos, neg] = pid;
      // A pid is a number (live) or a numeric string (a file); anything else, '' and blank included, is no pid, so pid:0
      // does not match it (a loose == did: '' == 0).
      const num = p => (typeof p === 'number' ? p : typeof p === 'string' && /^\s*\d+\s*$/.test(p) ? Number(p) : NaN);
      preds.push(m => { const p = num(m.pid); for (const n of neg) if (p === n) return false; if (!pos.length) return true; for (const n of pos) if (p === n) return true; return false; });
    }
    if (tag[0].length || tag[1].length) {
      const [pos, neg] = tag;
      preds.push(m => { const t = m.tag.toLowerCase(); for (const v of neg) if (t.includes(v)) return false; if (!pos.length) return true; for (const v of pos) if (t.includes(v)) return true; return false; });
    }
    if (app[0].length || app[1].length) {
      // iOS lines carry no package: app:com.example.headset matches when the tag contains 'headset' (the last dotted segment).
      const seg = v => v.slice(v.lastIndexOf('.') + 1);
      const [pos, neg] = app.map(list => list.map(v => [v, seg(v)]));
      const hit = (m, [v, s]) => (m.app ? m.app.toLowerCase().includes(v) : m.platform === 'ios' && s !== '' && m.tag.toLowerCase().includes(s));
      preds.push(m => { for (const v of neg) if (hit(m, v)) return false; if (!pos.length) return true; for (const v of pos) if (hit(m, v)) return true; return false; });
    }
    for (const [re, neg] of text) preds.push(neg ? m => !re.test(m.msg) : m => re.test(m.msg));
    const rest = allOf(preds);

    const lvOk = [0, 1, 2, 3, 4, 5].map(k => (levels & (1 << k)) !== 0);
    const plOk = { android: (plats & 1) !== 0, ios: (plats & 2) !== 0 };
    const gate = rest === null
      ? m => { const k = LV[m.lvl]; return k >= 0 && plOk[m.platform] === true ? k : -1; }
      : m => { const k = LV[m.lvl]; return k >= 0 && plOk[m.platform] === true && rest(m) ? k : -1; };
    const firstPos = text.find(([, neg]) => !neg);
    const hasText = text.length > 0;
    const live = tokens.filter(t => !(t.k === 'level' && levelMask(t.v) === -1));
    const key = `${serialize(live)}\u0000${hasText ? (mc ? 'C' : 'c') : ''}${hasWord ? (rx ? 'R' : 'r') : ''}\u0000${plats}`;
    const chipsOnly = tokens.every(t => t.k === 'level' || t.k === 'dev' || t.k === 'plat');
    const mark = firstPos ? (firstPos[2] ? firstNonEmpty(firstPos[3]) : firstPos[3]) : null;
    return { q: { key, gate, lvOk, levels, plats, rest, mark, hasText, usesDevNames, tags: tagList, chipsOnly, regexes }, error: null };
  }

  // parse + compile: { q, error }. The first error wins; an invalid query is never half applied.
  function build(text, opts, devices) {
    const p = parse(text);
    if (p.errors.length) return { q: null, error: p.errors[0] };
    return compile(p.tokens, opts, devices);
  }

  // ---- Rewrites (spec "Chips and text are one model") ----

  // Removes the tokens drop(token, index) picks, with the spaces after each (before it, at the end of the text), and puts
  // `insert` in place of the first of them, or in front when none matched. Every other byte of the text is kept.
  function rewrite(text, drop, insert) {
    let out = String(text == null ? '' : text);
    const gone = parse(out).tokens.filter(drop);
    for (let j = gone.length - 1; j >= 0; j--) {
      let a = gone[j].start;
      let b = gone[j].end;
      if (j === 0 && insert) return out.slice(0, a) + insert + out.slice(b);   // in place: its spacing stays
      let e = b;
      while (e < out.length && isWs(out[e])) e++;
      if (e > b) b = e; else while (a > 0 && isWs(out[a - 1])) a--;
      out = out.slice(0, a) + out.slice(b);
    }
    if (!insert) return out;
    return out ? `${insert} ${out}` : insert;
  }
  // The level chips: one level token for `mask` (levelText), none when all six are on.
  const setLevels = (text, mask) => rewrite(text, t => t.k === 'level', levelText(mask));
  // The device chips: one dev: token per platform set (one device per platform until the multi-device backend).
  const setDevices = (text, plats) => rewrite(text, t => t.k === 'dev' || t.k === 'plat', ['dev:none', 'dev:android', 'dev:ios', ''][plats & 3]);
  // A token chip's ×: token i of parse(text).tokens goes.
  const removeToken = (text, i) => rewrite(text, (t, j) => j === i, '');
  // The index of the first token with tok's kind, value and sign, or -1 (the text may have changed since a chip was drawn).
  const indexOf = (text, tok) => parse(text).tokens.findIndex(t => t.k === tok.k && t.v === tok.v && t.neg === tok.neg);
  // The token whose source range holds the caret (its end included), or -1: a chip's body puts the caret there (Open item 6).
  const tokenAt = (text, caret) => parse(text).tokens.findIndex(t => t.start <= caret && caret <= t.end);

  // The empty tile's tag causes (spec "Log grid", no matches), read from the counts, never from the lines. notTag: a
  // negated tag that every retained line carries; tag: the first positive tag when no retained line carries any of the
  // positive ones. hits(v) is the number of retained lines whose tag contains v; total the retained lines.
  function tagCause(q, hits, total) {
    let notTag = '';
    for (const [v, neg] of q.tags) if (neg && total > 0 && hits(v) === total) { notTag = v; break; }
    const pos = q.tags.filter(([, neg]) => !neg);
    const tag = pos.length && pos.every(([v]) => hits(v) === 0) ? pos[0][0] : '';
    return { notTag, tag };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.query = Object.freeze({ parse, serialize, compile, build, levelMask, levelText, setLevels, setDevices, removeToken, indexOf, tokenAt,
    tagCause, overlapRepeat, slowRegex, GUARD, SYNTH, LV, KEYS: Object.freeze(KEYS.slice()) });
})(typeof window !== 'undefined' ? window : globalThis);
