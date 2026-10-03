/**
 * Spare MCP tool registry: the seven Spare engine tools plus spare_token.
 * Every tool is free and read-only (`scope: "read"`); none can sign or move
 * funds. There is no other toolset and no third-party data gateway.
 */
export type { ToolDef, ToolParam } from "./registry.types.js";
import { inSpareToolset, type ToolDef, type ToolParam } from "./registry.types.js";
import { SPARE_ENGINE_TOOLS, SPARE_TOKEN_TOOL } from "../spare/tools.js";
import { TOOL_PREFIX } from "./normalize.js";
import { SPARE_MCP_SERVER } from "./server.info.js";

/** Every Spare MCP tool, Spare engine tools first. */
const ALL: ToolDef[] = [...SPARE_ENGINE_TOOLS, SPARE_TOKEN_TOOL];

export const TOOLS: readonly ToolDef[] = ALL;

export const REGISTRY: Record<string, ToolDef> = Object.fromEntries(
  ALL.map((t) => [t.name, t]),
);

export interface CatalogTool {
  name: string;
  category: string;
  scope: "read";
  free?: boolean;
  description: string;
  params: ToolParam[];
  /** JSON Schema for the params (what MCP clients see as inputSchema). */
  inputSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[] };
}
export interface Catalog {
  server: { name: string; title: string; version: string; description: string };
  tools: CatalogTool[];
  total: number;
  listed: number;
  /** Every tool name starts with this prefix; a bare name passed to a call gets it added. */
  prefix: string;
  toolset: "spare" | "all";
  toolsets: { spare: number; all: number };
}

function inputSchemaOf(params: ToolParam[]): CatalogTool["inputSchema"] {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = { type: p.type, description: p.description, ...(p.default !== undefined ? { default: p.default } : {}) };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/**
 * Tool catalog. `spare` lists the seven Spare engine tools; `all` adds
 * spare_token.
 */
export function buildCatalog(toolset: "spare" | "all" = "all"): Catalog {
  const source = toolset === "spare" ? ALL.filter(inSpareToolset) : ALL;
  const tools: CatalogTool[] = source.map(({ handler: _handler, ...meta }) => ({ ...meta, inputSchema: inputSchemaOf(meta.params) }));
  return {
    server: {
      name: SPARE_MCP_SERVER.name,
      title: SPARE_MCP_SERVER.title,
      version: SPARE_MCP_SERVER.version,
      description: SPARE_MCP_SERVER.description,
    },
    tools,
    total: tools.length,
    listed: tools.length,
    prefix: TOOL_PREFIX,
    toolset,
    toolsets: { spare: ALL.filter(inSpareToolset).length, all: ALL.length },
  };
}
