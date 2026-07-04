# Global Shortcuts Subsystem

Map of the global keyboard shortcut layer in Handy (being evolved into Murmur).
Repo root: `/Users/kyle/Developer/products/murmur-new`. All paths below are repo-relative.

## Purpose

Global (system-wide) hotkeys are the primary trigger for the dictation pipeline:
press a shortcut anywhere in the OS to start/stop recording, optionally run AI
post-processing, or cancel an in-flight recording. The subsystem:

- Persists named **bindings** (`transcribe`, `transcribe_with_post_process`, `cancel`)
  in the settings store and maps them to **actions** via a static `ACTION_MAP`.
- Supports two swappable **backends** selected by the `keyboard_implementation`
  setting: Tauri's `global-shortcut` plugin (`tauri`) and the `handy-keys` crate
  (`handy_keys`, v0.2.4 from crates.io).
- Delegates **toggle vs push-to-talk** semantics to the `TranscriptionCoordinator`
  (a separate subsystem) — the shortcut layer only reports press/release.
- Provides the **rebinding UX**: two different key-capture UIs (webview JS events
  for the Tauri backend, native key events streamed from Rust for handy-keys).

## Key Files and Roles

| File                                                                   | Role                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/shortcut/mod.rs`                                        | Backend dispatcher + all binding-management Tauri commands (`change_binding`, `reset_binding`, `suspend_binding`, `resume_binding`, implementation switching). Also hosts ~50 unrelated general-settings commands (see Gotchas). |
| `src-tauri/src/shortcut/handler.rs`                                    | Shared press/release event handler used by both backends: `handle_shortcut_event`.                                                                                                                                               |
| `src-tauri/src/shortcut/tauri_impl.rs`                                 | Backend A: `tauri-plugin-global-shortcut` registration/validation.                                                                                                                                                               |
| `src-tauri/src/shortcut/handy_keys.rs`                                 | Backend B: `handy-keys` crate; dedicated manager thread owning `HotkeyManager`; recording mode for UI key capture; `start/stop_handy_keys_recording` commands.                                                                   |
| `src-tauri/src/commands/mod.rs`                                        | `initialize_shortcuts` command — the actual entry point that registers shortcuts (deferred until frontend calls it). Marker state `ShortcutsInitialized`.                                                                        |
| `src-tauri/src/actions.rs`                                             | `ShortcutAction` trait, `ACTION_MAP` (binding id → action), `TranscribeAction`, `CancelAction`, `TestAction`.                                                                                                                    |
| `src-tauri/src/transcription_coordinator.rs`                           | Toggle vs PTT state machine (`Stage::Idle/Recording/Processing`), 30 ms press debounce, `is_transcribe_binding`. (Other subsystem, interface only.)                                                                              |
| `src-tauri/src/settings.rs`                                            | `ShortcutBinding` struct, `KeyboardImplementation` enum + platform default, default bindings in `get_default_settings`, binding merge on load, `get_bindings` / `get_stored_binding`.                                            |
| `src-tauri/src/signal_handle.rs`                                       | SIGUSR1/SIGUSR2 → coordinator as toggle inputs; alternate non-keyboard trigger path.                                                                                                                                             |
| `src/components/settings/ShortcutInput.tsx`                            | Wrapper choosing the capture UI per `keyboard_implementation`.                                                                                                                                                                   |
| `src/components/settings/GlobalShortcutInput.tsx`                      | Tauri-backend rebinding UI (JS `keydown`/`keyup` in the settings window).                                                                                                                                                        |
| `src/components/settings/HandyKeysShortcutInput.tsx`                   | handy-keys rebinding UI (backend-streamed key events via `handy-keys-event`).                                                                                                                                                    |
| `src/components/settings/debug/KeyboardImplementationSelector.tsx`     | Debug-settings dropdown to switch backends at runtime.                                                                                                                                                                           |
| `src/stores/settingsStore.ts`                                          | `updateBinding` (optimistic update + rollback, calls `changeBinding`), `resetBinding`.                                                                                                                                           |
| `src/lib/utils/keyboard.ts`                                            | `getKeyName`, `normalizeKey`, `formatKeyCombination` — JS key naming and display formatting.                                                                                                                                     |
| `src/App.tsx`, `src/components/onboarding/AccessibilityOnboarding.tsx` | Callers of `initializeShortcuts()` (post-onboarding / after macOS accessibility grant).                                                                                                                                          |

## Core Types

- `src-tauri/src/settings.rs (ShortcutBinding)` — `{ id, name, description, default_binding, current_binding }`, stored in `AppSettings.bindings: HashMap<String, ShortcutBinding>`.
- `src-tauri/src/settings.rs (KeyboardImplementation)` — `Tauri | HandyKeys`; `Default` is **HandyKeys on macOS/Windows, Tauri on Linux**.
- `src-tauri/src/actions.rs (ShortcutAction)` — trait with `start(app, binding_id, shortcut_str)` and `stop(...)`.
- `src-tauri/src/actions.rs (ACTION_MAP)` — static `Lazy<HashMap<String, Arc<dyn ShortcutAction>>>`:
  - `"transcribe"` → `TranscribeAction { post_process: false }`
  - `"transcribe_with_post_process"` → `TranscribeAction { post_process: true }`
  - `"cancel"` → `CancelAction`
  - `"test"` → `TestAction` (log-only; has no default binding, so unreachable unless a binding with id `test` is created)
- `src-tauri/src/shortcut/handy_keys.rs (HandyKeysState)` — managed Tauri state: command channel to manager thread, recording listener, recording flags.
- `src-tauri/src/shortcut/handy_keys.rs (FrontendKeyEvent)` — payload of `handy-keys-event`.
- `src-tauri/src/shortcut/mod.rs (BindingResponse)` — `{ success: bool, binding: Option<ShortcutBinding>, error: Option<String> }`.
- `src-tauri/src/shortcut/mod.rs (ImplementationChangeResult)` — `{ success: bool, reset_bindings: Vec<String> }`.

## Default Bindings

Defined in `src-tauri/src/settings.rs (get_default_settings)`:

| id                             | macOS                | Windows/Linux      | Notes                                                                       |
| ------------------------------ | -------------------- | ------------------ | --------------------------------------------------------------------------- |
| `transcribe`                   | `option+space`       | `ctrl+space`       | Main dictation hotkey                                                       |
| `transcribe_with_post_process` | `option+shift+space` | `ctrl+shift+space` | Registered only when `post_process_enabled`                                 |
| `cancel`                       | `escape`             | `escape`           | **Dynamically** registered only while recording; disabled entirely on Linux |

On settings load, `load_or_create_app_settings` merges any missing default binding
ids into the stored map, so new binding ids added in code appear for existing users.

## Runtime Flow

### 1. Registration at startup

1. Rust does **not** register shortcuts in `setup()`. The frontend calls the
   `initialize_shortcuts` command — from `src/App.tsx` once onboarding is `done`,
   or from `AccessibilityOnboarding.tsx` as soon as macOS accessibility is granted.
2. `src-tauri/src/commands/mod.rs (initialize_shortcuts)` is idempotent
   (guarded by `ShortcutsInitialized` marker state) and calls
   `src-tauri/src/shortcut/mod.rs (init_shortcuts)`.
3. `init_shortcuts` reads `keyboard_implementation` and dispatches:
   - `Tauri` → `tauri_impl::init_shortcuts`: iterates **default** binding ids,
     applies user overrides from settings, skips `cancel` (dynamic) and skips
     `transcribe_with_post_process` if post-processing is off, registers each.
   - `HandyKeys` → `handy_keys::init_shortcuts`: creates `HandyKeysState`
     (spawns the manager thread that owns `HotkeyManager::new_with_blocking()`),
     registers the same binding set through the command channel, then
     `app.manage(state)`.
   - If handy-keys init fails, it **silently falls back to Tauri and rewrites**
     `keyboard_implementation = tauri` in the settings store (`shortcut/mod.rs (init_shortcuts)`).

### 2. Hotkey fires

1. Backend delivers press/release:
   - Tauri: closure in `tauri_impl::register_shortcut` → `event.state == ShortcutState::Pressed`.
   - handy-keys: manager thread poll loop in `handy_keys::HandyKeysState::manager_thread`
     (`manager.try_recv()`, `HotkeyState::Pressed`), dispatching synchronously on that thread.
2. Both call `src-tauri/src/shortcut/handler.rs (handle_shortcut_event)(app, binding_id, hotkey_string, is_pressed)`:
   - If `is_transcribe_binding(binding_id)` (`transcribe` / `transcribe_with_post_process`):
     forward to `TranscriptionCoordinator::send_input(binding_id, hotkey_string, is_pressed, settings.push_to_talk)` and return. If the coordinator state is missing, only a `warn!` is logged.
   - If `binding_id == "cancel"`: fire `action.start` only when
     `AudioRecordingManager::is_recording()` and it is a press.
   - Otherwise (`test`): `action.start` on press, `action.stop` on release.

### 3. Toggle vs push-to-talk (coordinator, other subsystem)

`src-tauri/src/transcription_coordinator.rs`: a single thread serializes all inputs.
Presses within 30 ms of the previous press are debounced (`DEBOUNCE`); releases always pass.

- **Push-to-talk** (`push_to_talk == true`, the default): press while `Stage::Idle`
  → `start()`; release while `Stage::Recording(id)` **for the same binding id** → `stop()`.
- **Toggle** (`push_to_talk == false`): press while Idle → `start()`; press again
  while Recording the same id → `stop()`; presses while `Processing` or while a
  _different_ binding is recording are ignored ("pipeline busy"). Releases ignored.
- `start()` calls `ACTION_MAP[binding_id].start(...)` and only transitions to
  `Recording` if the audio manager actually started; `stop()` calls `.stop(...)`
  and moves to `Processing` until `notify_processing_finished()` (fired by the
  `FinishGuard` drop guard in `actions.rs`).
- The same entry point serves non-keyboard triggers:
  `src-tauri/src/signal_handle.rs (send_transcription_input)` sends
  `(is_pressed: true, push_to_talk: false)` — i.e., signals/CLI always act as toggles
  (SIGUSR2 → `transcribe`, SIGUSR1 → `transcribe_with_post_process`).

### 4. Cancel shortcut lifecycle

- `TranscribeAction::start` (on successful recording start) calls
  `shortcut::register_cancel_shortcut(app)`; `TranscribeAction::stop` and
  `utils::cancel_current_operation` call `unregister_cancel_shortcut`.
- Both are dispatched per-backend and run in a spawned async task "to avoid
  deadlock"; registration errors are only logged. Entirely compiled out on Linux.
- `CancelAction::start` → `src-tauri/src/utils.rs (cancel_current_operation)`:
  unregisters the cancel shortcut, cancels recording + stream, resets tray/overlay,
  notifies the coordinator.

### 5. Rebinding (user changes a shortcut)

Common path: both UIs end in `settingsStore.ts (updateBinding)` → optimistic local
update → `commands.changeBinding(id, binding)` → rollback + rethrow on failure.

`src-tauri/src/shortcut/mod.rs (change_binding)`:

1. Rejects empty strings (`Err`).
2. Looks up the stored binding; if missing, clones from defaults (warns); unknown
   id in defaults → `Ok(BindingResponse{ success:false, error })`.
3. Special case `id == "cancel"`: just persist the new string (it is dynamic), return.
4. Otherwise: **unregister old → validate new for the current backend → register new
   → persist**. See Fragile Points for the ordering hazard.

Validation differs per backend:

- `tauri_impl::validate_shortcut`: non-empty, no `fn` key, must contain at least one
  non-modifier key.
- `handy_keys::validate_shortcut`: non-empty and parseable as `handy_keys::Hotkey`
  — modifier-only combos (e.g. bare `fn`, `command`) are allowed.

Conflict handling: `tauri_impl::register_shortcut` rejects a combo already
registered by this app via `global_shortcut().is_registered` ("Shortcut 'X' is
already in use"). The handy-keys backend performs **no duplicate check**.
Neither backend can detect conflicts with other applications' hotkeys.

### 6. Key-capture UX

- **Tauri backend** (`GlobalShortcutInput.tsx`): click the chip →
  `commands.suspendBinding(id)` (unregisters the live hotkey so it can't fire while
  typing) → captures JS `keydown`/`keyup` on `window` (requires settings window
  focus), naming keys via `keyboard.ts (getKeyName/normalizeKey)` → when all keys
  are released, sorts modifiers first, joins with `+`, commits via `updateBinding`.
  Click-outside cancels: restores `originalBinding` via `updateBinding` (which
  re-registers), or calls `commands.resumeBinding(id)` if there was none.
- **handy-keys backend** (`HandyKeysShortcutInput.tsx`): click the chip →
  `commands.startHandyKeysRecording(shortcutId)` → backend spawns a recording
  thread (`handy_keys::HandyKeysState::recording_loop`) polling a fresh
  `KeyboardListener` and emitting each event as `handy-keys-event`
  (`FrontendKeyEvent`) → UI shows `hotkey_string` while keys are down and commits
  on the **first key-up** via `updateBinding`, then `stopHandyKeysRecording`.
  Click-outside cancels and restores the original binding. Note: this path does
  **not** suspend the existing registration (see Fragile Points).
- Reset button on both UIs → `settingsStore.ts (resetBinding)` →
  `commands.resetBinding(id)` → backend `reset_binding` = `change_binding(id, default_binding)`.
- Display formatting: `keyboard.ts (formatKeyCombination)` renders
  `option_left+space` as `Left Option + Space` etc.

Rebinding UIs are mounted for: `transcribe` and `cancel`
(`src/components/settings/general/GeneralSettings.tsx`) and
`transcribe_with_post_process`
(`src/components/settings/post-processing/PostProcessingSettings.tsx`).

### 7. Backend switching at runtime

`KeyboardImplementationSelector.tsx` (debug settings) →
`commands.changeKeyboardImplementationSetting("tauri" | "handy_keys")` →
`src-tauri/src/shortcut/mod.rs (change_keyboard_implementation_setting)`:

1. No-op if unchanged. Unknown strings are silently coerced to `tauri` (`parse_keyboard_implementation`).
2. `unregister_all_shortcuts` from the old backend (skips `cancel`; failures only warned).
3. Persist the new setting.
4. If switching to HandyKeys and `HandyKeysState` is not yet managed:
   `initialize_handy_keys_with_rollback` — on failure, reverts the setting to Tauri,
   re-inits Tauri, and returns `Err`.
5. Otherwise `register_all_shortcuts_for_implementation`: iterates **default**
   binding ids, validates each user binding against the new backend, resets
   incompatible ones to defaults (collected in `reset_bindings`), registers them
   (per-binding failures only logged), persists if anything was reset.
6. Emits `settings-changed` `{ setting: "keyboard_implementation", value, reset_bindings }`.
7. Frontend toasts a warning if `reset_bindings` is non-empty and calls `refreshSettings()`.

Typical incompatibility: a modifier-only or `fn`-based combo recorded under
handy-keys fails Tauri validation and gets reset on switch to `tauri`.

## Tauri Commands and Events

### Commands (frontend → Rust; names as registered, camelCase wrappers in `src/bindings.ts`)

| Command                                  | Args                          | Returns                                                                                                             | Defined in                      |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `initialize_shortcuts`                   | —                             | `Result<(), String>`                                                                                                | `src-tauri/src/commands/mod.rs` |
| `change_binding`                         | `id: String, binding: String` | `Result<BindingResponse, String>`                                                                                   | `shortcut/mod.rs`               |
| `reset_binding`                          | `id: String`                  | `Result<BindingResponse, String>`                                                                                   | `shortcut/mod.rs`               |
| `suspend_binding`                        | `id: String`                  | `Result<(), String>`                                                                                                | `shortcut/mod.rs`               |
| `resume_binding`                         | `id: String`                  | `Result<(), String>`                                                                                                | `shortcut/mod.rs`               |
| `change_keyboard_implementation_setting` | `implementation: String`      | `Result<ImplementationChangeResult, String>`                                                                        | `shortcut/mod.rs`               |
| `get_keyboard_implementation`            | —                             | `String` (`"tauri"`/`"handy_keys"`)                                                                                 | `shortcut/mod.rs`               |
| `start_handy_keys_recording`             | `bindingId: String`           | `Result<(), String>` (errors if handy-keys not active)                                                              | `shortcut/handy_keys.rs`        |
| `stop_handy_keys_recording`              | —                             | `Result<(), String>`                                                                                                | `shortcut/handy_keys.rs`        |
| `change_ptt_setting`                     | `enabled: bool`               | `Result<(), String>` — writes `push_to_talk`                                                                        | `shortcut/mod.rs`               |
| `change_post_process_enabled_setting`    | `enabled: bool`               | `Result<(), String>` — also registers/unregisters the `transcribe_with_post_process` hotkey live (errors swallowed) | `shortcut/mod.rs`               |
| `initialize_enigo`                       | —                             | `Result<(), String>` — paste-side sibling, gated on the same macOS accessibility grant                              | `src-tauri/src/commands/mod.rs` |

(`shortcut/mod.rs` additionally defines ~45 general settings commands unrelated to
shortcuts — audio feedback, overlay, paste, post-processing config, accelerators.
They are registered in `src-tauri/src/lib.rs` under `shortcut::…`.)

### Events (Rust → frontend)

| Event                 | Payload                                                                                                                                        | Emitted from                                                                          | Listener                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `handy-keys-event`    | `FrontendKeyEvent { modifiers: string[], key: string \| null, is_key_down: bool, hotkey_string: string }`                                      | `handy_keys.rs (recording_loop)` during recording mode                                | `HandyKeysShortcutInput.tsx`                              |
| `settings-changed`    | `{ setting: "keyboard_implementation", value: string, reset_bindings: string[] }` (same channel reused for `debug_mode`, `start_hidden`, etc.) | `shortcut/mod.rs (change_keyboard_implementation_setting)` and other setting commands | **None** — no frontend listener exists today (dead event) |
| `recording-error`     | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail?: string }`                                            | `actions.rs (TranscribeAction::start)`                                                | `App.tsx` toast (other subsystem)                         |
| `transcription-error` | `String`                                                                                                                                       | `actions.rs (TranscribeAction::stop)`                                                 | toast (other subsystem)                                   |
| `paste-error`         | `()`                                                                                                                                           | `actions.rs`                                                                          | toast (other subsystem)                                   |

