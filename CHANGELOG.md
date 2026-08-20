# Changelog

All notable changes to the Gearlynx Debugger extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.10] - 2026-08-19

### Added

- Out-of-date sources at launch now prompt to build first, running the launch config's new `buildTask` or the workspace's default build task, instead of only warning. Set `gearlynxDebug.staleSourceAction` (or the same key in a launch config) to `build`, `warn`, or `ignore` to change that.
- Trace logging can now target configurable memory capacities or size-limited/unbounded disk files when used with Gearlynx 1.2.27 or later, by [@drhelius](https://github.com/drhelius) in [#7](https://github.com/ganksoft/gearlynx-vscode/pull/7).

## [0.2.9] - 2026-08-14

### Changed

- Globals and Zero Page panes now batch their memory reads, and register/hardware state is fetched once per stop, cutting hundreds of emulator round-trips per stop down to a handful.
- Internal cleanup pass over `src/`: removed dead fields and code paths, and factored out shared hex/memory-read/breakpoint-clear helpers. No behavior change.

### Fixed

- Timers and Audio panes now read counter/backup and volume/output from the emulator's current `hardware_status` payload; they had reported `$00` for every value since Gearlynx moved those into a per-entry `registers` array.
- Hardware pane's LCD Line row appears again (the payload renamed the field that fed it), and the cart bank rows now list every bank instead of silently showing none.
- The source-root list no longer grows on every debug-file rebuild (each reload prepended another copy of the debug file's directory), which progressively slowed source-path resolution.

### Removed

- Hardware pane's DISPADR and VIDBAS rows: `hardware_status` no longer reports them and neither is readable another way (DISPADR is write-only in Mikey; `memory_get` returns the RAM under the register overlay, not the registers). They had not rendered since the payload changed.

## [0.2.8] - 2026-08-13

### Added

- Launch now warns (toast, Debug Console, and Output panel) when a source file has changed since the `.dbg` was built, so stepping/breakpoints against a stale build are easier to spot.
- Stack frames from cc65 runtime/library code (via `.dbg` module/library records) now render de-emphasized in the Call Stack view.

### Fixed

- Locals pane now resolves cc65 `static` local variables (`sc=static`), which were previously dropped instead of shown.
- Locals pane and its function-name fallback no longer leak variables/functions from a different, non-resident overlay when two overlay segments' address ranges collide.
- Call Stack view now shows the actual call chain instead of just the current frame, and addresses (call-stack frames, stepping) now label the enclosing function instead of falling back to a bare `$addr` whenever execution isn't at a function's exact entry point.

## [0.2.7] - 2026-08-11

### Fixed

- Local variables now resolve the cc65 software stack pointer from the `c_sp`/`sp` symbol instead of assuming it sits at the start of ZEROPAGE; projects placing their own variables in ZEROPAGE previously showed wrong values for every local.
- Locals pane now resolves cc65 `register` variables (`sc=reg`), which were previously dropped instead of shown.

## [0.2.6] - 2026-07-19

### Changed

- Symbol Table now classifies cc65's compiler-generated branch/storage labels (e.g. `L0002`, `M0001`) as "Generated Label" instead of misclassifying them as "Static"; hidden by filter default, toggle to show.

## [0.2.5] - 2026-07-13

### Fixed

- Zero-page/BSS/DATA symbols no longer resolve to lynxhdr.s/directory.s (EXEHDR/DIRECTORY alias address 0 with ZEROPAGE/EXTZP); they now resolve to their real declaring source file where cc65's debug info allows it.

## [0.2.4] - 2026-07-07

### Changed

- Generating a launch.json (Add Configuration or F5) now scans the workspace for a ROM instead of a placeholder game.lnx, and defaults new configs to headless with stopOnEntry off.

## [0.2.3] - 2026-07-07

### Changed

- Debug-monitor disconnects now show a toast, not just a log entry.
- Screen Viewer shows stream errors and blacks out on session end instead of freezing on the last frame.
- Debug-info parsing now logs symbol/function counts and warns on parse anomalies or an unreadable/empty debug file.

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
