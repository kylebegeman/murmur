# Post-Processing & LLM Cleanup Subsystem

Status: architecture map of the existing Handy code (pre-Murmur changes).
Scope: LLM API client, Apple Intelligence bridge, prompt management, where
post-processing hooks into the transcription pipeline, and the settings UI
that configures it. Murmur "cleanup presets" will extend this subsystem.

All paths are relative to the repo root (`/Users/kyle/Developer/products/murmur-new`).

---

## 1. Purpose

After speech-to-text produces a raw transcript, the app can optionally send
that transcript to an LLM ("post-processing") to clean it up: fix punctuation,
convert number words to digits, strip filler words, etc. The user picks a
provider (OpenAI, OpenRouter, Anthropic, Groq, Cerebras, Z.AI, AWS Bedrock via
Mantle, Apple Intelligence on Apple silicon, or a Custom OpenAI-compatible
endpoint), a model, and one of several editable prompt templates.

Post-processing is **per-invocation**, not per-setting: there are two separate
transcribe shortcuts. The plain `transcribe` binding never post-processes; the
`transcribe_with_post_process` binding always attempts it (when configured).
The `post_process_enabled` setting only controls whether the second shortcut
is registered and whether the Post-Processing page appears in the sidebar.

Design stance of the current code: post-processing is **best-effort and
silent**. Every configuration or API failure degrades to "paste the raw
transcript" with only a log line. There is no user-facing error for a failed
LLM call.

---

## 2. Key Files

### Rust backend (`src-tauri/src/`)

