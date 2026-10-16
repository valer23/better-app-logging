// A small fake page for the DOM side of the primitives (ui.test.mjs) and the shell (shell.test.mjs):
// elements with attributes, children, listeners and the few layout reads they make, a fake window with a
// manual clock, and the viewer's classic scripts loaded into one EMPTY vm context.
import { loadPureModules, read, HTML_PATH, memoryStorage, fakeMatchMedia, fakeRoot } from './_load.mjs';
import { parseHtml, findById } from './_html.mjs';

// fakePage({ files, platform, tauri }): `files` are the viewer scripts to load (dom.js, keys.js and ui.js
// by default); `tauri` becomes window.__TAURI__. win.listeners records the window listeners.
export function fakePage({ files = ['dom.js', 'keys.js', 'ui.js'], platform = 'mac', tauri = undefined } = {}) {
  const byId = {};
  let focused = null;
  let focusVisible = false;   // what ':focus-visible' answers; tests flip it with setFocusVisible
  const node = tag => {
    const n = {
      tagName: tag.toUpperCase(), attrs: {}, children: [], parent: null, listeners: {}, dataset: {}, style: {},
      hidden: false, inert: false, className: '', textContent: '', id: '', offsetWidth: 120, offsetHeight: 40,
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); byId[v] = this; } },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { if (c.parent) c.remove(); c.parent = this; this.children.push(c); return c; },
      insertBefore(c, ref) {
        if (!ref) return this.appendChild(c);
        if (c.parent) c.remove();
        c.parent = this;
        this.children.splice(this.children.indexOf(ref), 0, c);
        return c;
      },
      remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); },
      // Bubbles like a real event, so delegated listeners (the menu's click on its list) see it.
      fire(type, ev = {}) {
        for (let n = this; n; n = n.parent) for (const fn of n.listeners[type] || []) fn({ target: this, currentTarget: n, preventDefault() {}, ...ev });
      },
      contains(x) { for (let p = x; p; p = p.parent) if (p === this) return true; return false; },
      querySelector(sel) { return all(this).find(c => matches(c, sel)) || null; },
      querySelectorAll(sel) { return all(this).filter(c => matches(c, sel)); },
      closest(sel) { for (let p = this; p; p = p.parent) if (matches(p, sel)) return p; return null; },
      matches(sel) { return sel === ':focus-visible' ? focusVisible : matches(this, sel); },
      getClientRects() { return this.hidden ? [] : [1]; },
      getBoundingClientRect: () => ({ left: 500, top: 40, right: 580, bottom: 68, width: 80, height: 28 }),
      focus() { focused = this; },
      click() { this.fire('click'); },
      get isConnected() { return true; },
      // The few classList calls the page makes, over the className string.
      get classList() {
        const el = this, list = () => String(el.className).split(/\s+/).filter(Boolean);
        return {
          contains: c => list().includes(c),
          add: c => { if (!list().includes(c)) el.className = [...list(), c].join(' '); },
          remove: c => { el.className = list().filter(x => x !== c).join(' '); },
          toggle(c, force) { const on = force === undefined ? !list().includes(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
        };
      },
    };
    return n;
  };
  const all = n => n.children.flatMap(c => [c, ...all(c)]);
  // The selector forms the primitives and the shell use: a tag, a .class, [attr] and [attr="v"] or [attr=v],
  // as a comma-separated list (ALV.dom.INTERACTIVE).
  const matches = (el, sel) => !!el.attrs && sel.split(',').map(s => s.trim()).some(s => {
    if (/^[a-z][\w-]*$/.test(s)) return el.tagName === s.toUpperCase();
    if (/^(\.[\w-]+)+$/.test(s)) { const cls = String(el.className).split(/\s+/); return s.slice(1).split('.').every(c => cls.includes(c)); }
    const m = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(s);
    return !!m && m[1] in el.attrs && (m[2] === undefined || el.attrs[m[1]] === m[2]);
  });
  const doc = {
    listeners: {},
    hidden: false,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    createElement: tag => node(tag),
    createElementNS: (ns, tag) => node(tag),
    createTextNode: data => ({ nodeType: 3, textContent: data, attrs: {}, children: [], parent: null }),
    getElementById: id => byId[id] || null,
    querySelector(sel) { return this.body.querySelector(sel); },   // the shell's modal guard ('.modal-overlay.visible')
    documentElement: { clientWidth: 1400, clientHeight: 900 },
    body: node('body'),
    get activeElement() { return focused; },
  };
  for (const id of ['overlayRoot', 'ovDialogs', 'ovPopovers', 'toastAlerts', 'toastLive', 'ovTips', 'announcer', 'filterbar']) {
    doc.createElement('div').setAttribute('id', id);
  }
  doc.body.appendChild(byId.filterbar);
  doc.body.appendChild(byId.overlayRoot);
  let clock = 0;
  let timers = [];
  let timerId = 0;
  const win = {
    listeners: {},
    __TAURI__: tauri,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    setTimeout(fn, ms) { timers.push({ fn, at: clock + ms, id: ++timerId }); return timerId; },
    clearTimeout() {},
    setInterval(fn, ms) { const id = ++timerId; const tick = () => { timers.push({ fn: () => { tick(); fn(); }, at: clock + ms, id }); }; tick(); return id; },
    clearInterval(id) { timers = timers.filter(t => t.id !== id); },
  };
  // Advance the clock, running due timers in time order (a cleared timeout may still run: the
  // primitives re-check their state, as they must with real timers).
  const advance = ms => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(t => t !== due);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = end;
  };
  const ALV = loadPureModules(...files);
  const dom = ALV.createDom(doc);
  const keys = ALV.createKeys({ platform });
  const ui = ALV.createUi({ doc, win, dom, keys, now: () => clock });
  return { ALV, doc, win, byId, dom, keys, ui, advance, node, now: () => clock, focus: n => { focused = n; }, setFocusVisible: v => { focusVisible = v; } };
}

