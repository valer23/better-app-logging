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
      // Handler bodies are JavaScript the page-script scan never sees. The value must be exactly one call
      // (arguments may still contain '=', so an HTML sink can hide inside them), and the XSS lint is run
      // over the value too, so a sink in an argument is caught.
      const m = /^\s*([A-Za-z_$][\w$]*)\s*\((?:[^()'"]|'[^']*'|"[^"]*")*\)\s*;?\s*$/.exec(value);
      if (!m) out.push(`line ${el.line}: ${name}="${value}" is not a single plain function call`);
      else if (!globals.has(m[1])) out.push(`line ${el.line}: ${name} calls ${m[1]}(), which is not a global function`);
      out.push(...xssErrors(value, `line ${el.line} ${name}`));
    }
  }
  return out;
}

// XSS lint: innerHTML may only be cleared; no other HTML-string sinks.
export function xssErrors(js, filename = 'script', firstLine = 1) {
  const out = [];
  const lineAt = index => firstLine + (js.slice(0, index).match(/\n/g) || []).length;
  // .innerHTML or ['innerHTML'] assigned with any assignment operator. Runs over the whole text, not
  // line by line, so a continuation such as `= ''\n + s` is seen. Only a plain `= ''` that is not
  // continued by a binary operator is allowed; every compound operator (+=, ||=, &&=, ??=) is an error.
  // The right-hand side is captured inside a lookahead so it is not consumed: an allowed `= ''` with
  // no `;` after it must not swallow a later sink.
  for (const m of js.matchAll(/(?:\.innerHTML|\[\s*['"]innerHTML['"]\s*\])\s*(\+=|\|\|=|&&=|\?\?=|=)(?!=)(?=\s*([^;]*))/g)) {
    const SKIP = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
    const lit = /^(?:''|""|``)/.exec(m[2].replace(SKIP, ''));
    // After the empty literal the statement must end: nothing, or a char that cannot continue an expression.
    const cleared = !!lit && !/^[+\-*\/%|&^?:,<>=.\[(`]/.test(m[2].replace(SKIP, '').slice(lit[0].length).replace(SKIP, ''));
    if (m[1] !== '=' || !cleared) out.push(`${filename}:${lineAt(m.index)}: innerHTML assigned something other than ''`);
  }
  js.split('\n').forEach((text, i) => {
    const at = `${filename}:${firstLine + i}`;
    if (/\binnerHTML\s*:/.test(text)) out.push(`${at}: innerHTML set through an object literal`);
    if (/\.srcdoc\s*(?:[+|&?]{0,2})=(?!=)/.test(text)) out.push(`${at}: srcdoc assignment`);
    if (/\bcreateContextualFragment\s*\(|\bsetHTMLUnsafe\s*\(|\bparseFromString\s*\(/.test(text)) out.push(`${at}: HTML string parsed into nodes`);
    if (/\.outerHTML\s*(?:[+|&?]{0,2})=(?!=)/.test(text)) out.push(`${at}: outerHTML assignment`);
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
// `.lg-scope` must only appear inside :where(...). A bare .lg-scope adds a class to the specificity
// of every rule it scopes, so the move into legacy.css would silently outrank type-only and
// single-class rules (td padding, .zoom-btn, mark ...) that the old unscoped selectors lost to.
export function lgScopeSpecificityErrors(css, filename = 'css') {
  // Comments are blanked but keep their newlines, so reported lines match the file.
  const s = stripCss(css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')));
  const stack = [];
  const out = [];
  let line = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') line++;
    else if (ch === '(') stack.push(s.slice(Math.max(0, i - 6), i) === ':where');
    else if (ch === ')') stack.pop();
    else if (ch === '.' && s.startsWith('.lg-scope', i) && !/[\w-]/.test(s[i + 9] || '') && !stack.includes(true)) {
      out.push(`${filename}:${line}: .lg-scope outside :where() raises specificity`);
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
// SHA256SUMS lists exactly the bundled fonts and licence texts under fonts/. `sha256sum -c` only
// hashes what is listed, so an unlisted .woff2 would otherwise ship unchecked. files: asset paths
// relative to viewer/assets ("fonts/geist-5.3.0-latin.woff2"); sums: the SHA256SUMS text.
export function fontManifestErrors(files, sums) {
  const onDisk = new Set(files.filter(f => /^fonts\/(?:[^/]+\.woff2|OFL-[^/]+\.txt)$/.test(f)).map(f => f.slice('fonts/'.length)));
  const listed = new Set();
  const errors = [];
  for (const line of sums.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([^/\s]+)$/.exec(line);
    if (!m) { errors.push(`malformed SHA256SUMS line: ${line}`); continue; }
    if (listed.has(m[2])) errors.push(`${m[2]} is listed twice`);
    listed.add(m[2]);
  }
  for (const f of onDisk) if (!listed.has(f)) errors.push(`${f} is not listed in SHA256SUMS`);
  for (const f of listed) if (!onDisk.has(f)) errors.push(`${f} is listed in SHA256SUMS but is not a font or licence file on disk`);
  return errors;
}
