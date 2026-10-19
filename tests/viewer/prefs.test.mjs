// Settings store and localStorage migration (viewer/assets/js/prefs.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { ASSETS, read, loadPrefsModule, memoryStorage, fakeMatchMedia, fakeRoot } from './_load.mjs';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129.0';
const DARK = '(prefers-color-scheme: dark)';
const RT = '(prefers-reduced-transparency: reduce)';
const K = k => 'applogs-viewer.' + k;

const ALV = loadPrefsModule();

function boot({ stored = {}, ua = MAC, media = { [DARK]: true }, storage } = {}) {
  const st = storage || memoryStorage(Object.fromEntries(Object.entries(stored).map(([k, v]) => [K(k), v])));
  const mm = fakeMatchMedia(media);
  const prefs = ALV.createPrefs({ storage: st, matchMedia: mm, userAgent: ua });
  const root = fakeRoot();
  const state = prefs.boot(root);
  return { prefs, root, st, mm, state };
}

test('loads in an empty context: no DOM access at load and no auto-boot', () => {
  assert.equal(typeof ALV.createPrefs, 'function');
  assert.equal(ALV.prefs, undefined);
});

test('fresh profile boots dark, 13 px, solid, m and writes every root attribute', () => {
  const { root, st } = boot();
  assert.deepEqual({ ...root.attrs }, {
    'data-theme': 'dark', 'data-material': 'solid', 'data-ui': 'm', 'data-platform': 'mac',
    'data-font': 'default', 'data-density': 'comfortable', 'data-contrast': 'system',
    'data-motion': 'system', 'data-glass': 'off', 'data-sidebar': 'expanded',
  });
  assert.equal(root.props['--log-fs'], '13px');
  assert.equal(st.map.get(K('material')), 'solid');   // migration writes material once
  assert.equal(st.map.has(K('settings')), false);
});

test('old profile theme=light, logFontSize=9, glassMode=on opens light, 10 px, glass on macOS', () => {
  const { root, st } = boot({ stored: { theme: 'light', logFontSize: '9', glassMode: 'on' } });
  assert.equal(root.attrs['data-theme'], 'light');
  assert.equal(root.props['--log-fs'], '10px');
  assert.equal(root.attrs['data-material'], 'glass');
  assert.equal(root.attrs['data-glass'], 'on');
  assert.equal(st.map.get(K('material')), 'glass');
  assert.equal(st.map.get(K('glassMode')), 'on');      // never deleted: a downgrade still reads it
  assert.equal(st.map.get(K('logFontSize')), '9');     // read-time clamp; nothing rewritten at boot
});

test('the same old profile on Windows keeps the glass preference but renders solid', () => {
  const { root, prefs } = boot({ stored: { theme: 'light', logFontSize: '9', glassMode: 'on' }, ua: WIN });
  assert.equal(root.attrs['data-platform'], 'other');
  assert.equal(root.attrs['data-material'], 'solid');
  assert.equal(root.attrs['data-glass'], 'off');
  assert.equal(prefs.get('material'), 'glass');
});

test('logFontSize clamps to 10..20 with default 13', () => {
  const cases = [['8', 10], ['9', 10], ['10', 10], ['13', 13], ['20', 20], ['21', 20], ['12.6', 13], ['abc', 13], ['', 13], [null, 13]];
  for (const [raw, want] of cases) {
    const stored = raw === null ? {} : { logFontSize: raw };
    assert.equal(boot({ stored }).prefs.get('logFontSize'), want, `logFontSize=${raw}`);
  }
});

test('theme parses dark, light, system; anything else is dark', () => {
  const cases = [['dark', 'dark'], ['light', 'light'], ['system', 'system'], ['blue', 'dark'], [null, 'dark']];
  for (const [raw, want] of cases) {
    const stored = raw === null ? {} : { theme: raw };
    assert.equal(boot({ stored }).prefs.get('theme'), want, `theme=${raw}`);
  }
});

test('System resolves from prefers-color-scheme and follows OS changes live', () => {
  const { root, mm, prefs } = boot({ stored: { theme: 'system' }, media: { [DARK]: false } });
  assert.equal(root.attrs['data-theme'], 'light');
  mm.fire(DARK, true);
  assert.equal(root.attrs['data-theme'], 'dark');
  prefs.set('theme', 'light');
  mm.fire(DARK, false);
  mm.fire(DARK, true);
  assert.equal(root.attrs['data-theme'], 'light');     // an explicit choice ignores the OS
});

test('System without matchMedia resolves to dark', () => {
  const prefs = ALV.createPrefs({ storage: memoryStorage({ [K('theme')]: 'system' }), matchMedia: null, userAgent: MAC });
  const root = fakeRoot();
  prefs.boot(root);
  assert.equal(root.attrs['data-theme'], 'dark');
});

