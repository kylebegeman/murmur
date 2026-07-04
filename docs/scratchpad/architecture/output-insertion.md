# Output Insertion Subsystem: Paste, Typing, Clipboard, Auto-Submit

Status: scratchpad architecture map, written 2026-07-04 as part of the Handy -> Murmur
pipeline mapping. Describes the code as it exists today; no changes proposed here.

## Purpose

This subsystem takes the final transcription string (after optional post-processing)
and delivers it into whatever app currently has keyboard focus. It supports several
delivery strategies (clipboard + simulated paste keystroke, direct synthetic typing,
external script, or none), optionally presses Enter/Ctrl+Enter/Cmd+Enter afterwards
("auto-submit"), and optionally leaves the transcript on the clipboard. It is the last
stage of the dictation pipeline and the stage most exposed to OS-level fragility
(macOS accessibility permission, Wayland/X11 tool availability, focus changes).

## Key Files

| File                                                    | Role                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/clipboard.rs`                            | The whole insertion engine: `paste()` entry point, clipboard save/write/restore, paste-keystroke dispatch, direct typing, external script execution, auto-submit, Linux tool detection/execution. |
| `src-tauri/src/input.rs`                                | Low-level enigo wrappers: `EnigoState` managed state, layout-independent paste key combos, `paste_text_direct` (enigo `.text()`), `get_cursor_position` (used by overlay, not insertion).         |
| `src-tauri/src/utils.rs`                                | Facade module; `pub use crate::clipboard::*;` so callers use `utils::paste(...)`.                                                                                                                 |
| `src-tauri/src/actions.rs`                              | The only production caller of `paste()` (line ~764, inside the transcription-finished handler). Emits the `paste-error` event on failure.                                                         |
| `src-tauri/src/shortcut/mod.rs`                         | Tauri commands that mutate insertion-related settings (`change_paste_method_setting`, `change_typing_tool_setting`, `change_auto_submit_setting`, etc.) and `get_available_typing_tools`.         |
| `src-tauri/src/commands/mod.rs`                         | `initialize_enigo` command: lazily creates `EnigoState` after macOS accessibility is granted.                                                                                                     |
| `src-tauri/src/settings.rs`                             | Setting enums (`PasteMethod`, `ClipboardHandling`, `AutoSubmitKey`, `TypingTool`) and defaults.                                                                                                   |
| `src/components/settings/PasteMethod.tsx`               | UI dropdown for `paste_method` + external script path input.                                                                                                                                      |
| `src/components/settings/TypingTool.tsx`                | UI dropdown for `typing_tool` (Linux only, only when `paste_method == "direct"`).                                                                                                                 |
| `src/components/settings/AutoSubmit.tsx`                | UI dropdown combining `auto_submit` (bool) and `auto_submit_key` (enum) into one Off/Enter/Ctrl+Enter/Cmd+Enter selector.                                                                         |
| `src/components/settings/ClipboardHandling.tsx`         | UI dropdown for `clipboard_handling`.                                                                                                                                                             |
| `src/components/settings/AppendTrailingSpace.tsx`       | Toggle for `append_trailing_space` (applied inside `paste()`, listed under the "transcription" settings group).                                                                                   |
| `src/components/settings/debug/PasteDelay.tsx`          | Debug-only slider for `paste_delay_ms` (default 60).                                                                                                                                              |
| `src/components/settings/advanced/AdvancedSettings.tsx` | Composes the "Output" settings group (PasteMethod, TypingTool, ClipboardHandling, AutoSubmit).                                                                                                    |
| `src/stores/settingsStore.ts`                           | Maps each settings key to its specific `change_*_setting` Tauri command (optimistic update + revert on failure).                                                                                  |
| `src/App.tsx`                                           | Listens for the `paste-error` event and shows a toast; triggers `initialize_enigo` after onboarding.                                                                                              |
| `src/components/onboarding/AccessibilityOnboarding.tsx` | macOS/Windows permission onboarding; calls `initialize_enigo` + `initialize_shortcuts` once accessibility is granted.                                                                             |
| `src/components/AccessibilityPermissions.tsx`           | Persistent banner in the main window when macOS accessibility is missing.                                                                                                                         |

## Key Functions, Structs, Components

### Rust

- `src-tauri/src/clipboard.rs (paste)` — public entry point. Signature:
  `pub fn paste(text: String, app_handle: AppHandle) -> Result<(), String>`.
  Reads settings, optionally appends a trailing space, locks the managed `EnigoState`,
  dispatches on `PasteMethod`, then optionally auto-submits and optionally copies to
  clipboard. Every sub-step returns `Result<(), String>`; the first failure aborts the
  rest of the function.
- `src-tauri/src/clipboard.rs (paste_via_clipboard)` — clipboard strategy:
  1. `clipboard.read_text().unwrap_or_default()` saves current clipboard **text**
     (non-text content becomes an empty string).
  2. Writes transcript to clipboard (`tauri_plugin_clipboard_manager`; on Wayland
     prefers `wl-copy` via `write_clipboard_via_wl_copy`).
  3. Sleeps `paste_delay_ms` (default 60 ms).
  4. Sends the paste keystroke: on Linux tries native tools first
     (`try_send_key_combo_linux`); otherwise/fallback uses enigo
     (`input::send_paste_ctrl_v` / `send_paste_ctrl_shift_v` / `send_paste_shift_insert`).
  5. Sleeps a fixed 50 ms.
  6. Restores the saved clipboard text, errors ignored (`let _ = ...`).
- `src-tauri/src/clipboard.rs (paste_direct)` — direct typing strategy. On Linux first
  tries `try_direct_typing_linux` (honors the `typing_tool` setting or an auto fallback
  chain), then falls back to `input::paste_text_direct` (enigo `.text()`). On
  macOS/Windows it is enigo `.text()` only.
- `src-tauri/src/clipboard.rs (paste_via_external_script)` — runs
  `Command::new(script_path).arg(text)`; non-zero exit becomes an `Err` including exit
  code, stderr, and stdout.
- `src-tauri/src/clipboard.rs (send_return_key)` — presses Return, Ctrl+Return, or
  Cmd(Meta)+Return via enigo depending on `AutoSubmitKey`.
- `src-tauri/src/clipboard.rs (should_send_auto_submit)` — pure helper:
  `auto_submit && paste_method != PasteMethod::None`. Unit-tested at the bottom of the file.
- `src-tauri/src/clipboard.rs (get_available_typing_tools)` — Linux-only probe
  (`which wtype/kwtype/dotool/ydotool/xdotool`), always includes `"auto"` first.
- Linux tool plumbing in `clipboard.rs`: `try_send_key_combo_linux`,
  `try_direct_typing_linux`, `is_{wtype,kwtype,dotool,ydotool,xdotool,wl_copy}_available`,
  `type_text_via_{wtype,xdotool,dotool,ydotool,kwtype}`,
  `send_key_combo_via_{wtype,dotool,ydotool,xdotool}`, `write_clipboard_via_wl_copy`.
  Tool selection depends on `crate::utils::is_wayland()` / `is_kde_wayland()`
  (wtype is skipped on KDE Wayland; kwtype preferred there).
- `src-tauri/src/input.rs (EnigoState)` — `pub struct EnigoState(pub Mutex<Enigo>)`,
  stored in Tauri managed state. `EnigoState::new()` constructs `Enigo` and is where
  macOS accessibility failure surfaces.
- `src-tauri/src/input.rs (send_paste_ctrl_v)` — layout-independent paste combo:
  macOS `Key::Meta` + `Key::Other(9)` (kVK_ANSI_V), Windows `Key::Control` +
  `Key::Other(0x56)` (VK_V), Linux `Key::Control` + `Key::Unicode('v')`. Holds the
  modifier, clicks V, sleeps 100 ms, releases.
- `src-tauri/src/input.rs (send_paste_ctrl_shift_v)` — same pattern plus Shift. On
  macOS this becomes Cmd+Shift+V (the UI never offers it on macOS, but the backend
  would execute it if the setting were set by hand).
- `src-tauri/src/input.rs (send_paste_shift_insert)` — Shift + `Key::Other(0x2D)`
  (VK_INSERT) on Windows, Shift + `Key::Other(0x76)` elsewhere (an X11 Insert keycode;
  on macOS 0x76 is kVK_F4, so this method is wrong on macOS — the UI hides it there).
- `src-tauri/src/input.rs (paste_text_direct)` — `enigo.text(text)`.
- `src-tauri/src/commands/mod.rs (initialize_enigo)` — idempotent Tauri command; creates
  and `app.manage()`s `EnigoState`. Errors with "Failed to initialize input system: ..."
  (on macOS this means accessibility not granted). **Enigo is never initialized in Rust
  setup** — see the comment in `src-tauri/src/lib.rs (initialize_core_logic)`: the
  frontend must call `initialize_enigo` after onboarding to avoid premature macOS
  permission dialogs.
- `src-tauri/src/actions.rs` (transcription-finished handler, ~line 748–782) — the call
  site. If `processed.final_text` is non-empty, it schedules
  `utils::paste(final_text, ah_clone)` **on the main thread** via
  `ah.run_on_main_thread`, re-checking cancellation first. On `Err`, logs
  `error!("Failed to paste transcription: {}", e)` and emits `paste-error` (unit
  payload). On `Ok`, only a `debug!` log. Then hides the recording overlay and resets
  the tray icon either way.

### Frontend

- `src/components/settings/PasteMethod.tsx (PasteMethodSetting)` — options: `ctrl_v`
  ("clipboard" label, Cmd/Ctrl adjusted per OS), `direct`, `none`; plus `ctrl_shift_v`
  and `shift_insert` on Windows/Linux; plus `external_script` on Linux only. Shows a
  text input for `external_script_path` when `external_script` selected.
- `src/components/settings/TypingTool.tsx (TypingToolSetting)` — renders only on Linux
  and only when `paste_method === "direct"`. Fetches `commands.getAvailableTypingTools()`
  on mount; on error silently falls back to `["auto"]`.
- `src/components/settings/AutoSubmit.tsx (AutoSubmit)` — single dropdown mapping
  `off` -> `auto_submit=false`; `enter|ctrl_enter|cmd_enter` -> writes `auto_submit_key`
  and then `auto_submit=true` if it was off (two sequential `updateSetting` calls). The
  Cmd+Enter label shows "Cmd" on macOS and "Super" elsewhere.
- `src/components/settings/ClipboardHandling.tsx (ClipboardHandlingSetting)` —
  `dont_modify` vs `copy_to_clipboard`.
- `src/stores/settingsStore.ts (settingUpdaters)` (settingsStore.ts:76, used at
  line 294) — routes each key to its command
  (e.g. `paste_method` -> `commands.changePasteMethodSetting`). Updates are optimistic
  in the zustand store; on command failure the `updateSetting` catch block
  (settingsStore.ts:300-304) only reverts the key to its original value via `set(...)`
  — it never calls `refreshSettings()` (that only happens in other flows such as
  `resetBinding` and `setPostProcessProvider`, which the insertion settings keys
  don't use).
- `src/App.tsx` — `listen("paste-error", ...)` -> `toast.error(t("errors.pasteFailedTitle"), { description: t("errors.pasteFailed") })`.
  Deliberately generic: the comment notes the technical detail lives in `murmur.log`.

## Runtime Flow (happy path, macOS defaults)

1. Transcription completes in `src-tauri/src/actions.rs`; `processed.final_text` is
   non-empty.
2. `ah.run_on_main_thread(...)` schedules the paste on the Tauri main thread
   (needed for reliable CGEvent posting on macOS).
3. `utils::paste` == `src-tauri/src/clipboard.rs (paste)`:
   1. `get_settings(&app_handle)` reads the settings store.
   2. If `append_trailing_space`, text becomes `"{text} "`.
   3. `app_handle.try_state::<EnigoState>()` — error `"Enigo state not initialized"`
      if `initialize_enigo` never succeeded (e.g. macOS accessibility denied). Note
      this check happens **before** the `PasteMethod` match, so even
      `PasteMethod::None` and `ExternalScript` fail without Enigo.
   4. Match on `paste_method` (default: `CtrlV` on macOS/Windows, `Direct` on Linux):
      - `None`: log and skip.
      - `Direct`: `paste_direct` (Linux native tools first, else enigo `.text()`).
      - `CtrlV`/`CtrlShiftV`/`ShiftInsert`: `paste_via_clipboard` — save clipboard
        text, write transcript, sleep `paste_delay_ms` (60 ms), send paste keystroke
        (on macOS: Cmd held + virtual keycode 9 clicked + 100 ms + release), sleep
        50 ms, restore old clipboard text (errors ignored).
      - `ExternalScript`: run `external_script_path` with text as the single argument
        (errors if path unset/empty).
   5. If `auto_submit && paste_method != None`: sleep 50 ms, `send_return_key` with
      `auto_submit_key` (Enter / Ctrl+Enter / Cmd+Enter).
   6. If `clipboard_handling == CopyToClipboard`: write the (possibly space-suffixed)
      transcript back to the clipboard, overwriting the restore from step 4.
4. Back in `actions.rs`: `Ok` -> debug log only. `Err` -> `error!` log +
   `app.emit("paste-error", ())`.
5. `src/App.tsx` shows the "paste failed" toast (only visible if the main settings
   window is visible). Overlay hidden and tray icon reset regardless of outcome.

## Tauri Commands and Events

### Frontend -> Rust commands

| Command (snake_case / binding)                                                       | Defined in                                                             | Args -> Return                                   | Notes                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize_enigo` / `commands.initializeEnigo()`                                    | `src-tauri/src/commands/mod.rs`                                        | none -> `Result<null, string>`                   | Creates `EnigoState`; called from `App.tsx` post-onboarding and `AccessibilityOnboarding.tsx` after accessibility grant. Idempotent. |
| `initialize_shortcuts` / `initializeShortcuts()`                                     | `src-tauri/src/commands/mod.rs`                                        | none -> `Result<null, string>`                   | Adjacent (shortcut subsystem) but called in the same places.                                                                         |
| `get_available_typing_tools` / `getAvailableTypingTools()`                           | `src-tauri/src/shortcut/mod.rs` (delegates to `clipboard.rs` on Linux) | none -> `string[]`                               | Non-Linux always returns `["auto"]`.                                                                                                 |
| `change_paste_method_setting` / `changePasteMethodSetting(method)`                   | `src-tauri/src/shortcut/mod.rs`                                        | `method: string` -> `Result<null, string>`       | Unknown strings warn + default to `ctrl_v`.                                                                                          |
| `change_typing_tool_setting` / `changeTypingToolSetting(tool)`                       | `src-tauri/src/shortcut/mod.rs`                                        | `tool: string` -> `Result<null, string>`         | Unknown strings warn + default to `auto`.                                                                                            |
| `change_external_script_path_setting` / `changeExternalScriptPathSetting(path)`      | `src-tauri/src/shortcut/mod.rs`                                        | `path: string \| null` -> `Result<null, string>` | No validation of existence/executability.                                                                                            |
| `change_clipboard_handling_setting` / `changeClipboardHandlingSetting(handling)`     | `src-tauri/src/shortcut/mod.rs`                                        | `handling: string` -> `Result<null, string>`     | Unknown -> `dont_modify`.                                                                                                            |
| `change_auto_submit_setting` / `changeAutoSubmitSetting(enabled)`                    | `src-tauri/src/shortcut/mod.rs`                                        | `enabled: boolean` -> `Result<null, string>`     |                                                                                                                                      |
| `change_auto_submit_key_setting` / `changeAutoSubmitKeySetting(key)`                 | `src-tauri/src/shortcut/mod.rs`                                        | `key: string` -> `Result<null, string>`          | Unknown -> `enter`.                                                                                                                  |
| `change_paste_delay_ms_setting` / `changePasteDelayMsSetting(ms)`                    | `src-tauri/src/shortcut/mod.rs`                                        | `ms: number` -> `Result<null, string>`           | Debug settings page only.                                                                                                            |
| `change_append_trailing_space_setting` / `changeAppendTrailingSpaceSetting(enabled)` | `src-tauri/src/shortcut/mod.rs`                                        | `enabled: boolean` -> `Result<null, string>`     |                                                                                                                                      |

