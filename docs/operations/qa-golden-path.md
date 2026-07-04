# Golden Path QA — Manual Test Script

Manual QA script for the Murmur dictation app (Tauri fork of Handy, repo `/Users/kyle/Developer/products/murmur-new`). Primary platform: **macOS**. Reference test cases from commit messages as `QA TC-nn`.

- **Bundle identifier:** `com.pais.handy` (from `src-tauri/tauri.conf.json`; `productName: Handy`)
- **App data:** `~/Library/Application Support/com.pais.handy/` (contains `settings_store.json`, `history.db`, `recordings/`, models)
- **Log file:** `handy.log` in the app log dir (`~/Library/Logs/com.pais.handy/`); debug settings via `Cmd+Shift+D` in the main window
- **Default shortcuts (macOS):** `Option+Space` = transcribe, `Option+Shift+Space` = transcribe with post-processing, `Escape` = cancel (registered **only while recording**)
- **Default behavior:** push-to-talk ON (hold to record, release to stop), overlay style `Live`, overlay position `bottom`, paste method `ctrl_v` (clipboard + synthetic Cmd+V), audio feedback sounds OFF

---

## 0. Environment setup and reset procedures

### 0.1 Resetting permissions between runs

Quit the app first (tray menu → Quit, or `Cmd+Q`), then:

```bash
# Reset microphone permission only
tccutil reset Microphone com.pais.handy

# Reset accessibility permission only
tccutil reset Accessibility com.pais.handy

# Reset everything TCC knows about the app
tccutil reset All com.pais.handy
```

**Expected:** each command prints `Successfully reset <service> approval status for com.pais.handy`. On next launch the app behaves as if the permission was never requested (prompts fire again).

### 0.2 Full factory reset (fresh-install simulation)

```bash
rm -rf ~/Library/Application\ Support/com.pais.handy
tccutil reset All com.pais.handy
```

**Expected:** next launch shows the full onboarding flow (permissions → model download). Note this deletes downloaded models, history, and recordings.

### 0.3 Known signing caveat (dev builds)

The app is **ad-hoc signed** (`signingIdentity: "-"`). macOS TCC keys grants to the code signature hash, so **every rebuild invalidates the Accessibility grant**: the System Settings checkbox may still appear ON while the app is actually untrusted. If permission behavior looks inconsistent after a rebuild, manually remove the app from System Settings → Privacy & Security → Accessibility (minus button), re-add it, or run the `tccutil` resets above. Budget for this in every dev-build QA pass.

### 0.4 A note on error toasts

All error toasts (`recording-error`, `transcription-error`, `paste-error`, model errors) render **only in the main settings window**. For any test that expects a toast, keep the main window visible. If the window is hidden, the only evidence is `handy.log`.

---

## 1. Fresh-install permission flow

### TC-10 — First-launch onboarding shows permission cards

Precondition: factory reset (0.2). Launch the app.

1. Launch the app (open `Handy.app` or `bun run tauri dev`).
   **Expected:** main window (680×570) appears with the onboarding permission screen showing **two cards**: Microphone and Accessibility, both in "needed" state. No system permission prompt has fired yet (mic is untouched at startup unless `always_on_microphone` is on; Enigo/shortcut init is deferred).
2. Verify no global shortcut works yet: press `Option+Space` in another app.
   **Expected:** nothing happens (shortcuts are registered only after accessibility is granted).

### TC-11 — Grant microphone permission

1. On the Microphone card, click **Grant Permission**.
   **Expected:** the macOS system prompt appears: *"Handy" would like to access the microphone* with usage text "Request microphone access to transcribe audio locally". Card enters "Waiting…" state.
2. Click **Allow** on the system prompt.
   **Expected:** within ~1 s (1 Hz polling) the card flips to granted.
3. Known limitation to verify does-not-crash: if the permission was previously **denied** (not reset), clicking Grant Permission does nothing visible (silent no-op — no prompt, no System Settings deep link) and the card stays "Waiting…" forever. Recovery is `tccutil reset Microphone com.pais.handy` or manual toggle in System Settings → Privacy & Security → Microphone.

### TC-12 — Grant accessibility permission

1. On the Accessibility card, click **Grant Permission**.
   **Expected:** the one-time macOS accessibility prompt appears (offering to open System Settings). Card enters "Waiting…".
2. In System Settings → Privacy & Security → Accessibility, enable **Handy**.
   **Expected:** within ~1 s the card flips to granted; the app initializes Enigo and registers global shortcuts at this moment.
3. Known limitation: the AX prompt is **one-shot per app identity**. If it was previously dismissed, the button does nothing and never opens System Settings — the card polls forever. Recovery: open System Settings manually or `tccutil reset Accessibility com.pais.handy`.