test('an existing material value wins over glassMode', () => {
  const { root, st } = boot({ stored: { material: 'solid', glassMode: 'on' } });
  assert.equal(root.attrs['data-material'], 'solid');
  assert.equal(st.map.get(K('material')), 'solid');
});

test('Reduce transparency forces solid and is followed live where the WebView reports it', () => {
  const { root, mm } = boot({ stored: { material: 'glass' }, media: { [DARK]: true, [RT]: true } });
  assert.equal(root.attrs['data-material'], 'solid');
  mm.fire(RT, false);
  assert.equal(root.attrs['data-material'], 'glass');
  assert.equal(root.attrs['data-glass'], 'on');
});

test('uiSize accepts s, m, l; anything else is m', () => {
  for (const [raw, want] of [['s', 's'], ['m', 'm'], ['l', 'l'], ['xl', 'm']]) {
    assert.equal(boot({ stored: { uiSize: raw } }).root.attrs['data-ui'], want, `uiSize=${raw}`);
  }
});

test('corrupt settings JSON reads as defaults and is not written back at boot', () => {
  for (const bad of ['{not json', '[]', '5', 'null']) {
    const { prefs, st } = boot({ stored: { settings: bad } });
    assert.deepEqual({ ...prefs.getSettings() }, { font: 'default', density: 'comfortable', contrast: 'system', motion: 'system', iosQuiet: 'off', iosQuietHint: 'unseen' });
    assert.equal(st.map.get(K('settings')), bad);
  }
});

test('settings apply to the root and patchSettings preserves unknown fields', () => {
  const stored = { settings: JSON.stringify({ font: 'hyper', motion: 'off', retention: 750000, density: 'huge' }) };
  const { prefs, root, st } = boot({ stored });
  assert.equal(root.attrs['data-font'], 'hyper');
  assert.equal(root.attrs['data-motion'], 'off');
  assert.equal(root.attrs['data-density'], 'comfortable');   // an invalid value falls back to the default
  prefs.patchSettings({ contrast: 'more' });
  assert.equal(root.attrs['data-contrast'], 'more');
  const written = JSON.parse(st.map.get(K('settings')));
  assert.equal(written.retention, 750000);
  assert.equal(written.contrast, 'more');
  assert.throws(() => prefs.patchSettings({ contrast: 'max' }), { name: 'RangeError' });
  assert.throws(() => prefs.patchSettings({ colour: 'red' }), { name: 'TypeError' });
});

test('patchSettings over corrupt JSON writes a fresh object', () => {
  const { prefs, st } = boot({ stored: { settings: '{oops' } });
  prefs.patchSettings({ density: 'compact' });
  assert.deepEqual(JSON.parse(st.map.get(K('settings'))), { font: 'default', density: 'compact', contrast: 'system', motion: 'system', iosQuiet: 'off', iosQuietHint: 'unseen' });
});

test('set validates, persists, applies and mirrors glassMode', () => {
  const { prefs, root, st } = boot();
  prefs.set('logFontSize', 25);
  assert.equal(root.props['--log-fs'], '20px');
  assert.equal(st.map.get(K('logFontSize')), '20');
  prefs.set('material', 'glass');
  assert.equal(st.map.get(K('material')), 'glass');
  assert.equal(st.map.get(K('glassMode')), 'on');
  prefs.set('material', 'solid');
  assert.equal(st.map.get(K('glassMode')), 'off');
  prefs.set('theme', 'system');
  assert.equal(st.map.get(K('theme')), 'system');
  prefs.set('uiSize', 'l');
  assert.equal(root.attrs['data-ui'], 'l');
  assert.throws(() => prefs.set('theme', 'blue'), { name: 'RangeError' });
  assert.throws(() => prefs.set('logFontSize', 'big'), { name: 'RangeError' });
  assert.throws(() => prefs.set('volume', 3), { name: 'TypeError' });
});

test('blocked storage still boots with defaults and keeps changes in memory', () => {
  const { prefs, root } = boot({ storage: memoryStorage({}, { throwing: true }) });
  assert.equal(root.attrs['data-theme'], 'dark');
  prefs.set('theme', 'light');
  assert.equal(root.attrs['data-theme'], 'light');
  assert.equal(prefs.get('theme'), 'light');
});

test('no storage at all (null) behaves like an empty profile', () => {
  const prefs = ALV.createPrefs({ storage: null, matchMedia: null, userAgent: WIN });
  const root = fakeRoot();
  assert.equal(prefs.boot(root).logFontSize, 13);
  assert.equal(root.attrs['data-platform'], 'other');
});

test('onChange fires on every apply and can unsubscribe', () => {
  const { prefs } = boot();
  const seen = [];
  const off = prefs.onChange(s => seen.push(s.theme));
  prefs.set('theme', 'light');
  off();
  prefs.set('theme', 'dark');
  assert.deepEqual(seen, ['light']);
});

