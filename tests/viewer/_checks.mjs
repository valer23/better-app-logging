// Pure check functions behind static.test.mjs. Each returns a list of human-readable problems
// (empty = pass), so static.test.mjs can run them on the real files AND on broken snippets.
import vm from 'node:vm';
import { elements, closestWithin, findById } from './_html.mjs';

// Every script compiles. sources: [{ code, filename, line }]
export function scriptSyntaxErrors(sources) {
  const out = [];
  for (const s of sources) {
    try { new vm.Script(s.code, { filename: s.filename, lineOffset: (s.line || 1) - 1 }); }
    catch (e) { out.push(`${s.filename}: ${e.message}`); }
  }
  return out;
}

// No duplicate ids.
export function duplicateIds(root) {
  const seen = new Map();
  const out = [];
  for (const el of elements(root)) {
    const id = el.attrs.id;
    if (id === undefined) continue;
    if (seen.has(id)) out.push(`id "${id}" on line ${el.line} duplicates line ${seen.get(id)}`);
    else seen.set(id, el.line);
  }
  return out;
}

// Literal ids the JS looks up: getElementById('x'), getElementById(c ? 'x' : 'y'), and #x inside
// querySelector / querySelectorAll / closest selector strings.
export function referencedIds(js) {
  const ids = new Set();
  const byId = /getElementById\(\s*(?:(?:[^()?'"`]|'[^']*'|"[^"]*")*\?\s*)?(['"])([\w-]+)\1\s*(?::\s*(['"])([\w-]+)\3\s*)?\)/g;
  for (const m of js.matchAll(byId)) { ids.add(m[2]); if (m[4]) ids.add(m[4]); }
  const bySel = /(?:querySelector(?:All)?|closest)\(\s*(['"])([^'"]*)\1/g;
  for (const m of js.matchAll(bySel)) for (const h of m[2].matchAll(/#([\w-]+)/g)) ids.add(h[1]);
  return ids;
}

// Id contract: every id the JS names exists in the page (or is created at runtime: `allow`).
export function missingIds(root, js, allow = []) {
  const have = new Set(elements(root).map(el => el.attrs.id).filter(id => id !== undefined));
  return [...referencedIds(js)]
    .filter(id => !have.has(id) && !allow.includes(id))
    .map(id => `JS references #${id}, which is not in the HTML`);
}

// Top-level function declarations (column 0) and window.X assignments: the globals that inline
// on*="" handlers can call.
export function definedGlobals(js) {
  const out = new Set();
  for (const m of js.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) out.add(m[1]);
  for (const m of js.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) out.add(m[1]);
  return out;
}

// Handler contract: every on*="fn(...)" calls a defined global.
export function handlerErrors(root, js) {
  const globals = definedGlobals(js);
  const out = [];
  for (const el of elements(root)) {
    for (const [name, value] of Object.entries(el.attrs)) {
      if (!name.startsWith('on')) continue;
      const m = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(value);
      if (!m) out.push(`line ${el.line}: ${name}="${value}" is not a plain function call`);
      else if (!globals.has(m[1])) out.push(`line ${el.line}: ${name} calls ${m[1]}(), which is not a global function`);
    }
  }
  return out;
}

// XSS lint: innerHTML may only be cleared; no other HTML-string sinks.
export function xssErrors(js, filename = 'script', firstLine = 1) {
  const out = [];
  js.split('\n').forEach((text, i) => {
    const at = `${filename}:${firstLine + i}`;
    // .innerHTML or ['innerHTML'], with = or +=; += is always an error (it appends markup).
    for (const m of text.matchAll(/(?:\.innerHTML|\[\s*['"]innerHTML['"]\s*\])\s*(\+?=)(?!=)\s*([^;]*)/g)) {
      if (m[1] === '+=' || !/^(''|""|``)$/.test(m[2].trim())) out.push(`${at}: innerHTML assigned something other than ''`);
    }
    if (/\bcreateContextualFragment\s*\(|\bsetHTMLUnsafe\s*\(|\bparseFromString\s*\(/.test(text)) out.push(`${at}: HTML string parsed into nodes`);
    if (/\.outerHTML\s*=(?!=)/.test(text)) out.push(`${at}: outerHTML assignment`);
    if (/\binsertAdjacentHTML\s*\(/.test(text)) out.push(`${at}: insertAdjacentHTML`);
    if (/\bdocument\.write(?:ln)?\s*\(/.test(text)) out.push(`${at}: document.write`);
  });
  return out;
}

// Offline lint: no network URL except the local WebSockets and an explicit allowlist.
export const OFFLINE_ALLOW = [
  'http://www.w3.org/2000/svg',                       // SVG namespace, never fetched
  'https://apps.microsoft.com/detail/9NP83LWLPZ9K',   // "Install Apple Devices" link the user opens
];
export function offlineErrors(text, filename, allow = OFFLINE_ALLOW) {
  const out = [];
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`()<>\\]+/g)) {
    const url = m[0];
    if (/^ws:\/\/(localhost|127\.0\.0\.1):\d+$/.test(url)) continue;
    if (allow.includes(url)) continue;
    out.push(`${filename}: network URL ${url}`);
  }
  return out;
}

// Drag lint: every focusable or interactive descendant of a drag band matches INTERACTIVE
// (itself or an ancestor inside the band); otherwise a mousedown on it starts a window drag.
export function interactiveSelector(js) {
  const m = /const INTERACTIVE\s*=\s*'([^']+)'/.exec(js);
  return m ? m[1] : null;
}
function isInteractive(el) {
  if (['button', 'input', 'select', 'textarea', 'label', 'summary'].includes(el.tag)) return true;
  if (el.tag === 'a' && 'href' in el.attrs) return true;
  return ['tabindex', 'role', 'contenteditable'].some(a => a in el.attrs) || Object.keys(el.attrs).some(a => a.startsWith('on'));
}
export function dragErrors(root, js, bandIds) {
  const sel = interactiveSelector(js);
  if (!sel) return ['INTERACTIVE selector not found in the JS'];
  const out = [];
  for (const id of bandIds) {
    const band = findById(root, id);
    if (!band) { out.push(`drag band #${id} not found`); continue; }
    for (const el of elements(band)) {
      if (isInteractive(el) && !closestWithin(el, sel, band)) out.push(`#${id}: <${el.tag}> on line ${el.line} does not match INTERACTIVE`);
    }
  }
  return out;
}

// CSS: comments and strings blanked before structural checks.
export function stripCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

export function cssBraceErrors(css, filename = 'css') {
  let depth = 0;
  let line = 1;
  for (const ch of stripCss(css)) {
    if (ch === '\n') line++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return [`${filename}:${line}: unexpected }`];
  }
  return depth === 0 ? [] : [`${filename}: ${depth} unclosed {`];
}

// Class names used in selectors: the text before each "{" that is not an at-rule prelude.
export function cssClassSelectors(css) {
  const s = stripCss(css);
  const out = new Set();
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      const prelude = s.slice(start, i).trim();
      if (!prelude.startsWith('@')) for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
      start = i + 1;
    } else if (ch === '}' || ch === ';') {
      start = i + 1;
    }
  }
  return out;
}
export function cssPropsDeclared(text) {
  return new Set([...stripCss(text).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
}
export function cssVarsUsed(text) {
  return new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
}

// Asset references, as POSIX paths relative to viewer/assets: "assets/..." in HTML src/href and in
// JS string literals; url(...) in CSS, resolved against the CSS file's folder.
export function htmlAssetRefs(root) {
  const out = [];
  for (const el of elements(root)) {
    for (const a of ['src', 'href']) {
      const v = el.attrs[a];
      if (v && v.startsWith('assets/')) out.push(v.slice('assets/'.length));
    }
  }
  return out;
}
export function jsAssetRefs(js) {
  return [...js.matchAll(/(['"`])assets\/([\w./-]+)\1/g)].map(m => m[2]);
}
export function cssAssetRefs(css, cssPath) {
  const dir = cssPath.includes('/') ? cssPath.slice(0, cssPath.lastIndexOf('/') + 1) : '';
  return [...stripCssComments(css).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    .map(m => m[2])
    .filter(u => !/^(data:|#|[a-z]+:)/i.test(u))
    .map(u => dir + u);
}
function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }
