/**
 * Shared types for the MCP registry. Lives in its own file so registry.ts and
 * spare/tools.ts can import without circular deps.
 */

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "integer";
  description: string;
  required?: boolean;
  default?: unknown;
}

/** Category of the Spare engine tools: the default `spare` toolset. */
export const SPARE_ENGINE_CATEGORY = "Spare Engine";

/**
 * In the default `spare` toolset (what tools/list, GET /api/mcp/tools and
 * /health count): the seven Spare engine tools. spare_token is listed only
 * with `?toolset=all`.
 */
export function inSpareToolset(t: { category: string; free?: boolean }): boolean {
  return t.free === true && t.category === SPARE_ENGINE_CATEGORY;
}

export interface ToolDef {
  name: string;
  category: string;
  scope: "read";
  /** Free public read (every Spare tool is). */
  free?: boolean;
  description: string;
  params: ToolParam[];
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}