Note: none of the shortcut events are in the specta-typed `events` export of
`src/bindings.ts` (only history/stream events are); `handy-keys-event` is consumed
with a raw `listen<HandyKeysEvent>` and a hand-written interface.

## Settings Keys

Store: `settings_store.json` via `tauri-plugin-store` (`settings.rs SETTINGS_STORE_PATH`),
all under the single `"settings"` object.

- `bindings` — `HashMap<String, ShortcutBinding>`; read by both backends'
  `init_shortcuts`, `get_bindings`, `get_stored_binding`; written by
  `change_binding` / `reset_binding` / implementation-switch resets; defaults
  merged in on load.
- `keyboard_implementation` — `"tauri" | "handy_keys"`; read everywhere via
  dispatchers in `shortcut/mod.rs`; written by
  `change_keyboard_implementation_setting` and **silently rewritten** by the
  handy-keys init fallback.
- `push_to_talk` — bool, default `true`; read per event in
  `handler.rs (handle_shortcut_event)`; written by `change_ptt_setting`
  (UI: `src/components/settings/PushToTalk.tsx` via generic `updateSetting`).
- `post_process_enabled` — gates registration of `transcribe_with_post_process`
  at init and on toggle.

## Platform-Specific Behavior

### macOS

- Default backend is **HandyKeys**; default bindings use `option`(+`shift`)+`space`.
- handy-keys uses a low-level event tap requiring the **Accessibility** permission.
  That is why shortcut registration is deferred: `initialize_shortcuts` is invoked
  from `AccessibilityOnboarding.tsx` only after `checkAccessibilityPermission()`
  (via `tauri-plugin-macos-permissions`) reports granted, and again from `App.tsx`
  when onboarding completes.
