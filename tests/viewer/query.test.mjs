// The query grammar (viewer/assets/js/query.js, roadmap P6): one table row per spec "Query grammar" row, the edge rows
// the architects named, the error copy, a seeded round-trip property over tokens, a text fuzz, and what compile() keeps.
// Loaded in an EMPTY vm context, so any page, storage or timer use at load throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ASSETS, read, loadPureModule, pageScriptSrcs, rng } from './_load.mjs';

const SRC = read(path.join(ASSETS, 'js', 'query.js'));
const Q = loadPureModule('query.js').query;
// Tokens without their source ranges, as plain values of this realm (the vm context has its own Array and Object).
const shape = toks => Array.from(toks, t => ({ k: t.k, v: t.v, neg: t.neg }));
const toks = text => shape(Q.parse(text).tokens);
const errs = text => Array.from(Q.parse(text).errors, e => e.msg);
const T = (k, v, neg = false) => ({ k, v, neg });

test('query.js loads in an empty context, names no page, storage or timer API, and loads right after session.js', () => {
  assert.equal(typeof Q.parse, 'function');
  assert.ok(Object.isFrozen(Q));
  assert.doesNotMatch(SRC, /\b(document|window\.document|localStorage|sessionStorage|setTimeout|setInterval|requestAnimationFrame|performance)\b/);
  const srcs = pageScriptSrcs();
  assert.equal(srcs.indexOf('assets/js/query.js'), srcs.indexOf('assets/js/session.js') + 1);
});

test('parse: one row per spec grammar row', () => {
  const rows = [
    ['level:E', [T('level', 'E')]],
    ['level:error level:assert', [T('level', 'error'), T('level', 'assert')]],
    ['level:W+', [T('level', 'W+')]],
    ['level:D,I', [T('level', 'D,I')]],
    ['level:none dev:none', [T('level', 'none'), T('dev', 'none')]],
    ['tag:Bluetooth', [T('tag', 'Bluetooth')]],
    ['app:com.example.headset', [T('app', 'com.example.headset')]],
    ['pid:1645', [T('pid', '1645')]],
    ['dev:pixel dev:"iPhone 15"', [T('dev', 'pixel'), T('dev', 'iPhone 15')]],
    ['plat:android plat:ios', [T('plat', 'android'), T('plat', 'ios')]],
    ['-tag:chatty -noise', [T('tag', 'chatty', true), T('word', 'noise', true)]],
    ['"connection timeout"', [T('phrase', 'connection timeout')]],
    ['/time(out|d)/', [T('regex', 'time(out|d)')]],
    ['timeout', [T('word', 'timeout')]],
  ];
  for (const [text, want] of rows) {
    assert.deepEqual(toks(text), want, text);
    assert.deepEqual(errs(text), [], text);
  }
});

test('parse: edge rows (paths, colons, minus signs, pending keys, quotes, escapes, case, ranges)', () => {
  const rows = [
    ['/usr/lib', [T('word', '/usr/lib')]],                         // no closing slash before a space or the end: a word
    ['/a b/ c', [T('regex', 'a b'), T('word', 'c')]],              // a regex body may hold spaces
    ['/a\\/ b/', [T('regex', 'a\\/ b')]],                          // an escaped slash does not close it
    ['/[/]/', [T('regex', '[/]')]],
    ['foo:bar Exception: http://x', [T('word', 'foo:bar'), T('word', 'Exception:'), T('word', 'http://x')]],
    ['id:7 at:noon', [T('word', 'id:7'), T('word', 'at:noon')]],   // not one edit from a key with the same first letter
    ['-1 "-1" - x', [T('word', '1', true), T('phrase', '-1'), T('word', '-'), T('word', 'x')]],
    ['tag: level: -app:', []],                                     // a key still being typed is not applied
    ['tag:"', []], ['-tag:"', []], ['app:"', []], ['pid:"', []], ['dev:"', []], ['plat:"', []], ['level:"', []],   // an opening quote is still being typed
    ['tag:"" -app:"" pid:""', []],                                // so is an empty quoted value
    ['-tag:"Blue', [T('tag', 'Blue', true)]],
    ['tag:"Blue Tooth" app:"a \\"b\\" \\\\c"', [T('tag', 'Blue Tooth'), T('app', 'a "b" \\c')]],
    ['"unterminated phrase', [T('phrase', 'unterminated phrase')]],
    ['tag:"unterminated', [T('tag', 'unterminated')]],
    ['TAG:x Level:W+ PID:7', [T('tag', 'x'), T('level', 'W+'), T('pid', '7')]],
    ['  a\t\tb  ', [T('word', 'a'), T('word', 'b')]],
    ['"a"b', [T('phrase', 'a'), T('word', 'b')]],
    ['//', [T('regex', '')]],
    ['""', [T('phrase', '')]],
  ];
  for (const [text, want] of rows) assert.deepEqual(toks(text), want, text);
  assert.deepEqual(Array.from(Q.parse('ab -tag:"x y" /r/').tokens, t => [t.start, t.end]), [[0, 2], [3, 13], [14, 17]], 'ranges include the minus and the quotes');
});

test('parse: a key still being typed is never an error, and it hides nothing once compiled', () => {
  for (const text of ['tag:', 'tag:"', '-tag:"', 'app:"', 'pid:"', 'dev:"', 'plat:"', 'level:"', 'tag:""', '-tag:"" app:""']) {
    assert.deepEqual(errs(text), [], text);
    const { q, error } = Q.build(text, {}, {});
    assert.equal(error, null, text);
    assert.equal(q.key, Q.build('', {}, {}).q.key, `${text} is the empty filter`);
  }
});

test('parse: the spec\'s error copy, and the new copy for pid, plat and negated phrases or regexes', () => {
  assert.deepEqual(errs('tg:x'), ["Unknown field 'tg'. Did you mean tag:?"]);
  assert.deepEqual(errs('TG:x'), ["Unknown field 'TG'. Did you mean tag:?"]);
  assert.deepEqual(errs('pi:1 dv:a plt:ios'), ["Unknown field 'pi'. Did you mean pid:?", "Unknown field 'dv'. Did you mean dev:?", "Unknown field 'plt'. Did you mean plat:?"]);
  assert.deepEqual(errs('level:X'), ["Unknown level 'X'. Use V, D, I, W, E or F, or W+ for W and above."]);
  assert.deepEqual(errs('level:D,Q+'), ["Unknown level 'Q+'. Use V, D, I, W, E or F, or W+ for W and above."]);
  assert.deepEqual(errs('pid:abc'), ["PID 'abc' is not a number."]);
  assert.deepEqual(errs('plat:windows'), ["Unknown platform 'windows'. Use android or ios."]);
  assert.deepEqual(errs('-"x" -/y/'), ['Negated phrases and regexes are not supported. Use -word or -key:value.',
    'Negated phrases and regexes are not supported. Use -word or -key:value.']);
  const e = Q.parse('ok tg:x').errors[0];
  assert.deepEqual([e.start, e.end], [3, 7], 'an error carries the range of its token');
});

