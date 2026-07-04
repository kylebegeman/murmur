# Voice Activity Detection (VAD) Subsystem

Status: architecture map of the existing Handy code, pre-Murmur changes. Verified against source on 2026-07-04. Paths are relative to the repo root.

## Purpose

VAD gates the microphone stream frame-by-frame during a recording so that silence and non-speech noise never reach transcription. It runs a Silero VAD v4 ONNX model (via the `vad-rs` crate on ONNX Runtime) on 30 ms / 480-sample frames of 16 kHz mono audio, wrapped in a smoothing state machine (onset debounce, pre-roll, post-speech hangover). Both consumers of recorded audio are downstream of the same gate:

- the accumulated per-session buffer returned by `AudioRecorder::stop()` and fed to offline transcription, and
- the real-time frame callback that feeds live streaming transcription (`StreamRouter::feed`).

VAD improves transcription quality by removing long silences (which Whisper-family models tend to hallucinate on) and shrinking the audio sent to the model. It is user-toggleable via the single `vad_enabled` setting.

## Key files and roles

| File                                                    | Role                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/audio_toolkit/vad/mod.rs`                | Trait + frame enum + tuning constants shared by all detectors                                                                                                    |
| `src-tauri/src/audio_toolkit/vad/silero.rs`             | `SileroVad`: raw per-frame speech probability via the Silero ONNX model                                                                                          |
| `src-tauri/src/audio_toolkit/vad/smoothed.rs`           | `SmoothedVad`: onset / prefill / hangover smoothing wrapper around any detector                                                                                  |
| `src-tauri/src/audio_toolkit/audio/recorder.rs`         | `AudioRecorder` + `VadPolicy` + `VadConfig`; applies VAD in the consumer thread (`run_consumer` / `handle_frame`)                                                |
| `src-tauri/src/audio_toolkit/audio/resampler.rs`        | `FrameResampler`: converts device-rate chunks into exact 480-sample 16 kHz frames the VAD requires (adjacent subsystem, one hop)                                 |
| `src-tauri/src/managers/audio.rs`                       | `AudioRecordingManager`: builds the VAD stack (`create_audio_recorder`), resolves the bundled model path (`preload_vad`), owns recording lifecycle               |
| `src-tauri/src/actions.rs`                              | `TranscribeAction::start`: chooses the per-session `VadPolicy` from settings + model streaming capability; kicks off VAD preload in parallel with ASR model load |
| `src-tauri/src/settings.rs`                             | `AppSettings.vad_enabled` (`default_vad_enabled()` = `true`)                                                                                                     |
| `src-tauri/src/shortcut/mod.rs`                         | Tauri command `change_vad_enabled_setting`                                                                                                                       |
| `src-tauri/src/lib.rs`                                  | Registers `change_vad_enabled_setting` in the invoke handler                                                                                                     |
| `src/components/settings/VoiceActivityDetection.tsx`    | Settings toggle component (the only VAD UI)                                                                                                                      |
| `src/components/settings/advanced/AdvancedSettings.tsx` | Mounts `<VoiceActivityDetection/>` in Settings → Advanced                                                                                                        |
| `src/stores/settingsStore.ts`                           | Maps `vad_enabled` updates to `commands.changeVadEnabledSetting` with optimistic update + rollback                                                               |
| `src/bindings.ts`                                       | Specta-generated `changeVadEnabledSetting` → `invoke("change_vad_enabled_setting")`                                                                              |
| `src-tauri/src/audio_toolkit/bin/cli.rs`                | Dev CLI that builds the same stack standalone (threshold 0.5, relative model path)                                                                               |
| `src-tauri/resources/models/silero_vad_v4.onnx`         | The bundled Silero VAD v4 model weights                                                                                                                          |

External crate: `vad-rs` (git, `https://github.com/cjpais/vad-rs`, pinned in `Cargo.lock` to rev `2a412ed`, `default-features = false`). Its `Vad` struct holds an `ort` session plus the Silero LSTM `h`/`c` state tensors (2x1x64 each); `Vad::compute` runs one frame and returns `VadResult { prob }`; `Vad::reset` zeroes the recurrent state. The session is created CPU-only with `GraphOptimizationLevel::Level3` and 1 intra / 1 inter thread (`vad-rs/src/session.rs`), independent of the app's `ort_accelerator` transcription setting.

## Key types and functions

### `src-tauri/src/audio_toolkit/vad/mod.rs`

