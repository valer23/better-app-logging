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
  // Every .woff2 and OFL-*.txt at any depth under fonts/, any case. SHA256SUMS is flat, so a
  // nested file shows up here as "sub/x.woff2" and is reported as unlisted.
  const isFontFile = f => /^fonts\//.test(f) && (/\.woff2$/i.test(f) || /^OFL-.*\.txt$/i.test(f.slice(f.lastIndexOf('/') + 1)));
  const onDisk = new Set(files.filter(isFontFile).map(f => f.slice('fonts/'.length)));
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

// Universal-bucket selectors. A selector whose rightmost compound names no type, class, id or
// attribute is tried on every element, and with .app on <html> its descendant combinator then walks
// every ancestor to the root. A pseudo-element on such a compound (.app ::selection, *::before) costs
// more again: Chromium also resolves that pseudo-element's style for every element, which doubles
// the matching work of every other rule. Returns "file:line: selector" for each one outside
// @keyframes / @font-face, unless its exact text is in `allow`. Inside @supports (hanging-punctuation:
// first), the WebKit-only block (foundation header), only the selectors in WEBKIT_ALLOW may be universal;
// anything else there is reported like anywhere else.
// hanging-punctuation is the WebKit-only detector: re-check it whenever Chromium ships the property
// (the block would then style every element in Chromium too); static.test.mjs pins both uses of it.
export const WEBKIT_DETECTOR = '@supports (hanging-punctuation: first)';
const WEBKIT_ONLY = /^@supports \(\s*hanging-punctuation\s*:\s*first\s*\)$/;
export const WEBKIT_ALLOW = ['.app ::selection', '.app ::-webkit-scrollbar', '.app ::-webkit-scrollbar-thumb', '.app ::-webkit-scrollbar-track'];
// Splits on `sep` characters that sit outside () and [].
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && sep.test(ch)) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map(s => s.trim()).filter(Boolean);
}
// True when the compound names a type, .class, #id, [attr] or :root outside any (), or is a
// :where()/:is() whose single argument is itself one such compound.
function compoundHasKey(compound) {
  if (/^[a-zA-Z]/.test(compound)) return true;
  let depth = 0;
  for (let i = 0; i < compound.length; i++) {
    const ch = compound[i];
    if (ch === '(') {
      if (depth === 0 && /:(?:where|is)$/.test(compound.slice(0, i))) {
        let d = 0;
        let close = i;
        for (; close < compound.length; close++) {
          if (compound[close] === '(') d++;
          else if (compound[close] === ')' && --d === 0) break;
        }
        const arg = compound.slice(i + 1, close);
        if (splitTop(arg, /,/).length === 1 && splitTop(arg, /[\s>+~]/).length === 1 && compoundHasKey(arg.trim())) return true;
        i = close;
        continue;
      }
      depth++;
    } else if (ch === ')') depth--;
    else if (depth === 0 && (ch === '.' || ch === '#' || ch === '[')) return true;
    else if (depth === 0 && compound.startsWith(':root', i) && !/[\w-]/.test(compound[i + 5] || '')) return true;
  }
  return false;
}
export function universalSelectorErrors(css, filename = 'css', allow = []) {
  // Comments are blanked but keep their newlines, so reported lines match the file.
  const s = stripCss(css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')));
  const exempt = []; // one entry per open block: 'skip' = nothing inside is checked, 'webkit' = WEBKIT_ALLOW applies
  const out = [];
  let line = 1;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') line++;
    else if (ch === '{') {
      const prelude = s.slice(start, i).trim().replace(/\s+/g, ' ');
      if (prelude.startsWith('@')) {
        exempt.push(exempt.includes('skip') || /^@(?:-webkit-)?(?:keyframes|font-face)\b/.test(prelude) ? 'skip'
          : exempt.includes('webkit') || WEBKIT_ONLY.test(prelude) ? 'webkit' : '');
      } else {
        if (!exempt.includes('skip')) {
          const inWebkit = exempt.includes('webkit');
          for (const sel of splitTop(prelude, /,/)) {
            const parts = splitTop(sel, /[\s>+~]/);
            if (!compoundHasKey(parts[parts.length - 1] || '') && !allow.includes(sel) && !(inWebkit && WEBKIT_ALLOW.includes(sel))) out.push(`${filename}:${line}: ${sel}`);
          }
        }
        exempt.push('skip'); // declarations
      }
      start = i + 1;
    } else if (ch === '}') { exempt.pop(); start = i + 1; }
    else if (ch === ';') start = i + 1;
  }
  return out;
}

