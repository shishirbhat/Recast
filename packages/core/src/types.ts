import type { CapabilityContract, Evidence, Provenance } from "./generated/types.js";
export type { CapabilityContract, Evidence, Provenance };

export type ObjectType = "Person" | "Document" | "Event" | "Location" | "Image" | "Message" | "Task" | "Product" | "ResearchPaper";
export type TargetKind = "Event" | "Task" | "Project" | "Message" | "Claim" | "ResearchPaper" | "Product";
export type RiskTier = "low" | "medium" | "high";
export type Reliability = CapabilityContract["reliability"];
export type EffectFlag = NonNullable<CapabilityContract["accepts"][number]["effectFlags"]>[number];

export interface FieldMeta { confidence: number; evidence: Evidence[] }
export type Props = Record<string, unknown>;

export interface Candidate { type: ObjectType; properties: Props; fields: Record<string, FieldMeta>; provenance: Provenance }
export interface SemanticObject {
  readonly id: string; readonly type: ObjectType; readonly schemaVersion: "1.0.0";
  readonly properties: Readonly<Props>; readonly fields: Readonly<Record<string, FieldMeta>>;
  readonly provenance: Provenance; readonly extensions?: Readonly<Record<string, unknown>>;
}

export type PerceptionInput =
  | { kind: "jsonld"; docs: unknown[]; source: Provenance["source"]; at: string; adapter?: string }
  | { kind: "meta"; tags: { name: string; content: string }[]; source: Provenance["source"]; at: string }
  | { kind: "opengraph"; tags: { name: string; content: string }[]; source: Provenance["source"]; at: string };

export interface Approach { hintRelationId?: string }
export interface Preferences { approved?: { destination: string; relationId: string }[] }

export type ConsentKind = "release" | "confirm" | "hold";
export interface RiskAssessment {
  tier: RiskTier; consent: ConsentKind; requiresDeliberateChoice: boolean; reasons: string[];
}
export interface Proposal {
  id: string; object: SemanticObject; destination: CapabilityContract; relationId: string; relation: string;
  effect: string; effectFlags: EffectFlag[]; reversible: boolean; reliability: Reliability;
  dataMoved: string[]; confidence: number; risk: RiskAssessment; preferred: boolean;
  status: "ready" | "blocked"; blocked?: { reason: string; missing: string[] };
}
export interface Preview { summary: string; ghost: { targetKind: TargetKind; effect: string; rows: { label: string; value: string }[] }; sideEffects: false }
export interface Operation {
  opId: string; at: string; proposal: Proposal; risk: RiskAssessment;
  dataMoved: { path: string; value: string }[]; reliabilityLabel: string;
}
export type Consent = { kind: "release" } | { kind: "confirm" } | { kind: "hold"; heldMs: number };
export interface Receipt {
  receiptId: string; opId: string; at: string; status: "done" | "undone";
  objectId: string; destination: string; relationId: string; effect: string; reversible: boolean; bridgeRef?: string;
}
export type LogEntry =
  | { seq: number; at: string; kind: "commit"; receipt: Receipt }
  | { seq: number; at: string; kind: "undo"; receipt: Receipt }
  | { seq: number; at: string; kind: "failed"; opId: string; reason: string };
export type NewLogEntry = LogEntry extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

export interface EventLog { append(e: NewLogEntry): Promise<void>; entries(): Promise<readonly LogEntry[]> }
export interface Bridge {
  describe(): CapabilityContract;
  execute(op: Operation): Promise<{ ref?: string }>;
  undo(receipt: Receipt): Promise<void>;
}
export interface Env { now(): string }
export interface CommitEnv extends Env { bridge: Bridge; log: EventLog }
