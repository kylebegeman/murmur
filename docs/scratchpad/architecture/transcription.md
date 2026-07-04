# Transcription Engines & Streaming

Subsystem map for the Handy/Murmur dictation pipeline: engine abstraction, model
load/unload, batch vs live-streaming transcription, partial-result emission,
language/translate options, and custom-word/filler post-processing.

All paths are relative to the repo root (`/Users/kyle/Developer/products/murmur-new`).

## Purpose

`TranscriptionManager` (`src-tauri/src/managers/transcription.rs`) owns exactly one
loaded speech-to-text engine at a time and exposes two run paths:

1. **Batch**: `transcribe(Vec<f32>) -> Result<String>` over the full 16 kHz mono
   recording after the user releases the shortcut.
2. **Streaming** (live preview): a worker thread that leases the engine, opens a
   `transcribe_cpp` `Stream` on the held `Session`, is fed real-time audio frames
   through a `StreamRouter`, and emits `StreamTextEvent { committed, tentative }`
   snapshots to the overlay as the model decodes. Only transcribe-cpp
   (GGUF) models can stream; every other engine silently falls back to batch.

It also owns model lifecycle: load (with accelerator/backend selection), unload
(manual, idle-timeout watcher, or "immediately after use"), panic containment, and
runtime capability reconciliation back into the `ModelManager` registry.

## Key files

| File | Role |
| --- | --- |
| `src-tauri/src/managers/transcription.rs` | The whole subsystem: `TranscriptionManager`, `StreamRouter`, `LoadedEngine`, stream worker, batch transcribe, accelerator/backend selection, post-processing entry point, idle-unload watcher, CLI device helpers. ~1950 lines. |
| `src-tauri/src/commands/transcription.rs` | Three thin Tauri commands: `set_model_unload_timeout`, `get_model_load_status`, `unload_model_manually`. |
| `src-tauri/src/audio_toolkit/text.rs` | Text post-processing: `apply_custom_words` (fuzzy Levenshtein + Soundex + n-gram correction) and `filter_transcription_output` (language-aware filler-word removal + stutter collapse). Pure functions, well unit-tested. |
| `src-tauri/src/managers/model.rs` | (adjacent subsystem) `EngineType`, `ModelInfo` (incl. `supports_streaming`), `effective_language()` coercion, `set_runtime_capabilities()` reconciliation. |
| `src-tauri/src/managers/model_capabilities.rs` | (adjacent) GGUF header probe; reads `stt.capability.streaming` etc. pre-download/pre-load. |
| `src-tauri/src/catalog/catalog.json` + `catalog/mod.rs` | (adjacent) bundled model registry with `capabilities.streaming` flags. |
| `src-tauri/src/actions.rs` | (adjacent, orchestration) `TranscribeAction::start/stop` — decides streaming vs batch, finalizes, post-processes, pastes. |
| `src-tauri/src/managers/audio.rs` + `src-tauri/src/audio_toolkit/audio/recorder.rs` | (adjacent, audio capture) feeds VAD-gated 16 kHz frames into `StreamRouter::feed` via the recorder's audio callback. |
| `src-tauri/src/commands/history.rs` | (adjacent) `retry_history_entry_transcription` re-runs batch `transcribe()` on a saved WAV. |
| `src-tauri/src/lib.rs` | Command/event registration; headless CLI `--transcribe-file` benchmark path; startup init (`init_transcribe_backend`, `apply_accelerator_settings`). |
| `src/overlay/RecordingOverlay.tsx` | (frontend) consumes `streamTextEvent` / `streamPhaseEvent` and renders the live panel. |

## Engine abstraction

`transcription.rs (LoadedEngine)` — one enum, one loaded engine at a time behind
`Arc<Mutex<Option<LoadedEngine>>>`:

```rust
enum LoadedEngine {
    TranscribeCpp(Session),            // transcribe-cpp: ANY GGUF (whisper, breeze-asr,
                                       // parakeet-gguf, voxtral, qwen3-asr, nemotron,
                                       // canary-gguf, custom .bin/.gguf). Arch auto-detected.
    Parakeet(ParakeetModel),           // transcribe-rs ONNX
    Moonshine(MoonshineModel),         // transcribe-rs ONNX
    MoonshineStreaming(StreamingModel),// transcribe-rs ONNX (name is misleading, see below)
    SenseVoice(SenseVoiceModel),       // transcribe-rs ONNX
    GigaAM(GigaAMModel),               // transcribe-rs ONNX
    Canary(CanaryModel),               // transcribe-rs ONNX
    Cohere(CohereModel),               // transcribe-rs ONNX
}
```

The variant is chosen by `ModelInfo.engine_type` (`model.rs (EngineType)`, same 8
variants). Two engine libraries:

- **transcribe-cpp** (whisper.cpp-family C++ via GGUF): holds a `Model` +
  `Session`; the `Session` is kept alive in the enum so repeated dictations reuse
  it. Backend (CPU/Metal/CUDA/Vulkan) is fixed at load time via `ModelOptions`.
  This is the ONLY library with a live streaming API (`session.stream(...)`).
- **transcribe-rs** (ONNX Runtime): one struct per architecture, all loaded with
  `Quantization::Int8` except Moonshine (`Quantization::default()`, variant
  `Base`) and MoonshineStreaming (`StreamingModel::load(path, 0, default)`).
  Accelerator is a process-global (`accel::set_ort_accelerator`).

**Important naming trap**: `EngineType::MoonshineStreaming` wraps transcribe-rs's
ONNX `StreamingModel`, but the app only ever calls its *batch* `transcribe()`
(`transcription.rs (transcribe)`, `LoadedEngine::MoonshineStreaming` arm). The live
overlay streaming path matches exclusively on `LoadedEngine::TranscribeCpp`; ONNX
"streaming" moonshine never feeds the live preview. The catalog's GGUF
`moonshine-streaming-*` models (engine `TranscribeCpp`) are what actually stream.

### How streaming capability is detected

Two layers, deliberately:

1. **Pre-recording (decides whether to even try)** — `actions.rs
   (TranscribeAction::start)` reads `ModelInfo.supports_streaming` from the
   `ModelManager` registry. That flag comes from, in increasing authority:
   - `catalog.json` `capabilities.streaming` (currently true for seven models:
     `parakeet-unified-en-0.6b-gguf`, `nemotron-3.5-asr-streaming-0.6b-gguf`,
     `Voxtral-Mini-4B-Realtime-2602-gguf`, `moonshine-streaming-tiny-gguf`,
     `moonshine-streaming-small-gguf`, `moonshine-streaming-medium-gguf`,
     `nemotron-speech-streaming-en-0.6b-gguf`);
   - the 64 KiB GGUF header probe for local/custom models
     (`model_capabilities.rs`, key `stt.capability.streaming`; absent key => `None`
     => treated as false);
   - runtime reconciliation: after every transcribe-cpp load,
     `transcription.rs (load_model_with_device)` calls
     `session.model().capabilities()` and pushes the real values into
     `model.rs (ModelManager::set_runtime_capabilities)` (streaming, translate,
     language-detect, language list). This matters because transcribe-cpp *infers*
     streaming for parakeet/nemotron families where the flat GGUF key is absent.
   - All ONNX engine types are `supports_streaming: false` in the registry.
2. **At stream start (ground truth)** — `transcription.rs (run_stream_worker)`
   re-checks `session.model().capabilities().supports_streaming` on the actually
   loaded engine. If false (or the engine is not `TranscribeCpp`), the worker
   returns the engine, clears the router, and drains commands until finalize,
   replying `None` so the caller falls back to batch.

## Model load / unload

### Load — `transcription.rs (load_model_with_device)`

1. `apply_accelerator_settings(app)` — sets the transcribe-rs ORT global from
   `settings.ort_accelerator` (transcribe-cpp backend is NOT set here; it's chosen
   per-load).
2. Emit `model-state-changed` `loading_started`.
3. `ModelManager::get_model_info(model_id)`; missing => `Err`; not downloaded =>
   emit `loading_failed`, `Err`.