All `change_*` commands are registered in `src-tauri/src/lib.rs` (lines ~550–573, 602)
and follow the same pattern: read settings, mutate one field, `settings::write_settings`.
They never fail in practice (always `Ok(())`).

### Rust -> frontend events

| Event         | Emitted from                                                             | Payload                | Consumer                                                                                                                 |
| ------------- | ------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `paste-error` | `src-tauri/src/actions.rs` (`let _ = ah_clone.emit("paste-error", ());`) | `()` (null; no detail) | `src/App.tsx` -> generic sonner toast (`errors.pasteFailedTitle` / `errors.pasteFailed`). Emit result itself is ignored. |

That is the **only** event this subsystem emits. There is no success event, no
"inserted N chars" event, and no per-strategy detail. (`transcription-error` and
`recording-error` are adjacent pipeline events, not part of insertion.)

## Settings Keys

All live in the single `AppSettings` struct (`src-tauri/src/settings.rs`), persisted via
`settings::write_settings` (tauri store; settings subsystem).

| Key                     | Type / values                                                                 | Default                                    | Used in                                           |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `paste_method`          | `ctrl_v \| direct \| none \| shift_insert \| ctrl_shift_v \| external_script` | `ctrl_v` (macOS/Windows), `direct` (Linux) | `clipboard.rs (paste)` dispatch                   |
| `paste_delay_ms`        | `u64` ms                                                                      | `60`                                       | delay between clipboard write and paste keystroke |
| `typing_tool`           | `auto \| wtype \| kwtype \| dotool \| ydotool \| xdotool`                     | `auto`                                     | Linux `paste_direct` only                         |
| `external_script_path`  | `Option<String>`                                                              | `None`                                     | `ExternalScript` method                           |
| `clipboard_handling`    | `dont_modify \| copy_to_clipboard`                                            | `dont_modify`                              | post-paste clipboard copy                         |
| `auto_submit`           | `bool`                                                                        | `false`                                    | gate for `send_return_key`                        |
| `auto_submit_key`       | `enter \| ctrl_enter \| cmd_enter`                                            | `enter`                                    | which submit combo                                |
| `append_trailing_space` | `bool`                                                                        | `false`                                    | text mutation inside `paste()`                    |