### TC-13 — Model download completes onboarding

1. With both permissions granted, onboarding advances to the model selection step. Download/select a model (for streaming tests pick a streaming-capable one, e.g. **parakeet-unified-en-0.6b-gguf**).
   **Expected:** download progress is shown; when the model is set active, onboarding completes and the main settings UI appears. (`onboarding_completed` is written only when a model is set — a user who grants permissions but never picks a model re-enters onboarding on every launch; that is by design.)
2. Quit and relaunch.
   **Expected:** no onboarding; app goes straight to the main UI (or tray if start-hidden is set).

### TC-14 — Returning user with revoked permission is re-gated

1. Complete onboarding (TC-10..13). Quit the app. Run `tccutil reset Accessibility com.pais.handy`. Relaunch.
   **Expected:** the main window is force-shown and routed back to the permission onboarding step (returning-user mode). Granting accessibility again returns you directly to the main UI (no model step repeat).
2. Alternative surface: if you instead revoke accessibility **while the app shows the main UI** (toggle off in System Settings) and then reopen/re-render the main window, a persistent accessibility banner appears at the top of settings content.
   **Expected:** banner with a grant button is visible. (Known limitation: the button re-fires the one-shot AX prompt; it does not actually open System Settings despite its label.)

---

## 2. Golden path

Preconditions for this whole section: onboarding complete, both permissions granted, a **streaming-capable model** active (`parakeet-unified-en-0.6b-gguf`, `nemotron-3.5-asr-streaming-0.6b-gguf`, `moonshine-streaming-tiny-gguf`, `moonshine-streaming-small-gguf`, or `Voxtral-Mini-4B-Realtime-2602-gguf`), overlay style `Live` (default), push-to-talk ON (default), paste method `ctrl_v` (default). Keep the main window visible on a second display or beside your target app so toasts are observable.

### TC-20 — Push-to-talk dictation with live streaming overlay (the golden path)

1. Focus a text field in another app (e.g. TextEdit). Place the caret.
   **Expected:** tray icon shows Idle state.
2. Press **and hold** `Option+Space`; start speaking a full sentence.
   **Expected:** the streaming overlay appears bottom-center of the monitor the cursor is on — initially a small pill with pulsing dot, waveform bars reacting to your voice, elapsed timer, and an X cancel button. Tray icon switches to Recording. `Option+Space` does **not** reach the focused app (the combo is consumed).
3. Keep speaking.
   **Expected:** as soon as the model decodes text, the pill morphs open into a wider live panel (~392 px) showing the transcript growing in real time, with a blinking caret at the end. Earlier text is stable (committed); the tail may rewrite itself (tentative — currently styled identically to committed). Long text scrolls within the panel, auto-following the newest line.
4. Release `Option+Space`.
   **Expected:** the panel stays open, the waveform is replaced by a spinner + "Transcribing…" label (no size jump). Tray icon switches to Transcribing.
5. Wait for finalization (typically well under a second for streaming models).
   **Expected:** the transcript is inserted into the focused text field at the caret, the overlay fades out (~300 ms), and the tray returns to Idle. The inserted text matches what you said (streamed text is finalized; minor tail corrections vs. the live preview are acceptable).
6. Check your clipboard (`Cmd+V` elsewhere).
   **Expected:** with default `clipboard_handling = dont_modify`, the clipboard contains whatever **text** it held before dictation (the transcript was written to the clipboard transiently for Cmd+V, then restored).
7. Open the main window → History.
   **Expected:** a new entry at the top with the transcript and a playable audio recording (see section 6).

### TC-21 — Toggle mode

1. Settings → disable Push-to-talk. Focus a text field.
   **Expected:** setting persists (survives relaunch).
2. Press and **release** `Option+Space` (tap). Speak.
   **Expected:** recording starts on the tap and continues after release; overlay behaves as in TC-20 steps 2–3.
3. Tap `Option+Space` again.
   **Expected:** recording stops; finalize + insert as in TC-20 steps 4–5.
4. While the "Transcribing…" spinner is up, tap `Option+Space` rapidly.
   **Expected:** ignored (pipeline busy) — no double-start, no crash; next dictation works normally after idle. Re-enable push-to-talk afterwards.

### TC-22 — Non-streaming model uses the compact pill (no live text)

1. Switch the active model to a non-streaming one (e.g. a standard Whisper model) via Settings → Models or the tray model submenu.
   **Expected:** tray submenu shows the newly checked model.