- handy-keys supports the `fn` key and modifier-only shortcuts (e.g. hold `fn` as
  push-to-talk); the Tauri backend explicitly rejects both
  (`tauri_impl::validate_shortcut`).
- Modifier naming: `option` / `command` (see `handy_keys.rs (modifiers_to_strings)`
  and `keyboard.ts (getKeyName)`).
- `HotkeyManager::new_with_blocking()` — registered combos are consumed/blocked so
  they don't also reach the focused app.

### Linux

- Default backend is **Tauri** (`KeyboardImplementation::default`).
- The dynamic **cancel shortcut is completely disabled** (`register_cancel_shortcut`
  / `unregister_cancel_shortcut` early-return) "due to instability with dynamic
  shortcut registration" — Escape does nothing during recording; users must use
  toggle/PTT release or the tray.

### Windows

- Default backend HandyKeys; `ctrl+space` / `ctrl+shift+space`; `super`/`win`
  naming for the meta key.

## Fragile Points and Failure Modes

1. **Registration depends on the webview.** No shortcuts exist until the frontend
   calls `initialize_shortcuts`. If the UI crashes before that, onboarding never
   reaches `done`, or the command fails, the app runs with zero hotkeys and only a
   `console.warn` in the webview (`App.tsx`).
2. **`change_binding` ordering hazard** (`shortcut/mod.rs`): the old shortcut is
   unregistered _before_ the new one is validated/registered. On validation or
   registration failure the old hotkey stays unregistered; recovery relies on the
   frontend catching the error and re-committing `originalBinding`
   (`GlobalShortcutInput.tsx` / `HandyKeysShortcutInput.tsx` do this, with a
   second toast if the restore itself fails). A killed frontend mid-edit leaves a
   dead hotkey until restart.
