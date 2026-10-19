/* AppLogsViewer settings store, localStorage migration and pre-paint boot.
   Classic script. viewer/applogs-viewer.html loads it synchronously in <head>, before any
   stylesheet, so <html> carries its final data-* attributes before first paint.
   Every storage access is wrapped on its own: a WebView with storage blocked still renders.

   Keys (prefix "applogs-viewer."):
     theme        'dark' | 'light' | 'system'   absent or unknown = 'dark'
     logFontSize  10..20, default 13             8 and 9 (old minimum) clamp to 10, garbage = 13
     material     'solid' | 'glass'              absent: migrated once from glassMode ('on' = glass)
     glassMode    'on' | 'off'                   legacy; mirrored on every material write (downgrade)
     uiSize       's' | 'm' | 'l'                default 'm'
     sidebar      'expanded' | 'collapsed'       default 'expanded' (P4: ⌘B collapses it to the rail)
     settings     JSON object (font, density, contrast, motion, iosQuiet here; later PRs add fields).
                  Corrupt JSON reads as defaults and is not written back until the user changes
                  a setting. Unknown fields are preserved.
   Reserved for later PRs: presets (P7), onboarded (P15). */
(function (g) {
  'use strict';

  const NS = 'applogs-viewer.';
  const LOG_FS = Object.freeze({ min: 10, max: 20, def: 13 });
  const THEME_CYCLE = Object.freeze(['dark', 'light', 'system']);
  const SETTINGS_SCHEMA = Object.freeze({
    font: Object.freeze(['default', 'hyper']),
    density: Object.freeze(['comfortable', 'compact']),
    contrast: Object.freeze(['system', 'more', 'off']),
    motion: Object.freeze(['system', 'reduce', 'off']),
    iosQuiet: Object.freeze(['off', 'on']),   // Quiet system noise (shell.js, POST /ios/quiet); no root attribute
  });
  const DARK_QUERY = '(prefers-color-scheme: dark)';
  // Known limitation: WebKit (WKWebView, the only webview where glass applies) may not report
  // prefers-reduced-transparency. If matchMedia answers "not all", `matches` stays false and
  // Glass is not forced to Solid by macOS Reduce transparency; the Material control still works.
  // Honoured only where the WebView reports it (spec, Glass gating). Unverified in the real app.
  const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';

  // ---- Pure helpers (no storage, no DOM) ----
  function parseTheme(raw) { return THEME_CYCLE.includes(raw) ? raw : 'dark'; }
  function resolveTheme(pref, osPrefersDark) {
    if (pref === 'system') return osPrefersDark ? 'dark' : 'light';
    return pref === 'light' ? 'light' : 'dark';
  }
  function nextTheme(pref) { return THEME_CYCLE[(THEME_CYCLE.indexOf(parseTheme(pref)) + 1) % THEME_CYCLE.length]; }
  function clampLogFs(raw) {
    const n = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(n)) return LOG_FS.def;
    return Math.min(LOG_FS.max, Math.max(LOG_FS.min, Math.round(n)));
  }
  function parseMaterial(materialRaw, glassModeRaw) {
    if (materialRaw === 'solid' || materialRaw === 'glass') return materialRaw;
    return glassModeRaw === 'on' ? 'glass' : 'solid';
  }
  function resolveMaterial(pref, platform, reducedTransparency) {
    return pref === 'glass' && platform === 'mac' && !reducedTransparency ? 'glass' : 'solid';
  }
  function parseUiSize(raw) { return raw === 's' || raw === 'l' ? raw : 'm'; }
  function parseSidebar(raw) { return raw === 'collapsed' ? 'collapsed' : 'expanded'; }
  function platformOf(userAgent) { return /Mac OS X/i.test(userAgent || '') ? 'mac' : 'other'; }
  function defaultSettings() {
    const out = {};
    for (const k of Object.keys(SETTINGS_SCHEMA)) out[k] = SETTINGS_SCHEMA[k][0];
    return out;
  }
  // -> { value: complete settings, raw: stored object that writes merge into, corrupt: boolean }
  function parseSettings(rawText) {
    const value = defaultSettings();
    if (rawText === null || rawText === undefined || rawText === '') return { value, raw: {}, corrupt: false };
    let raw;
    try { raw = JSON.parse(rawText); } catch (_) { return { value, raw: {}, corrupt: true }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value, raw: {}, corrupt: true };
    for (const k of Object.keys(SETTINGS_SCHEMA)) if (SETTINGS_SCHEMA[k].includes(raw[k])) value[k] = raw[k];
    return { value, raw, corrupt: false };
  }

  // ---- Storage wrapper: one try/catch per access ----
  function wrapStorage(storage) {
    return {
      get(key) { try { return storage ? storage.getItem(NS + key) : null; } catch (_) { return null; } },
      set(key, value) { try { if (storage) storage.setItem(NS + key, String(value)); } catch (_) { /* blocked: memory only */ } },
    };
  }

  // env: { storage: Storage-like or null, matchMedia: function or null, userAgent: string }
  function createPrefs(env) {
    const store = wrapStorage(env.storage);
    const mq = q => { try { return env.matchMedia ? env.matchMedia(q) : null; } catch (_) { return null; } };
    const platform = platformOf(env.userAgent);
    const darkMq = mq(DARK_QUERY);
    const transparencyMq = mq(REDUCED_TRANSPARENCY_QUERY);
    const listeners = [];
    let rootEl = null;

    // In-memory copy of every value, so a blocked storage still gives a working session.
    const prefs = {
      theme: parseTheme(store.get('theme')),
      logFontSize: clampLogFs(store.get('logFontSize')),
      material: parseMaterial(store.get('material'), store.get('glassMode')),
      uiSize: parseUiSize(store.get('uiSize')),
      sidebar: parseSidebar(store.get('sidebar')),
    };
    let settings = parseSettings(store.get('settings'));

    function state() {
      return {
        theme: prefs.theme,
        themeResolved: resolveTheme(prefs.theme, darkMq ? darkMq.matches : true),
        material: prefs.material,
        materialEffective: resolveMaterial(prefs.material, platform, transparencyMq ? transparencyMq.matches : false),
        logFontSize: prefs.logFontSize,
        uiSize: prefs.uiSize,
        sidebar: prefs.sidebar,
        platform,
        settings: Object.assign({}, settings.value),
      };
    }

    function apply() {
      const s = state();
      if (rootEl) {
        rootEl.setAttribute('data-theme', s.themeResolved);
        rootEl.setAttribute('data-material', s.materialEffective);
        rootEl.setAttribute('data-ui', s.uiSize);
        rootEl.setAttribute('data-sidebar', s.sidebar);
        rootEl.setAttribute('data-platform', s.platform);
        rootEl.setAttribute('data-font', s.settings.font);
        rootEl.setAttribute('data-density', s.settings.density);
        rootEl.setAttribute('data-contrast', s.settings.contrast);
        rootEl.setAttribute('data-motion', s.settings.motion);
        // The legacy glass CSS keys off data-glass until P4 deletes it.
        rootEl.setAttribute('data-glass', s.materialEffective === 'glass' ? 'on' : 'off');
        rootEl.style.setProperty('--log-fs', s.logFontSize + 'px');
      }
      for (const fn of listeners.slice()) {
        try { fn(s); } catch (e) { if (g.console) g.console.error('prefs listener', e); }
      }
      return s;
    }

    function listen(list, fn) {
      if (!list) return;
      if (typeof list.addEventListener === 'function') list.addEventListener('change', fn);
      else if (typeof list.addListener === 'function') list.addListener(fn);   // WebKit before Safari 14
    }

    const VALIDATE = {
      theme(v) { if (!THEME_CYCLE.includes(v)) throw new RangeError('theme must be dark, light or system'); return v; },
      logFontSize(v) { if (!Number.isFinite(Number(v))) throw new RangeError('logFontSize must be a number'); return clampLogFs(Number(v)); },
      material(v) { if (v !== 'solid' && v !== 'glass') throw new RangeError('material must be solid or glass'); return v; },
      uiSize(v) { if (v !== 's' && v !== 'm' && v !== 'l') throw new RangeError('uiSize must be s, m or l'); return v; },
      sidebar(v) { if (v !== 'expanded' && v !== 'collapsed') throw new RangeError('sidebar must be expanded or collapsed'); return v; },
    };

    return {
      LOG_FS,
      nextTheme,
      get(name) {
        if (!Object.prototype.hasOwnProperty.call(prefs, name)) throw new TypeError('unknown pref ' + name);
        return prefs[name];
      },
      set(name, value) {
        if (!Object.prototype.hasOwnProperty.call(VALIDATE, name)) throw new TypeError('unknown pref ' + name);
        const v = VALIDATE[name](value);
        prefs[name] = v;
        store.set(name, v);
        if (name === 'material') store.set('glassMode', v === 'glass' ? 'on' : 'off');   // pre-redesign builds read glassMode
        return apply();
      },
      getSettings() { return Object.assign({}, settings.value); },
      patchSettings(patch) {
        const next = Object.assign({}, settings.value);
        for (const k of Object.keys(patch || {})) {
          if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, k)) throw new TypeError('unknown setting ' + k);
          if (!SETTINGS_SCHEMA[k].includes(patch[k])) throw new RangeError(k + ' must be one of ' + SETTINGS_SCHEMA[k].join(', '));
          next[k] = patch[k];
        }
        const raw = Object.assign({}, settings.raw, next);
        settings = { value: next, raw, corrupt: false };
        store.set('settings', JSON.stringify(raw));
        return apply().settings;
      },
      state,
      onChange(fn) {
        listeners.push(fn);
        return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      },
      // Migrates once, writes every root attribute, then follows OS theme and transparency changes.
      boot(el) {
        rootEl = el;
        const storedMaterial = store.get('material');
        if (storedMaterial !== 'solid' && storedMaterial !== 'glass') store.set('material', prefs.material);
        listen(darkMq, () => { if (prefs.theme === 'system') apply(); });
        listen(transparencyMq, () => { if (prefs.material === 'glass') apply(); });
        return apply();
      },
    };
  }

  const ALV = g.ALV || (g.ALV = {});
  ALV.createPrefs = createPrefs;
  ALV.prefsPure = Object.freeze({
    LOG_FS, SETTINGS_SCHEMA, parseTheme, resolveTheme, nextTheme, clampLogFs, parseMaterial,
    resolveMaterial, parseUiSize, parseSidebar, platformOf, parseSettings,
  });

  // In the page: boot against <html> now (pre-paint). In tests (no document): do nothing.
  if (typeof document !== 'undefined' && document.documentElement) {
    let storage = null;
    try { storage = g.localStorage; } catch (_) { storage = null; }   // the getter itself can throw
    ALV.prefs = createPrefs({
      storage,
      matchMedia: typeof g.matchMedia === 'function' ? g.matchMedia.bind(g) : null,
      userAgent: (g.navigator && g.navigator.userAgent) || '',
    });
    ALV.prefs.boot(document.documentElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