## Platform-Specific Behavior

### macOS

- **Hard dependency on Accessibility permission.** Enigo (CGEvent-based) cannot be
  constructed without it. `EnigoState` is created only by the `initialize_enigo`
  command, which the frontend calls (a) during `AccessibilityOnboarding` once
  `checkAccessibilityPermission()` (from `tauri-plugin-macos-permissions-api`) returns
  true, and (b) in `App.tsx` when onboarding is already done. If permission is revoked
  later, the already-constructed Enigo may silently stop delivering events; there is no
  runtime re-check inside `paste()`.
- Paste keystroke is Cmd+V using virtual keycode 9 (kVK_ANSI_V), which is keyboard-layout
  independent.
- `paste()` is executed on the main thread (`run_on_main_thread` in `actions.rs`).
- `shift_insert` would send Shift+0x76 (kVK_F4) — broken on macOS, but the UI never
  offers it there.
- `AccessibilityPermissions.tsx` renders a "grant permission" banner in the main window
  whenever accessibility is missing; onboarding polls permission state every 1 s.

### Windows

- Cmd is replaced by Ctrl (`Key::Control` + `Key::Other(0x56)` = VK_V). Insert is
  VK_INSERT (0x2D). No special permission needed. Onboarding checks only microphone.

### Linux

