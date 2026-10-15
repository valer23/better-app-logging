// The shortcut registry (viewer/assets/js/keys.js): combo parsing and labels per platform, the event
// matcher (layout-aware letters, Option via e.code, punctuation Shift), scopes, the single-key rules
// (WCAG 2.1.4: grid only, never in a text field, switchable off), conflicts and the Esc back-out stack.
// keys.js loads in an EMPTY vm context: the registry is pure, events are plain objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureModule } from './_load.mjs';

const ALV = loadPureModule('keys.js');
const P = ALV.keysPure;

// A keydown-like object. `prevented` records preventDefault().
const key = (k, o = {}) => ({
  key: k, code: o.code || '', metaKey: !!o.meta, ctrlKey: !!o.ctrl, altKey: !!o.alt, shiftKey: !!o.shift,
  repeat: !!o.repeat, isComposing: !!o.composing, keyCode: o.keyCode || 0, defaultPrevented: !!o.defaultPrevented,
  prevented: false, preventDefault() { this.prevented = true; },
});
// Element-like objects for document.activeElement.
const elem = (tagName, attrs = {}, extra = {}) => ({ tagName, getAttribute: n => (n in attrs ? attrs[n] : null), ...extra });
const BODY = elem('BODY');
const SEARCH = elem('INPUT', { type: 'text' });
const GRID_ROW = elem('DIV', { role: 'row' });
const GRID = elem('DIV', { role: 'grid' }, { contains: el => el === GRID_ROW });

test('keys.js loads in an empty context and does not build a page instance there', () => {
  assert.equal(typeof ALV.createKeys, 'function');
  assert.equal(ALV.keys, undefined);
});

test('parse: one canonical form; Mod is Meta on mac and Ctrl elsewhere; punctuation drops Shift', () => {
  assert.equal(P.parse('Mod+E', 'mac'), 'Meta+E');
  assert.equal(P.parse('Mod+E', 'other'), 'Ctrl+E');
  assert.equal(P.parse('shift+mod+e', 'mac'), 'Meta+Shift+E');
  assert.equal(P.parse('Alt+Shift+Ctrl+Meta+k', 'mac'), 'Meta+Ctrl+Alt+Shift+K');
  assert.equal(P.parse('Shift+?', 'mac'), '?');
  assert.equal(P.parse('?', 'other'), '?');
  assert.equal(P.parse('Shift+M', 'mac'), 'Shift+M');
  assert.equal(P.parse('Mod++', 'other'), 'Ctrl++');
  assert.equal(P.parse('esc', 'mac'), 'Escape');
  assert.equal(P.parse('Mod+Enter', 'mac'), 'Meta+Enter');
  assert.equal(P.parse('space', 'other'), 'Space');
  for (const bad of ['', 'Hyper+K', 'Mod+', 42]) assert.throws(() => P.parse(bad, 'mac'), /bad shortcut|bad modifier|no key/, String(bad));
});

test('eventCombo: letters follow e.key (any layout), Option combos use e.code, Space and punctuation normalise', () => {
  assert.equal(P.eventCombo(key('e', { meta: true })), 'Meta+E');
  assert.equal(P.eventCombo(key('E', { meta: true, shift: true })), 'Meta+Shift+E');
  assert.equal(P.eventCombo(key('a', { ctrl: true, code: 'KeyQ' })), 'Ctrl+A', 'AZERTY: the A key is where QWERTY has Q');
  assert.equal(P.eventCombo(key('ç', { alt: true, code: 'KeyC' })), 'Alt+C', 'macOS Option+C types ç');
  assert.equal(P.eventCombo(key('¡', { alt: true, code: 'Digit1' })), 'Alt+1');
  assert.equal(P.eventCombo(key('?', { shift: true, code: 'Slash' })), '?');
  assert.equal(P.eventCombo(key(' ')), 'Space');
  assert.equal(P.eventCombo(key('ArrowDown', { meta: true })), 'Meta+ArrowDown');
});

