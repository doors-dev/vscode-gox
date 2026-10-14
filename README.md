# GoX (VS Code)

VS Code support for **GoX**: Tree-sitter–based highlighting/folding and GoX language-server integration for completion, diagnostics, go-to-definition, and refactors across both `.gox` and `.go` files.

> Beta: This extension is in beta. You may encounter bugs or incomplete behavior, and features/configuration may change between releases. Please share feedback and file issues on GitHub (include your GoX version and minimal repro steps).

## Features

- **GoX Language Server (LSP)**
  - Language features for **GoX (`.gox`)** and **Go (`.go`)** via the GoX language server (GoX proxies `gopls`).

- **Syntax highlighting + folding**
  - Semantic highlighting and folding powered by bundled Tree-sitter WASM grammars.
  - Supports GoX and Go, including common embedded languages (HTML/CSS/JS) when present.

- **Tool management (automatic)**
  - Downloads the GoX language server binary (unless you provide a custom path).
  - Installs `gopls` at the pinned version using `go install` (unless you provide a custom path).

## Requirements

- For automatic `gopls` installation: **Go toolchain (`go`) available in PATH**.
- For automatic GoX download: **Windows/macOS/Linux on x64 or arm64**.
- Network access is required for the first-time download/install (unless you point to existing binaries).

> GoX proxies `gopls` functionality for both `.go` and `.gox`, so VS Code’s Go extension language server must be disabled.

## How it works

On activation, the extension:

1. Ensures `gox` and `gopls` are available (downloads/installs if missing).
2. Prompts to disable the VS Code Go extension language server (if it is enabled). If you decline, the GoX language server is not started; highlighting and folding still work. A declined prompt is not shown again in that window.
3. Starts the GoX language server for Go and GoX files.

`.gox` files have no TextMate grammar: colors come from semantic tokens, so the extension enables `editor.semanticHighlighting.enabled` for `[gox]` by default.

Comment toggling in `.gox` files inserts Go comments (`//`, `/* */`). Inside element bodies those are plain text; write comments there as `~//` or `~/* */`.

## Commands

- **GoX: Start** (`gox.start`)  
  Starts (or restarts) the GoX language server after performing a health check. Always shows the install and Go language server prompts, even if you declined them earlier.

## Settings

You can override the managed binaries and use your own installations:

### `gox.bin.gox`

Path to the GoX language server executable. May start with `~`; a bare command name is looked up in PATH.

### `gox.bin.gopls`

Path to the `gopls` executable (same rules).

### `gox.log.file`

Path of a file the GoX language server writes its log to. Empty (default) disables logging.

### `gox.log.level`

Log level: `debug`, `info` (default), `warn` or `error`. Used only when `gox.log.file` is set.

Example `settings.json`:

```json
{
  "gox.bin.gox": "/absolute/path/to/gox",
  "gox.bin.gopls": "gopls",
  "gox.log.file": "/tmp/gox.log",
  "gox.log.level": "debug"
}
```

After a `gox.bin.*` or `gox.log.*` setting changes, a notification offers to restart the GoX language server; the new values apply after the restart.

## Troubleshooting

- **Prompt says the Go extension language server must be disabled**
  - GoX provides Go and GoX language features by running `gopls` internally, so the Go extension’s language server must be off.
  - If you clicked “Cancel”, GoX language features stay off for that window. Run **GoX: Start** to get the prompt again, or set `"go.useLanguageServer": false` in your user settings and run **GoX: Start**.

- **`gopls` installation fails**
  - Install Go and ensure `go` is available in PATH, or set `"gox.bin.gopls"` to an existing `gopls` binary.

- **Unsupported platform/arch**
  - Automatic GoX download supports Windows/macOS/Linux on x64/arm64 only.
  - Install `gox` manually and set `"gox.bin.gox"`.

## Related projects

- GoX language server and library: https://github.com/doors-dev/gox
- Tree-sitter grammar: https://github.com/doors-dev/tree-sitter-gox
