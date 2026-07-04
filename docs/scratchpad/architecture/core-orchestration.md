# Core Orchestration & App Lifecycle

Subsystem map for the Handy (Murmur) dictation pipeline: how a shortcut trigger becomes a
recording session, then a transcription, then pasted text. Covers app startup/teardown,
the transcription coordinator state machine, the transcribe/cancel actions, external
triggers (Unix signals, CLI, single-instance forwarding), and the headless CLI mode.

All paths relative to repo root. Verified against source on 2026-07-04.

---

## Purpose

This subsystem is the heart of the app. It:

1. Boots the Tauri app, wires managers into Tauri managed state, creates the main window,
   tray, and overlay window (`src-tauri/src/lib.rs`).
2. Serializes every transcription lifecycle event (key press/release, signal, CLI toggle,
   cancel) through a single dedicated thread so the pipeline can never be double-started
   or torn down mid-flight (`src-tauri/src/transcription_coordinator.rs`).
3. Implements the actual start/stop pipeline: model preload, mic capture, WAV persistence,
   batch or streaming transcription, optional OpenCC Chinese conversion, optional LLM
   post-processing, history save, and paste (`src-tauri/src/actions.rs`).
4. Provides centralized cancellation from any entry point (`src-tauri/src/utils.rs`).
5. Provides a headless one-shot transcription mode for CI/benchmarking
   (`src-tauri/src/cli.rs`, `src-tauri/src/lib.rs (run_headless_transcription)`).

---

## Key Files

| File                                         | Role                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/main.rs`                      | Binary entry point. Parses `CliArgs` with clap, sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux, calls `handy_app_lib::run(cli_args)`.                                                     |
| `src-tauri/src/lib.rs`                       | The whole app assembly: plugin stack, logging targets, specta command/event registration, `setup` closure, window lifecycle, tray, run-event teardown, headless path.                       |
| `src-tauri/src/transcription_coordinator.rs` | `TranscriptionCoordinator` — single-threaded state machine (`Idle` / `Recording(binding_id)` / `Processing`) fed by an mpsc channel.                                                        |
| `src-tauri/src/actions.rs`                   | `ShortcutAction` trait + `TranscribeAction` (the full record→transcribe→paste pipeline), `CancelAction`, `TestAction`, `ACTION_MAP`, LLM post-processing, OpenCC conversion, `FinishGuard`. |
| `src-tauri/src/signal_handle.rs`             | Unix SIGUSR1/SIGUSR2 handler thread + `send_transcription_input` helper used by signals and CLI forwarding.                                                                                 |
| `src-tauri/src/cli.rs`                       | `CliArgs` clap struct (all flags below).                                                                                                                                                    |
| `src-tauri/src/utils.rs`                     | `cancel_current_operation` (centralized cancel) + Linux display-server helpers; re-exports `clipboard::*`, `overlay::*`, `tray::*`.                                                         |
| `src-tauri/src/commands/mod.rs`              | Generic app commands: `cancel_operation`, `initialize_enigo`, `initialize_shortcuts`, settings/log/dir commands.                                                                            |
| `src-tauri/src/shortcut/handler.rs`          | (adjacent subsystem, but the funnel) `handle_shortcut_event` — routes transcribe bindings into the coordinator, cancel/test bindings straight to `ACTION_MAP`.                              |

## Key Types & Functions

- `src-tauri/src/lib.rs (run)` — the entire builder + setup + run loop.
- `src-tauri/src/lib.rs (initialize_core_logic)` — manager construction, tray build, signal
  handler setup, autostart sync, overlay window creation.
- `src-tauri/src/lib.rs (show_main_window)` — unminimize/show/focus + macOS activation
  policy `Regular`.
- `src-tauri/src/lib.rs (run_headless_transcription)` — `--transcribe-file` /
  `--list-devices` / `--list-models` implementation; returns process exit code (0/1/2).
- `src-tauri/src/lib.rs (FILE_LOG_LEVEL, WEBVIEW_LOG_STREAMING)` — global `AtomicU8`/
  `AtomicBool` controlling the file log target and the `log://log` webview target.
- `src-tauri/src/transcription_coordinator.rs (TranscriptionCoordinator)` — public API:
  `new`, `send_input`, `notify_cancel`, `notify_processing_finished`.
