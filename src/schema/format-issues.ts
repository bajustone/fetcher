/**
 * Display helper for `StandardSchemaV1Issue` arrays. Produces a flat,
 * human-readable string with configurable separator and path-segment
 * joiner.
 *
 * @module
 */

import type { StandardSchemaV1Issue, StandardSchemaV1PathSegment } from '../types.ts';

export interface FormatIssuesOptions {
  /** Inserted between issue lines. Default: `'\n'`. */
  readonly separator?: string;
  /** Joins `path` segments. Default: `'.'`. */
  readonly pathJoiner?: string;
  /** Inserted between path and message. Default: `': '`. */
  readonly pathMessageSeparator?: string;
}

function segmentToString(segment: StandardSchemaV1PathSegment): string {
  if (typeof segment === 'object' && segment !== null && 'key' in segment)
    return String((segment as { key: PropertyKey }).key);
  return String(segment);
}

/**
 * Formats an issues array for display.
 *
 * @example
 * ```ts
 * const r = schema['~standard'].validate(data);
 * if (r.issues) console.error(formatIssues(r.issues));
 * // user.email: Pattern mismatch
 * // user.age: Too small
 * // items.0.name: Missing
 * ```
 */
export function formatIssues(
  issues: ReadonlyArray<StandardSchemaV1Issue>,
  options: FormatIssuesOptions = {},
): string {
  const { separator = '\n', pathJoiner = '.', pathMessageSeparator = ': ' } = options;
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.path && issue.path.length > 0) {
      const path = issue.path.map(segmentToString).join(pathJoiner);
      lines.push(path + pathMessageSeparator + issue.message);
    }
    else {
      lines.push(issue.message);
    }
  }
  return lines.join(separator);
}