test('labels and aria-keyshortcuts per platform', () => {
  assert.equal(P.label('Meta+Shift+E', 'mac'), '⇧⌘E');
  assert.equal(P.label('Ctrl+Alt+M', 'mac'), '⌃⌥M');
  assert.equal(P.label('Meta+Enter', 'mac'), '⌘↵');
  assert.equal(P.label('Ctrl+Shift+E', 'other'), 'Ctrl+Shift+E');
  assert.equal(P.label('Escape', 'other'), 'Esc');
  assert.equal(P.ariaOf('Ctrl+Shift+E'), 'Control+Shift+E');
  assert.equal(P.ariaOf('Meta+E'), 'Meta+E');
  const mac = ALV.createKeys({ platform: 'mac' });
  const pc = ALV.createKeys({ platform: 'win' });
  for (const k of [mac, pc]) k.register({ id: 'export.menu', keys: 'Mod+E', inText: true, run() {} });
  assert.equal(mac.label('export.menu'), '⌘E');
  assert.equal(pc.label('export.menu'), 'Ctrl+E');
  assert.equal(mac.aria('export.menu'), 'Meta+E');
  assert.equal(pc.aria('export.menu'), 'Control+E');
  assert.equal(mac.label('nope'), '');
});

test('isTextEntry: text inputs, textarea, select, contenteditable and text roles; not buttons or checkboxes', () => {
  for (const el of [SEARCH, elem('INPUT'), elem('INPUT', { type: 'Search' }), elem('TEXTAREA'), elem('SELECT'),
    elem('DIV', {}, { isContentEditable: true }), elem('DIV', { role: 'combobox' }), elem('SPAN', { role: 'textbox' })]) {
    assert.equal(P.isTextEntry(el), true, JSON.stringify(el));
  }
  for (const el of [BODY, elem('BUTTON'), elem('INPUT', { type: 'checkbox' }), elem('INPUT', { type: 'radio' }), GRID_ROW, null]) {
    assert.equal(P.isTextEntry(el), false, JSON.stringify(el));
  }
});

test('a global Mod combo fires anywhere, in a text field only with inText, and prevents the default', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const hits = [];
  k.register({ id: 'export.menu', keys: 'Mod+E', inText: true, run: () => hits.push('export') });
  k.register({ id: 'app.palette', keys: 'Mod+K', run: () => hits.push('palette') });
  const ev = key('e', { meta: true });
  assert.equal(k.dispatch(ev, BODY), 'export.menu');
  assert.equal(ev.prevented, true);
  assert.equal(k.dispatch(key('e', { meta: true }), SEARCH), 'export.menu');
  assert.equal(k.dispatch(key('k', { meta: true }), BODY), 'app.palette');
  const typed = key('k', { meta: true });
  assert.equal(k.dispatch(typed, SEARCH), null, 'inText:false stays out of fields (⌘K, ⌘A, ⌘Z keep their editing meaning)');
  assert.equal(typed.prevented, false);
  assert.equal(k.dispatch(key('e', { ctrl: true }), BODY), null, 'Ctrl+E is not Mod+E on mac');
  assert.deepEqual(hits, ['export', 'export', 'palette']);
});

test('acceptance: single-key grid shortcuts never fire in a text field, fire in the grid, and can be switched off', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  let n = 0;
  k.register({ id: 'stream.follow', keys: 'F', scope: 'grid', run: () => { n++; } });
  k.register({ id: 'app.shortcuts', keys: '?', scope: 'grid', run: () => { n += 100; } });
  assert.equal(k.dispatch(key('f'), GRID_ROW), null, 'no grid root yet (P5 sets it)');
  k.setGridRoot(GRID);
  for (const field of [SEARCH, elem('TEXTAREA'), elem('DIV', {}, { isContentEditable: true }), elem('DIV', { role: 'combobox' })]) {
    assert.equal(k.dispatch(key('f'), field), null, 'never in a text field');
  }
  assert.equal(k.dispatch(key('f'), BODY), null, 'focus outside the grid');
  assert.equal(k.dispatch(key('f'), GRID_ROW), 'stream.follow');
  assert.equal(k.dispatch(key('?', { shift: true }), GRID_ROW), 'app.shortcuts');
  k.setSingleKeys(false);
  assert.equal(k.dispatch(key('f'), GRID_ROW), null, 'Settings → Shortcuts can switch single keys off');
  assert.equal(n, 101);
});