4. **Drop the current engine and clear `current_model_id` before building the new
   one** (avoids two native contexts resident; a failed load leaves status "no
   loaded model").
5. Per-`EngineType` construction (see enum above). For `TranscribeCpp`:
   - backend: explicit `device_index` (CLI `--device-index` =>
     `resolve_device_index`) or `select_transcribe_backend(settings.transcribe_accelerator)`
     + `resolve_gpu_device(...)` from settings;
   - `Model::load_with(&path, &ModelOptions { backend, gpu_device })`, then
     `model.session()`;
   - reconcile runtime capabilities into the registry (see above).
6. Store engine + model id, `touch_activity()`, emit `model-state-changed`
   `loading_completed`.

Every load failure emits `model-state-changed` `loading_failed` with the error
string before returning `Err`.

`load_model(id)` = `load_model_with_device(id, None)`.

### Background load — `transcription.rs (initiate_model_load)`

Called at the start of every dictation (`actions.rs (TranscribeAction::start)`)
and on history retry. If not already loading/loaded (or a reload is pending via
`reload_model_on_next_use`), spawns a thread that loads `settings.selected_model`.
The `is_loading` flag + `loading_condvar` let `transcribe()` and
`run_stream_worker` block until the load finishes. **A failure here is only
`error!`-logged** (plus the `loading_failed` event from `load_model`); the user
learns about it later when `transcribe()` returns "Model is not loaded for
transcription." on the `transcription-error` toast.

### Unload

- `unload_model()` — drops the engine, clears the id, emits `model-state-changed`
  `unloaded`.
- **Idle watcher** (thread spawned in `TranscriptionManager::new`): every 10 s
  compares `last_activity` against `settings.model_unload_timeout`
  (`never | immediately | min2 | min5(default) | min10 | min15 | hour1 | sec15(debug)`).
  Skips the check while recording (refreshes the timer instead) and skips the
  `Immediately` variant entirely.
- `maybe_unload_immediately(context)` — runs after each batch transcription,
  stream finalize, and cancellation when the setting is `Immediately`.
- **Accelerator change**: `shortcut/mod.rs (save_accelerator_and_reload_next_use)`
  writes settings and calls `reload_model_on_next_use()`; the flag makes the next
  `initiate_model_load` reload even though an engine is resident.
- **Panic containment**: `transcribe()` wraps the engine call in
  `catch_unwind`; on panic the engine is *not* returned (dropped = unloaded),
  `current_model_id` is cleared, and `model-state-changed` `unloaded` is emitted
  with `error: "Engine panicked: …"`. `lock_engine()` also recovers a poisoned
  mutex.
- `Drop for TranscriptionManager` joins the watcher only when the last clone
  drops (guarded by `Arc::strong_count(&self.engine) > 1`).

## Runtime flow

### Batch (non-streaming model, or streaming fallback)

1. Shortcut press: `actions.rs (TranscribeAction::start)` →
   `tm.initiate_model_load()` (background), VAD preload, recorder starts with
   `VadPolicy::Offline` (or `Disabled`). Overlay = compact recording pill.
2. Shortcut release: `actions.rs (TranscribeAction::stop)` → recorder
   `stop_recording` returns all captured samples → `tm.finalize_stream()` returns
   `Ok(None)` (no stream) → `tm.transcribe(samples)`.
3. `transcription.rs (transcribe)`:
   - debug-only `HANDY_FORCE_TRANSCRIPTION_FAILURE` env simulates failure;
   - empty audio => `Ok("")` (and possible immediate unload);
   - wait on `loading_condvar`; engine `None` => `Err("Model is not loaded …")`;
   - resolve language: `effective_language_for_model(settings, mm, active_model)`
     → `model.rs (effective_language)` — coerces the persisted *intent*
     (`selected_language`, may be `"auto"`) against the loaded model's supported
     languages and language-detect capability; never written back to settings;
   - **take the engine out of the mutex** (no lock held during inference), probe
     transcribe-cpp live capabilities (`Feature::InitialPrompt`, translate,
     languages);
   - run the engine inside `catch_unwind` (per-engine arms described below);
   - `return_engine()` puts it back unless the model was switched/unloaded
     mid-run (then the stale engine is dropped);
   - `post_process_transcription_text(raw, settings, model_takes_initial_prompt)`;
   - log real-time factor; `maybe_unload_immediately("transcription")`.
4. Back in `actions.rs`: OpenCC zh-Hans/zh-Hant conversion, optional LLM
   post-processing, history save, paste. (Other subsystems.)

Per-engine batch options (`transcription.rs (transcribe)` match arms):

| Engine | Options |
| --- | --- |
| TranscribeCpp | `RunOptions { task, language, target_language }` from `transcribe_cpp_run_plan`; `RunExtension::Whisper(WhisperRunOptions { initial_prompt: custom_words.join(", ") })` only when the model advertises `Feature::InitialPrompt` (whisper family — attaching it to other archs is rejected with INVALID_ARG); `timestamps: Segment` when prompt-capable (prevents whisper long-form (>30 s) repetition-loop degeneration with prompt + no timestamps), else `None`. |
| Parakeet | `ParakeetParams { timestamp_granularity: Segment }`. |
| Moonshine / MoonshineStreaming / GigaAM | `TranscribeOptions::default()` (no language/translate). |
| SenseVoice | `SenseVoiceParams { language: whitelist zh/en/ja/ko/yue else None, use_itn: true }` (zh-Hans/zh-Hant collapsed via `normalize_cjk_language`). |
| Canary | `TranscribeOptions { language: unless "auto", translate: settings.translate_to_english }` — transcribe-rs forces the target to English itself. |
| Cohere | `TranscribeOptions { language: CJK-normalized unless "auto" }`, no translate. |

Language/translate plan for transcribe-cpp — `transcription.rs (transcribe_cpp_run_plan)`
and `(cpp_translation_task)`, shared verbatim by batch and streaming:

- language is only passed if the loaded model *advertises* it in
  `capabilities().languages` (else auto-detect, avoiding UNSUPPORTED_LANGUAGE);
  `zh-Hans`/`zh-Hant` intents collapse to `zh` for the engine (the script
  conversion happens later via OpenCC in `actions.rs`);
- `Task::Translate` + `target_language: "en"` only when
  `settings.translate_to_english` AND the model supports translate AND the source
  language isn't `en` (transcribe-cpp needs an explicit target: a null target
  defaults to the *source*, so es→es would silently happen otherwise).