2. Hold `Option+Space`, speak a sentence, release.
   **Expected:** only the compact pill (dot + waveform + X) appears while recording — **no live text ever** (Live style falls back to the pill for non-streaming models). On release, the pill switches to spinner + "Transcribing…", then the text is inserted and the overlay hides. Insertion result identical to TC-20 step 5.

### TC-23 — Overlay style and position settings

1. Set overlay style to `Minimal`. Dictate with the streaming model.
   **Expected:** compact pill only (no live text panel), insertion still works.
2. Set overlay style to `None`. Dictate.
   **Expected:** no overlay at all; recording/transcription/insertion still work; tray icon is the only visual state indicator.
3. Restore style `Live`; set overlay position to `Top`. Dictate.
   **Expected:** overlay appears top-center (~46 pt below the menu bar), live panel opens downward-flipped (pill above text). Restore `Bottom`.

### TC-24 — CLI remote toggle (`--toggle-transcription`)

Requires a **running** instance (the flag is forwarded via single-instance and the second process exits).

1. With the app running and a text field focused, run:
   ```bash
   /Applications/Handy.app/Contents/MacOS/Handy --toggle-transcription
   ```
   (dev build: `src-tauri/target/debug/handy`)
   **Expected:** the CLI process exits immediately; recording starts in the running instance (overlay appears) — toggle semantics regardless of the push-to-talk setting.
2. Speak, then run the same command again.
   **Expected:** recording stops, transcription finalizes, text is inserted into the focused app exactly as in TC-20.

---

## 3. Cancellation paths

Precondition: streaming model + Live overlay unless noted. In every cancellation case the defined outcome is: **nothing is inserted, nothing is saved to history, no error toast appears** (cancellation is deliberately silent), overlay hides, tray returns to Idle.

### TC-30 — Escape cancels during recording

1. Start recording (toggle mode is easiest: tap `Option+Space`). Speak so live text appears.
2. Press `Escape`.
   **Expected:** overlay fades out immediately, tray returns to Idle, no text is inserted anywhere, no history entry is created. The Escape press is consumed (should not, e.g., close a dialog in the focused app — verify with a dialog open).
3. Press `Escape` again while idle.
   **Expected:** normal Escape behavior in the focused app (the cancel shortcut is registered **only while recording** and is unregistered at stop/cancel).
4. Immediately start a new dictation.
   **Expected:** works normally (coordinator returned to Idle).

### TC-31 — Overlay X button cancels

1. Start recording. Click the **X** button on the overlay (pill or live panel).
   **Expected:** same silent teardown as TC-30 step 2. Clicking the X must not steal focus from your target app (the overlay is a non-activating NSPanel).

### TC-32 — Tray cancel, including during processing

1. Start recording. Open the tray menu.
   **Expected:** while Recording/Transcribing the menu shows a **Cancel** item in place of the model section.
2. Click **Cancel**.
   **Expected:** silent teardown as in TC-30.
3. Now dictate a long take (~30 s) with a **slow non-streaming model**, release, and while the "Transcribing…" spinner is up, click tray → Cancel.
   **Expected:** overlay hides and tray idles immediately; when the in-flight transcription hits its next cancellation checkpoint the result is discarded — **no text is inserted**. Note: `Escape` does nothing in this phase (already unregistered); only tray/overlay/CLI can cancel during processing.

### TC-33 — CLI `--cancel`

1. Start recording. Run:
   ```bash
   /Applications/Handy.app/Contents/MacOS/Handy --cancel
   ```
   **Expected:** CLI process exits immediately; the running instance cancels silently as in TC-30. (Requires a running instance; on a cold start the flag has no one to act on.)

---

## 4. Paste / insertion edge cases

### TC-40 — Secure input field (known silent-failure path)

1. In Terminal, enable **Terminal → Secure Keyboard Entry** (or focus a Safari password field).
2. Dictate into it.
   **Expected (documents current behavior):** the pipeline completes normally — overlay hides, tray idles — but **no text appears** in the secure field and **no error toast fires** (`paste()` returns Ok; delivery is unverifiable). The transcript **is** recoverable from History. Log claims "Text pasted successfully". This is a known gap, not a regression — fail this TC only if the app crashes, hangs, or corrupts the field.
3. Disable Secure Keyboard Entry and dictate again.
   **Expected:** insertion works normally.

### TC-41 — Target app changes mid-dictation

1. Focus TextEdit. Start recording (toggle mode). While recording, click into a different app's text field (e.g. Notes).
   **Expected:** recording continues uninterrupted (global shortcut/overlay are focus-independent).
2. Stop recording.
   **Expected:** the text is inserted into **Notes** (whatever holds keyboard focus at paste time), not TextEdit. This is current defined behavior — the paste targets the frontmost focused app at insertion, with no focus tracking from dictation start.

