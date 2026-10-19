/**
 * Release states: which capabilities each audience can use. Build broadly, release narrowly (docs/DECISIONS.md D11).
 *
 * This is NOT an authorisation boundary on its own. Every server checks it, but permissions, consent, grants and policy
 * still apply on top. Hiding a button in a UI never makes a capability unavailable; the server-side check does.
 */
export type ReleaseState = "internal" | "private" | "preview" | "public" | "disabled";
/** Who a tenant is, for release purposes. A capability is available to a cohort at or above its state. */
export type Cohort = "internal" | "private" | "preview" | "public";

const RANK: Record<Cohort, number> = { internal: 0, private: 1, preview: 2, public: 3 };
const STATE_RANK: Record<Exclude<ReleaseState, "disabled">, number> = { internal: 0, private: 1, preview: 2, public: 3 };

export interface CapabilityInfo { state: ReleaseState; surface: "consumer" | "workspace" | "api" | "sdk" | "mcp" | "agent" | "community" | "data"; description: string }

/** The registry. Change states here (with a decision log entry when it is a public launch), or per deployment with RECAST_RELEASE. */
export const CAPABILITIES = {
  "consumer.grab-and-place": { state: "private", surface: "consumer", description: "Grab an object and place it (browser harness; no native shell yet)" },
  "consumer.compose": { state: "internal", surface: "consumer", description: "Combine pieces into one object (time + place + title)" },
  "workspace.control-center": { state: "private", surface: "workspace", description: "Objects, permissions, history, privacy controls" },
  "workspace.supabase-signin": { state: "internal", surface: "workspace", description: "Sign-in with Supabase sessions (not verified against a real project)" },
  "api.resolve": { state: "private", surface: "api", description: "POST /v1/resolve, /v1/resolve/batch, GET /v1/bridges" },
  "api.corrections": { state: "private", surface: "api", description: "POST /v1/corrections (opt-in tenants only)" },
  "api.place": { state: "internal", surface: "api", description: "POST /v1/place, undo and reconcile: writes to a person's accounts" },
  "api.place.object": { state: "internal", surface: "api", description: "POST /v1/place with a complete object instead of text" },
  "sdk.place": { state: "internal", surface: "sdk", description: "Recast.place() and placements.*" },
  "mcp.recast-tools": { state: "private", surface: "mcp", description: "resolve_object and list_destinations as MCP tools" },
  "agent.gateway": { state: "private", surface: "agent", description: "Agent identity, scopes, policy, approvals and audit through the gateway" },
  "agent.spaces": { state: "internal", surface: "agent", description: "Spaces: bounded agent configurations" },
  "community.recipes": { state: "disabled", surface: "community", description: "Recipes and policy packs" },
  "data.library": { state: "disabled", surface: "data", description: "Data Library" },
} as const satisfies Record<string, CapabilityInfo>;
export type Capability = keyof typeof CAPABILITIES;

export class ReleaseConfigError extends Error {}

/** RECAST_RELEASE="api.place=preview,agent.spaces=private": per-deployment overrides. Unknown names or states refuse to start. */
export function parseOverrides(v: string | undefined): Partial<Record<Capability, ReleaseState>> {
  const out: Partial<Record<Capability, ReleaseState>> = {};
  for (const part of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, state] = part.split("=").map((x) => x.trim());
    if (!name || !(name in CAPABILITIES)) throw new ReleaseConfigError(`RECAST_RELEASE names an unknown capability '${name ?? ""}'`);
    if (!state || !["internal", "private", "preview", "public", "disabled"].includes(state)) throw new ReleaseConfigError(`RECAST_RELEASE: '${state ?? ""}' is not a release state`);
    out[name as Capability] = state as ReleaseState;
  }
  return out;
}

export interface Release {
  state(c: Capability): ReleaseState;
  /** True when a tenant in `cohort` may use capability `c`. */
  allows(c: Capability, cohort: Cohort): boolean;
  table(): { capability: Capability; state: ReleaseState; surface: string; description: string }[];
}
export function createRelease(overrides: Partial<Record<Capability, ReleaseState>> = {}): Release {
  const state = (c: Capability): ReleaseState => overrides[c] ?? CAPABILITIES[c].state;
  return {
    state,
    allows(c, cohort) { const s = state(c); return s !== "disabled" && RANK[cohort] <= STATE_RANK[s]; },
    table: () => (Object.keys(CAPABILITIES) as Capability[]).map((c) => ({ capability: c, state: state(c), surface: CAPABILITIES[c].surface, description: CAPABILITIES[c].description })),
  };
}
export const releaseFromEnv = (env: Record<string, string | undefined>) => createRelease(parseOverrides(env.RECAST_RELEASE));
export const isCohort = (v: unknown): v is Cohort => v === "internal" || v === "private" || v === "preview" || v === "public";