- `src-tauri/src/transcription_coordinator.rs (Command, Stage, start, stop)` — internal
  state machine (detailed below). `is_transcribe_binding(id)` = `"transcribe" |
"transcribe_with_post_process"`.
- `src-tauri/src/actions.rs (ShortcutAction)` — trait `{ start(app, binding_id,
shortcut_str), stop(...) }`, `Send + Sync`.
- `src-tauri/src/actions.rs (TranscribeAction)` — `{ post_process: bool }`; `impl
ShortcutAction`, the core pipeline.
- `src-tauri/src/actions.rs (ACTION_MAP)` — `Lazy<HashMap<String, Arc<dyn
ShortcutAction>>>` with keys `"transcribe"`, `"transcribe_with_post_process"`,
  `"cancel"`, `"test"`.
- `src-tauri/src/actions.rs (FinishGuard)` — drop guard created at the top of the async
  stop pipeline; on drop (normal completion or panic) calls
  `TranscriptionCoordinator::notify_processing_finished`, guaranteeing the coordinator
  returns to `Idle`.
- `src-tauri/src/actions.rs (process_transcription_output)` — OpenCC conversion + LLM
  post-processing; returns `ProcessedTranscription { final_text, post_processed_text,
post_process_prompt }`.
- `src-tauri/src/actions.rs (post_process_transcription)` — resolves provider/model/
  prompt from settings, calls `llm_client` (structured-output JSON schema first, legacy
  `${output}` prompt fallback) or `apple_intelligence` natively on macOS aarch64.
- `src-tauri/src/actions.rs (resolve_effective_language, maybe_convert_chinese_variant)`
  — coerces the persisted language intent against the loaded model's capabilities before
  deciding whether to run OpenCC zh-Hans/zh-Hant conversion.
- `src-tauri/src/utils.rs (cancel_current_operation)` — the one true cancel.
- `src-tauri/src/signal_handle.rs (setup_signal_handler, send_transcription_input)`.
- `src-tauri/src/commands/mod.rs (initialize_enigo, initialize_shortcuts,
ShortcutsInitialized)` — deferred, frontend-driven initialization (see macOS notes).

---

## Startup Flow (`lib.rs (run)`)

