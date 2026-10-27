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

  // An unknown key one edit (or one swap) away from a known key with the same first letter is a typo the spec names
  // ("Unknown field 'tg'. Did you mean tag:?"); any other `word:` is a bare word, so 'Exception:', 'id:' and URLs
  // still search the message.
  function oneEdit(a, b) {
    if (a === b || a[0] !== b[0] || Math.abs(a.length - b.length) > 1) return false;
    if (a.length === b.length) {
      const d = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
      return d.length === 1 || (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]);
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < s.length && s[i] === l[i]) i++;
    return s.slice(i) === l.slice(i + 1);
  }
  const nearKey = k => KEYS.find(K => oneEdit(k, K)) || null;

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
  // token's source range, the leading '-' included. A key with nothing after the colon ('tag:') is still being typed:
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
        if (end === at) continue;   // 'tag:' with nothing after it: still being typed
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

  const escQ = v => v.replace(/[\\"]/g, '\\$&');
  const quoteIf = v => (/[\s"]/.test(v) || v === '' ? `"${escQ(v)}"` : v);
  // serialize(tokens) → the canonical text: one space between tokens, keys in lower case, a value quoted only when it
  // holds whitespace or a quote. parse(serialize(tokens)) gives the same tokens (ranges aside).
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
  // hasText, usesDevNames }: levels is the 6-bit level mask, plats the platform bits (1 android, 2 ios), rest the
  // non-level, non-platform tests (null when none), mark the first positive text term's RegExp for the <mark> (null
  // when none). key changes exactly when the filter does: a recompile with an equal key needs no refilter.
  function compile(tokens, opts, devices) {
    const mc = !!(opts && opts.case);
    const rx = !!(opts && opts.regex);
    let lvPos = 0; let lvAny = false; let lvNeg = 0;
    const plat = { dev: [0, false, 0], plat: [0, false, 0] };   // [positive bits, any positive, negative bits]
    const tag = [[], []]; const app = [[], []]; const pid = [[], []];   // [positive values, negative values]
    const text = [];   // [RegExp, negated]
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
      } else if (t.k === 'pid') {
        pid[t.neg ? 1 : 0].push(Number(t.v));
      } else {
        if (t.v === '') continue;   // "" and // test nothing
        const src = t.k === 'regex' || (t.k === 'word' && rx) ? t.v : escRe(t.v);
        if (t.k === 'word') hasWord = true;
        let re;
        try { re = new RegExp(src, mc ? '' : 'i'); } catch (e) {
          return { q: null, error: { start: t.start, end: t.end, msg: `Invalid regex: ${reason(e)}. The last valid filter is still applied.` } };
        }
        text.push([re, t.neg]);
      }
    }
    const levels = (lvAny ? lvPos : ALL_LEVELS) & ~lvNeg;
    const side = s => (s[1] ? s[0] : BOTH) & ~s[2];
    const plats = side(plat.dev) & side(plat.plat);

    // The tests, cheapest first: pid, tag, app, then the message.
    const preds = [];
    if (pid[0].length || pid[1].length) {
      const [pos, neg] = pid;
      // == on purpose: a pid read from a file can be a numeric string.
      preds.push(m => { const p = m.pid; for (const n of neg) if (p == n) return false; if (!pos.length) return true; for (const n of pos) if (p == n) return true; return false; });
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
    return { q: { key, gate, lvOk, levels, plats, rest, mark: firstPos ? firstPos[0] : null, hasText, usesDevNames }, error: null };
  }

  // parse + compile: { q, error }. The first error wins; an invalid query is never half applied.
  function build(text, opts, devices) {
    const p = parse(text);
    if (p.errors.length) return { q: null, error: p.errors[0] };
    return compile(p.tokens, opts, devices);
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.query = Object.freeze({ parse, serialize, compile, build, levelMask, levelText, LV, KEYS: Object.freeze(KEYS.slice()) });
})(typeof window !== 'undefined' ? window : globalThis);
