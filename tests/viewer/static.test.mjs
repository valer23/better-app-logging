// Static checks over viewer/applogs-viewer.html and viewer/assets. Zero dependencies:
//   node --test "tests/viewer/*.test.mjs"
// The checks themselves live in _checks.mjs; the last test here feeds them broken snippets, so a
// check that silently stops detecting anything fails too.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseHtml, elements, findById } from './_html.mjs';
import { ROOT, ASSETS, HTML_PATH, read, listAssets, inlineScripts } from './_load.mjs';
import * as C from './_checks.mjs';
import { build as buildFoundation, REGEN_CMD } from './gen-foundation.mjs';
import * as SPRITE from './gen-sprite.mjs';

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

test('#overlayRoot is a direct child of <body>, the last element before the scripts, with its layers in paint order', () => {
  const body = root.children.find(el => el.tag === 'html').children.find(el => el.tag === 'body');
  const nonScript = body.children.filter(el => el.tag !== 'script');
  assert.equal(nonScript.at(-1).attrs.id, 'overlayRoot');
  const ov = nonScript.at(-1);
  assert.deepEqual(ov.children.map(el => el.attrs.id), ['ovDialogs', 'ovPopovers', 'toastRegion', 'ovTips', 'announcer']);
  const byId = id => elements(ov).find(el => el.attrs.id === id);
  assert.equal(byId('toastLive').attrs['aria-live'], 'polite', 'toasts live in one persistent polite region');
  assert.equal(byId('toastAlerts').attrs['aria-live'], undefined, 'error toasts carry role=alert themselves');
  assert.equal(byId('announcer').attrs['aria-live'], 'polite');
  const scripts = body.children.filter(el => el.tag === 'script');
  assert.ok(body.children.indexOf(ov) < body.children.indexOf(scripts[0]), '#overlayRoot comes before the scripts');
});

