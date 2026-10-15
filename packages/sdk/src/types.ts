export type ObjectType = "Person" | "Event" | "Location" | "Product" | "Paper" | "Document";
export type TrustLevel = "low" | "medium" | "high";
export type Consent = "release" | "confirm" | "hold";

export interface Provenance { field: string; source: string; confidence: number; excerpt?: string }
export interface RecastObject {
  id: string; type: ObjectType; fields: Record<string, unknown>; confidence: number; trust: TrustLevel; provenance?: Provenance[];
}
export interface Routing {
  destination: string; action: string; relationId: string; bridge: string; bridgeReliability: string; reliabilityLabel: string;
  requiresConfirmation: boolean; consent: Consent; risk: TrustLevel; reasons: string[];
}
export interface Meta { stage: "rules" | "embedding" | "llm"; schemaVersion: string; degraded: boolean }

export type ResolveResult =
  | { status: "resolved"; object: RecastObject; routing: Routing | null; routeError?: string; alternatives: RecastObject[]; degraded: boolean; meta: Meta }
  | { status: "ambiguous"; alternatives: RecastObject[]; reason: string; degraded: boolean; meta: Meta }
  | { status: "unresolved"; reason: string; suggestion?: string; degraded: boolean; meta: Meta };
export type BatchItemResult = ResolveResult | { status: "error"; error: { code: string; message: string }; index: number };

export interface ResolveInput {
  raw: string; sourceUrl?: string; sourceType?: string;
  target?: { type?: ObjectType; destination?: string };
  options?: { confidenceThreshold?: number; includeProvenance?: boolean };
}
export interface BridgeInfo { id: string; name: string; bridge: string; bridgeReliability: string; objects: ObjectType[]; actions: string[] }
export interface CorrectionInput { objectId: string; kind: "undo" | "reject" | "edit"; field?: string; oldValue?: unknown; newValue?: unknown }
export interface Usage { limit: number | "unlimited" | null; used: number | null }
