// The DOM builders (viewer/assets/js/dom.js): text goes into Text nodes, HTML-string properties are
// refused, icons reference the inline sprite, and the drag-band selector carries the roadmap list.
// dom.js loads in an EMPTY vm context (no document), so it must not touch the DOM at load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';

const ALV = loadPureModule('dom.js');

// Just enough of a document for el(), icon() and portal(). Assigning innerHTML on any node throws,
// so a builder that took the HTML path fails the test that exercises it.
function fakeDocument() {
  const byId = {};
  const node = (tag, ns = null) => {
    const n = {
      tagName: tag.toUpperCase(), ns, attrs: {}, children: [], listeners: {}, dataset: {}, hidden: false, className: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      set textContent(v) { this.children = [{ nodeType: 3, data: String(v) }]; },
      get textContent() { return this.children.map(c => (c.nodeType === 3 ? c.data : c.textContent)).join(''); },
    };
    Object.defineProperty(n, 'innerHTML', { set() { throw new Error('innerHTML was assigned'); } });
    return n;
  };
  return {
    byId,
    createElement: tag => node(tag),
    createElementNS: (ns, tag) => node(tag, ns),
    createTextNode: data => ({ nodeType: 3, data }),
    getElementById: id => byId[id] || null,
  };
}

test('dom.js loads in an empty context and does not build a page instance there', () => {
  assert.equal(typeof ALV.createDom, 'function');
  assert.equal(ALV.dom, undefined);
});

test('el sets class, id, text, attributes, dataset and listeners; true is an empty attribute, null/false skip', () => {
  const d = ALV.createDom(fakeDocument());
  const click = () => {};
  const b = d.el('button', { class: 'btn', id: 'x', type: 'button', 'aria-pressed': 'false', 'data-primary': true, title: null, disabled: false, dataset: { scope: 'all' }, on: { click } }, 'Go');
  assert.equal(b.tagName, 'BUTTON');
  assert.equal(b.className, 'btn');
  assert.deepEqual({ ...b.attrs }, { id: 'x', type: 'button', 'aria-pressed': 'false', 'data-primary': '' });
  assert.equal(b.dataset.scope, 'all');
  assert.deepEqual(b.listeners.click, [click]);
  assert.equal(b.textContent, 'Go');
  assert.equal(d.el('span', { text: '<b>x</b>' }).textContent, '<b>x</b>');
  assert.equal(d.el('div', { hidden: true }).hidden, true);
});

test('el puts strings and numbers in Text nodes, flattens arrays and skips null and false', () => {
  const d = ALV.createDom(fakeDocument());
  const inner = d.el('b', null, 'bold');
  const p = d.el('p', null, '<img src=x onerror=alert(1)>', 42, null, false, [inner, ['tail']]);
  assert.deepEqual(p.children.map(c => c.nodeType === 3 ? c.data : c.tagName), ['<img src=x onerror=alert(1)>', '42', 'B', 'tail']);
});

test('el refuses HTML-string properties and on* attributes', () => {
  const d = ALV.createDom(fakeDocument());
  for (const k of ['innerHTML', 'outerHTML', 'html', 'srcdoc']) assert.throws(() => d.el('div', { [k]: '<b>x</b>' }), /not allowed/, k);
  assert.throws(() => d.el('button', { onclick: 'alert(1)' }), /on: \{ click: fn \}/);
  // setAttribute lowercases names on HTML elements, so the React spellings must be refused too.
  assert.throws(() => d.el('button', { onClick: () => {} }), /on: \{ Click: fn \}/);
  assert.throws(() => d.el('div', { ONCLICK: 'x' }), /on: \{ CLICK: fn \}/);
  for (const k of ['srcDoc', 'SRCDOC', 'OuterHTML', 'InnerHtml', 'HTML']) assert.throws(() => d.el('div', { [k]: '<b>x</b>' }), /not allowed/, k);
  assert.equal(d.el('div', { on: { click() {} } }).tagName, 'DIV');
});

test('icon is an aria-hidden SVG that uses the sprite symbol #i-<name>', () => {
  const d = ALV.createDom(fakeDocument());
  const svg = d.icon('download');
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.deepEqual({ ...svg.attrs }, { class: 'icon', 'aria-hidden': 'true', focusable: 'false' });
  assert.equal(svg.children[0].tagName, 'USE');
  assert.equal(svg.children[0].attrs.href, '#i-download');
  assert.equal(d.icon('check', 'menu-check').attrs.class, 'icon menu-check');
});

test('portal appends to the named overlay layer; uid never repeats', () => {
  const doc = fakeDocument();
  for (const id of ['ovPopovers', 'ovDialogs', 'ovTips']) doc.byId[id] = doc.createElement('div');
  const d = ALV.createDom(doc);
  const a = d.el('div'), b = d.el('div'), c = d.el('div');
  d.portal(a, 'popover'); d.portal(b, 'dialog'); d.portal(c, 'tip');
  assert.deepEqual([doc.byId.ovPopovers.children[0], doc.byId.ovDialogs.children[0], doc.byId.ovTips.children[0]], [a, b, c]);
  const ids = new Set(Array.from({ length: 50 }, () => d.uid('tip')));
  assert.equal(ids.size, 50);
  assert.match([...ids][0], /^alv-tip-\d+$/);
});

test('focusables keeps tabbable stops only: no tabindex="-1" control (a roving radio), nothing hidden or inert', () => {
  const d = ALV.createDom(fakeDocument());
  const ctl = (attrs = {}, extra = {}) => ({ getAttribute: n => (n in attrs ? attrs[n] : null), closest: () => null,
    hidden: false, inert: false, getClientRects: () => [1], ...extra });
  const btnA = ctl();
  const radioMinus1 = ctl({ tabindex: '-1', role: 'radio' });
  const btnB = ctl();
  const hidden = ctl({}, { hidden: true, getClientRects: () => [] });
  const inInert = ctl({}, { closest: sel => (sel === '[inert]' ? {} : null) });
  const got = d.focusables({ querySelectorAll: () => [btnA, radioMinus1, hidden, inInert, btnB] });
  assert.equal(got.length, 2);
  assert.ok(got[0] === btnA && got[1] === btnB);
});

test('INTERACTIVE carries every roadmap selector, the widget roles the shell builds, and the legacy topbar classes', () => {
  const sel = ALV.createDom(fakeDocument()).INTERACTIVE.split(',').map(s => s.trim());
  for (const s of ['button', 'input', 'select', 'textarea', 'a', 'label', '[role=button]', '[role=switch]', '[role=radio]',
    '[role=tab]', '[role=slider]', '[role=combobox]', '[role=checkbox]', '[role=menuitem]', '[role=menuitemradio]',
    '[role=menuitemcheckbox]', '[role=option]', '[role=link]', '[data-no-drag]', '.zoom-group', '.theme-switch', '.glass-switch']) {
    assert.ok(sel.includes(s), `INTERACTIVE lacks ${s}`);
  }
});