### TC-42 — Clipboard preservation and the non-text clipboard caveat

1. Copy a distinctive **text** string to the clipboard. Dictate into a text field.
   **Expected:** after insertion, `Cmd+V` yields the original string (clipboard restored after the transient transcript write).
2. Copy an **image** (e.g. screenshot to clipboard via `Cmd+Ctrl+Shift+4`). Dictate.
   **Expected (documents current behavior):** insertion works, but the image is **lost** — the clipboard now holds an empty string (non-text clipboard is read as `""` and "restored" as such). Known data-loss issue; note it, don't fail the run.

### TC-43 — Clipboard-only fallback (no synthetic paste)

1. Settings → Advanced/Output: set Paste Method = `None` and Clipboard Handling = `copy_to_clipboard`.
2. Dictate.
   **Expected:** no keystroke is sent to any app (nothing auto-inserted); the transcript **is on the clipboard** — `Cmd+V` manually pastes it. Overlay/tray behave normally.
3. Quirk check: this path still requires Enigo — with accessibility never granted it fails with a paste-error toast even though no keys would be synthesized (known quirk).
4. Restore Paste Method `ctrl_v`, Clipboard Handling `dont_modify`.

### TC-44 — Empty transcript (silence)

1. With VAD enabled (default), hold `Option+Space` for ~3 s in **silence**, release.
   **Expected (documents current behavior):** overlay hides, tray idles, **nothing is inserted, no toast** — the empty-result path is deliberately silent. Depending on whether VAD filtered all frames, History shows either no new entry or an entry with an empty/failed transcript. No crash, and the next dictation works normally.

---

## 5. Error states

### TC-50 — No model downloaded

1. Settings → Models: delete all downloaded models (or tray → Unload + delete). Keep the main window visible.
   **Expected:** models list shows nothing downloaded; tray model submenu is empty/unchecked.
2. Dictate (hold `Option+Space`, speak, release).
   **Expected:** recording itself starts and the overlay appears (model load happens in the background and its failure does not block recording). At release, transcription fails and a **transcription-error toast** appears in the main window (message includes "Model is not loaded for transcription."). Overlay hides, tray idles.
3. Check History.
   **Expected:** an entry exists with a failed/empty transcript and playable audio — the take is recoverable via Retry after re-downloading a model (see TC-63).

### TC-51 — Microphone permission denied

1. Quit app. `tccutil reset Microphone com.pais.handy`. Relaunch, and when the mic prompt fires on first recording attempt (or via onboarding), click **Don't Allow**. Alternatively toggle Handy OFF in System Settings → Privacy & Security → Microphone while the app is quit, then relaunch. Keep the main window visible.
2. Attempt to dictate.
   **Expected:** recording never starts — overlay appears briefly or not at all, tray returns to Idle, and a **recording-error toast** appears: microphone permission denied, directing you to System Settings → Privacy & Security → Microphone. The coordinator stays Idle (no stuck state): after granting permission, the very next shortcut press records normally without app restart.
3. Known macOS caveat: if mic access is revoked **while the app is running**, CoreAudio may deliver silence instead of an error — the symptom is then an empty transcript (TC-44 behavior) with **no** permission toast. Note it; don't fail the run.

### TC-52 — Accessibility denied (paste failure)