### Streaming (live preview)

Precondition: selected model's `ModelInfo.supports_streaming == true` and
`settings.overlay_style == Live` for the big panel (streaming still runs with the
minimal overlay; only the UI differs).

1. **Press** — `actions.rs (TranscribeAction::start)`:
   - `vad_policy = Streaming` (Silero hangover tail 55×30 ms frames vs 15 offline —
     `audio_toolkit/vad/mod.rs`), `tm.start_stream()`, streaming overlay shown.
2. `transcription.rs (start_stream)` — guards against a second worker
   (`active_stream_worker` CAS), opens the `StreamRouter` channel, spawns
   `run_stream_worker`. Non-blocking; frames sent before the stream begins queue
   on the channel.
3. **Frame feed** — the audio recorder (`managers/audio.rs (create_audio_recorder)`
   → `audio_toolkit/audio/recorder.rs (run_consumer / handle_frame)`) invokes the
   audio callback with each VAD-passed 16 kHz 30 ms frame; the callback is just
   `router.feed(frame)`. `StreamRouter::feed` is a relaxed atomic check + clone +
   unbounded `mpsc` send (cheap no-op when no stream is open). The recorder ALSO
   accumulates the same frames into `processed_samples`, so the full recording
   always exists for batch fallback / WAV history.