test('levelMask and levelText: names, W+, lists, none, and the canonical chip forms', () => {
  const m = v => Q.levelMask(v);
  assert.deepEqual(['E', 'error', 'assert', 'fatal', 'F', 'W+', 'warning+', 'D,I', 'd, i ,E', 'none', 'V+', ',', ''].map(m),
    [16, 16, 32, 32, 32, 56, 56, 6, 22, 0, 63, -1, -1]);
  assert.equal(m('W,X').bad, 'X');
  assert.equal(m('+').bad, '+');
  const rows = [[63, ''], [0, 'level:none'], [62, 'level:D+'], [60, 'level:I+'], [56, 'level:W+'], [48, 'level:E+'], [32, 'level:F'],
    [6, 'level:D,I'], [22, 'level:D,I,E'], [1, 'level:V'], [61, 'level:V,I,W,E,F']];
  for (const [mask, text] of rows) {
    assert.equal(Q.levelText(mask), text, String(mask));
    if (text) assert.equal(Q.levelMask(text.slice(6)), mask, text);
  }
});

test('serialize: canonical text, lower-case keys, quotes only where needed, escapes inside quotes', () => {
  const rows = [
    ['TAG:x   level:W+ "a b"', 'tag:x level:W+ "a b"'],
    ['tag:"plain"', 'tag:plain'],
    ['app:"a \\"b\\""', 'app:"a \\"b\\""'],
    ['tag:a\\b', 'tag:a\\b'],
    ['-tag:"x y" -w', '-tag:"x y" -w'],
    ['/a b/ "q\\\\"', '/a b/ "q\\\\"'],
    ['"unterminated', '"unterminated"'],
    ['/x "a\\/ "', '/x "a\\/ "'],                // a backslash before a slash is not doubled, or regexEnd would read the slash as a close
    ['/x tag:"a\\/ "', '/x tag:"a\\/ "'],
    ['tag:"a\\\\\\" b"', 'tag:"a\\\\\\" b"'],       // a backslash before a quote or a backslash is doubled
  ];
  for (const [text, want] of rows) assert.equal(Q.serialize(Q.parse(text).tokens), want, text);
});

