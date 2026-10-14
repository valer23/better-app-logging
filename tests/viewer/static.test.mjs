// Static checks over viewer/applogs-viewer.html and viewer/assets. Zero dependencies:
//   node --test "tests/viewer/*.test.mjs"
// The checks themselves live in _checks.mjs; the last test here feeds them broken snippets, so a
// check that silently stops detecting anything fails too.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseHtml, elements } from './_html.mjs';
import { ROOT, ASSETS, HTML_PATH, read, listAssets, inlineScripts } from './_load.mjs';
import * as C from './_checks.mjs';

const html = read(HTML_PATH);
const { root, errors: parseErrors } = parseHtml(html);
const assetFiles = listAssets();
const allJs = [
  ...inlineScripts(html).map(s => ({ code: s.code, line: s.line, filename: 'viewer/applogs-viewer.html' })),
  ...assetFiles.filter(p => p.endsWith('.js')).map(p => ({ code: read(path.join(ASSETS, p)), line: 1, filename: `viewer/assets/${p}` })),
];
const jsText = allJs.map(s => s.code).join('\n');
const cssFiles = assetFiles.filter(p => p.endsWith('.css')).map(p => ({ path: p, text: read(path.join(ASSETS, p)) }));
// Ids that JS creates at runtime (createElement + id) and therefore are not in the HTML. None today.
const DYNAMIC_IDS = [];
// Ids the JS resolves through getElementById but only as indirect string literals (arrays passed to
// forEach / showOnly / runPairAction, a status-pill map, 'liveBar' + platform + 'Dropped'), which
// referencedIds cannot see. Listed by hand so renaming one in a redesign still fails CI.
const INDIRECT_IDS = [
  'autoScrollBtn', 'pauseBtn', 'clearBtn',
  'dropzone', 'livePanel', 'loading', 'logWrapper',
  'iosRepairBtn', 'setupRepairBtn', 'setupUnpairBtn', 'setupPairBtn', 'stallRepairBtn',
  'androidStatus', 'androidStatusText', 'iosStatus', 'iosStatusText',
  'liveBarAndroidDropped', 'liveBarAndroidDroppedText', 'liveBarIosDropped', 'liveBarIosDroppedText',
];

test('page HTML is well formed: tags balance, no duplicate attributes', () => {
  assert.deepEqual(parseErrors, []);
});

test('every script compiles', () => {
  assert.deepEqual(C.scriptSyntaxErrors(allJs), []);
});

test('ids are unique', () => {
  assert.deepEqual(C.duplicateIds(root), []);
});

test('every id the JS looks up exists in the page', () => {
  assert.deepEqual(C.missingIds(root, jsText, DYNAMIC_IDS), []);
});

test('every indirectly-resolved id exists in the page', () => {
  assert.deepEqual(C.missingIds(root, INDIRECT_IDS.map(id => `getElementById('${id}')`).join('\n')), []);
});

test('the id check is not vacuous: it sees a healthy number of literal lookups', () => {
  assert.ok(C.referencedIds(jsText).size >= 50, `only ${C.referencedIds(jsText).size} ids found`);
});

test('every inline on*= handler calls a defined global function', () => {
  assert.deepEqual(C.handlerErrors(root, jsText), []);
});

test('XSS: innerHTML is only ever cleared; no outerHTML, insertAdjacentHTML or document.write', () => {
  assert.deepEqual(allJs.flatMap(s => C.xssErrors(s.code, s.filename, s.line)), []);
});

test('drag band: every control inside #topbar matches INTERACTIVE', () => {
  assert.deepEqual(C.dragErrors(root, jsText, ['topbar']), []);
});

