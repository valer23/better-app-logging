# AppLogsViewer UI and UX redesign

**Status:** Approved 2026-10-14 after one review round. Mockup canvas: <https://claude.ai/artifact/7GicJ5oHRJu2SD2KtJ7QqW> (23 artboards, private to the owner until shared).
**Companion:** [`ui-redesign-foundation.css`](ui-redesign-foundation.css) holds the design tokens and the component reference CSS.
**Conventions:** ⌘ means Ctrl on Windows, ⌥ means Alt, ⌃ means Ctrl. Sizes assume interface size M, log text 13 px and a 1440×900 window unless written as tokens (`var(--ctl-h)`). Thousands use a thin space ("48 310").

## Summary

1. A sidebar and main layout replaces the File/Live mode tabs. The sidebar holds devices, sessions, saved filters and markers. The main area holds the toolbar, query bar, log grid and status bar.
2. One query bar with removable chips replaces the five separate filter controls. Typing, clicking a chip and row actions all edit the same query.
3. QA extras are added: one-key markers, saved filter presets, a line detail drawer, and "Copy as bug report".
4. The app gets its own accessible visual system: zinc neutrals, one violet accent, measured contrast in dark and light, Solid and Glass materials, and separate interface size (S/M/L) and log text size (10–20 px) controls.
5. Devices, onboarding and settings are designed screens, and every device and stream problem has a designed state that says what happened and what to do.

## Goals and non-goals

**Goals**
- Keep every current feature, giving each one a clear home in the new IA (see "Old to new feature mapping").
- Make the moment a bug happens easy to capture (markers) and easy to hand over (bug report, export, evidence bundle).
- Make filtering fast for developers (keyboard, query grammar, presets) and safe for QA testers (chips, counts, one-click fixes for empty results).
- Meet WCAG 2.2 AA in both themes and both materials, with measured contrast and no information carried by colour alone.
- Keep live throughput intact at 2k–27k lines/s (iOS bursts) with the existing bounded-DOM architecture.

**Non-goals**
- Rewriting the Rust bridges, the WebSocket protocol or the file parsers. New backend support is called out item by item under "Implementation notes"; nothing in this doc assumes an API that does not exist without saying so.
- Using the Bragi brand or design system. The user rejected it for accessibility and readability.
- Remote or networked log sources, log persistence across app restarts, and multi-window log views.
- Light/dark-specific native window materials. Glass uses the existing single HUD material.

## Users and jobs

| User | Context | Jobs the design serves |
|---|---|---|
| QA tester | Reproduces bugs on audio and earbud companion apps, often with hands on the phone. Less technical and click-first. | Get a phone streaming without help. Mark the moment it broke. Copy a clean report into Jira. Recover from Trust, driver and stall problems by following one sentence and one button. |
| Developer | Filters hard by tag, PID, package and regex. Keyboard-first, works in long sessions, needs high density. | Narrow to the relevant lines fast and save that filter. Read one line in full, including its JSON. Jump between markers and errors. Export exactly what is needed. |

Both users get equal weight. Every frequent action has a visible control (QA) and a shortcut (developer).

## Decisions log

### User decisions

| # | Date | Decision | Why |
|---|---|---|---|
| U1 | 2026-10-14 | Scope is the full redesign plus QA extras: markers, saved filter presets, line detail drawer, copy as bug report. | QA testers need to capture and hand over evidence, not only read logs. |
| U2 | 2026-10-14 | Layout is a sidebar plus main area. | Devices, sessions, presets and markers stay visible without stealing log rows. |
| U3 | 2026-10-14 | Filtering uses one query bar plus a chip row. | One filter model that is typable, clickable, savable and quotable in reports. |
| U4 | 2026-10-14 | Materials are Solid (default, every platform) and Glass (macOS). The switch lives in Settings → Appearance and onboarding, never in the main toolbar. Glass makes the chrome translucent; logs stay opaque. | Glass is a preference, not a frequent action. Opaque logs keep the measured contrast. |
| U5 | 2026-10-14 | Use our own visual system, not the Bragi brand. Inspiration is 21st.dev community components (shadcn/Radix style). | The Bragi system was judged bad for accessibility and readability. |
| U6 | 2026-10-14 | Dark, light and System themes. Two independent size controls: interface size S/M/L and log text 10–20 px with ⌘= / ⌘− / ⌘0 and a visible stepper in the log view. | Long sessions in dim labs, and very different reading distances. |
| U7 | 2026-10-14 | Review round 1, four fixes, all in mockup v4. (1) Onboarding step 2 no longer shifts when a platform is deselected: the root never wraps with a fixed height, and below 900 px it stacks as a column with the rail at its natural height. (2) Onboarding step 3 shows a live sample log line next to the log size slider, with the shortcut hints under the control. (3) Marker, gap and event rows keep a 7 px left inset, which centres their icon on the 28 px platform column and clears the 3 px level stripe. (4) The autocomplete popover aligns to the query field's left edge at `min(480px, 100%)` wide, not to the caret. | Layout stability, visible feedback for the size control, and alignment. |

