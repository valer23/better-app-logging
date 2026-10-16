// The log grid (roadmap P5): ALV.gridPure in an empty vm context, and the DOM side (createGrid) on the fake page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModules, pageScriptSrcs, loadLegacy, stickyDocument } from './_load.mjs';

const G = loadPureModules('shell.js', 'grid.js').gridPure;

test('grid.js loads after live.js in an empty context and exposes its pure helpers', () => {
  const srcs = pageScriptSrcs();
  assert.equal(srcs.indexOf('assets/js/grid.js'), srcs.indexOf('assets/js/live.js') + 1);
  for (const k of ['timeOf', 'rowClass', 'clampCol', 'resizeKey']) assert.equal(typeof G[k], 'function', k);
  assert.ok(Object.isFrozen(G) && Object.isFrozen(G.ROW_CLASS));
});

test('timeOf: the time of every timestamp shape the viewer reads, to the millisecond; anything else whole', () => {
  const cases = [
    ['2026-10-14 15:54:26.290', '15:54:26.290'],         // Android live (logcat -v year) and a .logcat file (formatTs)
    ['2026 Oct 14 15:54:26.290123', '15:54:26.290'],     // iOS live and idevicesyslog text: microseconds cut to ms
    ['2026 Oct  4 15:54:26.290123', '15:54:26.290'],     // a padded day
    ['2026 Oct 14 15:54:26', '15:54:26'],                // no fraction
    ['15:54:26.290', '15:54:26.290'],                    // no date at all
    ['', ''], [null, ''], [undefined, ''],
    ['garbage', 'garbage'], ['2026-10-14', '2026-10-14'], ['a b:c', 'a b:c'],
  ];
  for (const [ts, want] of cases) assert.equal(G.timeOf(ts), want, String(ts));
});

test('rowClass: level and platform in one class string; ASSERT is the F class; unknown levels read as Verbose', () => {
  assert.equal(G.rowClass('ERROR', 'ios'), 'l-e p-i');
  assert.equal(G.rowClass('WARN', 'android'), 'l-w p-a');
  assert.equal(G.rowClass('ASSERT', 'android'), 'l-f p-a');
  assert.equal(G.rowClass('NOPE', 'ios'), 'l-v p-i');
  assert.equal(G.rowClass('INFO', undefined), 'l-i p-a', 'a line without a platform shows the Android badge, as before');
  assert.deepEqual(Object.values(G.LEVEL_CLASS), ['l-v', 'l-d', 'l-i', 'l-w', 'l-e', 'l-f']);
});

test('resize steps: ←/→ 8 px, ⇧ 32 px, Enter and Home reset, other keys are not resize keys; widths stay within 40–400', () => {
  assert.deepEqual(['ArrowLeft', 'ArrowRight'].map(k => G.resizeKey(k, false)), [-8, 8]);
  assert.deepEqual(['ArrowLeft', 'ArrowRight'].map(k => G.resizeKey(k, true)), [-32, 32]);
  assert.deepEqual(['Enter', 'Home'].map(k => G.resizeKey(k, false)), ['reset', 'reset']);
  assert.deepEqual(['End', 'ArrowUp', ' ', 'a'].map(k => G.resizeKey(k, false)), [null, null, null, null]);
  assert.deepEqual([G.COL_MIN, G.COL_MAX], [40, 400]);
  assert.deepEqual([12, 40, 101.6, 400, 999, NaN].map(G.clampCol), [40, 40, 102, 400, 400, 40]);
  assert.deepEqual(Array.from(G.RESIZABLE, ([k]) => k), ['ts', 'lvl', 'tag', 'app', 'pid'], 'every boundary but the fixed platform badge column and the last');
});

