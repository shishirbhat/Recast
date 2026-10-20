import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { API_TYPES, MAX_RAW_CHARS, type ApiType } from "@recast/resolve";
import { ToolError, type Backend } from "./backend";

const summary = (w: any): string => {
  if (w?.status === "resolved") {
    const o = w.object; const r = w.routing;
    return `Resolved a ${o.type} (confidence ${o.confidence}, trust ${o.trust}).` + (r ? ` In ${r.destination} it becomes: ${r.action} (${r.reliability_label}; risk ${r.risk}${r.requires_confirmation ? ", needs the person's confirmation" : ""}).` : "");
  }
  if (w?.status === "ambiguous") return `Ambiguous: ${w.reason}. ${w.alternatives.length} candidates; ask the person which one they meant.`;
  return `Not resolved: ${w?.reason ?? "unknown"}.${w?.suggestion ? ` ${w.suggestion}` : ""}`;
};

/** The Recast MCP server: lets any agent turn raw text into a typed object and see where it can go. Read-only: nothing is placed. */
export function createRecastMcpServer(backend: Backend, info = { name: "recast", version: "0.1.0" }) {
  const server = new McpServer(info, { instructions: "Use resolve_object to turn text about one thing (a person, event, place, product, paper or document) into a typed object with field-level provenance and the action it maps to in a destination app. Nothing is changed in any app; acting on the result is a separate, consented step." });

  const fail = (e: unknown) => {
    if (e instanceof ToolError) return { isError: true, content: [{ type: "text" as const, text: e.message }] };
    return { isError: true, content: [{ type: "text" as const, text: "Recast could not handle this request." }] };
  };

  server.registerTool("resolve_object", {
    title: "Resolve an object",
    description: "Turn raw text about one thing into a typed Recast object (Person, Event, Location, Product, Paper or Document) with per-field confidence and provenance, plus how it would land in a destination app. Read-only.",
    inputSchema: {
      raw: z.string().min(1).max(MAX_RAW_CHARS).describe("The text describing one thing, as copied from a page, email or document"),
      source_url: z.string().url().max(2048).optional().describe("Where the text came from"),
      target_type: z.enum(API_TYPES as [ApiType, ...ApiType[]]).optional().describe("The type you expect, if you know it"),
      destination: z.string().max(64).optional().describe("Destination id from list_destinations, e.g. google_calendar"),
      include_provenance: z.boolean().optional().describe("Include where each field came from (default true)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: backend.mode === "remote" },
  }, async (args) => {
    try { const w = await backend.resolve(args); return { content: [{ type: "text", text: summary(w) }, { type: "text", text: JSON.stringify(w) }], structuredContent: w as Record<string, unknown> }; }
    catch (e) { return fail(e); }
  });

  server.registerTool("list_destinations", {
    title: "List destinations",
    description: "The apps Recast can place objects into, which object types each accepts, the actions, and how reliable each bridge is.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: backend.mode === "remote" },
  }, async () => {
    try { const d = await backend.destinations(); return { content: [{ type: "text", text: JSON.stringify(d) }], structuredContent: { destinations: d } }; }
    catch (e) { return fail(e); }
  });

  return server;
}
