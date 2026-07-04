# Murmur Product Plan

Murmur is a renamed, re-skinned, productized continuation of the open-source
[Handy](https://github.com/cjpais/Handy) voice dictation app. It is not a
rewrite. It evolves the Handy codebase in place, keeping the same stack
(Rust / Tauri 2 / React / TypeScript) and, above all, keeping Handy's working
dictation core intact: microphone permissions, recording lifecycle, local model
loading, live streaming transcription, overlay behavior, finalization, text
insertion/paste, history, and macOS behavior.

## Primary principle

Murmur must be a reliable daily dictation app before it becomes an ambitious
product. The golden path is sacred:

> Press shortcut → speak → see live transcription → finish recording → text
> appears in the focused app, or a clear fallback is shown.

Every change is judged against this path. If a change risks breaking it, the
change is isolated behind a setting or deferred.

## Core decisions

- Start from the Handy repo and evolve it in place into Murmur. No Electron
  rewrite, no port to a separate app.
- Do not replace the working recording/paste pipeline unless there is a
  concrete bug and a tested replacement.
- Rename/rebrand only after the working flow is understood and documented.
- No huge architecture rewrite before daily dictation behavior is preserved.
- No paid API dependence as a requirement. Optional cheap/local cleanup is fine
  later; local/basic behavior must always work.
- Never allow silent failure after a recording. The user always learns what
  happened to their words.

## Selected feature scope

### Minor features and improvements

1. **Dictation core reliability pass** — protect the core loop with smoke
   tests and manual QA scripts covering recording start, live preview, final
   transcript, paste/insertion, cancellation, and error states. No silent
   failure after recording.
2. **Insertion result feedback** — after finalization, clearly show whether
   text was inserted, copied, failed to paste, the target changed, or the
   transcript was empty. Recovery actions: copy transcript, retry paste, open
   history item.
3. **Live overlay polish** — preserve Handy's working overlay pipeline;
   improve visual polish: live transcript layout, committed/tentative text,
   waveform, timer, cancel/finalizing states, spacing, animation, placement.
   Do not break existing live streaming behavior.
4. **Better first-run setup** — guided setup for microphone permission,
   accessibility/paste permission, model selection/download, shortcut setup,
   and a test dictation. The user should know when Murmur is ready.
5. **Shortcut profiles** — multiple shortcut behaviors: toggle dictation,
   hold-to-talk if feasible, raw dictation, polished dictation, copy-only,
   retry last transcript. Defaults stay simple and reliable.
6. **Recent captures panel** — grow history into a useful recent captures
   surface: transcript, audio path, model used, duration, insertion
   target/status, retry actions, copy actions.
7. **Transcript cleanup presets** — configurable cleanup modes: raw, clean
   punctuation, email style, notes style, command style, preserve exact
   wording. Optional; local/basic behavior works without paid APIs.
8. **Model status clarity** — make active/downloaded/loading/streaming-capable
   states obvious; show speed/accuracy/memory/language capability labels where
   available.
9. **Settings search and command menu** — a searchable settings or command
   interface for common actions: model selection, shortcut, overlay, paste
   mode, history, cleanup preset.

### Major features, systems, and refactors

1. **Murmur Model Lab** — inspired by Lumen's model/provider concepts: model
   catalog browsing, downloads, local availability, benchmarking, comparison,
   selected default model, speed/accuracy/memory labels, streaming support,
   and test transcription. Makes local speech model choice understandable.
2. **Dictation workflow engine** — move from "record then transcribe" to
   configurable workflows. A workflow can capture audio, transcribe,
   optionally clean up, transform, insert, copy, save, or run a specific
   preset. Shortcuts eventually map to workflows.
3. **Whisperflow-style floating dictation UX** — a premium floating dictation
   experience: live transcript, waveform, timer, finalizing state,
   inserted/copied/failure result, and recovery affordances. Fast, polished,
   confidence-building.
4. **Audio diagnostics and QA lab** — tools to debug local capture quality:
   input device, sample rate, levels, clipping, silence detection, stream
   errors, test recording, and quality hints. Diagnose mic/model/paste
   problems without guessing.

## Work order

1. ✅ Inspect Handy's architecture and document the existing dictation
   pipeline (see `docs/scratchpad/architecture/`).
2. ✅ Identify exact files/functions for recording, streaming transcription,
   overlay updates, finalization, paste/insertion, model management, history,
   settings, shortcuts, and permissions.
3. Rename/rebrand to Murmur — only now that the working flow is documented,
   and without breaking the golden path.
4. ✅ This product plan.
5. Reliability + insertion-feedback pass first (it protects everything else).
6. Then: better setup, overlay polish, model status clarity, recent captures.
7. Then: Model Lab and workflow engine.

## Non-goals for now

- Restarting the Electron rewrite.
- Replacing the working Handy recording/paste pipeline without a concrete bug
  and a tested replacement.
- Big architecture rewrites ahead of preserving daily dictation behavior.
- Requiring paid APIs for core functionality.

## Verification expectations

Every milestone must preserve:

- Shortcut starts recording.
- Live overlay appears.
- Live text streams for streaming-capable models.
- Finishing recording finalizes the transcript.
- Text inserts into the focused app, or a clear fallback appears.

Manual QA steps for macOS permissions and paste behavior are documented in
`docs/operations/qa-golden-path.md`. Run the project's build/typecheck/lint
commands after meaningful changes (`bun run build`, `cargo check`,
`bun run lint`, `bun run format:check`). When changing model, overlay,
shortcut, or paste logic, test the actual app manually (`bun run tauri dev`).

## Reference material

- Upstream Handy repo: https://github.com/cjpais/Handy (note: upstream is
  under a feature freeze; Murmur diverges in this fork and does not send
  product features upstream).
- Prior Murmur (Electron) workspace, reference only:
  `/Users/kyle/Developer/products/murmur` — see
  `docs/scratchpad/architecture/prior-murmur-notes.md`.
- Lumen, Model Lab concept reference: `/Users/kyle/Developer/products/lumen` —
  see `docs/scratchpad/architecture/lumen-model-lab-reference.md`. Do not
  adopt Lumen's `packages/ui-react` wholesale; borrow concepts and
  interaction patterns, not dependencies.
