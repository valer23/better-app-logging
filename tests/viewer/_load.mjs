// Loaders and fakes for the viewer tests. Zero dependencies: node:vm runs the viewer's classic
// scripts exactly as the WebView does (one shared global scope, no bundler, no modules).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHtml, elements } from './_html.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VIEWER = path.join(ROOT, 'viewer');
export const ASSETS = path.join(VIEWER, 'assets');
export const HTML_PATH = path.join(VIEWER, 'applogs-viewer.html');
export const read = p => fs.readFileSync(p, 'utf8');

// Every file under viewer/assets as a POSIX path relative to it ("css/legacy.css"); dotfiles skipped.
export function listAssets(dir = ASSETS, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const rel = prefix + ent.name;
    if (ent.isDirectory()) out.push(...listAssets(path.join(dir, ent.name), rel + '/'));
    else out.push(rel);
  }
  return out.sort();
}

// Inline (no src) <script> blocks of the viewer page: [{ code, line }].
export function inlineScripts(html = read(HTML_PATH)) {
  const { root } = parseHtml(html);
  return elements(root)
    .filter(el => el.tag === 'script' && !('src' in el.attrs))
    .map(el => ({ code: el.text, line: el.textLine }));
}

// The page's <script src> files in document order, as paths under viewer/ ("assets/js/prefs.js").
export function pageScriptSrcs(html = read(HTML_PATH)) {
  const { root } = parseHtml(html);
  return elements(root)
    .filter(el => el.tag === 'script' && 'src' in el.attrs)
    .map(el => el.attrs.src);
}

// In-memory Storage. `throwing: true` makes every access throw, like a WebView with storage blocked.
export function memoryStorage(initial = {}, { throwing = false } = {}) {
  const map = new Map(Object.entries(initial));
  const guard = () => { if (throwing) throw new Error('SecurityError: storage disabled'); };
  return {
    map,
    getItem(k) { guard(); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { guard(); map.set(k, String(v)); },
    removeItem(k) { guard(); map.delete(k); },
  };
}

// matchMedia fake: `state` maps a media query string to a boolean; fire(q, value) flips it and
// notifies listeners the way a MediaQueryList 'change' event does.
export function fakeMatchMedia(state = {}) {
  const listeners = new Map();
  const mm = q => ({
    get matches() { return !!state[q]; },
    media: q,
    addEventListener(type, fn) {
      if (type !== 'change') return;
      if (!listeners.has(q)) listeners.set(q, []);
      listeners.get(q).push(fn);
    },
    removeEventListener() {},
  });
  mm.fire = (q, value) => {
    state[q] = value;
    for (const fn of listeners.get(q) || []) fn({ matches: value, media: q });
  };
  return mm;
}

// A stand-in for <html>: records attributes and inline custom properties.
export function fakeRoot() {
  const attrs = {};
  const props = {};
  return {
    attrs,
    props,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    style: { setProperty(k, v) { props[k] = v; } },
  };
}

// A seeded PRNG with good low bits (mulberry32): rng(seed)(n) is an integer in [0, n). The property tests share it; an LCG
// reduced with `% n` locks the low bit and leaves even moduli almost always on multiples of 4, which silently skipped
// most of the operations and characters those tests claim to cover.
export function rng(seed) {
  let s = seed | 0;
  return n => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

// Runs viewer/assets/js/prefs.js in an EMPTY context (no document, no window, no storage), so it
// must not touch the DOM at load and does not auto-boot. Returns that context's ALV namespace.
export function loadPrefsModule() {
  const ctx = vm.createContext({});
  vm.runInContext(read(path.join(ASSETS, 'js', 'prefs.js')), ctx, { filename: 'prefs.js' });
  return ctx.ALV;
}

// Runs a PURE viewer/assets/js file (session.js, and the later query.js, counts.js …) in an EMPTY
// context, so any DOM, storage or timer use at load throws. Returns that context's ALV namespace.
export function loadPureModule(file) {
  const ctx = vm.createContext({});
  vm.runInContext(read(path.join(ASSETS, 'js', file)), ctx, { filename: file });
  return ctx.ALV;
}

// Runs several PURE files, in order, in ONE empty context, as the page loads them (dom.js, keys.js, ui.js).
export function loadPureModules(...files) {
  const ctx = vm.createContext({});
  for (const file of files) vm.runInContext(read(path.join(ASSETS, 'js', file)), ctx, { filename: file });
  return ctx.ALV;
}

// A Proxy that answers every property read, call and `new` with another stub, so the legacy
// inline script's top-level DOM wiring runs without a browser. Deliberately NOT thenable.
export function deepStub(name = 'stub') {
  const store = new Map();
  return new Proxy(function () {}, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      if (store.has(k)) return store.get(k);
      const v = deepStub(`${name}.${String(k)}`);
      store.set(k, v);
      return v;
    },
    set(_t, k, v) { store.set(k, v); return true; },
    apply() { return deepStub(`${name}()`); },
    construct() { return deepStub(`new ${name}`); },
  });
}

