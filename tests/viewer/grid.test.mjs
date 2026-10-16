// The log grid (roadmap P5): ALV.gridPure in an empty vm context, and the DOM side (createGrid) on the fake page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModules, pageScriptSrcs } from './_load.mjs';

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
