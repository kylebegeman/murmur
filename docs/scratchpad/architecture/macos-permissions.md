# macOS Integration & Permissions

Subsystem map for the Handy → Murmur codebase. Covers microphone + accessibility
permission flows, Info.plist / entitlements, window and tray configuration,
autostart, and the Swift bridge that lives under `src-tauri/swift`. All paths
are relative to the repo root.

## Purpose

Handy needs two macOS TCC permissions to function:

- **Microphone** — to record audio for transcription (declared in
  `src-tauri/Info.plist` + `src-tauri/Entitlements.plist`).
- **Accessibility** — to synthesize keystrokes (Enigo) that paste/type
  transcribed text into other apps, and for the global-shortcut key listener.

Permission checking/requesting is done entirely from the **frontend** via the
third-party `tauri-plugin-macos-permissions` plugin (registered in
`src-tauri/src/lib.rs (run)`), gated by an onboarding screen. The Rust backend
deliberately defers everything that could trigger a TCC prompt (Enigo init,
shortcut registration) until the frontend says permissions are ready. There is
no Rust-side macOS permission code in this repo; the only macOS-permission
logic in `src-tauri/src` is Windows-registry mic checking and generic
"mic access denied" error classification.

## Key files and roles

| File | Role |
|---|---|
| `src-tauri/Info.plist` | Only key: `NSMicrophoneUsageDescription` = "Request microphone access to transcribe audio locally". Merged into the bundle plist automatically by tauri-build/bundler (no explicit reference in `tauri.conf.json`). No accessibility string (AX has no usage-description key). |
| `src-tauri/Entitlements.plist` | `com.apple.security.device.microphone` + `com.apple.security.device.audio-input`, both `true`. Referenced by `tauri.conf.json` `bundle.macOS.entitlements`. |
| `src-tauri/tauri.conf.json` | `identifier: com.pais.handy`, `productName: Handy`, `app.macOSPrivateApi: true` (needed for transparent overlay), `app.windows: []` (all windows created programmatically), `bundle.macOS.hardenedRuntime: true`, `signingIdentity: "-"` (ad-hoc!), updater plugin config pointing at cjpais/Handy GitHub releases. |
| `src-tauri/capabilities/default.json` | Capability for windows `main` **and** `recording_overlay`. Grants `macos-permissions:default` (all check/request commands of the plugin), `global-shortcut` allow-register/unregister, `store`, `updater`, `process`, `dialog`, `opener`, `fs` read scoped to `$APPDATA`. |
| `src-tauri/capabilities/desktop.json` | Capability for `main` only: `autostart:default` (duplicated 3x — harmless), `global-shortcut:default`, `updater:default`. |
| `src/App.tsx` | Boot-time onboarding gate: reads `onboarding_completed`, re-checks macOS accessibility+mic (and Windows mic) for returning users, routes to `AccessibilityOnboarding` when missing, initializes Enigo/shortcuts when `done`. Also hosts toast listeners for `recording-error`, `paste-error`, `transcription-error`, `model-state-changed`. |
| `src/components/onboarding/AccessibilityOnboarding.tsx` | The permission-request screen (macOS: mic + accessibility cards; Windows: mic card; other platforms: auto-skip). Requests permissions, then polls every 1 s until granted. |
| `src/components/AccessibilityPermissions.tsx` | Persistent banner rendered at top of the main settings content when macOS accessibility is missing (post-onboarding revocation case). |
| `src-tauri/src/lib.rs` | App wiring: plugin registration (`tauri_plugin_macos_permissions::init()`, `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![]))`, nspanel, single-instance…), programmatic `main` window creation (hidden), tray construction + menu-event handling, autostart enable/disable at startup, activation-policy management, `should_force_show_permissions_window` (Windows-only), `show_main_window_command` (`lib.rs:327`). |
| `src-tauri/src/commands/mod.rs` | `initialize_enigo`, `initialize_shortcuts` (the deferred, permission-sensitive initializations). |
| `src-tauri/src/commands/audio.rs` | `get_windows_microphone_permission_status` (registry ConsentStore read), `open_microphone_privacy_settings` (Windows `ms-settings:` deep link; **errors on all other OSes**), plus mic/output device selection commands. |
| `src-tauri/src/tray.rs` | Tray icon state machine (Idle/Recording/Transcribing), theme-aware icon selection, menu building (`update_tray_menu`), `set_tray_visibility`, `copy_last_transcript`. |
| `src-tauri/src/tray_i18n.rs` | `get_tray_translations(locale)` — locale → language-code → English fallback over a compile-time-generated `TRANSLATIONS` map. |
| `src-tauri/build.rs (generate_tray_translations)` | Generates `TrayStrings` struct + `TRANSLATIONS` static in `OUT_DIR/tray_translations.rs` from `src/i18n/locales/*/translation.json` `"tray"` sections (English is schema source of truth). |
| `src-tauri/swift/*` | **Not permissions.** Apple Intelligence FFI bridge (`FoundationModels`) for LLM post-processing; compiled by `build.rs (build_apple_intelligence_bridge)` on macOS/aarch64 only, with a stub when the SDK lacks `FoundationModels.framework`. Exposed via `commands::check_apple_intelligence_available`. |
| `src-tauri/src/audio_toolkit/audio/recorder.rs` | `is_microphone_access_denied`, `is_no_input_device_error` — string heuristics used to classify recording-start failures. |
| `src-tauri/src/actions.rs` | Emits `recording-error` event when recording start fails (permission denied / no device / unknown). |
| `src-tauri/src/overlay.rs` | `create_recording_overlay` — macOS path builds an NSPanel (`tauri_nspanel::PanelBuilder`, label `recording_overlay`, `PanelLevel::Status`, non-activating, joins all spaces / fullscreen auxiliary); non-macOS path builds a normal always-on-top transparent WebviewWindow. |

