// The query grammar (viewer/assets/js/query.js, roadmap P6): one table row per spec "Query grammar" row, the edge rows
// the architects named, the error copy, a seeded round-trip property over tokens, a text fuzz, and what compile() keeps.
// Loaded in an EMPTY vm context, so any page, storage or timer use at load throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ASSETS, read, loadPureModule, pageScriptSrcs } from './_load.mjs';

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
  assert.doesNotMatch(SRC, /\b(document|window\.document|localStorage|sessionStorage|setTimeout|setInterval|requestAnimationFrame)\b/);
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

test('parse: the spec\'s error copy, and the new copy for pid, plat and negated phrases or regexes', () => {
  assert.deepEqual(errs('tg:x'), ["Unknown field 'tg'. Did you mean tag:?"]);
  assert.deepEqual(errs('TG:x'), ["Unknown field 'TG'. Did you mean tag:?"]);
  assert.deepEqual(errs('lebel:E apps:x pi:1 dv:a plt:ios'), ["Unknown field 'lebel'. Did you mean level:?", "Unknown field 'apps'. Did you mean app:?",
    "Unknown field 'pi'. Did you mean pid:?", "Unknown field 'dv'. Did you mean dev:?", "Unknown field 'plt'. Did you mean plat:?"]);
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
  ];
  for (const [text, want] of rows) assert.equal(Q.serialize(Q.parse(text).tokens), want, text);
});

// A seeded generator over the token domain parse() can produce: field values of any shape, phrases of any shape,
// regex bodies without an unescaped '/' before a space or the end, words that are not fields, phrases or regexes.
function rng(seed) { return n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }; }
const CHARS = ['a', 'B', 'z', ' ', '"', '\\', '/', ':', '-', '.', 'é', 'İ', 'ß', '(', ')', '*', '+', ',', '1', '\t'];
function genToken(r) {
  const str = (n, set = CHARS) => Array.from({ length: n }, () => set[r(set.length)]).join('');
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