4. `transcription.rs (run_stream_worker)`:
   - `StreamWorkerGuard` (RAII) clears `stream_active` / `active_engine_lease` /
     `active_stream_worker` on any exit, including panics;
   - waits on `loading_condvar` for the background load racing it;
   - **leases the engine out of the mutex** (`active_engine_lease = worker_id`;
     `is_model_loaded()` consults the lease so the model still reports loaded);
     engine gone => log info, clear router, `drain_until_finalize` (=> batch);
   - re-checks capabilities on the live session; not streaming-capable => return
     engine, drain (=> batch);
   - builds `RunOptions` via the shared `transcribe_cpp_run_plan`;
   - `session.stream(&run_options, &StreamOptions::default())` (CommitPolicy::Auto,
     family-default strategy); on success sets `stream_active = true`;
   - loop on the command channel:
     - `Feed(pcm)` → `stream.feed(&pcm)`; if `update.committed_changed ||
       update.tentative_changed` → `stream.text()` → `emit_stream_text` →
       **`stream-text-event`** `{ committed, tentative }` (committed is the
       append-only flicker-free prefix, tentative the volatile suffix the model
       may rewrite). Feed errors are only `warn!`-logged; the loop continues.
     - `Finalize(reply)` → `stream.finalize()`; success replies
       `Some(stream.text().display())` (committed + tentative); failure replies
       `None` (=> caller batch-falls-back) after `error!` log.
     - `Cancel` → `stream.reset()`, break.
   - `StreamPerf` logs compute/audio RTF, buffered ms, revision every 5 s
     (`STREAM_PERF_LOG_INTERVAL`), plus a finalize summary;
   - engine returned via `return_engine` (dropped instead if the model changed
     mid-stream), then the finalize reply is sent.
5. **Release** — `actions.rs (TranscribeAction::stop)`:
   - if Live overlay + `tm.is_streaming()` → `tm.emit_stream_working(Transcribing)`
     → **`stream-phase-event`** `{ phase: "working", kind: "transcribing" }` (the
     frontend starts in `"listening"`; Rust only emits transitions away from it);
     else the compact transcribing pill;
   - `tm.finalize_stream()`:
     - `router.take()` (closes the route; subsequent frames no-op), sends
       `Finalize`, waits `recv_timeout(30 s)` (`STREAM_FINALIZE_REPLY_TIMEOUT`);
     - reply `Some(text)` → `post_process_transcription_text(raw, settings,
       false)` — streaming NEVER gets a decode prompt, so custom words always go
       through the fuzzy path — then `maybe_unload_immediately`; returns
       `Ok(Some(filtered))`;
     - reply `None` / channel closed / no stream → `Ok(None)`;
     - timeout → `Err` (the worker may still hold the engine, so the caller
       surfaces the error instead of starting a contending batch run);
   - `Ok(Some(non-empty))` wins; `Ok(None)` or empty → `tm.transcribe(samples)`
     re-transcribes the full recording; `Err` → `transcription-error` event;
   - if post-processing runs with the Live overlay,
     `tm.emit_stream_working(Polishing)` → `{ phase: "working", kind: "polishing" }`.
6. **Cancel** (`utils.rs (cancel_current_operation)`, empty-sample paths in
   `actions.rs`) → `tm.cancel_stream()` — sends `Cancel`, clears
   `stream_active`. Also called defensively when recording fails to start and
   when no samples are returned, so the worker's channel never leaks and blocks
   the next `start_stream`.

Frontend: `src/overlay/RecordingOverlay.tsx` listens to
`events.streamTextEvent` / `events.streamPhaseEvent` (tauri-specta bindings in
`src/bindings.ts`), plus `show-overlay` / `hide-overlay` / `mic-level`, and
renders committed text solid + tentative text dimmed with a caret, morphing the
pill into a panel.

### Headless CLI path

`lib.rs (run_headless_transcription)` (`lib.rs:336`; `--transcribe-file`, `--model`, `--device-index`,
`--repeat`, `--json`, `--list-devices`, `--list-models`): validates the WAV is
16 kHz mono 16-bit PCM, `tm.load_model_with_device(model_id, device_index)`
(hard device selection, not persisted), timed `tm.transcribe(samples)` runs,
prints RTF + text. `describe_compute_devices()` backs `--list-devices`.
`init_transcribe_backend()` (routes native/ggml logs into `log`, registers
compute backends; must run before the first load) and
`apply_accelerator_settings()` run at startup in both GUI and headless modes
(`lib.rs` lines ~173/774).

## Text post-processing (this subsystem's share)

`transcription.rs (post_process_transcription_text)`, applied to BOTH batch and
streaming results before they leave the manager:

