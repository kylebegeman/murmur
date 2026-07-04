# Audio Capture & Devices Subsystem

Status: architecture map of the existing Handy code (pre-Murmur changes). Verified against source on 2026-07-04.

## Purpose

This subsystem owns the microphone: opening/closing the cpal input stream, selecting the input device (including the macOS clamshell-mode override), converting whatever the hardware delivers into 16 kHz mono f32 suitable for Whisper, gating audio through VAD, feeding live frames to the streaming transcriber, driving the overlay waveform with FFT level buckets, and optionally muting system output while recording. It exposes the recording lifecycle (`try_start_recording` / `stop_recording` / `cancel_recording`) that the shortcut/action layer drives, plus a set of Tauri commands for device pickers in the settings UI.

## Key Files

| File | Role |
| --- | --- |
| `src-tauri/src/managers/audio.rs` | `AudioRecordingManager`: recording state machine, mic stream lifecycle, always-on vs on-demand mode, device resolution + caching, mute-while-recording, lazy stream close, cancel generations. |
| `src-tauri/src/audio_toolkit/audio/recorder.rs` | `AudioRecorder`: cpal stream construction, worker + consumer threads, command channel (`Start`/`Stop`/`Shutdown`), per-session VAD policy, config caching, error classification helpers. |
| `src-tauri/src/audio_toolkit/audio/device.rs` | `list_input_devices` / `list_output_devices` enumeration over the cpal host, marking the default device. |
| `src-tauri/src/audio_toolkit/audio/resampler.rs` | `FrameResampler`: native-rate → 16 kHz via rubato `FftFixedIn`, re-framed into fixed 30 ms (480-sample) frames. |
| `src-tauri/src/audio_toolkit/audio/visualizer.rs` | `AudioVisualiser`: FFT → 16 log-spaced vocal-band (400–4000 Hz) level buckets in 0..1 for the overlay waveform. |
| `src-tauri/src/audio_toolkit/audio/utils.rs` | WAV helpers: `read_wav_samples`, `save_wav_file` (16 kHz mono i16), `verify_wav_file`. |
| `src-tauri/src/audio_toolkit/utils.rs` | `get_cpal_host`: forces ALSA on Linux, default host elsewhere (CoreAudio on macOS, WASAPI on Windows). |
| `src-tauri/src/audio_toolkit/constants.rs` | `WHISPER_SAMPLE_RATE: u32 = 16000`. (Duplicated as a local `usize` const in `managers/audio.rs`.) |
| `src-tauri/src/helpers/clamshell.rs` | macOS `is_clamshell()` (ioreg `AppleClamshellState`) and Tauri command `is_laptop` (pmset battery probe). Non-macOS stubs return `false`. |
| `src-tauri/src/commands/audio.rs` | All device/mode Tauri commands, Windows mic-permission registry probe, output-device selection, test sounds. |
| `src-tauri/src/audio_toolkit/bin/cli.rs` | Standalone CLI harness exercising `AudioRecorder` + VAD outside the app (dev tool, not shipped in the app flow). |

Adjacent (one hop, other subsystems): `src-tauri/src/actions.rs` (`TranscribeAction` drives start/stop), `src-tauri/src/overlay.rs` (`emit_levels`, overlay windows), `src-tauri/src/managers/transcription.rs` (`StreamRouter::feed`), `src-tauri/src/audio_feedback.rs` (start/stop sounds), `src-tauri/src/audio_toolkit/vad/` (Silero VAD), `src-tauri/src/lib.rs` (`initialize_core_logic` wiring), `src-tauri/src/utils.rs` (`cancel_current_operation`).

## Key Types & Functions

### `src-tauri/src/managers/audio.rs`

- `AudioRecordingManager` — cloneable handle over `Arc<Mutex<..>>` state:
  - `state: RecordingState` (`Idle` | `Recording { binding_id }` | `Stopping`)
  - `mode: MicrophoneMode` (`AlwaysOn` | `OnDemand`)
  - `recorder: Option<AudioRecorder>` (lazily built by `preload_vad`)
  - `is_open`, `is_recording`, `did_mute` flags
  - `close_generation: AtomicU64` (invalidates pending lazy closes), `cancel_generation: AtomicU64` (invalidates in-flight stops)
  - `cached_device: Option<(String, cpal::Device)>` — name-keyed device resolution cache (system default is never cached)