| File                                                                               | Role                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src-tauri/src/llm_client.rs`                                                      | Minimal OpenAI-compatible HTTP client (chat completions + model listing) built on `reqwest`. Provider-agnostic except for Anthropic auth headers.                                                                                    |
| `src-tauri/src/apple_intelligence.rs`                                              | Safe Rust wrappers over a C FFI bridge into Swift `FoundationModels` (on-device Apple Intelligence).                                                                                                                                 |
| `src-tauri/swift/apple_intelligence.swift`                                         | Real Swift implementation (`@_cdecl` exports) using `SystemLanguageModel` / `LanguageModelSession`; requires macOS 26 SDK with `FoundationModels`.                                                                                   |
| `src-tauri/swift/apple_intelligence_stub.swift`                                    | Stub compiled when the build SDK lacks `FoundationModels`; availability always returns 0, processing always errors.                                                                                                                  |
| `src-tauri/swift/apple_intelligence_bridge.h`                                      | C header defining `AppleLLMResponse` for the FFI boundary.                                                                                                                                                                           |
| `src-tauri/build.rs` (`build_apple_intelligence_bridge`)                           | Compiles real-or-stub Swift into `libapple_intelligence.a` and links it. Only runs on `target_os = "macos"` + `target_arch = "aarch64"`.                                                                                             |
| `src-tauri/src/actions.rs`                                                         | **The pipeline hook.** `TranscribeAction { post_process: bool }` drives record→transcribe→post-process→paste. Contains `post_process_transcription`, `process_transcription_output`, `build_system_prompt`, `strip_invisible_chars`. |
| `src-tauri/src/settings.rs`                                                        | `PostProcessProvider`, `LLMPrompt`, `SecretMap`, all `post_process_*` settings fields, provider defaults, `ensure_post_process_defaults` migration.                                                                                  |
| `src-tauri/src/shortcut/mod.rs`                                                    | All post-process Tauri commands (enable toggle, provider/base-url/api-key/model setters, prompt CRUD, model fetch), plus registration gating of the `transcribe_with_post_process` shortcut.                                         |
| `src-tauri/src/commands/mod.rs`                                                    | `check_apple_intelligence_available` command; `get_app_settings` (returns full settings incl. API keys to the frontend).                                                                                                             |
| `src-tauri/src/commands/history.rs`                                                | `retry_history_entry_transcription` re-runs `process_transcription_output` honoring the entry's original `post_process_requested` flag.                                                                                              |
| `src-tauri/src/transcription_coordinator.rs`                                       | Serializes shortcut/CLI/signal inputs; routes binding ids (`transcribe`, `transcribe_with_post_process`) to `ACTION_MAP`.                                                                                                            |
| `src-tauri/src/cli.rs` + `src-tauri/src/lib.rs` + `src-tauri/src/signal_handle.rs` | External triggers: `--toggle-post-process` CLI flag (via single-instance plugin) and `SIGUSR1` both inject the `transcribe_with_post_process` binding.                                                                               |
| `src-tauri/src/managers/history.rs`                                                | Persists `post_processed_text`, `post_process_prompt`, `post_process_requested` columns on `transcription_history` (SQLite migrations at lines 31–33).                                                                               |
| `src-tauri/src/tray.rs` (`last_transcript_text`)                                   | Tray "recent transcript" menu prefers `post_processed_text` over raw text.                                                                                                                                                           |

### Frontend (`src/`)

| File                                                                               | Role                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/settings/post-processing/PostProcessingSettings.tsx`               | The whole Post-Processing settings page: shortcut input, API section (`PostProcessingSettingsApiComponent`), and prompt management (`PostProcessingSettingsPromptsComponent`). Exports `PostProcessingSettings`, `PostProcessingSettingsApi`, `PostProcessingSettingsPrompts`. |
| `src/components/settings/PostProcessingSettingsApi/usePostProcessProviderState.ts` | Hook holding all provider/API-key/model UI state and handlers; Apple Intelligence availability check on provider select; auto model refetch.                                                                                                                                   |
| `src/components/settings/PostProcessingSettingsApi/ProviderSelect.tsx`             | Provider dropdown (memoized `Dropdown`).                                                                                                                                                                                                                                       |
| `src/components/settings/PostProcessingSettingsApi/BaseUrlField.tsx`               | Base URL input (only editable for `custom` provider), commit on blur.                                                                                                                                                                                                          |
| `src/components/settings/PostProcessingSettingsApi/ApiKeyField.tsx`                | Password-type input for API key, commit on blur.                                                                                                                                                                                                                               |
| `src/components/settings/PostProcessingSettingsApi/ModelSelect.tsx`                | Creatable select for model id ("Use \"...\"" free entry).                                                                                                                                                                                                                      |
| `src/components/settings/PostProcessingSettingsApi/types.ts`                       | `ModelOption` type.                                                                                                                                                                                                                                                            |
| `src/components/settings/PostProcessingSettingsApi/index.tsx`                      | Re-export of `PostProcessingSettingsApi` from the page file.                                                                                                                                                                                                                   |
| `src/components/settings/PostProcessingToggle.tsx`                                 | The `post_process_enabled` toggle; mounted on the **Advanced** settings page (`src/components/settings/advanced/AdvancedSettings.tsx`).                                                                                                                                        |
| `src/components/settings/PostProcessingSettingsPrompts.tsx`                        | Re-export shim for the prompts component.                                                                                                                                                                                                                                      |
| `src/components/Sidebar.tsx`                                                       | Nav entry `postprocessing` gated by `enabled: (settings) => settings?.post_process_enabled ?? false`.                                                                                                                                                                          |
| `src/stores/settingsStore.ts`                                                      | Zustand store: `settingUpdaters` maps `post_process_enabled` / `post_process_selected_prompt_id` to commands; optimistic `setPostProcessProvider`; `updatePostProcessSetting` (base_url/api_key/model); `fetchPostProcessModels`; `postProcessModelOptions` cache.             |
| `src/hooks/useSettings.ts`                                                         | Thin hook over the store exposing the post-process helpers.                                                                                                                                                                                                                    |
| `src/bindings.ts`                                                                  | Generated tauri-specta bindings (commands + event names).                                                                                                                                                                                                                      |

---

## 3. Key Types / Functions

### Rust