1. Quit app. `tccutil reset Accessibility com.pais.handy`. Relaunch. If routed to onboarding (TC-14), note it — for this test, get to the main UI with accessibility still missing (returning-user onboarding can be observed, then grant **microphone only** scenarios don't apply here; the practical variant is below).
   Practical variant: complete onboarding normally, quit, revoke accessibility in System Settings, relaunch.
   **Expected:** onboarding/permission banner appears (TC-14). Global shortcuts may be dead (the event tap needs accessibility) — if `Option+Space` does nothing, that is the expected upstream symptom; trigger recording via `--toggle-transcription` instead.
2. Dictate via `Handy --toggle-transcription` (twice) with the main window visible.
   **Expected:** recording and transcription succeed, but insertion fails: **paste-error toast** ("paste failed", generic) in the main window. Transcript is recoverable from History; detail is in `handy.log`.
3. Known limitation: if accessibility is revoked **while the app is running** (Enigo already initialized), paste reports success and text silently goes nowhere — no toast. Note, don't fail.

---

## 6. History verification

### TC-60 — Entry lifecycle for a successful dictation

1. Dictate a distinctive sentence. Open main window → **History** (sidebar).
   **Expected:** the new entry appears at the top **without a manual reload** (live `added` event), showing a locale-formatted timestamp and the transcript text.
2. Click the entry's audio player.
   **Expected:** the recording plays back and matches what you said (WAV from `~/Library/Application Support/com.pais.handy/recordings/handy-<unix_ts>.wav`, 16 kHz mono).
3. Click **Copy** on the entry, paste somewhere.
   **Expected:** clipboard now holds the entry's raw transcript.
4. Click the **open recordings folder** header button.
   **Expected:** Finder opens the `recordings/` directory containing the matching `handy-*.wav` files.

### TC-61 — Star and retention pruning

Default retention: `preserve_limit` with limit **5** — unsaved entries beyond the 5 newest are pruned on each new capture.

1. Star (save) one distinctive entry. Then perform short dictations until more than 5 unsaved entries have been created since.
   **Expected:** after the capture that exceeds the limit, the oldest **unsaved** entries' rows and WAV files are gone (verify in the recordings folder); the **starred** entry survives regardless of age. Known gap: the open History page does not live-update for pruned rows — navigate away and back (or relaunch) to confirm.

### TC-62 — Delete entry

1. Delete an entry via its delete action; note its `file_name` first.
   **Expected:** the row disappears immediately (optimistic) and the corresponding WAV is removed from `recordings/`.

### TC-63 — Retry re-transcribes but does not paste

1. Create a failed entry (easiest: TC-50 with no model, then re-download a model). In History, click **Retry** on the failed entry.
   **Expected:** the row shows a pulsing "transcribing" state, then updates in place with the new transcript. **No text is inserted anywhere and nothing is copied** — retry only updates the row (current defined behavior).
2. Retry on a normal (successful) entry.
   **Expected:** same — row text refreshes from a fresh transcription of the stored WAV.

### TC-64 — Tray "Copy Last Transcript"

1. Dictate a sentence. Tray menu → **Copy Last Transcript**. Paste somewhere.
   **Expected:** clipboard holds the most recent non-empty transcript (the post-processed text if post-processing ran, else the raw transcript).

---

## 7. Headless CLI smoke test (`--transcribe-file`)

Headless flags spawn a **standalone instance** (single-instance skipped), so these work even while the GUI app is running. Console logs go to **stderr**; stdout is machine-parseable. Binary: `/Applications/Handy.app/Contents/MacOS/Handy` (dev: `src-tauri/target/debug/handy`).

### TC-70 — `--list-models` and `--list-devices`

```bash
Handy --list-models; echo "exit=$?"
Handy --list-devices; echo "exit=$?"
```

**Expected:** downloaded models (ids matching the Settings UI) and compute devices (on macOS: Metal/CPU) are printed to stdout; both exit `0`.

### TC-71 — Transcribe a known WAV

Input must be **16 kHz mono 16-bit int PCM WAV**. Easiest sources: any file from `~/Library/Application Support/com.pais.handy/recordings/` (already exactly that format), or generate one:

```bash
say -o /tmp/qa-smoke.wav --file-format=WAVE --data-format=LEI16@16000 "testing one two three"
```

1. Run:
   ```bash
   Handy --transcribe-file /tmp/qa-smoke.wav --model <downloaded-model-id> --json
   echo "exit=$?"
   ```
   **Expected:** exit `0`; stdout is a single JSON object containing model, device, backend, load time, best transcription time, RTF, and the transcript text — the text contains "testing one two three" (synthesized-voice recognition errors on individual words are acceptable; empty text is a failure). No GUI window, tray icon, or overlay appears; the process exits cleanly (no hang, no crash on teardown).
2. Re-run without `--json`.
   **Expected:** human-readable `model/device/backend/load_ms/best_ms/rtf/text` lines on stdout; exit `0`.
3. Run with `--repeat 3 --json`.
   **Expected:** three timed runs; still exit `0` and valid output.

### TC-72 — Invalid WAV is rejected with exit code 2

```bash
say -o /tmp/qa-bad.wav --file-format=WAVE --data-format=LEI16@44100 "wrong rate"
Handy --transcribe-file /tmp/qa-bad.wav --model <model-id>; echo "exit=$?"
```

**Expected:** strict validation rejects the 44.1 kHz file with a clear error on stderr and **exit code 2** (exit `1` is reserved for runtime errors such as model load failure — verify that separately by passing a nonexistent `--model` id and expecting a non-zero exit with an error message).

---

## Appendix: quick regression pass order

For a fast smoke of a new build: TC-20 (golden path) → TC-30 (Esc cancel) → TC-42.1 (clipboard restore) → TC-60 (history) → TC-71 (headless). Full pass order as numbered above; run section 1 last if you want to avoid re-granting permissions mid-session.