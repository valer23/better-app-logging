/* UI primitives (roadmap P3; spec "Toasts", "Menus, popovers and tooltips", "Accessibility requirements").
   Classic script. The decisions are pure functions on ALV.uiPure (placement, roving index, typeahead,
   the toast queue, the announcement throttle, the focus-trap step), so the tests run them in an empty
   vm context. The DOM side (ALV.createUi, ALV.ui in the page) wires them to the overlay root. */
(function (g) {
  'use strict';

  // ---- Pure ----

  // Where a surface of `size` {w, h} goes next to `anchor` (a DOMRect-like {left, top, right, bottom,
  // width}) inside `viewport` {vw, vh}. side 'bottom' flips above when it does not fit below; 'top' flips
  // below. align 'end' right-aligns with the anchor (the Export menu), 'start' left-aligns, 'center'
  // centres (tooltips). Left is clamped to `pad` from both edges. The defaults reproduce the legacy
  // positionExportMenu() exactly.
  function place(anchor, size, viewport, opts = {}) {
    const { side = 'bottom', align = 'end', gap = 6, pad = 8 } = opts;
    const { w, h } = size;
    const { vw, vh } = viewport;
    let left = align === 'start' ? anchor.left : align === 'center' ? anchor.left + (anchor.width - w) / 2 : anchor.right - w;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    let top;
    let used = side;
    if (side === 'top') {
      top = anchor.top - h - gap;
      if (top < pad) { used = 'bottom'; top = anchor.bottom + gap; }
    } else {
      top = anchor.bottom + gap;
      if (top + h + pad > vh) { used = 'top'; top = Math.max(pad, anchor.top - h - gap); }
    }
    return { left, top, side: used };
  }

  // Roving index for a list of `len` items (menus): arrows wrap, Home/End and PageUp/PageDown jump.
  // i = -1 means nothing is active yet. Returns -1 for an empty list.
  function moveIndex(len, i, key) {
    if (!len) return -1;
    switch (key) {
      case 'ArrowDown': return i < 0 ? 0 : (i + 1) % len;
      case 'ArrowUp': return i < 0 ? len - 1 : (i - 1 + len) % len;
      case 'Home': case 'PageUp': return 0;
      case 'End': case 'PageDown': return len - 1;
      default: return i;
    }
  }

  // Menu typeahead: printable keys typed within `timeout` ms build a prefix matched case-insensitively
  // against the start of each label; repeating one character cycles through the items it starts.
  function createTypeahead(timeout = 500) {
    let buf = '';
    let last = -Infinity;
    return function find(labels, current, ch, now) {
      buf = now - last > timeout ? ch : buf + ch;
      last = now;
      const q = buf.toLowerCase();
      const cycling = [...q].every(c => c === q[0]);
      const needle = cycling ? q[0] : q;
      const from = cycling ? current + 1 : Math.max(current, 0);
      for (let k = 0; k < labels.length; k++) {
        const j = (from + k) % labels.length;
        if (labels[j].trim().toLowerCase().startsWith(needle)) return j;
      }
      return -1;
    };
  }

  // Toasts (spec "Toasts"). At most `max` are visible; the rest wait in FIFO order, and a toast's clock
  // starts only when it is shown. Timed toasts expire after 5 s, or 10 s with an action. Errors are
  // sticky: they stay while there is room, and while a toast waits but an unheld timed toast is on screen
  // (it frees a slot within 10 s anyway). Only when a toast waits and every unheld visible toast is an
  // error does the oldest error that has been on screen for 5 s yield its slot. Hover or focus holds a
  // toast (pause): a held toast never expires and never yields, and resume gives it back its remaining
  // time (an error gets a fresh 5 s). A toast with a `key` updates the queued toast with that key in
  // place (same id, same position) and restarts its clock unless it is held. Every mutation takes `now`
  // and ends in settle(now), which restores the invariants below (checked after every step by the seeded
  // model test in ui.test.mjs). `now` is clamped to the latest value the queue has seen, so a clock that
  // steps backwards (NTP, a manual change) cannot strand a toast.
  //   I1 visible.length <= max.
  //   I2 if a toast waits, visible.length === max.
  //   I3 ids are unique and never reused; keys are unique across visible and pending.
  //   I4 visible ++ pending keeps its order, a new toast joins the end, and nothing returns to pending.
  //   I5 a held toast leaves only through dismiss().
  //   I6 nothing is overdue: every unheld timed toast expires after now and, while a toast waits and every
  //      unheld visible toast is an error, every unheld error yields after now, so nextDeadline(now) > 0.
  //   I7 no stuck queue: while a toast waits, nextDeadline(now) is finite unless every visible toast is held.
  //   I8 a toast leaves visible only through dismiss() or after at least 5 s on screen: every promoted
  //      toast is still visible when the call that promoted it returns (the DOM shows and announces it
  //      exactly once), and a waiting toast leaves pending only by being shown or dismissed.
  //   I9 an error yields only to a waiting toast, which takes the freed slot in the same call, and only
  //      while a toast waits and every unheld visible toast is an error.
  const TOAST_MS = 5000;
  const TOAST_ACTION_MS = 10000;
  const TOAST_YIELD_MS = TOAST_MS;
  function toastTimeout(spec) { return spec.kind === 'error' ? Infinity : spec.action ? TOAST_ACTION_MS : TOAST_MS; }
  function createToastQueue({ max = 3 } = {}) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('createToastQueue: max must be an integer >= 1');
    let seq = 0;
    const visible = [];   // on screen, oldest first: { id, spec, remaining, startedAt, paused }
    const pending = [];   // waiting, FIFO: never paused, clock not started
    const sticky = t => toastTimeout(t.spec) === Infinity;
    const find = id => visible.find(t => t.id === id) || pending.find(t => t.id === id);
    const timedRuns = () => visible.some(t => !t.paused && !sticky(t));   // an unheld timed toast will free a slot
    let last = -Infinity;
    const clock = now => { last = Math.max(last, now); return last; };   // never earlier than a time already seen

    // The one place a toast leaves the queue other than dismiss(). Returns the removed ids, in order.
    function settle(now) {
      const removed = [];
      for (let i = 0; i < visible.length;) {
        const t = visible[i];
        if (!t.paused && !sticky(t) && now - t.startedAt >= t.remaining) { visible.splice(i, 1); removed.push(t.id); }
        else i += 1;
      }
      for (;;) {
        while (visible.length < max && pending.length) {
          const t = pending.shift();
          t.startedAt = now;
          visible.push(t);
        }
        if (!pending.length) return removed;
        // Full and a toast waits. An unheld timed toast frees a slot within 10 s, so errors stay. Otherwise
        // the oldest unheld error on screen for TOAST_YIELD_MS gives up its slot. A toast promoted just
        // above has now - startedAt === 0, so it never yields in the same call.
        if (timedRuns()) return removed;
        const i = visible.findIndex(t => !t.paused && sticky(t) && now - t.startedAt >= TOAST_YIELD_MS);
        if (i < 0) return removed;
        removed.push(visible.splice(i, 1)[0].id);
      }
    }

    return {
      add(spec, now) {
        now = clock(now);
        let t = spec.key == null ? null : visible.find(x => x.spec.key === spec.key) || pending.find(x => x.spec.key === spec.key);
        if (t) {
          // Keyed replace: same id, same place. A held toast stays held with the full new time, which
          // starts on resume; otherwise the clock restarts now (a waiting toast's when it is shown).
          t.spec = spec;
          t.remaining = toastTimeout(spec);
          if (!t.paused) t.startedAt = now;
        } else {
          seq += 1;
          t = { id: seq, spec, remaining: toastTimeout(spec), startedAt: now, paused: false };
          pending.push(t);
        }
        settle(now);
        return t.id;
      },
      dismiss(id, now) {
        now = clock(now);
        let hit = false;
        for (const list of [visible, pending]) {
          const i = list.findIndex(t => t.id === id);
          if (i >= 0) { list.splice(i, 1); hit = true; break; }
        }
        settle(now);
        return hit;
      },
      pause(id, now) {
        now = clock(now);
        const t = visible.find(x => x.id === id);
        if (t && !t.paused) { t.remaining -= now - t.startedAt; t.paused = true; }
        settle(now);
      },
      resume(id, now) {
        now = clock(now);
        const t = visible.find(x => x.id === id);
        if (t && t.paused) { t.startedAt = now; t.paused = false; }
        settle(now);
      },
      // Time passed: expire what ran out, show what waits, let overdue errors yield. The DOM calls it when
      // its nextDeadline() timer fires. Returns the ids that left; the DOM reconciles from visible().
      tick: now => settle(clock(now)),
      // ms until a tick() would change something (<= 0: overdue); Infinity when no clock is running.
      nextDeadline(now) {
        now = clock(now);
        const errorsYield = pending.length > 0 && !timedRuns();
        let d = Infinity;
        for (const t of visible) {
          if (t.paused) continue;
          const span = sticky(t) ? (errorsYield ? TOAST_YIELD_MS : Infinity) : t.remaining;
          d = Math.min(d, t.startedAt + span - now);
        }
        return d;
      },
      visible: () => visible.map(t => t.id),
      pending: () => pending.map(t => t.id),
      get: id => { const t = find(id); return t ? t.spec : null; },
    };
  }

  // Live-region throttle: at most one announcement per `interval` ms; while throttled the newest text
  // waits and is spoken when the window ends (older waiting texts are dropped).
  function createThrottle(interval = 5000) {
    let lastAt = -Infinity;
    let queued = null;
    return {
      push(text, now) {
        if (now - lastAt >= interval) { lastAt = now; queued = null; return text; }
        queued = text;
        return null;
      },
      wait: now => (queued === null ? Infinity : Math.max(0, lastAt + interval - now)),
      flush(now) {
        if (queued === null || now - lastAt < interval) return null;
        const t = queued;
        queued = null;
        lastAt = now;
        return t;
      },
    };
  }

  // Focus trap step for Tab in a modal: the index to focus instead of the browser's default, -1 to let
  // the browser move focus (it stays inside), -2 when nothing inside is focusable (focus the panel).
  function trapTarget(len, i, shift) {
    if (!len) return -2;
    if (i < 0) return shift ? len - 1 : 0;
    if (shift && i === 0) return len - 1;
    if (!shift && i === len - 1) return 0;
    return -1;
  }

  // ---- DOM ----
  // createUi({ doc, win, dom, keys, now }) → ALV.ui. At creation it only adds three listeners (outside
  // press, resize) and the dialog Mod+Enter binding; each primitive touches the DOM when it is created.
  const KIND_ICON = { success: 'check', info: 'info', error: 'circle-alert' };
  const TIP_DELAY_MS = 400;
  const TIP_GRACE_MS = 100;
  const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
  const ROVING_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'];

  function createUi({ doc, win, dom, keys, now = () => win.performance.now() }) {
    let openPopup = null;   // the one open menu or popover
    let activeTip = null;   // the one visible tooltip
    const dialogs = [];     // open dialogs, oldest first
    const isShown = el => !!el && el.isConnected !== false && el.getClientRects().length > 0;
    const hideTip = () => { if (activeTip) activeTip.hide(); };
    function position(anchor, surface, opts) {
      const vp = { vw: doc.documentElement.clientWidth, vh: doc.documentElement.clientHeight };
      const p = place(anchor.getBoundingClientRect(), { w: surface.offsetWidth, h: surface.offsetHeight }, vp, opts);
      surface.style.left = `${p.left}px`;
      surface.style.top = `${p.top}px`;
    }

    // Light dismiss: a press outside the open surface and its trigger closes it and leaves focus where the
    // press put it. Capture phase, so a handler that stops propagation cannot keep a stale menu open.
    doc.addEventListener('pointerdown', e => {
      if (openPopup && !openPopup.owns(e.target)) openPopup.close({ restoreFocus: false });
    }, true);
    // Layout is read on open and on resize only (as the legacy Export menu did): no scroll listeners.
    win.addEventListener('resize', () => { hideTip(); if (openPopup) openPopup.reposition(); });

    // Open/close plumbing shared by menus and popovers. `focusIn(o)` moves focus into the surface.
    function popup(trigger, surface, opts, focusIn) {
      const placement = { side: opts.side || 'bottom', align: opts.align || 'end', gap: 6, pad: 8 };
      let popEsc = null;
      let returnTo = null;   // open({ returnFocus }): where a shortcut opener had focus
      const ctl = {
        trigger,
        isOpen: () => !surface.hidden,
        inSurface: node => surface.contains(node),
        owns: node => surface.contains(node) || trigger.contains(node),
        reposition() { if (ctl.isOpen()) position(trigger, surface, placement); },
        open(o = {}) {
          if (!ctl.isOpen()) {
            if (openPopup) openPopup.close({ restoreFocus: false });
            hideTip();
            if (opts.onOpen) opts.onOpen();
            surface.hidden = false;
            position(trigger, surface, placement);
            trigger.setAttribute('aria-expanded', 'true');
            openPopup = ctl;
            returnTo = o.returnFocus || null;
            popEsc = keys.pushEsc(() => ctl.close(), 'menu');
          }
          focusIn(o);
        },
        // Focus goes back (Esc, choosing an item) to `returnFocus` when a shortcut opened the surface and
        // that element is still shown, else to the trigger (APG: the menu button that opened it). Nothing
        // moves when restoreFocus is false (outside press, Tab) or the target is no longer shown.
        close({ restoreFocus = true } = {}) {
          if (!ctl.isOpen()) return;
          surface.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
          if (openPopup === ctl) openPopup = null;
          if (popEsc) { popEsc(); popEsc = null; }
          const back = returnTo && returnTo !== doc.body && isShown(returnTo) && !surface.contains(returnTo) ? returnTo : trigger;
          returnTo = null;
          if (restoreFocus && isShown(back)) back.focus();
          if (opts.onClose) opts.onClose();
        },
        toggle(o) { if (ctl.isOpen()) ctl.close(); else ctl.open(o); },
      };
      return ctl;
    }

    // Menu button (WAI-ARIA APG): `surface` is the positioned box in the popover layer; it is, or contains,
    // the role="menu" element. Items are real focus targets with tabindex="-1". A menuitem runs and closes;
    // menuitemradio / menuitemcheckbox items update aria-checked and keep the menu open.
    function menu(trigger, surface, opts = {}) {
      const list = surface.getAttribute('role') === 'menu' ? surface : surface.querySelector('[role="menu"]');
      if (!list.id) list.id = dom.uid('menu');
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', list.id);
      const items = () => Array.from(list.querySelectorAll(MENU_ITEMS)).filter(it => !it.hidden);
      const typeahead = createTypeahead(500);
      const ctl = popup(trigger, surface, opts, ({ focus = 'first' } = {}) => {
        const all = items();
        if (focus === 'none' || !all.length) return;
        all[focus === 'last' ? all.length - 1 : 0].focus();
      });
      trigger.addEventListener('click', () => ctl.toggle({ focus: 'first' }));
      trigger.addEventListener('keydown', e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        ctl.open({ focus: e.key === 'ArrowUp' ? 'last' : 'first' });
      });
      list.addEventListener('keydown', e => {
        const all = items();
        const at = all.indexOf(doc.activeElement);
        if (e.key === 'Tab') {
          // Leave as if the menu sat next to its trigger: focus the trigger now, and the browser's own
          // Tab / Shift+Tab then moves on from there.
          trigger.focus();
          ctl.close({ restoreFocus: false });
        } else if (ROVING_KEYS.includes(e.key)) {
          e.preventDefault();
          const next = all[moveIndex(all.length, at, e.key)];
          if (next) next.focus();
        } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const j = typeahead(all.map(it => it.textContent), at, e.key, now());
          if (j >= 0) { e.preventDefault(); all[j].focus(); }
        }
      });
      list.addEventListener('pointermove', e => {
        const it = e.target.closest(MENU_ITEMS);
        if (it && list.contains(it) && doc.activeElement !== it) it.focus({ preventScroll: true });
      });
      // Activation is the item's click: Enter and Space on a <button> click it, and so does a pointer.
      list.addEventListener('click', e => {
        const it = e.target.closest(MENU_ITEMS);
        if (!it || !list.contains(it) || it.getAttribute('aria-disabled') === 'true') return;
        const role = it.getAttribute('role');
        if (role === 'menuitemradio') {
          const group = it.closest('[role="group"]') || list;
          for (const r of group.querySelectorAll('[role="menuitemradio"]')) r.setAttribute('aria-checked', r === it ? 'true' : 'false');
        } else if (role === 'menuitemcheckbox') {
          it.setAttribute('aria-checked', it.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
        }
        if (opts.onSelect) opts.onSelect(it);
        if (role === 'menuitem') ctl.close();
      });
      return ctl;
    }

    // Non-modal popover (P4's drops popover): role="dialog" without aria-modal, light dismiss, no trap.
    function popover(trigger, panel, opts = {}) {
      if (!panel.id) panel.id = dom.uid('pop');
      if (!panel.getAttribute('role')) panel.setAttribute('role', 'dialog');
      if (!panel.getAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-controls', panel.id);
      const ctl = popup(trigger, panel, opts, () => {
        ((opts.initialFocus && panel.querySelector(opts.initialFocus)) || dom.focusables(panel)[0] || panel).focus();
      });
      trigger.addEventListener('click', () => ctl.toggle());
      panel.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return;
        const f = dom.focusables(panel);
        const at = f.indexOf(doc.activeElement);
        if (e.shiftKey ? at <= 0 : at === f.length - 1) {
          if (e.shiftKey) e.preventDefault();   // Shift+Tab out of the first control lands on the trigger
          trigger.focus();
          ctl.close({ restoreFocus: false });
        }
      });
      return ctl;
    }

    // Tooltip (spec Open item 1): a real role="tooltip" element in the tip layer, referenced from the
    // trigger's aria-describedby from the start. 400 ms after the pointer enters, at once on keyboard focus;
    // stays while the pointer is on it (100 ms grace); Esc hides it until the pointer leaves or focus moves.
    // `shortcut` is a binding id: the kbd shows its current label (⌘E / Ctrl+E). Text only, no controls.
    function tooltip(trigger, { text = '', shortcut = null } = {}) {
      const label = dom.el('span', { text });
      const kbd = dom.el('span', { class: 'kbd', hidden: true });
      const tip = dom.portal(dom.el('div', { class: 'tooltip ov', role: 'tooltip', id: dom.uid('tip'), hidden: true }, label, kbd), 'tip');
      const prior = (trigger.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      trigger.setAttribute('aria-describedby', prior.concat(tip.id).join(' '));
      let showTimer = 0;
      let hideTimer = 0;
      let popEsc = null;
      let suppressed = false;
      const clearTimers = () => { win.clearTimeout(showTimer); win.clearTimeout(hideTimer); };
      function render() {
        label.textContent = text;
        const k = shortcut ? keys.label(shortcut) : '';
        kbd.textContent = k;
        kbd.hidden = !k;
      }
      function show() {
        clearTimers();
        if (suppressed || trigger.getAttribute('aria-expanded') === 'true' || !isShown(trigger)) return;
        if (activeTip && activeTip !== api) activeTip.hide();
        render();
        tip.hidden = false;
        position(trigger, tip, { side: 'bottom', align: 'center', gap: 6, pad: 8 });
        activeTip = api;
        if (!popEsc) popEsc = keys.pushEsc(() => { suppressed = true; hide(); }, 'tooltip');
      }
      function hide() {
        clearTimers();
        tip.hidden = true;
        if (popEsc) { popEsc(); popEsc = null; }
        if (activeTip === api) activeTip = null;
      }
      const hideSoon = () => { win.clearTimeout(hideTimer); hideTimer = win.setTimeout(hide, TIP_GRACE_MS); };
      const keyboardFocus = () => { try { return trigger.matches(':focus-visible'); } catch (_) { return true; } };
      const on = {
        pointerenter: e => {
          if (e.pointerType === 'touch') return;
          win.clearTimeout(hideTimer);
          if (tip.hidden) { win.clearTimeout(showTimer); showTimer = win.setTimeout(show, TIP_DELAY_MS); }
        },
        pointerleave: () => { suppressed = false; win.clearTimeout(showTimer); if (!tip.hidden) hideSoon(); },
        focus: () => { if (keyboardFocus()) show(); },
        blur: () => { suppressed = false; hide(); },
        pointerdown: () => hide(),
        click: () => hide(),
      };
      for (const [type, fn] of Object.entries(on)) trigger.addEventListener(type, fn);
      tip.addEventListener('pointerenter', () => win.clearTimeout(hideTimer));
      tip.addEventListener('pointerleave', hideSoon);
      const api = {
        hide,
        setText(s) { text = String(s); render(); },
        // Call when the trigger goes away; tooltips are not garbage-collected with it.
        destroy() {
          hide();
          for (const [type, fn] of Object.entries(on)) trigger.removeEventListener(type, fn);
          tip.remove();
          const rest = (trigger.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
          if (rest.length) trigger.setAttribute('aria-describedby', rest.join(' '));
          else trigger.removeAttribute('aria-describedby');
        },
      };
      render();
      return api;
    }

    // Toasts (spec "Toasts"): #toastLive is the persistent polite live region; errors go to #toastAlerts
    // with role="alert" (not nested in the polite region, so they are announced once). Text via
    // textContent only. Toasts never take focus. spec: { kind: 'success'|'info'|'error', title, desc?,
    // icon? (sprite name; default by kind), action? { label, run }, key? }.
    // The queue decides everything; this side mirrors queue.visible() and nothing else. A node is built
    // once, when its id first appears (so it is announced once); a keyed replace refills that same node
    // (so its hover/focus hold stays true); and the node goes when its id leaves the queue for any
    // reason (dismissed, expired, or an error that yielded its slot to a waiting toast).
    const queue = createToastQueue({ max: 3 });
    const shown = new Map();   // id -> { node, spec, refs }
    const toastRegion = kind => doc.getElementById(kind === 'error' ? 'toastAlerts' : 'toastLive');
    const inToasts = n => !!n && (toastRegion('error').contains(n) || toastRegion('info').contains(n));
    let beforeToasts = null;   // the control that had focus before focus entered a toast (where Dismiss goes back to)
    // A toast that holds focus is about to leave: put focus on the same control (action, else Dismiss) of
    // the next toast, else the previous one, else back where it was before the toasts. Without this a
    // removed node drops focus to <body>, and the next Tab starts from the top of the page.
    function handOffFocus(id, leaving) {
      const active = doc.activeElement;
      if (!active || !leaving.node.contains(active)) return;
      const ids = Array.from(shown.keys());
      const stay = ids.filter(k => k !== id && queue.visible().includes(k));
      const at = ids.indexOf(id);
      const target = stay.find(k => ids.indexOf(k) > at) || stay.filter(k => ids.indexOf(k) < at).pop();
      if (target !== undefined) {
        const refs = shown.get(target).refs;
        (active === leaving.refs.action && !refs.action.hidden ? refs.action : refs.dismiss).focus();
      } else if (beforeToasts && !inToasts(beforeToasts) && isShown(beforeToasts)) {
        beforeToasts.focus();
      }
    }
    let toastTimer = 0;
    let syncing = 0;   // 1 while syncing; 2 when an event fired during the sync asked for another pass
    function syncToasts() {
      if (syncing) { syncing = 2; return; }
      try {
        do {
          syncing = 1;
          const t = now();
          queue.tick(t);
          const vis = queue.visible();
          for (const [id, s] of Array.from(shown)) if (!vis.includes(id)) { handOffFocus(id, s); shown.delete(id); s.node.remove(); }
          for (const id of vis) {
            const spec = queue.get(id);
            const s = shown.get(id);
            if (!s) { const made = buildToast(id, spec); shown.set(id, made); toastRegion(spec.kind).appendChild(made.node); }
            else if (s.spec !== spec) fillToast(s, spec);
          }
          win.clearTimeout(toastTimer);
          const wait = queue.nextDeadline(t);
          toastTimer = wait === Infinity ? 0 : win.setTimeout(syncToasts, Math.max(0, wait));
        } while (syncing === 2);
      } finally {
        syncing = 0;
      }
    }
    function dismissToast(id) { queue.dismiss(id, now()); syncToasts(); }
    // A fixed skeleton that fillToast writes into, so a keyed replace never swaps the node, its buttons or
    // its listeners (a focused button keeps focus, and the hold flags below stay true). The action button
    // always exists and is hidden when there is no action; that relies on base.css giving [hidden] back to
    // .btn (the foundation's .btn sets display, which beats the UA [hidden] rule).
    function buildToast(id, spec) {
      let pointer = false;
      let focused = false;
      const hold = () => {
        if (!shown.has(id)) return;   // removed: its hold left the queue with it
        if (pointer || focused) queue.pause(id, now()); else queue.resume(id, now());
        syncToasts();
      };
      const refs = {
        icon: dom.icon('info'),
        title: dom.el('div', { class: 'toast-title' }),
        desc: dom.el('div', { class: 'toast-desc' }),
        action: dom.el('button', { type: 'button', class: 'btn btn-sm', on: { click: () => {
          const spec = queue.get(id);   // the current spec: a keyed replace may have changed the action
          dismissToast(id);
          if (spec && spec.action) spec.action.run();
        } } }),
        dismiss: dom.el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Dismiss notification', on: { click: () => dismissToast(id) } }, dom.icon('x')),
      };
      const node = dom.el('div', {
        on: {
          pointerenter: () => { pointer = true; hold(); },
          pointerleave: () => { pointer = false; hold(); },
          focusin: e => { if (e.relatedTarget && !inToasts(e.relatedTarget)) beforeToasts = e.relatedTarget; focused = true; hold(); },
          focusout: e => { if (!e.currentTarget.contains(e.relatedTarget)) { focused = false; hold(); } },
        },
      },
      refs.icon,
      dom.el('div', { class: 'toast-body' }, refs.title, refs.desc),
      refs.action,
      refs.dismiss);
      const made = { node, spec: null, refs };
      fillToast(made, spec);
      return made;
    }
    function fillToast(s, spec) {
      const kind = KIND_ICON[spec.kind] ? spec.kind : 'info';
      const { node, refs } = s;
      node.className = `toast toast-${kind}`;
      if (kind === 'error') node.setAttribute('role', 'alert'); else node.removeAttribute('role');
      refs.icon.children[0].setAttribute('href', `#i-${spec.icon || KIND_ICON[kind]}`);
      refs.title.textContent = spec.title;
      refs.desc.textContent = spec.desc || '';
      refs.desc.hidden = !spec.desc;
      refs.action.textContent = spec.action ? spec.action.label : '';
      refs.action.hidden = !spec.action;
      // A keyed replace across error / non-error moves the node to the other region; moving a node drops
      // focus in browsers, so focus goes back to the same control.
      const region = toastRegion(spec.kind);
      if (s.spec && toastRegion(s.spec.kind) !== region) {
        const active = doc.activeElement;
        region.appendChild(node);
        if (active && node.contains(active) && doc.activeElement !== active) active.focus();
      }
      s.spec = spec;
    }
    function toast(spec) {
      const id = queue.add(spec, now());
      syncToasts();
      return { id, dismiss: () => dismissToast(id) };
    }

    // Polite announcements (#announcer): at most one per 5 s, the newest waiting text wins (spec
    // "Announcements"; P5/P6 call it for result counts and stalls).
    const throttle = createThrottle(5000);
    let announceTimer = 0;
    const speak = text => { doc.getElementById('announcer').textContent = text; };
    function flushAnnounce() {
      const text = throttle.flush(now());
      if (text !== null) speak(text);
      else if (throttle.wait(now()) !== Infinity) announceTimer = win.setTimeout(flushAnnounce, throttle.wait(now()) + 1);
    }
    function announce(text) {
      const t = now();
      const out = throttle.push(String(text), t);
      if (out !== null) { speak(out); return; }
      win.clearTimeout(announceTimer);
      announceTimer = win.setTimeout(flushAnnounce, throttle.wait(t));
    }

    // Modal dialog: role="dialog" over a scrim. Everything else is inert (body children except
    // #overlayRoot, and lower dialogs; the popover and tip layers stay live for menus in the dialog), which
    // already takes the page out of the accessibility tree. aria-modal is NOT set: browsers then drop
    // everything outside the panel from that tree, including #toastRegion and #announcer (siblings of the
    // dialog layer in #overlayRoot), so a toast or announcement made while a dialog is open would never be
    // spoken. Tab and Shift+Tab wrap inside;
    // Esc closes when dismissible; Mod+Enter clicks [data-primary]; focus returns to the opener, or to
    // `returnFocus` when the opener is gone. Hand-rolled: <dialog>.showModal() puts the dialog in the top
    // layer, above the toasts, and the Popover API needs Safari 17.
    keys.register({
      id: 'dialog.primary', keys: 'Mod+Enter', scope: 'dialog', inText: true,
      run: () => {
        const top = dialogs[dialogs.length - 1];
        const b = top && top.panel.querySelector('[data-primary]');
        if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
      },
    });
    function dialog(panel, opts = {}) {
      const { label, labelledBy, describedBy, initialFocus, returnFocus = null, dismissible = true, dismissOnScrim = true, escLevel = 'sheet', onClose } = opts;
      panel.setAttribute('role', 'dialog');
      if (label) panel.setAttribute('aria-label', label);
      if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);
      if (describedBy) panel.setAttribute('aria-describedby', describedBy);
      if (!panel.getAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      const scrim = dom.el('div', { class: 'scrim' });
      const host = dom.portal(dom.el('div', { class: 'dialog-host', hidden: true }, scrim, panel), 'dialog');
      let opener = null;
      let popEsc = null;
      let inerted = [];
      panel.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return;
        const f = dom.focusables(panel);
        const step = trapTarget(f.length, f.indexOf(doc.activeElement), e.shiftKey);
        if (step === -1) return;
        e.preventDefault();
        (step === -2 ? panel : f[step]).focus();
      });
      scrim.addEventListener('click', () => { if (dismissible && dismissOnScrim) ctl.close('scrim'); });
      const ctl = {
        el: panel,
        isOpen: () => !host.hidden,
        open(from) {
          if (ctl.isOpen()) return;
          // A dialog opened from a menu item comes back to the menu button: the item is hidden by then.
          opener = from || doc.activeElement;
          if (openPopup && openPopup.inSurface(opener)) opener = openPopup.trigger;
          if (openPopup) openPopup.close({ restoreFocus: false });
          hideTip();
          const root = doc.getElementById('overlayRoot');
          // The popover and tip layers stay live: a menu, popover or tooltip opened from a control inside
          // the dialog must work. Anything open now was just closed above.
          inerted = Array.from(doc.body.children).filter(el => el !== root)
            .concat(dialogs.map(d => d.host))
            .filter(el => el && !el.inert);
          for (const el of inerted) el.inert = true;
          host.hidden = false;
          dialogs.push({ ctl, host, panel });
          keys.setModal(panel);
          popEsc = keys.pushEsc(() => { if (dismissible) ctl.close('esc'); }, escLevel);   // P6 stall sheet: 'stall', P9 palette: 'palette'
          ((initialFocus && panel.querySelector(initialFocus)) || panel.querySelector('[data-autofocus]') || dom.focusables(panel)[0] || panel).focus();
        },
        close(reason = 'close') {
          if (!ctl.isOpen()) return;
          host.hidden = true;
          for (const el of inerted) el.inert = false;
          inerted = [];
          const k = dialogs.findIndex(d => d.ctl === ctl);
          if (k >= 0) dialogs.splice(k, 1);
          keys.setModal(dialogs.length ? dialogs[dialogs.length - 1].panel : null);
          if (popEsc) { popEsc(); popEsc = null; }
          const back = opener && isShown(opener) ? opener : returnFocus;
          opener = null;
          if (back) back.focus();
          if (onClose) onClose(reason);
        },
      };
      return ctl;
    }

    return { menu, popover, tooltip, toast, announce, dialog };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.uiPure = Object.freeze({ place, moveIndex, createTypeahead, createToastQueue, createThrottle, trapTarget, toastTimeout });
  ALV.createUi = createUi;
  if (typeof document !== 'undefined' && document.documentElement && ALV.dom && ALV.keys) {
    ALV.ui = createUi({ doc: document, win: g, dom: ALV.dom, keys: ALV.keys });
  }
})(typeof window !== 'undefined' ? window : globalThis);