3. **`reset_binding` can panic**: `settings.rs (get_stored_binding)` uses
   `.unwrap()` on the binding lookup — an unknown id panics inside the command.
4. **No duplicate detection in the handy-keys backend**: two binding ids may hold
   the same combo and both fire (the Tauri backend rejects duplicates via
   `is_registered`). Neither backend detects collisions with other apps.
5. **HandyKeys rebinding does not suspend the live hotkey**:
   `start_handy_keys_recording` opens a parallel `KeyboardListener` but leaves the
   existing registration active, so pressing the current combo while re-recording
   it triggers dictation mid-edit. (`suspend_binding` exists but is only used by
   the Tauri-path UI.)
6. **Silent backend fallback**: if handy-keys init fails at startup,
   `keyboard_implementation` is rewritten to `tauri` with no user-facing notice —
   the user's choice (and any handy-keys-only bindings like bare `fn`) silently
   degrade; those bindings then fail Tauri registration with only `error!` logs.
7. **`settings-changed` has no listener**: `reset_bindings` info emitted on
   implementation switch reaches the user only through the selector's own toast;
   any other UI showing bindings will be stale until a manual `refreshSettings`.
8. **Swallowed errors**: per-binding registration failures during init and during
   implementation switch are only logged (`error!`); cancel-shortcut register/
   unregister runs in fire-and-forget async tasks; the post-process hotkey
   register/unregister in `change_post_process_enabled_setting` uses `let _ =`.
   In all cases the UI shows success while the hotkey may be dead.
