; Tauri v2 NSIS installer hooks for AppLogsViewer.
;
; Surfaced to the NSIS template via tauri.conf.json:
;   bundle.windows.nsis.installerHooks = "scripts/installer-hooks.nsh"
;
; Tauri's installer template `!include`s this file at the top, *before*
; any Page directives — so the `Page custom` declaration below is
; inserted at the front of the install wizard's page list. The page
; immediately Aborts (skipping itself) when Apple Mobile Device Service
; is reachable on 127.0.0.1:27015, so users with iTunes / Apple Devices
; already installed see the normal Welcome → Install → Finish flow.
;
; Silent installs (/S) skip Pages entirely by NSIS design, so unattended
; deployments are never blocked by this prompt.
;
; ── Why a TCP probe instead of a registry check ────────────────────────
; Two distinct Apple installers expose AMDS:
;   1. iTunes / "Apple Mobile Device Support" MSI registers a Win32
;      service under HKLM\SYSTEM\CurrentControlSet\Services.
;   2. The "Apple Devices" Microsoft Store app (MSIX) installs into
;      WindowsApps and registers via AppX, NOT under classic Services.
; Both end up with `AppleMobileDeviceProcess` listening on 127.0.0.1:27015
; — that's the actual API libimobiledevice talks to. Probing the port
; matches both, and matches the runtime banner check in the app, so
; install-time and runtime warnings stay consistent.
;
; ── PowerShell quoting ─────────────────────────────────────────────────
; NSIS substitutes `$xxx` references inside *all* string forms (single
; quote, double quote, backtick) before passing the string to a plugin.
; A naive `$c = New-Object …` becomes ` = New-Object …` by the time
; PowerShell sees it (parser error → exit 1 → false-positive "AMDS
; missing"). The inline expression form `(New-Object …).Close()` has no
; PowerShell variables and survives NSIS substitution intact.

Var amdsDialog
Var amdsLink
Var amdsRadioStore
Var amdsRadioContinue
Var amdsRadioCancel

!define AMDS_STORE_URL "https://apps.microsoft.com/detail/9NP83LWLPZ9K"

Page custom amdsCheckPage amdsCheckPageLeave

; ── PREINSTALL: kill processes that lock our installed files ───────────
; NSIS overwrites existing files in place during upgrades; if any of the
; bundled binaries from a previous install are still running, the file
; copy fails with "Error opening file for writing". The big offender is
; adb.exe — it auto-spawns a detached `adb fork-server` daemon that
; survives the parent app and holds AdbWinApi.dll open indefinitely.
;
; `taskkill /F /IM` kills any process matching the image name regardless
; of its parent — including the detached adb fork-server. /T also tree-
; kills the app's children. taskkill returns non-zero (128) when no
; matching process is found, which is fine — we ignore exit codes.
;
; A developer's standalone adb running outside this install gets killed
; too, but adb auto-respawns on the next command, so the cost is a
; one-off restart. PowerShell with path filtering would be safer but
; NSIS string substitution mangles the `$_.Path` references reliably,
; and the image-name approach is robust against any quoting issue.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running AppLogsViewer processes..."
  nsExec::ExecToLog 'taskkill /F /T /IM applogs-viewer.exe'
  nsExec::ExecToLog 'taskkill /F /IM adb.exe'
  nsExec::ExecToLog 'taskkill /F /IM idevicesyslog.exe'
  nsExec::ExecToLog 'taskkill /F /IM ideviceinfo.exe'
  nsExec::ExecToLog 'taskkill /F /IM idevice_id.exe'
  ; A short pause lets the OS release the file handles before NSIS
  ; starts the file-copy step.
  Sleep 500
!macroend

Function amdsCheckPage
  ; ── Probe :27015 ────────────────────────────────────────────────────
  ; BeginConnect + WaitOne(750ms) bounds the probe at well under a second
  ; on any host. The default `New-Object Net.Sockets.TcpClient host, port`
  ; constructor connects synchronously with the OS's TCP timeout (~21 s
  ; on Windows when the port is filtered by a corporate firewall instead
  ; of cleanly refused) — the install wizard would freeze for 20 s on
  ; those hosts before the AMDS page renders.
  nsExec::ExecToLog 'powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -Command "try { $t = New-Object Net.Sockets.TcpClient; $r = $t.BeginConnect(''127.0.0.1'', 27015, $null, $null); if ($r.AsyncWaitHandle.WaitOne(750) -and $t.Connected) { $t.EndConnect($r); $t.Close(); exit 0 } else { $t.Close(); exit 1 } } catch { exit 1 }"'
  Pop $0
  ${If} $0 == "0"
    Abort   ; AMDS reachable — skip this page entirely.
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Apple's USB driver" "Required for iOS device detection"

  nsDialogs::Create 1018
  Pop $amdsDialog
  ${If} $amdsDialog == error
    Abort
  ${EndIf}

  ; ── Top description ────────────────────────────────────────────────
  ${NSD_CreateLabel} 0 0 100% 20u "AppLogsViewer's iOS panel needs Apple's USB driver to detect iPhones. The driver ships only via Apple's installers — we can't legally bundle it."
  Pop $0

  ; ── Visible + clickable Microsoft Store link ───────────────────────
  ; Always shown so the user can click / copy the URL even if auto-launch
  ; fails (some elevated-installer + corporate-AV combinations block
  ; ExecShell from talking to the default browser).
  ${NSD_CreateLink} 0 24u 100% 10u "${AMDS_STORE_URL}"
  Pop $amdsLink
  ${NSD_OnClick} $amdsLink amdsLinkClick

  ; ── Radio buttons ──────────────────────────────────────────────────
  ; Descriptions are kept under ~55 chars so they render on a single
  ; line at the dialog's 84% width allocation — anything longer wraps
  ; to a second line and gets clipped by the 10u label height.
  ${NSD_CreateRadioButton} 0 42u 100% 10u "Install Apple Devices first   (recommended for iOS testers)"
  Pop $amdsRadioStore
  ${NSD_CreateLabel} 16u 53u 84% 10u "Quits the installer and opens the Store link above."
  Pop $0

  ${NSD_CreateRadioButton} 0 70u 100% 10u "Install AppLogsViewer anyway"
  Pop $amdsRadioContinue
  ${NSD_CreateLabel} 16u 81u 84% 10u "Android works; iOS reminder shows up if you need it."
  Pop $0

  ${NSD_CreateRadioButton} 0 98u 100% 10u "Cancel — don't install anything"
  Pop $amdsRadioCancel
  ${NSD_CreateLabel} 16u 109u 84% 10u "Abort the installer with no changes to your system."
  Pop $0

  ; Default selection: "install anyway" — most QA hosts are Android-only
  ; and the runtime banner surfaces again later if they do plug an iPhone in.
  ${NSD_Check} $amdsRadioContinue

  nsDialogs::Show
