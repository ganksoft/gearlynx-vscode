# Changelog

All notable changes to the Gearlynx Debugger extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-07-07

### Changed

- Debug-monitor disconnects now show a toast, not just a log entry.
- Screen Viewer shows stream errors and blacks out on session end instead of freezing on the last frame.

## [0.2.2] - 2026-07-06

### Changed

- Overlay selector lists only code overlays, not data-only ones.
- Debug start now reveals and focuses the Lynx screen for keyboard input.

## [0.2.1] - 2026-07-05

### Changed

- Symbol Table keeps its filter, kind toggles, and count fixed while the row list scrolls.

### Fixed

- Symbol Table Function rows now show their segment.

## [0.2.0] - 2026-07-05

### Added

- Symbol Table panel: sort, filter, kind toggles, jump-to-source, and set-breakpoint on functions.
- "Gearlynx Debugger" output channel for connection status and errors.
- Screen, Overlays, and Symbols panels now work without an active debug session.

### Changed

- Screen Viewer panel is now always visible, showing "Disconnected" until connected.
- Extension activates on Screen/Symbols view open, not just debug start.

### Fixed

- A dropped framebuffer connection no longer crashes the extension host.
- Symbol Table no longer lists each function twice.
- `findSourceForAddress` is now a binary search instead of a linear scan.

## [0.1.1] - 2026-06-26

### Fixed

- Expand a leading `~` in launch/attach paths and the `gearlynxDebug.gearlynxPath` setting.

## [0.1.0] - 2026-06-25

### Added

- Initial public release.
- Source-level debugging for C and 6502 assembly via cc65 `.dbg` files, with `.sym` fallback.
- Step controls (in/over/out/frame), frame-level step back, source-line stepping, call stack, disassembly, goto-target.
- Breakpoints: source, conditional, hit-count, logpoints, data/watchpoints, function, instruction.
- Variable/memory inspection: registers, flags, locals, globals, zero page, hardware status, watch expressions, hover eval.
- Overlay detection and runtime overlay selection for banked ROM segments.
- Live Screen Viewer (60fps TCP stream) with gamepad input forwarding.
- Memory Map visualization, Trace Logger, and Loaded Sources browser.
- Debug-monitor protocol version handshake, warning on mismatch.