- `trait VoiceActivityDetector: Send + Sync`
  - `push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>>` — primary streaming API, one 30 ms frame in, keep/drop decision out.
  - `is_voice(&mut self, frame) -> Result<bool>` — default method, `push_frame(...).is_speech()`.
  - `set_hangover_frames(&mut self, frames: usize)` — default no-op; lets the recorder retune the smoothing tail per session.
  - `reset(&mut self)` — default no-op.
- `enum VadFrame<'a> { Speech(&'a [f32]), Noise }` — `Speech` may aggregate several frames (prefill + current).
- Tuning constants (all in units of 30 ms frames):
  - `VAD_PREFILL_FRAMES = 15` (450 ms of pre-roll kept before detected onset)
  - `VAD_OFFLINE_HANGOVER_FRAMES = 15` (450 ms tail after speech, offline models)
  - `VAD_STREAMING_HANGOVER_FRAMES = 55` (1.65 s tail, streaming-capable models)
  - `VAD_ONSET_FRAMES = 2` (60 ms of consecutive voiced frames required to enter speech)

### `src-tauri/src/audio_toolkit/vad/silero.rs`

- `SileroVad { engine: vad_rs::Vad, threshold: f32 }`
- `SileroVad::new(model_path, threshold)` — validates `threshold ∈ [0.0, 1.0]`, builds the ONNX session at `constants::WHISPER_SAMPLE_RATE` (16 000 Hz). This is where `silero_vad_v4.onnx` is actually loaded from disk.
- `SileroVad::push_frame` — bails if the frame is not exactly `SILERO_FRAME_SAMPLES` = 16 000 × 30 / 1000 = **480 samples**; runs `engine.compute(frame)`; returns `Speech(frame)` iff `result.prob > self.threshold`.
- `SileroVad::reset` — clears the Silero LSTM hidden/cell state so a new session does not inherit recurrent context from the previous recording.
- No smoothing here: it is a pure per-frame boolean-probability detector.

### `src-tauri/src/audio_toolkit/vad/smoothed.rs`

- `SmoothedVad { inner_vad: Box<dyn VoiceActivityDetector>, prefill_frames, hangover_frames, onset_frames, frame_buffer: VecDeque<Vec<f32>>, hangover_counter, onset_counter, in_speech, temp_out }`
- `SmoothedVad::push_frame` state machine (per 30 ms frame):
  1. Every incoming frame is copied into `frame_buffer`, capped at `prefill_frames + 1` entries (a rolling 480 ms window).
  2. The wrapped detector's boolean verdict is taken via `inner_vad.is_voice(frame)`.
  3. Transitions:
     - `(false, true)` (silence → possible speech): increment `onset_counter`; once it reaches `onset_frames` (2), enter speech, arm `hangover_counter = hangover_frames`, and emit **one aggregated `Speech` buffer** containing the whole prefill window plus the current frame (`temp_out`, up to 16 × 480 = 7 680 samples). Until then, return `Noise` (the frames are not lost, they are in the prefill buffer).
     - `(true, true)` (ongoing speech): re-arm `hangover_counter`, emit `Speech(frame)`.
     - `(true, false)` (speech → silence): while `hangover_counter > 0`, decrement it and still emit `Speech(frame)` (this is what keeps trailing consonants and short pauses); when it hits 0, leave speech and return `Noise`.
     - `(false, false)`: reset `onset_counter`, return `Noise`.
- `set_hangover_frames` — swaps the tail length (used to flip offline ↔ streaming profiles on one resident engine).
- `reset` — resets inner VAD plus all counters/buffers.

### `src-tauri/src/audio_toolkit/audio/recorder.rs`

- `enum VadPolicy { Disabled, Offline, Streaming }` — how frames are filtered for one recording session.
- `struct VadConfig { detector: Arc<Mutex<Box<dyn VoiceActivityDetector>>>, offline_hangover_frames, streaming_hangover_frames }` with `VadConfig::hangover_for(policy)` (`Disabled` maps to the offline value but never reaches the detector).
- `AudioRecorder::with_vad(detector, offline_hangover, streaming_hangover)` — attaches a **single** VAD engine; offline and streaming are never concurrent, so one engine is reconfigured per session instead of keeping two ONNX sessions resident.
- `AudioRecorder::with_audio_callback` — registers the real-time post-VAD frame callback (`AudioFrameCallback`); frames arrive in order on the consumer thread, so the callback must stay cheap.
- `run_consumer(...)` — the consumer thread: builds a `FrameResampler` (device rate → 16 kHz, 30 ms frames), tracks `recording` + `vad_policy` state, processes `Cmd::Start/Stop/Shutdown`.
  - On `Cmd::Start(policy, _)`: clears `processed_samples`, sets `recording = true`, and if `policy != Disabled` locks the detector, calls `det.set_hangover_frames(cfg.hangover_for(policy))` then `det.reset()` so the session starts with clean smoothing and LSTM state.
  - On `Cmd::Stop`: drains the in-flight chunk plus everything up to the producer's `EndOfStream` sentinel (2 s timeout), flushes the resampler (`finish`, zero-padded final frame), and replies with `processed_samples`.
