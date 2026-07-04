# Lumen Model Lab Reference

Source explored: `/Users/kyle/Developer/products/lumen` (pnpm monorepo: `apps/web`, `apps/server`, `packages/contracts`, `packages/shared`, `packages/ui-react`, etc.). Lumen has a literal, shipped "Model Lab" area for LLM endpoints/artifacts — the closest existing analog to a Murmur Model Lab for local speech models.

> **Caveat — do NOT adopt `packages/ui-react` wholesale.** `/Users/kyle/Developer/products/lumen/packages/ui-react` is "Lumen Kits" — a reusable React UI kit for products built _by_ Lumen (navigation-shell, marketing-pricing, auth-flow, settings), not Lumen's own app chrome. Lumen's Model Lab itself is built from app-local components in `apps/web/src/components/ui/` and `apps/web/src/components/area/`. Borrow the concepts and interaction patterns documented below; do not add Lumen packages as dependencies.

---

## 1. Where the Model Lab lives in Lumen

| Concern                                                                                                                                                 | Lumen path                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Area/surface registration (8 surfaces: endpoints, discovery, fit, downloads, serve-presets, benchmarks, tiny-agents, training; per-surface `riskLevel`) | `/Users/kyle/Developer/products/lumen/packages/contracts/src/areas.ts` (lines ~894–913)                                                           |
| Area shell (breadcrumb header, status-rows side card, surface switch)                                                                                   | `/Users/kyle/Developer/products/lumen/apps/web/src/components/modelLab/ModelLabAreaShell.tsx`                                                     |
| All surface UIs (2,243 lines: rows, metric grids, forms, queries/mutations)                                                                             | `/Users/kyle/Developer/products/lumen/apps/web/src/components/modelLab/ModelLabSurfaces.tsx`                                                      |
| Pure presentation logic (summaries, sorting, labels, formatters, provider presets) — separately unit-tested                                             | `/Users/kyle/Developer/products/lumen/apps/web/src/components/modelLab/ModelLabSurfaces.logic.ts` (+ `.logic.test.ts`)                            |
| Sidebar nav grouping ("Serving" / "Models" / "Experiments")                                                                                             | `/Users/kyle/Developer/products/lumen/apps/web/src/components/sidebar/ModelLabLens.tsx`                                                           |
| Model artifact contract (download lifecycle, import plans, serve presets, benchmark run/report, training)                                               | `/Users/kyle/Developer/products/lumen/packages/contracts/src/modelArtifacts.ts`                                                                   |
| Endpoint/capability contract (kinds, locality, capability profile, health, probes, routing)                                                             | `/Users/kyle/Developer/products/lumen/packages/contracts/src/modelEndpoints.ts`                                                                   |
| Hugging Face catalog contract                                                                                                                           | `/Users/kyle/Developer/products/lumen/packages/contracts/src/hfCatalog.ts`                                                                        |
| HF catalog service (live HF API search, sorted by downloads, file manifests)                                                                            | `/Users/kyle/Developer/products/lumen/apps/server/src/modelCatalog/Layers/HfCatalogService.ts`                                                    |
| Hardware detection (CPU/RAM/GPU/VRAM/accelerator probe, persisted as a "capability report" artifact)                                                    | `/Users/kyle/Developer/products/lumen/apps/server/src/modelEndpoints/Layers/HardwareCapabilityDetector.ts`                                        |
| RAM/VRAM → fit-verdict heuristic (shared client+server)                                                                                                 | `/Users/kyle/Developer/products/lumen/packages/shared/src/modelHardware.ts`                                                                       |
| Benchmark runner (fan-out probes across endpoints × artifacts, concurrency 4, timeout-capped)                                                           | `/Users/kyle/Developer/products/lumen/apps/server/src/modelArtifacts/Layers/ModelBenchmarkRunner.ts`                                              |
| Serve-preset planner (artifact × runtime-family matrix)                                                                                                 | `/Users/kyle/Developer/products/lumen/apps/server/src/modelArtifacts/Layers/ModelServePlanner.ts`                                                 |
| Download job runner (planned → downloading → ready/failed, gated execution, progress phases)                                                            | `/Users/kyle/Developer/products/lumen/apps/server/src/modelArtifacts/Layers/ModelDownloadJobRunner.ts`                                            |
| Design rationale/history for the whole lifecycle                                                                                                        | `/Users/kyle/Developer/products/lumen/docs/archive/2026-07-pre-v1/lumen-cockpit-implementation/roadmap/phases/54-local-ai-model-lab-lifecycle.md` |

