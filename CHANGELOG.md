# Changelog

All notable changes to the Gearlynx Debugger extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-06-25

### Changed

- Remove the no-op Open VSX publish step and the unused `ovsx` dependency.
- Replace the extension icon with a transparent-background version.
- Add `docs/PUBLISHING.md` and `scripts/setup-marketplace-oidc.ps1` (excluded
  from the packaged VSIX).

## [0.0.2] - 2026-06-25

### Changed

- Exclude `AGENTS.md` and README screenshots from the packaged VSIX.
- Bump `azure/login` and `softprops/action-gh-release` to v3 (Node 24 runtime).

## [0.0.1] - 2026-06-25

### Added

- Test release to validate the Microsoft Entra ID / GitHub OIDC publishing
  pipeline.

## [0.1.0] - Unreleased

### Added

- Initial public release.
- Source-level debugging for C and 6502 assembly via cc65 `.dbg` files, with
  `.sym` symbol-file fallback.
- Step controls (in/over/out/frame), frame-level step back, source-line stepping,
  call stack, disassembly view, and goto-target support.
- Breakpoints: source, conditional, hit-count, logpoints, data/watchpoints,
  function, and instruction breakpoints.
- Variable and memory inspection: registers and flags, locals, globals, zero page,
  hardware status, memory read/write, watch expressions, and hover evaluation.
- Overlay detection and runtime overlay selection for banked ROM segments.
- Live Screen Viewer (60fps TCP stream) with gamepad input forwarding.
- Memory Map visualization, Trace Logger, and Loaded Sources browser.
- Debug-monitor protocol version handshake (protocol version 1): the extension
  queries the emulator on connect and warns on a version mismatch.
