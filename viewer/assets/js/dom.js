/* DOM builders for the redesigned regions (roadmap P3). Classic script; registers ALV.createDom and,
   in the page, ALV.dom. The XSS invariant lives here: el() puts strings in Text nodes and never parses
   HTML, and it refuses the HTML-string property names outright.

   ALV.dom.el(tag, props?, ...children)
     props: class, id, text, hidden, dataset {k: v}, on {type: fn}, and any other attribute
            (aria-*, role, type, tabindex, data-*, value ...; true sets an empty attribute,
            null / undefined / false skips it)
     children: Nodes, strings and numbers (Text nodes), arrays (flattened); null / false skipped
   ALV.dom.icon(name, cls?)    <svg class="icon" aria-hidden="true"><use href="#i-name"></svg>
   ALV.dom.portal(node, layer) appends to #overlayRoot's 'popover' | 'dialog' | 'tip' layer
   ALV.dom.focusables(root)    visible, enabled, tabbable descendants in DOM order
   ALV.dom.INTERACTIVE         drag-band exclusion selector (initTopbarDrag; P4 initDragBand) */
(function (g) {
  'use strict';

  // A mousedown on anything matching this never starts a window drag. tests/viewer/static.test.mjs
  // reads this literal (the only `const INTERACTIVE` in the viewer) for its drag-band lint.
  const INTERACTIVE = 'button, input, select, textarea, a, label, [role=button], [role=switch], [role=radio], [role=tab], [role=slider], [role=combobox], [data-no-drag], .zoom-group, .theme-switch, .glass-switch';
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Compared lowercased: setAttribute lowercases names on HTML elements, so srcDoc / onClick would land as srcdoc / onclick.
  const HTML_PROPS = new Set(['innerhtml', 'outerhtml', 'html', 'srcdoc']);

  function createDom(doc) {
    let seq = 0;

    function append(parent, child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { for (const c of child) append(parent, c); return; }
      parent.appendChild(typeof child === 'object' ? child : doc.createTextNode(String(child)));
    }

    function el(tag, props, ...children) {
      const node = doc.createElement(tag);
      for (const [k, v] of Object.entries(props || {})) {
        const lk = k.toLowerCase();
        if (HTML_PROPS.has(lk)) throw new TypeError(`dom.el: "${k}" is not allowed; pass text or child nodes`);
        if (/^on./.test(lk)) throw new TypeError(`dom.el: use on: { ${k.slice(2)}: fn } instead of "${k}"`);
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = String(v);
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'hidden') node.hidden = true;
        else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
        else if (k === 'on') for (const [type, fn] of Object.entries(v)) node.addEventListener(type, fn);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
      append(node, children);
      return node;
    }

    function icon(name, cls) {
      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const use = doc.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', `#i-${name}`);
      svg.appendChild(use);
      return svg;
    }

    // The overlay layers are static markup at the end of <body> (viewer/applogs-viewer.html).
    function layer(name) {
      if (name === 'dialog') return doc.getElementById('ovDialogs');
      if (name === 'tip') return doc.getElementById('ovTips');
      return doc.getElementById('ovPopovers');
    }
    function portal(node, name) { layer(name).appendChild(node); return node; }

    // FOCUSABLE also matches a button or input with tabindex="-1" (a roving radio that is not the current
    // one), so those are dropped here: the dialog trap and the popover Tab-out count tabbable stops only.
    function focusables(root) {
      return Array.from(root.querySelectorAll(FOCUSABLE))
        .filter(n => n.getAttribute('tabindex') !== '-1' && !(n.closest && n.closest('[inert]')))
        .filter(n => !n.hidden && !n.inert && n.getClientRects().length > 0);
    }

    function clear(node) { node.textContent = ''; return node; }
    function uid(prefix) { seq += 1; return `alv-${prefix}-${seq}`; }

    return { el, icon, layer, portal, focusables, clear, uid, INTERACTIVE, FOCUSABLE };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.createDom = createDom;
  if (typeof document !== 'undefined' && document.documentElement) ALV.dom = createDom(document);
})(typeof window !== 'undefined' ? window : globalThis);