- `handle_frame(samples, recording, vad_policy, vad, audio_cb, out_buf)` — the actual gate, called once per 480-sample frame:
  - not recording → drop;
  - `VadPolicy::Disabled` → emit raw;
  - otherwise lock detector and `det.push_frame(samples).unwrap_or(VadFrame::Speech(samples))`; `Speech(buf)` → append `buf` to `out_buf` **and** invoke `audio_cb(buf)`; `Noise` → silently dropped;
  - no `VadConfig` attached at all → emit raw.

### `src-tauri/src/managers/audio.rs`

- `VAD_THRESHOLD: f32 = 0.3` (module constant, line 21; not user-configurable).
- `create_audio_recorder(vad_path, app_handle, stream_router)` — builds `SileroVad::new(vad_path, VAD_THRESHOLD)` → `SmoothedVad::new(silero, VAD_PREFILL_FRAMES, VAD_OFFLINE_HANGOVER_FRAMES, VAD_ONSET_FRAMES)` → `AudioRecorder::new().with_vad(smoothed, VAD_OFFLINE_HANGOVER_FRAMES, VAD_STREAMING_HANGOVER_FRAMES).with_level_callback(emit_levels).with_audio_callback(stream_router.feed)`.
- `AudioRecordingManager::preload_vad` — lazily creates the recorder exactly once; resolves the model with `app_handle.path().resolve("resources/models/silero_vad_v4.onnx", BaseDirectory::Resource)`. This is the only place the model path is resolved in the app proper.
- `AudioRecordingManager::start_microphone_stream` — calls `preload_vad()?` before opening the device (so a missing model fails the stream open), logs a `mic stream breakdown` timing line including `vad_ensure`.
- `AudioRecordingManager::try_start_recording(binding_id, vad_policy)` — in on-demand mode opens the stream, then `rec.start(vad_policy)`.

### `src-tauri/src/actions.rs` (policy selection)

`TranscribeAction::start`:

```rust
let vad_policy = if !settings.vad_enabled {
    VadPolicy::Disabled
} else if model_supports_streaming {
    VadPolicy::Streaming
} else {
    VadPolicy::Offline
};
```

`model_supports_streaming` comes from `ModelManager::get_model_info(selected_model).supports_streaming` (unknown → `false`). In parallel it spawns a thread running `rm.preload_vad()` so ONNX session creation overlaps ASR model load; a preload failure there is only `debug!`-logged.

### Frontend

- `src/components/settings/VoiceActivityDetection.tsx` — a `ToggleSwitch` bound to `getSetting("vad_enabled") ?? true` and `updateSetting("vad_enabled", enabled)`; i18n keys `settings.advanced.voiceActivityDetection.title` / `.description`. Rendered by `src/components/settings/advanced/AdvancedSettings.tsx`.
- `src/stores/settingsStore.ts` (`settingUpdaters.vad_enabled`, line 151) → `commands.changeVadEnabledSetting(value)`. `updateSetting` applies an optimistic store update, calls the command, and rolls back to the original value on error.
- `src/bindings.ts` — generated wrapper invoking `change_vad_enabled_setting` with `{ enabled }`.

## Runtime flow (hotkey press → transcription)

