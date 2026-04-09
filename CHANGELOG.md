# Changelog

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
