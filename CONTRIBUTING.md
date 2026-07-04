# Contributing to Murmur

Thank you for your interest in contributing to Murmur! This guide will help you get started with contributing to this speech-to-text application.

> Murmur is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais. If you want to contribute to the original app, its ecosystem, or its community, do so upstream at [cjpais/Handy](https://github.com/cjpais/Handy) (see upstream's own contributing guidelines). This document covers contributing to **this fork**.

## 📖 Philosophy

Murmur builds on Handy's foundation — a well-patterned, simple codebase. We prioritize:

- **Simplicity**: Clear, maintainable code over clever solutions
- **Privacy**: Keep everything local and offline
- **Product quality**: Polished, reliable behavior on the golden dictation path

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- Platform-specific build tools (see [BUILD.md](BUILD.md))

### Setting Up Your Development Environment

1. **Fork the repository** on GitHub

2. **Clone your fork**:

   ```bash
   git clone git@github.com:YOUR_USERNAME/murmur.git
   cd murmur
   ```

3. **Add upstream remote** (this repo):

   ```bash
   git remote add upstream https://github.com/kylebegeman/murmur.git
   ```

4. **Install dependencies**:

   ```bash
   bun install
   ```

5. **Download required models** (hosted on upstream Handy's model CDN):

   ```bash
   mkdir -p src-tauri/resources/models
   curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx
   ```

6. **Run in development mode**:
   ```bash
   bun run tauri dev
   # On macOS if you encounter cmake errors:
   CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
   ```

For detailed platform-specific setup instructions, see [BUILD.md](BUILD.md).

### Understanding the Codebase

Murmur follows a clean architecture pattern:

**Backend (Rust - `src-tauri/src/`):**

- `lib.rs` - Main application entry point with Tauri setup
- `managers/` - Core business logic (audio, model, transcription)
- `audio_toolkit/` - Low-level audio processing (recording, VAD)
- `commands/` - Tauri command handlers for frontend communication
- `shortcut.rs` - Global keyboard shortcut handling
- `settings.rs` - Application settings management

**Frontend (React/TypeScript - `src/`):**

- `App.tsx` - Main application component
- `components/` - React UI components
- `hooks/` - Reusable React hooks
- `lib/types.ts` - Shared TypeScript types

For more details, see the Architecture section in [README.md](README.md) or [AGENTS.md](AGENTS.md).

## 🐛 Reporting Bugs

### Before Submitting a Bug Report

1. **Search existing issues** at [github.com/kylebegeman/murmur/issues](https://github.com/kylebegeman/murmur/issues)
2. **Try the latest build** to see if the issue has been fixed
3. **Enable debug mode** (`Cmd/Ctrl+Shift+D`) to gather diagnostic information
4. **Check upstream** — if the bug also exists in [Handy](https://github.com/cjpais/Handy/issues), it may be inherited; note that in the report

### Submitting a Bug Report

When creating a bug report, please include:

**System Information:**

- App version (found in settings or about section)
- Operating System (e.g., macOS 14.1, Windows 11, Ubuntu 22.04)
- CPU (e.g., Apple M2, Intel i7-12700K, AMD Ryzen 7 5800X)
- GPU (e.g., Apple M2 GPU, NVIDIA RTX 4080, Intel UHD Graphics)

**Bug Details:**

- Clear description of the bug
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots or logs if applicable
- Information from debug mode if relevant

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) when creating an issue.

## 💡 Suggesting Features

Feature requests go in [GitHub Discussions](https://github.com/kylebegeman/murmur/discussions) rather than issues. This keeps issues focused on bugs and actionable tasks.

When suggesting a feature, describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## 🔧 Making Code Contributions

### Before You Start

**Search existing issues and PRs first** — check both open AND closed issues and pull requests. Someone may have already addressed this, or there may be a reason it was closed.

- [Open issues](https://github.com/kylebegeman/murmur/issues)
- [Closed issues](https://github.com/kylebegeman/murmur/issues?q=is%3Aissue+is%3Aclosed)
- [Open PRs](https://github.com/kylebegeman/murmur/pulls)
- [Closed PRs](https://github.com/kylebegeman/murmur/pulls?q=is%3Apr+is%3Aclosed)

For larger changes, open a discussion or issue first to align on direction before writing code.

### Development Workflow

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes**:
   - Write clean, maintainable code
   - Follow existing code style and patterns
   - Add comments for complex logic
   - Keep commits focused and atomic

3. **Test thoroughly**:
   - Test on your target platform(s)
   - Verify existing functionality still works
   - Test edge cases and error conditions
   - Use debug mode to verify audio/transcription behavior

4. **Commit your changes**:

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   # or
   git commit -m "fix: describe the bug fix"
   ```

   Use conventional commit messages:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `refactor:` for code refactoring
   - `test:` for test additions/changes
   - `chore:` for maintenance tasks

5. **Keep your fork updated**:

   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

6. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**:
   - Go to the [Murmur repository](https://github.com/kylebegeman/murmur)
   - Click "New Pull Request"
   - Select your fork and branch
   - Fill out the PR template completely, including:
     - Clear description of changes
     - Links to related issues or discussions
     - How you tested the changes
     - Screenshots/videos if applicable
     - Breaking changes (if any)

### AI Assistance Disclosure

**AI-assisted PRs are welcome!** Use whatever tools help you contribute, just be upfront about it.

In your PR description, please include:

- Whether AI was used (yes/no)
- Which tools were used (e.g., "Claude Code", "GitHub Copilot", "ChatGPT")
- How extensively it was used (e.g., "generated boilerplate", "helped debug", "wrote most of the code")

### Code Style Guidelines

**Rust:**

- Follow standard Rust formatting (`cargo fmt`)
- Run `cargo clippy` and address warnings
- Use descriptive variable and function names
- Add doc comments for public APIs
- Handle errors explicitly (avoid unwrap in production code)

**TypeScript/React:**

- Use TypeScript strictly, avoid `any` types
- Follow React hooks best practices
- Use functional components
- Keep components small and focused
- Use Tailwind CSS for styling

**General:**

- Write self-documenting code
- Add comments for non-obvious logic
- Keep functions small and single-purpose
- Prioritize readability over cleverness

### Testing Your Changes

**Manual Testing:**

- Run the app in development mode: `bun run tauri dev`
- Test your changes with debug mode enabled
- Verify on multiple platforms if possible
- Test with different audio devices
- Try various transcription scenarios

**Building for Production:**

```bash
bun run tauri build
```

Test the production build to ensure it works as expected.

## 📝 Documentation Contributions

Documentation improvements are highly valued! You can contribute by:

- Improving README.md, BUILD.md, or this CONTRIBUTING.md
- Adding code comments and doc comments
- Creating tutorials or guides
- Improving error messages

## 🤝 Community Guidelines

- **Be respectful and inclusive** - We welcome contributors of all skill levels
- **Be patient** - This is maintained by a small team, responses may take time
- **Be constructive** - Focus on solutions and improvements
- **Be collaborative** - Help others and share knowledge
- **Search first** - Check existing issues/discussions before creating new ones

## 📞 Getting Help

- **Discussions**: Ask questions in [GitHub Discussions](https://github.com/kylebegeman/murmur/discussions)

## 📜 License

By contributing to Murmur, you agree that your contributions will be licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

**Thank you for contributing to Murmur!** Your efforts help make speech-to-text technology more accessible, private, and useful for everyone.