export const texts = n => (n.textContent || '') + n.children.map(texts).join('');

const PAGE = parseHtml(read(HTML_PATH)).root;
// Builds the page's markup for `id` (viewer/applogs-viewer.html) as fake nodes on `p`'s <body>, so the DOM
// tests run against the ids, roles and attributes the page ships. Text between tags is not kept: the shell
// writes every text it shows.
export function mount(p, id) {
  const build = el => {
    const n = p.doc.createElement(el.tag);
    for (const [k, v] of Object.entries(el.attrs)) {
      if (k === 'class') n.className = v; else if (k === 'hidden') n.hidden = true; else n.setAttribute(k, v);
    }
    for (const c of el.children) n.appendChild(build(c));
    return n;
  };
  return p.doc.body.appendChild(build(findById(PAGE, id)));
}

// A shell (ALV.createShell) on a fake page with the page's sidebar mounted. `st` overrides what the legacy
// script's shellState() returns; an action without a function in `actions` is recorded in `calls`.
export const DARK = '(prefers-color-scheme: dark)';
const UA = { mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', other: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
// prefs: a real ALV.createPrefs on memory storage, with the OS appearance `osDark` (mm.fire changes it).
export function shellPage({ platform = 'mac', st = {}, actions = {}, tauri, osDark = true, files = ['prefs.js', 'dom.js', 'keys.js', 'ui.js', 'shell.js'] } = {}) {
  const p = fakePage({ files, platform, tauri });
  mount(p, 'sidebar');
  const mm = fakeMatchMedia({ [DARK]: osDark });
  const prefs = p.ALV.createPrefs({ storage: memoryStorage(), matchMedia: mm, userAgent: UA[platform] });
  prefs.boot(fakeRoot());
  const live = { kind: 'live', name: 'Live session', all: [], follow: true };
  const file = { kind: 'file', name: 'File', all: [], follow: false };
  const calls = [];
  const state = {
    cur: live, sessions: [live, file],
    live: { android: false, ios: false },
    status: { android: { state: 'disconnected', text: 'Disconnected' }, ios: { state: 'disconnected', text: 'Disconnected' } },
    devices: { android: { id: '', name: '' }, ios: { id: '', name: '' } },
    driverMissing: false, lines: { android: 0, ios: 0 }, dropped: { android: 0, ios: 0 }, enabled: new Set(['android', 'ios']),
    ...st,
  };
  const act = new Proxy(actions, { get: (o, k) => o[k] || ((...a) => calls.push([k, ...a])) });
  const shell = p.ALV.createShell({ doc: p.doc, win: p.win, dom: p.dom, ui: p.ui, keys: p.keys, prefs, now: p.now, state: () => state, actions: act });
  shell.sync();
  return { p, shell, state, live, file, calls, prefs, mm, $: id => p.byId[id] };
}