- Most complex path. Both the paste-keystroke and direct-typing strategies first try
  external CLI tools, chosen by display server:
  - Wayland: kwtype (KDE only, direct typing), wtype (skipped on KDE), dotool, ydotool.
  - X11: xdotool, then ydotool.
  - Clipboard writes prefer `wl-copy` on Wayland (better umlaut handling; uses
    `Stdio::null()` to avoid a fork/fd-inherit hang documented in
    `write_clipboard_via_wl_copy`).
- Tool availability is probed with `which` on every paste (spawned processes each time).
- If no tool is available it silently falls back to enigo, which frequently does not
  work on Wayland (comments in `input.rs` acknowledge this).
- `external_script` paste method and the typing-tool dropdown are Linux-only in the UI
  (backend would honor them anywhere).

## Fragile Points and Failure Modes

1. **Silent success is unverifiable.** `paste()` returns `Ok` as soon as the synthetic
   keystroke/typing calls succeed. Nothing confirms the frontmost app actually received
   the text (wrong focus, no text field, secure input fields, sandboxed apps that block
   synthetic events). The user gets zero feedback in this case: the overlay hides, the
   tray goes idle, and the debug log claims "Text pasted successfully". This is the
   main gap Murmur's insertion-result feedback must address.
2. **`paste-error` feedback only reaches a visible main window.** The toast lives in the
   settings window's webview (`src/App.tsx`). Handy is a tray app; if the window is
   hidden or closed during dictation (the normal case), the toast is never seen. The
   emit is also `let _ =`-ignored. Detail exists only in `murmur.log`.