1. User presses the transcribe shortcut → `actions.rs (TranscribeAction::start)`.
2. VAD preload kicks off on a background thread (`managers/audio.rs (preload_vad)`): first call resolves `resources/models/silero_vad_v4.onnx` from the Tauri resource dir and builds the whole recorder stack (Silero ONNX session, threshold 0.3, wrapped in `SmoothedVad`). Subsequent calls are no-ops.
3. The session `VadPolicy` is computed from `settings.vad_enabled` and the selected model's `supports_streaming` flag (see above). Streaming models also get `tm.start_stream()`.
4. `try_start_recording(binding_id, vad_policy)` → `AudioRecorder::start` sends `Cmd::Start(policy, now)` to the consumer thread.
5. Consumer thread (`recorder.rs (run_consumer)`) on `Cmd::Start`: clears the session buffer, and (if policy ≠ Disabled) sets the hangover tail for this policy (15 frames offline / 55 streaming) and resets the detector (smoothing counters + Silero LSTM state).
6. cpal input callback (`recorder.rs (build_stream)`) downmixes device audio to mono f32 and sends chunks over an mpsc channel. The consumer feeds each raw chunk to the spectrum visualizer (pre-VAD; drives the `mic-level` overlay event) and to `FrameResampler::push`, which emits exact 480-sample 16 kHz frames.
7. Each frame goes through `recorder.rs (handle_frame)`:
   - Disabled → everything is kept.
   - Enabled → `SmoothedVad::push_frame` → `SileroVad::push_frame` (ONNX inference, `prob > 0.3`). Speech onset requires 2 consecutive voiced frames; the first Speech emission then includes up to 450 ms of pre-roll. Speech continues to be emitted through up to 450 ms (offline) / 1.65 s (streaming) of trailing silence. Everything else is dropped.
   - Every kept buffer is appended to `processed_samples` and forwarded to `audio_cb` → `StreamRouter::feed` (`managers/transcription.rs`) for live streaming transcription.
8. On shortcut release → `TranscribeAction::stop` → `AudioRecorder::stop` sends `Cmd::Stop`; the consumer drains remaining chunks through the same VAD gate, flushes the resampler (final frame zero-padded to 480 samples), and returns the VAD-filtered `processed_samples` to the transcription pipeline.

Timing consequence: with VAD enabled the returned buffer is wall-clock-compressed (silence removed), so its duration does not equal recording duration.

## Tauri commands and events