FunctionEnd

Function amdsLinkClick
  Pop $0  ; SysLink control handle (unused — we know the URL)
  ; Empty verb lets Windows pick the registered default URL handler,
  ; which works in more locked-down environments than explicit "open".
  ExecShell "" "${AMDS_STORE_URL}"
FunctionEnd

Function amdsCheckPageLeave
  ; "Install Apple Devices first": open the Store, give the browser a
  ; moment to spin up, then quit. The Sleep matters: ExecShell returns
  ; immediately, and on Win11 with elevated installers the OS sometimes
  ; cancels the launch if the parent process exits within a few hundred
  ; ms. The visible link in the dialog is the user-clickable fallback
  ; if auto-launch is blocked entirely.
  ${NSD_GetState} $amdsRadioStore $0
  ${If} $0 == ${BST_CHECKED}
    ExecShell "" "${AMDS_STORE_URL}"
    Sleep 1500
    Quit
  ${EndIf}

  ; "Cancel — don't install anything": just quit, no side effects.
  ${NSD_GetState} $amdsRadioCancel $0
  ${If} $0 == ${BST_CHECKED}
    Quit
  ${EndIf}

  ; Otherwise "install anyway" is selected — return and proceed to the
  ; rest of the wizard pages (Welcome, License, Install, …).
FunctionEnd
