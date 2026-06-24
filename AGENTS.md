# AGENTS.md

Guidance for AI coding agents (Copilot, Claude, Codex, Cursor, etc.) working in
this repository. Human contributors may also find it useful.

## What this project is

**Gearlynx Debugger** is a Visual Studio Code extension: a source-level debugger for Atari
Lynx games built with the [cc65](https://cc65.github.io/) toolchain. It implements
the Debug Adapter Protocol (DAP) and drives the
[Gearlynx](https://github.com/DrHelius/Gearlynx) emulator over TCP.

- Language: **TypeScript** (compiled to `out/` via `tsc`).
- Runtime: VSCode extension host (Node). Engine: VSCode `^1.87.0`.
- License: **MIT**. Publisher: **Ganksoft**. Versioning: SemVer.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/extension.ts` | Extension entry point; registers the `gearlynx` debug type, commands, and webviews. |
| `src/lynx_debug_session.ts` | The DAP implementation (the bulk of the logic): launch/attach, breakpoints, stepping, variables. Largest file. |
| `src/debug_monitor_client.ts` | TCP client for the Gearlynx debug-monitor protocol (Content-Length-framed JSON). Holds `CLIENT_PROTOCOL_VERSION`. |
| `src/framebuffer_client.ts` | TCP client for the raw framebuffer stream (Screen Viewer). |
| `src/debug_info.ts`, `debug_info_cc65.ts`, `debug_info_sym.ts` | Parse cc65 `.dbg` and `.sym` debug info into source/symbol maps. |
| `src/memory_map.ts`, `webviews.ts` | Memory-map visualization and webview (Screen Viewer) HTML. |
| `src/types.ts` | Shared TypeScript interfaces for the wire protocol and debug info. |
| `package.json` | Extension manifest: version, publisher, contributed commands/settings/debugger. |
| `.github/workflows/ci.yml` | CI: compile + lint + package on every PR/push to `main`. |
| `.github/workflows/release.yml` | Release: on a `v*` tag, publish to VS Marketplace + Open VSX and attach the `.vsix`. |

Compiled output (`out/`) and `node_modules/` are git-ignored; never commit them.

## Build, lint, and test commands

Requires **Node 24 (LTS)** with `node`/`npm` on PATH:

```powershell
npm install        # install deps (first time / after package.json changes)
npm run compile    # tsc type-check + emit to out/  (MUST pass)
npm run lint       # eslint src/  (MUST pass with 0 errors; warnings OK)
npm run package    # build a .vsix locally
```

CI pins **Node 24** with `npm ci`. If you regenerate `package-lock.json`, prefer
doing it on Node 24 for parity.

Manual test: open the folder in VSCode and press **F5** to launch an Extension
Development Host, then debug a Lynx project in the new window.

## Conventions

- TypeScript `strict` mode is on (`tsconfig.json`); keep it compiling clean.
- 4-space indentation, single-quoted strings, semicolons, trailing commas in
  multi-line literals -- match the surrounding code.
- ESLint flat config in `eslint.config.mjs`. Unused vars/args must be prefixed
  with `_` to be allowed.
- ASCII only in code comments and string literals (no smart quotes, em/en
  dashes, or arrows -- use `--`, `->`, straight quotes).
- Do not introduce new runtime dependencies without a concrete need; the only
  runtime dep is `@vscode/debugadapter`.

## The cross-repo protocol contract (important)

The extension and the emulator negotiate an integer **debug-monitor protocol
version** on connect (the `handshake` command). A mismatch only **warns** the
user; it does not hard-fail.

- Client side: `CLIENT_PROTOCOL_VERSION` in `src/debug_monitor_client.ts`.
- Emulator side: `DM_PROTOCOL_VERSION` in the Gearlynx repo
  (`platforms/shared/desktop/debug_monitor_server.h`).
- Wire format reference: `PROTOCOL.md` in the Gearlynx repo.

If you change the debug-monitor wire format in a breaking way, bump **both**
constants, update `PROTOCOL.md`, and update the compatibility table in `README.md`.
Additive changes (new optional fields/commands) do not require a bump.

## Releasing

1. Make the change (code in `src/`, or `package.json` for commands/settings).
2. Bump `version` in `package.json` (SemVer).
3. Add a `CHANGELOG.md` entry.
4. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow publishes to both marketplaces using the `VSCE_PAT` and
`OVSX_PAT` repository secrets. Do not put tokens in code or commits.

## Guardrails

- Never commit secrets, `out/`, or `node_modules/`.
- Do not rename the extension id (`gearlynx-debugger`), the debug type (`gearlynx`), or the
  publisher (`Ganksoft`) without a deliberate migration.
- Keep `package.json` contributed `commands`/`configuration` in sync with the
  code that implements them.
