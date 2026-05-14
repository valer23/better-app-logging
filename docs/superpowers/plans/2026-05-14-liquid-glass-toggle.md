# Liquid Glass Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a topbar toggle that switches the AppLogsViewer chrome between the existing Classic look and a macOS-only Liquid Glass look (NSVisualEffectView `HudWindow` + CSS translucent surfaces).

**Architecture:** Tauri v2 `Window::set_effects()` is driven from a new `POST /window/glass-mode` route on the existing embedded axum server (preserves the "no Tauri IPC" pattern documented in `src-tauri/capabilities/default.json`). The frontend persists state in `localStorage`, toggles a `data-glass` attribute on `<html>`, and (on macOS only) POSTs the new state so the host applies/clears the vibrancy material. The window is permanently transparent with an overlayed hidden title bar so the toggle only swaps the material — no window recreation.

**Tech Stack:** Tauri v2, axum, vanilla HTML/CSS/JS, `backdrop-filter` (WebKit), NSVisualEffectView (via Tauri `Effect::HudWindow`).

**Decisions locked during brainstorm/grill:**
- macOS-only — toggle hidden on Windows/Linux builds
- Dynamic native toggle via `set_effects` (no window restart)
- Composes with existing light/dark theme switch (4 effective modes)
- Material: `HudWindow` + `FollowsWindowActiveState`
- Glass applies only to chrome (`#topbar`, `#filterbar`, `#liveBar`, `thead`, `.modal`, `.connect-card`, `.device-menu`) — log rows stay opaque for readability
- Toggle = two-state pill "Classic | Glass" right of the theme switch
- Default = Classic, state persisted in `localStorage`
- `titleBarStyle: Overlay` + `hiddenTitleBar: true` + permanent `transparent: true` on macOS; topbar gains 78px left padding for traffic lights
- Wiring: `POST /window/glass-mode` on axum (no new Tauri IPC permission)
- Verification: manual smoke on macOS + existing `cargo fmt/check/clippy` CI

**Why TDD is light here:** the repo has no JS test runner and Tauri runtime APIs (NSVisualEffectView) cannot be unit-tested off-runtime. The Rust route is verified with `cargo check`/`clippy` + a `curl` smoke; UI is verified by manual smoke (Q9 decision). Steps still use a tight write-test-or-smoke / run / commit cycle.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/tauri.macos.conf.json` | Modify | macOS-only window overrides: `transparent`, `titleBarStyle: Overlay`, `hiddenTitle: true`, initial `windowEffects: []` |
| `src-tauri/src/http_server.rs` | Modify | Carry `tauri::AppHandle` as axum state; add `POST /window/glass-mode` route that calls `Window::set_effects` / `clear_effects` |
| `src-tauri/src/lib.rs` | Modify | Pass `app.handle().clone()` into `http_server::serve()` |
| `viewer/applogs-viewer.html` | Modify | New CSS tokens + glass surface rules + toggle markup + JS state mgmt + `fetch('/window/glass-mode')` |
| `docs/superpowers/plans/2026-05-14-liquid-glass-toggle.md` | Create | This plan |

---

## Task 1: Tauri macOS window config — transparent + overlay title bar

**Files:**
- Modify: `src-tauri/tauri.macos.conf.json`

- [ ] **Step 1: Replace the macOS conf with window overrides**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "app": {
    "windows": [
      {
        "label": "main",
        "transparent": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "windowEffects": {
          "effects": [],
          "state": "followsWindowActiveState"
        }
      }
    ]
  },
  "bundle": {
    "resources": [
      "vendor/macos-aarch64/*"
    ]
  }
}
```

Notes:
- `effects: []` at startup → glass is OFF by default (matches Classic default).
- Window is permanently transparent so the runtime toggle can add/remove the material without recreating the window.
- `hiddenTitle: true` + `titleBarStyle: "Overlay"` puts traffic lights on top of `#topbar`; CSS adds `padding-left: 78px` (Task 7).

- [ ] **Step 2: Verify config validates**

Run from `src-tauri/`:
```bash
cargo check
```
Expected: PASS. Tauri merges `tauri.conf.json` ← `tauri.macos.conf.json` at build time; a malformed override fails `cargo check` via `tauri::generate_context!`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.macos.conf.json
git commit -m "feat(window): make macOS window transparent with overlay title bar for Liquid Glass"
```

---

## Task 2: Plumb AppHandle into the HTTP server

**Files:**
- Modify: `src-tauri/src/http_server.rs:10-50`
- Modify: `src-tauri/src/lib.rs:91-96`

`Window::set_effects` is a Rust API on `tauri::Window`. The axum router needs an `AppHandle` to look up the `main` window from inside request handlers. This task just plumbs the handle through; the new route lands in Task 3.

- [ ] **Step 1: Update `http_server::serve` to accept and store `AppHandle`**

Replace the top of `src-tauri/src/http_server.rs` (the `use` block + the `serve` signature, lines ~10-50) with:

```rust
use std::sync::mpsc::Sender;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tauri::AppHandle;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::tooling;

