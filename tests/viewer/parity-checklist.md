# Redesign parity checklist

Every row of the spec's "Old to new feature mapping" (`docs/design/ui-redesign.md`), plus the
in-flight viewer behaviour from #45, #46, #54, #55, #57 and #58. Nothing is dropped.

Tick a row in the PR that lands its **final** home (the last PR in brackets), after checking it by
hand in the running app (`cd src-tauri && cargo run`). A row a PR only partly covers stays open and
the PR body says which part landed. P16 requires every box ticked, except rows bracketed optional.

## Spec mapping

- [ ] **Mode tabs File Import / Live Devices** → Sidebar SESSIONS ("Live session" + files), Devices screen (⌘2), window drop overlay, ⌘O _(P4, P8, P11, P13)_
- [ ] **Zoom A− / A / A+ (8–20 px), ⌘ +/−/0, persisted** → Toolbar group "A− 13 px A+", ⌘= / ⌘− / ⌘0, Settings → Appearance slider (10–20 px, persisted). Interface size S/M/L added. _(P1 (store, 10–20 px), P4, P14)_
- [ ] **Theme switch light/dark, persisted** → Settings → Appearance (Light / Dark / System), sidebar footer cycle, ⇧⌘L, onboarding step 3, palette "Toggle theme" _(P1 (three-state store), P4, P13, P14, P15)_
- [ ] **Liquid Glass switch (macOS)** → Settings → Appearance → Material Solid / Glass, and onboarding step 3. Not in the main toolbar. _(P1 (material store), P4 (interim home so Glass / Solid stays reachable, e.g. the More menu; the legacy switch goes away in P4), P14, P15)_
- [ ] **Message search** → Query bar bare words and `"phrase"` _(P6)_
- [ ] **Case-sensitive (Aa)** → Query bar "Aa" (⌥C) _(P6, P13)_
- [ ] **Regex (.*)** → Query bar ".*" (⌥R) and `/regex/` tokens _(P6, P13)_
- [ ] **Tag/Process field** → `tag:` tokens and chips, autocomplete with counts, drawer "Only / Hide tag", T and X keys _(P6, P7, P9, P13)_
- [ ] **PID/App field** → `app:` and `pid:` tokens, drawer "Only this app" and PID only/hide, P key _(P6, P9, P13)_
- [ ] **Level toggles V D I W E A** → Level chips V D I W E **F** (= Fatal / Assert) with live counts, `level:`, ⌥ letter _(P6, P13)_
- [ ] **Platform toggles Android / iOS** → Device chips (per device, with platform badge), `plat:` / `dev:` tokens, sidebar device row and status bar device button _(P6)_
- [ ] **Auto-scroll toggle** → Toolbar Follow toggle (End); turns off on scroll-up and selection _(P5)_
- [ ] **Pause / Resume** → Toolbar Pause (Space), "Paused · N buffered" badge, Resume pill _(P4, P5)_
- [ ] **Clear** → Toolbar far-right Clear (⌘⌫) with a 10 s Undo; "New session" in More _(P4, P12)_
- [ ] **Stats "332 / 332 lines" + discarded notes** → Chip row "47 106 of 48 310 lines", status bar "Retained 48 310 of 500 000", buffer-full pill text, export notes _(P4, P6)_
- [ ] **Export menu (Plain text / CSV / JSON, Filtered / All, warning note)** → Toolbar Export menu with the same formats and captions, scopes Filtered / All / Around marker / Selection, the same gap and discard notes; defaults in Settings → Export _(P3 (portal), P11, P14)_
- [ ] **Android card + iOS card status pill** → Sidebar device rows (always visible) and Devices cards with status badges _(P4, P8)_
- [ ] **Status pill Error / bridge `error` frames (non-stall)** → Device card: err badge "Error" with the frame text and a primary "Try again"; sidebar row "Error"; an err toast on the first occurrence. Until `/devices/*` reports tool errors, show only frames received on the WebSocket. _(P8)_
- [ ] **Device picker dropdown** → Devices lists every detected device as its own card; the sidebar lists all _(P8)_
- [ ] **Refresh (↻)** → Devices toolbar "Refresh" (⌘R) and automatic detection (Settings → Devices) _(P8, P13, P14)_
- [ ] **Connect / Disconnect** → Card "Start streaming" / "Stop", sidebar row hover Start/Stop, palette, "Start all ready" (⌘↵) _(P4, P8, P13)_
- [ ] **Setup modal: Android steps** → Devices empty-state Android checklist with live ticks, card menu "Setup guide", onboarding step 2, Settings → Devices → Guides _(P8, P14, P15)_
- [ ] **Setup modal: iOS steps incl. Windows Apple Devices** → Devices empty-state iPhone checklist + "Get Apple Devices", onboarding step 2 _(P8, P15)_
- [ ] **Troubleshoot: Re-pair iPhone (unpair + pair + pkill)** → Stall sheet primary "Re-pair iPhone", iPhone card and sidebar menus, Settings → Devices → Pairing, palette _(P8, P14)_
- [ ] **Unpair only / Pair only** → Stall sheet → Advanced; Settings → Devices → Pairing → Advanced _(P8, P14)_
- [ ] **Manual commands ("Still stuck? Run these…")** → Stall sheet → "Run it yourself" with per-command copy and Copy all _(P8)_
- [ ] **iOS driver warning (Windows) + Install Apple Devices + Retry** → Devices error banner ("Install Apple Devices", "Check again"), "Driver missing" card and sidebar row, Settings → Devices → Apple Devices driver _(P8, P14)_
- [ ] **Live bar per-platform status + Connect/Disconnect** → Sidebar DEVICES rows and status bar per-device rate buttons _(P4)_
- [ ] **Frames dropped pill** → Status bar "312 lines dropped" + popover, sidebar "312 dropped", inline gap row, export and report notes _(P4, P10, P11, P12)_
- [ ] **Device badge (WebSocket `devices` frame)** → Card meta, "Show raw device info", drawer Device field, bug report header _(P8, P9, P12)_
- [ ] **Columns platform, Timestamp, PID-TID, Tag, App/Device, Lvl, Message** → The same seven columns in the order Platform, Time, Lvl, Tag, App / Device, PID–TID, Message; resizable, reorderable and hideable (Settings → Log view) _(P5, P14)_
- [ ] **PID → package mapping (adb shell ps every 5 s)** → App / Device column and drawer field; switch and interval in Settings → Devices _(P5, P9, P14)_
- [ ] **Column resize handles** → Kept, keyboard operable, plus reorder _(P5)_
- [ ] **Scroll-back beyond 6 000 rows** → Unchanged; Home jumps to the oldest retained line _(P5)_
- [ ] **Row click selection (stops auto-scroll)** → The same, plus ⇧/⌘-click multi-select; ↵ or double-click opens the drawer _(P5, P9)_
- [ ] **Stall modal (Re-pair / Dismiss, suppressed while paused)** → Stall sheet (Re-pair iPhone / Keep waiting), still suppressed while paused; sidebar "Stalled 15 s"; Live logs stall banner _(P8)_
- [ ] **Dropzone + Browse file** → Window-wide drop overlay (new session or add to live), Devices drop strip, ⌘O, empty states _(P8, P11)_
- [ ] **Window drag on the topbar, double-click maximize** → Sidebar header and toolbar form the drag band; double-click maximizes _(P4)_
- [ ] **Loading "Parsing… / Rendering N lines…"** → Toolbar progress "Reading pixel-crash-0412.logcat… 41%" and a progressively filling grid _(P11)_
- [ ] **New** → Markers, saved presets, detail drawer, bug report, command palette, global marker key, automatic crash markers, session names, highlight rules, timestamp formats _(P7–P15)_
- [ ] **New: Increase contrast, Reduce motion (On / Off overrides)** → Settings → Appearance writes `data-contrast` and `data-motion`; the Reduce motion overrides and the `forced-colors` pass land in P16 _(P14, P16)_
- [ ] **New: evidence bundle (⇧⌘E)** → optional follow-up `feat/viewer-evidence-bundle`, after P12; its Export menu items stay hidden until then. Not part of the P16 gate unless that PR has landed. _(feat/viewer-evidence-bundle, optional)_

## In-flight behaviour that must survive

- [ ] **#45 retention cap: "N older discarded" / "N discarded, resume skips to newest" with tooltip** → status bar Retained text; `#exportNote` stays inside the Export menu _(P4, P11)_
- [ ] **#46 server drops per platform, tooltip, reset on Clear (since P2 a loaded file is its own session and leaves the live counts alone)** → status bar drops button, sidebar device rows, gap rows _(P4, P10)_
- [ ] **#54 Follow off freezes the table; new lines load only at the bottom** → unchanged semantics under Follow _(P5)_
- [ ] **#55 every reset goes through `discardBacklog(s)` for the session it resets: Clear (the shown session), file load (the file session), Undo; a session switch resets nothing and the live backlog survives a file load** → every reset path _(P2 done for Clear, file load and switch; P12 Undo)_
- [ ] **#57 "N lines below · Jump to latest" pill, `updateNewerPill()` single hook, 56 px spacer** → jump pill, bottom-centre, portalled _(P5)_
- [ ] **#58 sliding scroll-back through the retained history and "lines X–Y of Z" hint** → hint in the status bar while Follow is off _(P4, P5)_