---

## 2. Concepts found, and the Murmur mapping

Murmur already has the raw material: `src-tauri/src/managers/model.rs` (`ModelInfo` with `size_mb`, `partial_size`, `engine_type`, `accuracy_score`/`speed_score` 0.0–1.0), `src-tauri/src/managers/model_capabilities.rs`, and `src/components/model-selector/` (dropdown + `DownloadProgressDisplay`). Lumen shows how to grow that into a lab.

### 2.1 Catalog browsing

**Lumen:** `HfCatalogEntry` (`packages/contracts/src/hfCatalog.ts`) carries `repoId`, `task` (includes `"automatic-speech-recognition"` — the taxonomy already anticipates speech), `library`, `license`, `gated`, `downloads`, `likes`, `tags`, `defaultRevision`. The Discovery surface (`ModelLabSurfaces.tsx` ~1629–1763) renders a search input + `CatalogEntryRows` (~843–899): each row shows a **Gated/Open badge**, task badge, license/downloads/likes meta, and a single **"Plan"** action. Planning is two-phase: `planImport` picks files (prefers `.gguf`, falls back to `.safetensors` — see `usePlanCatalogDownloadMutation`, ~1373–1411) and creates a _planned_ artifact with `totalBytes`, `requiresApproval`, `gated` before any bytes move.

**Murmur mapping:** A catalog pane listing available speech models (Whisper GGUF/GGML family via transcribe-cpp, Parakeet/Moonshine/SenseVoice ONNX via transcribe-rs) with per-row badges for engine, license, and size, and a **plan-before-download** step that shows total bytes and target path before committing. Murmur's static curated list in `model.rs` maps to Lumen's "planned artifacts"; a remote curated JSON (like `blob.handy.computer`) plays the role of the HF API. Key interaction to borrow: _catalog row → "Plan" → planned artifact appears in Downloads with explicit size — download is a separate, deliberate act._

### 2.2 Download state / artifact registry

**Lumen:** `ModelArtifactState = "planned" | "downloading" | "verifying" | "ready" | "failed" | "removed"` (`modelArtifacts.ts` lines 87–95). `ArtifactStateBadge` (`ModelLabSurfaces.tsx` ~799) maps states to badge variants (ready→success, failed→error, downloading/verifying→warning). `ModelArtifactMetricGrid` (~815) shows a 4-tile summary: **Artifacts / Ready / Active / Stored (total bytes)**. Rows show format badge, source, human size (`formatModelArtifactSize`, `.logic.ts` 216–221), relative updated time, monospace cache path, and a Remove action. `ModelDownloadJobRunner.ts` emits job progress phases with labels ("Starting download", "Model download is waiting for approval", failed/succeeded summaries).

**Murmur mapping:** Murmur already tracks `partial_size`; adopt the explicit six-state enum (notably **`verifying`** — checksum after download, which Murmur lacks — and **`planned`**). Give the Model Lab a top metric strip (Models / Ready / Downloading / Disk used) and per-row state badges + cache path, replacing progress-only UX. `formatModelArtifactSize` and the badge-variant mapping are directly portable one-liners.

### 2.3 Provider / runtime selection

**Lumen:** Two-layer split worth copying conceptually:

