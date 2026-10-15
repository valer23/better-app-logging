/* Shortcut registry and Esc back-out stack (roadmap P3; spec "Keyboard map"). Classic script.
   ALV.createKeys({ platform }) is pure: the tests drive dispatch() with plain event-like objects.
   In the page, ALV.keys is that registry with one keydown listener on document (bubble phase, so a
   widget that handles a key itself and calls preventDefault wins).

   Combos are written 'Mod+E', 'Shift+Mod+E', 'Alt+C', 'End', '?'. Mod is Meta (Cmd) on macOS and Ctrl
   elsewhere (data-platform). A combo is stored in one canonical form, 'Meta+Ctrl+Alt+Shift+Key':
     - letters are upper case and match on e.key, so they follow the keyboard layout (with Meta or Ctrl,
       a non-Latin letter falls back to e.code);
     - with Alt held, letters, digits and punctuation match on e.code (macOS Option+C types 'ç'), and a
       symbol typed with Option / AltGr (German ']' is ⌥6) matches as that symbol first;
     - a punctuation key carries its own Shift ('?' is Shift+/ on US layouts), so Shift is dropped.
   Scopes: 'global' (anywhere), 'grid' (focus inside the grid root, P5 sets it), 'dialog' (only while a
   dialog is open; while one is, nothing else fires). A single printable key (or Space) must be
   grid-scoped (WCAG 2.1.4) and can be switched off with setSingleKeys(false). No combo without
   Meta/Ctrl/Alt fires in a text field or takes a key the focused control owns (a slider's End, a
   button's Enter); a Mod combo fires in a field only when its binding says inText.
   Escape backs out one layer in the spec's level order (pushEsc(fn, level); tooltips, menus and dialogs
   push one). */