9. **`change_binding` for `cancel` when missing from stored settings** silently
   falls through the `if let Some` and takes the normal register path, statically
   registering what should be a dynamic-only shortcut. (Normally unreachable since
   defaults are merged at load, but a landmine for future binding sources.)
10. **HandyKeys manager thread is a bottleneck**: hotkey events are handled
    synchronously on the manager thread (`manager_thread` loop, 10 ms poll cadence);
    a slow `TranscribeAction::start` delays subsequent hotkey and register/unregister
    processing. Register/unregister calls also block the invoking command thread on
    `rx.recv()` with no timeout.
11. **Webview key capture limits** (Tauri-path UI): capture requires window focus;
    macOS does not deliver `keyup` for non-modifier keys released while `cmd` is
    held, which can strand the "all keys released" commit condition; `fn` is
    invisible to JS.
12. **State residue on backend switch**: `HandyKeysState` (and its thread) stays
    managed after switching back to `tauri`; `register_all_shortcuts_for_implementation`
    iterates **default** binding ids only, so any future non-default binding ids
    (e.g. Murmur profiles) would be dropped on switch.

## Notes for Murmur (shortcut profiles → workflows)

- The seam to extend is `bindings` (id → combo) + `ACTION_MAP` (id → behavior) +
  `is_transcribe_binding` (which ids route through the coordinator). Profiles could
  add binding ids, but see fragile points 9 and 12: several code paths iterate
  _default_ binding ids, special-case `"cancel"` by string, and assume the
  transcribe set is exactly two hard-coded ids.