- **Artifact** (bytes on disk: `format: gguf | safetensors | ollama | lora | ...`) vs. **endpoint/runtime** (`ModelEndpointKind`: ollama, llama.cpp, vLLM, SGLang…; `modelEndpoints.ts` 44–55).
- `ModelServePlanner.ts` generates the cross-product: for each ready artifact, one `ModelServePreset` per runtime family, each with a `fitHint` and `requiresApproval`. `ServePresetRows` (`ModelLabSurfaces.tsx` ~964–1053) badges each preset "recommended vs Not favored" based on `fitHint.viablePresetFamilies.includes(preset.endpointKind)`.
- Registration presets for known providers (`MODEL_ENDPOINT_PROVIDER_PRESETS`, `.logic.ts` 270–349): pick "Ollama local" and the form pre-fills id/kind/locality/baseUrl.

**Murmur mapping:** Murmur's `EngineType` (TranscribeCpp vs transcribe-rs/ONNX) is the runtime family; GPU backend (Metal/Vulkan/CPU) is the preset dimension. A Murmur Model Lab should show, per model, _which engine + acceleration path will run it_ and mark the recommended one, instead of hiding engine choice. The pre-filled-preset form pattern maps to "Add custom model" (pre-fill known Whisper GGUF URLs/paths per variant).

### 2.4 Local vs remote capability display

**Lumen:** `ModelEndpointLocality = "local" | "lan" | "remote" | "cloud"` (`modelEndpoints.ts` 57–58), rendered as a plain meta label on every endpoint row and used for filtering (`buildModelEndpointSummary` counts local+lan as "Local"; Discovery surface filters to local endpoints). `ModelEndpointRoutingMetadata` adds `localOnlyHints` and `requiresExplicitSelection` — cloud/keyed endpoints are never auto-selected (`buildModelEndpointDescriptorFromDraft`, `.logic.ts` 351–389, sets `requiresExplicitSelection` whenever a secret ref or cloud locality is present).

**Murmur mapping:** Murmur is local-first, but the pattern still applies if a remote/OpenAI-compatible STT endpoint is ever added: a `locality` field on every model entry, a "Local" count tile, and `requiresExplicitSelection: true` for anything non-local (never silently route audio off-device). Even today, "bundled vs downloaded vs custom-path" is a locality-like axis worth a badge.

### 2.5 Speed / accuracy / memory labeling

**Lumen (richest reusable idea):**

- `ModelCapabilityProfile` (`modelEndpoints.ts` 99–133): capability booleans + `observedTokensPerSecond` (measured, not claimed), `reliabilityScore` 0–100, `costTier`.
- `HardwareCapabilityProfile` (242–264): platform/arch/cores/RAM/VRAM/GPUs/accelerators + `fitTier: minimal|modest|capable|workstation` and a `partial` flag when probes were incomplete.
- `deriveServeFitHint` (`packages/shared/src/modelHardware.ts`): a pure, threshold-table function mapping VRAM/RAM → `{ verdict: fits|tight|cpu-only|insufficient|unknown, quantizationCeiling, maxModelParamsB, rationale }`. Every verdict ships a human-readable **rationale sentence**.
- UI: `formatFitVerdict`/`fitVerdictVariant` (`ModelLabSurfaces.tsx` 149–178) map verdicts to labels and badge colors; `HardwareCapabilityPanel` (~1104–1193) shows a CPU/RAM/VRAM/Fit tile row with a "Re-detect" button.

**Murmur mapping:** Murmur's static `accuracy_score`/`speed_score` floats become one axis; port `deriveServeFitHint` as a speech-model version: (model size, engine, quantization) × (detected RAM/VRAM/Metal/Vulkan from a Rust hardware probe) → `fits / tight / cpu-only / insufficient` badge per catalog entry **with a rationale sentence** ("Large-v3 will run but leaves little headroom; Turbo recommended on 8 GB"). Keep the function pure and shared (Rust core + TS bindings) exactly as Lumen keeps it in `packages/shared` so client and server render identical verdicts. The `partial: true` flag for incomplete hardware detection is a nice honesty detail.

### 2.6 Benchmark UX

**Lumen:**

