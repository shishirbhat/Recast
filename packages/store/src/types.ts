export type Reliability = "official-api" | "accessibility" | "keyboard-simulation" | "visual" | "manual";

export interface StoredObject { id: string; kind: string; title: string; data: Record<string, unknown>; source?: string | undefined; createdAt: string }
export interface StoredRelationship { id: string; relation: string; fromId: string; toId: string; createdAt: string }
export interface Integration { destination: string; app: string; reliability: Reliability; enabled: boolean }
export interface Grant { id: string; destination: string; scope: string; grantedAt: string; revokedAt?: string | undefined }
export interface AuditEvent { seq: number; at: string; action: string; subject?: string | undefined; detail: Record<string, unknown> }

export interface Export { version: 1; exportedAt: string; objects: StoredObject[]; relationships: StoredRelationship[]; integrations: Integration[]; grants: Grant[]; audit: AuditEvent[] }

/** Everything the control center needs. Implementations must audit every change. */
export interface Repository {
  listObjects(): Promise<StoredObject[]>;
  putObject(o: Omit<StoredObject, "createdAt">): Promise<void>;
  deleteObject(id: string): Promise<void>;
  listRelationships(): Promise<StoredRelationship[]>;
  putRelationship(r: Omit<StoredRelationship, "createdAt">): Promise<void>;
  listIntegrations(): Promise<Integration[]>;
  setIntegration(i: Integration): Promise<void>;
  listGrants(): Promise<Grant[]>;
  grant(g: Omit<Grant, "grantedAt" | "revokedAt">): Promise<void>;
  revokeGrant(id: string): Promise<void>;
  listAudit(): Promise<AuditEvent[]>;
  exportAll(): Promise<Export>;
  /** Removes all objects, relationships, grants and integrations. The audit log keeps one line saying so. */
  deleteAll(): Promise<void>;
}