pub const HTTP_PORT: u16 = 8780;
const VIEWER_HTML: &str = include_str!("../../viewer/applogs-viewer.html");

pub async fn serve(app: AppHandle, ready_tx: Sender<()>) -> Result<(), String> {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "http://localhost:8780".parse().expect("static origin"),
            "http://127.0.0.1:8780".parse().expect("static origin"),
        ]))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let router: Router<AppHandle> = Router::new()
        .route("/", get(serve_index))
        .route("/devices/android", get(android_devices))
        .route("/devices/ios", get(ios_devices))
        .route("/ios-driver-status", get(ios_driver_status))
        .route("/ios/unpair", post(ios_unpair))
        .route("/ios/pair", post(ios_pair))
        .route("/ios/repair", post(ios_repair))
        .layer(cors);
    let app_router = router.with_state(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", HTTP_PORT))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{HTTP_PORT}: {e}"))?;
    tracing::info!("http server listening on http://127.0.0.1:{HTTP_PORT}");
    if ready_tx.send(()).is_err() {
        tracing::warn!("http ready receiver already dropped — startup will hang");
    }
    axum::serve(listener, app_router)
        .await
        .map_err(|e| format!("axum::serve: {e}"))?;
    Ok(())
}
```

The existing handler functions (`serve_index`, `android_devices`, `ios_unpair`, …) stay unchanged — axum only injects `State<AppHandle>` into handlers that extract it. Do **not** add `State<AppHandle>` to them.

- [ ] **Step 2: Update the caller in `lib.rs`**

In `src-tauri/src/lib.rs:91-96`, replace the HTTP spawn block with:

```rust
let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
let http_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if let Err(err) = http_server::serve(http_handle, ready_tx).await {
        tracing::error!("http server failed: {err:?}");
    }
});
```

`app.handle()` is available on `&tauri::App` inside the `setup` closure; `tauri::Manager` is already imported a few lines above.

- [ ] **Step 3: Verify it builds**

```bash
cd src-tauri && cargo check
```
Expected: PASS.

- [ ] **Step 4: Verify no clippy regressions**

```bash
cd src-tauri && cargo clippy --all-targets -- -D warnings
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/http_server.rs src-tauri/src/lib.rs
git commit -m "refactor(http): thread AppHandle into axum state for upcoming window-control routes"
```

---

## Task 3: Add `POST /window/glass-mode` route

**Files:**
- Modify: `src-tauri/src/http_server.rs` (add route + handler)
- Modify: `src-tauri/Cargo.toml` (ensure `serde` direct dep)

- [ ] **Step 1: Add the route registration**

In `src-tauri/src/http_server.rs`, add to the `Router::new()` chain in `serve` (alongside the other `.route(...)` lines):

```rust
        .route("/window/glass-mode", post(set_glass_mode))
```

- [ ] **Step 2: Add `serde::Deserialize` import**

At the top of `http_server.rs`, ensure:

```rust
use serde::Deserialize;
```

If `serde` is not yet a direct dependency in `src-tauri/Cargo.toml`, add it under `[dependencies]`:

```toml
serde = { version = "1", features = ["derive"] }
```

(Tauri pulls `serde` transitively, but a direct dep makes the import unambiguous.)

- [ ] **Step 3: Add the handler at the bottom of the file**

```rust
#[derive(Deserialize)]
struct GlassModeReq {
    enabled: bool,
}