- `settings.rs (PostProcessProvider)` — `{ id, label, base_url, allow_base_url_edit, models_endpoint: Option<String>, supports_structured_output }`. Serialized into settings and to the frontend.
- `settings.rs (LLMPrompt)` — `{ id, name, prompt }`. Prompt text uses the `${output}` placeholder convention.
- `settings.rs (SecretMap)` — newtype over `HashMap<String, String>` for API keys. **Only redacts `Debug` output**; `Serialize` is `#[serde(transparent)]`, so keys are persisted in plaintext in `settings_store.json` and shipped to the frontend via `get_app_settings`.
- `settings.rs (default_post_process_providers)` — the built-in provider table (see section 7). Apple Intelligence is appended only under `cfg(target_os = "macos", target_arch = "aarch64")`.
- `settings.rs (ensure_post_process_defaults)` — idempotent migration run on **every settings read/load**: adds missing providers, syncs `supports_structured_output` to the hardcoded defaults (user edits to that flag get clobbered), seeds empty API-key/model map entries.
- `settings.rs (AppSettings::active_post_process_provider / post_process_provider / post_process_provider_mut)` — provider lookup helpers.
- `settings.rs` consts: `APPLE_INTELLIGENCE_PROVIDER_ID = "apple_intelligence"`, `APPLE_INTELLIGENCE_DEFAULT_MODEL_ID = "Apple Intelligence"`.
- `llm_client.rs (send_chat_completion_with_schema)` — POST `{base_url}/chat/completions` with optional system message, optional strict JSON-schema `response_format` (name `transcription_output`), optional `reasoning_effort` (OpenAI style) and `reasoning: ReasoningConfig` (OpenRouter style `{effort, exclude}`). Returns `Ok(Some(content))`, `Ok(None)` (no content in first choice) or `Err(String)`.
- `llm_client.rs (send_chat_completion)` — legacy path: same call, single user message, no schema.
- `llm_client.rs (fetch_models)` — GET `{base_url}/models`; parses OpenAI `{data:[{id}]}` shape (falls back to `name`) or a bare string array. Unrecognized shapes yield an **empty Vec, not an error**.
- `llm_client.rs (build_headers)` — Content-Type/Referer/User-Agent/X-Title always (Murmur branding, github.com/kylebegeman/murmur). Auth: `x-api-key` + `anthropic-version: 2023-06-01` when `provider.id == "anthropic"`, else `Authorization: Bearer`.
- `actions.rs (TranscribeAction)` — struct `{ post_process: bool }`; two instances registered in `ACTION_MAP`: `"transcribe"` (false) and `"transcribe_with_post_process"` (true).
- `actions.rs (process_transcription_output)` — shared post-transcription step (also used by history retry): OpenCC Chinese-variant conversion, then optional LLM post-processing; returns `ProcessedTranscription { final_text, post_processed_text, post_process_prompt }`.
- `actions.rs (post_process_transcription)` — the LLM gatekeeper + call (detailed flow in section 4). Returns `Option<String>`; `None` always means "use the raw transcript".
- `actions.rs (build_system_prompt)` — strips `${output}` from the prompt template to form the system message (structured-output mode sends the transcript as the user message instead).
- `actions.rs (strip_invisible_chars)` — removes ZWSP/ZWNJ/ZWJ/BOM characters some LLMs emit.
- `actions.rs (is_blank_transcription)` — whitespace-only guard so empty transcripts skip the LLM.
- `apple_intelligence.rs (check_apple_intelligence_availability)` — safe wrapper over `is_apple_intelligence_available()` FFI.
- `apple_intelligence.rs (process_text_with_system_prompt)` — CString marshalling, calls `process_text_with_system_prompt_apple(system, user, max_tokens)`, copies out response/error, frees via `free_apple_llm_response`. **Blocking** call.
- `swift/apple_intelligence.swift (processTextWithSystemPrompt)` — `LanguageModelSession(model:instructions:)`, first tries `@Generable CleanedTranscript` structured generation, falls back to plain `respond(to:)`; `maxTokens` is actually a **word-count truncation** (`truncatedText`), not a token limit; blocks the calling thread on a `DispatchSemaphore` until the detached Task completes.
- `transcription_coordinator.rs (TranscriptionCoordinator)` — single-threaded state machine (Idle/Recording/Processing); `is_transcribe_binding` recognizes both binding ids; `FinishGuard` in actions.rs returns the stage to Idle when the async pipeline drops.
- `shortcut/mod.rs (register_all_shortcuts_for_implementation)` — skips registering `transcribe_with_post_process` when `post_process_enabled` is false.
- `commands/history.rs (retry_history_entry_transcription)` — re-transcribes a saved WAV and re-runs `process_transcription_output(app, &transcription, entry.post_process_requested)`.

### Frontend