test('a combo without Meta/Ctrl/Alt never fires in a text field, even with inText', () => {
  const k = ALV.createKeys({ platform: 'other' });
  k.register({ id: 'stream.end', keys: 'End', inText: true, run() {} });
  assert.equal(k.dispatch(key('End'), BODY), 'stream.end');
  assert.equal(k.dispatch(key('End'), SEARCH), null, 'End moves the caret in a field');
});

test('register refuses single keys outside the grid, reserved combos, duplicates and taken combos', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  assert.throws(() => k.register({ id: 'x', keys: 'M', run() {} }), /single key outside the grid/);
  assert.throws(() => k.register({ id: 'x', keys: 'Space', scope: 'dialog', run() {} }), /single key outside the grid/);
  assert.throws(() => k.register({ id: 'x', keys: 'Mod+Q', run() {} }), /reserved/);
  assert.throws(() => k.register({ id: 'x', keys: 'Mod+=', run() {} }), /reserved/, 'legacy zoom keeps ⌘= until P13');
  assert.throws(() => k.register({ id: 'x', keys: 'Mod+E', scope: 'nowhere', run() {} }), /unknown scope/);
  assert.throws(() => k.register({ id: 'x', keys: 'Mod+E' }), /run function/);
  k.register({ id: 'a', keys: 'Mod+E', run() {} });
  assert.throws(() => k.register({ id: 'a', keys: 'Mod+J', run() {} }), /already registered/);
  assert.throws(() => k.register({ id: 'b', keys: 'Mod+E', scope: 'grid', run() {} }), /already bound to a/, 'global overlaps grid');
  assert.doesNotThrow(() => k.register({ id: 'c', keys: 'Mod+E', scope: 'dialog', run() {} }), 'dialog bindings never fire alongside global ones');
  const off = k.register({ id: 'd', keys: ['Mod+J', 'Mod+ArrowDown'], run() {} });
  assert.deepEqual([...k.keysOf('d')], ['Meta+J', 'Meta+ArrowDown']);
  off();
  assert.deepEqual([...k.keysOf('d')], []);
  assert.doesNotThrow(() => k.register({ id: 'd2', keys: 'Mod+J', run() {} }), 'unregister frees the combo');
});

test('override rebinds when free, reports conflicts otherwise, and null restores the default', () => {
  const k = ALV.createKeys({ platform: 'other' });
  k.register({ id: 'export.menu', keys: 'Mod+E', run() {} });
  k.register({ id: 'app.palette', keys: 'Mod+K', run() {} });
  assert.equal(k.override('export.menu', 'Mod+Shift+X').length, 0);
  assert.deepEqual([...k.keysOf('export.menu')], ['Ctrl+Shift+X']);
  const clash = k.override('export.menu', 'Mod+K');
  assert.deepEqual([...clash].map(c => [c.combo, [...c.ids], c.why]), [['Ctrl+K', ['app.palette', 'export.menu'], 'taken']]);
  assert.deepEqual([...k.keysOf('export.menu')], ['Ctrl+Shift+X'], 'a conflicting override is not applied');
  assert.equal(k.override('export.menu', 'X')[0].why, 'single key outside the grid');
  assert.equal(k.override('export.menu', null).length, 0);
  assert.deepEqual([...k.keysOf('export.menu')], ['Ctrl+E']);
  assert.throws(() => k.override('nope', 'Mod+J'), /unknown shortcut/);
  assert.equal(k.conflicts().length, 0);
});