3. **Non-text clipboard content is destroyed.** `paste_via_clipboard` saves the old
   clipboard with `read_text().unwrap_or_default()`. Images, files, or rich content
   read as `""`, and the "restore" then overwrites the user's clipboard with an empty
   string. Silent data loss, no error, no feedback.
4. **Clipboard restore failures are swallowed** (`let _ = clipboard.write_text(...)`
   in `clipboard.rs (paste_via_clipboard)`, both Linux and non-Linux branches).
5. **Timing races on fixed sleeps.** 60 ms (`paste_delay_ms`) between clipboard write
   and Cmd+V, 100 ms modifier hold, 50 ms before clipboard restore, 50 ms before
   auto-submit. Slow apps (Electron, remote desktops, VMs) can read the clipboard after
   restore (pasting the _old_ content) or receive Enter before the paste is processed.
   The only knob is the debug-only `paste_delay_ms` slider.
6. **Enigo requirement blocks even no-op paths.** `paste()` locks `EnigoState` before
   matching `paste_method`, so `PasteMethod::None` and `ExternalScript` also fail with
   `"Enigo state not initialized"` when accessibility was never granted.
7. **Stale Enigo after permission revocation.** If macOS accessibility is revoked while
   the app runs, `EnigoState` still exists; key events are posted but the OS drops
   them. `paste()` still returns `Ok`. No re-check, no error, no feedback.