test('INTERACTIVE is one literal, in dom.js, and the legacy drag code reads it from ALV.dom', () => {
  const literals = allJs.filter(s => /const INTERACTIVE\s*=\s*'/.test(s.code)).map(s => s.filename);
  assert.deepEqual(literals, ['viewer/assets/js/dom.js']);
  assert.equal((jsText.match(/const INTERACTIVE\s*=\s*'/g) || []).length, 1);
  assert.match(inlineScripts(html).at(-1).code, /const INTERACTIVE = ALV\.dom\.INTERACTIVE;/);
});

test('the Lucide sprite is the first element of <body>: aria-hidden, zero-size, exactly the generator\'s icons', () => {
  const body = root.children.find(el => el.tag === 'html').children.find(el => el.tag === 'body');
  const sprite = body.children[0];
  assert.equal(sprite.attrs.id, 'iconSprite');
  assert.deepEqual([sprite.attrs['aria-hidden'], sprite.attrs.width, sprite.attrs.height], ['true', '0', '0']);
  assert.deepEqual(C.spriteSymbols(root), SPRITE.ICONS);
  assert.deepEqual(elements(sprite).filter(el => el.tag === 'symbol').map(el => el.attrs.id), SPRITE.ICONS.map(n => `i-${n}`), 'every symbol sits in #iconSprite');
  assert.equal(html.split(SPRITE.START).length, 2);
  assert.equal(html.split(SPRITE.END).length, 2);
});

test('icons/SOURCES.md lists exactly the sprite\'s icons with their upstream hashes, and the licence ships', () => {
  const sources = read(path.join(ASSETS, 'icons', 'SOURCES.md'));
  const rows = [...sources.matchAll(/^\| `([\w-]+)` \| `lucide-static@1\.49\.0\/icons\/([\w-]+)\.svg` \| `[0-9a-f]{64}` \|$/gm)];
  assert.deepEqual(rows.map(m => m[1]), C.spriteSymbols(root));
  assert.ok(rows.every(m => m[1] === m[2]), 'each row names its own upstream file');
  assert.ok(sources.includes(SPRITE.INTEGRITY) && sources.includes(SPRITE.TARBALL_SHA256), 'package integrity and tarball hash recorded');
  assert.match(read(path.join(ASSETS, 'icons', 'LICENSE-lucide.txt')), /^ISC License\n/);
});

test('icons: every <svg> is aria-hidden, symbols are plain 24-unit shapes, every icon reference resolves', () => {
  assert.deepEqual(C.iconErrors(root, jsText), []);
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
  assert.deepEqual(C.dragErrors(h('<div id="topbar"><span role="switch" tabindex="0">x</span></div>'), "const INTERACTIVE = 'button, [role=switch]';", ['topbar']), []);
  assert.notDeepEqual(C.dragErrors(h('<div id="topbar"><span role="tab" tabindex="0">x</span></div>'), "const INTERACTIVE = 'button, [role=switch]';", ['topbar']), []);
  assert.deepEqual(C.dragErrors(h('<div id="topbar"><div data-no-drag><span tabindex="0">x</span></div></div>'), "const INTERACTIVE = '[data-no-drag]';", ['topbar']), []);
  assert.notDeepEqual(C.offlineErrors("@import url('https://fonts.googleapis.com/css2');", 'x.css'), []);
  assert.deepEqual(C.offlineErrors("new WebSocket('ws://localhost:8765')", 'x.js'), []);
  assert.notDeepEqual(C.lgScopeSpecificityErrors('.lg-scope * { margin: 0 }'), []);
  assert.notDeepEqual(C.lgScopeSpecificityErrors('html, .lg-scope { margin: 0 }'), []);
  assert.notDeepEqual(C.lgScopeSpecificityErrors('.lg-scope input[type="text"] { padding: 0 }'), []);
  assert.notDeepEqual(C.lgScopeSpecificityErrors(':is(.lg-scope) a { padding: 0 }'), []);
  assert.deepEqual(C.lgScopeSpecificityErrors('html, :where(.lg-scope, .lg-scope *) { margin: 0 }'), []);
  assert.deepEqual(C.lgScopeSpecificityErrors(':where(.lg-scope) input[type="text"]:focus { margin: 0 }'), []);
  assert.deepEqual(C.lgScopeSpecificityErrors('/* .lg-scope */ .lg-scoped { margin: 0 }'), []);
  for (const bad of ['.app * { }', '.app *::before { }', '.app ::selection { }', '::-webkit-scrollbar { }',
    '.app :where(button, input) { }', '* { }', '.a, .b :hover { }', '@media (x) { .a ::after { } }']) {
    assert.notDeepEqual(C.universalSelectorErrors(bad), [], bad);
  }
  for (const ok of ['.app::selection { }', 'button, input { }', ':where(.app) button { }', '.scroll::-webkit-scrollbar-thumb { }',
    ':where(.lg-scope) button { }', ':where(.lg-scope) { }', '.switch::after { }', 'td:not(table td) { }', '[data-glass="on"] tbody td { }',
    ':root { }', '@keyframes k { from { } to { } }', '@media (x) { .a .b { } }', ...C.WEBKIT_ALLOW.map(s => `${C.WEBKIT_DETECTOR} { ${s} { } }`),
    `${C.WEBKIT_DETECTOR} { .app .a { } }`]) {
    assert.deepEqual(C.universalSelectorErrors(ok), [], ok);
  }
  // The WebKit-only block is not a blanket exemption: only its four listed selectors pass, and only there.
  for (const bad of [`${C.WEBKIT_DETECTOR} { .app * { } }`, `${C.WEBKIT_DETECTOR} { .app *::before { } }`,
    `${C.WEBKIT_DETECTOR} { .app ::-webkit-scrollbar-corner { } }`, `${C.WEBKIT_DETECTOR} { .app ::selection, .app :hover { } }`,
    `${C.WEBKIT_DETECTOR} { @media (x) { .app ::after { } } }`, '@supports (display: grid) { .app ::selection { } }',
    '@media (x) { .app ::-webkit-scrollbar { } }']) {
    assert.notDeepEqual(C.universalSelectorErrors(bad), [], bad);
  }
  assert.deepEqual(C.universalSelectorErrors('.app * { }', 'x.css', ['.app *']), []);
  assert.match(C.universalSelectorErrors('a { }\n\n.app ::after { }', 'x.css')[0], /^x\.css:3: \.app ::after$/);
  assert.notDeepEqual(C.motionTokenErrors('.x { transition: color .2s }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { animation: spin 900ms linear infinite }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { transition-duration: 1s }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { transition-delay: 200ms }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { animation-delay: .5s }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { -webkit-transition: color 1s }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { transition: color var(--t-fast, 200ms) }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { transition-duration: var(--a, var(--b, 1s)) }'), []);
  assert.deepEqual(C.motionTokenErrors('.x { transition-delay: 0s; transition: color var(--t-fast, var(--t-med)) }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.x { scroll-behavior: smooth }'), []);
  assert.notDeepEqual(C.motionTokenErrors('@media (prefers-reduced-motion: no-preference) { .x { scroll-behavior: smooth } }'), []);
  assert.notDeepEqual(C.motionTokenErrors('.app:not([data-motion="reduce"]) { scroll-behavior: smooth }'), []);
  assert.deepEqual(C.motionTokenErrors('@media (prefers-reduced-motion: no-preference) { .app:not([data-motion="reduce"]) { scroll-behavior: smooth } }'), []);
  assert.deepEqual(C.motionTokenErrors('.x { scroll-behavior: auto }'), []);
  assert.match(C.motionTokenErrors('a { }\n.x { scroll-behavior: smooth }', 'x.css')[0], /^x\.css:2:/);
  // Pseudo-element box-sizing: any stylesheet, comma lists, nesting in @media / @supports / @layer.
  for (const bad of ['.a::before { padding: 4px }', '.a::after { content: ""; border: 1px solid red }', '.a::before, .b { border-width: 2px }',
    '.b, .a:after { border-top: 1px solid }', '@media (x) { .a::before { width: 50% } }', '@layer l { @supports (y) { .a::after { padding: 0 4px } } }',
    '.a::before { height: 100% }', '.a::before { border: solid }', '.a::before { padding: var(--p) }', '.a::before { border-left-width: thin }']) {
    assert.notDeepEqual(C.pseudoBoxSizingErrors(bad), [], bad);
  }
  for (const ok of ['.a::before { padding: 4px; box-sizing: border-box }', '.a::before { padding: 0 }', '.a::after { border: none }', '.a::after { border: 0 }',
    '.a::before { width: 3px; height: 20px }', '.a { padding: 4px; border: 1px solid }', '.a::before { border-radius: 50%; content: "}" }',
    '.a::before { content: "{ padding: 4px }" }', '@keyframes k { to { padding: 4px } }', '.a::before { padding: 4px; BOX-SIZING: content-box }']) {
    assert.deepEqual(C.pseudoBoxSizingErrors(ok), [], ok);
  }
  assert.deepEqual(C.pseudoBoxSizingErrors('.a::before { padding: 4px }', 'x.css', ['.a::before']), []);
  assert.match(C.pseudoBoxSizingErrors('a { }\n\n.b::after { padding: 1px }', 'x.css')[0], /^x\.css:3: \.b::after$/);
  // Reduce motion coverage of legacy-style literal-time animations.
  const RM = (sels, os = C.MOTION_OS_PREFIX, forced = C.MOTION_FORCED_PREFIX) => {
    const none = 'animation: none !important; transition: none !important';
    return `@media (prefers-reduced-motion: reduce) { ${sels.map(s => os + s).join(', ')} { ${none} } } ${sels.map(s => forced + s).join(', ')} { ${none} }`;
  };
  const ANIM = '.a { transition: color .1s } .b:hover::after { animation: spin 1s infinite } .c .d { transition-property: opacity }';
  assert.deepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b::after', '.c .d'])}`), []);
  assert.deepEqual(C.reducedMotionCoverageErrors(`@layer legacy { ${ANIM} ${RM(['.a', '.b::after', '.d'])} }`), []);
  assert.notDeepEqual(C.reducedMotionCoverageErrors(ANIM), []);
  assert.notDeepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b::after'])}`), []);          // .c .d missing in both
  assert.notDeepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b', '.d'])}`), []);              // ::after dropped
  assert.notDeepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b::after', '.d']).split('} .app[data-motion')[0]}}`), []); // no Settings rule
  assert.notDeepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b::after', '.d']).replace(/animation: none !important/, 'animation: none')}`), []);
  assert.notDeepEqual(C.reducedMotionCoverageErrors(`${ANIM} ${RM(['.a', '.b::after', '.d'], '.app ')}`), []);   // wrong OS prefix
  assert.deepEqual(C.animatedSelectors(`.x { transition: none } .y { color: red } ${RM(['.x'])}`), []); // none is not an animation; the Reduce motion rules themselves are skipped
  assert.deepEqual(C.motionTokenErrors('.x { transition: background var(--t-fast) var(--ease), color var(--t-fast) }'), []);
  assert.deepEqual(C.motionTokenErrors('.x { animation: row-in var(--t-arrival) var(--ease); transition: none }'), []);
  assert.notDeepEqual(C.cssBraceErrors('a { b: c; '), []);
  assert.notDeepEqual(C.cssBraceErrors('a { } }'), []);
  assert.deepEqual([...C.cssClassSelectors('.a .b:hover, x.c { transition: .5s } @media (x) { .d { } }')].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(C.cssAssetRefs("src: url(geist.woff2), url('data:x'), url(https://x.y/z)", 'fonts/fonts.css'), ['fonts/geist.woff2']);
  assert.deepEqual(C.jsAssetRefs("s.src = 'assets/js/dev-bench.js';"), ['js/dev-bench.js']);
  assert.deepEqual([...C.cssVarsUsed('a { color: var(--x, red); b: var( --y ) }')], ['--x', '--y']);
  const H = 'a'.repeat(64);
  assert.deepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/OFL-a.txt', 'fonts/fonts.css'], `${H}  a.woff2\n${H}  OFL-a.txt\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/b.woff2'], `${H}  a.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2'], `${H}  a.woff2\n${H}  gone.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2'], `${H}  a.woff2\n${H}  a.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/OFL-a.txt'], ''), []);
  // Any depth and any case: an unlisted font must not slip past the manifest by its name or folder.
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/Sneaky.WOFF2'], `${H}  a.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/sub/x.woff2'], `${H}  a.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/sub/OFL-x.txt'], `${H}  a.woff2\n`), []);
  assert.notDeepEqual(C.fontManifestErrors(['fonts/a.woff2', 'fonts/ofl-x.TXT'], `${H}  a.woff2\n`), []);
  const SPR = '<svg aria-hidden="true"><symbol id="i-a" viewBox="0 0 24 24"><path d="M0 0"/></symbol><symbol id="i-b" viewBox="0 0 24 24"><circle r="1"/></symbol></svg>';
  assert.deepEqual(C.iconErrors(h(`${SPR}<svg aria-hidden="true"><use href="#i-a"/></svg>`), "icon('b')"), []);
  assert.notDeepEqual(C.iconErrors(h(`${SPR}<svg aria-hidden="true"><use href="#i-nope"/></svg>`), ''), []);
  assert.notDeepEqual(C.iconErrors(h(`${SPR}<svg><use href="#i-a"/></svg>`), ''), [], 'an <svg> without aria-hidden');
  assert.notDeepEqual(C.iconErrors(h(SPR), "icon('nope')"), []);
  assert.notDeepEqual(C.iconErrors(h('<svg aria-hidden="true"><symbol id="i-a" viewBox="0 0 16 16"><path d="M0 0"/></symbol></svg>'), ''), []);
  assert.notDeepEqual(C.iconErrors(h('<svg aria-hidden="true"><symbol id="i-a" viewBox="0 0 24 24" fill="red"><path d="M0 0"/></symbol></svg>'), ''), []);
  assert.notDeepEqual(C.iconErrors(h('<svg aria-hidden="true"><symbol id="i-a" viewBox="0 0 24 24"><path d="M0 0" onclick="x()"/></symbol></svg>'), ''), []);
  assert.notDeepEqual(C.iconErrors(h('<svg aria-hidden="true"><symbol id="i-a" viewBox="0 0 24 24"><image href="x.png"/></symbol></svg>'), ''), []);
  assert.deepEqual(C.unusedSymbols(h(`${SPR}<svg aria-hidden="true"><use href="#i-a"/></svg>`), "const K = { error: 'b' };"), []);
  assert.deepEqual(C.unusedSymbols(h(`${SPR}<svg aria-hidden="true"><use href="#i-a"/></svg>`), ''), ['sprite symbol i-b is never used']);
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
  const UNREFERENCED_OK = [/^fonts\/OFL-[\w-]+\.txt$/, /^fonts\/SOURCES\.md$/, /^fonts\/SHA256SUMS$/, /^icons\/LICENSE-lucide\.txt$/, /^icons\/SOURCES\.md$/];
  const orphans = assetFiles.filter(f => !refs.includes(f) && !UNREFERENCED_OK.some(re => re.test(f)));
  assert.deepEqual(orphans, [], 'asset files nothing references');
});

test('fonts/SHA256SUMS lists exactly the bundled .woff2 and OFL-*.txt files', () => {
  assert.deepEqual(C.fontManifestErrors(assetFiles, read(path.join(ASSETS, 'fonts', 'SHA256SUMS'))), []);
});

test('every stylesheet has balanced braces', () => {
  assert.deepEqual(cssFiles.flatMap(f => C.cssBraceErrors(f.text, f.path)), []);
});

test('legacy.css shares no class with the foundation and declares only --lg-* tokens', () => {
  const legacy = read(path.join(ASSETS, 'css', 'legacy.css'));
  const foundationClasses = C.cssClassSelectors(read(path.join(ROOT, 'docs', 'design', 'ui-redesign-foundation.css')));
  // `.app` is the foundation root, named on purpose by legacy's two Reduce motion rules (OS and Settings).
  assert.deepEqual([...C.cssClassSelectors(legacy)].filter(c => c !== 'app' && foundationClasses.has(c)), []);
  assert.deepEqual([...C.cssPropsDeclared(legacy)].filter(p => !p.startsWith('--lg-')), []);
  assert.match(legacy, /^@layer legacy \{$/m);
});

test('legacy.css keeps its old specificity: .lg-scope only ever appears inside :where()', () => {
  assert.deepEqual(cssFiles.flatMap(f => C.lgScopeSpecificityErrors(f.text, f.path)), []);
  // Not vacuous: the scoped rules are really there.
  assert.match(read(path.join(ASSETS, 'css', 'legacy.css')), /:where\(\.lg-scope/);
});

test('no inline <style> is left in the page', () => {
  assert.equal(elements(root).filter(el => el.tag === 'style').length, 0);
});

test('foundation.css is the design file, verbatim, inside @layer foundation, after the layer order', () => {
  const css = read(path.join(ASSETS, 'css', 'foundation.css'));
  const m = /^\/\*[\s\S]*?\*\/\n@layer foundation, legacy, app;\n@layer foundation \{\n([\s\S]*)\n\}\n$/.exec(css);
  assert.ok(m, 'expected: header comment, "@layer foundation, legacy, app;", then "@layer foundation {" … "}"');
  const design = read(path.join(ROOT, 'docs', 'design', 'ui-redesign-foundation.css'));
  assert.equal(m[1], design.replace(/\n$/, ''), `regenerate foundation.css from docs/design/ui-redesign-foundation.css: ${REGEN_CMD}`);
  assert.equal(css, buildFoundation(), `foundation.css is not the generator's output; run: ${REGEN_CMD}`);
});