// A seeded generator over the token domain parse() can produce: field values of any shape, phrases of any shape,
// regex bodies without an unescaped '/' before a space or the end, words that are not fields, phrases or regexes.
const CHARS = ['a', 'B', 'z', ' ', '"', '\\', '/', ':', '-', '.', 'é', 'İ', 'ß', '(', ')', '*', '+', ',', '1', '\t'];
const drawn = new Set();   // which CHARS entries the round trip drew, asserted below: a skewed PRNG once left most of them out
function genToken(r) {
  const str = (n, set = CHARS) => Array.from({ length: n }, () => { const c = set[r(set.length)]; if (set === CHARS) drawn.add(c); return c; }).join('');
  const kind = ['level', 'tag', 'app', 'pid', 'dev', 'plat', 'word', 'phrase', 'regex'][r(9)];
  const neg = r(3) === 0;
  if (kind === 'level') return T('level', ['E', 'W+', 'D,I', 'error', 'none', 'V,F', 'assert+'][r(7)], neg);
  if (kind === 'pid') return T('pid', String(r(99999)), neg);
  if (kind === 'plat') return T('plat', ['android', 'ios', 'IOS'][r(3)], neg);
  if (kind === 'tag' || kind === 'app' || kind === 'dev') return T(kind, str(1 + r(8)), neg);
  if (kind === 'phrase') return T('phrase', str(r(8)), false);
  if (kind === 'regex') {
    const body = str(r(8), ['a', 'b', ' ', '(', ')', '|', '.', '*', '\\/', '[/]', 'x/y']).replace(/\\$/, '');
    return T('regex', body, false);
  }
  let w = str(1 + r(6), ['a', 'b', 'é', '"', '\\', '.', ':', '1', '-', '/', '*']);
  if (/^[-"/]/.test(w) || /^[A-Za-z]+:/.test(w)) w = `x${w}`;
  return T('word', w, neg);
}

test('round trip: parse(serialize(tokens)) gives the tokens back, and serialize is idempotent (2 000 seeded cases)', () => {
  const r = rng(20261027);
  for (let n = 0; n < 2000; n++) {
    const tokens = Array.from({ length: 1 + r(5) }, () => genToken(r));
    const text = Q.serialize(tokens);
    const back = Q.parse(text);
    assert.deepEqual(shape(back.tokens), tokens, text);
    assert.equal(Q.serialize(back.tokens), text, text);
  }
  assert.deepEqual(CHARS.filter(c => !drawn.has(c)), [], 'every character in CHARS (quotes, backslash, slash, colon, dash, space, tab ...) reached a generated value');
});

test('fuzz: parse, serialize and build never throw, and valid text normalises to the same tokens (3 000 seeded strings)', () => {
  const r = rng(7);
  const parts = ['tag:', 'level:', '-', '"', '/', '\\', ' ', 'a', 'W+', ',', 'x:y', 'pid:', '1', 'dev:', '(', ')', 'tg:', '*', 'é'];
  for (let n = 0; n < 3000; n++) {
    const text = Array.from({ length: r(12) }, () => parts[r(parts.length)]).join('');
    const p = Q.parse(text);
    for (const opts of [{}, { case: true, regex: true }]) Q.build(text, opts, {});
    if (p.errors.length) continue;
    assert.deepEqual(toks(Q.serialize(p.tokens)), shape(p.tokens), JSON.stringify(text));
  }
});

test('round trip: parse output survives serialize and parse (explicit rows, then 20 000 seeded strings over / space \\ " a)', () => {
  const same = text => {
    const t1 = Q.parse(text);
    const out = Q.serialize(t1.tokens);
    assert.deepEqual(toks(out), shape(t1.tokens), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    assert.equal(Q.serialize(Q.parse(out).tokens), out, `idempotent: ${JSON.stringify(out)}`);
  };
  for (const text of ['/x "a\\/ "', '/x tag:"a\\/ "', '/x -tag:"\\/ \\\\" /y', 'a "b\\\\" /c "\\/ d"', 'tag:"\\\\" /z',
    '/x tag:"a/"', '/x -app:"a/" y', '/x dev:"b/"', '/foo tag:"a/i"']) same(text);
  const r = rng(99);
  const parts = ['/', ' ', '\\', '"', 'a', 'a', 'tag:', '-', '\\/ ', '\\"', '/ ', 'tag:"a/"', ' tag:"a/" ', 'i', 'g', '/i', 'a/i', ' tag:"a/i" ', '/gi'];
  for (let n = 0; n < 20000; n++) {
    const text = Array.from({ length: 1 + r(14) }, () => parts[r(parts.length)]).join('');
    if (Q.parse(text).errors.length === 0) same(text);
  }
});

// ---- compile(): what each row keeps ----
const L = o => ({ ts: '', pid: 57, tid: 0, tag: 'SpringBoard', app: '', lvl: 'INFO', msg: 'hello world', platform: 'ios', ...o });
const LINES = [
  L({ lvl: 'VERBOSE', platform: 'android', tag: 'chatty', app: 'system_server', pid: 1000, msg: 'gc freed 12MB' }),          // 0
  L({ lvl: 'DEBUG', platform: 'android', tag: 'BluetoothGatt', app: 'com.example.headset', pid: 1645, msg: 'onConnectionState timeout' }), // 1
  L({ lvl: 'INFO', platform: 'android', tag: 'bt_stack', app: 'com.android.bluetooth', pid: 52, msg: 'Connection timed out' }),        // 2
  L({ lvl: 'WARN', platform: 'ios', tag: 'bluetoothd', app: '', pid: 88, msg: 'pairing failed: TIMEOUT' }),                            // 3
  L({ lvl: 'ERROR', platform: 'ios', tag: 'headset(ExampleKit)', app: '', pid: 1645, msg: 'Error -1 while pairing' }),                 // 4
  L({ lvl: 'ASSERT', platform: 'ios', tag: 'SpringBoard', app: '', pid: 57, msg: 'FATAL EXCEPTION in main' }),                        // 5
  L({ lvl: 'BOGUS', platform: 'ios', msg: 'unknown level' }),                                                                         // 6
  L({ lvl: 'INFO', platform: 'windows', msg: 'unknown platform' }),                                                                    // 7
];
const DEVICES = { android: { id: 'R5CT1234', name: 'Pixel 8 Pro' }, ios: { id: '00008110-ABC', name: 'iPhone 15' } };
function kept(text, opts = {}, devices = DEVICES) {
  const { q, error } = Q.build(text, opts, devices);
  assert.equal(error, null, `${text}: ${error && error.msg}`);
  return LINES.map((m, i) => [m, i]).filter(([m]) => { const k = q.gate(m); return k >= 0 && q.lvOk[k]; }).map(([, i]) => i);
}

test('compile: each spec grammar row keeps exactly its lines', () => {
  const rows = [
    ['', [0, 1, 2, 3, 4, 5]],                       // unknown levels and platforms never show (as before P6)
    ['level:E', [4]], ['level:error', [4]], ['level:assert', [5]], ['level:F', [5]],
    ['level:W+', [3, 4, 5]], ['level:D,I', [1, 2]], ['level:none', []], ['dev:none', []],
    ['tag:blue', [1, 3]],                           // case-insensitive substring
    ['app:com.example.headset', [1, 4]],            // the iOS line whose tag holds 'headset' matches too
    ['app:bluetooth', [2, 3]],                      // no dot: the whole value is the segment ('bluetoothd' on iOS)
    ['pid:1645', [1, 4]], ['pid:16', []],           // exact
    ['dev:pixel', [0, 1, 2]], ['dev:"iPhone 15"', [3, 4, 5]], ['dev:iphone15', [3, 4, 5]], ['dev:r5ct', [0, 1, 2]], ['dev:android', [0, 1, 2]],
    ['plat:android', [0, 1, 2]], ['plat:ios', [3, 4, 5]],
    ['-tag:chatty', [1, 2, 3, 4, 5]], ['-timeout', [0, 2, 4, 5]],
    ['"timed out"', [2]], ['/time(out|d)/', [1, 2, 3]],
    ['timeout', [1, 3]],                            // a bare word is a case-insensitive substring
  ];
  for (const [text, want] of rows) assert.deepEqual(kept(text), want, text);
});

test('compile: Aa and .* (case follows Aa for every text term; .* makes bare words regexes, not phrases)', () => {
  assert.deepEqual(kept('timeout', { case: true }), [1]);
  assert.deepEqual(kept('TIMEOUT', { case: true }), [3]);
  assert.deepEqual(kept('/TIME/', { case: true }), [3]);
  assert.deepEqual(kept('time(out|d)', { regex: true }), [1, 2, 3]);
  assert.deepEqual(kept('time(out|d)'), [], 'without .* the parentheses are literal');
  assert.deepEqual(kept('"time(out|d)"', { regex: true }), [], 'a phrase stays literal under .*');
  assert.deepEqual(kept('-err.r', { regex: true }), [0, 1, 2, 3, 5], 'a negated word is a regex under .* too');
});

test('compile: the same key ORs, different keys AND, negations exclude, levels union', () => {
  assert.deepEqual(kept('tag:BluetoothGatt tag:bt_stack'), [1, 2]);
  assert.deepEqual(kept('tag:BluetoothGatt app:com.example.headset'), [1]);
  assert.deepEqual(kept('level:E level:W'), [3, 4]);
  assert.deepEqual(kept('app:com.example.headset level:E+'), [4]);
  assert.deepEqual(kept('pairing failed'), [3], 'two bare words must both match');
  assert.deepEqual(kept('level:W+ -level:F'), [3, 4]);
  assert.deepEqual(kept('-level:V'), [1, 2, 3, 4, 5]);
  assert.deepEqual(kept('dev:android plat:ios'), [], 'dev and plat intersect');
  assert.deepEqual(kept('dev:pixel dev:iphone'), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(kept('-dev:ios'), [0, 1, 2]);
  assert.deepEqual(kept('-pid:1645 -pid:57'), [0, 2, 3]);
  assert.deepEqual(kept('tag:blue -tag:gatt'), [3]);
  assert.deepEqual(kept('dev:nothing'), [], 'a device that matches nothing hides everything');
  assert.deepEqual(kept('"" //'), [0, 1, 2, 3, 4, 5], 'an empty phrase or regex tests nothing');
});

test('compile: gate is the level index of a line that passes all but the level filter, lvOk the level filter', () => {
  const { q } = Q.build('level:W+ tag:blue', {}, DEVICES);
  assert.deepEqual(LINES.map(m => q.gate(m)), [-1, 1, -1, 3, -1, -1, -1, -1], 'counts ignore the level filter: DEBUG line 1 still counts');
  assert.deepEqual([...q.lvOk], [false, false, false, true, true, true]);
  assert.deepEqual([q.levels, q.plats, q.rest === null], [56, 3, false]);
  const none = Q.build('', {}, DEVICES).q;
  assert.deepEqual([none.rest, none.mark, none.levels, none.plats, none.hasText], [null, null, 63, 3, false]);
  const proto = Q.build('', {}, {}).q;
  for (const lvl of ['constructor', '__proto__', 'toString', undefined]) assert.equal(proto.gate(L({ lvl })), -1, String(lvl));
  for (const platform of ['constructor', '__proto__', undefined]) assert.equal(proto.gate(L({ platform })), -1, String(platform));
});

test('compile: an invalid regex is an error with the spec copy, and nothing is half applied', () => {
  for (const [text, opts] of [['/time(/', {}], ['(x', { regex: true }]]) {
    const r = Q.build(text, opts, {});
    assert.equal(r.q, null);
    assert.match(r.error.msg, /^Invalid regex: .+\. The last valid filter is still applied\.$/, text);
    assert.doesNotMatch(r.error.msg, /Invalid regular expression/, 'the engine prefix is dropped');
  }
  assert.equal(Q.build('(x', {}, {}).error, null, 'without .* a bare word is literal');
  assert.deepEqual(Q.build('ok tg:x', {}, {}).error.msg, "Unknown field 'tg'. Did you mean tag:?");
});

test('compile: key is equal exactly when the filter is (spacing, quotes, Aa or .* with no term, an unresolved device)', () => {
  const key = (t, o = {}, d = DEVICES) => Q.build(t, o, d).q.key;
  assert.equal(key('tag:x  '), key('tag:"x"'));
  assert.equal(key('level:W+ tag:x', { case: true, regex: true }), key('level:W+ tag:x'), 'Aa and .* change nothing without text');
  assert.notEqual(key('a', { case: true }), key('a'));
  assert.equal(key('"a"', { regex: true }), key('"a"'), '.* changes nothing without a bare word');
  assert.notEqual(key('a', { regex: true }), key('a'));
  assert.equal(key('level:,'), key(''), 'a level token that lists nothing yet is not applied');
  assert.notEqual(key('dev:pixel'), key('dev:pixel', {}, {}), 'a device name that resolves differently is a different filter');
  assert.equal(Q.build('dev:pixel', {}, DEVICES).q.usesDevNames, true);
  assert.equal(Q.build('dev:ios dev:none', {}, DEVICES).q.usesDevNames, false);
});

test('compile: mark is the first positive text term, case-insensitive unless Aa', () => {
  const mark = (t, o) => Q.build(t, o, {}).q.mark;
  assert.equal(mark('tag:x', {}), null);
  assert.equal(mark('-skip "Time Out" /b+/', {}).exec('a time out b').index, 2);
  assert.equal(mark('"Time Out"', { case: true }).exec('a time out'), null);
  assert.equal(mark('a.c', {}).exec('abc a.c').index, 4, 'a literal word is escaped');
  assert.equal(mark('a', {}).global, false, 'no g flag: no lastIndex state between lines');
});

// ---- Rewrites (P6b): chips and text are one model ----

test('setLevels writes one canonical level token where the first stood, keeps every other byte, and drops it when all six are on', () => {
  const rows = [
    ['', 56, 'level:W+'],
    ['tag:x', 56, 'level:W+ tag:x'],
    ['tag:x  level:E   "a  b"', 6, 'tag:x  level:D,I   "a  b"'],
    ['level:E tag:x -level:F', 0, 'level:none tag:x'],
    ['tag:x level:E', 63, 'tag:x'],
    ['level:E tag:x', 63, 'tag:x'],
    ['  level:E', 63, ''],
    ['tag: level:W+', 62, 'tag: level:D+'],
  ];
  for (const [text, mask, want] of rows) assert.equal(Q.setLevels(text, mask), want, `${JSON.stringify(text)} → ${mask}`);
});

test('setDevices writes dev:android, dev:ios or dev:none in place of every dev: and plat: token, and nothing for both', () => {
  const rows = [
    ['tag:x', 1, 'dev:android tag:x'],
    ['dev:pixel tag:x plat:ios', 2, 'dev:ios tag:x'],
    ['tag:x dev:ios', 3, 'tag:x'],
    ['-dev:ios', 0, 'dev:none'],
  ];
  for (const [text, plats, want] of rows) assert.equal(Q.setDevices(text, plats), want, `${text} → ${plats}`);
});

test('removeToken, indexOf and tokenAt: by token index, the other tokens byte-identical; the caret on a token\'s range', () => {
  const text = 'level:W+  -tag:"chatty x"  /a b/ word';
  assert.equal(Q.removeToken(text, 1), 'level:W+  /a b/ word');
  assert.equal(Q.removeToken(text, 3), 'level:W+  -tag:"chatty x"  /a b/');
  assert.equal(Q.removeToken(text, 9), text, 'no such token: unchanged');
  assert.equal(Q.indexOf(text, { k: 'tag', v: 'chatty x', neg: true }), 1);
  assert.equal(Q.indexOf(text, { k: 'tag', v: 'chatty x', neg: false }), -1);
  assert.deepEqual([0, 8, 9, 10, 25, 26, 30, 33, 99].map(c => Q.tokenAt(text, c)), [0, 0, -1, 1, 1, -1, 2, 3, -1], 'a range includes its end');
  const r = rng(11);
  for (let n = 0; n < 500; n++) {
    const tokens = Array.from({ length: 2 + r(4) }, () => genToken(r));
    const text2 = Q.serialize(tokens);
    const i = r(tokens.length);
    assert.deepEqual(toks(Q.removeToken(text2, i)), tokens.filter((_, j) => j !== i), text2);
  }
});

test('chip rewrites round-trip: every level mask and platform set reads back from the text it writes', () => {
  for (let mask = 0; mask < 64; mask++) {
    const text = Q.setLevels('tag:x "y"', mask);
    assert.equal(Q.build(text, {}, {}).q.levels, mask, text);
    assert.equal(Q.setLevels(text, mask), text, 'idempotent');
  }
  for (const plats of [0, 1, 2, 3]) assert.equal(Q.build(Q.setDevices('a', plats), {}, {}).q.plats, plats);
});

test('tagCause: NOT tag:x that every retained line carries; tag:x when no retained line carries any positive tag', () => {
  const hits = { chatty: 10, bt: 0, kernel: 3 };
  const cause = text => ({ ...Q.tagCause(Q.build(text, {}, {}).q, v => hits[v.toLowerCase()] || 0, 10) });
  assert.deepEqual(cause('-tag:Chatty'), { notTag: 'Chatty', tag: '' });
  assert.deepEqual(cause('-tag:kernel'), { notTag: '', tag: '' });
  assert.deepEqual(cause('tag:bt'), { notTag: '', tag: 'bt' });
  assert.deepEqual(cause('tag:bt tag:kernel'), { notTag: '', tag: '' }, 'kernel lines match: tag:bt is not the cause');
  assert.deepEqual(cause('tag:bt tag:nope'), { notTag: '', tag: 'bt' });
  assert.deepEqual(cause('level:E'), { notTag: '', tag: '' });
  assert.deepEqual([Q.build('level:E dev:ios plat:ios', {}, {}).q.chipsOnly, Q.build('level:E x', {}, {}).q.chipsOnly], [true, false]);
});

// ---- Typed text (P6b): what the bar may apply on its 100 ms debounce ----

test('unknown keys: only a missing letter or a swap of a known key is "Did you mean"; log words one letter away search the message', () => {
  assert.deepEqual(errs('tg:x pi:1 ap:x de:a plt:ios leve:E tga:x pdi:1'), ["Unknown field 'tg'. Did you mean tag:?", "Unknown field 'pi'. Did you mean pid:?",
    "Unknown field 'ap'. Did you mean app:?", "Unknown field 'de'. Did you mean dev:?", "Unknown field 'plt'. Did you mean plat:?",
    "Unknown field 'leve'. Did you mean level:?", "Unknown field 'tga'. Did you mean tag:?", "Unknown field 'pdi'. Did you mean pid:?"]);
  const words = 'pin:3 pod:a ppid:1 apk:x apn:y dex:z play:on lebel:E apps:x id:7 Exception:';
  assert.deepEqual(errs(words), []);
  assert.deepEqual(toks(words).map(t => t.k), Array(11).fill('word'));
});

test('regex flags: "/foo/i" is reported with a hint, never searched as a word; paths stay words', () => {
  assert.deepEqual(errs('/foo/i -/a\\/b/gi'), ['Regex flags are not supported. Use /foo/, and Aa for match case.',
    'Regex flags are not supported. Use /a\\/b/, and Aa for match case.']);
  for (const p of ['/usr/lib', '/tmp/x', '/proc/sys', '/a/b/c', '/foo/', '/i']) assert.deepEqual(errs(p), [], p);
  assert.equal(Q.build('/foo/i', {}, {}).q, null, 'never applied');
});

test('regex flags (F2): only the flags people type after a regex (g, i, m, never m alone) are reported; URL and path tails made of other gimsuy letters stay words', () => {
  for (const p of ['/api/msg', '/img/gui', '/v1/sum', '/home/my', '/tmp/my', '/home/guy', '/sys/msg', '/dev/sg', '/var/is', '/data/mu', '/data/u', '/data/us', '/x/s', '/x/y', '/x/m']) {
    assert.deepEqual(errs(p), [], p);
    assert.deepEqual(toks(p).map(t => t.k), ['word'], p);
    assert.notEqual(Q.build(p, {}, {}).q, null, `${p} applies`);
  }
  assert.deepEqual(errs('/a/g /b/gi /c/im /d/gim /e/mig'), Array(5).fill(0).map((_, i) => `Regex flags are not supported. Use /${'abcde'[i]}/, and Aa for match case.`));
  assert.deepEqual(errs('/a/gg /a/ii'), [], 'a repeated letter is no flag set');
});

test('regex flags (F3): a flagged regex whose body holds spaces is reported too, never split into two words', () => {
  assert.deepEqual(errs('/time out/i'), ['Regex flags are not supported. Use /time out/, and Aa for match case.']);
  assert.deepEqual(errs('/connection (lost|reset)/i'), ['Regex flags are not supported. Use /connection (lost|reset)/, and Aa for match case.']);
  assert.deepEqual(errs('tag:x -/a \\/ b/gi y'), ['Regex flags are not supported. Use /a \\/ b/, and Aa for match case.']);
  assert.equal(Q.build('/connection (lost|reset)/i', {}, {}).q, null, 'never applied');
  // The report covers the whole flagged regex, so the next token parses on its own.
  const t = toks('/time out/i word');
  assert.deepEqual([t.length, t.at(-1).v], [2, 'word']);
  // No closing slash with flags, or a flag set that is no flag set: the words they always were.
  for (const p of ['/time out/ i', '/foo bar', '/var/log message', '/var/log msg/is', '/ab c/xy']) assert.deepEqual(errs(p), [], p);
});

test('nested quantifiers: a regex that can backtrack exponentially is refused before it applies; flat and bounded repeats pass', () => {
  const msg = 'Invalid regex: Nested quantifiers such as (a+)+ can freeze the viewer. The last valid filter is still applied.';
  for (const [text, opts] of [['/(a+)+$/', {}], ['/(x*)*y/', {}], ['/(?:a\\d+){2,}/', {}], ['/((a+)b)+/', {}], ['(\\w+\\s?)+$', { regex: true }], ['-(a+)*', { regex: true }], ['/(a*){25}/', {}], ['/((a+){4}){4}$/', {}], ['/(a+){4}$/', {}], ['/(a+){3}$/', {}], ['/((a+){2}){2}/', {}], ['/(((a+){2}){1}){2}/', {}], ['/((a+){2}b){2}/', {}], ['/((a+){2}b)+/', {}]]) {
    const r = Q.build(text, opts, {});
    assert.deepEqual([r.q, r.error && r.error.msg], [null, msg], text);
  }
  for (const [text, opts] of [['/(ab)+/', {}], ['/(a|b)+c/', {}], ['/a+b*/', {}], ['/(a{2}){3}/', {}], ['/([a+])+/', {}], ['/\\(a+\\)+/', {}], ['(a+)+', {}], ['/(ab){5}/', {}], ['/(a+){2}/', {}], ['/(a+){2}(b+){2}/', {}], ['/((a+){2}){1}/', {}], ['/((a+){1}){2}/', {}]]) {
    assert.equal(Q.build(text, opts, {}).error, null, text);
  }
  const { start, end } = Q.build('ok /(a+)+/', {}, {}).error;
  assert.deepEqual([start, end], [3, 10], 'the error carries the range of its token');
});

test('the <mark> takes the first non-empty hit of a regex term, as legacy did (a pattern such as /x*/ matches "" first)', () => {
  const mark = (t, o) => Q.build(t, o, {}).q.mark;
  const hit = (m, s) => { const r = m.exec(s); return r && [r.index, r[0]]; };
  assert.deepEqual(hit(mark('/x*/', {}), 'abxxc'), [2, 'xx']);
  assert.deepEqual(hit(mark('\\d*', { regex: true }), 'pid 12'), [4, '12']);
  assert.equal(hit(mark('/x*/', {}), 'abc'), null, 'only empty hits: no mark');
  assert.deepEqual(hit(mark('/x*/', {}), 'xab'), [0, 'x']);
  const m = mark('/b+/', {});
  assert.deepEqual([hit(m, 'abb'), hit(m, 'cb'), m.global], [[1, 'bb'], [1, 'b'], false], 'no state carried from one row to the next');
});

test('the <mark> scan is bounded (F6): a regex that matches "" at every offset and scans on from each one costs a fixed budget per row, never O(length^2)', () => {
  const mark = (t, o) => Q.build(t, o, {}).q.mark;
  const line = 'a'.repeat(4000);
  for (const [text, o] of [['.*x|', { regex: true }], ['/.*Exception|/', {}], ['/(?:.*x)?/', {}]]) {
    const m = mark(text, o);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 60; i++) assert.equal(m.exec(line), null, text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 150, `${text}: 60 rows of 4000 characters took ${ms} ms (unbounded: about 400 ms)`);
  }
  // Within the budget the first non-empty hit is still found, however many empty hits come before it ...
  const hit = (m, s) => { const r = m.exec(s); return r && [r.index, r[0]]; };
  assert.deepEqual(hit(mark('\\d*', { regex: true }), 'Connection failed after 3 retries'), [24, '3']);
  assert.deepEqual(hit(mark('\\d*', { regex: true }), 'x'.repeat(100) + '42'), [100, '42'], 'a short row: far more offsets than 16');
  // ... and a long row past the budget marks nothing (what P6a did) instead of stalling the flush.
  assert.equal(hit(mark('\\d*', { regex: true }), 'x'.repeat(100000) + '42'), null);
});

test('pid: a number or a numeric string is the line\'s pid; an empty or blank pid is none, so pid:0 does not match it', () => {
  const lines = [0, '0', '', ' ', null, undefined, '57 ', 57, 'x'].map(pid => L({ pid }));
  const keep = text => { const { q } = Q.build(text, {}, {}); return lines.map((m, i) => [m, i]).filter(([m]) => q.gate(m) >= 0).map(([, i]) => i); };
  assert.deepEqual(keep('pid:0'), [0, 1]);
  assert.deepEqual(keep('-pid:0'), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(keep('pid:57'), [6, 7]);
});

// ---- P7a: the regex guard (follow-up F4) ----

const S1_MSG = 'Invalid regex: Repeated alternatives that overlap, such as (a|aa)+, can freeze the viewer. The last valid filter is still applied.';

test('S1: a group repeated without bound whose alternatives overlap or can be empty is refused at compile time', () => {
  for (const re of ['(a|aa)+z', '(\\w|\\d)+z', '(.|\\s)*z', '(a|a)+', '(x|x?)+y', '(a|)+b', '(?:ab|a)*c', '(a|b|ab){2,}c',
    // line terminators are atoms too: \n and \r overlap \s, and one multi-line live message (a stack trace) would freeze the drain
    '(\\n|\\s)+x', '(\\s|\\r)*x', '(\\u2028|\\s)+x', '(\\u2029|\\s)+x']) {
    const r = Q.build(`/${re}/`, {}, {});
    assert.equal(r.q, null, re);
    assert.deepEqual([r.error.msg, r.error.start, r.error.end], [S1_MSG, 0, re.length + 2], re);
  }
  assert.equal(Q.build('(\\w|\\d)+z', { regex: true }, {}).error.msg, S1_MSG, 'a word under .* is a regex term too');
});

test('S1 passes common log regexes', () => {
  // Not \d{1,3}(\.\d{1,3}){3}: nestedQuantifier (unchanged) already refuses a quantified group that holds a quantifier,
  // before S1 runs. S1 neither widens nor narrows that rule, so the unrolled dotted quad stands in for it.
  const pass = ['(POST|PUT)+', '(ab|ac)+', '(foo|bar)+', '(a|b)+c', '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}', '([0-9a-f]{2}:){5}[0-9a-f]{2}', 'time(out)?\\s+\\d+',
    '(error|fail|timeout|disconnect)', '\\bconn(ected|ecting)\\b', '(a+){2}', '^\\[(\\w+)\\]\\s+(.*)$', 'gatt.*mtu', 'foo.*bar.*baz.*qux',
    'status=\\d+.*handle', '(?<=id=)\\d+', '(?!foo)bar', '(\\w)\\1', '[A-Z]\\w+Exception', '0x[0-9a-f]+', '(a|b){3}'];
  for (const re of pass) assert.equal(Q.build(`/${re}/`, {}, {}).error, null, re);
  assert.equal(Q.overlapRepeat('(a|aa)+', 'i'), true);
  assert.equal(Q.overlapRepeat('(A|b)+', ''), false, 'case-sensitive: A and b share nothing');
  assert.equal(Q.overlapRepeat('(A|a)+', 'i'), true, 'case-insensitive: A and a overlap');
});

test('compile exposes q.regexes: every /regex/ token and word under .*, negated ones included; literals are not regexes', () => {
  const q = Q.build('tag:x "lit" /a b/ -c word', { regex: true }, {}).q;
  assert.deepEqual(Array.from(q.regexes, r => [r.re.source, r.start, r.end]), [['a b', 12, 17], ['c', 18, 20], ['word', 21, 25]]);
  assert.equal(Q.build('plain "words"', {}, {}).q.regexes.length, 0);
});

test('a leading .* is dropped from the regex a line is tested with (same result), and kept in the mark', () => {
  const q = Q.build('/.*err(or)?/', {}, {}).q;
  assert.equal(q.regexes[0].re.source, 'err(or)?');
  assert.equal(q.gate({ lvl: 'INFO', platform: 'ios', tag: '', app: '', pid: 1, msg: 'x error y' }), 2);
  assert.equal(q.gate({ lvl: 'INFO', platform: 'ios', tag: '', app: '', pid: 1, msg: 'nothing' }), -1);
  assert.equal(q.mark.source, '.*err(or)?', 'the <mark> highlights the pattern as typed');
  assert.equal(Q.build('/.*?x/', {}, {}).q.regexes[0].re.source, 'x', 'lazy too');
  assert.equal(Q.build('/^.*x/', {}, {}).q.regexes[0].re.source, '^.*x', 'anchored: a different pattern, kept');
  assert.equal(Q.build('/.+x/', {}, {}).q.regexes[0].re.source, '.+x', '.+ needs a character: kept');
  const lines = ['x', 'ax', '', 'a\nx', 'yyy'];
  for (const src of ['.*x', '.*?x', '.*.*x', '.*|x', '.*']) {
    const t = Q.build(`/${src}/`, {}, {}).q.regexes[0].re, o = new RegExp(src, 'i');
    for (const s of lines) assert.equal(t.test(s), o.test(s), `${src} on ${JSON.stringify(s)}`);
  }
});

// A fake clock: each re.test(s) advances it by cost(s) ms, and each read by 1 ns (a real clock always moves), so the probe
// never runs a real slow regex. `t` is the clock time the probe spent. Options: `pause` ms added to every `every`-th call
// (a busy machine preempting the thread), and `step` (a coarse clock: reads are rounded down to it, and a read takes 20 ns,
// so the clock moves within GUARD.MAX_CALLS reads).
function fakeClock(cost, source = 'f+', { every = 0, pause = 0, step = 0 } = {}) {
  let t = 0, longest = 0, calls = 0;
  const re = { source, test(s) { longest = Math.max(longest, s.length); t += cost(s); if (every && ++calls % every === 0) t += pause; return false; } };
  const now = step ? () => Math.floor((t += 2e-5) / step) * step : () => (t += 1e-6);
  return { now, re, get longest() { return longest; }, get t() { return t; } };
}
const qOf = re => ({ regexes: [{ re, start: 3, end: 9 }] });
const msgs = (n, len) => Array.from({ length: n }, (_, i) => ({ msg: `m${i} `.padEnd(len, 'z') }));
const NEXT = 'Make it more specific, for example with fewer .* or a ^ anchor';

test('slowRegex: a degree-3 cost is refused on the worst-line projection without running a step predicted over STEP_MS', () => {
  const c = fakeClock(s => 1e-7 * s.length ** 3);   // 0.1 ms at 100 chars, 107 ms at 1 024
  const err = Q.slowRegex(qOf(c.re), msgs(10, 200), c.now);
  assert.match(err.cause, /^It would take about [\d\u2009]+ ms on one of these lines and can freeze the viewer$/);
  assert.equal(err.reason, `${err.cause}. ${NEXT}`);
  assert.equal(err.msg, `Invalid regex: ${err.reason}. The last valid filter is still applied.`);
  assert.deepEqual([err.start, err.end], [3, 9]);
  assert.ok(c.longest < Q.GUARD.MIN_LEN, `stopped before the ${Q.GUARD.MIN_LEN}-char step (longest probed: ${c.longest})`);
});

test('slowRegex: a linear cost is accepted early; a high mean is refused; a high total for this session is refused', () => {
  const lin = fakeClock(s => 1e-6 * s.length);   // 1 ns a char: 0.2 µs a 200-char line
  assert.equal(Q.slowRegex(qOf(lin.re), msgs(1000, 200), lin.now), null);
  assert.ok(lin.t < 10, `accepted after ${lin.t.toFixed(1)} ms of probing (early accept, no repeated timings)`);
  const mean = fakeClock(() => 0.008);        // 8 µs a line whatever its length
  assert.equal(Q.slowRegex(qOf(mean.re), msgs(1000, 200), mean.now).msg,
    `Invalid regex: It takes about 8.0 µs a line, over the 5 µs a line the viewer allows. ${NEXT}. The last valid filter is still applied.`);
  const total = fakeClock(() => 0.004);       // 4 µs a line: under MEAN_US, but 600 000 lines × 4 µs = 2.4 s
  const big = { length: 600000 };
  for (let i = 0; i < 256; i++) big[Math.floor(i * 600000 / 256)] = { msg: 'x'.repeat(100) };
  assert.equal(Q.slowRegex(qOf(total.re), big, total.now).msg,
    `Invalid regex: It would take about 2.4 s to filter these 600\u2009000 lines. ${NEXT}. The last valid filter is still applied.`);
});

test('slowRegex: the mean is timed line by line and stops early: lines of 10 ms each are refused after at most 50 ms of probing', () => {
  const lines = msgs(1000, 100);
  lines[1] = { msg: 'L'.repeat(300) };   // the longest line (not in the evenly spaced sample) is linear: the mean decides
  const c = fakeClock(s => (s[0] === 'L' ? 1e-6 * s.length : 10));
  const err = Q.slowRegex(qOf(c.re), lines, c.now);
  assert.equal(err.cause, 'It takes about 10000.0 µs a line, over the 5 µs a line the viewer allows');
  assert.ok(c.t <= 50, `the probe read the clock for ${c.t.toFixed(1)} ms (one 10 ms line per mean timing, three timings)`);
});

test('slowRegex: one inflated call (a GC pause, a JIT compile) does not refuse a fine regex: a call over GAP_MS runs again and counts at its cheapest', () => {
  let paused = false;
  const a = fakeClock(() => (paused ? 1e-4 : (paused = true, 5)));   // the very first test call pays 5 ms
  assert.equal(Q.slowRegex(qOf(a.re), msgs(1000, 200), a.now), null, 'in the worst-line probe');
  paused = false;
  const lines = msgs(1000, 100);
  lines[1] = { msg: 'L'.repeat(300) };
  const b = fakeClock(s => (s[0] === 'L' ? 1e-6 * s.length : paused ? 1e-4 : (paused = true, 5)));   // the first sampled line pays 5 ms
  assert.equal(Q.slowRegex(qOf(b.re), lines, b.now), null, 'in the mean');
});

test('slowRegex on a busy machine: a pause in every timing window (5 ms every 40 calls) refuses nothing fine, and what is slow is still refused', () => {
  // Measured with 8–16 CPU burners on 10 cores: the thread runs 0.4–0.8 ms between pauses of up to 10 ms, so every 2 ms
  // window holds one (the round-1 guard's three windows in a row held three). The paused call reads over GAP_MS, runs
  // again without the pause, and counts at its own cost.
  const busy = { every: 40, pause: 5 };
  const lin = fakeClock(s => 1e-6 * s.length, 'f+', busy);
  assert.equal(Q.slowRegex(qOf(lin.re), msgs(1000, 200), lin.now), null, 'a linear regex is accepted');
  const fine = fakeClock(() => 0.002, 'f+', busy);
  assert.equal(Q.slowRegex(qOf(fine.re), msgs(1000, 200), fine.now), null, '2 µs a line is accepted');
  const mean = fakeClock(() => 0.008, 'f+', busy);
  assert.match(Q.slowRegex(qOf(mean.re), msgs(1000, 200), mean.now).cause, /^It takes about 8\.\d µs a line/, '8 µs a line is still refused, at its own cost');
  const cubic = fakeClock(s => 1e-7 * s.length ** 3, 'f+', busy);
  assert.match(Q.slowRegex(qOf(cubic.re), msgs(10, 200), cubic.now).cause, /ms on one of these lines/);
});

test('slowRegex on a coarse clock (WebKit may step 1 ms): fine regexes are accepted, slow ones refused, and the error leans toward accepting', () => {
  const coarse = { step: 1 };
  const lin = fakeClock(s => 1e-6 * s.length, 'f+', coarse);
  assert.equal(Q.slowRegex(qOf(lin.re), msgs(1000, 200), lin.now), null, 'a linear regex is accepted');
  const fine = fakeClock(() => 0.003, 'f+', coarse);
  assert.equal(Q.slowRegex(qOf(fine.re), msgs(1000, 200), fine.now), null, '3 µs a line is accepted');
  const mean = fakeClock(() => 0.008, 'f+', coarse);
  assert.match(Q.slowRegex(qOf(mean.re), msgs(1000, 200), mean.now).cause, /^It takes about [67]\.\d µs a line/, '8 µs a line is refused, counted one clock step low (6–8)');
  const cubic = fakeClock(s => 1e-7 * s.length ** 3, 'f+', coarse);
  assert.match(Q.slowRegex(qOf(cubic.re), msgs(10, 200), cubic.now).cause, /ms on one of these lines/);
});

test('slowRegex: the probe stops at APPLY_MS per apply: the term it reaches past the cap is refused', () => {
  let t = 0;
  const lin = { source: 'x+', test(s) { t += 1e-6 * s.length; return false; } };   // about 6 ms of probing per term
  const q = { regexes: Array.from({ length: 30 }, (_, i) => ({ re: lin, start: i * 4, end: i * 4 + 3 })) };
  const err = Q.slowRegex(q, msgs(1000, 200), () => (t += 1e-6));
  assert.equal(err.cause, `Its regex terms take over ${Q.GUARD.APPLY_MS} ms to check on these lines`);
  assert.equal(err.reason, `${err.cause}. Use fewer regex terms`);
  assert.ok(err.start > 0 && t <= Q.GUARD.APPLY_MS + 10, `refused at the term at ${err.start}, after ${t.toFixed(0)} ms`);
});

test('slowRegex: the APPLY_MS cap counts the timings it keeps, not the wall clock: a 30 ms pause before each of five terms refuses nothing', () => {
  let t = 0;
  const mk = () => { let first = true; return { source: 'x+', test(s) { t += 1e-6 * s.length; if (first) { first = false; t += 30; } return false; } }; };   // the first call of a term is preempted for 30 ms
  const q = { regexes: [0, 1, 2, 3, 4].map(i => ({ re: mk(), start: i * 4, end: i * 4 + 3 })) };
  assert.equal(Q.slowRegex(q, msgs(1000, 200), () => (t += 1e-6)), null);
  assert.ok(t > Q.GUARD.APPLY_MS, `the wall clock read ${t.toFixed(0)} ms, over the ${Q.GUARD.APPLY_MS} ms cap, and the query was still accepted`);
});

test('slowRegex: a wall-clock stop at 4 x APPLY_MS refuses the remaining terms with the same copy', () => {
  let t = 0;
  const lin = { source: 'x+', test(s) { t += 1e-6 * s.length; return false; } };
  const q = { regexes: [{ re: lin, start: 0, end: 3 }, { re: lin, start: 4, end: 7 }] };
  const now = () => (t += 1e-6);
  const clock = { now, jump() { t += 4 * Q.GUARD.APPLY_MS + 1; } };
  let calls = 0;
  const err = Q.slowRegex(q, msgs(1000, 200), () => { if (++calls === 3000) clock.jump(); return now(); });
  assert.ok(err && err.cause === `Its regex terms take over ${Q.GUARD.APPLY_MS} ms to check on these lines`, JSON.stringify(err));
});

test('slowRegex: a term without a quantifier is linear and not timed; /.*.*.*z/ runs as /z/ and is accepted at no cost', () => {
  let reads = 0;
  const count = () => ++reads;
  assert.equal(Q.slowRegex(Q.build('tag:x "a b" word', {}, {}).q, msgs(10, 50), count), null);
  assert.equal(Q.slowRegex(Q.build('/error|fail/ /^E\\//', {}, {}).q, msgs(10, 50), count), null);
  assert.equal(Q.slowRegex(Q.build('error timeout disconnect', { regex: true }, {}).q, msgs(10, 50), count), null);
  const q = Q.build('/.*.*.*z/', {}, {}).q;
  assert.equal(q.regexes[0].re.source, 'z');
  assert.equal(Q.slowRegex(q, msgs(10, 50), count), null);
  assert.equal(reads, 0, 'no clock read for any of them');
});

test('slowRegex: a clock that never moves (the test sandbox) cannot time anything: accepted after a bounded number of reads', () => {
  let reads = 0;
  assert.equal(Q.slowRegex(qOf(/a+b/), msgs(10, 50), () => { reads++; return 0; }), null);
  assert.ok(reads <= Q.GUARD.MAX_CALLS + 1, `${reads} reads`);
});

test('slowRegex: an empty session is probed on SYNTH', () => {
  const seen = new Set(), c = fakeClock(s => { seen.add(s.slice(0, 20)); return 1e-6 * s.length; });
  assert.equal(Q.slowRegex(qOf(c.re), [], c.now), null);
  assert.ok(seen.has(Q.SYNTH.slice(0, 20)), 'the probe line and the sample are SYNTH');
  assert.ok(Q.SYNTH.length > 200 && !/[<>&]/.test(Q.SYNTH));
});

test('slowRegex: every timed term is probed in order, and the first slow one is the one reported', () => {
  let t = 0;
  const mk = cost => ({ source: 'x+', test(s) { t += cost(s.length); return false; } });
  const q = { regexes: [{ re: mk(len => 1e-6 * len), start: 0, end: 3 }, { re: mk(len => 1e-7 * len ** 3), start: 10, end: 13 }] };
  assert.equal(Q.slowRegex(q, msgs(10, 200), () => (t += 1e-6)).start, 10);
});

test('slowRegex on a real clock (V8): pathological regexes are refused on the first attempt, common ones accepted (a common regex that is refused is retried, at most twice)', () => {
  const now = () => performance.now();
  const lines = Array.from({ length: 2000 }, (_, i) => ({ msg: `D/BluetoothGatt( ${1000 + i % 900}): onClientConnectionState() status=${i % 3} clientIf=${i % 9} device=DE:AD:BE:EF:00:${(i % 256).toString(16)} took ${i % 97} ms`.repeat(1 + (i % 3)) }));
  // \s.*.*.*z, not .*.*.*z: the strip turns .*.*.*z into z (accepted below), so the pathological sample must not start with .*
  // Refusal is the outcome asserted, never the elapsed time: that is a wall clock on a shared machine (843 ms at load 88).
  // One attempt per refused source, no retry: load only inflates a timing, so it cannot make the guard accept one of
  // these regexes. A retry here would hide an intermittent missed refusal (which would freeze the drain). The elapsed
  // time is logged, not asserted. "No apply" (the filter is left unchanged on a refusal) is asserted by the page test
  // (query-page.test.mjs, `cur.filter === __f`), not here.
  for (const src of ['\\s.*.*.*z', '(.*){2}z', '\\w+\\w+z']) {
    const t0 = now();
    const err = Q.slowRegex(Q.build(`/${src}/`, {}, {}).q, lines, now);
    console.log(`# real clock: ${src} ${err ? 'refused' : 'accepted'} in ${(now() - t0).toFixed(0)} ms`);
    assert.ok(err, `${src} refused on the first attempt`);
  }
  // A real clock on a shared machine: each accepted regex gets up to 3 attempts. The busy-machine and coarse-clock tests
  // above pin the mechanism deterministically; a retry here is logged, never hidden.
  for (const src of ['time ?out', '\\d+ms', '^E\\/', 'gatt.*mtu', 'foo.*bar.*baz.*qux', 'status=\\d+.*handle', '.*error', '.*.*.*z', '(error|fail|timeout)', '0x[0-9a-f]+', '\\S+\\s+\\S+', '^\\s*at\\s+\\S+']) {
    let err = Q.slowRegex(Q.build(`/${src}/`, {}, {}).q, lines, now);
    for (let i = 1; err && i < 3; i++) {
      console.log(`# real clock: ${src} refused once (${err.cause}); retrying`);
      err = Q.slowRegex(Q.build(`/${src}/`, {}, {}).q, lines, now);
    }
    assert.equal(err, null, src);
  }
});