- `usePostProcessProviderState.ts (usePostProcessProviderState)` — resolves selected provider (falls back to first provider / `"openai"`), exposes handlers; on provider select: clears the Apple-unavailable alert, calls `commands.checkAppleIntelligenceAvailable()` for Apple (shows alert but **still selects the provider**), then auto-fetches models when configured (custom needs base URL, others need API key).
- `settingsStore.ts (setPostProcessProvider)` — optimistic update of `post_process_provider_id` with rollback on error; clears cached model options for the provider.
- `settingsStore.ts (updatePostProcessSetting)` — dispatches to `changePostProcessBaseUrlSetting` / `changePostProcessApiKeySetting` / `changePostProcessModelSetting` with per-provider updating keys (`post_process_api_key:{id}` etc.), then `refreshSettings()`.
- `settingsStore.ts (updatePostProcessBaseUrl)` — sets base URL **and clears the stored model** (`changePostProcessModelSetting(providerId, "")`) plus cached options, since models from the old endpoint are meaningless.
- `settingsStore.ts (fetchPostProcessModels)` — calls `fetchPostProcessModels` command, caches results in `postProcessModelOptions[providerId]`.
- `PostProcessingSettings.tsx (PostProcessingSettingsPromptsComponent)` — prompt CRUD UI; create/update/delete via commands then `refreshSettings()`; delete disabled when only one prompt remains (mirrors backend rule).

---

## 4. Runtime Flow (post-processed dictation, step by step)

1. **Trigger.** One of:
   - Global shortcut for binding `transcribe_with_post_process` (default `option+shift+space` on macOS, `ctrl+shift+space` Windows/Linux; only registered while `post_process_enabled` is true — `shortcut/mod.rs (register_all_shortcuts_for_implementation)`).
   - CLI: `handy --toggle-post-process` forwarded by `tauri_plugin_single_instance` in `lib.rs` → `signal_handle::send_transcription_input(app, "transcribe_with_post_process", "CLI")`.
   - Unix signal `SIGUSR1` (`signal_handle.rs (setup_signal_handler)`).
     All converge on `TranscriptionCoordinator::send_input`, which serializes to `ACTION_MAP["transcribe_with_post_process"]` = `TranscribeAction { post_process: true }`. Note: CLI/signal triggers are **not** gated by `post_process_enabled`; they work even when the setting (and shortcut) is off.
2. **Record.** `actions.rs (TranscribeAction::start)` — identical for both variants (model preload, VAD, overlay, tray icon). `post_process` plays no role until stop.
3. **Stop & transcribe.** `actions.rs (TranscribeAction::stop)` spawns the async pipeline: stop recording → save WAV concurrently → `TranscriptionManager::finalize_stream()` or batch `transcribe(samples)`.
4. **Working overlay.** If `post_process` is true: `Live` overlay gets `tm.emit_stream_working(StreamWorkKind::Polishing)` (event `stream-phase-event`, payload `{phase:"working", kind:"polishing"}`); otherwise `utils::show_processing_overlay`.
5. **`process_transcription_output(app, &transcription, post_process)`** (`actions.rs`):
   1. Re-reads settings fresh from the store.
   2. `resolve_effective_language` + `maybe_convert_chinese_variant` — OpenCC zh-Hans/zh-Hant conversion (independent of LLM post-processing; runs for both shortcut variants).
   3. If `post_process`: `post_process_transcription(&settings, &final_text)`.
6. **`post_process_transcription` gate chain** — each failure returns `None` (raw text pasted) with only a `debug!` log:
   - blank transcript → skip
   - no active provider (`active_post_process_provider`) → skip
   - `post_process_models[provider.id]` empty → skip
   - `post_process_selected_prompt_id` is `None` → skip (note: fresh installs default to `None`; the UI only sets it when the user picks a prompt)
   - selected prompt id not found in `post_process_prompts` → skip
   - prompt text empty → skip