test('while a dialog is open only dialog bindings fire; with none open, dialog bindings never do', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const hits = [];
  k.register({ id: 'export.menu', keys: 'Mod+E', run: () => hits.push('page') });
  k.register({ id: 'dialog.primary', keys: 'Mod+Enter', scope: 'dialog', inText: true, run: () => hits.push('primary') });
  assert.equal(k.dispatch(key('Enter', { meta: true }), BODY), null);
  k.setModal(elem('DIV', { role: 'dialog' }));
  assert.equal(k.dispatch(key('e', { meta: true }), BODY), null, 'page shortcuts are off behind a dialog');
  assert.equal(k.dispatch(key('Enter', { meta: true }), SEARCH), 'dialog.primary');
  k.setModal(null);
  assert.equal(k.dispatch(key('e', { meta: true }), BODY), 'export.menu');
  assert.deepEqual(hits, ['primary', 'page']);
});

test('Esc backs out in the spec order, not push order; newest first within a level; a layer inside a sheet goes first', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const order = [];
  // Context mode then the drawer, and the reverse: context backs out first either way (spec "Selection").
  for (const levels of [['context', 'drawer'], ['drawer', 'context']]) {
    const pops = levels.map(l => k.pushEsc(() => order.push(l), l));
    const ev = key('Escape');
    assert.equal(k.dispatch(ev, SEARCH), 'esc', 'even in a text field');
    assert.equal(ev.prevented, true);
    for (const pop of pops) { pop(); pop(); }   // pop() is idempotent
  }
  assert.deepEqual(order, ['context', 'context']);
  assert.equal(k.escDepth(), 0);
  const popA = k.pushEsc(() => order.push('menu A'), 'menu');
  const popB = k.pushEsc(() => order.push('menu B'), 'menu');
  k.dispatch(key('Escape'), BODY);
  popA();
  k.dispatch(key('Escape'), BODY);
  popB();
  assert.deepEqual(order.slice(2), ['menu B', 'menu B'], 'newest within a level; removal from the middle');
  const pops = ['selection', 'sheet', 'menu'].map(l => k.pushEsc(() => order.push(l), l));
  for (let i = 2; i >= 0; i--) { k.dispatch(key('Escape'), BODY); pops[i](); }
  assert.deepEqual(order.slice(4), ['menu', 'sheet', 'selection'], 'a menu opened inside a sheet closes before the sheet');
  assert.throws(() => k.pushEsc(() => {}, 'popover'), /unknown Esc level/);
  assert.throws(() => k.pushEsc(() => {}), /unknown Esc level/);
  const plain = key('Escape');
  assert.equal(k.dispatch(plain, BODY), null);
  assert.equal(plain.prevented, false, 'with nothing to back out of, Escape keeps its default');
});

test('layouts: Option and AltGr symbols match as the symbol, Alt+punctuation by e.code, non-Latin letters under Mod by e.code', () => {
  assert.equal(P.eventCombo(key('‘', { alt: true, code: 'BracketRight' }), 'mac'), 'Alt+]', 'US macOS: ⌥] types ‘');
  assert.deepEqual([...P.eventCombos(key(']', { alt: true, code: 'Digit6' }), 'mac')], [']', 'Alt+6'], 'German macOS: ] is ⌥6');
  assert.equal(P.eventCombo(key(']', { alt: true, ctrl: true, code: 'Digit9' }), 'other'), ']', 'German Windows: ] is AltGr+9');
  assert.deepEqual([...P.eventCombos(key(']', { alt: true, code: 'BracketRight' }), 'other')], ['Alt+]'], 'Windows Alt+] does not change the character');
  assert.equal(P.eventCombo(key('у', { meta: true, code: 'KeyE' }), 'mac'), 'Meta+E', 'Cyrillic layout: ⌘E types у');
  const k = ALV.createKeys({ platform: 'mac' });
  const hits = [];
  k.register({ id: 'marker.next', keys: ']', scope: 'grid', run: () => hits.push(']') });
  k.register({ id: 'filter.saved6', keys: 'Alt+6', run: () => hits.push('⌥6') });
  k.register({ id: 'error.next', keys: 'Alt+]', run: () => hits.push('⌥]') });
  k.register({ id: 'export.menu', keys: 'Mod+E', inText: true, run: () => hits.push('⌘E') });
  k.setGridRoot(GRID);
  assert.equal(k.dispatch(key(']', { alt: true, code: 'Digit6' }), GRID_ROW), 'marker.next', 'German ] in the grid is ], not ⌥6');
  const typed = key(']', { alt: true, code: 'Digit6' });
  assert.equal(k.dispatch(typed, SEARCH), null, 'in a text field the symbol just types');
  assert.equal(typed.prevented, false);
  assert.equal(k.dispatch(key('‘', { alt: true, code: 'BracketRight' }), GRID_ROW), 'error.next');
  assert.equal(k.dispatch(key('¶', { alt: true, code: 'Digit6' }), BODY), 'filter.saved6', 'US macOS: ⌥6 types ¶');
  assert.equal(k.dispatch(key('у', { meta: true, code: 'KeyE' }), SEARCH), 'export.menu');
  assert.deepEqual(hits, [']', '⌥]', '⌥6', '⌘E']);
});