- Toggle/PTT is a single global `push_to_talk` flag applied to every transcribe
  binding at event time (`handler.rs`), not per binding — per-workflow behavior
  would need a per-binding mode field.
- `shortcut/mod.rs` is a grab bag: only ~15% of it is shortcut logic; plan to split
  before growing it.

## Cross-Links (other subsystems)

- **Transcription coordinator** (`src-tauri/src/transcription_coordinator.rs`):
  consumes press/release for transcribe bindings; owns Idle/Recording/Processing.
- **Actions / dictation pipeline** (`src-tauri/src/actions.rs`): `TranscribeAction`
  drives `AudioRecordingManager`, `TranscriptionManager`, overlay, tray, history,
  paste; re-enters this subsystem via `register_cancel_shortcut`.
- **Signals/CLI** (`src-tauri/src/signal_handle.rs`): SIGUSR1/SIGUSR2 toggle
  transcription through the same coordinator entry point, bypassing keyboards.
- **Settings store** (`src-tauri/src/settings.rs`, `src/stores/settingsStore.ts`):
  persistence and optimistic frontend cache.
- **Permissions/onboarding** (`src/components/onboarding/AccessibilityOnboarding.tsx`,
  `tauri-plugin-macos-permissions`): gates when registration is allowed to happen
  on macOS; `initialize_enigo` (paste) shares the same gate.
- **Cancel path** (`src-tauri/src/utils.rs (cancel_current_operation)`): tray,
  overlay, audio, stream teardown.