- Contract: `ModelBenchmarkRunInput { kind: fit|benchmark, endpointIds[], artifactIds[], timeoutMs ≤ 30s, persist }` → `ModelBenchmarkReport { endpointId, artifactId, probeResult (status + latencyMs + capabilityUpdates), fitHint, createdAt }` (`modelArtifacts.ts` 305–335).
- Runner (`ModelBenchmarkRunner.ts`): empty selection = "benchmark everything enabled/ready" default; fan-out endpoints × artifacts with `concurrency: 4`; probes measure wall-clock `latencyMs` (`ModelEndpointProber.ts` ~496) and can write back `capabilityUpdates` to the profile.
- UI (`ModelLabBenchmarksSurface`, `ModelLabSurfaces.tsx` 1940–2035): one **"Run"** button, then a summary tile row (**Reports / Healthy / Degraded / Avg latency**) + `BenchmarkReportRows` with health badge, fit badge, latency meta, relative timestamps. Reports are explicitly scoped: _"Reports are scoped to the latest run from this surface."_ Results also persist as artifacts (`ModelEndpointArtifactKind: fit-report | benchmark-report | probe-log | capability-report`, `modelEndpoints.ts` 181–188).

**Murmur mapping:** "Benchmark" = transcribe a bundled sample WAV (or the user's last recording, or user-picked file) through each selected model. Report per model: load time, RTF/x-realtime speed (Murmur's analog of latencyMs / tokens-per-sec), peak memory, and — if a reference transcript exists for the bundled sample — WER as the accuracy column. Borrow: single Run button; select-none-means-all default; hard timeout; concurrency cap (probably 1 for speech models due to memory); summary tiles above rows; persist reports so measured numbers can replace the hardcoded `speed_score`/`accuracy_score` ("observed" beats "claimed" — Lumen's `observedTokensPerSecond` naming makes that distinction explicit).

### 2.7 Comparison UI

**Lumen:** Comparison is deliberately lightweight — no side-by-side table. It is _uniform rows + shared badge vocabulary + shared summary tiles_, sorted by health then name (`sortByHealthAndName`, `.logic.ts` 87–104). The "fit" surface stacks `HardwareCapabilityPanel` on top of the benchmark surface in fit mode (`ModelLabHardwareFitSurface`, 1899–1938) so hardware context and per-model verdicts read as one comparison. The generic row primitive is `AreaListRow` (title / badges / meta / detail / actions) + `MetricTile` + `MetaChip` in `apps/web/src/components/area/`.

**Murmur mapping:** For 5–15 speech models, copy this: one consistent row layout (name, state badge, engine badge, fit badge; meta = size · speed · accuracy · last benchmarked; detail = rationale sentence; actions = Download/Benchmark/Set default), a 4-tile summary strip, and health-first sorting (ready models first, then by fit). Only add a true side-by-side table if benchmark history grows.

### 2.8 Default selection

**Lumen:** `defaultModelId` on `ModelEndpointDescriptor` plus `isDefault`/`enabled` per model-list entry (`modelEndpoints.ts` 135–148, 407–409). Display fallback chain in `defaultModelLabel` (`ModelLabSurfaces.tsx` 294–296): explicit default → first model → `"Not selected"`. Routing metadata (`preferredFor` / `disallowedFor` per use-case, `fallbackEndpointIds`) generalizes defaulting to per-task defaults.

**Murmur mapping:** Murmur has one global selected model. Borrow (a) the visible "default" chip on the row rather than only a dropdown selection, and (b) `preferredFor`-style per-context defaults as a future shape (e.g., a fast model for push-to-talk vs. an accurate model for post-processed transcription — Murmur already has `--toggle-post-process` as a second pipeline that could carry its own default). Also borrow `enabled` as distinct from downloaded: hide a model from the quick-picker without deleting its files.

### 2.9 Streaming-capability display

**Lumen:** `supportsStreaming` is a first-class boolean in `ModelCapabilityProfile` (`modelEndpoints.ts` line 109), alongside graded enums (`ModelToolCallingSupport: unknown|none|basic|parallel`). Notably, the web UI **does not yet render** `supportsStreaming`/`observedTokensPerSecond` anywhere — the contract is ahead of the display. Capability values start `"unknown"` and get upgraded by probes (`capabilityUpdates` on `ModelEndpointProbeResult`).

**Murmur mapping:** Two lessons. (1) Model the capability explicitly: Murmur's `model_capabilities.rs` should carry `supports_streaming` (partial/live transcription), `supports_translation`, `supports_word_timestamps`, languages — as data on `ModelInfo`, not as code branches — and render them as capability chips on the row and in the picker (a "Live" chip matters when choosing a model for push-to-talk). (2) Use graded `unknown → confirmed` values: default to `unknown` and let a benchmark run confirm, mirroring Lumen's probe-upgrades-profile flow. Don't repeat Lumen's gap — actually render the chips.

### 2.10 Reusable interaction ideas (cross-cutting)

- **Five-state surface machine:** `resolveModelLabSurfaceState` (`.logic.ts` 106–150) — `no-environment | loading | error | empty | ready`, each with title+description; skeleton rows while loading, actionable empty states ("Run local discovery or register an endpoint…"). Directly portable to any Murmur Lab pane.
- **Logic/presentation split:** every summary, sort, label map, and formatter is a pure function in `ModelLabSurfaces.logic.ts` with its own test file — no rendering needed to test the lab's brains. Murmur equivalent: pure TS module + Vitest, or Rust functions + `#[cfg(test)]`.
- **Read-only by default, gated writes:** discovery/probes/benchmarks never mutate; downloads and serve-starts are gated jobs with receipts, and surfaces are tagged `riskLevel` in `areas.ts`. Murmur analog: browsing/benchmarks free; download/delete confirmed with byte counts shown up front.
- **Pending-state per row:** mutations track `pendingArtifactId`/`pendingKey` so only the acted-on row shows "Removing/Planning/Probing" while siblings stay interactive (see `ModelArtifactRows`, `ServePresetRows`).
- **Re-detect / Refresh affordances everywhere:** hardware panel "Re-detect", registry "Refresh", benchmark "Run" — cached results shown with relative timestamps (`formatRelativeTimeLabel`) so staleness is visible.
- **Sidebar grouping:** `ModelLabLens.tsx` groups 8 surfaces into Serving / Models / Experiments with the comment "the nav panel navigates" (no stats in nav). Murmur likely needs only Catalog / Downloads / Benchmarks — one settings section, same grouping instinct.

---

## 3. Suggested Murmur Model Lab shape (synthesis)

1. **Catalog surface** — curated speech-model list (rows: name, engine badge, size, fit badge with rationale, capability chips incl. streaming/translation, license); plan → download two-step with total bytes shown. (Concepts from `hfCatalog.ts`, `CatalogEntryRows`, `deriveServeFitHint`.)
2. **Downloads/artifacts surface** — six-state lifecycle incl. `verifying`; metric tiles (Models/Ready/Downloading/Disk); cache path per row; remove with per-row pending state. (`modelArtifacts.ts`, `ModelArtifactRows`, `ModelDownloadJobRunner.ts`.)
3. **Hardware panel** — one-time + re-detectable probe (RAM, VRAM, Metal/Vulkan/CPU-AVX from Murmur's existing platform detection), CPU/RAM/VRAM/Fit tiles, `partial` honesty flag. (`HardwareCapabilityDetector.ts`, `HardwareCapabilityPanel`.)
4. **Benchmark surface** — Run button over ready models × sample audio; timeout-capped; reports: load time, x-realtime, peak RAM, optional WER; summary tiles; persist reports and promote observed numbers over hardcoded scores. (`ModelBenchmarkRunner.ts`, `ModelLabBenchmarksSurface`.)
5. **Default selection** — visible default chip, `enabled` toggle separate from downloaded, future per-pipeline defaults via a `preferredFor`-style field. (`modelEndpoints.ts` routing metadata.)
6. Keep all verdict/summary/formatting logic in pure, tested modules; keep the UI five-state; keep writes explicit and byte-transparent.
