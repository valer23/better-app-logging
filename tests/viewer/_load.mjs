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

// Runs viewer/assets/js/prefs.js in an EMPTY context (no document, no window, no storage), so it
// must not touch the DOM at load and does not auto-boot. Returns that context's ALV namespace.
export function loadPrefsModule() {
  const ctx = vm.createContext({});
  vm.runInContext(read(path.join(ASSETS, 'js', 'prefs.js')), ctx, { filename: 'prefs.js' });
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
  doc.getElementById = id => {
    if (!els.has(id)) {
      const el = deepStub(`#${id}`);
      if (Object.prototype.hasOwnProperty.call(values, id)) el.value = values[id];
      els.set(id, el);
    }
    return els.get(id);
  };
  return doc;
}

// Loads the legacy inline <script> (the last one on the page) the way the page does: every
// <script src> first, in page order (prefs.js booted against a fake <html>), then the legacy code
// with stubbed browser globals. Returns { api, run } where api holds the requested top-level
// bindings and run(code) evaluates more code in the same global scope (to read or assign top-level
// bindings). `now` pins Date (ms since epoch) so year-dependent parsers are deterministic.
// `document` replaces the default deepStub (see stickyDocument).
// Deleted in P13 together with the last of the legacy inline script.
export function loadLegacy(names, { now = Date.UTC(2026, 9, 14, 13, 53, 43, 120), document = deepStub('document') } = {}) {
  const scripts = inlineScripts();
  const main = scripts[scripts.length - 1];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    document,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    localStorage: memoryStorage(),
    location: { search: '' },
    fetch: () => new Promise(() => {}),
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