1. `audio_toolkit/text.rs (apply_custom_words)` — skipped when the words were
   already given to whisper as an initial prompt. Fuzzy match per word and per
   2-/3-gram (longest first): normalized Levenshtein, ×0.3 boost on Soundex
   match, ≤25 % length difference gate, accept below
   `settings.word_correction_threshold` (default 0.18). Preserves case pattern
   and surrounding punctuation ("Charge B," → "ChargeBee,").
2. `audio_toolkit/text.rs (filter_transcription_output)` — filler-word removal
   keyed on `settings.app_language` (per-language lists in
   `get_filler_words_for_language`; e.g. Portuguese keeps "um", Spanish keeps
   "ha"); `settings.custom_filler_words` `Some(list)` overrides, `Some([])`
   disables, `None` uses defaults; then `collapse_stutters` (3+ identical
   consecutive words → one) and whitespace cleanup.

Chinese Simplified/Traditional conversion (OpenCC) and LLM polishing happen
*after* this, in `actions.rs (process_transcription_output)` (pipeline
subsystem), gated on the effective language re-resolved via
`actions.rs (resolve_effective_language)`.

## Tauri commands & events

### Commands (frontend → Rust), registered in `lib.rs (collect_commands!)`

Core (this subsystem, `commands/transcription.rs`):

| Command | Payload → Result | Notes |
| --- | --- | --- |
| `set_model_unload_timeout` | `{ timeout: ModelUnloadTimeout }` → `()` | writes `settings.model_unload_timeout` |
| `get_model_load_status` | `()` → `{ is_loaded: bool, current_model: string \| null }` | lease-aware |
| `unload_model_manually` | `()` → `Result<(), String>` | |

Adjacent but wired directly into this manager:

| Command | Effect here |
| --- | --- |
| `set_active_model` (`commands/models.rs (switch_active_model)`) | claims `try_start_loading` guard, persists `selected_model`, calls `load_model` (skipped + `selection_changed` event when timeout = Immediately); reverts the setting on load failure. Also used by the tray menu. |
| `delete_model` | unloads first when deleting the active model |
| `get_transcription_model_status` | `tm.get_current_model()` |
| `is_model_loading` | **misnamed**: returns `current_model.is_none()`, not the `is_loading` flag |
| `retry_history_entry_transcription` (`commands/history.rs`) | `initiate_model_load()` + blocking `tm.transcribe(samples)` from a saved WAV |
| `shortcut::change_translate_to_english_setting`, `change_selected_language_setting`, `update_custom_words`, `change_word_correction_threshold_setting` | write the settings this subsystem reads per-run |
| `shortcut::change_transcribe_accelerator_setting`, `change_ort_accelerator_setting`, `change_transcribe_gpu_device` | write + `tm.reload_model_on_next_use()` |
| `shortcut::get_available_accelerators` | `transcription.rs (get_available_accelerators)` → `{ transcribe: ["auto","cpu","gpu"], ort: [...], gpu_devices: [{id, name, total_vram_mb}] }` (GPU list cached in a `OnceLock` at first call) |
| `cancel_operation` | → `utils::cancel_current_operation` → `tm.cancel_stream()` |

### Events (Rust → frontend)

