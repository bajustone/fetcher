/**
 * `@bajustone/fetcher/spec-tools` — development-time helpers for OpenAPI
 * spec coverage and drift detection. Not needed at runtime.
 *
 * @module
 */

export { coverage, lintSpec } from '../spec-tools.ts';
export type {
  RouteCoverage,
  SpecCoverageReport,
  SpecDriftIssue,
} from '../spec-tools.ts';