1. `main.rs (main)`: clap-parse `CliArgs` → `run(cli_args)`.
2. `portable::init()` detects portable mode (redirects data/log dirs).
3. `build_console_filter()` parses `RUST_LOG` (invalid values fall back to `Info`).
4. tauri-specta `Builder` collects 105 commands (`collect_commands![]`,
   `lib.rs:534-640`) and 3 typed events
   (`HistoryUpdatePayload`, `StreamTextEvent`, `StreamPhaseEvent`); in debug builds it
   exports `src/bindings.ts` (the frontend's typed client).
5. `headless_mode = transcribe_file.is_some() || list_devices || list_models`.
6. Plugin stack: dialog, log (3 targets: console stdout/stderr, rotating file
   `murmur.log`, webview `log://log`), nspanel (macOS only), single-instance (skipped in
   headless mode), fs, process, updater, os, clipboard-manager, macos-permissions,
   opener, store, global-shortcut, autostart. `CliArgs` is put into managed state.
7. **Single-instance forwarding** (`lib.rs`, closure in `run`): a second invocation with
   `--toggle-transcription` → `signal_handle::send_transcription_input(app,
"transcribe", "CLI")`; `--toggle-post-process` → same with
   `"transcribe_with_post_process"`; `--cancel` → `utils::cancel_current_operation`;
   anything else → `show_main_window`.
8. `setup` closure:
   - **Headless branch**: constructs only `ModelManager` + `TranscriptionManager`,
     inits the transcribe-cpp backend + accelerator settings, then runs
     `run_headless_transcription` on a worker thread and `std::process::exit(code)`
     (after explicitly unloading the model — ggml-metal SIGABRTs if Metal resources
     survive to C++ static destructors — and flushing stdout/stderr). No window, tray,
     mic, signals, or autostart.
   - **Normal branch**: builds the `main` window programmatically (680x570, hidden,
     `data_directory` override in portable mode); applies `--debug` runtime override
     (debug_mode=true, log_level=Trace, not persisted); stores `FILE_LOG_LEVEL` and
     `WEBVIEW_LOG_STREAMING`; `app.manage(TranscriptionCoordinator::new(app_handle))`;
     calls `initialize_core_logic`; primes `overlay::update_overlay_enabled_cache`;
     pre-warms accelerator enumeration on a background thread; applies `--no-tray`;
     decides window visibility (`start_hidden` setting OR `--start-hidden`, forced
     visible if Windows mic permission onboarding is needed
     (`should_force_show_permissions_window`) or if the tray is unavailable).
9. `initialize_core_logic` (`lib.rs`):
   - Constructs `ModelManager`, `TranscriptionManager`, `AudioRecordingManager` (given
     the transcription manager's stream router), `HistoryManager` — all
     `.expect(...)` (startup panics on failure).
   - `init_transcribe_backend()` + `apply_accelerator_settings()`.
   - **Deliberately does NOT init Enigo or shortcuts** — the frontend calls
     `initialize_enigo` / `initialize_shortcuts` after onboarding/permissions
     (`src/App.tsx` effect on `onboardingStep === "done"`, and
     `src/components/onboarding/AccessibilityOnboarding.tsx`). This avoids macOS
     permission dialogs firing before the user is ready.
   - Unix: `signal_handle::setup_signal_handler` for SIGUSR1/SIGUSR2.
   - macOS: if `start_hidden && show_tray_icon`, sets `ActivationPolicy::Accessory`.
   - Builds the tray icon (menu handlers: `settings`, `check_updates`,
     `copy_last_transcript`, `unload_model`, `cancel`, `quit`, `model_select:<id>`),
     listens for `model-state-changed` to refresh the tray menu, syncs autostart with
     `autostart_enabled`, creates the hidden `recording_overlay` window
     (`utils::create_recording_overlay`).
10. Window events (`lib.rs (run)`): `CloseRequested` → `prevent_close` + hide (macOS:
    switch to `Accessory` policy if tray is visible, keeping the app alive in the tray);
    `ThemeChanged` → swap tray icon.
11. Run events: macOS `Reopen` (dock click) → `show_main_window`; `Exit` →
    `TranscriptionManager::unload_model()` (transcribe-cpp teardown before process exit).

---

## The Dictation Pipeline: Trigger → Text

### Trigger sources (all converge on the coordinator)

| Source                                                                       | Path                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global hotkey (Tauri or handy-keys impl)                                     | `shortcut/tauri_impl.rs` / `shortcut/handy_keys.rs` → `shortcut/handler.rs (handle_shortcut_event)` → `TranscriptionCoordinator::send_input(binding_id, hotkey, is_pressed, settings.push_to_talk)` |
| Unix signal SIGUSR2 / SIGUSR1                                                | `signal_handle.rs (setup_signal_handler)` thread → `send_transcription_input` → `send_input(id, "SIGUSR1/2", true, false)` (toggle semantics)                                                       |
| CLI on a second instance (`--toggle-transcription`, `--toggle-post-process`) | single-instance plugin closure in `lib.rs (run)` → `send_transcription_input(..., "CLI")`                                                                                                           |
| Cancel: hotkey / tray "cancel" / overlay button / CLI `--cancel`             | all → `utils::cancel_current_operation` (the cancel hotkey goes via `handler.rs`, which only fires it while `AudioRecordingManager::is_recording()` and on press)                                   |

### Coordinator state machine (`transcription_coordinator.rs`)

Owned exclusively by one `std::thread` spawned in `TranscriptionCoordinator::new`,
consuming `Command` values from an `mpsc::channel`. The whole loop is wrapped in
`catch_unwind`; a panic is logged and the thread dies (see Fragile Points).

States (`Stage`): `Idle`, `Recording(binding_id)`, `Processing`.

Commands:

- `Command::Input { binding_id, hotkey_string, is_pressed, push_to_talk }`
- `Command::Cancel { recording_was_active }`
- `Command::ProcessingFinished`

Transition rules:

- **Debounce**: presses within 30 ms (`DEBOUNCE`) of the previous press are dropped
  (key-repeat / double-tap guard). Releases always pass through.
- **Push-to-talk** (`push_to_talk == true`): press while `Idle` → `start`; release while
  `Recording(id)` _for the same binding_ → `stop`. Releases of other bindings and
  presses while busy are ignored.
- **Toggle mode** (press-only): `Idle` → `start`; `Recording(same id)` → `stop`;
  `Recording(other id)` or `Processing` → ignored ("pipeline busy"). Signals/CLI always
  send `is_pressed=true, push_to_talk=false`, i.e. toggle semantics regardless of the
  user's PTT setting.
- `start` helper (`transcription_coordinator.rs (start)`): looks up `ACTION_MAP`, calls
  `action.start(...)` **synchronously on the coordinator thread**, then transitions to
  `Recording(binding_id)` only if `AudioRecordingManager::is_recording()` is actually
  true afterwards — a failed mic open leaves the stage `Idle`.
- `stop` helper: calls `action.stop(...)` (which spawns the async pipeline and returns
  quickly) and sets `Processing` unconditionally.
- `Command::Cancel`: resets to `Idle` only if **not** `Processing` and (a recording was
  active or stage is `Recording`). Cancel during `Processing` does not reset the stage;
  the pipeline notices the cancellation itself (generation check below) and
  `FinishGuard` restores `Idle`.
- `Command::ProcessingFinished` (sent by `FinishGuard::drop`): stage → `Idle`.

### `TranscribeAction::start` (`actions.rs`) — runs on the coordinator thread

1. `TranscriptionManager::initiate_model_load()` (async model warm-up) and, on a spawned
   thread, `AudioRecordingManager::preload_vad()` (parallel VAD warm-up; failure only
   `debug!`-logged).
2. Tray icon → `Recording`.
3. Reads settings: `always_on_microphone`, `selected_model`, `vad_enabled`,
   `overlay_style`. Determines `model_supports_streaming` from
   `ModelManager::get_model_info(selected_model)` (unknown ⇒ false). Picks `VadPolicy`:
   `Disabled` (vad off) / `Streaming` (streaming model) / `Offline`. If streaming, calls
   `TranscriptionManager::start_stream()`.
4. Overlay: `OverlayStyle::Live` + streaming model → `utils::show_streaming_overlay`
   (400x120 live panel); `Live` (non-streaming) or `Minimal` → `show_recording_overlay`
   (256x46 pill); `None` → nothing. (Emits `show-overlay` to the `recording_overlay`
   window with payload `"streaming"` / `"recording"`.)
5. Mic start, ordering differs by mode:
   - **Always-on mic**: play start sound immediately on a spawned thread
     (`play_feedback_sound_blocking` then `AudioRecordingManager::apply_mute`), then
     `try_start_recording(binding_id, vad_policy)`.
   - **On-demand**: `try_start_recording` first, then a spawned thread sleeps 100 ms
     (mic stream warm-up), plays the start sound, applies mute
     (`mute_while_recording`).
6. On success: `shortcut::register_cancel_shortcut(app)` — the cancel hotkey is only
   registered _while recording_ (spawned async; no-op on Linux).
7. On failure: reverts everything (`TranscriptionManager::cancel_stream`,
   `utils::hide_recording_overlay`, tray → `Idle`) and emits **`recording-error`** to
   the frontend with `{ error_type: "microphone_permission_denied" | "no_input_device"
| "unknown", detail }` (classified by
   `audio_toolkit::{is_microphone_access_denied, is_no_input_device_error}`). The
   frontend (`src/App.tsx`) shows a localized toast. Because recording never started,
   the coordinator's post-start check keeps the stage `Idle`.

### `TranscribeAction::stop` (`actions.rs`) — coordinator thread + async task

Synchronous part (still on the coordinator thread):

1. `shortcut::unregister_cancel_shortcut(app)`.
2. Tray → `Transcribing`. Overlay: if `overlay_style == Live` and
   `TranscriptionManager::is_streaming()`, emit stream phase
   `emit_stream_working(StreamWorkKind::Transcribing)` (typed `StreamPhaseEvent`);
   otherwise `show_transcribing_overlay` (payload `"transcribing"`).
3. `AudioRecordingManager::remove_mute()`, then `play_feedback_sound(SoundType::Stop)`.
4. Snapshot `cancel_generation = rm.cancel_generation()` (an `AtomicU64`; every cancel
   bumps it — `was_cancelled_since(gen)` is the pipeline's cancellation probe).
5. `tauri::async_runtime::spawn` the pipeline. First statement inside:
   `let _guard = FinishGuard(app)`.

Async pipeline: 6. `rm.stop_recording(binding_id, cancel_generation)` — blocks for
`extra_recording_buffer_ms` (checking cancellation every ≤25 ms), stops the recorder,
closes/lazy-closes the mic in on-demand mode, returns `None` if cancelled, pads
sub-1s clips to 1.25 s. **Note: this blocking sleep runs on a tokio worker thread.** 7. `None` (not recording / cancelled inside stop) or cancelled-since → `cancel_stream()`
(so the streaming worker channel doesn't leak and block the next `start_stream`),
hide overlay, tray `Idle`, return. **Silent: no user feedback.** 8. Empty samples → same silent reset. 9. Otherwise: spawn*blocking `audio_toolkit::save_wav_file` of
`recordings/murmur-<unix_ts>.wav` concurrently with transcription. 10. Transcription: `TranscriptionManager::finalize_stream()` first —
`Ok(Some(text))` non-empty wins; `Ok(None)`/empty falls back to batch
`tm.transcribe(samples)`; `Err` (finalize timeout — worker may still hold the
engine) is surfaced as the transcription error rather than risking contention. 11. Await WAV save, then `audio_toolkit::verify_wav_file`; failures logged, `wav_saved
    = false` (history entry then skipped, audio lost). 12. Cancellation check → silent reset if cancelled. 13. On transcription `Ok`: - If `post_process`: overlay → `StreamWorkKind::Polishing` (Live) or
`show_processing_overlay` (`"processing"`). - `process_transcription_output(app, &transcription, post_process)`: 1. `resolve_effective_language` + `maybe_convert_chinese_variant` (OpenCC
Tw2sp/S2tw only when the \_effective* language is zh-Hans/zh-Hant). 2. If post-processing: `post_process_transcription` — skips silently (debug log
only) when transcription is blank, no provider, no model, no/empty prompt.
Providers: Apple Intelligence (native Swift call, macOS aarch64 only) or
OpenAI-compatible HTTP via `llm_client` (structured-output JSON schema
`{transcription: string}` first; on failure falls back to legacy `${output}`
prompt substitution; on any error returns `None` ⇒ raw transcription is used,
**user is never told post-processing failed**). Reasoning is disabled for
`custom` and `openrouter` providers. `strip_invisible_chars` removes
zero-width characters LLMs sometimes emit. - Cancellation check → silent reset. - If `wav_saved`: `HistoryManager::save_entry(file_name, transcription,
      post_process, post_processed_text, post_process_prompt)` (emits typed
`HistoryUpdatePayload` event; save errors only logged). - If `final_text` empty → reset UI silently. Otherwise
`app.run_on_main_thread`: last cancellation check, then
`utils::paste(final_text, app)` (`clipboard.rs (paste)` — Enigo typing or
clipboard+Cmd/Ctrl-V per `paste_method`, honors `append_trailing_space`,
`auto_submit`, `clipboard_handling`). Paste failure → `error!` +
emit **`paste-error`** (frontend toast). Then hide overlay, tray `Idle`. 14. On transcription `Err`: emit **`transcription-error`** (payload = error string,
frontend toast) and, if `wav_saved`, save a history entry with empty text so the
user can retry from History (`commands/history.rs (retry_history_entry_transcription)`). 15. `FinishGuard` drops → coordinator `Processing` → `Idle`.

### Cancellation (`utils.rs (cancel_current_operation)`)

Called from: cancel hotkey (`handler.rs`, only while recording), tray menu `cancel`,
overlay cancel button → `cancel_operation` command (`commands/mod.rs`), CLI `--cancel`
via single-instance.

Sequence: unregister cancel shortcut → `recording_was_active = rm.is_recording()` →
`rm.cancel_recording()` (**bumps the cancel generation atomic**, stops recorder,
discards samples) → `tm.cancel_stream()` → tray `Idle` + hide overlay →
`tm.maybe_unload_immediately("cancellation")` (if the model-unload timeout is
"immediately") → `coordinator.notify_cancel(recording_was_active)`.

The generation bump is what makes in-flight pipelines abandon their work at the next
checkpoint; the coordinator only resets its own stage if it isn't `Processing`.

---

## Headless CLI Mode (`lib.rs (run_headless_transcription)`)

Flags (`cli.rs (CliArgs)`): `--start-hidden`, `--no-tray`, `--toggle-transcription`,
`--toggle-post-process`, `--cancel`, `--debug`, `-f/--transcribe-file <WAV>`, `--model
<id>`, `--device-index <N>`, `--list-devices`, `--list-models`, `--repeat <N>`, `--json`.

- Headless mode runs a **standalone instance** (single-instance plugin skipped) so it
  works while the app is open.
- `--transcribe-file` validates the WAV strictly (16 kHz mono 16-bit int PCM, else exit
  2), loads the model via `TranscriptionManager::load_model_with_device` (timed),
  transcribes `--repeat` times (reloading if the immediate-unload setting evicted the
  engine), prints `model/device/backend/load_ms/best_ms/rtf/text` (or JSON), and exits
  with 0/1/2 via `std::process::exit` so the code reaches the shell. Console logs go to
  **stderr** in this mode to keep stdout machine-parseable.

---

## Tauri Commands & Events Touched by This Subsystem

`lib.rs (run)` registers every command in the app (105, via tauri-specta, which also
generates `src/bindings.ts`). Below are only the ones **defined in this subsystem's
files**; the rest belong to the shortcut/settings, models, audio, transcription, and
history subsystems.

### Commands (frontend → Rust)

| Command                                                                                                                                                                                                                 | File              | Signature / behavior                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `trigger_update_check`                                                                                                                                                                                                  | `lib.rs`          | No-op unless `update_checks_enabled`; re-emits `check-for-updates`.                                                           |
| `show_main_window_command`                                                                                                                                                                                              | `lib.rs`          | Shows/focuses main window (macOS: activation policy `Regular`). Called by `src/App.tsx (revealMainWindowForPermissions)`.     |
| `cancel_operation`                                                                                                                                                                                                      | `commands/mod.rs` | → `cancel_current_operation`. Called by the overlay cancel button (`src/overlay/RecordingOverlay.tsx`).                       |
| `initialize_enigo`                                                                                                                                                                                                      | `commands/mod.rs` | Lazily creates `input::EnigoState` and `app.manage`s it; errors with a string (macOS: accessibility not granted). Idempotent. |
| `initialize_shortcuts`                                                                                                                                                                                                  | `commands/mod.rs` | Calls `shortcut::init_shortcuts`; guarded by `ShortcutsInitialized` marker state. Idempotent.                                 |
| `is_portable`, `get_app_dir_path`, `get_app_settings`, `get_default_settings`, `get_log_dir_path`, `set_log_level`, `open_recordings_folder`, `open_log_dir`, `open_app_data_dir`, `check_apple_intelligence_available` | `commands/mod.rs` | Utility/settings commands. `set_log_level` writes `settings.log_level` **and** the `FILE_LOG_LEVEL` atomic.                   |

### Events

| Event                                                         | Direction                                                  | Emitted from                                                                                          | Payload                                                                                                    | Frontend consumer                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `recording-error`                                             | Rust → frontend                                            | `actions.rs (TranscribeAction::start)`                                                                | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail: string \| null }` | `src/App.tsx` toast                                                                          |
| `transcription-error`                                         | Rust → frontend                                            | `actions.rs (TranscribeAction::stop)`                                                                 | error message `string`                                                                                     | `src/App.tsx` toast                                                                          |
| `paste-error`                                                 | Rust → frontend                                            | `actions.rs (TranscribeAction::stop)`                                                                 | `()`                                                                                                       | `src/App.tsx` toast                                                                          |
| `check-for-updates`                                           | Rust → frontend                                            | `lib.rs` (tray `check_updates`, `trigger_update_check`)                                               | `()`                                                                                                       | `src/components/update-checker/UpdateChecker.tsx`                                            |
| `show-overlay`                                                | Rust → overlay window                                      | `overlay.rs (show_overlay_state)` (called from actions)                                               | `"recording" \| "streaming" \| "transcribing" \| "processing"`                                             | `src/overlay/RecordingOverlay.tsx`                                                           |
| `hide-overlay`                                                | Rust → overlay window                                      | `overlay.rs (hide_recording_overlay)`                                                                 | `()`                                                                                                       | overlay                                                                                      |
| `model-state-changed`                                         | Rust → Rust **and** frontend                               | emitted by `managers/transcription.rs` (other subsystem)                                              | `ModelStateEvent { event_type, model_name?, error? }`                                                      | `lib.rs (initialize_core_logic)` **listens** to refresh the tray menu; `src/App.tsx`, stores |
| `StreamTextEvent`, `StreamPhaseEvent`, `HistoryUpdatePayload` | Rust → frontend (typed specta events, mounted in `lib.rs`) | transcription/history managers; `actions.rs` triggers `StreamPhaseEvent` via `tm.emit_stream_working` | see `managers/transcription.rs`, `managers/history.rs`                                                     | overlay + history UI                                                                         |
| `log://log`                                                   | Rust → frontend                                            | tauri-plugin-log webview target                                                                       | log record                                                                                                 | debug panel live log viewer (only while `WEBVIEW_LOG_STREAMING` is true, i.e. debug mode)    |

(Other events named in `lib.rs`'s registered commands — `settings-changed`,
`models-updated`, `model-download-*`, `handy-keys-event`, `mic-level` — belong to the
shortcut/settings, models, and audio subsystems.)

---

## Settings Keys Read/Written Here

Read via `settings::get_settings` (Tauri store-backed `AppSettings`,
`src-tauri/src/settings.rs`):

- Startup/lifecycle (`lib.rs`): `start_hidden`, `show_tray_icon`, `autostart_enabled`,
  `update_checks_enabled`, `debug_mode`, `log_level`, `overlay_style`, `selected_model`
  (tray model picker + headless default).
- Pipeline (`actions.rs`): `always_on_microphone`, `selected_model`, `vad_enabled`,
  `overlay_style`, `selected_language`, `post_process_provider_id` /
  `post_process_providers` (via `active_post_process_provider()`),
  `post_process_models`, `post_process_api_keys`, `post_process_prompts`,
  `post_process_selected_prompt_id`.
- Dispatch (`shortcut/handler.rs`): `push_to_talk`; (`shortcut/*`):
  `keyboard_implementation`, `bindings` (incl. the dynamically registered `"cancel"`
  binding).
- One hop into the stop path (`managers/audio.rs (stop_recording)`):
  `extra_recording_buffer_ms`, `lazy_stream_close`; (`clipboard.rs (paste)`):
  `paste_method`, `paste_delay_ms`, `append_trailing_space`, `auto_submit`,
  `auto_submit_key`, `clipboard_handling`, `typing_tool`, `external_script_path`.

Written: `log_level` (`commands/mod.rs (set_log_level)`). `--debug` overrides
`debug_mode`/`log_level` at runtime **without persisting**. (`shortcut/mod.rs` writes
`keyboard_implementation` when handy-keys init fails and it falls back to Tauri.)

---

## Thread / Async Structure

- **Coordinator thread** (plain `std::thread`, `transcription_coordinator.rs`): owns the
  `Stage` state machine; runs `TranscribeAction::start` and the synchronous half of
  `stop` inline, so anything slow there delays subsequent hotkey handling.
- **Pipeline task** (`tauri::async_runtime::spawn` in `TranscribeAction::stop`): the full
  stop→transcribe→paste flow; WAV save on `spawn_blocking`; paste hops to the **main
  thread** via `run_on_main_thread` (Enigo/AppKit requirement).
- **Helper threads**: VAD preload, start-sound+mute sequencing (both in `start`), signal
  handler loop (`signal_handle.rs`), accelerator pre-warm, tray model switch, overlay
  hide delay (300 ms), headless worker.
- **Cancellation**: `AudioRecordingManager.cancel_generation` (`AtomicU64`) is the only
  cross-thread cancel signal for the pipeline; `TranscriptionCoordinator`'s stage is
  thread-confined and reconciled via `Command`s.

---

## Platform-Specific Behavior

### macOS

- Activation-policy dance: `Accessory` when hidden-to-tray (startup with
  `start_hidden && show_tray_icon`; on window close when tray visible), `Regular`
  when showing (`lib.rs (show_main_window)`). Without the tray, the dock icon is kept
  so the user can get back in.
- `RunEvent::Reopen` (dock click) reopens the main window.
- `tauri_nspanel` plugin: the overlay is a non-activating NSPanel (`overlay.rs`).
- Enigo + shortcuts init deferred to the frontend post-onboarding to avoid premature
  accessibility/input-monitoring permission prompts (`commands/mod.rs`,
  `src/components/onboarding/AccessibilityOnboarding.tsx`).
- Apple Intelligence post-processing provider (macOS aarch64 only,
  `apple_intelligence.rs`); on other platforms the provider silently no-ops.
- Headless exit explicitly unloads the model to dodge a ggml-metal static-destructor
  SIGABRT.

### Linux

- `main.rs`: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (GPU crash workaround).
- Cancel shortcut dynamic registration is disabled entirely
  (`shortcut/tauri_impl.rs (register_cancel_shortcut)`) — cancel is only reachable via
  tray/overlay/CLI there.
- `utils.rs`: `is_wayland`, `is_kde_plasma`, `is_kde_wayland` helpers (used by
  clipboard/typing-tool selection).

### Windows

- `should_force_show_permissions_window` (`lib.rs`): forces the main window visible when
  models are installed but mic permission is denied.
- `main.rs`: `windows_subsystem = "windows"` in release (no console).

### Unix (macOS + Linux)

- SIGUSR2 toggles `transcribe`, SIGUSR1 toggles `transcribe_with_post_process`
  (`signal_handle.rs`) — scripting hook equivalent to the CLI toggles.

---

## Fragile Points & Failure Modes

1. **Coordinator thread death is unrecoverable.** The loop is wrapped in
   `catch_unwind`; on panic it logs and the thread exits. Every later
   `send_input`/`notify_*` just logs "Transcription coordinator channel closed" —
   hotkeys silently stop working until app restart. No respawn, no user notification.
   (`transcription_coordinator.rs (new, send_input)`)
2. **Silent empty-result paths.** No samples, empty samples, cancelled-mid-stop, and
   empty `final_text` all reset UI with only `debug!` logs — the user gets no toast and
   may not notice nothing was pasted. (`actions.rs (TranscribeAction::stop)`)
3. **Post-processing failures are invisible.** Every skip/error in
   `post_process_transcription` (no provider/model/prompt, HTTP error, Apple
   Intelligence unavailable) returns `None` and the raw transcription is pasted; the
   only breadcrumbs are debug/error logs. A user who configured cleanup gets uncleaned
   text with no explanation. (`actions.rs (post_process_transcription)`)
4. **WAV save failure loses the audio silently** (`wav_saved = false` skips the history
   entry; only `error!` logs). Combined with a transcription error, both the audio and
   the retry path are gone. (`actions.rs (TranscribeAction::stop)`)
5. **Startup panics on manager init**: `initialize_core_logic` and the headless branch
   use `.expect(...)` for all four managers, and the tray builder `.unwrap()`s icon
   loading — a corrupt settings store or missing resource crashes the app before any UI
   exists. (`lib.rs`)
6. **`run_on_main_thread` failure loses the text**: if scheduling the paste closure
   fails, the error is logged, UI resets, and the transcription is neither pasted nor
   copied to the clipboard (it does survive in history if the WAV saved). (`actions.rs`)
7. **Blocking on async runtime**: `stop_recording`'s `extra_recording_buffer_ms` loop
   and the batch `tm.transcribe(samples)` both run inside the tokio task (the latter is
   CPU/GPU-bound for seconds) — they occupy async runtime worker threads. Paste runs on
   the main thread; slow simulated typing blocks the UI.
8. **`start` runs inline on the coordinator thread** — settings-store reads, tray icon
   swap, and overlay repositioning all add keypress→capture latency (the code itself
   logs per-span timings for this reason) and delay handling of the next hotkey event.
9. **Cancel-shortcut registration is fire-and-forget async** (`shortcut/tauri_impl.rs`):
   registration failure is only logged, so the cancel hotkey may silently not exist for
   a session; on Linux it never exists.
10. **`emit` results are almost universally discarded** (`let _ = app.emit(...)`) —
    lost UI events (toasts, overlay state) fail silently.
11. **Stage vs. reality races**: `start()` decides `Recording` by polling
    `rm.is_recording()` right after `action.start` returns; anything that stops the
    recorder out-of-band without bumping the cancel generation would leave the
    coordinator stuck in `Recording` until the next matching press. Conversely a
    `Cancel` arriving during `Processing` is deliberately ignored by the coordinator
    and depends entirely on the generation checks inside the pipeline.
12. **30 ms debounce constant** (`transcription_coordinator.rs (DEBOUNCE)`): a very
    fast intentional press-release (tap-to-talk under 30 ms) is dropped for presses;
    fine in practice but hardcoded.
13. **Sub-second recordings are zero-padded to 1.25 s** (`managers/audio.rs
(stop_recording)`) — surprising if you're mapping timing behavior.
14. **Single-instance vs. headless**: the CLI toggles only work when an instance is
    already running (they're forwarded), while headless flags always spawn a fresh
    instance; mixing flags across those two groups behaves non-obviously.

---

## Cross-Links (adjacent subsystems, not mapped here)

- **Shortcut capture**: `src-tauri/src/shortcut/` (tauri*impl / handy_keys backends,
  `handler.rs` funnel, all `change*\*\_setting`commands live in`shortcut/mod.rs`).
- **Audio capture & VAD**: `src-tauri/src/managers/audio.rs`,
  `src-tauri/src/audio_toolkit/` (recorder, resampler, VAD, WAV IO, mic levels).
- **Transcription engines & streaming**: `src-tauri/src/managers/transcription.rs`
  (model load/unload, stream router, `StreamTextEvent`/`StreamPhaseEvent`),
  `src-tauri/src/managers/model.rs` (+ `catalog/`).
- **Text output**: `src-tauri/src/clipboard.rs (paste)`, `src-tauri/src/input.rs`
  (EnigoState).
- **Overlay UI**: `src-tauri/src/overlay.rs` + `src/overlay/RecordingOverlay.tsx`.
- **Tray**: `src-tauri/src/tray.rs`, `tray_i18n.rs`.
- **History**: `src-tauri/src/managers/history.rs`, `src-tauri/src/commands/history.rs`
  (incl. retry-transcription which re-enters `process_transcription_output`).
- **Post-processing**: `src-tauri/src/llm_client.rs`,
  `src-tauri/src/apple_intelligence.rs`.
- **Settings store**: `src-tauri/src/settings.rs` (`AppSettings`, Tauri store).
- **Frontend shell**: `src/App.tsx` (event toasts, deferred init),
  `src/bindings.ts` (generated typed command/event client).
