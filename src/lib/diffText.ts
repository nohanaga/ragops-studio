/**
 * Unified diff helper.
 *
 * Used by compare mode to show textual differences between two JSON payloads
 * (e.g., request/response, baseline vs candidate run).
 */

import { createTwoFilesPatch } from 'diff';

export function unifiedDiff(input: {
  aName: string;
  bName: string;
  aText: string;
  bText: string;
  context?: number;
}): string {
  const context = input.context ?? 3;
  return createTwoFilesPatch(
    input.aName,
    input.bName,
    input.aText ?? '',
    input.bText ?? '',
    '',
    '',
    { context },
  );
}