## Plugin internals (tauri-plugin-macos-permissions 2.3.0)

Rust side (cargo registry, `src/commands.rs` of the plugin):

- `check_accessibility_permission` → `macos_accessibility_client::accessibility::application_is_trusted()` (AXIsProcessTrusted). Non-macOS: always `true`.
- `request_accessibility_permission` → `application_is_trusted_with_prompt()` (AXIsProcessTrustedWithOptions with prompt). Shows the one-time system dialog; **does not open System Settings** and does nothing if the prompt was already shown/denied.
- `check_microphone_permission` → `AVCaptureDevice authorizationStatusForMediaType:"soun"` `== 3` (authorized).
- `request_microphone_permission` → `AVCaptureDevice requestAccessForMediaType:completionHandler:` with a **nil completion handler**; fire-and-forget. Prompts only when status is NotDetermined; a previously-denied status is a silent no-op.

JS side (`tauri-plugin-macos-permissions-api` 2.3.0) invokes
`plugin:macos-permissions|check_accessibility_permission` etc.

## Runtime flow

### 1. Backend startup (`src-tauri/src/lib.rs (run)` → `.setup`)

1. Plugins registered, including `tauri_plugin_macos_permissions::init()` and
   `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![]))`.
2. `main` window built programmatically (`WebviewWindowBuilder`, 680×570,
   `visible(false)`), so capabilities in `default.json`/`desktop.json` apply by
   label.
3. `initialize_core_logic` runs: managers created (this opens the mic stream
   immediately **only** if `always_on_microphone` is true — otherwise the mic is
   never touched at startup, so no TCC mic prompt); Enigo and shortcuts are
   explicitly NOT initialized (comments at `lib.rs:149-153`, `184-187`); on
   macOS, if `start_hidden && show_tray_icon`, activation policy is set to
   `Accessory` (no dock icon); tray built; autostart enabled/disabled to match
   `autostart_enabled`; recording overlay window created hidden.
