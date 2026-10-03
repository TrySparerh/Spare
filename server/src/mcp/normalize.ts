/**
 * Tool-name normalisation for Spare MCP.
 *
 * Canonical names are `spare_*`. Accepted inputs:
 *   - canonical:  spare_universe
 *   - bare:       universe  -> spare_universe
 */
export const TOOL_PREFIX = 'spare_';

/** Canonical `spare_*` name for any accepted input form. */
export function normalizeToolName(raw: unknown): string {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase();
  return name.startsWith(TOOL_PREFIX) ? name : TOOL_PREFIX + name;
}