| Event name | Payload | Emitted from | Listeners |
| --- | --- | --- | --- |
| `model-state-changed` | `ModelStateEvent { event_type: "loading_started" \| "loading_completed" \| "loading_failed" \| "unloaded" \| "selection_changed", model_id?, model_name?, error? }` | `transcription.rs (load_model_with_device, unload_model, transcribe panic arm)`, `commands/models.rs (switch_active_model)` | `src/App.tsx` (toasts), `settingsStore.ts`, `modelStore.ts`, `ModelSelector.tsx`. Plain `app.emit` (string-typed, NOT in the specta registry). |
| `stream-text-event` | `StreamTextEvent { committed: string, tentative: string }` | `transcription.rs (emit_stream_text)` on every commit/tentative change during feed | `RecordingOverlay.tsx` via typed `events.streamTextEvent` (tauri-specta, registered in `lib.rs (collect_events!)`) |
| `stream-phase-event` | `StreamPhaseEvent { phase: "listening" \| "working", kind?: "transcribing" \| "polishing" }` | `transcription.rs (emit_stream_working)` called from `actions.rs` | `RecordingOverlay.tsx`. Rust only ever emits `working`; `listening` is the frontend's initial state. |
| `transcription-error` | `String` (error text) | `actions.rs (TranscribeAction::stop)` on batch/finalize failure | `src/App.tsx` toast |
| `recording-error` | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail? }` | `actions.rs (TranscribeAction::start)` | `src/App.tsx` |
| `paste-error` | `()` | `actions.rs` | `src/App.tsx` |
| `models-updated` | `()` | `model.rs (rescan_local_models)` etc. | `modelStore.ts` |
| `model-download-progress` / `model-download-failed` | progress / `{model_id, error}` | `model.rs` / `commands/models.rs` | model UI (adjacent subsystem) |
| `show-overlay` / `hide-overlay` / `mic-level` | overlay state string / `number[16]` | `overlay.rs` / recorder level callback | `RecordingOverlay.tsx` (adjacent) |

## Settings keys

All live in the single `"settings"` object of `settings_store.json`
(`settings.rs (AppSettings)`), read fresh via `get_settings` on every use:

- `selected_model` — id loaded by `initiate_model_load`; written by
  `switch_active_model`.
- `selected_language` — persisted *intent* (`"auto"` or a code); coerced per-model
  at run time by `effective_language`, never written back.
- `translate_to_english` — gates `Task::Translate` (transcribe-cpp) /
  `translate: true` (Canary).
- `custom_words: Vec<String>` — whisper initial prompt or fuzzy correction input.
- `word_correction_threshold: f64` (default 0.18).
- `custom_filler_words: Option<Vec<String>>` — `None` = language defaults,
  `Some([])` = disable filtering.
- `app_language` — selects the filler-word list (NOT the recognition language).
- `model_unload_timeout` — idle watcher / immediate unload.
- `transcribe_accelerator` (`auto|cpu|gpu`) — transcribe-cpp backend at load time.
- `transcribe_gpu_device: i32` — transcribe-cpp device registry index (−1 = auto
  sentinel; validated by `resolve_gpu_device`, silently falls back to 0 if stale).
- `ort_accelerator` (`auto|cpu|cuda|directml|rocm`) — transcribe-rs global.
- `vad_enabled`, `overlay_style` (`live|minimal|none`), `always_on_microphone` —
  read in `actions.rs` to pick VAD policy / overlay / feedback timing.

## Platform-specific behavior

- **macOS**: `select_transcribe_backend(Gpu)` candidates = `[Backend::Metal]`
  only; transcribe-cpp is a static build there, so `init_backends_default()` is a
  no-op (backends compiled in). Elsewhere candidates = `[Cuda, Vulkan]`, and a
  `dynamic-backends` build loads per-ISA CPU/GPU modules at startup. If no GPU
  backend is available, `Gpu` silently degrades to `Auto` (warn log only).
- ORT accelerator options are build-dependent (`OrtAccelerator::available()`);
  CUDA/DirectML/ROCm are non-mac; macOS effectively gets Auto/CPU (CoreML not
  exposed here).
- Apple Intelligence LLM post-processing is macOS-aarch64-only (`actions.rs`,
  adjacent subsystem).
- The overlay default differs per-OS upstream of this subsystem
  (`settings.rs` notes Linux defaults `overlay_style` handling).

## Fragile points & failure modes

- **Silent background-load failure**: `initiate_model_load` only logs `error!`.
  The UI does get `model-state-changed: loading_failed`, but nothing blocks the
  recording from proceeding; the user finds out at release time via a generic
  `transcription-error` ("Model is not loaded for transcription."). If the
  frontend misses the event (e.g. overlay-only context), there is no feedback
  until then.
- **Streaming feed errors are swallowed**: `stream.feed` failures are `warn!`
  only; the live text just stops updating while recording continues. If
  `finalize` then also fails, the reply is `None` and the batch fallback saves
  the text — but a *timeout* (30 s) surfaces an error with NO fallback, losing
  the take's text (the WAV is still saved to history for retry).
- **Batch fallback doubles work**: any streaming session that yields `None`/empty
  re-transcribes the entire recording from scratch — correct but potentially a
  long "Transcribing…" spinner after a long dictation on a slow model.
- **Unbounded frame channel**: `StreamRouter::feed` clones every 30 ms frame into
  an unbounded `mpsc`. A model slower than real time (or a stalled worker) grows
  the queue without limit for the duration of the recording; there is no
  backpressure or drop policy.
- **Stuck worker blocks the next stream**: after a finalize timeout the worker
  may still hold the engine lease; `start_stream` refuses to start while
  `active_stream_worker != 0` (warn only), so subsequent dictations silently run
  without live preview (they still work via batch) until the worker exits.
- **Concurrent batch calls race the taken engine**: `transcribe()` takes the
  engine out of the mutex; a second concurrent call sees `None` and returns the
  misleading error "Model failed to load after auto-load attempt". Normal UI flow
  serializes via the `TranscriptionCoordinator`, but the history-retry command
  and CLI path can race a hotkey dictation.
- **`is_model_loading` lies**: it returns `current_model.is_none()`, i.e.
  "nothing loaded", not the actual `is_loading` flag — a UI polling it during an
  idle-unloaded period shows "loading" forever.
- **Engine panic = model unload**: contained via `catch_unwind`, but the run's
  audio is only recoverable through history retry; the panic message reaches the
  UI via `model-state-changed.error` and the `transcription-error` toast.
- **Event emission is fire-and-forget**: every `emit` in this subsystem ignores
  its `Result` (`let _ =`), including error events — if the webview is gone,
  errors vanish.
- **Capability drift**: pre-recording streaming decisions use registry metadata
  that may say `false` until the first successful load reconciles runtime truth
  (`set_runtime_capabilities`) — a genuinely streaming-capable custom GGUF with a
  bare header won't live-stream until it has been loaded once.
- **Whisper prompt/timestamps coupling**: custom words as an initial prompt force
  `TimestampKind::Segment` to dodge the whisper.cpp long-form repetition loop;
  removing either side of that pairing regresses >30 s dictations.
- **Two sources of truth for capabilities**: `ModelInfo` (registry) vs
  `session.model().capabilities()` (live). Batch and streaming deliberately trust
  the live session for run options but the registry for `effective_language` —
  keep that split in mind when refactoring.
- Debug-only failure injection: env `HANDY_FORCE_TRANSCRIPTION_FAILURE` makes
  `transcribe()` fail (debug builds only).

## Cross-links (other subsystems)

- **Audio capture / VAD**: `managers/audio.rs`, `audio_toolkit/audio/recorder.rs`,
  `audio_toolkit/vad/*` — produce the 16 kHz frames; `VadPolicy::Streaming`
  (55-frame hangover) exists specifically for this subsystem; the recorder holds
  the `Arc<StreamRouter>` from `TranscriptionManager::stream_router()` (wired in
  `lib.rs` line ~165).
- **Model management**: `managers/model.rs`, `managers/model_capabilities.rs`,
  `managers/gguf_meta.rs`, `catalog/` — registry, downloads, capability probes,
  `effective_language`.
- **Pipeline orchestration**: `actions.rs` (TranscribeAction), `transcription_coordinator.rs`
  (serializes press/release/cancel through one thread; notified via `FinishGuard`).
- **Output/paste + overlay + tray**: `utils.rs`, `overlay.rs`, `clipboard.rs`,
  `tray.rs`.
- **History**: `managers/history.rs`, `commands/history.rs` (WAV save + retry).
- **LLM post-processing**: `actions.rs (post_process_transcription)`,
  `llm_client.rs`, `apple_intelligence.rs`.
- **Settings**: `settings.rs`, `shortcut/mod.rs` setting commands.
- **Frontend**: `src/bindings.ts` (generated by tauri-specta in debug builds),
  `src/overlay/RecordingOverlay.tsx`, `src/App.tsx`, `src/stores/modelStore.ts`.