test('a global key without Meta/Ctrl/Alt stays with the focused control that owns it (slider End, button Enter)', () => {
  const k = ALV.createKeys({ platform: 'other' });
  k.register({ id: 'stream.end', keys: 'End', run() {} });
  k.register({ id: 'onboarding.next', keys: 'Enter', run() {} });
  k.register({ id: 'export.menu', keys: 'Mod+E', run() {} });
  const RANGE = elem('INPUT', { type: 'range' });
  const BUTTON = elem('BUTTON');
  assert.equal(k.dispatch(key('End'), RANGE), null, 'End moves the slider');
  assert.equal(k.dispatch(key('End'), elem('DIV', { role: 'radio' })), null);
  assert.equal(k.dispatch(key('End'), elem('INPUT', { type: 'checkbox' })), null);
  assert.equal(k.dispatch(key('End'), BUTTON), 'stream.end', 'a button does not use End');
  assert.equal(k.dispatch(key('Enter'), BUTTON), null, 'Enter activates the focused button');
  assert.equal(k.dispatch(key('Enter'), elem('DIV', { role: 'switch' })), null);
  assert.equal(k.dispatch(key('Enter'), elem('INPUT', { type: 'submit' })), null);
  assert.equal(k.dispatch(key('Enter'), BODY), 'onboarding.next');
  assert.equal(k.dispatch(key('e', { ctrl: true }), RANGE), 'export.menu', 'command combos are never owned');
  assert.equal(P.ownsKey(BUTTON, 'End'), false);
  assert.equal(P.ownsKey(elem('BUTTON'), 'Space'), true);
});

test('IME composition, keyCode 229, handled events and unwanted repeats are ignored; `when` gates a binding', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  let on = false;
  let n = 0;
  k.register({ id: 'export.menu', keys: 'Mod+E', when: () => on, run: () => { n++; } });
  k.pushEsc(() => { n += 100; }, 'menu');
  assert.equal(k.dispatch(key('Escape', { composing: true }), BODY), null);
  assert.equal(k.dispatch(key('Process', { keyCode: 229 }), BODY), null);
  assert.equal(k.dispatch(key('Escape', { defaultPrevented: true }), BODY), null);
  assert.equal(k.dispatch(key('e', { meta: true }), BODY), null, 'when() is false');
  on = true;
  assert.equal(k.dispatch(key('e', { meta: true, repeat: true }), BODY), null, 'auto-repeat ignored unless the binding sets repeat');
  assert.equal(k.dispatch(key('e', { meta: true }), BODY), 'export.menu');
  assert.equal(n, 1);
});

