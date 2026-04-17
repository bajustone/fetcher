# Changelog

## [0.0.15] - 2026-04-17

### Added
- clean docs
- add component schemas + validators to virtual:fetcher

## [0.0.14] - 2026-04-11

### Fixed
- fix url query

## [0.0.13] - 2026-04-10

### Changed
- update read me

## [0.0.12] - 2026-04-10

### Added
- feat: add .unwrap() and .query() primitives on TypedFetchPromise

## [0.0.11] - 2026-04-10

### Changed
- refactor: redesign plugin to export routes instead of pre-built client

## [0.0.10] - 2026-04-10

### Fixed
- fix: vite plugin no longer ships full OpenAPI spec in bundle

## [0.0.9] - 2026-04-10

### Added
- add Rollup/Vite plugin; rewrite docs to match source

## [0.0.8] - 2026-04-10

### Added
- dx: .result() shorthand, bearerWithRefresh exclude, SchemaOf<>

## [0.0.7] - 2026-04-10

### Added
- types

## [0.0.6] - 2026-04-09

### Added
- rework: result model, middleware, retry/timeout, OpenAPI typing

## [0.0.5] - 2026-04-09

### Fixed
- fix jsr

## [0.0.4] - 2026-04-09

### Changed
- Document every exported type and interface field in `src/types.ts` to lift the JSR documented-symbols score.
- Promote `executeMiddleware` to a full JSDoc block and mark it `@internal`.

### Fixed
- Remove the dead `description` field from `jsr.json` (not part of JSR's config schema — set via package settings instead).

## [0.0.3] - 2026-04-09

### Fixed
- fix jsr
