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
  // word '/foo/i'. The flags are 1 to 4 distinct letters of gimsuy after a body with no unescaped '/', so paths such as
  // '/usr/lib', '/tmp/x', '/proc/sys' or '/a/b/c' stay words. [, body, repeated letter, flags]
  const REGEX_FLAGS = /^\/((?:\\[\s\S]|[^\\/])+)\/(?![a-z]*([a-z])[a-z]*\2)([gimsuy]{1,4})$/;

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
      const flags = src[j] === '/' ? REGEX_FLAGS.exec(src.slice(j, end)) : null;
      if (flags) err(start, end, `Regex flags are not supported. Use /${flags[1]}/, and Aa for match case.`);
      tokens.push({ k: 'word', v: src.slice(j, end), neg, start, end });
      i = end;
    }
    return { tokens, errors };
  }

  // Escape exactly what quoted() unescapes: a quote, and a backslash that precedes a quote, a backslash or the closing
  // quote. Any other backslash is written as it is, so '\/ ' inside a value stays '\/ ' and the regexEnd scan, which skips
  // the character after a backslash, sees the same pairs the parser did.
  const escQ = v => v.replace(/"|\\(?=["\\]|$)/g, '\\$&');
  // A value ending in '/' is quoted too: unquoted, that '/' could close a leading '/word' regex when the text is re-parsed.
  const quoteIf = v => (/[\s"]/.test(v) || v === '' || v.endsWith('/') ? `"${escQ(v)}"` : v);
  // serialize(tokens) → the canonical text: one space between tokens, keys in lower case, a value quoted only when it
  // is empty, holds whitespace or a quote, or ends in '/'. parse(serialize(tokens)) gives the same tokens (ranges aside).
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
  // A regex term that can backtrack exponentially on a long line (ReDoS): a group holding an unbounded quantifier that
  // is itself repeated, as in (a+)+, (x*)* or (?:a\d+){2,}. Its test runs on every line, in the drain and on each trim's
  // dropped run, so it is refused before it applies. Escapes and character classes are skipped; a small exact repeat such
  // as {3} is bounded, but {5} or more of such a group is refused too ((a*){25} ran 140 s on a 29-char line).
  // Alternation overlap such as (a|a)+ is not detected.
  function nestedQuantifier(src) {
    const rep = i => src[i] === '*' || src[i] === '+' || (src[i] === '{' && /^\{\d+,\d*\}/.test(src.slice(i, i + 24)));
    const inner = [false];   // per open group: whether its body repeats without bound
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') { i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
      if (c === '(') { inner.push(false); continue; }
      if (c === ')' && inner.length > 1) {
        if (inner.pop()) { if (rep(i + 1) || /^\{(?:[5-9]|\d{2,})\}/.test(src.slice(i + 1, i + 25))) return true; inner[inner.length - 1] = true; }
        continue;
      }
      if (rep(i)) inner[inner.length - 1] = true;
    }
    return false;
  }
  // The <mark>'s matcher for a regex term (buildMessageNodes calls exec once per row): its first non-empty hit, as legacy
  // marked it. /x*/ or \d* match '' at offset 0 first, so the plain RegExp would mark nothing. Literal terms keep their
  // RegExp: an escaped non-empty literal never matches ''. The 'g' copy is reset on every call, so no row sees another's state.
  function firstNonEmpty(re) {
    const all = new RegExp(re.source, re.flags + 'g');
    return Object.freeze({ source: re.source, flags: re.flags, global: false, exec(s) {
      all.lastIndex = 0;
      for (let m = all.exec(s); m !== null; m = all.exec(s)) { if (m[0] !== '') return m; all.lastIndex++; }
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
  function compile(tokens, opts, devices) {
    const mc = !!(opts && opts.case);
    const rx = !!(opts && opts.regex);
    let lvPos = 0; let lvAny = false; let lvNeg = 0;
    const plat = { dev: [0, false, 0], plat: [0, false, 0] };   // [positive bits, any positive, negative bits]
    const tag = [[], []]; const app = [[], []]; const pid = [[], []];   // [positive values, negative values]
    const text = [];   // [RegExp, negated, from a regex (a /regex/ token, or a word under .*)]
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
        text.push([re, t.neg, isRe]);
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
    const mark = firstPos ? (firstPos[2] ? firstNonEmpty(firstPos[0]) : firstPos[0]) : null;
    return { q: { key, gate, lvOk, levels, plats, rest, mark, hasText, usesDevNames, tags: tagList, chipsOnly }, error: null };
  }

  // parse + compile: { q, error }. The first error wins; an invalid query is never half applied.
  function build(text, opts, devices) {
    const p = parse(text);
    if (p.errors.length) return { q: null, error: p.errors[0] };
    return compile(p.tokens, opts, devices);
  }

  // P6a: the legacy filter bar as query text, so the old controls run through compile(). st = { search, case, regex,
  // tag, pid, levels (names), plats (platform names) }. The search box is one phrase (or one /regex/ in regex mode),
  // the Tag box one tag: token, the PID / App box pid:N when it is a number else app:, the level and platform toggles
  // one level: and one dev: token. → text, or null when the regex-mode search is not a valid regex.
  function fromLegacy(st) {
    const out = [];
    let mask = 0;
    for (const l of st.levels) if (LV[l] >= 0) mask |= 1 << LV[l];
    const lt = levelText(mask);
    if (lt) out.push(lt);
    const plats = new Set(st.plats);
    const a = plats.has('android');
    const i = plats.has('ios');
    if (!a || !i) out.push(a ? 'dev:android' : i ? 'dev:ios' : 'dev:none');
    if (st.tag) out.push(`tag:"${escQ(st.tag)}"`);
    if (st.pid) out.push(/^\d+$/.test(st.pid) ? `pid:${st.pid}` : `app:"${escQ(st.pid)}"`);
    if (st.search) {
      if (st.regex) {
        try { new RegExp(st.search); } catch (e) { return null; }
        out.push(`/${st.search.replace(/\\[\s\S]|\//g, x => (x === '/' ? '\\/' : x))}/`);
      } else out.push(`"${escQ(st.search)}"`);
    }
    return out.join(' ');
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
  ALV.query = Object.freeze({ parse, serialize, compile, build, levelMask, levelText, fromLegacy, setLevels, setDevices, removeToken, indexOf, tokenAt,
    tagCause, LV, KEYS: Object.freeze(KEYS.slice()) });
})(typeof window !== 'undefined' ? window : globalThis);
