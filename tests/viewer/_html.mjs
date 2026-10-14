// Small HTML tokenizer and element tree for the viewer's static checks.
// Not an HTML5 parser: it knows void elements, raw-text elements, comments, quoted attributes
// and `/>` on foreign (SVG) elements, and it REPORTS structure errors instead of recovering
// from them. That is the point: `<div><span></div>` is an error here, while Python's
// HTMLParser (the old CI check) accepts it.

export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

function countNl(s) {
  let n = 0;
  for (let k = s.indexOf('\n'); k >= 0; k = s.indexOf('\n', k + 1)) n++;
  return n;
}

// Returns { root, errors }. Every element is { tag, attrs, children, parent, line, text? }.
// `text` is set on raw-text elements (script, style, textarea, title) and holds their content.
export function parseHtml(src) {
  const lower = src.toLowerCase();
  const root = { tag: '#root', attrs: {}, children: [], parent: null, line: 1 };
  const errors = [];
  let cur = root;
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    line += countNl(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) { errors.push(`line ${line}: unterminated comment`); break; }
      line += countNl(src.slice(lt, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }   // <!DOCTYPE html>
    if (src[lt + 1] === '/') {
      const m = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(lt, lt + 80));
      if (!m) { errors.push(`line ${line}: malformed end tag`); i = lt + 2; continue; }
      const tag = m[1].toLowerCase();
      if (VOID.has(tag)) errors.push(`line ${line}: end tag for void element </${tag}>`);
      else if (cur.tag !== tag) errors.push(`line ${line}: </${tag}> closes <${cur.tag}> opened on line ${cur.line}`);
      else cur = cur.parent;
      i = lt + m[0].length;
      continue;
    }
    const nameM = /^<([a-zA-Z][\w-]*)/.exec(src.slice(lt, lt + 80));
    if (!nameM) { i = lt + 1; continue; }   // a literal "<" in text
    const tag = nameM[1].toLowerCase();
    const startLine = line;
    let j = lt + nameM[0].length;
    const attrs = {};
    let selfClose = false;
    for (;;) {
      const ws = /^\s*/.exec(src.slice(j, j + 4096))[0];
      line += countNl(ws);
      j += ws.length;
      if (j >= src.length) { errors.push(`line ${startLine}: unterminated <${tag}>`); break; }
      if (src[j] === '>') { j++; break; }
      if (src.startsWith('/>', j)) { selfClose = true; j += 2; break; }
      const am = /^[^\s"'>/=]+/.exec(src.slice(j, j + 256));
      if (!am) { errors.push(`line ${line}: malformed attribute in <${tag}>`); j++; continue; }
      const name = am[0].toLowerCase();
      j += am[0].length;
      let value = '';
      const ws2 = /^\s*/.exec(src.slice(j, j + 256))[0];
      if (src[j + ws2.length] === '=') {
        j += ws2.length + 1;
        j += /^\s*/.exec(src.slice(j, j + 256))[0].length;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          if (end < 0) { errors.push(`line ${line}: unterminated attribute ${name} in <${tag}>`); j = src.length; break; }
          value = src.slice(j + 1, end);
          line += countNl(value);
          j = end + 1;
        } else {
          value = /^[^\s>]*/.exec(src.slice(j, j + 4096))[0];
          j += value.length;
        }
      }
      if (Object.prototype.hasOwnProperty.call(attrs, name)) errors.push(`line ${line}: duplicate attribute "${name}" on <${tag}>`);
      attrs[name] = value;
    }
    const el = { tag, attrs, children: [], parent: cur, line: startLine };
    cur.children.push(el);
    if (RAW.has(tag) && !selfClose) {
      const close = lower.indexOf(`</${tag}`, j);
      if (close < 0) { errors.push(`line ${startLine}: <${tag}> is never closed`); break; }
      el.text = src.slice(j, close);
      el.textLine = line;
      line += countNl(el.text);
      i = src.indexOf('>', close) + 1;
      continue;
    }
    if (!VOID.has(tag) && !selfClose) cur = el;
    i = j;
  }
  for (let open = cur; open !== root; open = open.parent) errors.push(`<${open.tag}> opened on line ${open.line} is never closed`);
  return { root, errors };
}

export function walk(node, fn) {
  for (const child of node.children) { fn(child); walk(child, fn); }
}

export function elements(root) {
  const out = [];
  walk(root, el => out.push(el));
  return out;
}

export function classList(el) {
  return (el.attrs.class || '').split(/\s+/).filter(Boolean);
}

// Compound selectors only: tag, .class, [attr], [attr=value], [attr="value"], combined without
// spaces (e.g. `label.theme-switch`). Enough for the INTERACTIVE drag selector.
function parseCompound(sel) {
  const parts = { tag: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  let consumed = '';
  while ((m = re.exec(sel))) {
    consumed += m[0];
    if (m[1]) parts.tag = m[1].toLowerCase();
    else if (m[2]) parts.classes.push(m[2]);
    else parts.attrs.push({ name: m[3].toLowerCase(), value: m[4] ?? m[5] ?? m[6] ?? null });
  }
  if (consumed !== sel) throw new Error(`unsupported selector: ${sel}`);
  return parts;
}

export function matches(el, selectorList) {
  return selectorList.split(',').map(s => s.trim()).filter(Boolean).some(sel => {
    const p = parseCompound(sel);
    if (p.tag && p.tag !== el.tag) return false;
    const cls = classList(el);
    if (!p.classes.every(c => cls.includes(c))) return false;
    return p.attrs.every(a => Object.prototype.hasOwnProperty.call(el.attrs, a.name) && (a.value === null || el.attrs[a.name] === a.value));
  });
}

// Element.closest() limited to the subtree under `stop` (inclusive).
export function closestWithin(el, selectorList, stop) {
  for (let n = el; n && n !== stop.parent; n = n.parent) if (matches(n, selectorList)) return n;
  return null;
}

export function findById(root, id) {
  let found = null;
  walk(root, el => { if (!found && el.attrs.id === id) found = el; });
  return found;
}
