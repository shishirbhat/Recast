import type { ObjectType as CoreType } from "@recast/core";

/** The API's vocabulary. "Paper" is the core's ResearchPaper. There is no "Org" yet: the ontology does not have one. */
export type ApiType = "Person" | "Event" | "Location" | "Product" | "Paper" | "Document";
export const API_TYPES: readonly ApiType[] = ["Person", "Event", "Location", "Product", "Paper", "Document"];
export const toCoreType = (t: ApiType): CoreType => (t === "Paper" ? "ResearchPaper" : t);
export const toApiType = (t: CoreType): ApiType | null => (t === "ResearchPaper" ? "Paper" : (API_TYPES as readonly string[]).includes(t) ? (t as ApiType) : null);

export type Stage = "rules" | "embedding" | "llm";
export type TrustLevel = "low" | "medium" | "high";

export interface ResolveInput {
  raw: string;
  sourceUrl?: string;
  sourceType?: string;
  target?: { type?: ApiType; destination?: string };
  options?: { confidenceThreshold?: number; includeProvenance?: boolean };
}

export interface FieldProvenance { field: string; source: string; confidence: number; excerpt?: string }
export interface ResolvedObjectView {
  id: string; type: ApiType; fields: Record<string, unknown>; confidence: number; trust: TrustLevel; provenance: FieldProvenance[];
}
export interface Routing {
  destination: string; action: string; relationId: string; bridge: string;
  bridgeReliability: string; reliabilityLabel: string; requiresConfirmation: boolean; consent: "release" | "confirm" | "hold"; risk: TrustLevel; reasons: string[];
}
export interface Meta { stage: Stage; schemaVersion: string; degraded: boolean }

export type ResolveOutcome =
  | { status: "resolved"; object: ResolvedObjectView; routing: Routing | null; routeError?: string; alternatives: ResolvedObjectView[]; meta: Meta }
  | { status: "ambiguous"; alternatives: ResolvedObjectView[]; reason: string; meta: Meta }
  | { status: "unresolved"; reason: string; suggestion?: string; meta: Meta };

/** Optional smarter stages. Neither is required; the engine works (and says so) with rules alone. */
export interface Embedder { embed(text: string): Promise<number[]> }
export interface LlmExtraction { type: ApiType; fields: Record<string, unknown>; confidence: number }
export interface Llm { extract(req: { text: string; types: readonly ApiType[]; hint?: ApiType }): Promise<LlmExtraction | null> }

export const SCHEMA_VERSION = "1.0.0";
export const MAX_RAW_CHARS = 4000;
/** Ceiling for anything a model (not a rule) decided. Keeps those results at "medium" risk or above: they always ask. */
export const MODEL_CONFIDENCE_CAP = 0.7;