4. Window visibility decision (`lib.rs:858-869`): show unless
   `start_hidden` (setting or `--start-hidden` CLI) with a usable tray;
   `should_force_show_permissions_window` forces show **only on Windows** when
   models are downloaded but mic registry access is Denied. On macOS the
   equivalent forcing is done by the frontend (step 2 below).

### 2. Frontend boot gate (`src/App.tsx (checkOnboardingStatus)`)

1. `commands.getAppSettings()` → read `onboarding_completed`.
2. **Returning user** (`onboarding_completed === true`):
   - macOS: `Promise.all([checkAccessibilityPermission(), checkMicrophonePermission()])`
     (both non-prompting). If either is false →
     `commands.showMainWindowCommand()` (reveals a possibly-hidden window,
     sets activation policy Regular) and route to onboarding step
     `"accessibility"` with `isReturningUser = true`.
   - Windows: `commands.getWindowsMicrophonePermissionStatus()`; if
     `supported && overall_access === "denied"` → same reveal + onboarding.
   - Check failures are caught, `console.warn`ed, and the user proceeds to the
     main app (silent).
3. **New user**: straight to onboarding step `"accessibility"`.
4. When step becomes `"done"` (once): `commands.initializeEnigo()` +
   `commands.initializeShortcuts()` (failures only `console.warn`ed), then
   refresh audio device lists.

### 3. Onboarding screen (`src/components/onboarding/AccessibilityOnboarding.tsx`)

1. On mount: platform switch. Non-macOS/Windows → `onComplete()` immediately.
2. macOS initial check: `checkAccessibilityPermission()` +
   `checkMicrophonePermission()`. If accessibility already granted, eagerly
   runs `initializeEnigo` + `initializeShortcuts`. If both granted →
   `completeOnboarding()` (refresh devices, 300 ms delay, `onComplete`).
   Check failure → toast `onboarding.permissions.errors.checkFailed`, both
   cards shown as "needed".
3. User clicks **Grant Permission** on the accessibility card →
   `requestAccessibilityPermission()` (system AX prompt) → card enters
   `"waiting"` → `startPolling()`.
4. User clicks **Grant Permission** on the mic card →
   `requestMicrophonePermission()` on macOS (system mic prompt, only if
   NotDetermined) or `commands.openMicrophonePrivacySettings()` on Windows →
   `"waiting"` → `startPolling()`.
5. Polling (`startPolling`, 1 s interval): re-checks both permissions; on
   accessibility flip to granted, runs `initializeEnigo` + `initializeShortcuts`;
   when all granted, clears interval and completes. After 3 consecutive check
   **errors** the poll stops with a `checkFailed` toast; a check that simply
   keeps returning `false` polls forever with a spinner.
6. `onComplete` → `App.tsx (handleAccessibilityComplete)`: returning users skip
   to `"done"`, new users go to `"model"` (model download onboarding —
   `commands.models.set_active_model` delegates to the shared helper
   `switch_active_model` (`models.rs:91`), which is what finally writes
   `onboarding_completed = true`, `src-tauri/src/commands/models.rs:120`; the
   tray `model_select:` handler (`lib.rs:265`) calls the same helper).

### 4. Post-onboarding revocation banner (`src/components/AccessibilityPermissions.tsx`)

Rendered above settings content on every main-app render. macOS only; checks
`checkAccessibilityPermission()` on mount; if missing shows a banner whose
button first calls `requestAccessibilityPermission()` (state `request` →
`verify`), then on subsequent clicks re-checks (`verify` state). Button label
is "Open System Settings" in both states but never actually opens System
Settings. Microphone revocation has no equivalent banner; it surfaces only as
a `recording-error` toast at recording time.

### 5. Recording-time permission failure (`src-tauri/src/actions.rs (TranscribeAction::start)`)

