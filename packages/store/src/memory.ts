import type { AuditEvent, Export, Grant, Integration, Repository, StoredObject, StoredRelationship } from "./types";

/** Local-first default and the reference behaviour the SQL implementation is tested against. */
export class MemoryRepository implements Repository {
  private objects = new Map<string, StoredObject>();
  private rels = new Map<string, StoredRelationship>();
  private ints = new Map<string, Integration>();
  private grants = new Map<string, Grant>();
  private audit: AuditEvent[] = [];
  constructor(private now: () => Date = () => new Date()) {}
  private log(action: string, subject?: string, detail: Record<string, unknown> = {}) {
    this.audit.push({ seq: this.audit.length + 1, at: this.now().toISOString(), action, subject, detail });
  }
  async listObjects() { return [...this.objects.values()].sort((a, b) => a.title.localeCompare(b.title)); }
  async putObject(o: Omit<StoredObject, "createdAt">) {
    const prev = this.objects.get(o.id);
    this.objects.set(o.id, { ...o, createdAt: prev?.createdAt ?? this.now().toISOString() });
    this.log(prev ? "object.updated" : "object.created", o.id, { kind: o.kind });
  }
  async deleteObject(id: string) {
    if (!this.objects.delete(id)) return;
    for (const [k, r] of this.rels) if (r.fromId === id || r.toId === id) this.rels.delete(k);
    this.log("object.deleted", id);
  }
  async listRelationships() { return [...this.rels.values()]; }
  async putRelationship(r: Omit<StoredRelationship, "createdAt">) {
    this.rels.set(r.id, { ...r, createdAt: this.rels.get(r.id)?.createdAt ?? this.now().toISOString() });
    this.log("relationship.placed", r.id, { relation: r.relation });
  }
  async listIntegrations() { return [...this.ints.values()].sort((a, b) => a.app.localeCompare(b.app)); }
  async setIntegration(i: Integration) { this.ints.set(i.destination, i); this.log(i.enabled ? "integration.enabled" : "integration.disabled", i.destination); }
  async listGrants() { return [...this.grants.values()]; }
  async grant(g: Omit<Grant, "grantedAt" | "revokedAt">) { this.grants.set(g.id, { ...g, grantedAt: this.now().toISOString() }); this.log("grant.created", g.id, { scope: g.scope }); }
  async revokeGrant(id: string) {
    const g = this.grants.get(id); if (!g || g.revokedAt) return;
    this.grants.set(id, { ...g, revokedAt: this.now().toISOString() }); this.log("grant.revoked", id);
  }
  async listAudit() { return [...this.audit]; }
  async exportAll(): Promise<Export> {
    return { version: 1, exportedAt: this.now().toISOString(), objects: await this.listObjects(), relationships: await this.listRelationships(), integrations: await this.listIntegrations(), grants: await this.listGrants(), audit: await this.listAudit() };
  }
  async deleteAll() { this.objects.clear(); this.rels.clear(); this.ints.clear(); this.grants.clear(); this.log("data.deleted", "all"); }
}