7. **Reasoning suppression.** Provider-specific: `custom` gets top-level `reasoning_effort: "none"`; `openrouter` gets nested `reasoning: {effort:"none", exclude:true}`; all others get neither.
8. **Provider dispatch.**
   - **Apple Intelligence** (`provider.id == "apple_intelligence"`, only compiled on macOS aarch64): runtime availability re-check (`check_apple_intelligence_availability`) — if unavailable, silent `None`. Model string is parsed as an i32 "token limit" (actually a word cap; parse failure → 0 = unlimited). Calls the blocking Swift bridge with system prompt + transcript. Empty response → `None`; error → `error!` log + `None`. On non-mac-ARM builds the whole branch returns `None`.
   - **Structured-output providers** (`supports_structured_output: true` — openai, zai, openrouter, cerebras, bedrock_mantle): `send_chat_completion_with_schema` with system prompt = template minus `${output}`, user message = transcript, strict JSON schema `{transcription: string}`. Response content is parsed as JSON and the `transcription` field extracted; missing field or JSON parse failure logs an error and returns the **raw content string** as the result. An API `Err` logs a `warn!` and **falls through to legacy mode** (a second full API call).
   - **Legacy mode** (anthropic, groq, custom, or structured fallback): prompt template with `${output}` substituted becomes the single user message via `send_chat_completion`. Success → cleaned text; `Ok(None)`/`Err` → `error!` log + `None`.
   - All successful outputs pass through `strip_invisible_chars`.
9. **Result assembly.** On success `final_text` becomes the processed text; `post_processed_text` and `post_process_prompt` are captured for history. If only OpenCC changed the text (non-post-process path), `post_processed_text` is set to the converted text.
10. **Persist & paste.** `HistoryManager::save_entry(file_name, raw_transcription, post_process_requested, post_processed_text, post_process_prompt)` (emits `history-update-payload`), then `utils::paste(final_text)` on the main thread. Paste failure emits `paste-error`; transcription failure emits `transcription-error`. There is **no event for post-processing failure**.
11. **History retry.** `commands/history.rs (retry_history_entry_transcription)` replays steps 5–9 for a stored recording, using the entry's original `post_process_requested`.
12. **Tray.** `tray.rs (last_transcript_text)` shows `post_processed_text` (falling back to raw) in the tray's recent-transcript item.

### Settings/UI flow (configuration)

Sidebar page `postprocessing` (visible only when `post_process_enabled`) →
`PostProcessingSettings.tsx`: shortcut editor for `transcribe_with_post_process`,
provider/base-url/api-key/model section (`usePostProcessProviderState`), prompt
CRUD. The enable toggle itself lives on the Advanced page
(`PostProcessingToggle.tsx`); toggling it registers/unregisters the shortcut via
`change_post_process_enabled_setting`.

---

## 5. Tauri Commands & Events

All commands are `frontend -> rust` via generated bindings (`src/bindings.ts`,
tauri-specta; camelCase on the frontend). All return `Result<_, String>` except
`check_apple_intelligence_available`, which returns a plain `bool`
(`commands/mod.rs:119`; `Promise<boolean>` in `bindings.ts:545`).

### Commands (defined in `src-tauri/src/shortcut/mod.rs` unless noted)

| Command                                                                   | Args                            | Returns       | Notes                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `change_post_process_enabled_setting`                                     | `enabled: bool`                 | `()`          | Persists flag; registers/unregisters the `transcribe_with_post_process` shortcut. Registration errors are discarded (`let _`).                              |
| `set_post_process_provider`                                               | `provider_id: String`           | `()`          | Validates provider exists; sets `post_process_provider_id`.                                                                                                 |
| `change_post_process_base_url_setting`                                    | `provider_id, base_url: String` | `()`          | Hard-rejects any provider except `custom` (checks `provider.id != "custom"`, not `allow_base_url_edit`).                                                    |
| `change_post_process_api_key_setting`                                     | `provider_id, api_key: String`  | `()`          | Stores key in `post_process_api_keys` (plaintext).                                                                                                          |
| `change_post_process_model_setting`                                       | `provider_id, model: String`    | `()`          | Stores model id string (free-form).                                                                                                                         |
| `fetch_post_process_models`                                               | `provider_id: String`           | `Vec<String>` | Apple → returns `["Apple Intelligence"]` on mac-ARM, error elsewhere. Requires non-empty API key for all except `custom`. Calls `llm_client::fetch_models`. |
| `add_post_process_prompt`                                                 | `name, prompt: String`          | `LLMPrompt`   | Id = `prompt_{timestamp_millis}` (despite the comment, no random component — same-millisecond collision possible).                                          |
| `update_post_process_prompt`                                              | `id, name, prompt: String`      | `()`          | Errors if id not found.                                                                                                                                     |
| `delete_post_process_prompt`                                              | `id: String`                    | `()`          | Refuses to delete the last prompt; reselects first prompt if the selected one was deleted.                                                                  |
| `set_post_process_selected_prompt`                                        | `id: String`                    | `()`          | Validates prompt exists; sets `post_process_selected_prompt_id`.                                                                                            |
| `check_apple_intelligence_available` (`src-tauri/src/commands/mod.rs`)    | none                            | `bool`        | FFI availability probe; `false` on non-mac-ARM builds.                                                                                                      |
| `get_app_settings` (`src-tauri/src/commands/mod.rs`)                      | none                            | `AppSettings` | Returns everything above **including API keys** to the webview.                                                                                             |
| `retry_history_entry_transcription` (`src-tauri/src/commands/history.rs`) | `id: i64`                       | `()`          | Re-runs transcription + post-processing for a history entry.                                                                                                |

