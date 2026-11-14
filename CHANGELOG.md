# Change Log

All notable changes to the "gox" extension will be documented in this file.

## [0.0.34]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.3.4...v0.4.0). Breaking: the legacy `~{ }` and `func { }` forms are removed; see the [gox v0.4.0 notes](https://github.com/doors-dev/gox/releases/tag/v0.4.0)
- Tree-sitter grammar updated to [tree-sitter-gox v0.3.2](https://github.com/doors-dev/tree-sitter-gox/releases/tag/v0.3.2): Go 1.27 generic methods, HTML implicit closing closer to browsers, no parser crash on `<` in a `<script>` or `<style>` attribute
- Fixed: folding an implicitly closed element (`<li>` without `</li>`) hid the next line
- Generic calls with one type argument (`F[T](x)`) are highlighted as calls

## [0.0.33]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.3.3...v0.3.4)
- gopls version bump (v0.23.0 → v0.24.0)

## [0.0.32]

- Fixed: highlighting of embedded CSS/JS/HTML, missing colours on the first opened file, a memory leak
- Fixed: comment toggling in `.gox` files
- Fixed: declining the "disable Go language server" prompt now keeps the GoX server off
- More reliable language server restart and binary install
- Changing `gox.bin.*` / `gox.log.*` offers a server restart; command shown as "GoX: Start"

## [0.0.31]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.3.2...v0.3.3)


## [0.0.30]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.3.1...v0.3.2)

## [0.0.29]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.2.4...v0.3.1)
- [gopls version bump](https://github.com/doors-dev/gox/releases/tag/v0.3.1)

## [0.0.28]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.2.3...v0.2.4)

## [0.0.27]

- [gox version bump](https://github.com/doors-dev/gox/compare/v0.2.1...v0.2.3)

## [0.0.26]

- [GoX version bump](https://github.com/doors-dev/gox/compare/v0.1.36...v0.2.1)


## [0.0.25]

- [GoX version bump](https://github.com/doors-dev/gox/compare/v0.1.34...v0.1.36)

## [0.0.24]

- [GoX version bump](https://github.com/doors-dev/gox/releases/tag/v0.1.34)

## [0.0.23]

- gox version bump

## [0.0.22]

- Gox version bump
- gopls version bump

## [0.0.21]

- Gox version bump

## [0.0.20]

- Gox version bump

## [0.0.19]

- Gox version bump

## [0.0.18]

- Gox version bump

## [0.0.17]

- Gox version bump

## [0.0.16]

- Gox version bump

## [0.0.15]

- Gox version bump

## [0.0.14]

- Gox version bump

## [0.0.13]

- Gox version bump

## [0.0.12]

- Gox version bump

## [0.0.11]

- Gox version bump

## [0.0.10]

- Gox version bump

## [0.0.9]

- Gox version bump

## [0.0.8]

- Gox version bump

## [0.0.7]

- Gox version bump

## [0.0.6]

- Refactored grammer

## [0.0.5]

- Beta disclaimer

## [0.0.4]

- Fixed patch offset calculation

## [0.0.3]

- Fixed document URI conversion for windows

## [0.0.2]

- Fixed windows build (static link of missing dll)

## [0.0.1]

- Initial release