| Name                         | Direction                                                   | Payload                                                                                                                                                          | Where                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `change_vad_enabled_setting` | frontend → rust command                                     | args `{ enabled: boolean }`, returns `Result<(), String>` (never errors in practice; writes the settings store)                                                  | `src-tauri/src/shortcut/mod.rs (change_vad_enabled_setting)`; invoked via `src/bindings.ts (changeVadEnabledSetting)` from `src/stores/settingsStore.ts`                                                                                                                                                                 |
| `get_app_settings`           | frontend → rust command                                     | returns full `AppSettings` including `vad_enabled`                                                                                                               | settings subsystem; how the toggle reads its value                                                                                                                                                                                                                                                                       |
| `mic-level`                  | rust → frontend event (`emit_to("recording_overlay", ...)`) | `f32[16]` spectrum buckets, ~24 Hz while the stream is open                                                                                                      | emitted by the recorder's level callback wired in `managers/audio.rs (create_audio_recorder)` → `overlay.rs (emit_levels)`. Computed on raw pre-VAD audio, so the overlay visualizer moves even for frames VAD later drops. Overlay subsystem detail; noted here because the callback lives on the same consumer thread. |
| `recording-error`            | rust → frontend event                                       | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail?: string }`                                                              | `actions.rs (TranscribeAction::start)`; this is the only user-visible channel when recording start fails, including "Recorder not available" caused by a VAD preload failure                                                                                                                                             |
| `settings-changed`           | rust → frontend event                                       | emitted by several settings commands in `shortcut/mod.rs` — **not** emitted by `change_vad_enabled_setting` (the frontend relies on its optimistic store update) | `src-tauri/src/shortcut/mod.rs`                                                                                                                                                                                                                                                                                          |

There are no VAD-specific events; VAD state (in-speech / dropped frames) is never surfaced to the UI.

## Settings keys

- `vad_enabled: bool` — default `true` (`src-tauri/src/settings.rs (default_vad_enabled)`). Written only by `change_vad_enabled_setting`. Read at each recording start in `actions.rs (TranscribeAction::start)`; changes take effect on the next recording with no restart.
- Indirectly relevant (other subsystems): `selected_model` (its `supports_streaming` flag decides Offline vs Streaming hangover), `always_on_microphone` (decides when `preload_vad`/stream open happen relative to the keypress).

There is no setting for the threshold, prefill, onset, or hangover values; all are compile-time constants.

## Platform-specific behavior

- The VAD code itself is platform-independent. The Silero session always runs on CPU (`vad-rs` builds a plain `ort` session with 1 intra + 1 inter thread); the app's `ort_accelerator` / `transcribe_accelerator` settings do not affect it.
- macOS: the model resolves through `BaseDirectory::Resource` into the app bundle's `Resources/resources/models/` (bundled via `"resources": ["resources/**/*"]` in `src-tauri/tauri.conf.json`). In dev it resolves into `src-tauri/resources/models/`. macOS-specific quirks in this area belong to the recorder (CoreAudio config fetch, `is_no_input_device_error` matching coreaudio strings, AppleScript mute in `managers/audio.rs (set_mute)`), not VAD.
- The dev CLI (`src-tauri/src/audio_toolkit/bin/cli.rs`) loads the model from the relative path `./resources/models/silero_vad_v4.onnx`, so it only works when run from `src-tauri/`.

## Fragile points and failure modes

1. **VAD inference errors are swallowed with zero logging.** `recorder.rs (handle_frame)` does `det.push_frame(samples).unwrap_or(VadFrame::Speech(samples))`. Fail-open is the right call (audio is never lost), but if the ONNX session errors on every frame, VAD is silently effectively disabled: no log line, no event, no UI hint. Anyone debugging "why is silence in my transcript" gets nothing.
2. **Background preload failure is only `debug!`-logged.** `actions.rs (TranscribeAction::start)` logs `"VAD pre-load failed: {e}"` at debug level. Recovery depends on mode:
   - On-demand mode: `try_start_recording` → `start_microphone_stream` → `preload_vad()?` retries and surfaces the error via the `recording-error` event (`error_type` likely `"unknown"` for a missing model — the message won't match the permission/no-device matchers).
   - Always-on mode: `try_start_recording` skips `start_microphone_stream` (the stream is presumed open), so if the recorder was never created (model missing at boot) the user gets a bare `"Recorder not available"` in `recording-error.detail` with `error_type: "unknown"` — no mention of the actual cause.
3. **Hangover/prefill overlap can duplicate audio around medium pauses.** After speech ends, the 15 hangover frames are emitted; the prefill ring buffer (`smoothed.rs`) keeps buffering those same frames. If speech resumes after roughly 16–29 frames of silence (~0.5–0.9 s), the onset re-trigger re-emits up to ~13 frames (~390 ms) that were already emitted during the hangover, so the transcription buffer contains a short duplicated stretch. Usually inaudible in a transcript but a real correctness wart if audio is ever persisted or aligned.
4. **Constant coupling: `VAD_ONSET_FRAMES` must stay ≤ `VAD_PREFILL_FRAMES`.** Onset frames are reported as `Noise` and only recovered from the prefill buffer; raising onset above prefill+1 would silently drop the start of every utterance. Nothing enforces this.
5. **Threshold drift between app and CLI.** App uses `VAD_THRESHOLD = 0.3` (`managers/audio.rs`); the CLI hardcodes `0.5` (`audio_toolkit/bin/cli.rs`). Tuning experiments in the CLI will not reproduce app behavior.
6. **Frame-size invariant lives two modules away.** `SileroVad::push_frame` hard-errors on anything but 480 samples; correctness depends on `FrameResampler` always emitting exact frames (it does, zero-padding the final frame in `finish`). If a future caller feeds frames directly, the error path funnels into fragile point 1 (silent fail-open).
7. **Detector is shared state under a mutex across sessions.** One `SmoothedVad`+`SileroVad` instance lives for the app's lifetime inside `VadConfig` (`Arc<Mutex<...>>`). State hygiene relies entirely on `Cmd::Start` calling `reset()` — and that reset is skipped when the session policy is `Disabled`, leaving stale LSTM/smoothing state until the next enabled session resets it (harmless today, a trap if reset ordering changes).
8. **Zero-padded flush frames pass through VAD.** `FrameResampler::finish` pads the final partial frame with zeros; during a hangover tail this near-silent frame is still emitted into the transcript audio (negligible, but it means the last frame of a recording can be partially synthetic silence).
9. **VAD-compressed timeline.** `processed_samples` has silence removed, so any downstream logic that treats buffer length as elapsed time (duration display, billing, alignment with recordings history) will under-report with VAD enabled.
10. **The settings toggle trusts the optimistic update.** `change_vad_enabled_setting` does not emit `settings-changed`; other webviews/windows reading settings would not learn of the change until their next `get_app_settings`.
