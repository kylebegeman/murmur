# Rebrand Decisions — Handy → Murmur (Phase A)

Decision record for the identity changes applied in Phase A of the rebrand. Factual reference; revisit only with cause.

## Identity

- **App display name:** Murmur (`productName: "Murmur"` in `src-tauri/tauri.conf.json`)
- **Bundle identifier:** `com.kylebegeman.murmur` (was `com.pais.handy`)
- **Fork repo:** https://github.com/kylebegeman/murmur — upstream: https://github.com/cjpais/Handy by CJ Pais (credited, not erased)

## Decisions

### 1. Bundle identifier changed to `com.kylebegeman.murmur`

Changing the identifier resets macOS TCC permission grants (microphone, accessibility) and moves the app-data directory (`~/Library/Application Support/com.kylebegeman.murmur/`, log dir `~/Library/Logs/com.kylebegeman.murmur/`). This is acceptable **pre-launch**: there are no Murmur users to migrate. An installed Handy app's data remains untouched under the old `com.pais.handy` id — no migration is performed and none is planned; the two apps coexist.

### 2. Updater fails closed

`plugins.updater` endpoint now points at the fork (`https://github.com/kylebegeman/murmur/releases/latest/download/latest.json`) and `pubkey` is deliberately **empty**, so signature verification can never pass — the updater fails closed instead of ever accepting an artifact signed with upstream's key or an unsigned one.

**BEFORE FIRST RELEASE:** run `bunx tauri signer generate`, set the generated public key as `pubkey` in `tauri.conf.json`, keep the private key in CI secrets (`TAURI_SIGNING_PRIVATE_KEY`), and publish `latest.json` + signed updater artifacts with each release.

### 3. Windows `signCommand` removed

The upstream Windows code-signing hook was removed from the bundle config; it invoked upstream's signing identity/infrastructure, which this fork does not have. Windows releases need their own signing identity (e.g. Azure Trusted Signing) before distribution.

### 4. Icon/wordmark artwork is a temporary placeholder — launch blocker

The current icon artwork (`src-tauri/icons/**`, `src-tauri/resources/murmur.png`) is still the upstream Handy glove glyph, kept only as a development placeholder. Upstream's branding terms:

> "Handy is open-source software, but the Handy name, logo, icon, and brand assets are not open-source. Unofficial forks, rewrites, and redistributions must use their own branding and must not imply endorsement or affiliation."

Original Murmur artwork **MUST** replace all icon/wordmark assets before any distribution (releases, screenshots in marketing, store listings). The in-app wordmark component was already replaced with a `MurmurTextLogo` text placeholder.

### 5. Donate button removed; attribution row added

The in-app donate button pointed at upstream funding channels (which fund Handy, not this fork), and `.github/FUNDING.yml` likewise listed upstream's sponsors — both removed. In their place, the About screen carries a "Based on Handy by CJ Pais" attribution row linking upstream. The README keeps a pointer to upstream's sponsorship instead of a Sponsors section.

## Deferred to Phase B (not done in Phase A — deliberate)

- **Crate/binary rename** (`handy`, `handy_app_lib` → murmur equivalents), including the Nix package attr/pname/mainProgram (`flake.nix`, `nix-check.yml`'s `.#handy`) and the CI smoke tests that assert cargo target paths (`src-tauri/target/*/handy`). Docs currently note the dev binary is still `handy`.
- **`HANDY_*` env var renames** (`HANDY_NO_GTK_LAYER_SHELL`, `HANDY_VC_REDIST_DIRS`) — must land in lockstep with the CI workflows and Rust code that set/read them.
- **Model infrastructure migration** off `blob.handy.computer` (model CDN, ONNX Runtime archives, silero VAD) and the `handy-computer` Hugging Face org (`scripts/gen_catalog.py` `ORG`) to Murmur-owned hosting.
- **Distribution channels** (Homebrew cask, winget, website) — Murmur is not distributed anywhere yet; upstream's channels ship Handy only.