// Rule parser shared by the checks below. Comments are blanked (newlines kept, so lines match the file)
// and the structural characters inside strings are masked, but string text is kept, so attribute
// selectors such as [data-motion="reduce"] stay readable. Returns [{ selectors, body, atRules, line }] for
// every style rule, at any depth of @media / @supports / @layer / @container; @keyframes, @font-face and
// the like are skipped. CSS nesting (a rule inside a rule) is not supported: its body is kept as text.
export function maskCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, m => m.replace(/[{};,()[\]]/g, '_'));
}
export function cssRules(css) {
  const s = maskCss(css);
  const rules = [];
  const atRules = [];
  let line = 1;
  let start = 0;
  const closeOf = open => {
    let d = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}' && --d === 0) return j;
    }
    return s.length;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') line++;
    else if (ch === '{') {
      const prelude = s.slice(start, i).trim().replace(/\s+/g, ' ');
      const close = closeOf(i);
      if (prelude.startsWith('@')) {
        if (/^@(?:-webkit-)?(?:keyframes|font-face|page|property|counter-style|font-feature-values)\b/.test(prelude)) {
          line += (s.slice(i, close).match(/\n/g) || []).length;
          i = close;
        } else atRules.push(prelude);
      } else {
        rules.push({ selectors: splitTop(prelude, /,/), body: s.slice(i + 1, close), atRules: [...atRules], line });
        line += (s.slice(i, close).match(/\n/g) || []).length;
        i = close;
      }
      start = i + 1;
    } else if (ch === '}') { atRules.pop(); start = i + 1; }
    else if (ch === ';') start = i + 1;
  }
  return rules;
}
// [{ prop, value }] of a rule body; prop lower-cased, !important kept in value.
export function declarations(body) {
  return splitTop(body, /;/).map(d => {
    const k = d.indexOf(':');
    return k < 0 ? null : { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
  }).filter(Boolean);
}

// Pseudo-elements are not boxes of .app *, so they keep content-box (design v1.2 dropped
// .app *::before/::after). A rule on ::before/::after that sets a non-zero padding or border, or a
// percentage width/height, must say which box model it means: declare box-sizing in the same rule
// (or list the exact selector in `allow`, when a shared rule elsewhere sets it). Returns
// "file:line: selector" per offending selector.
const SIDES = '(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end)';
const PAD = new RegExp(`^padding(?:-${SIDES})?$`);
const BORDER = new RegExp(`^border(?:-${SIDES})?(?:-width)?$`);
const SIZE = /^(?:min-|max-)?(?:width|height|inline-size|block-size)$/;
function nonZeroLength(v) {
  return v.split(/\s+/).some(t => /var\(|calc\(|env\(|min\(|max\(|clamp\(/.test(t)
    || (/^[+-]?(?:\d*\.)?\d+[a-z%]*$/i.test(t) && !/^[+-]?0*\.?0+[a-z%]*$/i.test(t)));
}
function setsBox({ prop, value }) {
  const v = value.replace(/\s*!important\s*$/i, '').toLowerCase();
  if (PAD.test(prop)) return nonZeroLength(v);
  if (BORDER.test(prop)) {
    if (/\b(?:none|hidden)\b/.test(v)) return false;
    if (nonZeroLength(v) || /\b(?:thin|medium|thick)\b/.test(v)) return true;
    return /\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(v);
  }
  return SIZE.test(prop) && v.includes('%');
}
export function pseudoBoxSizingErrors(css, filename = 'css', allow = []) {
  const out = [];
  for (const r of cssRules(css)) {
    const decls = declarations(r.body);
    if (!decls.some(setsBox) || decls.some(d => d.prop === 'box-sizing')) continue;
    for (const sel of r.selectors) {
      if (/::?(?:before|after)\b/.test(sel) && !allow.includes(sel)) out.push(`${filename}:${r.line}: ${sel}`);
    }
  }
  return out;
}

// Reduce motion zeroes the foundation's --t-* duration tokens rather than matching every element,
// so a transition or animation with a literal time would ignore it. Returns "file:line: declaration"
// for each transition / animation / *-duration / *-delay value that holds a literal time, including
// one in a var() fallback (a literal 0 delay is harmless and passes). Also flags scroll-behavior:
// smooth, which Reduce motion no longer forces back to auto, unless the rule sits in
// @media (prefers-reduced-motion: no-preference) and every selector has :not([data-motion="reduce"]).
export function motionTokenErrors(css, filename = 'css') {
  const s = stripCss(css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')));
  const out = [];
  const TIME = /(?<![\w.-])(?:\d*\.)?\d+m?s\b/g;
  for (const m of s.matchAll(/(?<![\w-])(?:-webkit-)?(?:transition|animation)(-duration|-delay)?\s*:([^;{}]*)/g)) {
    // var(--x) is a token reference; var(--x, 200ms) keeps its fallback, which is a literal time.
    let value = m[2];
    for (let prev = ''; prev !== value;) { prev = value; value = value.replace(/var\(\s*--[\w-]+\s*\)/g, ' ').replace(/var\(\s*--[\w-]+\s*,/g, '('); }
    const times = value.match(TIME) || [];
    if (times.some(x => m[1] !== '-delay' || !/^0*\.?0+m?s$/.test(x))) {
      out.push(`${filename}:${s.slice(0, m.index).split('\n').length}: ${m[0].trim()}`);
    }
  }
  for (const r of cssRules(css)) {
    if (!declarations(r.body).some(d => d.prop === 'scroll-behavior' && /\bsmooth\b/i.test(d.value))) continue;
    const safe = r.atRules.includes('@media (prefers-reduced-motion: no-preference)')
      && r.selectors.every(sel => sel.includes(':not([data-motion="reduce"])'));
    if (!safe) out.push(`${filename}:${r.line}: scroll-behavior: smooth outside a reduced-motion-safe rule`);
  }
  return out;
}

// Legacy animations use literal times, so the token trick does not reach them: legacy.css carries two
// class-bucketed rules instead, both setting animation: none !important and transition: none !important
// on every legacy selector that animates or transitions:
//   @media (prefers-reduced-motion: reduce) { :where(.app:not([data-motion="off"])) <sel>, ... }
//   .app[data-motion="reduce"] <sel>, ...
// A selector is covered when some selector of the rule ends in the same compound (state pseudo-classes
// such as :hover ignored, pseudo-elements kept). Returns problems; empty = every one is covered.
export const MOTION_OS_PREFIX = ':where(.app:not([data-motion="off"])) ';
export const MOTION_FORCED_PREFIX = '.app[data-motion="reduce"] ';
const ENDING = sel => (splitTop(sel, /[\s>+~]/).pop() || '').replace(/(?<!:):(?!:)[\w-]+(?:\([^)]*\))?/g, '');
const isReducedRule = r => r.selectors.some(sel => sel.startsWith(MOTION_OS_PREFIX) || sel.startsWith(MOTION_FORCED_PREFIX));
export function animatedSelectors(css) {
  const out = new Set();
  for (const r of cssRules(css)) {
    if (isReducedRule(r)) continue;
    const animates = declarations(r.body).some(d => /^(?:-webkit-)?(?:animation(?:-name)?|transition(?:-property)?)$/.test(d.prop) && !/^none\b/i.test(d.value));
    if (animates) for (const sel of r.selectors) out.add(sel);
  }
  return [...out];
}
export function reducedMotionCoverageErrors(css, filename = 'css') {
  const rules = cssRules(css);
  const animated = animatedSelectors(css);
  const out = [];
  const kinds = [
    ['OS Reduce motion', MOTION_OS_PREFIX, r => r.atRules.includes('@media (prefers-reduced-motion: reduce)')],
    ['Settings Reduce motion', MOTION_FORCED_PREFIX, r => !r.atRules.some(a => a.startsWith('@media') || a.startsWith('@supports'))],
  ];
  for (const [name, prefix, where] of kinds) {
    const mine = rules.filter(r => where(r) && r.selectors.some(sel => sel.startsWith(prefix)));
    if (!mine.length) { out.push(`${filename}: no ${name} rule (${prefix.trim()} ...)`); continue; }
    const covered = new Set();
    for (const r of mine) {
      for (const sel of r.selectors) {
        if (!sel.startsWith(prefix)) out.push(`${filename}:${r.line}: ${name} rule selector "${sel}" does not start with ${prefix.trim()}`);
        else covered.add(ENDING(sel.slice(prefix.length)));
      }
      const d = declarations(r.body);
      for (const prop of ['animation', 'transition']) {
        if (!d.some(x => x.prop === prop && /^none\s*!important$/i.test(x.value))) out.push(`${filename}:${r.line}: ${name} rule must set ${prop}: none !important`);
      }
    }
    for (const sel of animated) if (!covered.has(ENDING(sel))) out.push(`${filename}: ${sel} animates but the ${name} rule does not cover it`);
  }
  return out;
}