// ---- buildRow (legacy script) on a document that builds countable nodes; _load.mjs stubs everything else ----
function rowKit() {
  const doc = stickyDocument();
  const { api, run } = loadLegacy(['buildRow', 'doExport'], { document: doc });
  const text = data => ({ nodeType: 3, data, childNodes: [] });
  doc.createTextNode = text;
  doc.createDocumentFragment = () => ({ nodeType: 11, childNodes: [], appendChild(c) { this.childNodes.push(c); return c; } });
  doc.createElement = tag => ({
    nodeType: 1, tagName: tag.toUpperCase(), className: '', attrs: {}, childNodes: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { if (c.nodeType === 11) { this.childNodes.push(...c.childNodes); c.childNodes = []; } else this.childNodes.push(c); return c; },
    set textContent(v) { this.childNodes = v === '' ? [] : [text(String(v))]; },
    get textContent() { return this.childNodes.map(c => (c.nodeType === 3 ? c.data : c.textContent)).join(''); },
  });
  const count = n => 1 + n.childNodes.reduce((a, c) => a + count(c), 0);
  return { api, run, doc, count };
}
const line = (o = {}) => ({ ts: '2026 Oct 14 15:53:43.000123', pid: 57, tid: 12, tag: 'SpringBoard', app: 'com.example.headset',
  lvl: 'ERROR', msg: 'pairing failed', platform: 'ios', seq: 1, ...o });

test('buildRow: seven cells in the D14 order, the level and platform in the row class, 14 nodes (17 before P5)', () => {
  const k = rowKit();
  const tr = k.api.buildRow(line(), false);
  assert.equal(tr.className, 'l-e p-i');
  assert.deepEqual(tr.childNodes.map(td => td.className), ['c-plat', 'c-ts', 'c-lvl', 'c-tag', 'c-app', 'c-pid', 'c-msg']);
  assert.deepEqual(tr.childNodes.map(td => td.textContent), ['', '15:53:43.000', 'E', 'SpringBoard', 'com.example.headset', '57-12', 'pairing failed']);
  assert.equal(k.count(tr), 14, 'tr + 7 cells + 6 text nodes: the badge is CSS');
  assert.deepEqual(tr.attrs, {}, 'no attribute on an unselected row: no tabindex, title, role or aria-selected');
  assert.equal(tr._message.msg, 'pairing failed');
  assert.equal(k.api.buildRow(line(), true).className, 'l-e p-i is-new', 'isNew stays the arrival flag (P5b styles it)');
});

test('buildRow: ASSERT reads F on screen while a TXT export keeps A; the selected line gets aria-selected', async () => {
  const k = rowKit();
  const m = line({ lvl: 'ASSERT', platform: 'android', tid: 0 });
  const tr = k.api.buildRow(m, false);
  assert.deepEqual([tr.className, tr.childNodes[2].textContent, tr.childNodes[5].textContent], ['l-f p-a', 'F', '57']);
  k.run('cur').sel = m;
  assert.equal(k.api.buildRow(m, false).attrs['aria-selected'], 'true');
  assert.equal(k.api.buildRow(line(), false).attrs['aria-selected'], undefined);
  k.run("globalThis.__saved = null; legacyDownload = (name, content) => { __saved = content; }");
  k.run('cur').all = [m];
  k.doc.querySelector = () => ({ value: 'all' });
  await k.api.doExport('txt');
  assert.match(k.run('__saved'), / {2}🤖 {2}\s+57-\s+0 {2}A {2}SpringBoard /u, 'the export letter is unchanged, so files round-trip');
});

test('buildRow: log text stays text (XSS), and no row of any shape exceeds 14 nodes without a search hit', () => {
  const k = rowKit();
  const evil = k.api.buildRow(line({ msg: '<img src=x onerror=alert(1)>', tag: '<b>', app: '"><script>' }), false);
  assert.deepEqual(evil.childNodes.slice(3).map(td => td.childNodes.map(c => c.nodeType)), [[3], [3], [3], [3]], 'one Text node each, no element');
  assert.equal(evil.childNodes[6].textContent, '<img src=x onerror=alert(1)>');
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const LV = ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'ASSERT', 'BOGUS'];
  for (let i = 0; i < 300; i++) {
    const m = line({ lvl: LV[rnd(7)], platform: rnd(2) ? 'ios' : 'android', app: rnd(2) ? '' : 'app', tid: rnd(2), tag: rnd(3) ? 'T' : '',
      msg: 'x'.repeat(rnd(400)), ts: rnd(4) ? '2026-10-14 15:54:26.290' : 'odd' });
    const tr = k.api.buildRow(m, false);
    assert.ok(k.count(tr) <= 14, `row ${i}: ${k.count(tr)} nodes`);
    assert.match(tr.className, /^l-[vdiwef] p-[ai]$/);
  }
});