test('the checks reject deliberately broken input', () => {
  const h = s => parseHtml(s).root;
  assert.notDeepEqual(parseHtml('<div><span></div>').errors, []);
  assert.notDeepEqual(parseHtml('<p class="a" class="b"></p>').errors, []);
  assert.notDeepEqual(C.scriptSyntaxErrors([{ code: 'function (', filename: 'bad.js' }]), []);
  assert.notDeepEqual(C.duplicateIds(h('<p id="a"></p><i id="a"></i>')), []);
  assert.notDeepEqual(C.missingIds(h('<p id="a"></p>'), "document.getElementById('b')"), []);
  const ternary = "getElementById(x === 'q' ? 'a' : 'b')";
  assert.deepEqual([...C.referencedIds(ternary)].sort(), ['a', 'b']);
  assert.deepEqual(C.missingIds(h('<p id="a"></p><p id="b"></p>'), ternary), []);
  assert.notDeepEqual(C.missingIds(h('<p id="a"></p>'), ternary), []);
  assert.notDeepEqual(parseHtml('<div></div><!DOCTYPE html').errors, []);
  assert.notDeepEqual(parseHtml('<script>x</script').errors, []);
  assert.notDeepEqual(parseHtml('<body><script src="a.js" /><div></div></body>').errors, []);
  assert.notDeepEqual(parseHtml('<div/><span></span>').errors, []);
  assert.deepEqual(parseHtml('<svg><path d="M0 0"/></svg><br/><img src="x"/>').errors, []);
  assert.notDeepEqual(C.handlerErrors(h('<button onclick="nope()">x</button>'), 'function yes() {}'), []);
  assert.deepEqual(C.handlerErrors(h('<button onclick="yes(1)">x</button>'), 'function yes() {}'), []);
  assert.notDeepEqual(C.handlerErrors(h('<button onclick="yes(); x.innerHTML = s">x</button>'), 'function yes() {}'), []);
  assert.notDeepEqual(C.handlerErrors(h('<button onclick="yes(1) + other()">x</button>'), 'function yes() {}'), []);
  assert.notDeepEqual(C.handlerErrors(h('<button onclick="yes(el.innerHTML = s)">x</button>'), 'function yes() {}'), []);
  assert.notDeepEqual(C.handlerErrors(h('<button onclick="yes(document.body.outerHTML = location.hash)">x</button>'), 'function yes() {}'), []);
  assert.deepEqual(C.handlerErrors(h(`<button onclick="yes('a)b', &quot;c&quot;)">x</button>`), 'function yes() {}'), []);
  assert.notDeepEqual(C.xssErrors('el.innerHTML = userText;'), []);
  assert.notDeepEqual(C.xssErrors("el.innerHTML = '<b>' + s;"), []);
  assert.deepEqual(C.xssErrors("el.innerHTML = '';"), []);
  assert.notDeepEqual(C.xssErrors('el.innerHTML += s;'), []);
  assert.notDeepEqual(C.xssErrors("el['innerHTML'] = s;"), []);
  assert.deepEqual(C.xssErrors("if (el.innerHTML === '') x();"), []);
  assert.notDeepEqual(C.xssErrors("new DOMParser().parseFromString(s, 'text/html');"), []);
  assert.notDeepEqual(C.xssErrors('range.createContextualFragment(s);'), []);
  assert.notDeepEqual(C.xssErrors("el.insertAdjacentHTML('beforeend', s);"), []);
  assert.notDeepEqual(C.xssErrors('el.outerHTML = s;'), []);
  for (const op of ['||=', '&&=', '??=']) assert.notDeepEqual(C.xssErrors(`el.innerHTML ${op} s;`), [], op);
  assert.notDeepEqual(C.xssErrors('el.outerHTML += s;'), []);
  assert.notDeepEqual(C.xssErrors("el.innerHTML = ''\n  + s;"), []);
  assert.notDeepEqual(C.xssErrors("el.innerHTML = '' // clear\n  + s;"), []);
  assert.deepEqual(C.xssErrors("el.innerHTML = '' // clear\nnext();"), []);
  assert.deepEqual(C.xssErrors("if (a) { el.innerHTML = '' }"), []);
  assert.deepEqual(C.xssErrors("a();\nel.innerHTML = '';"), []);
  assert.notDeepEqual(C.xssErrors("if (a) { el.innerHTML = '' } else { el.innerHTML = userText; }"), []);
  assert.notDeepEqual(C.xssErrors("el.innerHTML = ''\nother.innerHTML = userText;"), []);
  assert.deepEqual(C.xssErrors("el.outerHTML === s;"), []);
  assert.match(C.xssErrors("a();\nb();\nel.innerHTML ||= s;", 'f.js', 10)[0], /^f\.js:12:/);
  assert.notDeepEqual(C.xssErrors('Object.assign(el, { innerHTML: s });'), []);
  assert.notDeepEqual(C.xssErrors('frame.srcdoc = s;'), []);
  assert.notDeepEqual(C.dragErrors(h('<div id="topbar"><span tabindex="0">x</span></div>'), "const INTERACTIVE = 'button';", ['topbar']), []);
  assert.deepEqual(C.dragErrors(h('<div id="topbar"><div class="grp"><span role="switch">x</span></div></div>'), "const INTERACTIVE = 'button, .grp';", ['topbar']), []);
  assert.notDeepEqual(C.offlineErrors("@import url('https://fonts.googleapis.com/css2');", 'x.css'), []);
  assert.deepEqual(C.offlineErrors("new WebSocket('ws://localhost:8765')", 'x.js'), []);
  assert.notDeepEqual(C.cssBraceErrors('a { b: c; '), []);
  assert.notDeepEqual(C.cssBraceErrors('a { } }'), []);
  assert.deepEqual([...C.cssClassSelectors('.a .b:hover, x.c { transition: .5s } @media (x) { .d { } }')].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(C.cssAssetRefs("src: url(geist.woff2), url('data:x'), url(https://x.y/z)", 'fonts/fonts.css'), ['fonts/geist.woff2']);
  assert.deepEqual(C.jsAssetRefs("s.src = 'assets/js/dev-bench.js';"), ['js/dev-bench.js']);
  assert.deepEqual([...C.cssVarsUsed('a { color: var(--x, red); b: var( --y ) }')], ['--x', '--y']);
});

test('every assets/ reference resolves to a file, and every asset file is referenced', () => {
  const files = new Set(assetFiles);
  const refs = [
    ...C.htmlAssetRefs(root),
    ...allJs.flatMap(s => C.jsAssetRefs(s.code)),
    ...cssFiles.flatMap(f => C.cssAssetRefs(f.text, f.path)),
  ];
  assert.deepEqual(refs.filter(r => !files.has(r)), [], 'references to missing files');
  // Licence texts and font provenance ship in the repo without being referenced by the page.
  const UNREFERENCED_OK = [/^fonts\/OFL-[\w-]+\.txt$/, /^fonts\/SOURCES\.md$/, /^fonts\/SHA256SUMS$/];
  const orphans = assetFiles.filter(f => !refs.includes(f) && !UNREFERENCED_OK.some(re => re.test(f)));
  assert.deepEqual(orphans, [], 'asset files nothing references');
});