8. **Auto-submit fires blind.** `send_return_key` runs 50 ms after paste with no
   verification the paste landed; a failed-but-Ok paste (case 1) still presses Enter in
   whatever has focus, potentially submitting an empty or wrong form. (It _is_ skipped
   when the paste step returns `Err`, since `?` aborts earlier, and when
   `paste_method == none` via `should_send_auto_submit`.)
9. **Settings parsing silently coerces.** `change_paste_method_setting` and friends map
   unknown strings to defaults with only a `warn!` log, returning `Ok` to the frontend,
   so a UI/backend enum drift would go unnoticed.
10. **External script risks.** `paste_via_external_script` executes an arbitrary
    user-configured path with the transcript as argv (transcript visible in process
    lists). Path is not validated when saved; failure detail (exit code, stderr,
    stdout) is good, but surfaces only as the generic toast + log.
11. **Enigo mutex poisoning.** A panic while holding the `EnigoState` lock would make
    every later paste fail with "Failed to lock Enigo".
12. **`run_on_main_thread` failure path skips the error event.** In `actions.rs`, if
    scheduling on the main thread fails, the closure never runs: it logs an error and
    resets UI, but no `paste-error` is emitted, so the text silently vanishes (it may
    still be recoverable from history).
13. **Linux tool probing per paste.** `which` subprocesses on every insertion; a PATH
    change mid-session changes behavior silently (logged at info level only).
14. **History "copy" is a separate, weaker path.** `src/components/settings/history/HistorySettings.tsx (copyToClipboard)`
    uses `navigator.clipboard.writeText` with errors only `console.error`ed; it does not
    reuse this subsystem.

## Existing User Feedback Summary (for Murmur insertion-result work)

- Success: nothing user-visible (debug log line only; overlay hides, tray resets).
- Mechanical failure (enigo error, clipboard write error, script non-zero exit, missing
  script path, Enigo not initialized): `paste-error` event -> generic toast in the main
  window, full detail in `murmur.log` only.
- Logical failure (text never landed in the target app, clipboard image lost, restore
  race): reported as success. The transcript is recoverable from history, and from the
  clipboard only if `clipboard_handling = copy_to_clipboard`.

## Cross-Links to Other Subsystems

- **Transcription pipeline** (`src-tauri/src/actions.rs`): produces `final_text`,
  handles cancellation checks around the paste, saves history entries before pasting.
- **Overlay/tray** (`src-tauri/src/overlay.rs`, `tray.rs` via `utils::hide_recording_overlay`,
  `change_tray_icon`): visual state reset after paste; `input::get_cursor_position` is
  consumed by overlay positioning.
- **Settings subsystem** (`src-tauri/src/settings.rs` `get_settings`/`write_settings`,
  `src/stores/settingsStore.ts`): all knobs above.
- **Permissions/onboarding** (`tauri-plugin-macos-permissions-api`,
  `src/components/onboarding/AccessibilityOnboarding.tsx`,
  `src-tauri/src/commands/mod.rs (initialize_enigo)`): gates Enigo creation on macOS.
- **Shortcut subsystem** (`src-tauri/src/shortcut/mod.rs`): hosts the settings commands
  for historical reasons; also initialized alongside Enigo.
- **History** (`src-tauri/src/managers/history*`, `HistorySettings.tsx`): the fallback
  place users can retrieve text when insertion fails.