### Events (rust -> frontend)

| Event                    | Emitted from                                      | Payload                                                                                                                    | Post-processing relevance                                                                 |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `stream-phase-event`     | `managers/transcription.rs (emit_stream_working)` | `{ phase: "working", kind: "transcribing" \| "polishing" }`                                                                | `kind: "polishing"` is emitted right before the LLM call when the Live overlay is active. |
| `history-update-payload` | `managers/history.rs` (save/update/toggle/delete) | tagged enum (`Added { entry }` etc.); entries carry `post_processed_text`, `post_process_prompt`, `post_process_requested` | History UI refresh after a post-processed dictation.                                      |
| `transcription-error`    | `actions.rs (TranscribeAction::stop)`             | `String` (error message)                                                                                                   | Fires for STT failure only, **never** for LLM post-processing failure.                    |
| `paste-error`            | `actions.rs`                                      | `()`                                                                                                                       | Paste failure toast.                                                                      |
| `recording-error`        | `actions.rs (TranscribeAction::start)`            | `{ error_type, detail }`                                                                                                   | Recording start failure (mic permissions etc.).                                           |

There are no post-processing-specific events. No progress/streaming events
exist for the LLM call itself.

---

## 6. Settings Keys

Stored in `settings_store.json` under the single `"settings"` key
(`tauri_plugin_store`), fields of `AppSettings` (`src-tauri/src/settings.rs`):

| Key                                        | Type                                           | Default                                                                                                                                           | Written by                                                                                         |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `post_process_enabled`                     | bool                                           | `false`                                                                                                                                           | `change_post_process_enabled_setting`                                                              |
| `post_process_provider_id`                 | String                                         | `"openai"`                                                                                                                                        | `set_post_process_provider`                                                                        |
| `post_process_providers`                   | `Vec<PostProcessProvider>`                     | table in `default_post_process_providers`                                                                                                         | `change_post_process_base_url_setting` (custom only); `ensure_post_process_defaults` on every read |
| `post_process_api_keys`                    | `SecretMap` (map provider id → key, plaintext) | all `""`                                                                                                                                          | `change_post_process_api_key_setting`                                                              |
| `post_process_models`                      | `HashMap<String,String>`                       | `""` for all except `apple_intelligence` → `"Apple Intelligence"`                                                                                 | `change_post_process_model_setting`                                                                |
| `post_process_prompts`                     | `Vec<LLMPrompt>`                               | one prompt: id `default_improve_transcriptions`, name "Improve Transcriptions" (clean transcript instructions ending in `Transcript:\n${output}`) | prompt CRUD commands                                                                               |
| `post_process_selected_prompt_id`          | `Option<String>`                               | `None`                                                                                                                                            | `set_post_process_selected_prompt`, `delete_post_process_prompt`                                   |
| `bindings["transcribe_with_post_process"]` | `ShortcutBinding`                              | `option+shift+space` (mac) / `ctrl+shift+space` (win/linux) / `alt+shift+space` (other)                                                           | shortcut change commands (shortcut subsystem)                                                      |

History DB columns (SQLite `transcription_history`, `managers/history.rs`):
`post_processed_text TEXT`, `post_process_prompt TEXT`,
`post_process_requested BOOLEAN NOT NULL DEFAULT 0`.

---

## 7. Provider Table (defaults)

From `settings.rs (default_post_process_providers)`:

| id                   | base_url                                      | structured output         | base URL editable | notes                                                                                                        |
| -------------------- | --------------------------------------------- | ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `openai`             | `https://api.openai.com/v1`                   | yes                       | no                | default provider                                                                                             |
| `zai`                | `https://api.z.ai/api/paas/v4`                | yes                       | no                |                                                                                                              |
| `openrouter`         | `https://openrouter.ai/api/v1`                | yes                       | no                | reasoning `{effort:none, exclude:true}` forced                                                               |
| `anthropic`          | `https://api.anthropic.com/v1`                | no                        | no                | `x-api-key` + `anthropic-version: 2023-06-01` headers; uses legacy prompt mode                               |
| `groq`               | `https://api.groq.com/openai/v1`              | no                        | no                | legacy prompt mode                                                                                           |
| `cerebras`           | `https://api.cerebras.ai/v1`                  | yes                       | no                |                                                                                                              |
| `apple_intelligence` | `apple-intelligence://local`                  | yes (native `@Generable`) | no                | only present on macOS aarch64 builds; "model" field repurposed as word cap                                   |
| `bedrock_mantle`     | `https://bedrock-mantle.us-east-1.api.aws/v1` | yes                       | no                | AWS Bedrock via Mantle OpenAI-compat                                                                         |
| `custom`             | `http://localhost:11434/v1` (Ollama)          | no                        | **yes**           | only provider allowed to edit base URL; `reasoning_effort:"none"` forced; API key optional for model listing |

`ensure_post_process_defaults` re-adds any of these that are missing and
force-syncs `supports_structured_output` back to these values on every
settings read (self-healing, but also means the flag is not user-tunable).

---

## 8. Platform-Specific Behavior (macOS)

- **Compile gating**: the Swift bridge is built and linked only for
  `target_os = "macos" && target_arch = "aarch64"`
  (`build.rs (build_apple_intelligence_bridge)`). Intel macs, Windows, Linux
  never get the provider (it is not even in the provider list), and
  `check_apple_intelligence_available` returns `false`.
- **SDK gating**: `build.rs` probes the macOS SDK for
  `FoundationModels.framework`. Present → compile
  `swift/apple_intelligence.swift`; absent → compile
  `swift/apple_intelligence_stub.swift` (availability 0, calls error). So an
  Apple-silicon build made with an old Xcode silently ships a non-functional
  Apple Intelligence provider.
- **OS gating**: the real Swift code requires macOS 26 at runtime
  (`guard #available(macOS 26.0, *)`) and `SystemLanguageModel.default
.availability == .available` (Apple Intelligence enabled in System Settings,
  model downloaded, region/language eligible).
- **Deferred availability check**: the provider is _always listed_ in
  settings on mac-ARM without probing availability at startup. Comment in
  `settings.rs`: probing `SystemLanguageModel.default` during early app init
  SIGABRTs on macOS 26.x beta. Availability is checked (a) in the UI when the
  user selects the provider (`checkAppleIntelligenceAvailable`) and (b) at
  each use in `actions.rs`.
- **Blocking FFI**: `process_text_with_system_prompt` blocks its thread on a
  semaphore while a detached Swift Task runs the model. It is invoked from
  `post_process_transcription`, which runs inside a `tauri::async_runtime
::spawn` future — this blocks a tokio worker thread for the duration of the
  on-device generation. There is no timeout.
- **maxTokens misnomer**: the "model" setting for Apple Intelligence is a
  number parsed as `i32` and applied in Swift as a **word-count** truncation of
  the output (`truncatedText`); unparseable values (including the default
  string "Apple Intelligence") become 0 = no truncation.
- Default shortcuts differ per OS (see section 6).
- Unix-only: `SIGUSR1` triggers post-processed dictation; Windows has only the
  CLI/single-instance path.

---

## 9. Fragile Points & Failure Modes

Silent-failure spots (user gets raw text with no explanation):

1. **Every gate in `post_process_transcription` is `debug!`-only.** No provider
   selected, no model, no prompt selected (the fresh-install default!), prompt
   missing/empty — all silently paste raw text. A user who enables the feature
   but never picks a prompt gets no post-processing and no hint why.
2. **LLM API errors are logged, never surfaced.** HTTP failures, auth errors,
   404 models, quota errors: `error!`/`warn!` to `murmur.log`, then raw text is
   pasted. There is no `post-process-error` event and the frontend has no
   listener for one. (Contrast: STT failures emit `transcription-error`.)
3. **Apple Intelligence unavailability at use-time is silent** (`debug!` +
   `None`), including on unsupported platforms if stale settings carry the
   provider id.
