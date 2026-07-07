# Changelog

All notable changes to the Gearlynx Debugger extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-07-06

### Changed

- The overlay selector (Overlays panel and debug-toolbar picker) now lists only
  code overlays. Overlay segments are classified as code or data structurally --
  a segment is code when it hosts a function symbol, independent of its name --
  because cc65 debug info only distinguishes read-only from read-write, not code
  from rodata. Data-only overlays have no function symbols and are omitted.
- On debug start the Lynx screen is revealed and focused so keyboard input is
  routed to the emulator without clicking the canvas. The screen no longer grabs
  focus on window/panel load -- only on Run and on click.

## [0.2.1] - 2026-07-05

### Changed

- The Symbol Table panel now keeps the filter input, kind toggles, and count
  fixed at the top; only the row list scrolls underneath.

### Fixed

- The Symbol Table's Function rows now show their segment. `DebugFunction`
  never carried a segment name, so it was always blank for functions even
  though the cc65 `.dbg` parser already resolved it.

## [0.2.0] - 2026-07-05

### Added

- **Symbol Table panel**: a new "Symbols" view in the Lynx panel listing every
  function and symbol with its kind, address, segment, and source location.
  Sort by clicking a column header, filter by name or address, toggle
  visibility per kind (Function/Global/Zero Page/Static), click a row to jump
  to its source location, and right-click a function to set a breakpoint.
- **"Gearlynx Debugger" output channel**: a persistent log of connection
  status and errors (connect/attach lifecycle, protocol mismatches, socket
  errors) separate from the Debug Console, so issues are visible even before
  or after a debug session runs.
- The **Screen**, **Overlays**, and **Symbols** panels, and the **Show Memory
  Map** / **Select Active Overlay** commands, now work without an active debug
  session: they resolve debug info directly from the `gearlynx` configuration
  in `launch.json` and refresh automatically when the ROM is rebuilt or
  `launch.json` changes.

### Changed

- The Screen Viewer panel is now always visible in the Lynx panel (previously
  it only appeared once a debug session started); it shows "Disconnected"
  until a session connects.
- The extension now activates when the Screen or Symbols view is opened, in
  addition to on debug session start, so the panel is available before
  pressing F5.

### Fixed

- A dropped connection error on the framebuffer stream could crash the
  extension host; socket errors are now surfaced (and logged) instead of
  silently discarded.
- The Symbol Table no longer lists each function twice. cc65 debug info
  records a function both as a C-level symbol and as its own
  underscore-prefixed assembly label at the same address; only the function
  row is shown now.
- `findSourceForAddress` (used by source-line stepping, the call stack, and
  the Symbol Table) is now a binary search instead of a linear scan, which
  matters on projects with a large debug file.

## [0.1.1] - 2026-06-26

### Fixed

- Expand a leading `~` in launch/attach paths (`rom`, `debugFile`, `gearlynxPath`,
  `sourceRoots`) and in the `gearlynxDebug.gearlynxPath` setting. Node does not
  perform shell tilde expansion, so paths like `~/gearlynx` previously failed to
  resolve on Linux and macOS.

## [0.1.0] - 2026-06-25

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