async fn set_glass_mode(
    State(app): State<AppHandle>,
    Json(req): Json<GlassModeReq>,
) -> Response {
    use tauri::utils::config::WindowEffectsConfig;
    use tauri::utils::{WindowEffect, WindowEffectState};
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "main window missing").into_response();
    };

    let result = if req.enabled {
        let cfg = WindowEffectsConfig {
            effects: vec![WindowEffect::HudWindow],
            state: Some(WindowEffectState::FollowsWindowActiveState),
            radius: None,
            color: None,
        };
        window.set_effects(cfg)
    } else {
        window.clear_effects()
    };

    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::warn!("set_glass_mode failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response()
        }
    }
}
```

If the Tauri v2 type paths in this project resolve under slightly different modules (some Tauri versions re-export `WindowEffect` from `tauri::window`), follow the compiler error: in v2 the canonical struct is `tauri::utils::config::WindowEffectsConfig`, the variant is `tauri::utils::WindowEffect::HudWindow`, and `set_effects`/`clear_effects` are inherent methods on `tauri::WebviewWindow`.

- [ ] **Step 4: Build it**

```bash
cd src-tauri && cargo build
```
Expected: PASS on macOS. On Windows/Linux the `HudWindow` variant compiles but `set_effects` is effectively a no-op there — that is fine because the frontend gates the toggle to darwin anyway.

- [ ] **Step 5: Smoke the route (macOS, app running)**

Launch the app:
```bash
cd src-tauri && cargo tauri dev
```

In another terminal:
```bash
curl -i -X POST http://127.0.0.1:8780/window/glass-mode \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```
Expected: `HTTP/1.1 204 No Content` and the window background visibly turns translucent (desktop blur shows behind the CSS surfaces — note Tasks 4–9 are not done yet, so CSS surfaces will still be solid; you should at least see a translucent fringe behind the title-bar area where no CSS surface paints).

```bash
curl -i -X POST http://127.0.0.1:8780/window/glass-mode \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```
Expected: `HTTP/1.1 204 No Content` and the window goes back to flat.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/http_server.rs src-tauri/Cargo.toml
git commit -m "feat(http): add POST /window/glass-mode route toggling NSVisualEffectView"
```

---

## Task 4: CSS — add `data-glass` design tokens

**Files:**
- Modify: `viewer/applogs-viewer.html` (CSS block, immediately after the existing `:root` / theme variable declarations)

The existing theme switch sets `data-theme="light"|"dark"` on `<html>`. The glass toggle will set `data-glass="on"|"off"`. The CSS combines both axes by overriding surface variables when `data-glass="on"`.

- [ ] **Step 1: Add glass surface variables**

Locate the existing `:root` (and any `[data-theme="dark"]` / `[data-theme="light"]`) blocks in the `<style>` section of `viewer/applogs-viewer.html`. Add immediately after them:

```css
  /* Liquid Glass mode — chrome surfaces become translucent overlays.
     Combined with light/dark theme to yield 4 effective looks. */
  [data-glass="on"] {
    --surface:        rgba(22, 27, 34, 0.55);
    --surface2:       rgba(22, 27, 34, 0.35);
    --border:         rgba(255, 255, 255, 0.12);
    --row-hover:      rgba(255, 255, 255, 0.04);
  }
  [data-glass="on"][data-theme="light"] {
    --surface:        rgba(255, 255, 255, 0.55);
    --surface2:       rgba(255, 255, 255, 0.35);
    --border:         rgba(0, 0, 0, 0.10);
    --row-hover:      rgba(0, 0, 0, 0.03);
  }
  [data-glass="on"] body { background: transparent; }
```

Match the existing variable names verbatim. If the file uses additional surface tokens (e.g. `--surface3`), override them with proportionally lower alpha. Do **not** override `--bg` — it stays solid for the log table; the `body { background: transparent }` rule alone gives the desktop bleed-through.

- [ ] **Step 2: Sanity-check by inspection**

Open the file in an editor and verify no missing semicolons or unbalanced braces. (Visual check at this point only — full visual test happens in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "feat(viewer): add data-glass CSS tokens for translucent surfaces"
```

---

## Task 5: CSS — apply backdrop-filter to chrome surfaces

**Files:**
- Modify: `viewer/applogs-viewer.html` (CSS block)

Apply `backdrop-filter` only to the chrome surfaces enumerated in the Q5 decision. Log table rows stay solid.

- [ ] **Step 1: Add glass-mode rules**

Append to the `<style>` block (after Task 4 tokens):

```css
  /* Apply backdrop-filter only to chrome surfaces when glass is on.
     Log rows + tbody intentionally stay opaque (readability — Q5). */
  [data-glass="on"] #topbar,
  [data-glass="on"] #filterbar,
  [data-glass="on"] #liveBar,
  [data-glass="on"] thead th,
  [data-glass="on"] .modal,
  [data-glass="on"] .connect-card,
  [data-glass="on"] .device-menu {
    backdrop-filter: blur(30px) saturate(180%);
    -webkit-backdrop-filter: blur(30px) saturate(180%);
  }

  [data-glass="on"] .modal-overlay {
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }
```

