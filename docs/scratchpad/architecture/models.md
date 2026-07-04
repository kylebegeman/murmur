# Subsystem Map: Model Catalog & Management

Status: scratchpad architecture note, verified against source on 2026-07-04.
Repo: `/Users/kyle/Developer/products/murmur-new` (Handy, evolving into Murmur).
All paths below are repo-relative. Citations use `path (function_name)`.

## Purpose

This subsystem owns the app's model registry: which speech models exist (bundled
catalog + legacy hardcoded table + local discovery), what each one can do
(streaming, translation, language detection, languages, size, speed/accuracy
scores), whether it is on disk, how it gets downloaded (with progress events,
SHA-256 verification, tar.gz extraction, resume, cancel), where it is stored,
and which model is currently selected/active. It is the data source for the
frontend model UI (onboarding picker, settings Models page, model dropdown,
tray menu) and hands resolved on-disk paths to the transcription subsystem.
This is the direct substrate for the future Murmur Model Lab; capability
labeling is fully described below.

## Key Files

| File                                                                                                                                                 | Role                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/managers/model.rs`                                                                                                                    | `ModelManager`: the in-memory registry (`HashMap<String, ModelInfo>`), legacy hardcoded model table, catalog seeding, local discovery (custom dir + shared HF cache), download/cancel/delete/resume, SHA-256 verify, tar.gz extraction, path resolution, auto-selection, language-intent resolution (`effective_language`). ~2700 lines, the heart of the subsystem. |
| `src-tauri/src/managers/model_capabilities.rs`                                                                                                       | Capability probing seam: `CapabilityProbe`, `Compatibility` verdicts, `CapabilityProber` trait + `GgufHeaderProber` (reads capabilities from a local GGUF header before/without loading). `KNOWN_ARCHES` whitelist of transcribe-cpp architectures.                                                                                                                  |
| `src-tauri/src/managers/gguf_meta.rs`                                                                                                                | Minimal dependency-free GGUF v2/v3 header parser (`parse_header`), never touches tensor data. Works on file prefixes so it can run on partial reads. Hardened against malformed input (`GgufError`, size caps).                                                                                                                                                      |
| `src-tauri/src/catalog/mod.rs`                                                                                                                       | Bundled offline catalog loader: parses `catalog.json` (via `include_str!`) into `Vec<ModelDescriptor>` (`CATALOG` lazy static), plus `rank_of(model_id)` editorial ordering.                                                                                                                                                                                         |
| `src-tauri/src/catalog/catalog.json`                                                                                                                 | Generated catalog data (65 models, `catalog_version: 1`), produced by `scripts/gen_catalog.py` from the `handy-computer` Hugging Face org. Compiled into the binary; zero network needed to show the full list.                                                                                                                                                      |
| `src-tauri/src/commands/models.rs`                                                                                                                   | All model Tauri commands + `switch_active_model` (shared by the `set_active_model` command and the tray menu handler in `src-tauri/src/lib.rs`).                                                                                                                                                                                                                     |
| `scripts/gen_catalog.py`                                                                                                                             | Catalog generator (HF card `transcribe_cpp` capability blocks + GGUF header probe + hand-written `CURATION` map for rank/recommended/descriptions). Not shipped; run manually, output committed.                                                                                                                                                                     |
| `src/stores/modelStore.ts`                                                                                                                           | Frontend Zustand store: calls every model command, listens to every model event, tracks download progress/speed/verify/extract state.                                                                                                                                                                                                                                |
| `src/components/settings/models/ModelsSettings.tsx`, `src/components/onboarding/Onboarding.tsx` + `ModelCard.tsx`, `src/components/model-selector/*` | Frontend consumers. Both settings and onboarding hide legacy `Url`-sourced models that are not already downloaded (`isLegacyModel` / `isLegacySource`).                                                                                                                                                                                                              |

## Core Types (exact names)

All in `src-tauri/src/managers/model.rs` unless noted:

- `EngineType` (enum, serialized to frontend): `TranscribeCpp` (any GGUF —
  Whisper/Parakeet/Voxtral/Qwen3-ASR/... auto-detected from file), `Parakeet`,
  `Moonshine`, `MoonshineStreaming`, `SenseVoice`, `GigaAM`, `Canary`, `Cohere`.
  The non-TranscribeCpp variants are the legacy ONNX directory engines.
- `ModelSource` (enum): `Url { url, sha256: Option<String> }` (legacy
  blob.handy.computer downloads), `HuggingFace { repo_id, revision }` (catalog
  - HF-cache-discovered GGUFs, fetched via hf-hub into the shared HF cache),
    `Local` (user-dropped custom file, nothing to download).
- `ModelInfo` (the frontend-facing shape, specta-typed): `id`, `name`,
  `description`, `filename`, `source`, `size_mb`, `is_downloaded`,
  `is_downloading`, `partial_size`, `is_directory`, `engine_type`,
  `accuracy_score` (0.0–1.0), `speed_score` (0.0–1.0), `supports_translation`,
  `is_recommended`, `supported_languages: Vec<String>`,
  `supports_language_selection`, `is_custom`, `supports_streaming`,
  `supports_language_detection`.
- `QuantFile`: `{ filename, quant, size_bytes }` — one downloadable quantization;
  deserializes straight from a catalog `files[]` entry.
- `ModelDescriptor`: normalized catalog entry — `id`, `source`, `name`,
  `description`, `engine_type`, `caps: CapabilityProbe`, `files: Vec<QuantFile>`,
  `default_quant`, `speed_score`, `accuracy_score`, `recommended_rank`,
  `recommended`. Rendered to `ModelInfo` by `ModelDescriptor::to_model_info(status: &DiskStatus)`.
- `DiskStatus`: `{ is_downloaded, is_downloading, partial_size }` — the live half
  of `ModelInfo`, kept separate from the static descriptor.
- `DownloadProgress`: `{ model_id, downloaded, total, percentage }` — the
  `model-download-progress` event payload.
- `default_quant_file(files, default_quant)` — the single "which file do we
  surface" rule (declared default quant, else first file), shared by
  `ModelDescriptor::default_file` and catalog id construction so they can't drift.
- `effective_language(intent, supported_languages, supports_language_detection)`
  — resolves the persisted language intent (`"auto"` or a code) into what a
  given model will actually use. Base-language-aware (`en` matches `en-US` and
  returns the model's concrete code), passes `zh-Hans`/`zh-Hant` through so
  Simplified/Traditional post-conversion still fires, falls back to `"auto"` if
  the model can detect, else English, else the first supported language. Never
  written back to settings.
- `src-tauri/src/managers/model_capabilities.rs`: `CapabilityProbe`
  (all-`Option` capability fields; `None` = "not known yet"), `Compatibility`
  (`Compatible` / `MaybeIncompatible` / `Unsupported` / `Unknown`),
  `CapabilityProber` trait, `GgufHeaderProber`, `KNOWN_ARCHES`,
  `read_header_metadata` (64 KiB initial prefix, geometric growth to 16 MiB cap).
- `src-tauri/src/managers/gguf_meta.rs`: `GgufMetadata` (`kv: HashMap<String,
GgufValue>` with `get_str` / `get_bool` / `get_string_array`), `GgufValue`,
  `GgufError` (`NotGguf`, `UnsupportedVersion`, `Truncated { needed }`,
  `Malformed`), `parse_header(bytes, wanted_keys)` — materializes only requested
  keys, skips the rest with checked cursor movement.
- `src-tauri/src/catalog/mod.rs`: `CatalogRoot`, `CatalogModel`, `CatalogCaps`,
  `CATALOG: Lazy<Vec<ModelDescriptor>>`, `RANK_BY_ID`, `rank_of`.

## Catalog Schema (`src-tauri/src/catalog/catalog.json`)

Top level: `{ "catalog_version": 1, "generated_at": ISO8601, "models": [...] }`.
65 models currently. Per-model keys (Rust deserializes a subset; serde ignores
the rest):

| Key                                                                       | Used by Rust? | Meaning                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                      | yes           | HF repo id, e.g. `handy-computer/whisper-medium-gguf`.                                                                                                                                                                                                    |
| `slug`, `family`, `parameters`, `base_model`, `license`, `language_count` | no (ignored)  | Metadata for the generator/humans. `parameters` (e.g. "0.6B") would be useful for Model Lab memory estimates but is currently dropped.                                                                                                                    |
| `name`, `description`                                                     | yes           | Display copy (description is hand-curated for ranked models, generated otherwise).                                                                                                                                                                        |
| `architecture`                                                            | yes           | transcribe-cpp arch string; a test (`catalog/mod.rs (catalog_architectures_are_known_to_capability_probe)`) asserts every one is in `KNOWN_ARCHES`.                                                                                                       |
| `languages`                                                               | yes           | Full language-code list (up to 100 for whisper).                                                                                                                                                                                                          |
| `capabilities`                                                            | yes           | `{ streaming: bool, translate: bool, lang_detect: bool, timestamps: "none"\|"token"\|"segment"\|"word" }`. **`timestamps` is parsed by the generator but NOT wired into `CapabilityProbe` yet** — noted in `catalog/mod.rs (CatalogCaps)` as future work. |
| `speed_score`, `accuracy_score`                                           | yes           | 0–100 in JSON; divided by 100 into `ModelDescriptor` (UI uses 0.0–1.0). Derived in `gen_catalog.py` from benchmark rtf/WER: `speed = 100·(1 − e^(−rtf/8))`, `accuracy = 100·e^(−wer/15)`; models with no benchmark rtf get a floor of 10.                 |
| `files[]`                                                                 | yes           | Quantizations: `{ filename, quant, size_bytes }`. Typical set: Q4_K_M, Q5_K_M, Q6_K, Q8_0, (B)F16, F32.                                                                                                                                                   |
| `default_quant`                                                           | yes           | Which quant is surfaced (usually Q8_0 for small models, Q5_K_M for large ones).                                                                                                                                                                           |
| `recommended`                                                             | yes           | The small curated onboarding set (currently 5: parakeet-unified-en, nemotron-3.5-streaming, canary-180m-flash, cohere-transcribe-03-2026, whisper-medium). Badged "Recommended".                                                                          |
| `recommended_rank`                                                        | yes           | Editorial sort priority 1..10 (independent of `recommended` — ranks 6–10 are ordered high but not badged). Unranked models sort last (`rank_of` returns `u32::MAX`).                                                                                      |

Descriptor id construction (`catalog/mod.rs (From<CatalogModel> for
ModelDescriptor)`): `"{repo_id}/{default_quant_filename}"` — deliberately the
same id the HF-cache scan computes, so a catalog model already in the cache
dedups onto its richer catalog entry instead of appearing twice.

Only the **default quant** is exposed to the frontend today; the other
`files[]` entries exist in `ModelDescriptor.files` but never reach `ModelInfo`.
A Model Lab quant picker will need a new command or an extended `ModelInfo`.

## Capability Metadata: the three layers (Model Lab core)

Capabilities are canonical **in the GGUF file itself**; everything else is a
progressively better view of it:

1. **Catalog (pre-download, confident).** `catalog.json` `capabilities` becomes
   a `CapabilityProbe` with `Some(..)` for every field
   (`catalog/mod.rs (From<CatalogModel>)`), verdict forced `Compatible`.
2. **GGUF header probe (on-disk, best-effort).**
   `model_capabilities.rs (GgufHeaderProber::probe_file)` →
   `gguf_meta.rs (parse_header)` reads exactly these keys:
   - `general.architecture` → `CapabilityProbe.architecture` + `Compatibility`
     verdict (`Compatible` iff in `KNOWN_ARCHES`)
   - `general.name` → `display_name` (used as the UI name for discovered models)
   - `stt.variant` → `variant`
   - `general.languages` (string array) → `languages`
   - `stt.capability.streaming` → `supports_streaming`
   - `stt.capability.translate` → `supports_translation`
   - `stt.capability.lang_detect` → `supports_language_detect`
     Absent keys stay `None` ("unknown", never guessed). Notably, parakeet-family
     streaming is _inferred_ by transcribe-cpp from encoder hparams, so the flat
     key can be absent for genuinely streaming models — the probe leaves it
     unknown. Legacy `.bin` (GGML) files have no GGUF header at all and get
     `CapabilityProbe::default()` (everything unknown → rendered as `false`
     through `model.rs (local_caps)`).
3. **Runtime reconciliation (ground truth).** When a TranscribeCpp model loads,
   `managers/transcription.rs` (~line 565) reads the loaded session's real
   capabilities and calls
   `model.rs (ModelManager::set_runtime_capabilities)`, overwriting streaming /
   translation / lang-detect and (only if non-empty) the language set on the
   registry entry. This matters most for streaming (gates whether streaming
   preview is even attempted — see `actions.rs`) and for lang-detect + language
   set (which feed `effective_language`; a mislabeled header would otherwise
   coerce an "auto" intent to a forced language). An empty runtime language set
   is treated as "failed read", not "language-agnostic": the probed/catalog
   list is kept.

Derived fields: `supports_language_selection = languages.len() > 1` (computed
in both `to_model_info` and `local_caps`);
`canonicalize_supported_languages` collapses `zh-Hans`/`zh-Hant` → `zh` and
dedups. `accuracy_score == 0.0 && speed_score == 0.0` is a UI sentinel meaning
"no scores, hide the bars" (used for all discovered/custom models).

## Registry Construction (startup)

`model.rs (ModelManager::new)` — called from `lib.rs (initialize_core_logic)`
(and a second, separate instance in the headless `--transcribe-file` path,
`lib.rs` ~line 766):

1. Compute `models_dir = {app_data_dir}/models` via
   `portable::app_data_dir` and create it.
2. Insert the **legacy hardcoded table**: whisper `small`/`medium`/`turbo`/
   `large`/`breeze-asr` (single `.bin` files), `parakeet-tdt-0.6b-v2`/`-v3`,
   `moonshine-base`, `moonshine-{tiny,small,medium}-streaming-en`,
   `sense-voice-int8`, `gigaam-v3-e2e-ctc`, `canary-180m-flash`, `canary-1b-v2`,
   `cohere-int8` (tar.gz → directory models). All `ModelSource::Url` with
   pinned SHA-256s against `blob.handy.computer`. These are deprecated but kept
   runnable: the UI hides them unless already downloaded.
3. `seed_catalog_models` — insert every `crate::catalog::CATALOG` descriptor
   whose id is not already present (additive; catalog and legacy entries are
   deliberately separate ids/files/runtimes).
4. `discover_custom_transcribe_models(models_dir, ..)` — scan the models dir
   for loose `.bin`/`.gguf` files (skipping hidden files, predefined filenames,
   existing ids, directories, `.partial`s). GGUFs get a header probe for
   name + capabilities; id = filename minus extension; `is_custom: true`,
   `source: Local`, scores 0.0.
5. `discover_hf_cache_models` — walk the shared HF cache
   (`Cache::from_env().path()`, i.e. `$HF_HOME` or `~/.cache/huggingface/hub`)
   for `models--org--name/snapshots/<ref>/**.gguf`, probe each header, and
   surface **only `Compatibility::Compatible`** architectures (LLM GGUFs in the
   same cache are ignored). id = `"{repo_id}/{filename}"` (collides with the
   catalog id on purpose → dedup). `pick_hf_revision` prefers the `main` ref.
6. `migrate_bundled_models` — copy `resources/models/ggml-small.bin` (if
   bundled) into the user models dir.
7. `migrate_gigaam_to_directory` — one-time migration of the old single-file
   GigaAM ONNX into the directory layout (uses bundled
   `resources/models/gigaam_vocab.txt`).
8. `update_download_status` — recompute `is_downloaded` / `partial_size` per
   entry from disk (HF entries: `hf_cached_path(..).is_some()`; directory
   models: dir exists; file models: file exists), and clean up orphaned
   `.extracting` dirs.
9. `auto_select_model_if_needed` — see "Selection & switching".

Listing: `get_available_models` sorts by catalog `rank_of(id)` ascending, then
recommended flag, then accuracy desc, speed desc, name.

## Download Flow

Entry: frontend `commands.downloadModel(modelId)` →
`commands/models.rs (download_model)` → `model.rs (ModelManager::download_model)`.
The command wrapper is what emits `model-download-failed` on any `Err` — the
manager itself never emits a failure event.

### Route by `ModelSource`

- `Local` → error "No download source for model".
- `HuggingFace` → `model.rs (download_hf_model)`:
  - If already in the shared cache: refresh status, emit
    `model-download-complete`, done.
  - Set `is_downloading`, register an hf-hub `CancellationToken` in
    `cancel_flags`, arm a `DownloadCleanup` RAII guard (resets the flag +
    removes the token on every error path).
  - `ApiBuilder::from_env().with_progress(false).with_max_files(8)` — 8
    parallel connections (per-connection throughput is capped ~8 MB/s).
  - `download_with_progress_cancellable(filename, HfDownloadProgress, token)`
    — the `HfDownloadProgress` adapter (impl of hf-hub's `Progress` trait)
    emits `model-download-progress`, throttled to ~10/sec with a guaranteed
    final emit.
  - Cancel: hf-hub returns `ApiError::Cancelled`; the partial `.sync.part`
    stays in the cache so retry resumes. No SHA-256 step (hf-hub handles
    integrity); file lands in the shared HF cache, not the models dir.
- `Url` (legacy) → inline in `download_model`:
  1. If final file exists: clean stray `.partial`, refresh status, return.
  2. Resume support: if `{filename}.partial` exists, send
     `Range: bytes={size}-`; if the server answers 200 instead of 206, delete
     the partial and restart from zero (avoids corruption).
  3. Stream chunks to `{filename}.partial`, emitting throttled
     `model-download-progress` (initial, ≤10/sec, final 100%).
  4. Per-chunk cancellation check (`cancel_token.is_cancelled()`) — keeps the
     partial for later resume.
  5. Size check: if `total_size > 0`, actual bytes must match or the partial is
     deleted and an error returned.
  6. SHA-256 verify (`verify_sha256` on a `spawn_blocking` thread; up to
     1.6 GB hashes). Emits `model-verification-started` /
     `model-verification-completed`. Mismatch/read error deletes the partial.
     `sha256: None` (never the case for the built-in table) skips verification.
  7. Directory models: emit `model-extraction-started`, unpack the tar.gz into
     `{filename}.extracting` (tracked in `extracting_models` so
     `update_download_status` doesn't garbage-collect it mid-extract), then
     atomically rename into `{filename}` (handling single-nested-dir archives),
     delete the tar.gz. Failure deletes both temp dir and the corrupt partial
     (issue #858) and emits `model-extraction-failed`, then
     `model-extraction-completed` on success.
  8. File models: `fs::rename(partial, final)`.
  9. Mark `is_downloaded`, emit `model-download-complete`.

### Cancel

`commands/models.rs (cancel_download)` → `model.rs (cancel_download)`: fires
the token, clears `is_downloading` immediately for UI responsiveness, refreshes
disk status, emits `model-download-cancelled`. If no active download exists it
only logs a warning and still emits the event (returns Ok).

### Delete

`commands/models.rs (delete_model)`: if deleting the selected model, first
`TranscriptionManager::unload_model` and clear `settings.selected_model`. Then
`model.rs (delete_model)`:

- HF-sourced: resolves the cached file and deletes the **entire repo directory**
  (`models--org--name/`, blobs+refs+snapshots) from the shared HF cache —
  a deliberate product decision, but it removes all quants and anything other
  tools cached from that repo.
- Url/Local: delete the file or directory plus any `.partial`. Errors with
  "No model files found to delete" if nothing existed.
- Custom (`is_custom`) entries are removed from the registry entirely (no way
  to re-download); others just get status refreshed. Emits `model-deleted`.

### Rescan

`commands/models.rs (rescan_local_models)` (run on `spawn_blocking`) →
`model.rs (rescan_local_models)`: single-flight via `is_rescanning`
AtomicBool + `RescanGuard`; discovery runs against a cloned snapshot off-lock;
merge is additive (existing entries keep runtime-probed capabilities); then
`update_download_status` + `auto_select_model_if_needed` + emits
`models-updated`.

## Storage Paths

| What                         | Where                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Models dir (legacy + custom) | `{app_data_dir}/models` — macOS: `~/Library/Application Support/com.kylebegeman.murmur/models` (bundle id from `src-tauri/tauri.conf.json`). Portable mode (`src-tauri/src/portable.rs`): `Data/` next to the executable when a `portable` marker file with the magic string exists. |
| In-flight download           | `{models_dir}/{filename}.partial`                                                                                                                                                                                                                                                    |
| In-flight extraction         | `{models_dir}/{filename}.extracting/`                                                                                                                                                                                                                                                |
| HF-sourced models            | Shared Hugging Face cache: `$HF_HOME` else `~/.cache/huggingface/hub` (note: `~/.cache` even on macOS — hf-hub convention, shared with other tools). Layout `models--{org}--{name}/snapshots/{commit}/{file}`. Cancelled HF downloads leave a `.sync.part` there for resume.         |
| Bundled resources            | `resources/models/ggml-small.bin` (optional), `resources/models/gigaam_vocab.txt` — resolved via Tauri `BaseDirectory::Resource` (inside the .app bundle on macOS).                                                                                                                  |
| Settings                     | `settings_store.json` via tauri-plugin-store (`settings.rs (SETTINGS_STORE_PATH)`, portable-aware via `portable::store_path`).                                                                                                                                                       |

Path resolution for loading: `model.rs (get_model_path)` — refuses
not-downloaded or currently-downloading models, resolves HF entries through
`hf_cached_path`, and refuses file/dir models whose `.partial` still exists.

## Selection & Switching

- Persisted selection is `settings.selected_model` (a model id; `""` = none).
- `commands/models.rs (switch_active_model)` — shared by the
  `set_active_model` command and the tray `model_select:{id}` menu handler
  (`lib.rs` ~line 257, runs on a spawned thread):
  1. Claim the transcription manager's loading slot
     (`try_start_loading`) — rejects concurrent switches with
     "Model load already in progress".
  2. Validate the model exists and `is_downloaded`.
  3. **Write settings early**: `selected_model = id` and
     `onboarding_completed = true` (selecting a model is what completes
     onboarding), so the frontend sees the right model when load events fire.
  4. If `model_unload_timeout == ModelUnloadTimeout::Immediately`, skip eager
     loading and emit `model-state-changed` with
     `event_type: "selection_changed"` (the model loads on demand at next
     transcription).
  5. Otherwise `TranscriptionManager::load_model(id)`; on failure the persisted
     `selected_model` and `onboarding_completed` are reverted and the error
     returned.
- `auto_select_model_if_needed` (`model.rs`, run at startup and after rescans):
  clears a stale `selected_model` that no longer exists in the registry
  (writing settings silently); skips auto-selection entirely until
  `onboarding_completed`; otherwise picks the first **downloaded** model in
  ranked order and writes it to settings.
- Settings migration note: `settings.rs` (~line 979) backfills
  `onboarding_completed = !selected_model.is_empty()` for pre-existing installs.

## Tauri Commands (frontend → Rust)

All in `src-tauri/src/commands/models.rs`, registered in `lib.rs`
(collect_commands, ~lines 604–613), specta-generated bindings in
`src/bindings.ts` (camelCase: `commands.getAvailableModels()` etc.).

| Command                          | Args               | Returns             | Notes                                                                                                 |
| -------------------------------- | ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `get_available_models`           | –                  | `Vec<ModelInfo>`    | Ranked/sorted list.                                                                                   |
| `get_model_info`                 | `model_id: String` | `Option<ModelInfo>` |                                                                                                       |
| `rescan_local_models`            | –                  | `()`                | Emits `models-updated` on success.                                                                    |
| `download_model`                 | `model_id`         | `()`                | Emits `model-download-failed` on error (command wrapper, not manager).                                |
| `cancel_download`                | `model_id`         | `()`                | Emits `model-download-cancelled`.                                                                     |
| `delete_model`                   | `model_id`         | `()`                | May unload active model + clear `selected_model` first. Emits `model-deleted`.                        |
| `set_active_model`               | `model_id`         | `()`                | Delegates to `switch_active_model`; writes `selected_model` + `onboarding_completed`.                 |
| `get_current_model`              | –                  | `String`            | Just reads `settings.selected_model`.                                                                 |
| `get_transcription_model_status` | –                  | `Option<String>`    | Loaded (in-memory) model id from `TranscriptionManager`.                                              |
| `is_model_loading`               | –                  | `bool`              | **Misleading**: returns `current_model.is_none()`, i.e. "no model loaded", not "loading in progress". |

Adjacent (transcription subsystem, listed for completeness):
`set_model_unload_timeout`, `get_model_load_status`, `unload_model_manually`
(`src-tauri/src/commands/transcription.rs`).

## Events (Rust → frontend)

All consumed in `src/stores/modelStore.ts (initialize)` unless noted.

| Event                                                         | Payload                                                                                     | Emitted from                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-download-progress`                                     | `DownloadProgress { model_id, downloaded, total, percentage }`                              | `model.rs (download_model)` URL path + `HfDownloadProgress::emit` (HF path). Throttled ~10/sec, final emit guaranteed.                                                                                                                                                                        |
| `model-download-complete`                                     | `model_id: String`                                                                          | `model.rs (download_model / download_hf_model)`.                                                                                                                                                                                                                                              |
| `model-download-failed`                                       | `{ model_id, error }` (JSON)                                                                | `commands/models.rs (download_model)` wrapper only. Frontend toasts the error.                                                                                                                                                                                                                |
| `model-download-cancelled`                                    | `model_id: String`                                                                          | `model.rs (cancel_download)`.                                                                                                                                                                                                                                                                 |
| `model-verification-started` / `model-verification-completed` | `model_id: String`                                                                          | `model.rs (download_model)` around SHA-256 hashing (URL path only).                                                                                                                                                                                                                           |
| `model-extraction-started` / `model-extraction-completed`     | `model_id: String`                                                                          | `model.rs (download_model)` around tar.gz unpack (directory models only).                                                                                                                                                                                                                     |
| `model-extraction-failed`                                     | `{ model_id, error }` (JSON)                                                                | `model.rs (download_model)` unpack error closure. The command also emits `model-download-failed` for the same failure.                                                                                                                                                                        |
| `model-deleted`                                               | `model_id: String`                                                                          | `model.rs (delete_model)`.                                                                                                                                                                                                                                                                    |
| `models-updated`                                              | `()`                                                                                        | `model.rs (rescan_local_models)`.                                                                                                                                                                                                                                                             |
| `model-state-changed`                                         | `ModelStateEvent { event_type, model_id, model_name, error }` (`managers/transcription.rs`) | `commands/models.rs (switch_active_model)` with `event_type: "selection_changed"`; also heavily by `TranscriptionManager` for `loading_started` / `loaded` / `failed` / unload lifecycle (other subsystem). Listened to by `modelStore`, `App.tsx` (load-failure toast), `ModelSelector.tsx`. |

## Settings Keys

Read/written by this subsystem (via `settings.rs (get_settings / write_settings)`,
persisted in `settings_store.json`):

- `selected_model` (String) — written by `switch_active_model`,
  `auto_select_model_if_needed` (auto-pick + stale-clear), `delete_model`
  (cleared when deleting the active model).
- `onboarding_completed` (bool) — read to gate auto-selection; **written to
  `true` by `switch_active_model`** (and reverted on load failure).
- `model_unload_timeout` (`ModelUnloadTimeout`) — read by
  `switch_active_model` to decide eager vs lazy load.
- `selected_language` (String, default `"auto"`) — not read in `model.rs`
  itself, but it is the "intent" input to `effective_language` at the call
  sites (`actions.rs (resolve_effective_language)`,
  `managers/transcription.rs (effective_language_for_model)`). Never written by
  the coercion.

## Platform-Specific Behavior

- **macOS**: models dir under `~/Library/Application Support/com.kylebegeman.murmur/`;
  bundled resources resolve inside the `.app`; HF cache still at
  `~/.cache/huggingface/hub` (not `~/Library/Caches`) unless `HF_HOME` is set.
  No macOS-specific code paths inside the model subsystem itself.
- **Windows/portable**: `portable` marker file next to the exe redirects all
  data (models, settings, logs) to `Data/` (`portable.rs`); includes a
  migration for v0.8.0's empty marker files.
- **Headless CLI** (`--transcribe-file`, `--list-models`): `lib.rs` (~line 766)
  constructs a second independent `ModelManager` (window/tray/audio skipped).

## Fragile Points & Failure Modes

1. **All event emits are `let _ =`** — if the webview isn't ready or emit
   fails, progress/completion/failure signals vanish silently. The frontend
   partially compensates (`modelStore.ts (downloadModel)` cleans up local state
   when the command returns an error even without the event).
2. **`is_model_loading` is semantically wrong** (`commands/models.rs`): returns
   "no model currently loaded". Any caller treating it as "a load is in flight"
   is misled. (Frontend mostly uses `get_model_load_status` / events instead.)
3. **URL downloads with unknown length**: if the server omits
   `Content-Length`, `total_size == 0` → percentage stays 0 the whole time and
   the byte-count completeness check is skipped entirely; only SHA-256 (when
   present) catches truncation.
4. **HF delete nukes the shared repo dir** (`model.rs (delete_model)`): removes
   every quant and anything other tools cached for that repo. Intentional, but
   destructive beyond Handy's own footprint. Also: `hf_cached_path(...).ancestors().nth(3)`
   assumes the exact cache layout; a layout change silently turns delete into
   "No model files found to delete".
5. **Rescan vs in-flight download race** (documented in
   `model.rs (rescan_local_models)`): `update_download_status` resets
   `is_downloading = false` for every entry, so a rescan during a download
   briefly lies to the UI; event flow self-corrects.
6. **Cancel emits even when nothing was downloading** and cancellation of the
   URL path is only observed per-chunk — a stalled connection cancels late.
7. **`ModelManager::new` failures panic** (`expect` at both construction sites
   in `lib.rs`): an unwritable app-data dir or failed bundled-model copy
   (`migrate_bundled_models` uses `?`) crashes the app at startup with no UI.
8. **Legacy hardcoded capability lies**: the legacy `.bin`/ONNX table hardcodes
   `supports_language_detection: true` for models where that's a preserved
   historical behavior rather than probed truth, and `supports_streaming:
false` even for `MoonshineStreaming` engines (streaming preview is
   transcribe-cpp-only). Runtime reconciliation only runs for TranscribeCpp
   loads, so ONNX-engine entries are never corrected.
9. **Catalog `timestamps` capability is dropped** on the Rust side — Model Lab
   will need to add it to `CapabilityProbe`/`ModelInfo`. Same for catalog
   fields `parameters`, `family`, `license`, `base_model`, `slug` (parsed by
   the generator, ignored by serde).
10. **Only the default quant is reachable**: `ModelInfo.filename`/`size_mb`
    come from `default_quant_file`; the rest of `files[]` is invisible to the
    UI and un-downloadable without new commands.
11. **HF path has no explicit SHA-256** — integrity rests on hf-hub; catalog
    entries carry sizes but no hashes.
12. **GGUF probe silently drops models**: any header parse failure (or header
    > 16 MiB cap in `model_capabilities.rs (read_header_metadata)`) yields
    > `CapabilityProbe::unsupported()`, and the HF-cache scan then skips the file
    > with no log/UI trace. Custom-dir `.gguf`s still appear but with all
    > capabilities false.
13. **Custom model id collisions are silent**: `discover_custom_transcribe_models`
    skips a file whose stem matches an existing id (e.g. a user-dropped
    `turbo.bin` when legacy id `turbo` exists) — the file simply never appears.
14. **`switch_active_model` flips `onboarding_completed`** as a side effect;
    revert-on-failure also reverts it. Anyone refactoring onboarding must keep
    this coupling in mind.
15. **Two `ModelManager` instances in headless mode** mean the CLI path
    re-runs migrations/scans independently; concurrent GUI+CLI runs could race
    on the same files (unlikely but unguarded).
16. **Errors swallowed with `warn!`**: discovery failures
    (`discover_custom_transcribe_models` per-entry errors, rescan discovery
    errors), `.extracting`/`.partial` cleanup failures, and orphaned-partial
    removals log-and-continue with no user feedback.

## Cross-Subsystem Interfaces

- **Transcription** (`src-tauri/src/managers/transcription.rs`): consumes
  `get_model_path`, `get_model_info`, `EngineType` for engine dispatch; calls
  `set_runtime_capabilities` after TranscribeCpp loads; owns
  `ModelStateEvent`/`model-state-changed` load lifecycle and
  `ModelUnloadTimeout`; `effective_language_for_model` wraps
  `model.rs (effective_language)`.
- **Actions/dictation pipeline** (`src-tauri/src/actions.rs`):
  `resolve_effective_language` (language coercion + `zh-Hans`/`zh-Hant`
  conversion gate); streaming gating reads `supports_streaming` off the loaded
  capability truth.
- **Tray** (`lib.rs` tray menu handler): `model_select:{id}` menu ids →
  `switch_active_model`.
- **Settings** (`src-tauri/src/settings.rs`): `selected_model`,
  `onboarding_completed`, `model_unload_timeout`, `selected_language`.
- **Portable mode** (`src-tauri/src/portable.rs`): all storage paths.
- **Frontend**: `src/stores/modelStore.ts` (single event/command hub),
  `src/components/settings/models/ModelsSettings.tsx` (hides legacy `Url`
  models unless downloaded; rescan button), `src/components/onboarding/`
  (recommended set: rank-sorted, first two recommended = "top picks"),
  `src/components/model-selector/` (downloaded-only dropdown), `src/App.tsx`
  (load-failure toast), `src/bindings.ts` (specta-generated).
- **Catalog generation**: `scripts/gen_catalog.py` (HF org `handy-computer`,
  curation map, scoring formulas) — regenerate and commit `catalog.json`.