(function (g) {
  'use strict';

  const MOD_ORDER = ['Meta', 'Ctrl', 'Alt', 'Shift'];
  const NAMED = {
    esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', space: 'Space', spacebar: 'Space', tab: 'Tab',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', backspace: 'Backspace', delete: 'Delete',
  };
  // OS and still-legacy combos nothing may bind: quit/close/hide/minimise, and the zoom keys the legacy
  // window keydown listener handles until P13 moves them into this registry.
  const RESERVED = ['Mod+Q', 'Mod+W', 'Mod+H', 'Mod+M', 'Mod+=', 'Mod+-', 'Mod+0'];
  const SCOPES = ['global', 'grid', 'dialog'];
  // The spec's Esc back-out order (spec "Selection": palette → sheet → stall sheet → menu → autocomplete →
  // rename → title edit → context → drawer → selection), with P3's tooltip first. Menus and popovers push
  // 'menu'. palette, sheet and stall are modal: a layer opened inside one backs out before it.
  const ESC_LEVELS = ['tooltip', 'palette', 'sheet', 'stall', 'menu', 'autocomplete', 'rename', 'title', 'context', 'drawer', 'selection'];
  const MODAL_ESC = new Set(['palette', 'sheet', 'stall']);
  // The unshifted US character of the punctuation keys, by e.code (the physical key under Alt).
  const CODE_KEY = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Comma: ',', Period: '.',
    Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=' };
  const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/;
  // Roles whose element handles unmodified keys itself (arrows, Home, End, Space, Enter).
  const OWNING_ROLES = new Set(['slider', 'spinbutton', 'scrollbar', 'radio', 'tab', 'menuitem', 'menuitemradio',
    'menuitemcheckbox', 'option', 'treeitem', 'separator', 'listbox', 'tree', 'tablist']);
  const ACTIVATING_ROLES = new Set(['button', 'link', 'checkbox', 'switch', ...OWNING_ROLES]);
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week']);
  const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
  const MAC_MOD = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
  const MAC_KEY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫',
    Delete: '⌦', Escape: 'esc', Tab: '⇥', Space: 'Space' };
  const PC_KEY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };

  // 'Mod++' is Mod and the '+' key; a lone '+' is the '+' key.
  function splitCombo(s) {
    if (s === '+') return ['+'];
    if (s.endsWith('++')) return [...s.slice(0, -2).split('+'), '+'];
    return s.split('+');
  }
  function normKey(k) {
    if (k.length === 1) return k === ' ' ? 'Space' : k.toUpperCase();
    const named = NAMED[k.toLowerCase()];
    if (named) return named;
    if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
    return k;
  }
  const isPunct = key => key.length === 1 && !/[A-Z0-9]/.test(key);
  function canon(mods, key) {
    if (isPunct(key)) mods.delete('Shift');
    return MOD_ORDER.filter(m => mods.has(m)).concat(key).join('+');
  }

  function parse(combo, platform) {
    if (typeof combo !== 'string' || !combo.trim()) throw new TypeError(`bad shortcut: ${combo}`);
    const parts = splitCombo(combo.trim());
    const raw = parts.pop();
    if (!raw) throw new TypeError(`no key in shortcut ${combo}`);
    const mods = new Set();
    for (const p of parts) {
      const m = p.toLowerCase();
      if (m === 'mod') mods.add(platform === 'mac' ? 'Meta' : 'Ctrl');
      else if (m === 'meta' || m === 'cmd') mods.add('Meta');
      else if (m === 'ctrl' || m === 'control') mods.add('Ctrl');
      else if (m === 'alt' || m === 'option') mods.add('Alt');
      else if (m === 'shift') mods.add('Shift');
      else throw new TypeError(`bad modifier "${p}" in shortcut ${combo}`);
    }
    return canon(mods, normKey(raw));
  }

  const physicalKey = code => (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : CODE_KEY[code] || null);
  // Option (macOS) or AltGr (Ctrl+Alt elsewhere) typed an ASCII symbol that the key does not carry on its
  // own: German ']' is ⌥6 on macOS and AltGr+9 on Windows. Plain Alt on Windows never changes the character.
  const typesSymbol = (ev, platform) => !!ev.altKey && !ev.metaKey && (platform === 'mac' || !!ev.ctrlKey)
    && ASCII_PUNCT.test(ev.key || '') && CODE_KEY[ev.code || ''] !== ev.key;

  // The combos an event can mean, most specific first; match() runs the first one that is bound.
  //   1. The symbol Option / AltGr typed, without modifiers, so ']' fires on every layout.
  //   2. With Alt held, the physical key plus the held modifiers: US ⌥] types '‘', Option+C types 'ç'.
  //   3. Otherwise e.key, so letters follow the layout. With Meta or Ctrl, a non-Latin letter (Cyrillic
  //      'у' on the E key) falls back to the physical letter, so ⌘E still works.
  function eventCombos(ev, platform) {
    const code = ev.code || '';
    const k = ev.key || '';
    const mods = () => {
      const m = new Set();
      if (ev.metaKey) m.add('Meta');
      if (ev.ctrlKey) m.add('Ctrl');
      if (ev.altKey) m.add('Alt');
      if (ev.shiftKey) m.add('Shift');
      return m;
    };
    const out = [];
    if (typesSymbol(ev, platform)) out.push(canon(new Set(), k));
    const phys = physicalKey(code);
    if (ev.altKey && phys) out.push(canon(mods(), phys));
    else if ((ev.metaKey || ev.ctrlKey) && /^Key[A-Z]$/.test(code) && k.length === 1 && /\p{L}/u.test(k) && !/[A-Za-z]/.test(k)) out.push(canon(mods(), code.slice(3)));
    else out.push(canon(mods(), normKey(k)));
    return out;
  }
  const eventCombo = (ev, platform) => eventCombos(ev, platform)[0];

  // One printable character or Space, with at most Shift: WCAG 2.1.4 "character key shortcut".
  function isSingleKey(c) {
    const parts = splitCombo(c);
    const key = parts.pop();
    return parts.every(m => m === 'Shift') && (key.length === 1 || key === 'Space');
  }
  const hasCommandMod = c => splitCombo(c).slice(0, -1).some(m => m !== 'Shift');

  function label(c, platform) {
    const parts = splitCombo(c);
    const key = parts.pop();
    if (platform === 'mac') return ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(m => parts.includes(m)).map(m => MAC_MOD[m]).join('') + (MAC_KEY[key] || key);
    return parts.map(m => (m === 'Meta' ? 'Win' : m)).concat(PC_KEY[key] || key).join('+');
  }
  // aria-keyshortcuts value: UI Events modifier names, '+' separated.
  function ariaOf(c) {
    const parts = splitCombo(c);
    const key = parts.pop();
    return parts.map(m => (m === 'Ctrl' ? 'Control' : m)).concat(key).join('+');
  }

  function isTextEntry(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    if (el.isContentEditable === true) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.getAttribute('type') || '').toLowerCase());
    return TEXT_ROLES.has(String(el.getAttribute('role') || ''));
  }
  // True when the focused element handles this unmodified key itself: every text field, any native input
  // but a button (a range's End, a checkbox's Space), the widget roles above, and Enter / Space on anything
  // that activates. A global binding without Meta/Ctrl/Alt must not take the key from it.
  function ownsKey(el, combo) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    if (isTextEntry(el)) return true;
    const tag = String(el.tagName || '').toUpperCase();
    const role = String(el.getAttribute('role') || '');
    if (tag === 'INPUT' && !BUTTON_INPUT_TYPES.has(String(el.getAttribute('type') || '').toLowerCase())) return true;
    if (OWNING_ROLES.has(role)) return true;
    const key = splitCombo(combo).pop();
    return (key === 'Enter' || key === 'Space') && (['BUTTON', 'A', 'SUMMARY', 'INPUT'].includes(tag) || ACTIVATING_ROLES.has(role));
  }
  const within = (root, el) => !!root && !!el && (root === el || (typeof root.contains === 'function' && root.contains(el)));
  // global fires in the grid too; dialog bindings fire only while a dialog is open, when nothing else does.
  const overlaps = (a, b) => a === b || (a === 'global' && b === 'grid') || (a === 'grid' && b === 'global');

  function createKeys({ platform } = {}) {
    const plat = platform === 'mac' ? 'mac' : 'other';
    const reserved = RESERVED.map(r => parse(r, plat));
    const bindings = new Map();   // id -> { id, scope, defaults, keys, run, when, inText, repeat }
    const escStack = [];   // { fn, rank, seq, modal }, in push order
    let escSeq = 0;
    let gridRoot = null;
    let modal = null;
    let singleKeys = true;

    const toCanon = keys => (Array.isArray(keys) ? keys : [keys]).map(k => parse(k, plat));

    function clashes(id, scope, keys) {
      const out = [];
      for (const k of keys) {
        if (reserved.includes(k)) out.push({ combo: k, ids: [id], why: 'reserved' });
        if (isSingleKey(k) && scope !== 'grid') out.push({ combo: k, ids: [id], why: 'single key outside the grid' });
        for (const b of bindings.values()) {
          if (b.id !== id && overlaps(b.scope, scope) && b.keys.includes(k)) out.push({ combo: k, ids: [b.id, id], why: 'taken' });
        }
      }
      return out;
    }
    const describe = list => list.map(c => (c.why === 'taken' ? `${c.combo} is already bound to ${c.ids[0]}` : `${c.combo}: ${c.why}`)).join('; ');

    function register({ id, keys, scope = 'global', run, when = null, inText = false, repeat = false }) {
      if (!id || typeof run !== 'function') throw new TypeError('register needs an id and a run function');
      if (!SCOPES.includes(scope)) throw new TypeError(`unknown scope "${scope}" for ${id}`);
      if (bindings.has(id)) throw new Error(`shortcut ${id} is already registered`);
      const k = toCanon(keys);
      const clash = clashes(id, scope, k);
      if (clash.length) throw new Error(`${id}: ${describe(clash)}`);
      const b = { id, scope, defaults: k, keys: k, run, when, inText: !!inText, repeat: !!repeat };
      bindings.set(id, b);
      return () => { if (bindings.get(id) === b) bindings.delete(id); };
    }

    // Rebind (P14 persists overrides). null restores the defaults. Returns the conflicts; applied only if none.
    function override(id, keys) {
      const b = bindings.get(id);
      if (!b) throw new Error(`unknown shortcut ${id}`);
      const k = keys == null ? b.defaults : toCanon(keys);
      const clash = clashes(id, b.scope, k);
      if (!clash.length) b.keys = k;
      return clash;
    }

    function conflicts() {
      const out = [];
      const list = [...bindings.values()];
      list.forEach((b, i) => {
        for (const k of b.keys) {
          if (reserved.includes(k)) out.push({ combo: k, ids: [b.id], why: 'reserved' });
          for (const o of list.slice(i + 1)) if (overlaps(b.scope, o.scope) && o.keys.includes(k)) out.push({ combo: k, ids: [b.id, o.id], why: 'taken' });
        }
      });
      return out;
    }

    // `level` is one of ESC_LEVELS. Returns pop(), which is idempotent and may remove from the middle.
    function pushEsc(fn, level) {
      const rank = ESC_LEVELS.indexOf(level);
      if (rank < 0) throw new TypeError(`unknown Esc level "${level}"`);
      if (typeof fn !== 'function') throw new TypeError('pushEsc needs a function');
      const entry = { fn, rank, seq: ++escSeq, modal: MODAL_ESC.has(level) };
      escStack.push(entry);
      return () => { const i = escStack.indexOf(entry); if (i >= 0) escStack.splice(i, 1); };
    }
    // What Escape backs out of: the layers opened after the newest modal one (a menu inside a sheet) if any,
    // else every layer; among those the spec's level order first, then the newest within a level.
    function escTarget() {
      let from = 0;
      for (let i = escStack.length - 1; i >= 0; i--) {
        if (escStack[i].modal) { if (i + 1 < escStack.length) from = i + 1; break; }
      }
      let best = null;
      for (const e of escStack.slice(from)) if (!best || e.rank < best.rank || (e.rank === best.rank && e.seq > best.seq)) best = e;
      return best;
    }

    // The binding this event would run, or null. `active` is document.activeElement.
    function match(ev, active) {
      const inField = isTextEntry(active);
      if (inField && typesSymbol(ev, plat)) return null;   // Option / AltGr typed a character into the field
      for (const combo of eventCombos(ev, plat)) {
        for (const b of bindings.values()) {
          if (!b.keys.includes(combo)) continue;
          if (modal ? b.scope !== 'dialog' : b.scope === 'dialog') continue;
          if (ev.repeat && !b.repeat) continue;
          if (inField && (!hasCommandMod(combo) || !b.inText)) continue;
          if (!hasCommandMod(combo) && b.scope !== 'grid' && ownsKey(active, combo)) continue;
          if (b.scope === 'grid' && (!within(gridRoot, active) || (isSingleKey(combo) && !singleKeys))) continue;
          if (b.when && !b.when()) continue;
          return b;
        }
      }
      return null;
    }

    // Runs what the event means and returns its id ('esc' for the back-out stack), or null.
    function dispatch(ev, active) {
      if (!ev || ev.isComposing || ev.keyCode === 229 || ev.defaultPrevented) return null;
      if (ev.key === 'Escape' && escStack.length) {
        ev.preventDefault();
        escTarget().fn(ev);
        return 'esc';
      }
      const b = match(ev, active);
      if (!b) return null;
      ev.preventDefault();
      b.run(ev);
      return b.id;
    }

    function attach(target, getActive) {
      const onKey = ev => { dispatch(ev, getActive()); };
      target.addEventListener('keydown', onKey);
      return () => target.removeEventListener('keydown', onKey);
    }

    const first = id => { const b = bindings.get(id); return b && b.keys.length ? b.keys[0] : null; };

    return {
      platform: plat,
      register, override, conflicts, pushEsc, dispatch, match, attach,
      escDepth: () => escStack.length,
      setGridRoot(el) { gridRoot = el || null; },
      setModal(el) { modal = el || null; },
      setSingleKeys(on) { singleKeys = !!on; },
      keysOf: id => { const b = bindings.get(id); return b ? b.keys.slice() : []; },
      label: id => { const c = first(id); return c ? label(c, plat) : ''; },
      aria: id => { const b = bindings.get(id); return b ? b.keys.map(ariaOf).join(' ') : ''; },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.createKeys = createKeys;
  ALV.keysPure = Object.freeze({ parse, eventCombo, eventCombos, label, ariaOf, isTextEntry, ownsKey, isSingleKey, RESERVED, ESC_LEVELS });
  if (typeof document !== 'undefined' && document.documentElement) {
    ALV.keys = createKeys({ platform: document.documentElement.getAttribute('data-platform') });
    ALV.keys.attach(document, () => document.activeElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