- [ ] **Step 2: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "feat(viewer): blur chrome surfaces in glass mode (rows stay opaque)"
```

---

## Task 6: CSS — toggle pill button styling

**Files:**
- Modify: `viewer/applogs-viewer.html` (CSS block, near the existing `.theme-switch-*` rules)

Mirror the existing `.theme-switch-track` look (rounded 999px pill with animated thumb) but with text labels "Classic" / "Glass" instead of sun/moon icons.

- [ ] **Step 1: Add pill styles**

Append to the `<style>` block, right after the existing `.theme-switch-*` rules (search for `.theme-switch-track` to find them):

```css
  /* Liquid Glass mode pill — same affordance as the theme switch.
     Hidden on non-macOS platforms via .platform-mac class (set by JS). */
  .glass-switch { position: relative; display: none; align-items: center; cursor: pointer; user-select: none; margin-left: 8px; }
  .glass-switch.platform-mac { display: inline-flex; }
  .glass-switch input { position: absolute; opacity: 0; pointer-events: none; }
  .glass-switch-track {
    position: relative; width: 110px; height: 28px;
    background: var(--surface2); border: 1px solid var(--muted);
    border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: space-between;
    padding: 0 10px; box-sizing: border-box;
    font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; font-weight: 600;
    color: var(--muted);
    transition: background .2s, border-color .2s, color .2s;
  }
  .glass-switch-label { z-index: 1; transition: color .2s; }
  .glass-switch input:checked + .glass-switch-track .glass-switch-label.glass { color: var(--text); }
  .glass-switch input:not(:checked) + .glass-switch-track .glass-switch-label.classic { color: var(--text); }
  .glass-switch-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 50px; height: 22px;
    background: var(--text); opacity: 0.18;
    border-radius: 999px;
    transition: transform .25s cubic-bezier(.4, 0, .2, 1);
  }
  .glass-switch input:checked + .glass-switch-track .glass-switch-thumb {
    transform: translateX(54px);
  }
```

- [ ] **Step 2: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "style(viewer): add Liquid Glass toggle pill styles"
```

---

## Task 7: CSS — traffic-light clearance in topbar

**Files:**
- Modify: `viewer/applogs-viewer.html` (the `#topbar` rule, around line 89)

`titleBarStyle: Overlay` + `hiddenTitle: true` makes the macOS traffic lights float over the topbar's leading edge. Add left padding on macOS only.

- [ ] **Step 1: Edit the `#topbar` rule**

Find the existing `#topbar` rule. It currently reads:

```css
#topbar { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: stretch; padding: 0 16px; flex-shrink: 0; }
```

Replace with:

```css
#topbar { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: stretch; padding: 0 16px; flex-shrink: 0; }
html[data-platform="mac"] #topbar { padding-left: 78px; }
```

The `data-platform` attribute on `<html>` is set by JS in Task 9; on Windows/Linux the padding stays at 16px and traffic lights are not relevant.

- [ ] **Step 2: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "style(viewer): reserve traffic-light space in topbar on macOS"
```

---

## Task 8: HTML — add toggle markup

**Files:**
- Modify: `viewer/applogs-viewer.html` (`#topbar` markup, right after the existing theme switch `<label>`)

- [ ] **Step 1: Insert the pill markup**

Find the existing `<label class="theme-switch" …>` block in the topbar (around line 379). Immediately after its closing `</label>`, insert:

```html
<label class="glass-switch" id="glassSwitch" title="Toggle Classic / Liquid Glass (macOS)">
  <input type="checkbox" id="glassSwitchInput">
  <span class="glass-switch-track">
    <span class="glass-switch-thumb"></span>
    <span class="glass-switch-label classic">Classic</span>
    <span class="glass-switch-label glass">Glass</span>
  </span>
</label>
```