- `AudioRecordingManager::new` (managers/audio.rs) — reads settings, sets mode; in always-on mode opens the mic stream immediately at app startup.
- `desired_device_name` — clamshell override: if `clamshell_microphone` is set AND `clamshell::is_clamshell()` returns true, use it; else `selected_microphone`; `None` means system default.
- `get_effective_microphone_device` — cache-checked name→`cpal::Device` resolution via `list_input_devices()`; enumeration failure or name-not-found silently yields `None` (= system default).
- `start_microphone_stream` — resolves device, `preload_vad()`, `recorder.open(device)`; on first open failure invalidates the device cache, re-resolves fresh, retries once, then surfaces the error.
- `stop_microphone_stream` — unmutes if muted, stops any active recording, closes the recorder. Does not take the `state` lock (relied on by `schedule_lazy_close`).
- `schedule_lazy_close` — spawns a thread that sleeps `STREAM_IDLE_TIMEOUT` (30 s) and closes the stream if the close generation is unchanged and state is `Idle`; holds the state lock across check+close to avoid racing a new recording.
- `update_mode` — transitions AlwaysOn↔OnDemand, opening or closing the stream accordingly (won't close mid-recording).
- `try_start_recording(binding_id, vad_policy)` — Idle→Recording; in on-demand mode bumps `close_generation` and opens the stream first; calls `AudioRecorder::start`.
- `stop_recording(binding_id, cancel_generation)` — Recording→Stopping; optionally sleeps `extra_recording_buffer_ms` (interruptible in 25 ms slices by cancel); `recorder.stop()` returns the samples; back to Idle; in on-demand mode closes the stream (lazily if `lazy_stream_close`); returns `None` if cancelled meanwhile; pads recordings shorter than 1 s with zeros to 1.25 s (20 000 samples).
- `cancel_recording` — bumps `cancel_generation`, discards samples, closes stream per mode. No-op logging if already `Stopping`.
- `apply_mute` / `remove_mute` — system-output mute via `set_mute` when `mute_while_recording` is on and the stream is open; `did_mute` remembers whether we muted.
- `set_mute(bool)` (free fn) — Windows: WASAPI `IAudioEndpointVolume::SetMute` on the default render endpoint; Linux: tries `wpctl`, then `pactl`, then `amixer`; macOS: `osascript -e 'set volume output muted true/false'`. All paths fail silently by design.
- `create_audio_recorder` — builds `AudioRecorder` with a `SmoothedVad(SileroVad)` (threshold 0.3 — `VAD_THRESHOLD` in `src-tauri/src/managers/audio.rs:21`; prefill 15 frames, offline hangover 15, onset 2; streaming hangover 55 — frame constants in `src-tauri/src/audio_toolkit/vad/mod.rs:3-6`), a level callback forwarding to `utils::emit_levels` (re-export of `overlay::emit_levels`), and an audio-frame callback into `StreamRouter::feed`.
- `update_selected_device` — invalidates the device cache; if the stream is open, stop+start to pick up the new device.
- `invalidate_device_cache`, `preload_vad` (resolves `resources/models/silero_vad_v4.onnx` from Tauri resources), `is_recording`, `cancel_generation`, `was_cancelled_since`.

### `src-tauri/src/audio_toolkit/audio/recorder.rs`

- `VadPolicy` — `Disabled` | `Offline` | `Streaming` (chosen per session in `actions.rs` from `vad_enabled` + model streaming capability).
- `AudioRecorder::open(Option<Device>)` — `None` means "resolve the host default now". Spawns a worker thread that: fetches the stream config (name-keyed `config_cache`, else `get_preferred_config`), builds the input stream for the sample format (U8/I8/I16/I32/F32; anything else → error), calls `stream.play()`, reports success/failure over a sync init channel, then runs `run_consumer` until shutdown. `open` blocks on the init handshake; on error maps "access is denied"-style messages to `ErrorKind::PermissionDenied` via `is_microphone_access_denied`.
- `get_preferred_config` — uses the device's default (native) sample rate; never forces 16 kHz on hardware. Among supported configs matching that rate, prefers F32 > I16 > I32 > others; falls back to the default config with a `warn!` if enumeration fails or nothing matches.
- `build_stream::<T>` — cpal input callback: converts to f32, mixes channels down to mono by averaging, sends `AudioChunk::Samples` over an mpsc channel. When `stop_flag` is set it sends one `AudioChunk::EndOfStream` sentinel and goes silent. Stream errors are only logged (`log::error!("Stream error: ...")`).
- `run_consumer` — the consumer loop (same worker thread):
  1. `FrameResampler::new(native_rate, 16000, 30ms)`.
  2. `AudioVisualiser` window size scaled to the device rate (`rate/30` snapped to 256/512/1024/2048) so the analysis window stays ~33 ms across devices.
  3. On each received chunk: first drain pending commands (so `Cmd::Start` captures the in-flight chunk — ordering fix to avoid dropping a buffer period at start):
     - `Cmd::Start(policy, sent_at)`: clear buffers, reset visualizer, reconfigure the single VAD engine's hangover for the policy (`set_hangover_frames` + `reset`), set `recording = true`.
     - `Cmd::Stop(reply_tx)`: stop recording, set `stop_flag`, feed the in-hand chunk, drain the channel until `EndOfStream` (2 s `recv_timeout`, `warn!` on timeout), `frame_resampler.finish()`, reply with the accumulated samples, clear `stop_flag` so always-on mode keeps flowing.
     - `Cmd::Shutdown`: set `stop_flag` and return (ends the worker; `close()` joins it).
  4. Feed raw chunk to the visualizer → `level_cb(Vec<f32>)` (~24 Hz).
  5. Feed raw chunk to the resampler → 30 ms 16 kHz frames → `handle_frame`: when recording, either bypass VAD (`Disabled`) or push through the VAD; `Speech` frames are appended to `processed_samples` and forwarded to `audio_cb` (StreamRouter). VAD errors default to treating the frame as speech (`unwrap_or(VadFrame::Speech)`).
- `is_microphone_access_denied(&str)`, `is_no_input_device_error(&str)` — string-heuristic error classifiers used by `actions.rs` to pick the `recording-error` type. The no-device heuristic also matches "failed to fetch preferred config" + "coreaudio" (macOS machines with zero input devices).

### `src-tauri/src/audio_toolkit/audio/resampler.rs`

- `FrameResampler` — buffers input into fixed 1024-sample chunks for rubato `FftFixedIn` (only instantiated when in_hz != out_hz; a native-16 kHz device skips resampling entirely), then re-frames output into exact 480-sample (30 ms) frames. `finish()` zero-pads the last partial chunk and pending frame, and clears `in_buf` so the padded tail can't leak into the next session (regression-tested in the same file).

### `src-tauri/src/audio_toolkit/audio/visualizer.rs`

- `AudioVisualiser::feed` — accumulates samples until `window_size`, DC-removes, Hann-windows, FFTs, averages power into 16 log-spaced buckets between 400–4000 Hz, converts to dB, normalizes -55..-8 dB to 0..1 with gain 1.3 and curve 0.7, neighbor-smooths, clears the buffer (dropping any overshoot samples), returns `Some(Vec<f32>)` of length 16. Maintains a slowly-adapting per-bucket noise floor (currently computed but not subtracted). `reset()` clears the buffer and noise floor per session.

### `src-tauri/src/helpers/clamshell.rs`

- `is_clamshell()` — macOS: `ioreg -r -k AppleClamshellState -d 4`, true iff output contains `"AppleClamshellState" = Yes`. ~10-20 ms subprocess; only invoked when `clamshell_microphone` is configured.
- `is_laptop` (Tauri command) — macOS: `pmset -g batt` contains `InternalBattery`. Both stubbed to `false` off-macOS.

## Runtime Flow

### Recording start (hotkey pressed → `actions.rs (TranscribeAction::start)`)

1. Model load and `preload_vad` kick off in parallel threads; tray icon switches to Recording; overlay shows (style depends on `overlay_style` + model streaming capability).
2. `vad_policy` chosen: `Disabled` if `vad_enabled` is false, else `Streaming` if the selected model advertises streaming, else `Offline`.
3. `AudioRecordingManager::try_start_recording(binding_id, policy)`:
   - On-demand mode: bump `close_generation` (cancels pending lazy close), `start_microphone_stream()` → `desired_device_name` (clamshell probe only if configured) → `get_effective_microphone_device` (cache or enumerate) → `preload_vad` → `AudioRecorder::open` (retry once with fresh enumeration on failure). Always-on mode: stream is already open.
   - `AudioRecorder::start(policy)` sends `Cmd::Start`; the consumer begins capturing with the in-flight chunk.
4. Start feedback sound plays, then `apply_mute()` mutes system output if `mute_while_recording` (ordering differs: always-on plays sound immediately; on-demand starts capture first, waits 100 ms, then sound + mute).
5. On failure, UI is reverted and a `recording-error` event is emitted (see Events).

### While recording

- cpal callback (real-time thread) → mono f32 chunks → mpsc → consumer thread: visualizer buckets → `overlay::emit_levels` → `mic-level` event → overlay waveform; resampled 30 ms 16 kHz frames → VAD → `processed_samples` + `StreamRouter::feed` (live streaming transcription).

### Recording stop (hotkey released → `actions.rs (TranscribeAction::stop)`)

1. `remove_mute()` (so the stop sound is audible), stop sound plays, overlay switches to transcribing.
2. Async task: `stop_recording(binding_id, cancel_generation)` → optional `extra_recording_buffer_ms` sleep → `AudioRecorder::stop()` (Cmd::Stop, drain to EndOfStream, resampler flush) → samples returned; short recordings zero-padded to 1.25 s.
3. On-demand mode: stream closes immediately, or after 30 s idle if `lazy_stream_close`.
4. Samples go to WAV persistence + transcription (other subsystems).

### Cancel (`utils.rs (cancel_current_operation)`)

`cancel_recording()` bumps `cancel_generation` (aborts extra-buffer sleeps and discards in-flight stops), discards samples, closes the stream per mode; the transcription stream and overlay are torn down by the caller.

### Device / mode changes

- `set_selected_microphone` / settings change → `update_selected_device()` → cache invalidation + stream restart if open.
- `update_microphone_mode` → `update_mode()` opens (AlwaysOn) or closes (OnDemand, if idle) the stream and persists `always_on_microphone`.

## Tauri Commands (frontend → rust, all in `src-tauri/src/commands/audio.rs` unless noted; registered in `src-tauri/src/lib.rs`, typed via specta in `src/bindings.ts`)

| Command | Payload → Result | Notes |
| --- | --- | --- |
| `update_microphone_mode` | `{ alwaysOn: bool }` → `Result<(), String>` | Writes `always_on_microphone`, calls `update_mode`. |
| `get_microphone_mode` | `()` → `Result<bool, String>` | Reads `always_on_microphone`. |
| `get_available_microphones` | `()` → `Result<AudioDevice[], String>` | `AudioDevice { index, name, is_default }`; prepends a synthetic `{"default", "Default", true}` entry; real devices are marked `is_default: false`. |
| `set_selected_microphone` | `{ deviceName: string }` → `Result<(), String>` | `"default"` → `None`; restarts stream if open. |
| `get_selected_microphone` | `()` → `Result<String, String>` | `None` → `"default"`. |
| `get_available_output_devices` / `set_selected_output_device` / `get_selected_output_device` | same shapes | Output device is only persisted here; consumed by `audio_feedback.rs`. |
| `set_clamshell_microphone` / `get_clamshell_microphone` | `{ deviceName }` / `()` → String | macOS clamshell override; UI (`src/components/settings/ClamshellMicrophoneSelector.tsx`) shows it only when `is_laptop` is true. |
| `is_recording` | `()` → `bool` | Wraps `AudioRecordingManager::is_recording`. |
| `get_windows_microphone_permission_status` | `()` → `WindowsMicrophonePermissionStatus { supported, overall_access, device_access, app_access, desktop_app_access }` (`allowed`/`denied`/`unknown`) | Registry probe of `CapabilityAccessManager\ConsentStore\microphone`; `supported: false` off-Windows. |
| `open_microphone_privacy_settings` | `()` → `Result<(), String>` | Windows-only `ms-settings:privacy-microphone`; errors elsewhere. |
| `play_test_sound` | `{ soundType: "start" \| "stop" }` → `()` | Delegates to `audio_feedback`; unknown types just `warn!`. |
| `check_custom_sounds` | `()` → `CustomSounds { start, stop }` | Checks for `custom_start.wav` / `custom_stop.wav` in app data. |
| `is_laptop` (`src-tauri/src/helpers/clamshell.rs`) | `()` → `Result<bool, String>` | macOS `pmset` battery probe; false elsewhere. |

## Events (rust → frontend)

| Event | Emitter | Payload | Consumer |
| --- | --- | --- | --- |
| `mic-level` | `overlay.rs (emit_levels)`, called from the recorder's level callback (~24 Hz while the stream is open) via `emit_to("recording_overlay", ...)` — targeted at the overlay window only | `number[]` — 16 floats 0..1 | `src/overlay/RecordingOverlay.tsx` — exponential smoothing then first N bars of the waveform. Gated by the `OVERLAY_ENABLED` atomic cache (synced from `overlay_style`) to avoid unbounded WebKit allocation on a hidden overlay (issue #1279). |
| `recording-error` | `actions.rs (TranscribeAction::start)` when `try_start_recording` fails | `{ error_type: "microphone_permission_denied" \| "no_input_device" \| "unknown", detail?: string }` | `src/App.tsx` — localized toast. |

Related overlay events (`show-overlay`, `hide-overlay`, stream text/phase) belong to the overlay/transcription subsystems.

## Settings Keys (single `settings` object in `settings_store.json`, `src-tauri/src/settings.rs`)

- `always_on_microphone` (bool, default false) — read at manager construction, `TranscribeAction::start`, mode commands.
- `selected_microphone` (`string | null`, null = system default).
- `clamshell_microphone` (`string | null`) — macOS lid-closed override.
- `selected_output_device` (`string | null`) — written here, read by audio feedback.
- `mute_while_recording` (bool, default false) — `apply_mute`.
- `lazy_stream_close` (bool, default false, experimental) — 30 s idle close instead of immediate.
- `extra_recording_buffer_ms` (u64, default 0) — post-release capture tail.
- `vad_enabled` (bool) — read in `actions.rs` to choose `VadPolicy` (VAD subsystem boundary).
- `overlay_style` — indirectly gates `mic-level` emission via the `OVERLAY_ENABLED` cache (overlay subsystem).

## Platform-Specific Behavior

### macOS

- Host: cpal default (CoreAudio). Mic permission (TCC) prompt is triggered by the first stream open; denial surfaces as an open error classified by `is_microphone_access_denied`; a Mac with no input devices manifests as a coreaudio "fetch preferred config" error, matched by `is_no_input_device_error`.
- Clamshell: `ioreg` subprocess per recording start (only when `clamshell_microphone` is set); `is_laptop` uses `pmset`.
- Mute: `osascript "set volume output muted ..."` mutes SYSTEM OUTPUT (speakers), not the app or the mic.
- Accessory/dock policy and overlay windows are handled elsewhere (`lib.rs`, `overlay.rs`).

### Windows

- Mute via WASAPI `IAudioEndpointVolume` on the default render endpoint (COM, `CoInitializeEx` tolerated as already-initialized; every failure silently returns).
- Mic permission is read from the registry (no runtime prompt API); `open_microphone_privacy_settings` deep-links Settings.

### Linux

- `get_cpal_host` forces ALSA (falls back to default host if unavailable).
- Mute tries `wpctl` → `pactl` → `amixer`; missing tools fail silently.
- Overlay defaults to `none` on Linux, so `mic-level` is typically never emitted.

## Fragile Points & Failure Modes

1. Silent fallback to the default mic: if the configured device name isn't found (unplugged, renamed) or enumeration fails, `get_effective_microphone_device` (managers/audio.rs) returns `None` and recording proceeds on the system default with only a `debug!` log. The user gets no indication their chosen mic wasn't used.
2. `set_mute` is fire-and-forget on every platform (documented as such). If it fails, `did_mute` is still set true; the later unmute is also best-effort. If the app crashes or is killed while muted, system output stays muted with no recovery path.
3. macOS mute semantics: it mutes system OUTPUT volume globally, including other apps' audio. `remove_mute` unconditionally unmutes if `did_mute`, which can also unmute audio the user had muted themselves before recording.
4. `AudioRecorder::stop` blocks forever if the stream dies: `stop()` does `resp_rx.recv()` with no timeout, and the consumer only processes commands when a chunk arrives. If the cpal stream silently stops delivering (device unplugged mid-recording, host suspend — the stream error callback only logs), `Cmd::Stop` is never seen and the caller hangs while holding the `recorder` mutex, wedging the whole audio manager.
5. Recorder errors are flattened: in `try_start_recording`, a failed `rec.start(...)` is collapsed by `.is_ok()` into the generic `"Recorder not available"` message; in `stop_recording`, a failed `rec.stop()` yields an empty `Vec` with only an `error!` log — downstream treats it as "no audio" and quietly resets the UI.
6. Error classification is string matching: `is_microphone_access_denied` / `is_no_input_device_error` (recorder.rs) match substrings of cpal/coreaudio error text. A wording change in cpal or the OS locale-independent-but-fragile strings will misclassify errors into the generic toast.
7. EndOfStream drain timeout: on stop, the consumer waits up to 2 s for the sentinel; on timeout it `warn!`s and proceeds, potentially truncating the tail of the recording with no user feedback.
8. Zero-padding surprises: recordings under 1 s are padded with silence to 1.25 s (`stop_recording`), and the resampler `finish()` pads partial frames with zeros — downstream consumers see synthetic silence appended to real audio.
9. VAD failures default-open: `handle_frame` treats a VAD `push_frame` error as speech, so a broken ONNX session silently degrades to "no filtering" rather than failing.
10. `mic-level` depends on the `OVERLAY_ENABLED` cache (overlay.rs): it defaults to false until `lib.rs` setup populates it, and must be kept in sync by `change_overlay_style_setting`; a missed sync silently kills the waveform (events are also only delivered to the `recording_overlay` window, so no other view can reuse them as-is).
11. Stale caches self-heal only via the retry-once path: both the manager's `cached_device` and the recorder's `config_cache` can go stale (unplug/replug, sample-rate change); `start_microphone_stream` invalidates and retries once, but a failure of the retry surfaces as a start error attributed to whatever the second attempt hit.
12. Clamshell probe errors are swallowed: `is_clamshell().unwrap_or(false)` means an `ioreg` failure silently disables the clamshell mic override.
13. Lazy close threads are unbounded: every stop/cancel with `lazy_stream_close` spawns a 30 s sleeper thread; generation counters make them no-ops but they still accumulate under rapid use.
14. Mode/state races are mostly serialized through the `state` mutex, but `stop_microphone_stream` deliberately does not take it; correctness relies on callers (lazy close holds `state`; `update_mode` checks Idle first). New call sites must preserve that discipline.
15. `FrameResampler::new` uses `expect` on rubato construction — a pathological sample rate would panic the worker thread; subsequent `start`/`stop` calls then error out via closed channels rather than reporting the root cause.
16. Duplicate constant: `WHISPER_SAMPLE_RATE` exists in `audio_toolkit/constants.rs` (u32) and again as a local const in `managers/audio.rs` (usize) — keep them in sync if the pipeline rate ever changes.

## Cross-Subsystem Interfaces

- **Shortcut/actions**: `actions.rs (TranscribeAction::start/stop)` is the only production driver of `try_start_recording`/`stop_recording`; `shortcut/handy_keys.rs` and `utils.rs (cancel_current_operation)` trigger stop/cancel paths.
- **Transcription**: 16 kHz post-VAD frames flow into `managers/transcription.rs (StreamRouter::feed)` for live streaming; final samples go to `TranscriptionManager` via `actions.rs`. `StreamRouter` is passed into `AudioRecordingManager::new` in `lib.rs (initialize_core_logic)` explicitly (not via Tauri state) so always-on startup works before state is managed.
- **Overlay**: level buckets → `overlay.rs (emit_levels)` → `mic-level` on the `recording_overlay` window; overlay show/hide is driven from `actions.rs`.
- **Audio feedback**: start/stop sounds (`audio_feedback.rs`) are sequenced around `apply_mute` so mute never silences the feedback sound; it consumes `selected_output_device`.
- **History**: final samples saved with `audio_toolkit::save_wav_file` into the history recordings dir (`actions.rs`).
- **VAD**: `SileroVad`/`SmoothedVad` and the `VAD_*_FRAMES` constants live in `src-tauri/src/audio_toolkit/vad/` (separate subsystem; the recorder only holds a `Box<dyn VoiceActivityDetector>`).