test('Esc: the newest modal layer is a barrier, also when it is the last one on the stack', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const hit = [];
  const run = (name, pushes) => {
    const pops = pushes.map(([level, tag]) => k.pushEsc(() => hit.push(tag), level));
    k.dispatch(key('Escape'), BODY);
    pops.forEach(p => p());
  };
  run('stall over sheet', [['sheet', 'sheet'], ['stall', 'stall']]);
  run('stall over palette', [['palette', 'palette'], ['stall', 'stall']]);
  run('sheet opened from the palette', [['palette', 'palette'], ['sheet', 'sheet']]);
  run('sheet over a tooltip', [['tooltip', 'tooltip'], ['sheet', 'sheet']]);
  run('dialog over a hovered tooltip and a menu', [['tooltip', 'tooltip'], ['menu', 'menu'], ['sheet', 'sheet']]);
  run('a menu inside the sheet still goes first', [['tooltip', 'tooltip'], ['sheet', 'sheet'], ['menu', 'menu']]);
  assert.deepEqual(hit, ['stall', 'stall', 'sheet', 'sheet', 'sheet', 'menu']);
  assert.equal(k.escDepth(), 0);
});

test('Shift stays when the written key is not itself a shifted symbol: ⇧⌘= and ⌘= are two combos', () => {
  assert.equal(P.parse('Shift+Mod+=', 'mac'), 'Meta+Shift+=');
  assert.equal(P.parse('Mod+=', 'mac'), 'Meta+=');
  assert.notEqual(P.parse('Shift+Mod+=', 'mac'), P.parse('Mod+=', 'mac'));
  assert.equal(P.parse('Shift+Mod+-', 'other'), 'Ctrl+Shift+-');
  assert.equal(P.parse('Shift+?', 'mac'), '?', 'a shifted symbol still carries its own Shift');
  assert.equal(P.parse('Shift+Mod++', 'mac'), 'Meta++');
  assert.deepEqual([...P.eventCombos(key('+', { meta: true, shift: true, code: 'Equal' }), 'mac')], ['Meta++', 'Meta+Shift+=']);
  assert.deepEqual([...P.eventCombos(key('=', { meta: true, code: 'Equal' }), 'mac')], ['Meta+=']);
  const k = ALV.createKeys({ platform: 'mac' });
  const hits = [];
  assert.doesNotThrow(() => k.register({ id: 'ui.bigger', keys: 'Shift+Mod+=', run: () => hits.push('bigger') }), '⇧⌘= is not the reserved ⌘=');
  k.register({ id: 'ui.smaller', keys: 'Shift+Mod+-', run: () => hits.push('smaller') });
  assert.throws(() => k.register({ id: 'ui.zoom', keys: 'Mod+=', run() {} }), /reserved/);
  assert.equal(k.dispatch(key('+', { meta: true, shift: true, code: 'Equal' }), BODY), 'ui.bigger', 'US layout: ⇧⌘= types +');
  assert.equal(k.dispatch(key('_', { meta: true, shift: true, code: 'Minus' }), BODY), 'ui.smaller');
  assert.equal(k.dispatch(key('=', { meta: true, code: 'Equal' }), BODY), null, 'plain ⌘= is the legacy zoom, not ours');
  assert.deepEqual(hits, ['bigger', 'smaller']);
});

test('with Meta or Ctrl held, a digit matches on e.code when the layout types a symbol there (AZERTY ⌘1)', () => {
  assert.deepEqual([...P.eventCombos(key('&', { meta: true, code: 'Digit1' }), 'mac')], ['Meta+&', 'Meta+1']);
  assert.deepEqual([...P.eventCombos(key('1', { meta: true, code: 'Digit1' }), 'mac')], ['Meta+1']);
  assert.equal(P.eventCombo(key('&', { meta: true, code: 'Digit1' }), 'mac'), 'Meta+&');
  const k = ALV.createKeys({ platform: 'mac' });
  k.register({ id: 'view.logs', keys: 'Mod+1', run() {} });
  k.register({ id: 'view.devices', keys: 'Mod+2', run() {} });
  assert.equal(k.dispatch(key('&', { meta: true, code: 'Digit1' }), BODY), 'view.logs');
  assert.equal(k.dispatch(key('é', { meta: true, code: 'Digit2' }), BODY), 'view.devices');
  assert.equal(k.dispatch(key('2', { meta: true, code: 'Digit2' }), BODY), 'view.devices', 'QWERTY unchanged');
});