- [ ] **Step 2: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "feat(viewer): add Liquid Glass toggle markup to topbar"
```

---

## Task 9: JS — wire toggle to localStorage + backend

**Files:**
- Modify: `viewer/applogs-viewer.html` (`<script>` block — add a self-contained IIFE near the top of the script section so it runs before the rest of the page logic)

Behavior:
1. On load: detect macOS via the WebView UA. Set `data-platform="mac"` (or `"other"`) on `<html>`.
2. On load: read `localStorage.glassMode` (default `"off"`), set `data-glass` on `<html>`, check the checkbox accordingly.
3. On toggle: update `data-glass`, write `localStorage`, POST new state to `/window/glass-mode` (mac only — non-mac skips the fetch).
4. Hide the pill on non-mac (via absence of `platform-mac` class — already in Task 6 CSS).
5. If a previously saved Glass=on session reopens on macOS, send one initial POST so the native window matches the CSS (the conf starts with `effects: []`).

- [ ] **Step 1: Add the IIFE**

Find the existing `<script>` opening tag in `viewer/applogs-viewer.html` (after `</style>`). At the **top** of that script block, add:

```javascript
// ─── Liquid Glass toggle (macOS only) ────────────────────────────────────
(function initGlassToggle() {
  const root = document.documentElement;

  // Tauri WKWebView/WebView2 UA contains "Mac OS X" on darwin builds.
  const isMac = /Mac OS X/i.test(navigator.userAgent);
  root.setAttribute('data-platform', isMac ? 'mac' : 'other');

  const saved = localStorage.getItem('glassMode') === 'on' ? 'on' : 'off';
  root.setAttribute('data-glass', saved);

  function postGlassMode(enabled) {
    return fetch('/window/glass-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  }

  function bind() {
    const el = document.getElementById('glassSwitch');
    const input = document.getElementById('glassSwitchInput');
    if (!el || !input) return;
    if (isMac) el.classList.add('platform-mac');
    input.checked = saved === 'on';

    input.addEventListener('change', async () => {
      const enabled = input.checked;
      const next = enabled ? 'on' : 'off';
      root.setAttribute('data-glass', next);
      localStorage.setItem('glassMode', next);
      if (!isMac) return;
      try {
        const r = await postGlassMode(enabled);
        if (!r.ok) console.warn('glass-mode http', r.status);
      } catch (e) {
        console.warn('glass-mode fetch failed', e);
      }
    });

    // Sync native window to persisted state on startup (only when enabling,
    // since the conf already starts with effects=[]).
    if (isMac && saved === 'on') {
      postGlassMode(true).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add viewer/applogs-viewer.html
git commit -m "feat(viewer): wire Liquid Glass toggle (localStorage + POST /window/glass-mode)"
```

---

## Task 10: Manual smoke test (macOS)

**Files:**
- None (verification only)

- [ ] **Step 1: Build & launch**

```bash
cd src-tauri && cargo tauri dev
```

- [ ] **Step 2: Run through the smoke checklist**

Verify each item:

1. App opens with **Classic** look — opaque chrome, identical to before this PR. (Window is technically transparent but `--bg` solid fills it.)
2. Traffic lights sit cleanly to the left of the logo, no overlap, no clipping. Title text is hidden.
3. Click the new **Glass** pill → chrome surfaces blur the desktop visibly behind the window; logo, tabs, filters, status pills all readable.
4. Flip the existing **light/dark** theme switch while in Glass mode → tints change between light-glass and dark-glass; both readable.
5. Open a log file (file mode) → log rows stay fully opaque (no see-through text).
6. Open the iOS troubleshooting modal → modal has glass, backdrop dims behind it.
7. Toggle Glass → Classic → Glass several times rapidly — no flicker / window-resize artifacts.
8. Close app, reopen → state persists (Glass stays Glass on next launch; native window also matches because of the on-startup re-POST in Task 9 Step 1).
9. Test with **active vs inactive** window: cmd-tab away → the glass dims (FollowsWindowActiveState confirmed).

- [ ] **Step 3: Windows build sanity (optional, if a Windows runner is handy)**

The toggle pill must be **hidden** on Windows. CSS pixel-test only; no native blur expected.

- [ ] **Step 4: CI**

Push the branch; the existing `cargo fmt + check + clippy` workflow must stay green.

- [ ] **Step 5: Commit fixups (if any)**

If any task above needs follow-up tweaks discovered during smoke, commit them as separate `fix(viewer): …` / `fix(window): …` commits with one-line subjects.

---

## Self-Review

**Spec coverage:**
- macOS-only toggle → Tasks 1 (conf), 6 (CSS visibility), 9 (JS UA detect)
- Dynamic native toggle → Tasks 1–3 (transparent window + axum route + `set_effects`)
- Compose with light/dark → Task 4 (`[data-glass][data-theme]` combinatorial CSS)
- HudWindow + FollowsWindowActiveState → Task 3 handler
- Chrome-only glass, opaque rows → Task 5 (selector list excludes `tbody`/rows)
- Two-state pill, default Classic, localStorage → Tasks 6, 8, 9
- titleBarStyle Overlay + hiddenTitle + transparent permanent → Task 1; topbar padding Task 7
- HTTP wiring (no Tauri IPC) → Tasks 2 & 3 (route on existing axum)
- Manual smoke verification → Task 10

**Placeholder scan:** none.

**Type consistency:** `GlassModeReq.enabled: bool` matches the JSON body sent by JS (`{enabled: boolean}`). `data-glass` values are `"on"|"off"` in both CSS and JS. `data-platform="mac"` matches the CSS selector in Task 7. Function `postGlassMode(enabled)` consistent name in JS.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration via `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

Which approach?