4. **Structured-output fallback doubles cost/latency**: on any structured
   request `Err`, the code falls through and issues a _second_ complete
   request in legacy mode (`actions.rs (post_process_transcription)`).
5. **Structured-output content that isn't valid JSON is returned as-is** —
   if a provider claims structured support but returns prose, the prose
   (possibly with preamble) gets pasted (`error!` + `Some(raw content)`).
6. **API keys are plaintext**: in `settings_store.json` on disk, in every
   `get_app_settings` response to the webview, and in the Zustand store.
   `SecretMap` only guards `Debug` formatting.
7. **No timeout on any LLM call**: `reqwest::Client` is built without a
   timeout, and the Apple bridge waits forever on its semaphore. A hung
   provider leaves the pipeline in `Processing` (coordinator ignores further
   presses: "pipeline busy") until the OS/socket gives up; the overlay spins.
   Cancel (`Cancel` shortcut) sets a flag checked only _after_ the LLM call
   returns.
8. **`change_post_process_enabled_setting` discards shortcut registration
   errors** (`let _ = register_shortcut(...)`): the toggle can show enabled
   while the hotkey silently failed to register.
9. **CLI/SIGUSR1 bypass `post_process_enabled`** — the action map entry always
   exists, so `--toggle-post-process` works with the feature "disabled";
   inconsistent with the shortcut gating. (May be intentional, but is
   undocumented.)
10. **Prompt id generation** (`add_post_process_prompt`): timestamp-millis
    only; two prompts created in the same millisecond collide (unlikely via
    UI, possible via scripted calls).
11. **`ensure_post_process_defaults` clobbers `supports_structured_output`**
    edits and runs (with a store write) on every settings read — any future
    per-user override of that flag needs a schema change.
12. **`fetch_models` returns `Ok(vec![])` for unknown response shapes**, so a
    misconfigured custom endpoint looks like "provider has no models" rather
    than an error.
13. **Anthropic/OpenAI-compat assumption**: all remote providers are called at
    `{base_url}/chat/completions`. Anthropic works only through its
    OpenAI-compat layer; `models_endpoint` (`/models`) is stored per provider
    but `fetch_models` ignores it and hardcodes `/models`.
14. **`build_system_prompt` blanks `${output}`** wherever it appears; a prompt
    written to embed the transcript mid-sentence degrades oddly in
    structured-output mode (transcript is instead sent as the user message).
15. **Branding constants in `llm_client.rs (build_headers)`** (Referer,
    User-Agent, X-Title all say "Handy"/cjpais GitHub) — must change for
    Murmur.
16. **History saves raw + processed but retry re-bills**: retry runs the LLM
    again with the _currently selected_ prompt/provider, not the ones stored
    on the entry.

---

## 10. Cross-Links to Other Subsystems

- **Shortcuts/bindings** (`src-tauri/src/shortcut/*`): registration of
  `transcribe_with_post_process`, cancel shortcut, HandyKeys/Tauri impls.
- **Transcription pipeline** (`src-tauri/src/managers/transcription.rs`,
  `managers/audio.rs`): produces the raw transcript; `emit_stream_working`
  drives the overlay "polishing" spinner.
- **Coordinator** (`src-tauri/src/transcription_coordinator.rs`): serializes
  both transcribe variants; `FinishGuard` unblocks the state machine after
  post-processing completes.
- **Overlay** (`src-tauri/src/overlay.rs`, `utils::show_processing_overlay`):
  visual states during the LLM call.
- **History** (`src-tauri/src/managers/history.rs`,
  `src-tauri/src/commands/history.rs`, history UI): stores raw + processed
  text + prompt; retry path re-enters this subsystem.
- **Paste/output** (`src-tauri/src/utils.rs`, `clipboard.rs`): consumes
  `final_text`.
- **Settings store** (`src-tauri/src/settings.rs`,
  `src/stores/settingsStore.ts`): persistence and frontend sync (poll-style
  `refreshSettings` after each command; no settings-changed push event).
- **Tray** (`src-tauri/src/tray.rs`): displays last (post-processed)
  transcript.
- **OpenCC Chinese conversion** (`actions.rs (maybe_convert_chinese_variant)`):
  runs in the same `process_transcription_output` step but is independent of
  the LLM feature.
