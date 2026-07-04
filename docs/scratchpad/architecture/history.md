# Transcription History Subsystem

Status: architecture map of the existing Handy code, pre-Murmur changes.
Scope: SQLite history store, WAV retention, history Tauri commands/events, and
the history/retention UI. Written for engineers taking over the codebase.

## Purpose

Every dictation capture is persisted twice: the raw audio as a WAV file on
disk, and a row in a local SQLite database holding the transcript plus
post-processing metadata. The subsystem provides:

- Durable capture records with a star/"saved" flag that exempts entries from cleanup.
- Count-based or time-based retention cleanup of unsaved entries (DB row + WAV file).
- A settings page ("History" in the sidebar) with infinite scroll, per-entry
  copy / star / re-transcribe / delete actions, and inline audio playback.
- Retry: re-transcribe a stored WAV through the current model (this is the seed
  for Murmur's planned Recent Captures panel with retry/copy actions).
- Tray-menu "copy last transcript" (reads the newest non-empty entry).

## Storage backend

NOT tauri-plugin-sql. The code was migrated to direct `rusqlite` +
`rusqlite_migration`. A compatibility shim converts databases created by the
old tauri-plugin-sql/sqlx setup.

- Database file: `{app_data_dir}/history.db`
  (`src-tauri/src/managers/history.rs` (`HistoryManager::new`)).
- Recordings directory: `{app_data_dir}/recordings/`, created on manager init.
- `{app_data_dir}` is portable-aware via `src-tauri/src/portable.rs`
  (`app_data_dir`): if a `portable` marker file sits next to the executable,
  data lives in `Data/` next to the exe; otherwise Tauri's
  `app.path().app_data_dir()` is used. On macOS that resolves to
  `~/Library/Application Support/com.kylebegeman.murmur` (identifier from
  `src-tauri/tauri.conf.json`).
- Connections: `HistoryManager::get_connection` opens a **fresh
  `rusqlite::Connection` per operation**. No pool, no WAL pragma, no
  `busy_timeout` configured.

### Migrations

`src-tauri/src/managers/history.rs` (`MIGRATIONS` static, applied by
`init_database` via `Migrations::to_latest`, tracked in SQLite's
`user_version` pragma):

1. `CREATE TABLE transcription_history (id, file_name, timestamp, saved, title, transcription_text)`
2. `ADD COLUMN post_processed_text TEXT`
3. `ADD COLUMN post_process_prompt TEXT`
4. `ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0`

`migrate_from_tauri_plugin_sql` runs first: if a legacy `_sqlx_migrations`
table exists and `user_version == 0`, it copies `MAX(version)` of successful
sqlx migrations into `user_version` so migrations do not re-run on upgraded
installs. The legacy table is intentionally left in place. Migrations are
`validate()`d only in debug builds; `HistoryManager::new` failure at startup is
an `expect` panic in `src-tauri/src/lib.rs` ("Failed to initialize history
manager").

### Schema / exact metadata per capture

Table `transcription_history`, mapped to `HistoryEntry`
(`src-tauri/src/managers/history.rs`), mirrored in `src/bindings.ts`:

| Column                   | Type                       | Meaning                                                                                                        |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                     | INTEGER PK AUTOINCREMENT   | entry id, also the pagination cursor                                                                           |
| `file_name`              | TEXT NOT NULL              | WAV file name, `handy-{unix_seconds}.wav`                                                                      |
| `timestamp`              | INTEGER NOT NULL           | capture time, `Utc::now().timestamp()` (seconds)                                                               |
| `saved`                  | BOOLEAN NOT NULL DEFAULT 0 | star flag; saved rows are exempt from all cleanup                                                              |
| `title`                  | TEXT NOT NULL              | local-time string `"%B %e, %Y - %l:%M%p"` (`format_timestamp_title`); UI ignores it and re-formats `timestamp` |
| `transcription_text`     | TEXT NOT NULL              | raw transcript; **empty string when transcription failed** (enables retry)                                     |
| `post_processed_text`    | TEXT NULL                  | LLM-processed text, or OpenCC Chinese-variant conversion output                                                |
| `post_process_prompt`    | TEXT NULL                  | the prompt text used for post-processing                                                                       |
| `post_process_requested` | BOOLEAN NOT NULL DEFAULT 0 | whether the capture came from the post-process shortcut binding; retry re-uses it                              |

Audio files themselves are 16 kHz mono 16-bit PCM WAV
(`src-tauri/src/audio_toolkit/audio/utils.rs` (`save_wav_file`)).

## Key files

- `src-tauri/src/managers/history.rs` — `HistoryManager` (owned as
  `Arc<HistoryManager>` in Tauri state, created in `lib.rs`); structs
  `HistoryEntry`, `PaginatedHistory`, event enum `HistoryUpdatePayload`;
  functions `save_entry`, `update_transcription`, `cleanup_old_entries`,
  `cleanup_by_count`, `cleanup_by_time`, `delete_entries_and_files`,
  `get_history_entries`, `get_latest_completed_entry`, `toggle_saved_status`,
  `get_entry_by_id`, `delete_entry`, `get_audio_file_path`, `recordings_dir`.
- `src-tauri/src/commands/history.rs` — all history Tauri commands (thin
  wrappers over the manager, `anyhow::Error` stringified), plus
  `retry_history_entry_transcription` which orchestrates a full re-transcribe.
- `src-tauri/src/commands/mod.rs` (`open_recordings_folder`) — opens the
  recordings dir with `tauri-plugin-opener`.
- `src-tauri/src/actions.rs` (`TranscribeAction::stop`,
  `process_transcription_output`, `ProcessedTranscription`) — the **write
  path**: the only place `save_entry` is called.
- `src-tauri/src/tray.rs` (`copy_last_transcript`, `last_transcript_text`) —
  tray consumer of `get_latest_completed_entry`.
- `src-tauri/src/settings.rs` — `RecordingRetentionPeriod` enum,
  `history_limit`, getters `get_recording_retention_period`,
  `get_history_limit`; persisted via tauri-plugin-store in
  `settings_store.json` (`SETTINGS_STORE_PATH`).
- `src-tauri/src/portable.rs` (`app_data_dir`) — resolves where db/recordings live.
- `src/components/settings/history/HistorySettings.tsx` — history page UI
  (`HistorySettings`, `HistoryEntryComponent`, `IconButton`,
  `OpenRecordingsButton`; `PAGE_SIZE = 30`).
- `src/components/settings/RecordingRetentionPeriod.tsx`
  (`RecordingRetentionPeriodSelector`) — retention dropdown.
- `src/components/settings/HistoryLimit.tsx` (`HistoryLimit`) — numeric input
  (0–1000) for the count-based limit.
- `src/components/settings/advanced/AdvancedSettings.tsx` — mounts both
  retention controls under the "history" settings group.
- `src/components/Sidebar.tsx` — mounts `HistorySettings` at sidebar key `history`.
- `src/stores/settingsStore.ts` (`settingUpdaters`) — maps the two settings
  keys to their Tauri commands.
- `src/utils/dateFormat.ts` (`formatDateTime`) — renders `timestamp` (unix
  seconds as string) per locale.
- `src/components/ui/AudioPlayer.tsx` — lazy audio loading via
  `onLoadRequest: () => Promise<string | null>`.
- `src/bindings.ts` — generated tauri-specta bindings (`commands.*`,
  `events.historyUpdatePayload`, types `HistoryEntry`, `PaginatedHistory`,
  `HistoryUpdatePayload`, `RecordingRetentionPeriod`).

## Runtime flow

### 1. Capture write path — `src-tauri/src/actions.rs` (`TranscribeAction::stop`)

1. User releases the transcribe shortcut. An async task starts;
   `AudioRecordingManager::stop_recording` returns `Vec<f32>` samples.
   Cancellation and empty-sample cases bail out early: **nothing is persisted**.
2. `file_name = format!("murmur-{}.wav", chrono::Utc::now().timestamp())`; the
   WAV is written by `spawn_blocking(save_wav_file)` **concurrently** with
   transcription.
3. WAV result is verified via `verify_wav_file` (sample-count round-trip).
   Any save/verify failure sets `wav_saved = false` and is only `error!`-logged.
4. Transcription: finalize a live stream if one ran, else batch
   `TranscriptionManager::transcribe(samples)`.
5. Success path: `process_transcription_output(&app, &transcription, post_process)`
   produces `ProcessedTranscription { final_text, post_processed_text, post_process_prompt }`
   (OpenCC Chinese conversion and/or LLM post-processing). Then, **only if
   `wav_saved`**, `HistoryManager::save_entry(file_name, transcription,
post_process, post_processed_text, post_process_prompt)` — errors logged,
   never surfaced. Paste proceeds regardless.
6. Failure path: emits `transcription-error` (string payload) to the frontend
   and, if `wav_saved`, saves an entry with **empty `transcription_text`** so
   the user can retry from the History page.
7. `save_entry` (`managers/history.rs`): INSERT → `cleanup_old_entries()`
   (synchronous, same call) → emit `HistoryUpdatePayload::Added { entry }` on
   the `history-update-payload` event.

### 2. Retention cleanup — `managers/history.rs` (`cleanup_old_entries`)

Triggered from exactly three places: every `save_entry`, the
`update_history_limit` command, and the `update_recording_retention_period`
command. **Never on app start and never on a timer.** Dispatch on
`settings.recording_retention_period`:

- `Never` → no-op.
- `PreserveLimit` (default) → `cleanup_by_count(get_history_limit())`
  (default 5): selects unsaved rows (`saved = 0`) ordered `timestamp DESC`,
  deletes everything past the first `limit`.
- `Days3` / `Weeks2` / `Months3` → `cleanup_by_time`: deletes unsaved rows with
  `timestamp < now - period`. `Months3` is approximated as 90 days.

`delete_entries_and_files` deletes the DB row, then the WAV
(`recordings_dir/file_name`). Not transactional; a failed `fs::remove_file`
is logged and leaves an orphaned WAV. Starred (`saved = 1`) rows are never
touched by cleanup, only by explicit `delete_history_entry`.

### 3. History page read path — `src/components/settings/history/HistorySettings.tsx`

1. Mount → `loadPage()` → `commands.getHistoryEntries(null, 30)`.
2. Backend `get_history_entries(cursor, limit)`: keyset pagination
   `WHERE id < cursor ORDER BY id DESC LIMIT limit+1`; limit clamped to 100;
   the extra row computes `has_more` then is popped. (`limit = None` returns
   the whole table and ignores the cursor; the UI always passes a limit.)
3. Infinite scroll: an `IntersectionObserver` on a sentinel div calls
   `loadPage(lastEntry.id)`.
4. Live updates: `events.historyUpdatePayload.listen` prepends on
   `action === "added"` and replaces on `"updated"`. `"deleted"` and
   `"toggled"` are deliberately ignored (the UI already applied optimistic
   updates for its own actions).
5. Per-entry actions:
   - Copy → `navigator.clipboard.writeText(entry.transcription_text)` (raw
     text, not the post-processed text), disabled when transcript is empty.
   - Star → optimistic flip, `commands.toggleHistoryEntrySaved(id)`, reverted
     on failure (console only, no toast).
   - Retry → `commands.retryHistoryEntryTranscription(id)`; row shows a pulsing
     "transcribing" state; error → `toast.error` + console.
   - Delete → optimistic removal, `commands.deleteHistoryEntry(id)`; on failure
     reload page 1 only — the `toast.error(t("settings.history.deleteError"))`
     in `handleDeleteEntry` (`HistorySettings.tsx:338`) is unreachable, because
     `deleteAudioEntry` (`HistorySettings.tsx:204-217`) swallows both failure
     modes (non-`"ok"` result → `loadPage()` + normal return; catch → log +
     `loadPage()` without rethrow) and the generated binding converts backend
     rejections to `{status:"error"}` instead of throwing
     (`src/bindings.ts:800-807`).
   - Audio playback → `AudioPlayer onLoadRequest` lazily calls
     `commands.getAudioFilePath(file_name)` then `convertFileSrc(path, "asset")`;
     on Linux instead reads the file with `@tauri-apps/plugin-fs` `readFile`
     and builds a Blob URL (asset-protocol workaround).
   - "Open folder" header button → `commands.openRecordingsFolder()`.

### 4. Retry path — `src-tauri/src/commands/history.rs` (`retry_history_entry_transcription`)

`get_entry_by_id` → `read_wav_samples` (i16 WAV back to f32; error string on
missing/corrupt file) → reject empty samples → `initiate_model_load()` →
`spawn_blocking(transcribe)` → reject empty transcript ("Recording contains no
speech") → `process_transcription_output(app, text, entry.post_process_requested)`
→ `HistoryManager::update_transcription(id, ...)` which UPDATEs the row
(preserving `saved`, `timestamp`, `post_process_requested`) and emits
`HistoryUpdatePayload::Updated`. Retry only updates the history row; it does
**not** paste or copy the new text anywhere.

### 5. Tray consumer — `src-tauri/src/tray.rs` (`copy_last_transcript`)

Fetches `get_latest_completed_entry` (newest row with
`transcription_text != ''`), prefers `post_processed_text` over
`transcription_text` (`last_transcript_text`), writes to the clipboard via
`tauri-plugin-clipboard-manager`. All failure modes are log-only (warn/error);
the user gets no feedback if the copy silently fails.

## Tauri commands and events

All commands are specta-typed; generated frontend wrappers live in
`src/bindings.ts` and return `Result<T, string>` objects
(`{status: "ok", data} | {status: "error", error}`).

### Commands (frontend -> rust)

| Command                             | Args                                            | Returns                                                        | Notes                                                                                                   |
| ----------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `get_history_entries`               | `cursor: number \| null, limit: number \| null` | `PaginatedHistory { entries: HistoryEntry[], has_more: bool }` | keyset pagination, limit clamped to 100                                                                 |
| `toggle_history_entry_saved`        | `id: number`                                    | `null`                                                         | flips `saved`, emits `toggled`                                                                          |
| `get_audio_file_path`               | `fileName: string`                              | `string` (absolute path)                                       | plain join of `recordings_dir + file_name`, no sanitization                                             |
| `delete_history_entry`              | `id: number`                                    | `null`                                                         | deletes WAV (log-only on failure) then row, emits `deleted`                                             |
| `retry_history_entry_transcription` | `id: number`                                    | `null`                                                         | full re-transcribe; descriptive error strings                                                           |
| `update_history_limit`              | `limit: number`                                 | `null`                                                         | writes setting, then runs cleanup                                                                       |
| `update_recording_retention_period` | `period: string`                                | `null`                                                         | accepts `"never" \| "preserve_limit" \| "days3" \| "weeks2" \| "months3"`, writes setting, runs cleanup |
| `open_recordings_folder`            | —                                               | `null`                                                         | `commands/mod.rs`, tauri-plugin-opener                                                                  |

### Events (rust -> frontend)

| Event name               | Payload                                                                                                                                      | Emitted from                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history-update-payload` | tagged union: `{action:"added", entry: HistoryEntry}` \| `{action:"updated", entry}` \| `{action:"deleted", id}` \| `{action:"toggled", id}` | `managers/history.rs` `save_entry` / `update_transcription` / `delete_entry` / `toggle_saved_status` (tauri_specta `Event` derive on `HistoryUpdatePayload`; frontend `events.historyUpdatePayload`) |
| `transcription-error`    | `string` (error message)                                                                                                                     | `actions.rs` failure path (adjacent subsystem, but it is the only user-visible signal that a failed-capture history row was created)                                                                 |

Adjacent events touched by the same `actions.rs` flow but owned by other
subsystems: `recording-error`, `paste-error`.

## Settings keys

Stored in `settings_store.json` under the single `"settings"` object
(tauri-plugin-store; `src-tauri/src/settings.rs`):

- `history_limit: usize` — default 5 (`default_history_limit`). UI:
  `HistoryLimit.tsx`; write path `settingsStore.ts` -> `update_history_limit`.
- `recording_retention_period: RecordingRetentionPeriod` — serde snake_case
  `never | preserve_limit | days3 | weeks2 | months3`; default
  `preserve_limit` (`default_recording_retention_period`). UI:
  `RecordingRetentionPeriod.tsx`; write path `settingsStore.ts` ->
  `update_recording_retention_period` (string round-trip re-parsed in the
  command, not the enum type directly).

Note the frontend selector defaults its _display_ to `"never"` when the
setting is undefined, while the backend default is `preserve_limit` — a
cosmetic mismatch only possible before settings load.

## Platform-specific behavior

- macOS: data at `~/Library/Application Support/com.kylebegeman.murmur/{history.db,recordings/}`.
  WAV playback uses the asset protocol (`convertFileSrc(path, "asset")`); the
  asset scope in `tauri.conf.json` is wide open (`allow: ["**"]`,
  `requireLiteralLeadingDot: false`), so any absolute path returned by
  `get_audio_file_path` is servable.
- Linux: asset protocol is avoided; the WAV is read via
  `@tauri-apps/plugin-fs` `readFile` into a Blob URL
  (`HistorySettings.tsx` (`getAudioUrl`), keyed off `useOsType`).
- Windows portable mode: `portable` marker file next to the exe redirects
  everything (db, recordings, settings, logs) to `Data/` next to the exe
  (`portable.rs`).
- `title` is rendered with the machine's local timezone at capture time and
  frozen into the row; the UI ignores it and re-formats `timestamp` with
  `Intl.DateTimeFormat`, so displayed times follow the current locale/tz.

## Fragile points and failure modes

1. **Silent capture loss on WAV failure.** If `save_wav_file` fails, the save
   task panics, or `verify_wav_file` mismatches, `wav_saved = false` and
   `actions.rs` skips `save_entry` entirely — the transcript is still pasted,
   but no history row exists and the user is never told
   (`actions.rs` (`TranscribeAction::stop`), log-only).
2. **`save_entry` errors are swallowed.** Both the success path and the
   failed-transcription path only `error!`-log a failed insert; the paste
   continues and the UI shows nothing.
3. **Insert succeeds but event can be lost.** Inside `save_entry`, the row is
   inserted, then `cleanup_old_entries()` runs, then the `Added` event fires.
   If cleanup errors, `save_entry` returns `Err` after the INSERT and the
   `Added` event is never emitted: the row exists but the open History page
   will not show it until reload.
4. **Cleanup deletions are invisible to the UI.** `cleanup_by_count` /
   `cleanup_by_time` remove rows without emitting `Deleted` events, so an open
   History page can list entries whose rows and WAVs are already gone (audio
   load then fails; retry returns "Failed to load audio").
5. **Non-transactional delete.** `delete_entries_and_files` and `delete_entry`
   delete DB row and WAV independently; a failed file delete is log-only and
   orphans the WAV in `recordings/`. Conversely `delete_entry` deletes the
   file before the row: a subsequent row-delete failure leaves a row pointing
   at a missing file. Also `deleted_count` in `delete_entries_and_files`
   counts file deletions, not row deletions, so the debug log undercounts when
   files were already missing.
6. **File-name collision within one second.** `file_name` is
   `handy-{unix_seconds}.wav`; two captures in the same second share a name:
   the second WAV overwrites the first, two DB rows reference one file, and
   deleting either entry destroys the other's audio.
7. **New connection per operation, no busy timeout.** Concurrent writes (e.g.
   pipeline `save_entry` racing a UI delete) can surface `SQLITE_BUSY` as an
   opaque error string; on the pipeline side that is again log-only (point 2).
8. **No periodic cleanup.** Retention only enforces on new captures or
   settings changes; with `never` retention, recordings grow unboundedly with
   no size indicator anywhere in the UI.
9. **Failed captures look like ordinary rows.** A failed transcription stores
   `transcription_text = ""`; the UI renders "transcriptionFailed" text and
   disables copy, but nothing marks the row as retryable-at-a-glance beyond
   that, and the only toast at capture time is the generic
   `transcription-error` event.
10. **`get_audio_file_path` does not sanitize `file_name`** — it joins
    whatever string the frontend passes onto `recordings_dir`, and the asset
    scope allows `**`; combined, any renderer compromise can read arbitrary
    files. Low risk today (file names come from the DB) but worth fixing when
    building Recent Captures.
11. **Retry silently does not paste.** `retry_history_entry_transcription`
    only updates the row. Users may expect the retried text to be inserted or
    copied; Murmur's Recent Captures retry/copy design should make this
    explicit.
12. **`Months3` is 90 days**, not calendar months (`cleanup_by_time`).
13. **Optimistic UI reverts are console-only** for star toggles; delete
    failures reset scroll position by reloading page 1 without any toast —
    the delete-failure toast is unreachable because `deleteAudioEntry`
    handles both failure modes internally and never rejects, and the
    generated binding returns `{status:"error"}` rather than throwing.

## Murmur growth notes (Recent Captures panel)

The pieces needed for retry/copy already exist: keyset-paginated
`get_history_entries`, the `history-update-payload` event stream (added /
updated / deleted / toggled), `retry_history_entry_transcription`, and the
empty-`transcription_text` convention for failed captures. Gaps to close for
a product-grade panel: emit `Deleted` events from retention cleanup (point 4),
mark failed entries explicitly (status column vs empty-string sentinel),
surface WAV-save failures (points 1–2), decide paste/copy semantics for retry
(point 11), and de-collide file names (point 6).