test('a text field keeps Option (macOS) and AltGr (Ctrl+Alt) typing, whatever inText says', () => {
  const mac = ALV.createKeys({ platform: 'mac' });
  mac.register({ id: 'level.error', keys: 'Alt+E', inText: true, run() {} });
  mac.register({ id: 'export.menu', keys: 'Mod+E', inText: true, run() {} });
  const dead = key('Dead', { alt: true, code: 'KeyE' });
  assert.equal(mac.dispatch(dead, SEARCH), null, 'Option+E is the acute dead key');
  assert.equal(dead.prevented, false);
  assert.equal(mac.dispatch(key('Dead', { alt: true, code: 'KeyE' }), BODY), 'level.error', 'outside a field it is a shortcut');
  assert.equal(mac.dispatch(key('e', { meta: true, alt: true, code: 'KeyE' }), SEARCH), null, 'no ⌘⌥E binding');
  assert.equal(mac.dispatch(key('e', { meta: true }), SEARCH), 'export.menu', 'Cmd combos still reach a field');
  const pc = ALV.createKeys({ platform: 'win' });
  pc.register({ id: 'level.error', keys: 'Ctrl+Alt+A', inText: true, run() {} });
  pc.register({ id: 'level.warn', keys: 'Alt+W', inText: true, run() {} });
  const altgr = key('ą', { ctrl: true, alt: true, code: 'KeyA' });
  assert.equal(pc.dispatch(altgr, SEARCH), null, 'AltGr+A types ą on a Polish layout');
  assert.equal(altgr.prevented, false);
  assert.equal(pc.dispatch(key('a', { ctrl: true, alt: true, code: 'KeyA' }), BODY), 'level.error');
  assert.equal(pc.dispatch(key('w', { alt: true, code: 'KeyW' }), SEARCH), 'level.warn', 'plain Alt types nothing on Windows');
});

test('match stops at the first candidate that has a binding, so one keystroke is one command wherever focus is', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const hits = [];
  k.register({ id: 'marker.next', keys: ']', scope: 'grid', run: () => hits.push(']') });
  k.register({ id: 'filter.saved6', keys: 'Alt+6', run: () => hits.push('⌥6') });
  k.setGridRoot(GRID);
  const german = () => key(']', { alt: true, code: 'Digit6' });
  assert.equal(k.dispatch(german(), GRID_ROW), 'marker.next');
  const outside = german();
  assert.equal(k.dispatch(outside, BODY), null, 'German ⌥6 outside the grid is the ] key, which is bound but not eligible here');
  assert.equal(outside.prevented, false);
  assert.equal(k.dispatch(key('¶', { alt: true, code: 'Digit6' }), BODY), 'filter.saved6', 'US ⌥6 is still ⌥6');
  assert.deepEqual(hits, [']', '⌥6']);
});

test('Windows Alt letters follow the layout (AZERTY Alt+A), macOS Option keeps the physical key', () => {
  assert.deepEqual([...P.eventCombos(key('a', { alt: true, code: 'KeyQ' }), 'other')], ['Alt+A'], 'AZERTY Windows: the A key is KeyQ');
  assert.deepEqual([...P.eventCombos(key('1', { alt: true, code: 'Digit1' }), 'other')], ['Alt+1']);
  assert.deepEqual([...P.eventCombos(key('&', { alt: true, code: 'Digit1' }), 'other')], ['Alt+1'], 'a symbol under Alt falls back to the physical digit');
  assert.deepEqual([...P.eventCombos(key('A', { alt: true, shift: true, code: 'KeyQ' }), 'other')], ['Alt+Shift+A']);
  assert.deepEqual([...P.eventCombos(key('å', { alt: true, code: 'KeyA' }), 'mac')], ['Alt+A'], 'macOS Option+A types å');
  assert.deepEqual([...P.eventCombos(key('ą', { alt: true, ctrl: true, code: 'KeyA' }), 'other')], ['Ctrl+Alt+A'], 'AltGr keeps the physical key');
  const k = ALV.createKeys({ platform: 'win' });
  k.register({ id: 'level.warn', keys: 'Alt+W', run() {} });
  k.register({ id: 'level.alt', keys: 'Alt+Z', run() {} });
  assert.equal(k.dispatch(key('w', { alt: true, code: 'KeyZ' }), BODY), 'level.warn', 'AZERTY: ⌥W is the key labelled W');
  assert.equal(k.dispatch(key('z', { alt: true, code: 'KeyW' }), BODY), 'level.alt');
});