test('nextTheme cycles Dark, Light, System', () => {
  const { nextTheme } = ALV.prefsPure;
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'system');
  assert.equal(nextTheme('system'), 'dark');
  assert.equal(nextTheme('garbage'), 'light');
});

// ---- Production boot path: prefs.js with a document present (what the page does in <head>) ----

// Runs prefs.js the way the page does: `window` is the global object g, `document` exists. The
// window is a plain object so a throwing localStorage getter really throws (node:vm swallows
// getter errors on the context global). `matchMedia` throws "Illegal invocation" when called
// unbound, as WebKit does. `storageGetter` replaces the localStorage property with a getter.
function runPageBoot({ stored = {}, ua = MAC, media = { [DARK]: true }, storageGetter } = {}) {
  const root = fakeRoot();
  const st = memoryStorage(Object.fromEntries(Object.entries(stored).map(([k, v]) => [K(k), v])));
  const base = fakeMatchMedia(media);
  const win = { navigator: { userAgent: ua } };
  win.matchMedia = function (q) {
    if (this !== win) throw new TypeError('Illegal invocation');
    return base(q);
  };
  if (storageGetter) Object.defineProperty(win, 'localStorage', { get: storageGetter });
  else win.localStorage = st;
  const ctx = vm.createContext({ window: win, document: { documentElement: root } });
  vm.runInContext(read(path.join(ASSETS, 'js', 'prefs.js')), ctx, { filename: 'prefs.js' });
  return { ALV: win.ALV, root, st, mm: base };
}

test('page boot: with a document, prefs.js boots itself against <html> using the real globals', () => {
  const { ALV, root, st, mm } = runPageBoot({ stored: { theme: 'light', glassMode: 'on' } });
  assert.equal(typeof ALV.prefs, 'object');
  assert.equal(root.attrs['data-theme'], 'light');
  assert.equal(root.attrs['data-platform'], 'mac');
  assert.equal(root.attrs['data-material'], 'glass');
  assert.equal(root.attrs['data-glass'], 'on');
  assert.equal(root.attrs['data-ui'], 'm');
  assert.equal(root.props['--log-fs'], '13px');
  assert.equal(st.map.get(K('material')), 'glass');   // the migration ran against the real storage
  // matchMedia was bound: the OS theme listener is live (theme=system follows it).
  ALV.prefs.set('theme', 'system');
  assert.equal(root.attrs['data-theme'], 'dark');
  mm.fire(DARK, false);
  assert.equal(root.attrs['data-theme'], 'light');
});

test('page boot: a localStorage getter that throws still boots with defaults', () => {
  const { ALV, root } = runPageBoot({
    storageGetter() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  });
  assert.equal(typeof ALV.prefs, 'object');
  assert.equal(root.attrs['data-theme'], 'dark');
  assert.equal(root.attrs['data-material'], 'solid');
  assert.equal(root.attrs['data-platform'], 'mac');
  assert.equal(root.props['--log-fs'], '13px');
  ALV.prefs.set('theme', 'light');   // changes live in memory for the session
  assert.equal(root.attrs['data-theme'], 'light');
});

test('sidebar: expanded by default, collapsed persists and writes data-sidebar, anything else reads expanded (P4)', () => {
  for (const [raw, want] of [['collapsed', 'collapsed'], ['expanded', 'expanded'], ['rail', 'expanded'], [null, 'expanded']]) {
    const { prefs, root } = boot({ stored: raw === null ? {} : { sidebar: raw } });
    assert.equal(prefs.get('sidebar'), want, `sidebar=${raw}`);
    assert.equal(root.attrs['data-sidebar'], want);
  }
  const { prefs, root, st } = boot();
  assert.equal(prefs.set('sidebar', 'collapsed').sidebar, 'collapsed');
  assert.deepEqual([root.attrs['data-sidebar'], st.map.get(K('sidebar'))], ['collapsed', 'collapsed']);
  assert.throws(() => prefs.set('sidebar', 'rail'), /sidebar must be expanded or collapsed/);
  assert.equal(ALV.prefsPure.parseSidebar('collapsed'), 'collapsed');
});

test('settings: iosQuiet (Quiet system noise) is off by default, validated, persisted and never a root attribute', () => {
  const { prefs, root, st } = boot();
  assert.equal(prefs.getSettings().iosQuiet, 'off');
  assert.equal(prefs.getSettings().iosQuietHint, 'unseen');
  prefs.patchSettings({ iosQuiet: 'on' });
  assert.equal(JSON.parse(st.map.get(K('settings'))).iosQuiet, 'on');
  assert.throws(() => prefs.patchSettings({ iosQuiet: true }), { name: 'RangeError' });
  assert.ok(!Object.keys(root.attrs).some(k => /quiet/i.test(k)));
});