test('legacy regions opt out of the foundation root\'s font smoothing and control font', () => {
  const legacy = read(path.join(ASSETS, 'css', 'legacy.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(legacy, /:where\(\.lg-scope\)\s*\{[^}]*-webkit-font-smoothing:\s*auto\b/,
    'foundation sets antialiased on .app (<html>); legacy regions keep the platform default');
  assert.match(legacy, /:where\(\.lg-scope\)\s+button,\s*:where\(\.lg-scope\)\s+input,\s*:where\(\.lg-scope\)\s+select,\s*:where\(\.lg-scope\)\s+textarea\s*\{[^}]*font:\s*revert\b/,
    'foundation sets font: inherit on controls; legacy controls keep the browser default control font');
});

// Universal-bucket selectors left on purpose, by exact text (see universalSelectorErrors).
const UNIVERSAL_OK = [
  '.app *',                         // box-sizing + scrollbar-width: one attempt per element, nothing else
  '.app :focus', '.app :focus-visible', // fail on the rightmost compound; Chromium files them by focus
  '.log-row > *',                   // one parent step, no walk to the root
  ':where(.lg-scope, .lg-scope *)', // main's * reset, scoped to the legacy regions; leaves with legacy.css (P13)
];

test('no stylesheet puts a selector in the universal bucket or hangs a pseudo-element off one', () => {
  assert.deepEqual(cssFiles.flatMap(f => C.universalSelectorErrors(f.text, `viewer/assets/${f.path}`, UNIVERSAL_OK)), []);
});

test('transitions and animations take their duration from a --t-* token (Reduce motion zeroes them)', () => {
  // legacy.css keeps its literal times until the region PRs replace it; main never reduced them either.
  assert.deepEqual(cssFiles.filter(f => !f.path.endsWith('legacy.css'))
    .flatMap(f => C.motionTokenErrors(f.text, `viewer/assets/${f.path}`)), []);
});

test('both Reduce motion rules zero every --t-* token', () => {
  const design = C.stripCss(read(path.join(ROOT, 'docs', 'design', 'ui-redesign-foundation.css')));
  const tokens = [...new Set([...design.matchAll(/(--t-[\w-]+)\s*:/g)].map(m => m[1]))];
  assert.ok(tokens.length >= 5, `only ${tokens.length} --t-* tokens found`);
  // stripCss blanks strings, so [data-motion="off"] reads [data-motion=""] here.
  for (const sel of ['.app:not([data-motion=""])', '.app[data-motion=""]']) {
    const rule = design.split(sel + ' {')[1];
    assert.ok(rule, `missing rule: ${sel}`);
    const body = rule.slice(0, rule.indexOf('}'));
    for (const t of tokens) assert.match(body, new RegExp(`${t}\\s*:\\s*0s\\b`), `${sel} must set ${t}: 0s`);
  }
});

test('pseudo-elements that set padding, a border or a percentage size declare their own box-sizing', () => {
  // .app * gives elements border-box; ::before/::after keep content-box since v1.2 (no .app *::before).
  // Every stylesheet is checked, so legacy and future region sheets ported from mockup CSS are too.
  assert.ok(cssFiles.length >= 3, 'expected foundation, legacy and base');
  assert.deepEqual(cssFiles.flatMap(f => C.pseudoBoxSizingErrors(f.text, `viewer/assets/${f.path}`)), []);
});

test('every legacy animation or transition is switched off by both Reduce motion rules', () => {
  const legacy = cssFiles.find(f => f.path === 'css/legacy.css').text;
  assert.ok(C.animatedSelectors(legacy).length >= 20, 'the legacy animation scan found too few selectors');
  assert.deepEqual(C.reducedMotionCoverageErrors(legacy, 'viewer/assets/css/legacy.css'), []);
});

test('the WebKit-only @supports detector gates exactly the foundation\'s per-element ::selection and scrollbar rules', () => {
  // universalSelectorErrors allows four universal selectors inside this block. If Chromium ever ships
  // hanging-punctuation the block would also apply there (the cost v1.2 removed), so re-check the
  // detector then: pick another WebKit-only feature and change WEBKIT_DETECTOR / WEBKIT_ONLY together.
  const css = read(path.join(ASSETS, 'css', 'foundation.css'));
  assert.equal(C.WEBKIT_DETECTOR, '@supports (hanging-punctuation: first)');
  assert.equal(C.stripCss(css).split(C.WEBKIT_DETECTOR).length - 1, 2, 'one inline ::selection rule and one scrollbar block');
  const inside = C.cssRules(css).filter(r => r.atRules.includes(C.WEBKIT_DETECTOR)).flatMap(r => r.selectors);
  assert.deepEqual([...new Set(inside)].sort(), [...C.WEBKIT_ALLOW].sort());
});

test('<html> is the foundation root; stylesheets load foundation, legacy, app in that order', () => {
  const htmlEl = root.children.find(el => el.tag === 'html');
  assert.ok((htmlEl.attrs.class || '').split(/\s+/).includes('app'), '<html class="app">');
  const sheets = elements(root).filter(el => el.tag === 'link' && el.attrs.rel === 'stylesheet').map(el => el.attrs.href);
  const order = ['assets/css/foundation.css', 'assets/css/legacy.css', 'assets/css/base.css'];
  assert.deepEqual(sheets.filter(h => order.includes(h)), order);
  assert.match(read(path.join(ASSETS, 'css', 'base.css')), /^@layer app \{$/m);
});

test('the first @layer statement in document order is the foundation order statement', () => {
  // CSS cascade layer order is fixed by the document order of the stylesheets, not by load order:
  // the first block-less `@layer a, b, c;` found in link (document) order fixes it, so it must come from foundation.css.
  const hrefs = elements(root).filter(el => el.tag === 'link' && el.attrs.rel === 'stylesheet').map(el => el.attrs.href);
  let first = null;
  for (const href of hrefs) {
    const p = path.join(ASSETS, ...href.replace(/^assets\//, '').split('/'));
    let text;
    try { text = read(p); } catch (_) { continue; }
    const m = /@layer\s+[\w-]+(?:\s*,\s*[\w-]+)*\s*;/.exec(text.replace(/\/\*[\s\S]*?\*\//g, ''));
    if (m) { first = { href, statement: m[0] }; break; }
  }
  assert.ok(first, 'no @layer order statement found in any linked stylesheet');
  assert.equal(first.href, 'assets/css/foundation.css');
  assert.equal(first.statement, '@layer foundation, legacy, app;');
});

test('every var(--x) used in CSS or inline styles is declared in CSS or set from JS', () => {
  const declared = new Set(cssFiles.flatMap(f => [...C.cssPropsDeclared(f.text)]));
  for (const m of jsText.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)) declared.add(m[1]);
  const styleAttrs = elements(root).map(el => el.attrs.style || '').join('\n');
  const used = new Set([...cssFiles.flatMap(f => [...C.cssVarsUsed(f.text)]), ...C.cssVarsUsed(styleAttrs)]);
  assert.deepEqual([...used].filter(v => !declared.has(v)).sort(), []);
});

test('offline: no network URL in the page, its CSS or its JS (local WebSockets excepted)', () => {
  const problems = [
    ...C.offlineErrors(html, 'viewer/applogs-viewer.html'),
    ...cssFiles.flatMap(f => C.offlineErrors(f.text, `viewer/assets/${f.path}`)),
    ...allJs.filter(s => s.filename !== 'viewer/applogs-viewer.html').flatMap(s => C.offlineErrors(s.code, s.filename)),
  ];
  assert.deepEqual(problems, []);
});

test('prefs.js is the only head script: first, synchronous, before every stylesheet', () => {
  const head = root.children.find(el => el.tag === 'html').children.find(el => el.tag === 'head');
  const ordered = head.children.filter(el => el.tag === 'script' || el.tag === 'style' || (el.tag === 'link' && el.attrs.rel === 'stylesheet'));
  const scripts = ordered.filter(el => el.tag === 'script');
  assert.equal(scripts.length, 1, 'exactly one <script> in <head>');
  assert.equal(ordered[0], scripts[0], 'prefs.js comes before every stylesheet');
  assert.equal(scripts[0].attrs.src, 'assets/js/prefs.js');
  assert.ok(!('async' in scripts[0].attrs) && !('defer' in scripts[0].attrs) && !('type' in scripts[0].attrs));
});

test('legacy log columns 2-6 are sized in ch, so they follow the log text size', () => {
  const colWidths = (r) => {
    const cg = elements(r).find(el => el.attrs.id === 'colgroup');
    assert.ok(cg, '#colgroup exists');
    return cg.children.filter(el => el.tag === 'col').map(el => (el.attrs.style || '').match(/width:\s*([^;]+)/)?.[1].trim());
  };
  const isCh = (w) => /^calc\(\d+(\.\d+)?ch \+ 20px\)$/.test(w || '');
  const widths = colWidths(root);
  assert.equal(widths.length, 7);
  assert.equal(widths[0], '28px');
  widths.slice(1, 6).forEach((w, i) => assert.ok(isCh(w), `column ${i + 2} width ${w} is calc(Nch + 20px)`));
  // Broken input: a px width must fail the same check.
  const broken = parseHtml('<table><colgroup id="colgroup"><col style="width:28px"><col style="width:190px"></colgroup></table>').root;
  assert.ok(!isCh(colWidths(broken)[1]), 'a px width is rejected');
});

test('legacy log table min-width keeps a Message floor that follows the log font', () => {
  // 102ch = 78ch of sized columns 2-6 + a 24ch Message floor. 148px = 28px column 1 + 5x20px padding on
  // columns 2-6 + 20px Message padding. Both terms scale with the table's own font, so the floor grows with the text.
  const css = C.stripCss(read(path.join(ASSETS, 'css', 'legacy.css')));
  const rules = [...css.matchAll(/(?:^|[\s}])table\s*\{([^}]*)\}/g)];
  assert.equal(rules.length, 1, 'legacy.css has exactly one bare table rule');
  assert.equal(rules[0][1].match(/min-width:\s*([^;]+);/)?.[1].trim(), 'max(960px, calc(102ch + 148px))');
});