test('a grid binding does not take Enter or Space from a button, link or checkbox inside the grid', () => {
  const k = ALV.createKeys({ platform: 'mac' });
  const ROW_BUTTON = elem('BUTTON');
  const ROW_LINK = elem('A');
  const ROW_CHECK = elem('INPUT', { type: 'checkbox' });
  const root = { ...GRID, contains: el => [GRID_ROW, ROW_BUTTON, ROW_LINK, ROW_CHECK].includes(el) };
  k.register({ id: 'row.open', keys: 'Enter', scope: 'grid', run() {} });
  k.register({ id: 'stream.pause', keys: 'Space', scope: 'grid', run() {} });
  k.register({ id: 'stream.follow', keys: 'F', scope: 'grid', run() {} });
  k.setGridRoot(root);
  assert.equal(k.dispatch(key('Enter'), GRID_ROW), 'row.open', 'a row has no owning role');
  assert.equal(k.dispatch(key(' '), GRID_ROW), 'stream.pause');
  assert.equal(k.dispatch(key('Enter'), ROW_BUTTON), null, 'Enter activates the button');
  assert.equal(k.dispatch(key(' '), ROW_BUTTON), null);
  assert.equal(k.dispatch(key('Enter'), ROW_LINK), null);
  assert.equal(k.dispatch(key(' '), ROW_CHECK), null);
  assert.equal(k.dispatch(key('f'), ROW_BUTTON), 'stream.follow', 'a letter is not the button\'s');
});

test('Esc: a hover tooltip ranks after menus and text editing, a keyboard tooltip before everything (P4)', () => {
  assert.deepEqual([...P.ESC_LEVELS], ['tooltip', 'palette', 'sheet', 'stall', 'menu', 'autocomplete', 'rename', 'title',
    'tooltip-hover', 'context', 'drawer', 'selection']);
  const k = ALV.createKeys({ platform: 'mac' });
  const hit = [];
  const popHover = k.pushEsc(() => hit.push('hover'), 'tooltip-hover');
  const popMenu = k.pushEsc(() => hit.push('menu'), 'menu');
  k.dispatch(key('Escape'), BODY);
  popMenu();
  k.dispatch(key('Escape'), BODY);
  popHover();
  const popKb = k.pushEsc(() => hit.push('keyboard'), 'tooltip');
  const popMenu2 = k.pushEsc(() => hit.push('menu'), 'menu');
  k.dispatch(key('Escape'), BODY);
  popKb(); popMenu2();
  const popHover2 = k.pushEsc(() => hit.push('hover'), 'tooltip-hover');
  const popAc = k.pushEsc(() => hit.push('autocomplete'), 'autocomplete');
  k.dispatch(key('Escape'), BODY);
  popAc(); popHover2();
  assert.deepEqual(hit, ['menu', 'hover', 'keyboard', 'autocomplete'], 'Esc cancels what the keyboard is typing first');
});

test('comboLabel labels a written combo outside the registry, per platform (P4 zoom tooltips)', () => {
  const mac = ALV.createKeys({ platform: 'mac' });
  const pc = ALV.createKeys({ platform: 'other' });
  assert.deepEqual([mac.comboLabel('Mod+-'), mac.comboLabel('Mod+='), mac.comboLabel('Mod+0'), mac.comboLabel('Mod+Backspace')], ['⌘-', '⌘=', '⌘0', '⌘⌫']);
  assert.deepEqual([pc.comboLabel('Mod+-'), pc.comboLabel('Shift+Mod+L')], ['Ctrl+-', 'Ctrl+Shift+L']);
  assert.throws(() => mac.comboLabel('Hyper+X'), /bad modifier/);
});