If `AudioRecordingManager::try_start_recording` fails, the overlay is hidden,
tray reset to Idle, and a `recording-error` event is emitted with
`error_type` classified by
`src-tauri/src/audio_toolkit/audio/recorder.rs (is_microphone_access_denied /
is_no_input_device_error)` — substring matching on `"access is denied"`,
`"permission denied"`, `"0x80070005"` (WASAPI) / `"no input device found"`,
CoreAudio config-fetch failure. `src/App.tsx` maps
`microphone_permission_denied` to a platform-specific toast
(`errors.micPermissionDenied.macos` → "Grant microphone access in System
Settings → Privacy & Security → Microphone.").

### 6. Tray (`src-tauri/src/lib.rs (initialize_core_logic)` + `src-tauri/src/tray.rs`)

- Built with `TrayIconBuilder` (`show_menu_on_left_click(true)`,
  `icon_as_template(true)`); the `TrayIcon` handle is put into Tauri managed
  state and reused by `tray.rs`.
- `tray.rs (get_current_theme)`: Linux always `Colored`; otherwise main-window
  theme (fallback Dark). `get_icon_path` maps (theme, state) → PNG under
  `resources/` (dark theme uses light icons and vice versa).
- `change_tray_icon(app, state)`: sets icon (`.expect` panics if the resource
  can't resolve) and rebuilds the menu via `update_tray_menu`.
- `update_tray_menu(app, state, locale)`: localized via
  `tray_i18n::get_tray_translations` (locale defaults to `settings.app_language`);
  menu items (ids): `version` (disabled), `copy_last_transcript`,
  `model_submenu` with `model_select:<model_id>` check items (downloaded
  models, active one checked; submenu label = active model name),
  `unload_model` (enabled only when a model is loaded), `settings`
  (Cmd+, / Ctrl+,), `check_updates` (enabled per `update_checks_enabled`),
  `quit` (Cmd+Q / Ctrl+Q); Recording/Transcribing states swap the model section
  for `cancel`. All item construction uses `.expect(...)`.
- Menu event handling lives in `lib.rs (initialize_core_logic .on_menu_event)`:
  `settings` → `show_main_window` (also sets activation policy Regular on
  macOS); `check_updates` → show window + emit `check-for-updates`;
  `copy_last_transcript` → `tray::copy_last_transcript` (clipboard write,
  errors only logged); `unload_model`; `cancel` →
  `utils::cancel_current_operation`; `quit` → `app.exit(0)`;
  `model_select:*` → `commands::models::switch_active_model` on a spawned
  thread, then tray menu refresh.
- `model-state-changed` (Rust-internal listen in `lib.rs:293`) refreshes the
  tray menu whenever model state changes.
- Visibility: `--no-tray` CLI or `show_tray_icon=false` →
  `tray::set_tray_visibility(false)`.
- Window close (`lib.rs .on_window_event CloseRequested`): close is prevented,
  window hidden; on macOS if the tray is visible the activation policy flips to
  `Accessory` (dock icon removed). `RunEvent::Reopen` (dock click) →
  `show_main_window`. ThemeChanged → tray icon refresh.

### 7. Autostart

- Plugin: `tauri_plugin_autostart` with `MacosLauncher::LaunchAgent` and empty
  extra args (`lib.rs:748-751`).
- Applied at startup in `initialize_core_logic` (`lib.rs:297-307`):
  enable/disable to match `autostart_enabled`; **results discarded** (`let _ =`).
- Toggled at runtime by `src-tauri/src/shortcut/mod.rs (change_autostart_setting)`:
  writes setting, enables/disables (again `let _ =`), emits `settings-changed`.

## Tauri commands and events

### Commands (frontend → Rust)

Plugin commands (invoked via `tauri-plugin-macos-permissions-api`, permission
`macos-permissions:default` in `capabilities/default.json`):

| Command | Returns | Notes |
|---|---|---|
| `plugin:macos-permissions\|check_accessibility_permission` | `bool` | AXIsProcessTrusted; non-prompting |
| `plugin:macos-permissions\|request_accessibility_permission` | `void` | AX prompt (once per app identity) |
| `plugin:macos-permissions\|check_microphone_permission` | `bool` | AVCaptureDevice status == authorized |
| `plugin:macos-permissions\|request_microphone_permission` | `Result<(), String>` | fire-and-forget; nil completion handler |

App commands (all specta-typed in `src/bindings.ts`):

| Command | Defined in | Returns / payload | Notes |
|---|---|---|---|
| `get_app_settings` | `commands/mod.rs` | `Result<AppSettings, String>` | source of `onboarding_completed` |
| `initialize_enigo` | `commands/mod.rs` | `Result<(), String>` | idempotent; fails on macOS without accessibility |
| `initialize_shortcuts` | `commands/mod.rs` | `Result<(), String>` | idempotent; registers global shortcuts |
| `show_main_window_command` | `lib.rs` | `Result<(), String>` | unminimize+show+focus; macOS activation policy Regular |
| `get_windows_microphone_permission_status` | `commands/audio.rs` | `WindowsMicrophonePermissionStatus { supported, overall_access, device_access, app_access, desktop_app_access }` (`PermissionAccess = "allowed"\|"denied"\|"unknown"`) | registry ConsentStore; `supported:false` off-Windows |
| `open_microphone_privacy_settings` | `commands/audio.rs` | `Result<(), String>` | Windows `ms-settings:privacy-microphone`; **Err on macOS/Linux** |
| `change_autostart_setting(enabled)` | `shortcut/mod.rs` | `Result<(), String>` | writes setting + applies autolaunch |
| `change_start_hidden_setting(enabled)` | `shortcut/mod.rs` | `Result<(), String>` | setting only |
| `change_show_tray_icon_setting(enabled)` | `shortcut/mod.rs` | `Result<(), String>` | applies `set_tray_visibility` immediately |
| `change_app_language_setting(language)` | `shortcut/mod.rs` | `Result<(), String>` | refreshes tray menu locale |
| `trigger_update_check` | `lib.rs` | `Result<(), String>` | re-emits `check-for-updates` if enabled |
| `check_apple_intelligence_available` | `commands/mod.rs` | `bool` | Swift bridge (adjacent subsystem) |

### Events (Rust → frontend)

| Event | Emitted from | Payload | Listener |
|---|---|---|---|
| `recording-error` | `actions.rs:570` | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail?: string }` | `App.tsx` → toast |
| `check-for-updates` | `lib.rs` tray handler + `trigger_update_check` | `()` | `src/components/update-checker/UpdateChecker.tsx` |
| `settings-changed` | `shortcut/mod.rs` (`change_autostart_setting`, `change_start_hidden_setting`, others) | `{ setting: string, value: any }` | **no frontend listener found** (dead event) |
| `model-state-changed` | `commands/models.rs` etc. | `ModelStateEvent` | `App.tsx` toast + Rust-side tray refresh (`lib.rs:293`) |
| `paste-error`, `transcription-error` | `actions.rs` (adjacent) | `()` / `string` | `App.tsx` toasts |

Tray menu item ids (native menu events, not Tauri events): `version`,
`settings`, `check_updates`, `copy_last_transcript`, `model_submenu`,
`model_select:<id>`, `unload_model`, `cancel`, `quit`.

## Settings keys (Tauri store, `src-tauri/src/settings.rs`)

| Key | Default | Read/written by |
|---|---|---|
| `onboarding_completed` | `false`; migration at `settings.rs:979` derives `true` from non-empty `selected_model` for pre-key installs | read `App.tsx`; written `commands/models.rs (switch_active_model)` — reached from both `set_active_model` and the tray `model_select:` handler (`lib.rs:265`) (and reverted on load failure) |
| `autostart_enabled` | `false` | applied `lib.rs:297-307`; toggled `change_autostart_setting` |
| `start_hidden` | `false` | window visibility + Accessory policy (`lib.rs`) |
| `show_tray_icon` | `true` | tray visibility, close-to-tray behavior, hidden-start override |
| `app_language` | system locale (`tauri_plugin_os::locale()`) | tray menu locale (`update_tray_menu`) |
| `update_checks_enabled` | `true` | gates `check_updates` menu item + `trigger_update_check` |
| `always_on_microphone` | `false` | if true, mic opens during `initialize_core_logic` → mic TCC prompt at launch instead of first recording |
| `selected_model` | — | tray model submenu; onboarding-migration proxy |

## Platform-specific behavior

- **macOS**: ad-hoc signing (`signingIdentity: "-"`) with hardened runtime;
  `macOSPrivateApi: true` for transparent NSPanel overlay; activation-policy
  dance (Accessory when hidden-to-tray, Regular when shown); autostart via
  LaunchAgent; overlay is an NSPanel (`overlay.rs:322`) that joins all Spaces
  and doesn't activate the app; tray icons are template images; min system
  version 10.15. Accessibility + mic permission flows as described above.
- **Windows**: mic permission read from registry
  (`HKLM/HKCU ...CapabilityAccessManager\ConsentStore\microphone` +
  `\NonPackaged`), request = deep link to `ms-settings:privacy-microphone`;
  `should_force_show_permissions_window` (Rust) forces the window visible at
  startup when denied; no accessibility concept (card hidden).
- **Linux**: no permission flow at all (onboarding auto-completes); tray always
  uses the pink "Colored" icon set; overlay uses GTK layer-shell when
  available.
- **Swift bridge** (`src-tauri/swift/`): Apple Intelligence only —
  `is_apple_intelligence_available`, `process_text_with_system_prompt_apple`,
  `free_apple_llm_response` (`apple_intelligence_bridge.h`), compiled per-build
  by `build.rs (build_apple_intelligence_bridge)` (real impl when the SDK ships
  `FoundationModels.framework`, else stub; weak-linked so the app launches on
  older macOS). No permission code lives here.

## Fragile points and failure modes

1. **Ad-hoc signing vs TCC** (`tauri.conf.json` `signingIdentity: "-"`): TCC
   grants are keyed to the code signature. Every ad-hoc rebuild changes the
   cdhash, so dev builds routinely lose/stale their Accessibility grant (the
   System Settings checkbox can stay on while `AXIsProcessTrusted` returns
   false), forcing re-onboarding or worse, a checked-but-dead toggle the user
   must manually remove and re-add. Murmur first-run/setup work must budget for
   a real signing identity.
2. **`request_accessibility_permission` is one-shot and mislabeled**: the
   plugin calls `AXIsProcessTrustedWithOptions` (prompt) — it never opens
   System Settings. If the user dismissed the original prompt, clicking
   "Grant Permission"/"Open System Settings"
   (`AccessibilityOnboarding.tsx (handleGrantAccessibility)`,
   `AccessibilityPermissions.tsx (handleButtonClick)`) does nothing visible and
   the UI sits in "Waiting..." polling forever. No deep link to
   Privacy & Security → Accessibility exists anywhere.
3. **Mic request is a silent no-op once denied**: plugin passes a nil
   completion handler to `requestAccessForMediaType`; if the status is already
   Denied there is no prompt, no error, and onboarding shows an endless
   "Waiting..." spinner. Unlike Windows (`open_microphone_privacy_settings`),
   there is no macOS command to open the Microphone privacy pane.
4. **Endless polling**: `AccessibilityOnboarding.tsx (startPolling)` stops only
   after 3 consecutive **exceptions**; checks that keep returning `false` poll
   at 1 Hz indefinitely with no timeout or "having trouble?" escape hatch.
5. **Swallowed init failures**: `App.tsx` post-onboarding
   `initializeEnigo`/`initializeShortcuts` failures are only `console.warn`ed —
   the user discovers them later as a dead hotkey or a `paste-error` toast.
   Same for permission-check failures in `checkOnboardingStatus` ("proceed to
   main app and let them fix it there").
6. **Autostart results discarded**: `lib.rs:301-307` and
   `shortcut/mod.rs (change_autostart_setting)` use `let _ =` on
   `autolaunch().enable()/disable()`. A failed LaunchAgent write (e.g. app
   translocation of an unsigned build) leaves the toggle on with no autostart
   and no feedback.
7. **`settings-changed` is a dead event**: emitted by several setting commands
   but nothing in `src/` listens for it.
8. **String-matching permission detection**: `recorder.rs
   (is_microphone_access_denied)` matches English cpal/OS error substrings and
   the WASAPI HRESULT. On macOS, TCC mic denial often does not error at stream
   open at all — CoreAudio can deliver silence — so a revoked-mic recording may
   produce an empty transcription with no `microphone_permission_denied` toast.
   The onboarding gate is the real protection on macOS; the runtime heuristic
   is mostly a Windows path.
9. **Tray code panics on failure**: `tray.rs (change_tray_icon)` uses
   `.expect("failed to resolve")`/`.expect("failed to set icon")` and every
   menu-item constructor `.expect(...)`s; a missing `resources/tray_*.png`
   crashes the app. `set_icon`/`set_menu`/`set_tooltip` results are dropped.
10. **Hidden-window recovery relies on the webview**: on macOS the "reveal
    window when permissions are missing" logic lives in frontend JS
    (`App.tsx (revealMainWindowForPermissions)`); the Rust-side force-show
    (`lib.rs (should_force_show_permissions_window)`) is Windows-only. If the
    webview fails to load while `start_hidden` is set and permissions were
    revoked, the only recovery is tray → Settings.
11. **`update_tray_menu` sets `set_icon_as_template(true)` unconditionally**
    (`tray.rs:231`) — fine on macOS, meaningless elsewhere, but note the Linux
    colored icons rely on this being a no-op there.
12. **`capabilities/desktop.json` duplicates `autostart:default` three times**
    — harmless, but a sign this file is hand-edited without review; it also
    scopes autostart/global-shortcut/updater to `main` only, so any future
    window that needs them must be added.
13. **Onboarding completion is coupled to model download**:
    `onboarding_completed` flips only in
    `commands/models.rs (switch_active_model)` (`models.rs:91`, write at
    `models.rs:120`) — reached from both `set_active_model` and the tray
    `model_select:` handler (`lib.rs:265`), so a tray model switch flips it
    too. A user who grants permissions but
    never picks a model re-enters full onboarding every launch (by design,
    but non-obvious).

## Cross-links (other subsystems)

- **Recording pipeline**: `actions.rs (TranscribeAction)` +
  `managers/audio.rs (AudioRecordingManager)` — consumer of mic permission;
  source of `recording-error`.
- **Shortcuts**: `shortcut/mod.rs (init_shortcuts)` via `initialize_shortcuts`;
  needs accessibility on macOS for key simulation side effects.
- **Input/paste**: `input.rs (EnigoState)` — created by `initialize_enigo`;
  accessibility-gated.
- **Overlay**: `overlay.rs` — `recording_overlay` window/panel; shares
  `capabilities/default.json` with `main`.
- **Models**: `commands/models.rs (switch_active_model)` (called by both
  `set_active_model` and the tray `model_select:` handler) writes
  `onboarding_completed`; tray model submenu.
- **Settings store**: `settings.rs (get_settings / write_settings)`.
- **i18n**: `src/i18n/locales/*/translation.json` — `tray` section compiled
  into Rust by `build.rs`; `accessibility.*`, `onboarding.permissions.*`,
  `errors.micPermissionDenied.*` strings used by the flows above.
- **Apple Intelligence post-processing**: `apple_intelligence.rs` +
  `src-tauri/swift/*` (adjacent; no permissions involvement).
- **Updater**: `check-for-updates` event → `UpdateChecker.tsx`.