### Design resolutions

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Command palette key | ⌘K, triggered from a "Search actions… ⌘K" field at the top of the sidebar. | The common convention in the inspiration set. |
| D2 | Clear | A visible ghost-danger icon at the far right of the toolbar, after a divider. ⌘⌫, with a 10 s Undo. | Developers clear often, so it stays visible. Undo makes it safe. |
| D3 | Toolbar height | 52 px at every interface size. | Forms one title band with the sidebar header and keeps the traffic lights aligned. |
| D4 | Sources model | A SESSIONS section: "Live session" first, then opened files. The session name is editable in the toolbar and flows into exports and reports. | File and live coexist without mode tabs. |
| D5 | Query text and chips | The bar holds plain query text. The chip row shows level chips, device chips and the remaining tokens as removable chips. Editing either rewrites the other. | Two views of one model. |
| D6 | Follow and Pause | Two separate toggles. Follow is the viewport. Pause stops the drain and buffers. | They answer different needs: reading back, and freezing the stream. |
| D7 | Where drops show | Status bar button and popover, sidebar device row, inline gap row, export note and report note. | A gap must be visible where it happened and wherever evidence leaves the app. |
| D8 | Assert level letter | F ("Fatal / Assert"). Logcat A and F both map to it. | One letter for the highest level. |
| D9 | Settings placement | Its own window (960×680). | Settings are not part of the log workflow. |
| D10 | Onboarding stepper | A 280 px left rail with a vertical stepper and "Step n of 4". | Uses the wide window, and progress stays visible. |
| D11 | Devices layout | A full-width card list, max 880 px, one card per detected device. Cards expand in place. | Steppers and callouts need width. |
| D12 | Single-key shortcuts | Active only while the log list has focus, with an off switch (WCAG 2.1.4). A global marker key ⌃⌥M works from any app. | Avoids clashes with typing and screen readers. |
| D13 | iOS stall timeout | 15 s. | Matches `STREAM_STALL_TIMEOUT_SECS = 15` in the iOS bridge. |
| D14 | Column order | Platform · Time · Lvl · Tag · App / Device · PID–TID · Message. | The level sits next to the time; PID–TID stays visible. |
| D15 | Level colour | The message text stays neutral. Level colour goes on the letter, the 3 px stripe (W, E, F), a row tint (W, E, F) and the chip. "Color whole line by level" is opt-in. | Readability. Every level colour passes on every row background anyway. |
| D16 | Glass opacity | Chrome alpha 0.80 dark, 0.78 light. Tinted fills always mix over the opaque surface. | Measured: tints directly on glass failed. |
| D17 | Bug report sheet | A centred 760×640 modal with the form at 280 px and a live preview. Formats are Markdown, Jira and Plain text. Context lines 0, 10 or 50. | Users see exactly what they will paste. |
| D18 | Light-theme I and W | Tailwind -800 shades (#166534, #92400e). | The -700 shades fail on the selected row. |

### As-built decisions after review

| # | Decision | Why |
|---|---|---|
| B1 | Toolbar kbd hints show only when the toolbar is at least 1320 px wide (tooltips always carry the shortcut). Labels drop below 1180 px and the log text stepper hides below 1040 px. | At 1440 with the sidebar open the toolbar is 1192 px. Hints there would clip Clear and More. |
| B2 | Level chips show the letter and count. The level name shows only when the query region is at least 1280 px wide, and it is always in the aria-label and title. | Density at the default width. |
| B3 | Two or more text, tag, app, PID or platform tokens collapse into one "N filters" chip with a popover. | The chip row never wraps or pushes the count off screen. |
| B4 | The detail drawer narrows the grid: App / Device and PID–TID hide (they are in the drawer's Fields), and Message keeps a 24ch floor. | Messages stay readable with the drawer open. |
| B5 | The "Multi-select" status bar toggle was removed. Selection is click, ⇧-click and ⌘-click; the status bar shows "N selected" with a clear button. | Two permanent accent pills in the status bar read as state that was not there. |
| B6 | Settings is de-duplicated. Row density, wrap and "Color whole line by level" live only in Log view. Buffer size lives only in General. Fonts is one Standard/Hyperlegible control (the separate interface and log font selects were removed). | Each setting has exactly one home; the font preset and selects could contradict each other. |
| B7 | Preset ⌥3 "Errors from app" is `app:com.example.headset level:E+`. | The earlier `app:… tag:… level:E+` returned nothing under AND semantics. |
| B8 | Theme cycles Dark → Light → System from the sidebar footer and the palette. ⇧⌘L cycles it from the keyboard. | System must be reachable from the quick control, since Settings offers it. |
| B9 | "Start all ready (n)" on Devices is primary only when n ≥ 2. The Trust card's "Check again" is its primary and "Start streaming" is a disabled secondary. | One primary per region. |
| B10 | Clicking a device row in the sidebar toggles that device in the filter; on the Devices screen it also reveals the card. | One meaning for the row everywhere. |

## Design principles

1. **The log is the product.** Chrome takes 192 px of height in total (toolbar 52, query region 84, grid header 28, status bar 28). Log text size is separate from interface size.
2. **One filter model, three ways in.** Typing, chips and row actions all edit the same query, which is visible, savable and quoted in reports.
3. **State is never only colour.** Levels show a letter. Statuses show icon and text. Toggles show `aria-pressed` with a fill and an inset ring. Negation shows "NOT" and a dashed border. Selection shows a fill and a bar. Hover, focus and selected all look different.
4. **Every state says what happened and what to do.** Each device or stream problem gets one plain sentence and one primary button. Empty, loading, stalled, dropped and disconnected states are all designed.
5. **Calm, dense, measured.** Zinc neutrals, hairline structure, one violet accent, a 4-pt grid, 120–160 ms motion, tabular numbers updated at most 4 times per second, and every text tier contrast-measured.

## Visual system

### Themes

- **Dark** (default), **Light**, **System**. System follows the OS appearance and writes `data-theme="dark"` or `"light"`; the CSS has only two themes.
- The theme applies to the whole window, including sheets and the Settings window.

### Materials

| Material | Platforms | What changes |
|---|---|---|
| Solid (default) | macOS, Windows | All surfaces opaque. |
| Glass | macOS only | Sidebar, toolbar, query region, status bar, drawer header, sheets and the Settings nav become translucent (`backdrop-filter: blur(30px) saturate(180%)`). Chrome alpha 0.80 (dark) and 0.78 (light); raised chrome 0.86. The log list, drawer body, menus, inputs, cards and toasts stay opaque. |

Glass falls back to Solid while macOS Reduce transparency is on. On Windows the option is disabled with the reason "Glass is available on macOS."

### Sizes

**Interface size** changes chrome only:

| Token | S | M (default) | L |
|---|---|---|---|
| Body / small / extra small text | 12 / 11 / 10 | 13 / 12 / 11 | 15 / 13 / 12 |
| Title / section heading | 20 / 14 | 22 / 15 | 26 / 17 |
| Control height / small control | 26 / 24 | 28 / 24 | 32 / 28 |
| Chip / query bar height | 24 / 32 | 26 / 36 | 28 / 40 |
| Icon | 14 | 16 | 18 |
| Sidebar width | 224 | 248 | 272 |
| Status bar / menu row | 26 / 28 | 28 / 32 | 30 / 36 |
| Badge and kbd height | 18 | 20 | 22 |

Fixed at every size: toolbar and title band 52 px, sidebar footer 44 px, collapsed rail 52 px, drawer 400 px (resizable 320–640).

**Log text size** is 10–20 px (default 13), via `--log-fs`. Row height is `max(18px, log size × 1.6)` (Comfortable) or `× 1.4` (Compact). Grid column widths are in `ch`, so they scale with log text. The platform badge in rows is `max(18px, log size × 1.3)`.

### Typography

| Use | Font | Notes |
|---|---|---|
| Interface | Geist 400/500/600/700 | Fallback `system-ui, -apple-system, "Segoe UI"`. |
| Logs, query text, kbd, code | JetBrains Mono 400/500/700 | Unambiguous 0/O and 1/l/I. |
| Hyperlegible option | Atkinson Hyperlegible Next (interface) and Atkinson Hyperlegible Mono (logs) | One switch sets both (`data-font="hyper"`). |

Scale at M: title 22/600, section 15/600, body 13/400 and 500, meta 12, section label 11/600 uppercase +0.04em (used sparingly), log mono at the chosen size.

### Colour tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #09090b | #ffffff | App and log background |
| `--bg-side` | #111113 | #f4f4f5 | Sidebar, segmented track |
| `--surface` | #18181b | #fafafa | Chrome, cards, grid header |
| `--raised` | #1f1f23 | #ffffff | Menus, toasts, kbd |
| `--hairline` | #27272a | #e4e4e7 | Structure lines (decorative) |
| `--border` | #82828c | #7a7a84 | Control boundaries (≥ 3:1) |
| `--text` | #fafafa | #18181b | Primary text |
| `--text-2` | #a1a1aa | #52525b | Secondary text (≥ 4.5:1) |
| `--text-3` | #71717a | #71717a | Decoration and disabled only |
| `--accent` | #a78bfa | #6d28d9 | Accent text, rings, pressed borders |
| `--accent-fill` / hover | #7c3aed / #6d28d9 | #6d28d9 / #5b21b6 | Primary buttons, switches, done steps |
| `--accent-subtle` / `--accent-on-subtle` | #1b112f / #c4b5fd | #f5f0fc / #5b21b6 | Pressed and current fills |
| `--row-hover` / `--row-sel` | #141416 / #22143d | #f6f6f6 / #efe7fb | Log rows |
| `--tint-w` / `--tint-e` / `--tint-f` | #1a160d / #231416 / #1f1423 | #fef5e7 / #fef0f0 / #fcf2fe | W, E, F row tints |
| `--ok` / `--warn` / `--err` / `--info` | #4ade80 / #fbbf24 / #f87171 / #60a5fa | #166534 / #92400e / #b91c1c / #1d4ed8 | Status |
| `--plat-android` / `--plat-ios` | #2dd4bf / #d4d4d8 | #115e59 / #3f3f46 | Platform badges |
| `--marker` / `--marker-bg` | #a78bfa / #1b112f | #6d28d9 / #f5f0fc | Marker rows |
| `--match-bg` / `--match-fg` | #524012 / #fafafa | #fef08a / #18181b | Search hits |
| `--tip-bg` / `--tip-fg` | #f4f4f5 / #18181b | #18181b / #fafafa | Tooltips (inverted) |

**Increase contrast** (Settings → Appearance; On, or System when the OS asks for more contrast) derives `--text-2`, `--border` and `--hairline` from the theme by mixing `--text` into `--bg` at 88%, 62% and 24%.

### Level colours

| Level | Letter | Chip name | Dark | Light | Row treatment |
|---|---|---|---|---|---|
| Verbose | V | Verbose | #a1a1aa | #52525b | None |
| Debug | D | Debug | #60a5fa | #1d4ed8 | None |
| Info | I | Info | #4ade80 | #166534 | None |
| Warning | W | Warn | #fbbf24 | #92400e | `--tint-w` background, 3 px stripe |
| Error | E | Error | #f87171 | #b91c1c | `--tint-e` background, 3 px stripe |
| Fatal / Assert | F | Fatal | #e879f9 | #a21caf | `--tint-f` background, 3 px stripe |

The level letter is always present. Selection replaces the stripe with the accent bar and the background with `--row-sel`.

### Contrast policy

- Body text ≥ 4.5:1. Control boundaries and focus indicators ≥ 3:1. `--text-3` is never used for information.
- Every level colour is checked against plain, hover, W/E/F tint, selected and marker backgrounds, and on the pressed chip.
- Alpha tints are flattened onto their base before measuring. Tinted fills (pressed chips, status badges, platform badges, banners) always mix over opaque `--surface`, because tints directly on glass failed (dark E chip 3.76, err badge 3.87).
- Rows are never dimmed with opacity. Out-of-filter rows in Show context use `--text-2`.
- Any token change is re-measured before it ships.

### Measured contrast

WCAG 2.x relative luminance; 238 pair checks, 0 failures, plus 42 tint + hover checks and the 14% platform badges re-measured after review. Token values are unchanged since measurement.

**Dark theme**

| Tier | bg #09090b | side #111113 | surface #18181b | raised #1f1f23 | Need |
|---|---|---|---|---|---|
| text #fafafa | 19.06 | 18.07 | 16.97 | 15.74 | 4.5 |
| text-2 #a1a1aa | 7.76 | 7.36 | 6.91 | 6.41 | 4.5 |
| text-3 #71717a | 4.12 | 3.90 | 3.67 | 3.40 | decor only |
| border #82828c | 5.23 | 4.96 | 4.66 | 4.32 | 3.0 |
| accent #a78bfa | 7.31 | 6.93 | 6.51 | 6.04 | 4.5 |

| Level | row #09090b | hover #141416 | W tint | E tint | F tint | selected #22143d | marker #1b112f | pressed chip |
|---|---|---|---|---|---|---|---|---|
| V #a1a1aa | 7.76 | 7.18 | 7.04 | 6.93 | 6.93 | 6.63 | 7.02 | 5.50 |
| D #60a5fa | 7.83 | 7.24 | 7.09 | 6.98 | 6.98 | 6.69 | 7.07 | 5.55 |
| I #4ade80 | 11.42 | 10.56 | 10.35 | 10.19 | 10.19 | 9.75 | 10.32 | 7.62 |
| W #fbbf24 | 11.92 | 11.02 | 10.80 | 10.63 | 10.64 | 10.18 | 10.77 | 7.90 |
| E #f87171 | 7.19 | 6.65 | 6.52 | 6.42 | 6.42 | 6.14 | 6.50 | 5.26 |
| F #e879f9 | 8.09 | 7.48 | 7.33 | 7.21 | 7.22 | 6.91 | 7.31 | 5.73 |
| text #fafafa | 19.06 | 17.63 | 17.28 | 17.01 | 17.01 | 16.28 | 17.23 | 16.97 |
| text-2 #a1a1aa | 7.76 | 7.18 | 7.04 | 6.93 | 6.93 | 6.63 | 7.02 | 6.91 |

**Light theme**

| Tier | bg #ffffff | side #f4f4f5 | surface #fafafa | raised #ffffff | Need |
|---|---|---|---|---|---|
| text #18181b | 17.72 | 16.12 | 16.97 | 17.72 | 4.5 |
| text-2 #52525b | 7.73 | 7.03 | 7.41 | 7.73 | 4.5 |
| text-3 #71717a | 4.83 | 4.40 | 4.63 | 4.83 | decor only |
| border #7a7a84 | 4.25 | 3.86 | 4.07 | 4.25 | 3.0 |
| accent #6d28d9 | 7.10 | 6.46 | 6.81 | 7.10 | 4.5 |

| Level | row #ffffff | hover #f6f6f6 | W tint | E tint | F tint | selected #efe7fb | marker #f5f0fc | pressed chip |
|---|---|---|---|---|---|---|---|---|
| V #52525b | 7.73 | 7.15 | 7.15 | 6.97 | 7.09 | 6.44 | 6.90 | 6.37 |
| D #1d4ed8 | 6.70 | 6.20 | 6.20 | 6.04 | 6.15 | 5.58 | 5.98 | 5.52 |
| I #166534 | 7.13 | 6.60 | 6.60 | 6.43 | 6.54 | 5.94 | 6.37 | 5.87 |
| W #92400e | 7.09 | 6.56 | 6.56 | 6.39 | 6.51 | 5.91 | 6.33 | 5.82 |
| E #b91c1c | 6.47 | 5.99 | 5.99 | 5.83 | 5.94 | 5.39 | 5.78 | 5.26 |
| F #a21caf | 6.32 | 5.85 | 5.85 | 5.70 | 5.80 | 5.27 | 5.65 | 5.15 |
| text #18181b | 17.72 | 16.39 | 16.39 | 15.98 | 16.26 | 14.76 | 15.82 | 16.97 |
| text-2 #52525b | 7.73 | 7.15 | 7.15 | 6.97 | 7.09 | 6.44 | 6.90 | 7.41 |

**Other pairs**

| Pair | Dark | Light |
|---|---|---|
| White on accent fill | 5.70 | 7.10 |
| White on accent fill hover | 7.10 | 8.98 |
| Accent fill vs bg (boundary) | 3.49 | 7.10 |
| White on danger fill #b91c1c | 6.47 | 6.47 |
| Accent-on-subtle on accent-subtle | 9.74 | 8.02 |
| Search match text on match bg | 9.58 | 15.22 |
| Tooltip text on tooltip bg | 16.12 | 16.97 |
| ok / warn / err / info on 12% badge | 8.00 / 8.29 / 5.39 / 5.76 | 5.70 / 5.67 / 5.05 / 5.32 |
| Android / iOS on 14% badge | 7.28 / 8.65 | 5.83 / 7.92 |

**Tint + hover** (W, E and F rows on hover use `color-mix(--row-hover 50%, --tint-*)`; the selected row keeps `--row-sel`)

| Level | Dark W / E / F hover | Light W / E / F hover |
|---|---|---|
| V and text-2 | 7.11 / 7.06 / 7.06 | 7.17 / 7.06 / 7.12 |
| D | 7.17 / 7.11 / 7.12 | 6.22 / 6.12 / 6.17 |
| I | 10.46 / 10.38 / 10.38 | 6.61 / 6.51 / 6.57 |
| W | 10.92 / 10.83 / 10.84 | 6.58 / 6.48 / 6.53 |
| E | 6.59 / 6.54 / 6.54 | 6.00 / 5.91 / 5.96 |
| F | 7.41 / 7.35 / 7.35 | 5.87 / 5.77 / 5.83 |
| text | 17.46 / 17.33 / 17.33 | 16.44 / 16.18 / 16.32 |

**Glass** (worst case is chrome over the brightest wallpaper blob #a78bfa):
- Dark chrome 0.80: text-2 ≥ 4.96, border ≥ 3.34, accent ≥ 4.67. Dark sidebar: text-2 5.41, border 3.65, accent 5.10. Dark sheet 0.86: text-2 5.11, border 3.44.
- Light chrome 0.78: text-2 ≥ 6.14, border ≥ 3.38, accent ≥ 5.65. Light sidebar: text-2 5.87, border 3.22, accent 5.39. Light sheet: text-2 6.84.
- Status and level colours as text directly on glass chrome: ≥ 4.60 (dark err) and ≥ 4.80 (light F).

**Increase contrast** (derived tokens)

| Theme | text-2 | border | text-2 on bg / side / surface / raised | border on bg / side / surface / raised |
|---|---|---|---|---|
| Dark | #dddddd | #9e9e9f | 14.65 / 13.89 / 13.04 / 12.09 | 7.43 / 7.05 / 6.62 / 6.14 |
| Light | #343436 | #707072 | 12.42 / 11.30 / 11.90 / 12.42 | 4.94 / 4.50 / 4.73 / 4.94 |

Rejected during measurement: dark border #71717a (2.63 on glass), light border #8a8a94 (2.61 on glass), light ok #15803d (4.09 on badge), light Android #0f766e (4.44 on badge), light I #15803d and W #a16207 (fail on the selected row).

### Shape, spacing, motion, icons

- Radius: 6 (controls), 8 (cards, menus), 12 (sheets, windows, device cards), pill (badges, jump pill). Spacing on a 4-pt grid.
- Elevation: hairline, `--shadow-md` (menus, segmented thumb, tooltips), `--shadow-lg` (sheets, toasts, jump pill).
- Motion: 120 ms (hover, toggles) and 160 ms (sheets, drawer) with `cubic-bezier(.2,.8,.2,1)`, no bounce. Arrival highlight 600 ms. Reduce motion (OS, or Settings On) removes all animation; Settings Off overrides the OS.
- Icons: Lucide geometry, 24 viewBox, stroke 1.75, `currentColor`, `aria-hidden="true"`. No emoji anywhere in the UI.
- Voice: short and direct, numbers not adjectives, sentence case. Errors say what happened and what to do next.

## Information architecture

```
Window (1440×900; minimum 1100×700)
├── Sidebar (248 at M; collapses to a 52 px rail, ⌘B)
│   ├── Header 52: traffic lights (macOS) · "Hide sidebar"
│   ├── "Search actions…  ⌘K"   (opens the command palette)
│   ├── DEVICES        one row per detected device: status, rate, drops · "Devices & setup ⌘2"
│   ├── SESSIONS       "Live session" (always first) · opened files · "Open log file… ⌘O"
│   ├── SAVED FILTERS  presets with ⌥1…⌥9 · "Save current filter ⌘S"
│   ├── MARKERS        markers of the current session, in time order
│   └── Footer 44: Settings ⌘, · Keyboard shortcuts ⌘/ · Theme cycle · Welcome guide · version
└── Main
    ├── Live logs: toolbar 52 · query region 84 · grid · status bar 28 · optional detail drawer 400
    └── Devices: toolbar 52 · device cards · open-file drop strip
Separate window: Settings (⌘,)        First run: Onboarding (full window, no sidebar)
Overlays: command palette · bug report sheet · iOS stall sheet · drop overlay · toasts · menus and popovers
```

**Routing**
- First launch opens Onboarding. Later launches open Devices, or Live logs if Settings → General → On launch says so.
- When a device starts streaming, the main area switches to Live logs. ⌘2 opens Devices at any time; ⌘1 returns to Live logs with scroll position, selection and query intact.
- Live and file sessions coexist. Each session has its own buffer, query, scroll position and selection. Live keeps streaming while a file is open, and the "Live session" row shows the line count.
- Dropping a file anywhere shows a full-window overlay with two targets: "Open as new session" (default) and "Add to Live session" (merged by timestamp).
- Export, markers and bug reports always apply to the selected session.

## Screen specs

### Window frame and sidebar (Live logs and Devices)

**macOS frame.** The OS draws the traffic lights at the top left over the sidebar header (title bar overlay). The sidebar header and the toolbar form one 52 px drag band; double-click toggles maximize.
**Windows frame.** The native caption bar stays (Snap Layouts). The sidebar header shows "AppLogsViewer" 13/600 at x 16 with no traffic lights.

**Sidebar** (`.chrome-side`, right hairline, flex column):
- **Header (52).** Traffic-light space at left; at right an icon button `panel-left` "Hide sidebar" (tooltip "Hide sidebar ⌘B").
- **Command trigger** (margin 0 12 8): a full-width input-styled button with `search` icon, "Search actions…" and kbd "⌘K".
- **Sections** (padding 4 8, gap 12). Each has a collapsible header button (`aria-expanded`) with chevron, section label and count.
  - **DEVICES.** One 48 px row per device: platform badge ("A" or "i"), name (13/500), and a status line. Statuses are "Streaming · 842/s" (ok dot), "Connecting…" (spinner), "Stalled 15 s" (warn clock), "Ready · stopped" (idle dot), "Needs Trust" (warn), "Disconnected" (idle) and "Driver missing" (err). A second line "312 dropped" in `--warn` with a warning icon appears when that device's stream dropped lines. Clicking the row toggles the device in the filter (`aria-pressed`; `aria-current` when it is the only device shown). Hover or focus reveals "Stop streaming {name}" or "Start streaming {name}" and "More for {name}". The menu holds Start/Stop streaming, Re-pair iPhone (iOS), Setup guide and Copy device info. Last row: link "Devices & setup" with kbd ⌘2.
  - **SESSIONS.** "Live session" (`radio` icon, line count, `aria-current="page"` when shown), each opened file (`file-text`, line count), then "Open log file…" ⌘O.
  - **SAVED FILTERS.** One row per preset (`bookmark`, name, kbd ⌥n; tooltip shows the query); the preset whose query equals the current query is `aria-current`. Last row "Save current filter" ⌘S.
  - **MARKERS.** One row per marker: flag icon in `--marker`, "M2 Pairing drops after OTA", time in mono 12 at right. The current marker is `aria-current`. Hover reveals "Rename marker M2" and "Delete marker M2". Rename edits in place (Enter commits, Esc cancels).
- **Footer (44, top hairline).** Icon buttons Settings (⌘,), Keyboard shortcuts (⌘/), Theme (icon `moon`, `sun` or `monitor`; aria-label "Theme: Dark. Switch to Light"; tooltip "Theme: Dark" or "Theme: System (Dark)"), Welcome guide (reopens onboarding), then the version "v1.4.0" at right.
- **Collapsed rail (52).** Show sidebar, Search actions, one icon per device (platform badge plus a status shape: filled dot streaming, ring stopped, spinner connecting, triangle stalled), Devices & setup, Live session, Next marker. Footer: Settings, Theme, Welcome guide. Every item has a tooltip to the right.

### Live logs

#### Toolbar (52, `.chrome`, bottom hairline, padding 0 12 0 16, gap 8; a size container)

Left:
1. **Session title** button (15/600, max 280, ellipsis), "HS-1234 · OTA pairing", pencil icon on hover or focus. aria-label "Rename session HS-1234 · OTA pairing". Click edits in place.
2. **Stream badge:** "Streaming · 2.7k/s" (ok, pulsing dot), "Paused · 3 402 buffered" (warn, pause icon), "Stopped · 48 310 lines" (idle, no device streaming), "File · 12 044 lines" (idle, file session), or while parsing a 120 px progress bar with "Reading pixel-crash-0412.logcat… 41%".

Right, in order (gap 6):
1. **Pause** button: "Pause" / "Resume" with kbd Space (`aria-keyshortcuts="Space"`). Tooltip "Pause stream · Space" / "Resume stream · Space".
2. **Follow** toggle: `arrow-down-to-line`, "Follow", kbd End, `aria-pressed`. Tooltip "Follow newest lines · End".
3. Divider.
4. **Log text size group** (`role="group"`, "Log text size"): "A−" (Smaller log text ⌘−), "13 px" ghost button (Reset log text size to 13 px, tooltip "Reset ⌘0"), "A+" (Larger log text ⌘=). The ends are `aria-disabled` at 10 and 20.
5. Divider.
6. **Bug report** button (`file-text`, "Bug report", kbd ⇧⌘C). `aria-disabled` with no selection; its reason "Select lines first (click, ⇧-click)" is the tooltip and is announced via `aria-describedby`.
7. **Export** menu button (`download`, "Export", chevron). Tooltip "Export ⌘E".
8. **Mark**, the only primary in the toolbar (`flag`, "Mark", kbd M always shown). Tooltip "Add marker now · M (log list) · ⌃⌥M anywhere"; until the global-shortcut plugin ships, "Add marker now · M (log list) · ⌃⌥M (this window)".
9. **More** icon button (`ellipsis`): New session ⇧⌘N · Open log file… ⌘O · Save evidence bundle… ⇧⌘E · separator · Show shortcuts ⌘/ · Settings… ⌘, · Welcome guide.
10. Divider.
11. **Clear** icon button at the far right (`trash-2`, `--err`, hover `--tint-e`). aria-label "Clear view", tooltip "Clear view ⌘⌫ (undo for 10 s)".

**Collapse tiers** (container width; 1192 px at 1440 with the sidebar, 1388 with the rail). Tooltips always keep the shortcut. Container queries measure the content box; thresholds below are border-box widths. With the toolbar's 28 px of horizontal padding they are `@container (max-width: 1291px)` (hints), `1151px` (labels) and `1011px` (text size group). At 1440 with the sidebar, labels show and kbd hints hide. The same rule applies to the query region (32 px padding: level names `max-width: 1247px`, counts `827px`) and the status bar (24 px padding: retained text `975px`).
- Under 1320 px: kbd hints on Pause, Follow and Bug report hide. Mark keeps "M".
- Under 1180 px: Bug report and Export become icon buttons (aria-label kept).
- Under 1040 px: the log text size group and its divider hide; ⌘= / ⌘− / ⌘0 still work.

#### Query region (84 at M, `.chrome`, padding 8 16, gap 4, bottom hairline)

Height 84 = 8 padding + 36 query bar + 4 gap + 28 chip row (36 px tall with −4 px vertical margins so focus rings are not clipped) + 8 padding.

**Query bar** (full width, height `--query-h`):
- Leading `search` icon. Visually hidden label "Filter logs". The input is mono, `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`; spellcheck off.
- Placeholder: `Filter: level:E  tag:Bluetooth  app:com.example.headset  "timeout"  -tag:chatty  /time(out|d)/`.
- Trailing tools: "Aa" Match case (⌥C, `aria-pressed`), ".*" Treat text as regex (⌥R, `aria-pressed`), divider, "Saved filters" menu button, "Save current filter" (⌘S), "Clear filter" (only with a non-empty query), kbd ⌘F (only while unfocused and empty).
- **Invalid:** red border and a 20 px line under the bar (`role="alert"`, error icon). The last valid filter stays applied. Messages: "Invalid regex: {reason}. The last valid filter is still applied.", "Unknown field 'tg'. Did you mean tag:?", "Unknown level 'X'. Use V, D, I, W, E or F, or W+ for W and above."

**Banners** (between the bar and the chip row, when they apply):
- Show context (info): "Showing 101 lines around line 18 422 · filter paused" + "Back to filter Esc".
- iOS stream stalled (warn): "No lines from iPhone 15 for 15 s. The log stream stalled." + "Re-pair iPhone…".

**Chip row** (36 px including room for focus rings, no wrap):
1. **Levels** group: six chips V D I W E F. Each shows the level badge letter, the level name (only at ≥ 1280 px region width) and the count (hidden under 860 px). aria-label "Verbose, 12 950 lines"; title "Verbose · ⌥V". All pressed by default. A zero count stays focusable. Counts follow the text and device filters but ignore the level filter.
2. Divider. **Devices** group: one chip per device with platform badge and name; pressed = shown.
3. Divider (only with tokens). **Active filters:** one token renders as a chip (`NOT` in `--err` and a dashed border for negations, mono key in `--text-2`, value in `--text`, a 24 px × "Remove filter NOT tag:chatty"). Two or more collapse into one "N filters" chip with a popover that lists each token with its own remove button.
4. Spacer, then the count "47 106 of 48 310 lines" and a ghost "Reset" (tooltip "Reset filter ⇧⌘F", only with a non-empty query). The count and Reset never leave the row; the chip area clips first.

#### Log grid (`role="grid"`, `aria-multiselectable="true"`, `aria-rowcount` = filtered total)

- **Header** (28, sticky, `--surface`): Platform (empty, aria-label), Time, Lvl, Tag, App / Device, PID–TID, Message. Each boundary has a 24 px hit-area resize handle (`role="separator"`, "Resize Tag column", value 40–400 px); a 1 px `--border` line shows on hover or focus. Keys on the handle: ←/→ 8 px, ⇧ 32 px, Enter or Home resets.
- **Columns:** `calc(max(18px, log × 1.3) + 10px) 13ch 3ch 18ch 20ch 11ch minmax(0, 1fr)`. With the drawer open: App / Device and PID–TID hide and Message is `minmax(24ch, 1fr)`.
- **Row** (a focusable row with roving tabindex; cells are gridcells): platform badge (title = device name), time `15:54:26.290` (meta), level letter in the level colour (700), tag, App / Device (meta: Android package, or `pid 1645` when unmapped; iOS shows the device name), PID–TID (meta; iOS shows the PID alone), message (`--text`, first search hit wrapped in `<mark>`). W/E/F rows get the tint and stripe. Selected rows get `--row-sel` and the accent bar. New rows flash `--accent-subtle` for 600 ms while following.
- **Marker row:** `--marker-bg`, marker borders top and bottom, 3 px marker stripe, 7 px left inset. Flag icon, "M2" (700), name, meta "15:54:26.581 · Pixel 8 Pro", and a ghost "Rename". The current marker has a 1 px marker ring.
- **Gap row:** dashed `--warn` top and bottom borders, 7 px inset, warning icon, "About 312 lines from iPhone 15 were dropped here. The viewer fell behind; exports will have a gap." and a ghost "Why?" that opens the drops popover.
- **Event row:** italic `--text-2`, 7 px inset, `plug` icon, "Pixel 8 Pro reconnected · 15:52:10.004".
- **Show context rows:** the target row has a 1 px dashed accent outline (2 px ring on focus). Rows outside the filter get `.ctx-dim`: plain `--bg`, no tint or stripe, and meta, level and message in `--text-2`.
- **Empty states inside the grid:**
  - No matches: tile `search-x`, "No lines match this filter", "0 of 48 310 lines in view. {cause}" and a specific fix button plus "Reset filter". Causes, in order: "All levels are turned off." → "Turn levels back on"; "Both devices are hidden." → "Show both devices"; "NOT tag:chatty hides every line here." → "Remove NOT tag:chatty"; "No retained line matches tag:x." → "Remove tag:x"; otherwise "No retained line matches the level and device chips."
  - After Clear: "Waiting for new lines…" / "The view was cleared. New lines appear here as they arrive."
  - Device streaming but silent: `loader` + "Waiting for the first lines from Pixel 8 Pro…" over 6 skeleton rows.
  - No source: "No logs yet" / "Start a device in Devices, or open a log file." + primary "Open Devices" + "Open log file…".

#### Status bar (`--status-h`, `.chrome`, top hairline, padding 0 12, gap 12; polite announcements at most once per 5 s)

- Left: one ghost button per device (platform badge, name, rate "842/s", "1.9k/s", "connecting…", "stopped" or "stalled"); clicking toggles that device in the filter. Then the drops button in `--warn` (warning icon, "312 lines dropped", `aria-haspopup="dialog"`).
- Right: "Lines 18 100–18 400 of 47 106" (only while Follow is off) and `·`; "10 selected" with a "Clear selection" × (only with a selection) and `·`; "Retained 48 310 of 500 000" and `·` (hidden under 1000 px); "Following" with an ok dot or "Not following" in `--text-2` (tooltip carries the retained text); `·`; a ghost button "⌘K Commands".
- **Drops popover** (320, opens upward): "312 lines dropped from iPhone 15" / "The viewer fell behind at 2.7k lines/s, so the bridge dropped the oldest unsent lines. The log shows a gap row where it happened, and exports will have the same gap. Resets on Clear." / "Jump to gap". If the gap has scrolled out of retention, a toast says "The gap has scrolled out of the retained lines".

#### Detail drawer (400, resizable 320–640 from its left edge; non-modal, focus stays in the grid)

- **Resize handle:** `role="separator"` on the left edge (`aria-orientation="vertical"`, value 320–640); ←/→ 8 px (⇧ 32 px), Home resets to 400; width persisted in `applogs-viewer.settings`.

- **Head** (48, `--chrome-raised`): filled level badge, level name (600), "· Line 18 422", then "Previous line ↑", "Next line ↓", "Close details Esc".
- **Body** (scrolls, padding 16, gap 20):
  1. Actions: "Copy line ⌘C", "Mark here M", "Show context C", "Bug report… ⇧⌘C".
  2. MESSAGE + "Copy message" icon: the full message in a card, mono at the log size, wrapped.
  3. JSON (when the message contains a parseable `{…}` object): disclosure button "Show JSON", "Copy JSON", and a focusable region "Message JSON" with pretty-printed JSON (keys `--accent`, strings `--text`, numbers `--lv-d`, booleans and null `--lv-f`, punctuation `--text-2`). Open by default.
  4. FIELDS (`<dl>`, 96 px label column, 28 px rows). Time "2026-10-14 15:54:26.598" with note "+17 ms after M2"; Device "iPhone 15 · iOS 18.2"; Platform; PID; TID ("—" on iOS); Tag; App / Device; Level "E (Error)". Hovering or focusing a row reveals "Show only …" (+) and "Hide …" (−) for Device, PID, Tag, App (Android) and Level.
  5. FILTER: "Only tag ExampleHeadset T", "Hide tag ExampleHeadset X", "Only this app P", "Only iPhone 15".
  6. NEAREST MARKER: flag, "M2 Pairing drops after OTA", "17 ms before this line", "Jump".
- Clicking a row selects it; an open drawer follows the selection and a closed one stays closed. ↵ or double-click opens it.

#### States

| State | What the user sees |
|---|---|
| Streaming (default) | Follow on, Pause off. The list is bottom-anchored and new rows arrive at the bottom. Rates and counts update at most 4 times per second. |
| Reading back | Follow off (scroll up, row selection, marker jump or context). The view is frozen; new lines keep arriving below. A jump pill floats bottom-centre, 16 px above the status bar: arrow icon, "**1 284** lines below" ("1 line below"), primary "Jump to latest", kbd End. A 56 px spacer below the last row keeps the pill from covering it. Status bar: "Not following" and the reading window "Lines 18 100–18 400 of 47 106". |
| Paused | Badge "Paused · 3 402 buffered", a 2 px `--warn` line at the top of the grid, and the pill "Resume to see **3 402** buffered lines" with primary "Resume" and kbd Space. When the buffer reaches the retention cap: "Buffer full · resuming skips to the newest lines". |
| Autocomplete | See "Interaction details". |
| Line detail | Drawer open, grid narrowed, markers visible in the list. |
| Bug report | Sheet open over a scrim, with the selected lines highlighted behind it. |
| iOS stream stalled | Sidebar row "Stalled 15 s" (always the stall threshold, default 15 s, not a running timer; cleared when the first new line arrives), status bar rate "stalled", stall banner in the query region, and the stall sheet (below) unless the stream is paused. |
| Parsing a file | Toolbar progress; the grid fills as the first rows parse. |
| Drop overlay | Scrim plus two 360×200 drop targets: "Open as new session" / "Keeps live evidence separate" and "Add to Live session" / "Merged by timestamp". Caption: ".logcat · idevicesyslog text · .txt / .csv / .json from this app". Invalid file: "Can't read .zip. Use .logcat, .txt, .csv or .json." |

**Stall sheet (Live logs)** (560, `role="dialog"`, focus on the primary): warning icon, "iOS log stream stalled", close. Body: "No lines from iPhone 15 for 15 s. The iPhone is still connected, but the log stream stopped. Usually the pair record is stale, or an old idevicesyslog process still holds the device." FIX IT: 1 "Unlock the iPhone." 2 "Click Re-pair iPhone." 3 "Tap Trust on the iPhone and enter the passcode." Helper: "Re-pair runs unpair + pair and stops stale streams. You'll tap Trust again." Footer: ghost "Keep waiting esc" and primary "Re-pair iPhone". Re-pair puts the device into "Connecting…" with the toast "Re-pairing iPhone 15…" / "Unpair, pair, then restart idevicesyslog. Keep the iPhone unlocked.", then "iPhone 15 re-paired" / "Streaming again · iOS 18.2". The full troubleshooting flow (progress, Advanced, Run it yourself) lives on the Devices screen.

### Devices

Frame: the shared sidebar with "Devices & setup" current. The main area is opaque (Solid) or chrome (Glass).

**Toolbar (52):** "Devices" (15/600) + "2 detected" + a scan note ("Scanned 2 s ago", then "Scanned just now"). Right: "Refresh" with kbd ⌘R (while scanning: spinner and "Scanning…"), and "Start all ready (n)" with kbd ⌘↵ (primary only when n ≥ 2; disabled at 0 with tooltip "No device is ready to stream"; otherwise tooltip "Start every ready device · ⌘↵").

**Body** (scrolls, padding 32 40, content max 880 centred, gap 16): intro "Plug a phone in with a USB data cable. Devices appear here within 2 s. Bundled: adb 35.0.2 · libimobiledevice 1.3.0." then the section label "Connected · 2".

**Device card** (`.card`, radius 12, padding 16, grid `40px 1fr auto auto`, gap 16, min height 88): a 40 px tile (`smartphone` icon, platform badge at bottom right), name (15/600) with mono meta ("Android 15 · 3A091FDJH00ABC"), a status badge (icon + text), the actions, and "More for {name}". The menu holds Setup guide (expands the platform checklist inside the card), Copy device info, Show raw device info / Hide raw device info (inline mono block), Re-pair iPhone (iOS) and Forget device. An expansion row spans the card under a top hairline for callouts, steppers and guides.

**States per device**

| State | Badge | Content and actions |
|---|---|---|
| Ready | ok `circle-check` "Ready" | "USB debugging allowed." Primary "Start streaming". |
| Needs Trust (iOS) | warn `triangle-alert` "Needs Trust" | Warn banner: **"Unlock iPhone 15, tap Trust This Computer, then enter the passcode."** / "This page updates by itself." / spinner "Waiting for Trust…". Buttons "Setup guide", primary "Check again", disabled "Start streaming" (tooltip "Trust this computer on the iPhone first"). |
| Connecting | info spinner "Connecting…" | Horizontal 4-step stepper: Found ✓, Authorized ✓, Starting logcat (spinner), Receiving lines (4); done joins are `--accent-fill`, todo joins `--border`. "Usually under 3 s." and "Cancel". iOS shows "Starting idevicesyslog…". |
| Streaming | ok pulsing dot "Streaming · 842 lines/s" | "Stop" and primary "Open logs". |
| Stalled (iOS) | warn `clock` "Stalled 15 s" | "Stop" and primary "Re-pair iPhone". Opens the stall sheet unless the stream is paused. |
| Unauthorized (Android) | warn | "Pixel 8 Pro hasn't allowed this computer. Unlock it and tap Allow on "Allow USB debugging?"." → "Try again". |
| Offline (Android) | warn | "Pixel 8 Pro stopped responding. Unplug the cable and plug it back in." → "Try again". |
| Disconnected | idle | "Pixel 8 Pro was unplugged at 15:52:08. Plug it back in to continue." → "Reconnect" + switch "Reconnect automatically". |
| Driver missing (Windows, iOS) | err "Driver missing" | Muted card "No iPhone detected" / "Needs Apple's USB driver before an iPhone can show up here." plus the page banner below. |

**No device detected:** centred block (max 560): 48 px `usb` tile, "No phone detected" (16/600), "Watching for devices. Plugged-in phones show up here within 2 s.", spinner "Watching…". Then two checklist cards side by side:
- Android: 1 "Turn on Developer options" / "Settings → About phone → tap Build number 7 times"; 2 "Turn on USB debugging" / "Settings → System → Developer options"; 3 "Use a data cable" / "Charge-only cables are common. If nothing happens, swap the cable or try a port that is not on a hub."; 4 "Tap Allow on the phone" / ""Allow USB debugging?" → tick Always allow from this computer".
- iPhone: 1 "Plug in and unlock the iPhone"; 2 "Tap Trust This Computer, then enter the passcode"; 3 "Windows only: install Apple Devices" / "It contains Apple's USB driver." + link button "Get Apple Devices".
- Disclosure "Still not showing?": "Try another USB port (not a hub) · Restart the phone · On Windows, install your phone maker's USB driver · Settings → Devices → Restart adb".

**Drop strip** (dashed dropzone, 96 px; 140 px in the empty state): `upload` icon, "Or open a log file: drop **.logcat, .txt, .csv or .json** here", "Browse…" with kbd ⌘O. In the empty state add the caption "idevicesyslog text and Android Studio .logcat files are supported." After a drop: "Opening {file} as a new session…" with "Open logs".

**Windows, Apple Devices missing:** native caption bar, no traffic lights. An error banner heads the list: **"Apple Devices isn't installed"** / "iPhones can't be detected on Windows without Apple's USB driver. Install Apple Devices from the Microsoft Store, then check again." Actions: link button "Install Apple Devices" (`external-link`) and ghost "Check again" (result line "Checked just now. Apple Devices still isn't installed."). The iPhone card becomes the driver-missing card.

**Stall sheet (Devices)** (560, centred over a scrim; the iPhone card shows "Stalled 15 s"):
- Head: warning icon, "iOS log stream stalled", close.
- Body: the same paragraph, FIX IT steps and helper as the Live logs sheet.
- After "Re-pair iPhone" the helper becomes a progress checklist: "Removing old pairing" (done), "Pairing · tap Trust on the iPhone" (waiting), "Restarting stream" (pending). On success all are done, an ok badge "Logs are flowing again." appears, and the sheet closes 1.5 s later. Failure line: `circle-x` "Pair failed: device locked. Unlock the iPhone and try again."
- Disclosure "Advanced": "Unpair only" / "Deletes this computer's pair record." and "Pair only" / "Shows the Trust prompt again." Each reports a result line: busy "Unpairing…" (Unpair only) or "Waiting for Trust…" (Pair only), ok "Pair record deleted. Click Pair only or Re-pair iPhone." or "Paired. iPhone 15 trusts this computer.", fail as above.
- Disclosure "Run it yourself": a "Terminal" card listing `idevicepair unpair`, `idevicepair pair` and `pkill -f idevicesyslog`, each with its own copy button, plus "Copy commands" for all three. Then "Still stuck: restart the iPhone. On a Mac, run `sudo killall usbmuxd`."
- Fine print: "This sheet stays closed while you have paused the stream. The sidebar shows "Stalled" instead."
- Footer: ghost "Keep waiting" and primary "Re-pair iPhone".

**Card menu rules:** Re-pair from a card in Needs Trust shows the toast "Trust this iPhone first" / "Tap Trust This Computer on the iPhone, then use Check again." and highlights the card. With the driver missing: "Install Apple Devices first" / "iPhones need Apple's USB driver on Windows before they can be paired." Forget shows "{name} forgotten" / "Plug it back in to add it again."

### Onboarding

Full window, no sidebar. The root never wraps. Stacked layouts (Onboarding < 900 px, Settings < 760 px) only occur in the mockup canvas or embeds, because the minimum window is 1100×700; implement them only if the minimum width ever drops. Below 900 px it becomes a column: the rail sits on top at its natural height (steps in a row, sublabels hidden) and the content fills the rest, with the footer pinned.

**Rail** (280, `.chrome-side`, right hairline): traffic-light header (52); app mark (32 px violet waveform glyph + "AppLogsViewer" 15/600); a vertical stepper of 52 px rows (step dot done ✓ / current / number, label 13/500, sublabel 12 `--text-2`, 2 px joins). Steps: Welcome · "What it does"; Prepare devices · "Android and iPhone"; Appearance · "Theme and text size"; Ready · "Start streaming". The current step has `aria-current="step"`; done steps are buttons that go back. Bottom: "Step 2 of 4". A polite live region announces step changes.

**Content:** column max 640 (920 on step 3), margin-left 80, padding-top 88. **Footer** (72, top hairline, padding 0 40): ghost "Skip setup" (hidden on step 4) at left; "Back" (hidden on step 1) and the primary at right. The primary shows kbd ↵ on steps 1–3, and Enter advances when focus is not on a control.

**Step 1, Welcome.** Title "See Android and iPhone logs in one place" (`--title-fs`: 20 at S, 22 at M, 26 at L; every onboarding step title uses the same token). Three rows with a 32 px icon tile and 15 px text: `usb` "Stream logs live over USB from Android and iPhone, merged in one view."; `flag` "Mark the moment a bug happens with one key."; `file-text` "Copy a clean bug report for Jira in one click." Idle badges: "macOS · Apple Silicon", "Windows x64", "Android 8+ via adb", "iOS via libimobiledevice". Note: "adb and libimobiledevice are built in. iPhones on Windows also need Apple Devices." Primary "Get started".

**Step 2, Prepare devices.** Title "Prepare your devices" / "Pick what you test on. Steps tick green as we detect them." Two toggle cards in two columns (gap 40), 80 px high, radius 12: "Android" / "Pixel, Galaxy and other Android 8+ phones" and "iPhone" / "iOS 15 or later", both pressed by default. Pressed: accent border plus a 1 px accent ring, `--accent-subtle` fill, check icon top right. Below, the checklist of each pressed platform side by side (the Devices empty-state copy), ticking live: Android 1–3 done and 4 waiting ("Waiting for you to tap Allow on the phone…"), then all done with an ok badge "Pixel 8 Pro detected · Android 15"; iPhone step 1 done and step 2 waiting ("Waiting for Trust…"). With no platform pressed: "Pick Android, iPhone or both to see the steps. You can also continue without a device." Primary "Continue without a device", which becomes "Continue" once a device is detected.

**Step 3, Appearance.** Title "Make it readable" / "You can change all of this later in Settings." Grid `1fr 320px`, gap 32. Every control restyles the whole window immediately.
- Theme: Light | Dark | System. Help: "Follows macOS · Dark now", "Always dark." or "Always light."
- Material: Solid | Glass. Help: "Glass makes the window chrome translucent on macOS. Logs stay opaque." On Windows Glass is disabled with "Glass is available on macOS."
- Interface size: S | M | L. Help: "Sidebar, toolbar and menus."
- Log text size: "10 to 20 px. Applies to every log line." A slider with its value ("13 px") and, beside it, a 44 px sample box showing one log line at the chosen size and log font (time, "I" in the Info colour, "BluetoothGatt", "Connected to Pixel Buds Pro", ellipsis). Under the control: "In the app: ⌘− ⌘= ⌘0".
- Switch "Hyperlegible fonts" / "Atkinson Hyperlegible: clearer 0/O and 1/l/I."
- Preview card (320 wide, `aria-label="Preview"`): chips "W 412 warnings" and "E 37 errors", then eight log rows and the M2 marker row at the chosen size, with no App or PID columns.

**Step 4, Ready.** Title "You're set". Detected: a 560 card with the device tile, "Pixel 8 Pro is ready", mono "Android 15 · 3A091FDJH00ABC" and an ok badge "Ready" (no button inside the card). Not detected: "No device yet" / "Plug in a phone and finish the steps in Devices, or open a saved log file instead." + "Open a log file… ⌘O". Cheat sheet "Shortcuts worth learning", 3×2: M Mark the moment · Space Pause / resume · ⌘F Filter · ⌘K Commands · ⇧⌘C Copy as bug report · ⌘/ All shortcuts. Note: "Single-key shortcuts work when the log list has focus. ⌃⌥M marks from anywhere." (until the global-shortcut plugin ships: "⌃⌥M marks while this window is focused.") The footer has a single primary: "Start streaming" (to Live logs) or, with no device, "Open Devices".

### Settings

A separate 960×680 window (radius 12, `--shadow-lg`). Below 760 px the nav stacks on top (max 240 px). Changes apply live; there is no Save. The footer (`--chrome-raised`, top hairline) has a single primary "Done" that closes the window; the red traffic light also closes it.

- **Nav** (200, `.chrome-side`): title band 52 with "Settings" centred; input "Search settings" (filters the nav by section name and keywords, jumps to the first match, shows "No settings match your search."); `<nav aria-label="Settings sections">` with Appearance (`palette`), Log view (`rows-3`), Devices (`smartphone`), Shortcuts (`keyboard`), General (`sliders-horizontal`), Export (`download`) and About (`info`), the current one `aria-current="page"`; footer "AppLogsViewer 1.4.0".
- **Content** (`--bg`, scrolls, padding 28 32): title + subtitle, then groups (section label + card). **Row:** min height 52, padding 12 0, gap 24, hairline between rows; left label 13/500 and help 12 `--text-2` (max 380); control right-aligned. Every switch has a `<label for>` so the whole label toggles it.

**Appearance** / "Changes apply right away."
- Preview card (min 150; 5 rows including the M2 marker, chip row "W 10", "E 2", token NOT tag:chatty, "failed" highlighted, "5 of 47 106 lines").
- Theme and material: Theme · "Dark is easier on the eyes in dim labs." → Light | Dark | System (System adds "Follows macOS · Dark now"). Material · "Glass makes the window chrome translucent. Logs, menus and inputs stay opaque." → Solid | Glass, with the note "Uses Solid while macOS Reduce transparency is on. Windows: Solid only."
- Text: Interface size · "Sidebar, toolbar and menus." → S | M | L. Log text size · "Also ⌘= / ⌘− / ⌘0 in the log view." → slider + "13 px" + "Reset". Fonts · "Atkinson Hyperlegible makes 0/O and 1/l/I easier to tell apart." → Standard | Hyperlegible.
- Accessibility: Increase contrast · "Uses stronger borders and secondary text." → System | On | Off. Reduce motion · "Turns off arrival highlights and sheet animations." → System | On | Off.

**Log view** / "How lines look in the log list."
- The same preview card, which shows tint, highlight, wrap and line colour as they change.
- Rows: Row density · "Compact fits more lines. Comfortable is easier to scan." → Compact | Comfortable (1.4× or 1.6× line height). Wrap long messages · "Off keeps one line per entry." (off). Tint warning and error rows (on). Color whole line by level · "Off keeps message text neutral. The level letter always shows." (off). Highlight filter matches (on). Arrival highlight · "A 0.6 s tint on new lines. Off when Reduce motion is on." (on; disabled while Reduce motion is On).
- Columns: "Drag to reorder, or use the arrow buttons. Message is always shown." One row per column: grip, checkbox, name, "Move {name} up" and "Move {name} down" (`aria-disabled` at the ends, so focus stays). App / Device carries the note "Android: package from adb shell ps every 5 s". Message is last, always on and fixed ("Always shown"). Button "Reset columns".
- Time: Timestamp, with a live example ("15:54:26.290") → Time | Date and time | Since first marker ("+00:43.170").
- Highlight rules: "Lines that match a rule get a colored stripe. Use plain text or /regex/." Each rule row: enable switch, pattern input (an invalid regex is flagged), colour select (Violet, Blue, Green, Amber, Red) and delete. Button "Add rule". Empty: "No rules yet. Add one to color lines you care about." Defaults: `FATAL EXCEPTION` Red, `/time(d)? ?out/i` Amber, `ExampleHeadset-9B20` Violet. A matching row's 3 px stripe takes the rule colour; the selection bar still wins, and the level letter and tint are unchanged.

**Devices** / "adb and libimobiledevice ship with the app."
- Detection: Detect devices automatically (on). Start streaming when a ready device is plugged in (off). Reconnect after the cable is replugged (on).
- Android: Bundled adb (mono path and "35.0.2") → "Restart adb" (result "Restarted just now. The adb server is listening on port 5037."). Map PIDs to app names · "Runs adb shell ps every 5 s to fill the App column." (on; off says "Off. The App column shows the PID only."). PID to package polling interval · "Shorter is fresher. Longer costs the phone less CPU." → 2 s | 5 s | 10 s | 30 s (disabled while mapping is off).
- iOS: Bundled libimobiledevice (mono path and "1.3.0"). Restart the iOS stream after silence of · "The bridge restarts idevicesyslog after 15 s without lines." → number input + "s". Pairing · "Fixes most "no logs" problems. You'll tap Trust again." → "Re-pair iPhone" and an "Advanced" disclosure with "Unpair only" / "Deletes this computer's pair record." and "Pair only" / "Shows the Trust prompt again."; a status line reports progress and the result ("Re-pairing iPhone 15: unpair, pair, restart idevicesyslog…" then "Paired. If the iPhone asks, tap Trust, then start streaming again."). Apple Devices driver · "Needed on Windows only." → ok badge "Installed" + "Check again", or err badge "Not installed" + secondary "Install" (`external-link`).
- Markers: Mark crashes automatically · "Adds a red marker on FATAL EXCEPTION or when the app under test exits." (off). App under test → input "com.example.headset, ExampleHeadset".
- Guides: Setup guides · "Step-by-step pages for QA testers." → links "Android setup guide", "iPhone setup guide", "Troubleshoot iOS streaming".

**Shortcuts** / "Single-key shortcuts work only while the log list has focus."
- Single-key shortcuts · "M, Space, J/K and others. Turn off if they clash with your screen reader." (on).
- Global marker shortcut · "Works while another app is in front, e.g. when your hands are on the phone." → kbd ⌃ ⌥ M + "Change". Recording shows an accent-ringed field "Press the new keys, Esc to cancel"; it needs at least one modifier. This row is hidden until the global-shortcut plugin ships.
- "Search shortcuts" (matches action, group, note and key names such as "cmd", "alt", "enter"). Help: "While recording, every key is captured, including Tab. Press Escape to cancel." A status line reports the result ("Toggle follow set to ⌥ F.", "Recording cancelled. Toggle follow is unchanged."). Then "⌘ is Ctrl on Windows." plus "Rows tagged Single key work only while the log list has focus." (or "Single-key shortcuts (M, Space, J/K…) are off.") and a count "{shown} of {total} shortcuts".
- Table grouped Stream · Filter · Log list · Markers · View · App. Each 36 px row: action (13) with an optional note, key alternatives joined by "or", a "Single key" tag (dimmed when single keys are off), a warn badge "Also used by {action}" on a conflict, "Reset shortcut for {action}" when overridden, and "Change shortcut for {action}" (pencil). The content is the keyboard map below.

**General**
- Startup and memory: On launch → Devices | Live logs (opens the empty Live session, ⌘1). Live lines kept in memory · "Older lines are discarded to bound memory. About 0.3 KB per line (500 000 ≈ 150 MB)." → 100 000 | 250 000 | 500 000 | 1 000 000 (help updates: 30, 75, 150, 300 MB; the viewer measures about 290 B per line). Confirm before clearing · "Clear can be undone for 10 s either way." (off). Query history · "Recent filters shown when the bar is empty." → number input "50".
- Saved filters: one row per preset with name, kbd ⌥n, mono query, "Rename {name}", "Move {name} up", "Move {name} down", "Delete {name}" (danger colour). Empty: "No saved filters. Save one from the query bar with ⌘S." + "Restore examples".
- App: Updates · "Checks GitHub releases on launch." (on) → "Check now" (then "You're on 1.4.0, the latest release. Checked just now."). Onboarding → "Show onboarding again".

**Export**
- Files: Default format → Text | CSV | JSON, help "Terminal-style, easy to share" / "Open in Excel / Numbers" / "Re-import into this viewer". Default lines → Filtered view | All lines | Around marker. Around marker window → "30" s before, "10" s after. File name → mono input `{session}_{device}_{yyyy-MM-dd_HHmm}` (`{device}` is the single device name with spaces replaced by "-", or "2-devices" when both platforms are in the export; for file sessions it is omitted with its underscore) with preview "HS-1234-OTA-pairing_Pixel-8-Pro_2026-10-14_1554.txt". Folder → "~/Downloads" + "Choose…".
- Contents: Include header · "Devices, OS, app version and filter at the top of the file." (on). Include markers as lines (on).
- Bug reports: Bug report format → Markdown | Jira | Plain text. Bug report max lines → "200".

**About:** card with the 48 px app glyph, "AppLogsViewer" (17/600) and "Version 1.4.0 · macOS Apple Silicon". Bundled tools · "adb and libimobiledevice" → "adb 35.0.2 · libimobiledevice 1.3.0". Buttons: "Release notes", "Copy diagnostics" ("Copied diagnostics (2.1 KB): versions, devices, settings. No log lines."), "Report a problem", "Licenses", "Show logs folder". Closing line: "Made for QA testers and developers who test Android and iPhone apps over USB."

### Foundations sheet

A 1440×2640 reference sheet that follows the theme switch (Dark | Light in its header); the palette, level and glass panels always show both themes. Sections in order: header ("AppLogsViewer foundations" / "Geist UI · JetBrains Mono logs · one violet accent · WCAG 2.2 AA measured in both themes"), dark palette, light palette, log levels with measured contrast (dark, then light), type scale, spacing / radius / elevation / focus ring, controls in every state (buttons, icon buttons, segmented, switch, slider, input, select, query bars idle / focused / invalid, kbd, tooltip, inline tokens), menu / toasts / jump pill, stepper dots and checklist items, drop overlay, banners, chips and status badges, log rows (V–F, hover, selected with match, marker, gap, event), sidebar rows and nav items, device error callouts, dropzone, window chrome (macOS: "traffic lights sit in the sidebar header. Toolbar is 52 px."; Windows: "native caption buttons"; note "Windows keeps the native caption bar for Snap Layouts. The theme syncs via setTheme."), log area states (waiting, no match, no source, parsing), and glass material ("Dark left, chrome alpha 0.80 · light right, alpha 0.78."). The sheet adds `forced-colors: active` rules so pressed, selected and focus states survive Windows high contrast; the same block is at the end of the foundation CSS.

## Interaction details

### Query grammar

| Form | Meaning |
|---|---|
| `level:E` | Exactly E. Names also work: `level:error`, `level:assert` (= F). |
| `level:W+` | W and above. |
| `level:D,I` | D or I. `level:none` hides every level (written by the chips when all are off). |
| `dev:none` | Hides every device (written by the chips when all are off). |
| `tag:X` | Tag contains X (case-insensitive substring). |
| `app:X` | App contains X. On iOS lines, which have no package, `app:com.example.headset` matches when the tag contains the last dotted segment ("headset"). |
| `pid:N` | Exact PID. |
| `dev:pixel`, `dev:"iPhone 15"` | Device by short id, platform, or name substring (spaces ignored). |
| `plat:android`, `plat:ios` | Platform. |
| `-key:value`, `-word` | Negates a field token or a bare word. Negated phrases and regexes are not supported in v1. |
| `"phrase"` | Message contains the phrase. |
| `/regex/` | Message matches the regex. |
| bare word | Message contains the word. With ".*" on, bare words are regexes. Case follows "Aa". |

**Combination:** the same key ORs (`tag:a tag:b` is a or b); different keys AND; every negation must not match; every text term must match. Example: `app:com.example.headset level:E+` is "from the app under test AND error or fatal". More: `tag:BluetoothGatt tag:bt_stack` = either tag. `tag:BluetoothGatt app:com.example.headset` = that tag AND that app. `level:E level:W` = E or W (the union). Two bare words both must match.

**Chips and text are one model.** Level and device chips write or remove a single `level:` / `dev:` token (`level:W+` when the set runs contiguously up to F, otherwise a list such as `level:D,I,E`; `dev:pixel`). The chips read their pressed state back from the query. Row and drawer actions rewrite the query: "Only tag X" replaces positive `tag:` tokens, "Hide tag X" appends `-tag:X`, "Only this app" replaces positive `app:` tokens (iOS lines use the tag).

**Errors** keep the last valid filter applied (see Query region). A token being typed (the autocomplete is open on it) is not applied until it is accepted.

### Autocomplete

- Opens when the token under the caret is `key:` or `-key:` plus a prefix; accepting replaces only that token and keeps the caret after it. The popover (`.menu`, `role="listbox"`, `min(480px, 100%)` wide, max 360 high) sits 4 px under the bar, aligned to the field's left edge.
- Group 1 depends on the key, each item with its platform badge or level badge and a count or description: Tags ("Tags · 3 matches": **Blu**etoothGatt 3 102, **Blu**etoothAdapter 211, **blu**etoothd 1 040), Apps, Levels (V…F plus W+ "Warning and above", E+ "Error and above"), Devices, Platforms, Processes (PIDs seen in the session). Matching is a case-insensitive prefix; the matched part is bold.
- Group 2: Saved filters (name, mono query, kbd).
- A static Syntax strip: `level:W+` `tag:` `app:` `pid:` `dev:` `-tag:` `/regex/` `"phrase"`. Footer: "↑↓ navigate · Tab complete · ↵ apply · esc close".
- Keys: ↑↓ move the active option (wraps), Tab or ↵ accept, Esc closes. Accepting a value writes `key:value ` and closes; accepting a preset replaces the query. With no match: "No tags match 'Blx'. Press ↵ to search messages for "Blx"." and ↵ turns the prefix into a message search.

### Saved filter presets

| Key | Name | Query |
|---|---|---|
| ⌥1 | BLE pairing | `tag:BluetoothGatt tag:bt_stack tag:bluetoothd tag:PairingManager level:D+` |
| ⌥2 | Audio routing | `tag:AudioFlinger tag:mediaserverd "route"` |
| ⌥3 | Errors from app | `app:com.example.headset level:E+` |
| ⌥4 | Hide system noise | `-tag:chatty -app:system_server -tag:SpringBoard` |

- Apply from the sidebar, the query bar menu, autocomplete, the palette or ⌥1…⌥9. Applying replaces the whole query and leaves context mode.
- ⌘S saves the current (normalised) query. The new preset gets the next free ⌥ key (up to 9) and a name derived from its first two tokens ("NOT tag:chatty + level:W+ +1", max 34 characters). It opens in rename mode in the sidebar. Toast: "Saved filter '{name}'" / "{query} · ⌥5 · type to rename it in the sidebar". An empty query gives "Nothing to save" / "Type a filter first, for example level:W+ tag:bt_stack."
- Settings → General manages rename, order (which reassigns ⌥ keys) and delete. Presets are global, not per session.

### Follow, pause and the jump pill

- **Follow** pins the view to the newest line. It turns off when the user scrolls up, selects a row, jumps to a marker or gap, or opens context. End, ⌘↓, the Follow button or "Jump to latest" turn it back on and clear context.
- **Pause** stops draining into the view; frames keep arriving into a buffer. The badge shows the buffered count. Resume drains the buffer. When the buffer passes the retention cap, the oldest buffered lines are discarded and the pill says "Buffer full · resuming skips to the newest lines".
- The jump pill shows only when not following or paused, and never during context. Paused wins over new lines.

### Selection

- Click selects one row; ⇧-click extends from the anchor; ⌘-click toggles a row. ↑↓ or J/K move; ⇧↑↓ extends. ⌘A selects all shown lines. Selecting stops Follow.
- Marker and gap rows ride along in a range selection but are not counted ("10 selected" counts log lines).
- ⌘C copies the selected lines as `{HH:MM:SS.mmm} {L} {tag} {message}`, one per line, unless the user has selected text inside a row (then the normal text copy runs). Toast "Copied 10 lines".
- Esc backs out one level: palette → sheet → stall sheet → menu → autocomplete → rename → title edit → context → drawer → selection.

### Markers

- **Add:** M (log list), ⇧M (add and name), ⌃⌥M (global), the toolbar Mark button, "Mark here" in the drawer, or the palette. With a selection or open drawer the marker goes right after that line and takes its time and device; otherwise it goes at the newest line with the current time.
- **Numbering:** M1, M2… per session, never reused. Default name "New marker". Toast "Marker M4 added" / "15:54:31.208 · press M again to add another" with action "Rename".
- **Navigate:** ] and [ cycle through markers (wrapping) and make the target current (sidebar `aria-current`, a ring on the row). Sidebar rows and palette items jump. The drawer shows the nearest marker and the time delta.
- **Edit:** rename inline in the sidebar or from the row's "Rename". Delete from the sidebar with an Undo toast for 10 s ("Marker M2 deleted" / name / "Undo"; then "Marker M2 restored").
- **Lifetime:** markers survive retention trimming and Clear. They appear in exports when "Include markers as lines" is on, and in bug reports.
- **Automatic crash markers** (Settings, off by default) add a red marker on `FATAL EXCEPTION` or when the app under test exits.

### Show context

C (or the drawer's "Show context") suspends the filter around the focused line and shows ±50 lines. The target is outlined, rows outside the filter are `.ctx-dim`, and the info banner says "Showing N lines around line 18 422 · filter paused" with "Back to filter Esc". Follow turns off and the jump pill hides. Changing the query, a preset or a row filter action leaves context.

### Bug report

- **Open:** ⇧⌘C, the toolbar button, the drawer or the palette. Without a selection: toast "Select lines first" / "Click a line, then ⇧-click another to select a range."
- **Sheet** (760×640, `role="dialog"`, `aria-modal`, focus trapped, focus starts in Title, Esc closes, focus returns to the opener). Head: "Copy as bug report" + "10 lines · 15:54:24.611 → 15:54:26.598 (2.0 s) · Pixel 8 Pro, iPhone 15" + close. Body grid `280px 1fr`, gap 20:
  - Form: Title (prefilled with a marker inside the selection, else the nearest marker); Format Markdown | Jira | Plain text (radio group, arrow keys); Include: Devices and OS · App version (`com.example.headset 3.8.1 (412)`) · Time range · Active filter (mono, the last valid query or "none") · Markers in range · Dropped-lines note; Lines before the selection 0 | 10 | 50.
  - Preview: label + "2.1 KB · 10 lines", and a focusable `pre` region "Bug report preview" that updates live.
  - Footer: "Paste into Jira or GitHub. Up to 200 lines (Settings → Export)." Ghost "Cancel esc", "Save as .md…" (".txt…" for Jira and Plain), primary "Copy ⌘↵".
- **Copy** closes the sheet and shows "Bug report copied" / "10 lines · 2.1 KB · Markdown".
- **Over the max lines:** the footer note becomes a warning "Large report (1 204 lines). Consider Save evidence bundle." and a "Save evidence bundle…" button appears. Copy always copies all lines; the warning is advisory.
- **No markers:** the Title is empty and the report heading is "Bug report". Export "Around marker" is disabled with the reason "Add a marker first". The "Since first marker" timestamp shows "+00:00.000" until a marker exists and uses the earliest remaining marker after a delete.

**Markdown template.** Sections are omitted when unchecked or empty. Body lines are `{HH:MM:SS.mmm} {A|i} {L} {tag padded to 15} {message}`; the lines before the selection are log lines only; markers and gaps inside the selected range appear as `--` lines when their Include box is on. The device line adds the serial for Android only.

~~~markdown
## {title}

**Devices**
- {device} · {OS}[ · {Android serial}]

**App** {app and version per device, joined with " · "}
**Time range** {yyyy-MM-dd} {first} → {last} ({seconds} s)
**Filter** `{last valid query, or none}`
**Markers** {Mn name @ HH:MM:SS.mmm, …}
**Note** About {n} lines from {device} were dropped around {HH:MM:SS.m}.

```text
{lines}
-- ~{n} lines from {device} dropped here --
-- {Mn} {name} @ {HH:MM:SS.mmm} --
```
_Captured with AppLogsViewer {version}_
~~~

Worked example (selection #18–#27 of the sample session, shortened here to five of its ten lines):

~~~markdown
## Pairing drops after OTA

**Devices**
- Pixel 8 Pro · Android 15 · 3A091FDJH00ABC
- iPhone 15 · iOS 18.2

**App** com.example.headset 3.8.1 (412) · ExampleHeadset 3.8.1 (412)
**Time range** 2026-10-14 15:54:24.611 → 15:54:26.598 (2.0 s)
**Filter** `-tag:chatty`
**Markers** M2 Pairing drops after OTA @ 15:54:26.581
**Note** About 312 lines from iPhone 15 were dropped around 15:54:25.9.

```text
15:54:24.611 A W BluetoothGatt   onClientConnectionState() status=133 clientIf=7 device=F4:12:FA:3C:9B:20
15:54:25.733 i W bluetoothd      Pairing request from F4:12:FA:3C:9B:20 timed out after 1.0 s
-- ~312 lines from iPhone 15 dropped here --
15:54:26.290 A E PairingManager  Pairing failed: GATT_ERROR (133) after OTA reboot, giving up after 3 attempts
-- M2 Pairing drops after OTA @ 15:54:26.581 --
15:54:26.598 i E ExampleHeadset  BLEConnectionError {"domain":"CBErrorDomain","code":14,"peer":"F4:12:FA:3C:9B:20","attempt":3,"fw":"3.8.1"}
```
_Captured with AppLogsViewer 1.4.0_
~~~

**Jira variant:** `h2. {title}`, `*bold*` labels, `* ` bullets, the filter as `{{query}}`, and `{code}` … `{code}` around the lines. **Plain text:** the same content without markup, ending with a blank line and "Captured with AppLogsViewer {version}".

### Export

- **Menu** (340, under Export, ⌘E). FORMAT (radio items with a check): "Plain text" / "Terminal-style, easy to share"; "CSV" / "Open in Excel / Numbers"; "JSON" / "Re-import into this viewer". LINES: "Filtered view" 47 106; "All lines" 48 310; "Around marker M2" −30 s / +10 s (the current marker); "Selection" 10 (disabled without a selection).
- **Notes** (warning icon, only when they apply): "312 lines never reached the viewer (server buffer overflow); the export has a gap where they occurred." and "Exports retained lines only: 82 114 older lines were discarded (live view keeps the newest 500 000)."
- **Buttons:** "Save evidence bundle…" and primary "Export 47 106 lines…" (or "Export around M2…").
- **Files** use the Settings name template and default format. The TXT, CSV and JSON formats stay byte-compatible with today's exports so they re-import. Byte-compatible applies to the line format only. The header and marker lines are written as TXT lines starting with "# " and CSV rows whose first cell starts with "#", and the TXT and CSV parsers skip both. In JSON the header adds top-level keys (`session`, `devices`, `filter`, `markers`, `gaps`) that the importer ignores. Exports keep today's level letters (A for assert) and emoji platform markers; the UI uses F. If the parsers do not change in the first PR, Include header and Include markers default to off.
- **Evidence bundle** (⇧⌘E): one viewer-JSON file with all retained lines of the session plus the session name, devices, active filter, markers and drop gaps. It re-imports as a session.
- Toasts: "Exported 47 106 lines" / "{file name}" / "Show in folder"; failure "Export failed" / "Disk is full. Free some space and try again." / "Retry" (`role="alert"`, stays).

### Clear and undo

- ⌘⌫, the toolbar Clear or the palette. It empties the session view, keeps markers, resets level counts and drop counts, clears selection, drawer and context, and turns Follow on.
- Toast "View cleared · 48 310 lines" / "Undo within 10 s" / "Undo" (10 s). ⌘Z or Undo restores the cleared lines merged with anything that arrived since, and restores the drop count ("View restored").
- With "Confirm before clearing" on, a confirmation comes first. "New session" (⇧⌘N) keeps the old session in SESSIONS instead of clearing it.

### Command palette

- ⌘K or the sidebar trigger. A 560 wide dialog at top 96, radius 12, over a light scrim; the page behind is inert; focus trapped; Esc closes and returns focus.
- Input "Type a command or search…" with kbd esc. Items filter by a substring of label or group; empty: "No commands match." Footer "↑↓ navigate · ↵ run · esc close".
- Groups: **Actions** (Add marker M, Pause stream / Resume stream Space, Copy as bug report ⇧⌘C, Export… ⌘E, Clear view ⌘⌫, Open log file… ⌘O); **Saved filters** (each preset with its ⌥ key); **Devices** (Stop / Start Pixel 8 Pro, Re-pair iPhone 15, Open Devices ⌘2; on the Devices screen also Start iPhone 15, Start all ready (n) ⌘↵, Refresh devices ⌘R); **View** (Toggle theme ⇧⌘L, Larger log text ⌘=, Smaller log text ⌘−, Hide sidebar / Show sidebar ⌘B, Settings… ⌘,); **Markers** (each marker).

### Toasts

Bottom right, 16 px above the status bar (shifted left of an open drawer), 356 wide, inside one persistent polite live region. Auto-hide after 5 s, or 10 s when they carry an action; hover or focus pauses the timer; errors use `role="alert"` and stay. Each has a dismiss button "Dismiss notification".

| Event | Icon | Title | Description | Action |
|---|---|---|---|---|
| Marker added | flag (marker colour) | Marker M4 added | 15:54:31.208 · press M again to add another | Rename |
| Marker deleted | trash | Marker M2 deleted | {name} | Undo |
| Cleared | trash | View cleared · 48 310 lines | Undo within 10 s | Undo |
| Copied lines | check | Copied 10 lines | — | — |
| Bug report | check | Bug report copied | 10 lines · 2.1 KB · Markdown | — |
| Filter saved | check | Saved filter '{name}' | {query} · ⌥5 · type to rename it in the sidebar | — |
| Device stopped | info | Stopped Pixel 8 Pro | Lines already captured stay in this session. | — |
| Re-pair | check | iPhone 15 re-paired | Streaming again · iOS 18.2 | — |
| Device info | check | Copied device info | Pixel 8 Pro · Android 15 · 3A091FDJH00ABC | — |
| Exported | check | Exported 47 106 lines | HS-1234-OTA-pairing_2-devices_2026-10-14_1554.txt | Show in folder |
| Error | alert (err) | Export failed | Disk is full. Free some space and try again. | Retry |

### Drops display

The backend reports drops per platform (`dropped` frames). The UI shows them in five places, all reset by Clear: the status bar button and popover, the sidebar device row ("312 dropped"), an inline gap row placed where the drop was reported, the export menu note, and the bug report note and `--` line.

### Menus, popovers and tooltips

- Menus close on Esc, on choosing an item, and on any press outside them; their trigger toggles them. Menu items use the 2 px inset accent bar for the active item; radio items show a check.
- Tooltips open after 400 ms on hover and at once on keyboard focus, stay open while hovered, and Esc hides them until the pointer or focus moves. Every icon-only control has an aria-label and a tooltip that includes its shortcut.

## Keyboard map

⌘ = Ctrl on Windows; ⌥ = Alt; ⌃ = Ctrl. † = single key: works only while the log list has focus, never in a text field, and can be switched off in Settings → Shortcuts. Every shortcut can be rebound there.

| Area | Action | Keys |
|---|---|---|
| App | Command palette | ⌘K |
| App | Settings | ⌘, |
| App | Keyboard shortcuts | ⌘/ or ?† |
| App | Logs / Devices | ⌘1 / ⌘2 |
| App | Toggle sidebar | ⌘B |
| App | Open log file | ⌘O |
| App | New session | ⇧⌘N |
| Stream | Pause or resume | Space† (the toolbar button works anywhere) |
| Stream | Follow on, jump to latest | End or ⌘↓ |
| Stream | Toggle follow | F† |
| Stream | Oldest retained line | Home or ⌘↑ |
| Stream | Clear view / undo clear | ⌘⌫ / ⌘Z |
| Filter | Focus query bar | ⌘F or /† |
| Filter | Match case / regex | ⌥C / ⌥R |
| Filter | Toggle level V D I W E F | ⌥V ⌥D ⌥I ⌥W ⌥E ⌥F |
| Filter | Apply saved filter 1–9 | ⌥1…⌥9 |
| Filter | Save current filter | ⌘S |
| Filter | Reset filter | ⇧⌘F |
| Filter | Autocomplete move / accept / close | ↑↓ / Tab or ↵ / Esc |
| Log list | Move selection | ↑↓ or J K† |
| Log list | Extend selection | ⇧↑↓, ⇧-click |
| Log list | Toggle a row in the selection | ⌘-click |
| Log list | Select all shown | ⌘A |
| Log list | Open or close the detail drawer | ↵ or double-click / ⌘J |
| Log list | Show context ±50 | C† |
| Log list | Only this tag / hide this tag / only this app | T† / X† / P† |
| Log list | Copy lines | ⌘C |
| Log list | Copy as bug report | ⇧⌘C |
| Log list | Back out one level | Esc |
| Markers | Add marker now (or at the selection) | M† |
| Markers | Add marker and name it | ⇧M† |
| Markers | Add marker from any app | ⌃⌥M (global) |
| Markers | Next / previous marker | ]† / [† |
| Markers | Next / previous error | ⌥] / ⌥[ |
| View | Log text larger / smaller / reset | ⌘= / ⌘− / ⌘0 |
| View | Interface size larger / smaller | ⇧⌘= / ⇧⌘− |
| View | Cycle theme (Dark → Light → System) | ⇧⌘L |
| Export | Export menu | ⌘E |
| Export | Save evidence bundle | ⇧⌘E |
| Devices | Refresh | ⌘R |
| Devices | Start all ready | ⌘↵ |
| Sheets | Confirm the primary (Copy, Re-pair) | ⌘↵ |

While a dialog is open, ⌘↵ confirms its primary button and never triggers page shortcuts; Start all ready applies only with no dialog open.
| Onboarding | Next step (steps 1–3) | ↵ |
| Column resize handle | Narrower / wider / reset | ← / → (⇧ for 32 px) / Enter or Home |

## Accessibility requirements

- **Contrast:** as measured above, in both themes, both materials and with Increase contrast. Re-measure on any token change.
- **Not colour alone:** level letters on every row and chip; status = icon + text; pressed = fill + inset ring (or border + badge fill for level chips); negation = "NOT" + dashed border; selection = fill + bar; current marker = ring; rail statuses = distinct shapes. Forced-colours mode keeps pressed, selected and focus visible.
- **Focus:** a visible 2 px `--ring` with 2 px offset on every interactive element (inset −2 px on log rows and inside scroll regions). Roving tabindex in the grid and in radio groups (arrows, Home, End). Dialogs trap focus and return it to their opener; the page behind is inert.
- **Semantics:** real `<button>`, `<a href>`, `<input>` + `<label>`, `<dl>` for fields, `role="grid"` with rows, gridcells, `aria-rowcount`, `aria-rowindex` and `aria-selected`; `role="combobox"` + `listbox` + `aria-activedescendant` for autocomplete and the palette; `role="radiogroup"`/`radio` for segmented controls; `role="switch"` for switches; `role="separator"` with value for column handles; `aria-current` for the current section, session, marker, preset and step; `aria-keyshortcuts` on toolbar buttons; `aria-describedby` for disabled reasons.
- **Announcements:** one polite live region for the result count (only when the filter changes, not on every streamed line), selection count, empty-state cause, context mode and stalls, at most once per 5 s while streaming. Errors use `role="alert"`. Toasts live in a persistent polite region.
- **Targets:** at least 24×24 px (WCAG 2.5.8). Standard controls are 28–32 px tall; the chip × is its own 24 px button.
- **Keyboard:** every action has a keyboard path. Single-key shortcuts are scoped to the focused log list and can be turned off (WCAG 2.1.4). Recording a shortcut captures every key, and Esc cancels.
- **Motion:** honour the OS Reduce motion unless Settings says Off; Settings On forces it. Arrival highlight, pulsing dots, sheet and drawer animations are all removable.
- **Text:** interface size S/M/L and log text 10–20 px are independent; Hyperlegible fonts; nothing clips at L with 20 px logs (the toolbar and chip row collapse in tiers instead).
- **Icons and decoration:** SVG icons are `aria-hidden`; icon-only buttons have aria-labels; no emoji.

## Old to new feature mapping

Nothing is dropped.

| Current feature | New home |
|---|---|
| Mode tabs File Import / Live Devices | Sidebar SESSIONS ("Live session" + files), Devices screen (⌘2), window drop overlay, ⌘O |
| Zoom A− / A / A+ (8–20 px), ⌘ +/−/0, persisted | Toolbar group "A− 13 px A+", ⌘= / ⌘− / ⌘0, Settings → Appearance slider (10–20 px, persisted). Interface size S/M/L added. |
| Theme switch light/dark, persisted | Settings → Appearance (Light / Dark / System), sidebar footer cycle, ⇧⌘L, onboarding step 3, palette "Toggle theme" |
| Liquid Glass switch (macOS) | Settings → Appearance → Material Solid / Glass, and onboarding step 3. Not in the main toolbar. |
| Message search | Query bar bare words and `"phrase"` |
| Case-sensitive (Aa) | Query bar "Aa" (⌥C) |
| Regex (.*) | Query bar ".*" (⌥R) and `/regex/` tokens |
| Tag/Process field | `tag:` tokens and chips, autocomplete with counts, drawer "Only / Hide tag", T and X keys |
| PID/App field | `app:` and `pid:` tokens, drawer "Only this app" and PID only/hide, P key |
| Level toggles V D I W E A | Level chips V D I W E **F** (= Fatal / Assert) with live counts, `level:`, ⌥ letter |
| Platform toggles Android / iOS | Device chips (per device, with platform badge), `plat:` / `dev:` tokens, sidebar device row and status bar device button |
| Auto-scroll toggle | Toolbar Follow toggle (End); turns off on scroll-up and selection |
| Pause / Resume | Toolbar Pause (Space), "Paused · N buffered" badge, Resume pill |
| Clear | Toolbar far-right Clear (⌘⌫) with a 10 s Undo; "New session" in More |
| Stats "332 / 332 lines" + discarded notes | Chip row "47 106 of 48 310 lines", status bar "Retained 48 310 of 500 000", buffer-full pill text, export notes |
| Export menu (Plain text / CSV / JSON, Filtered / All, warning note) | Toolbar Export menu with the same formats and captions, scopes Filtered / All / Around marker / Selection, the same gap and discard notes; defaults in Settings → Export; evidence bundle added |
| Android card + iOS card status pill | Sidebar device rows (always visible) and Devices cards with status badges |
| Status pill Error / bridge `error` frames (non-stall) | Device card: err badge "Error" with the frame text and a primary "Try again"; sidebar row "Error"; an err toast on the first occurrence. Until `/devices/*` reports tool errors, show only frames received on the WebSocket. |
| Device picker dropdown | Devices lists every detected device as its own card; the sidebar lists all |
| Refresh (↻) | Devices toolbar "Refresh" (⌘R) and automatic detection (Settings → Devices) |
| Connect / Disconnect | Card "Start streaming" / "Stop", sidebar row hover Start/Stop, palette, "Start all ready" (⌘↵) |
| Setup modal: Android steps | Devices empty-state Android checklist with live ticks, card menu "Setup guide", onboarding step 2, Settings → Devices → Guides |
| Setup modal: iOS steps incl. Windows Apple Devices | Devices empty-state iPhone checklist + "Get Apple Devices", onboarding step 2 |
| Troubleshoot: Re-pair iPhone (unpair + pair + pkill) | Stall sheet primary "Re-pair iPhone", iPhone card and sidebar menus, Settings → Devices → Pairing, palette |
| Unpair only / Pair only | Stall sheet → Advanced; Settings → Devices → Pairing → Advanced |
| Manual commands ("Still stuck? Run these…") | Stall sheet → "Run it yourself" with per-command copy and Copy all |
| iOS driver warning (Windows) + Install Apple Devices + Retry | Devices error banner ("Install Apple Devices", "Check again"), "Driver missing" card and sidebar row, Settings → Devices → Apple Devices driver |
| Live bar per-platform status + Connect/Disconnect | Sidebar DEVICES rows and status bar per-device rate buttons |
| Frames dropped pill | Status bar "312 lines dropped" + popover, sidebar "312 dropped", inline gap row, export and report notes |
| Device badge (WebSocket `devices` frame) | Card meta, "Show raw device info", drawer Device field, bug report header |
| Columns platform, Timestamp, PID-TID, Tag, App/Device, Lvl, Message | The same seven columns in the order Platform, Time, Lvl, Tag, App / Device, PID–TID, Message; resizable, reorderable and hideable (Settings → Log view) |
| PID → package mapping (adb shell ps every 5 s) | App / Device column and drawer field; switch and interval in Settings → Devices |
| Column resize handles | Kept, keyboard operable, plus reorder |
| Scroll-back beyond 6 000 rows | Unchanged; Home jumps to the oldest retained line |
| Row click selection (stops auto-scroll) | The same, plus ⇧/⌘-click multi-select; ↵ or double-click opens the drawer |
| Stall modal (Re-pair / Dismiss, suppressed while paused) | Stall sheet (Re-pair iPhone / Keep waiting), still suppressed while paused; sidebar "Stalled 15 s"; Live logs stall banner |
| Dropzone + Browse file | Window-wide drop overlay (new session or add to live), Devices drop strip, ⌘O, empty states |
| Window drag on the topbar, double-click maximize | Sidebar header and toolbar form the drag band; double-click maximizes |
| Loading "Parsing… / Rendering N lines…" | Toolbar progress "Reading pixel-crash-0412.logcat… 41%" and a progressively filling grid |
| New | Markers, saved presets, detail drawer, bug report, command palette, evidence bundle, global marker key, automatic crash markers, session names, highlight rules, timestamp formats, Increase contrast, Reduce motion |

## Implementation notes

### Structure

- The viewer stays one file, `viewer/applogs-viewer.html`, served by `src-tauri/src/http_server.rs` through `include_str!` at `GET /` on `127.0.0.1:8780`. There are no other routes today, so all CSS and JS stay inline unless new routes are added (a small Rust change). Every edit needs a Rust rebuild (`cargo run` from `src-tauri/`).
- The foundation CSS replaces the current `:root` token set. Apply its `.app` selectors to `<html class="app">`, because the pre-paint script already writes `data-theme`, `data-glass` and `data-platform` on `<html>`.
- Keep the XSS invariant: rows and messages are built with `textContent` and nodes, never `innerHTML`.
- `#logTable` today is the only scroll container (`body` is `overflow:hidden`). The new grid keeps one scroll container with a sticky header. The grid may move from `<table>` to the `role="grid"` div layout, but row heights must stay uniform (see Performance).

### Persisted settings and migration

All settings are client-side `localStorage` (origin `http://localhost:8780`), each access in its own try/catch as today.

| Key | Today | New |
|---|---|---|
| `applogs-viewer.theme` | `'light'` or `'dark'` (set by the toggle); pre-paint only reads `'light'` | `'dark'`, `'light'` or `'system'`. Pre-paint resolves System with `matchMedia('(prefers-color-scheme: dark)')`; it listens for changes while System is chosen. Pre-paint always writes `data-theme="dark"` or `"light"` (never absent) so `[data-theme]`-qualified rules in the foundation CSS apply. |
| `applogs-viewer.logFontSize` | 8–20, default 12 | 10–20, default 13. Values 8 and 9 clamp to 10. Pre-paint writes `--log-fs` (renamed from `--log-font-size`). |
| `applogs-viewer.glassMode` | `'on'` / `'off'` | Read once; if `applogs-viewer.material` is absent, write `'glass'` for `'on'` and `'solid'` otherwise. The old key is left in place so a downgrade still works. |
| `applogs-viewer.material` | — | `'solid'` or `'glass'`. Pre-paint writes `data-material`, forcing `solid` unless `data-platform="mac"`. |
| `applogs-viewer.uiSize` | — | `'s'`, `'m'` or `'l'`. Pre-paint writes `data-ui` to avoid a layout flash. |
| `applogs-viewer.settings` | — | One JSON object for the rest of Settings (fonts, contrast, motion, density, wrap, tints, columns, timestamp format, highlight rules, detection, shortcuts and overrides, retention, export defaults, bug report defaults). |
| `applogs-viewer.presets` | — | JSON array of `{name, q}`; the ⌥ key is the position. Seeded with the four examples. |
| `applogs-viewer.onboarded` | — | Set when onboarding finishes or is skipped; "Show onboarding again" clears it. |

Markers, session names and selections are per session and in memory; they leave the app through exports, bug reports and the evidence bundle.

### Glass gating

- `data-platform` is `mac` or `other` from the user agent (pre-paint, unchanged). Glass is only selectable when it is `mac`; elsewhere the option is disabled with its reason.
- Changing material keeps calling `POST /window/glass-mode {enabled}` (macOS), and the startup re-sync stays.
- Glass falls back to Solid while `prefers-reduced-transparency: reduce` matches, where the WebView reports it.
- The native material is a single HUD material that follows the OS appearance, not the app theme. A light app theme on a dark OS therefore sits on a dark material behind the translucent CSS chrome. A per-theme material needs a backend change (a new request field and effect choice).

### Window chrome (Tauri)

- macOS: `titleBarStyle: "Overlay"`, `hiddenTitle: true` and `transparent: true` already live in `src-tauri/tauri.macos.conf.json`. That file's `windows[]` replaces the base `windows[]` wholesale (JSON merge-patch), so every macOS window key goes there. The traffic lights sit over the sidebar header; reserve about 78 px on the left of the 52 px band (today `html[data-platform="mac"] #topbar { padding-left: 78px }`).
- Drag: `data-tauri-drag-region` does not work on the remote URL, so the hand-wired `initTopbarDrag` (arm after 4 px of movement, `startDragging()`, double-click `toggleMaximize()`) must cover both the sidebar header and the toolbar. Its `INTERACTIVE` selector must include every new control class placed in them.
- Windows: `decorations: true` keeps the native caption bar. Syncing the caption theme needs `setTheme` and the `core:window:allow-set-theme` permission in `capabilities/default.json` (config change).
- Settings as a separate window needs a second Tauri window plus capability entries (backend/config change). Until then it opens as an in-page modal with the same 960×680 layout.

### What exists and what needs new backend support

| Feature | Status |
|---|---|
| Live streams | Exists: `ws://localhost:8765` (Android) and `:8766` (iOS), read-only frames `log`, `devices`, `error`, `dropped`. Start/Stop is opening or closing the socket; the bridges run regardless. |
| Device lists, auto-detect | Exists: `GET /devices/android` (`id, name, model, product, status`) and `GET /devices/ios` (`id, name, version`). Auto-detect is client polling (iOS costs two process spawns per device per poll, so poll it at 5–10 s and pause while hidden). |
| Re-pair, unpair, pair | Exists: `POST /ios/repair`, `/ios/unpair`, `/ios/pair`. |
| Apple Devices driver status | Exists: `GET /ios-driver-status`. |
| iOS stall | Exists: `error` frame containing "stalled" after 15 s. The client keeps substring matching. |
| Drops | Exists: per-platform `dropped` frames. The gap row is placed where the frame arrives. |
| Connecting stepper | Client: Found (device list), Authorized (Android `status`), Starting (socket open), Receiving (first `log` frame). |
| Markers, presets, drawer, context, bug report text, palette, highlight rules, timestamp formats, retention setting (`MAX_RETAINED` is a JS `let`) | Client only. |
| Clipboard | Client: `navigator.clipboard.writeText` (localhost is a secure context), with an `execCommand('copy')` fallback; verify in WKWebView and WebView2. |
| Android "Unauthorized" and "Offline" states | **Needs backend:** `/devices/android` drops devices whose status is not `device`. |
| Onboarding step 2 intermediate ticks (cable seen, waiting for Allow or Trust) | **Needs backend:** same signals as Unauthorized and Needs Trust. Until then: all steps pending, then all done once a device appears in `/devices/*`. |
| iOS "Needs Trust" state | **Needs backend:** no pairing-state signal today (for example `idevicepair validate`). |
| More than one device per platform | **Needs backend:** one bridge per platform, and frames carry no device id. Until then rates and drops are per platform. |
| Android OS version, app-under-test version | **Needs backend:** not in any response today. Report fields are omitted while unavailable. |
| App version (sidebar footer, About, report footer) | **Needs backend:** `GET /version`, or the `core:app:default` permission for `getVersion`. |
| Tool paths and versions, "Restart adb" | **Needs backend:** not exposed. |
| "Tool missing" versus "no device" | **Needs backend:** `/devices/*` swallows spawn errors. |
| Stall timeout setting | **Needs backend:** `STREAM_STALL_TIMEOUT_SECS` is a compile-time constant. The row shows the value read-only until then. |
| Android stall | Client heuristic: no `log` frames for the threshold while connected. |
| Global marker ⌃⌥M while in the background | **Needs backend:** the Tauri global-shortcut plugin is not installed. In-app ⌃⌥M works without it. |
| Export folder setting, "Show in folder", "Show logs folder", opening external links (Install Apple Devices, guides, release notes, report a problem) | **Needs backend:** no dialog, fs or opener plugin. Export uses `showSaveFilePicker` with the download fallback until then. |
| Update check against GitHub releases | **Needs config:** `connect-src` in the CSP does not allow api.github.com. |
| Bundled fonts (offline) | **Needs backend or config:** fonts load from Google today (IBM Plex Sans + JetBrains Mono). Serve Geist, JetBrains Mono and Atkinson Hyperlegible from a new `/fonts/*` route (`font-src 'self'` already allows it), or inline them as `data:` and add `data:` to `font-src`. Then remove the Google hosts from the CSP. |

### Performance constraints

- Volume: iOS 2k–8k lines/s with bursts to 27k/s; Android far lower. Latency problems live in the viewer drain, not the bridges.
- Keep the drain model: frames always queue (`pendingBatch`), `FLUSH_INTERVAL_MS = 150`, a 50 ms budget per flush, FIFO requeue, and only the chunk that empties the queue renders. No per-row layout reads and no per-flush DOM writes beyond the counters.
- Keep the bounded DOM: following shows a tail of `FOLLOW_DOM_CAP = 300` rows; reading back is a frozen window of up to `LIVE_DOM_CAP = 6000` rows grown in `PAGE = 500` chunks (freeze-while-reading, #54). Clear and file load must go through `discardBacklog()` (#55); Undo keeps the cleared arrays for 10 s only.
- Restyle and re-place the existing #57 newer pill: keep `updateNewerPill()` as the one hook and keep the 56 px bottom spacer while it shows. #58 supplies the "N lines below" copy and the reading-window hint. Implementation PRs start only after #57 and #58 are merged.
- Retention: `MAX_RETAINED` default 500 000, set from Settings (100 000–1 000 000). A 1 000 000-line JSON export approaches V8's string limit (about 537M characters, WebView2), so exports above about 800 000 lines are written in chunks (an array of line strings, never one string); until chunked writing lands, the export button warns "Too many lines for one JSON file. Export the filtered view." Retention is trimmed 10% at a time by `seq` binary search. Keep markers and gap rows in their own arrays keyed by `seq` and merge them into the render window, so trimming stays one contiguous splice and markers survive it.
- Counts: keep per-level counts (filtered, ignoring the level filter) and per-tag and per-app counts incrementally in the flush. Never rescan 500 000 lines per update. Update visible numbers at most 4 times per second and the live region at most once per 5 s.
- Filtering: compile the query once per change into a closure (as `makeFilter` does today); debounce typing (about 100 ms) before re-filtering the retained lines.
- Arrival highlight: only for rows appended by the last flush, and skipped when a flush appends more than one screenful.
- Row height must stay uniform for the tail and window math. Wrap long messages makes heights variable, so in wrap mode `dropTopRows` must measure the removed height instead of assuming a fixed row height.
- Export formats and parsers stay mutual inverses. TXT keeps its field widths and its platform markers for re-import, even though the UI uses no emoji. Header and marker lines in TXT and CSV exports start with "#" and the parsers skip them (see Export).

### Testing

- CI today parses the HTML with Python's lenient parser only. Add a zero-dependency Node job: `node --check` on the extracted inline scripts, a tag-balance check, and `node --test` on extracted pure functions (query parser, level sets, bug report builder, CSV round trip, iOS log regex).
- Manually verify at 1100×700 (minimum window), 1440×900 and full screen, at interface S/M/L and log 10/13/20 px, in both themes and both materials, with VoiceOver and Narrator, and with forced colours on Windows.

## Open items

1. **Tooltips are CSS bubbles** (`data-tip` pseudo-elements) in the mockup, so they cannot carry `role="tooltip"` or an id for `aria-describedby`. The app builds them as real elements, with `role="tooltip"` and `aria-describedby` on the trigger and the same timing and Esc behaviour.
2. **Pressed-state ring:** in the mockup it lives only in Main's screen CSS. It is now in the foundation (v1.1), together with the 7 px marker inset, `.ctx-dim`, the badge/kbd size tokens, Increase contrast and Reduce motion "Off". The other mockup files still carry the v1 block. v1.2 rewrote the foundation's universal selectors (resets, `::selection`, scrollbars, Reduce motion via the `--t-*` tokens) for style-recalc cost without changing rendering; see the file header.
3. **System theme renders as Dark** in the mockup (onboarding, Settings, sidebar cycle). The app resolves it from `prefers-color-scheme` and follows OS changes live.
4. **Theme shortcut ⇧⌘L** appears only as a label in the Devices palette. No key handler for it exists in any mockup file. Main's palette and the Settings → Shortcuts table lack it, and the Devices sidebar toggle cycles only Dark and Light. The app uses the three-state cycle everywhere and lists ⇧⌘L in the shortcuts table (View group).
5. **Traffic lights versus the collapsed rail:** the 52 px rail is narrower than the macOS traffic lights (about 70 px). On macOS the collapsed rail keeps a full-width 52 px header band above the toolbar's left edge, so the lights never overlap rail icons.
6. **Clicking a token chip's body** should put the caret on that token in the query bar. The mockup only implements the ×.
7. **Backend-dependent states** (Unauthorized, Offline, Needs Trust, multi-device, versions, global shortcut, Settings window, folders, external links, fonts) are designed but ship only when their backend support from the table above lands; until then each control is hidden or read-only as stated there.

## Appendix: Mockup

- **Canvas:** <https://claude.ai/artifact/7GicJ5oHRJu2SD2KtJ7QqW>, private to the owner until shared. The sources are working files outside the repo (`canvas/project/*.dc.html` in the design session's scratchpad); this doc and the foundation CSS are the record.
- **Using it:** turn on Play mode to interact with an artboard (clicks, keyboard, timers). Use the Tweaks (props) panel on a selected artboard to set `theme` (dark, light), `material` (solid, glass), `logSize` (10–20), `uiSize` (s, m, l) and the artboard's `scene`, `step` or `section`. Props seed the initial state; in-app controls win after the first click.

| Row | Artboards | Shows |
|---|---|---|
| 1 Onboarding | Onboarding, Onboarding-2, Onboarding-3, Onboarding-4 | Steps 1–4 |
| 2 Devices | Devices, Devices-Connecting, Devices-Empty, Devices-Troubleshoot | Ready, connecting, nothing plugged in, iOS stream stalled (with the Windows variant) |
| 3 Live logs | Main, Logs-Paused, Logs-Autocomplete, Logs-Detail, Logs-BugReport, Logs-Stalled | Streaming, reading back with new lines waiting, autocomplete and presets, line detail with markers, copy as bug report, iOS stream stalled |
| 4 Appearance | Main-Light, Main-Glass-Dark, Main-Glass-Light, Main-LargeText | Light Solid, Dark Glass, Light Glass, interface L with 17 px logs |
| 5 Settings | Settings, Settings-LogView, Settings-Devices, Settings-Shortcuts | Appearance, Log view, Devices, Shortcuts (other sections via the nav) |
| 6 Foundations | Foundations (1440×2640) | Tokens and components |

**Mockup-only mechanics** (not app behaviour): a 700 ms timer appends one line from an 8-line pool and keeps the last 160 rows; rates jitter around 842/s and 1.9k/s; scenes seed state; the Devices troubleshoot artboard and Settings → Devices carry a dashed "Mockup variant" switch (macOS stalled / Windows driver missing; driver installed / missing); "Pair only" fails once with "device locked" and then succeeds, to show the failure copy; connecting completes after 2.4 s and re-pair after about 3 s; "Open log file…", "New session" and ⇧⌘N show explanatory toasts; context mode shows ±16 rows of the 44-line sample.

**Keys handled in the mockup.** Main: ⌘K ⌘B ⌘E ⌘S ⌘C ⇧⌘C ⇧⌘F ⌘= ⌘− ⌘0 ⌘⌫ ⌘Z, ⌘↵ in the bug report sheet only, ⌥C ⌥R ⌥V…⌥F ⌥1…⌥9. With a log row focused: ↑↓ J K ⇧↑↓ ↵ M Space End F C ] [ T X P Esc. Plus column handle keys and autocomplete keys. Devices: ⌘R ⌘↵ ⌘K ⌘B Esc. Spec only, not handled in the mockup: ⌘F and / (the ⌘F hint is drawn), ⌘/ and ?, ⌘1, ⌘2, ⌘O, ⇧⌘N, ⇧⌘E, ⌘, , ⌘↓, Home, ⌘↑, ⌘A, ⌘J, ⇧M (acts as M, no rename), ⌥] and ⌥[, ⇧⌘= and ⇧⌘−, ⇧⌘L, ⌃⌥M, ⌘↵ in the stall sheet.

**Spec only, not rendered in the mockup:** Unauthorized, Offline and Disconnected device cards (their copy exists only as data and Foundations callouts); the drawer resize handle (the mockup drawer is a fixed 400 px); the toolbar "File · 12 044 lines" badge and parse progress; the over-max "Large report" warning; ⇧M naming.

**Known mockup deviations from this doc** (the doc wins): Main's container queries use the border-box numbers on padded containers, so at 1440 with the sidebar Bug report and Export lose their labels; autocomplete opens only for the last token of the query, not the token under the caret; onboarding step 2's intermediate Android state ticks only step 3; the Devices ⌘↵ handler runs Start all ready even while the stall sheet is open; Devices shows re-pair toasts "iPhone 15 is streaming again" / "Re-paired and restarted the stream." instead of the toast table copy; Main's jump pill says "new lines"; single-device Pixel and iPhone streaming badges differ (Pixel "Streaming · 842 lines/s", iPhone "Streaming" plus a separate rate note), and the app uses the Pixel form for both. The sample session is "HS-1234 · OTA pairing" with Pixel 8 Pro (Android 15) and iPhone 15 (iOS 18.2), 48 310 lines, markers M1 "OTA started" 15:53:43.120, M2 "Pairing drops after OTA" 15:54:26.581 and M3 "Forget and re-pair tapped" 15:54:28.660, and 312 dropped iOS lines.