// A deepStub document whose getElementById returns the same stub for an id every time, so a test
// can read back what the legacy script wrote (textContent, title, value). `hidden` is a plain
// writable flag: true (the default) keeps the live drain on its data-only path (renderLiveTail only
// marks the DOM stale), false runs the render paths against stubs. `values` seeds input values.
export function stickyDocument({ hidden = true, values = { search: '', tagFilter: '', pidFilter: '' } } = {}) {
  const els = new Map();
  const doc = deepStub('document');
  doc.hidden = hidden;
  // addEventListener on a sticky element records its listeners here as `${id}:${type}` -> [fn], so a
  // test can call a handler the page registered (a delegated click on #logTable, say).
  const listeners = new Map();
  doc.listeners = listeners;
  // Focus: focus() / blur() on a sticky element move document.activeElement (null = <body>), so a test can
  // read where the page parked focus (the pill hiding under a keyboard activation).
  doc.activeElement = null;
  doc.getElementById = id => {
    if (!els.has(id)) {
      const el = deepStub(`#${id}`);
      if (Object.prototype.hasOwnProperty.call(values, id)) el.value = values[id];
      // A real class list, so a test can mark an element (stallModal 'visible') and querySelector can find it.
      const classes = new Set();
      el.classList = {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      };
      el.focus = () => { doc.activeElement = el; };
      el.blur = () => { if (doc.activeElement === el) doc.activeElement = null; };
      el.addEventListener = (type, fn) => {
        const k = `${id}:${type}`;
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
      };
      els.set(id, el);
    }
    return els.get(id);
  };
  // Minimal querySelector: one compound class selector ('.modal-overlay.visible') over the elements a
  // page or test has already touched by id; null when none matches (a deepStub would always be truthy).
  doc.querySelector = sel => {
    const wanted = /^(\.[\w-]+)+$/.test(sel) ? sel.slice(1).split('.') : null;
    if (!wanted) return deepStub(`document.querySelector(${sel})`);
    for (const el of els.values()) if (wanted.every(c => el.classList.contains(c))) return el;
    return null;
  };
  return doc;
}

// Loads the legacy inline <script> (the last one on the page) the way the page does: every
// <script src> first, in page order (prefs.js booted against a fake <html>), then the legacy code
// with stubbed browser globals. Returns { api, run } where api holds the requested top-level
// bindings and run(code) evaluates more code in the same global scope (to read or assign top-level
// bindings). `now` pins Date (ms since epoch) so year-dependent parsers are deterministic.
// `document` replaces the default deepStub (see stickyDocument). `stored` seeds localStorage (unprefixed keys
// are the caller's: 'applogs-viewer.material'), `fetchImpl` replaces the never-settling fetch, and `platform`
// gives <html> a data-platform attribute (the page's IS_MAC reads it) on top of a deepStub document.
// Deleted in P13 together with the last of the legacy inline script.
export function loadLegacy(names, { now = Date.UTC(2026, 9, 14, 13, 53, 43, 120), document = deepStub('document'), stored = {}, fetchImpl = null, platform = null } = {}) {
  const scripts = inlineScripts();
  const main = scripts[scripts.length - 1];
  if (platform) document.documentElement.getAttribute = k => (k === 'data-platform' ? platform : null);   // the rest of <html> stays a stub
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    document,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    localStorage: memoryStorage(stored),
    location: { search: '' },
    fetch: fetchImpl || (() => new Promise(() => {})),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    performance: { now: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: fakeMatchMedia(),
    alert() {}, confirm: () => false,
    addEventListener() {}, removeEventListener() {},
    WebSocket: function WebSocket() { return deepStub('ws'); },
    FileReader: class { readAsText(file) { this.onload({ target: { result: file.text } }); } },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`(() => {
    const RealDate = Date, FIXED = ${Number(now)};
    globalThis.Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(FIXED); }
      static now() { return FIXED; }
    };
  })();`, ctx);
  for (const src of pageScriptSrcs()) {
    vm.runInContext(read(path.join(VIEWER, src)), ctx, { filename: src });
    if (src !== 'assets/js/prefs.js') continue;
    sandbox.ALV.prefs = sandbox.ALV.createPrefs({
      storage: sandbox.localStorage, matchMedia: sandbox.matchMedia, userAgent: sandbox.navigator.userAgent,
    });
    sandbox.ALV.prefs.boot(fakeRoot());
  }
  const exportList = names.map(n => `${JSON.stringify(n)}: (typeof ${n} === 'undefined' ? undefined : ${n})`).join(', ');
  vm.runInContext(`${main.code}\n;globalThis.__api = { ${exportList} };`, ctx, {
    filename: 'applogs-viewer.html', lineOffset: main.line - 1,
  });
  return { api: ctx.__api, run: code => vm.runInContext(code, ctx) };
}
