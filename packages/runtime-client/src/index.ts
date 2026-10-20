/** What the control center needs from the Agent Runtime: who the agents are, what waits for a person, and what happened. */
export interface AgentScopeView { id: string; tool: string; action: string; calls: number; maxCalls: number; expiresAt: string }
export interface AgentView { agentId: string; name: string; createdAt: string; revoked: boolean; scopes: AgentScopeView[] }
export interface ApprovalView { id: string; agentId: string; tool: string; action: string; createdAt: number }
export interface AuditView { seq: number; at: string; agentId: string; tool: string; action: string; result: string; reason?: string; humanApproved?: boolean; hash: string }
export interface AuditReport { total: number; entries: AuditView[]; verification: { ok: true; entries: number } | { ok: false; brokenAt: number; reason: string } }

/** A Space: one agent's bounded configuration (docs/16-spaces.md). Money is in minor units of `currency`. */
export interface SpaceView {
  id: string; agentId: string; name: string; purpose?: string; state: "active" | "stopped" | "expired" | "exhausted";
  tools: { tool: string; action: string; approval?: "always" | "never" }[];
  calls: number; maxCalls: number; spend?: { currency: string; spentMinor: number; limitMinor: number };
  expiresAt: string; stoppedBy?: string;
}

export interface RuntimeClient {
  listAgents(): Promise<AgentView[]>;
  listApprovals(): Promise<ApprovalView[]>;
  /** `by` is the signed-in person; the runtime records it next to the decision. */
  decide(approvalId: string, approve: boolean, by: string): Promise<void>;
  audit(limit?: number): Promise<AuditReport>;
  listSpaces(): Promise<SpaceView[]>;
  /** Immediate and permanent. `by` is the signed-in person. */
  stopSpace(id: string, by: string): Promise<void>;
}

export class RuntimeError extends Error { constructor(m: string, readonly status: number) { super(m); this.name = "RuntimeError"; } }

/** Talks to the runtime's admin API. The admin token stays on the server: never give this client to browser code. */
export class HttpRuntimeClient implements RuntimeClient {
  constructor(private o: { baseUrl: string; adminToken: string; tenantId: string; fetch?: typeof fetch }) {}
  private async req(path: string, init: RequestInit = {}) {
    const r = await (this.o.fetch ?? fetch)(this.o.baseUrl.replace(/\/+$/, "") + path, { ...init, headers: { authorization: `Bearer ${this.o.adminToken}`, "content-type": "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new RuntimeError(j?.error?.message ?? `runtime answered ${r.status}`, r.status);
    return j;
  }
  async listAgents() { return (await this.req(`/admin/agents?tenant=${this.o.tenantId}`)).agents as AgentView[]; }
  async listApprovals() { return ((await this.req(`/admin/approvals?tenant=${this.o.tenantId}`)).approvals as any[]).map((a) => ({ id: a.id, agentId: a.agentId, tool: a.tool, action: a.action, createdAt: a.createdAt })); }
  async decide(id: string, approve: boolean, by: string) { await this.req(`/admin/approvals/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ tenant: this.o.tenantId, approve, by }) }); }
  async listSpaces(): Promise<SpaceView[]> {
    const j = await this.req(`/admin/spaces?tenant=${this.o.tenantId}`);
    return (j.spaces as any[]).map((s) => ({ id: s.id, agentId: s.agentId, name: s.name, ...(s.purpose ? { purpose: s.purpose } : {}), state: s.state,
      tools: (s.tools as any[]).map((t) => ({ tool: t.tool, action: t.action, ...(t.approval ? { approval: t.approval } : {}) })), calls: s.calls, maxCalls: s.budget.maxCalls,
      ...(s.budget.spend ? { spend: { currency: s.budget.spend.currency, spentMinor: s.spentMinor, limitMinor: s.budget.spend.limitMinor } } : {}), expiresAt: s.expiresAt, ...(s.stoppedBy ? { stoppedBy: s.stoppedBy } : {}) }));
  }
  async stopSpace(id: string, by: string) { await this.req(`/admin/spaces/${encodeURIComponent(id)}/stop`, { method: "POST", body: JSON.stringify({ tenant: this.o.tenantId, by }) }); }
  async audit(limit = 100): Promise<AuditReport> {
    const j = await this.req(`/admin/audit?tenant=${this.o.tenantId}&limit=${limit}`);
    return { total: j.total, verification: j.verification, entries: (j.entries as any[]).map((e) => ({ seq: e.seq, at: e.at, agentId: e.agentId, tool: e.tool, action: e.action, result: e.result, ...(e.reason ? { reason: e.reason } : {}), ...(e.humanApproved ? { humanApproved: true } : {}), hash: e.hash })) };
  }
}

/** Sample data so the control center runs and is testable without a runtime. State lives in memory. */
export class DemoRuntimeClient implements RuntimeClient {
  private approvals: ApprovalView[] = [{ id: "apr_demo00000001", agentId: "agt_9f3a2b000001", tool: "gmail", action: "send_email", createdAt: Date.now() - 120_000 }];
  private log: AuditView[] = [
    { seq: 1, at: "2026-10-15T09:58:00.000Z", agentId: "agt_9f3a2b000001", tool: "google_calendar", action: "create_event", result: "allowed", hash: "a1".repeat(32) },
    { seq: 2, at: "2026-10-15T09:58:01.000Z", agentId: "agt_9f3a2b000001", tool: "google_calendar", action: "create_event", result: "success", hash: "b2".repeat(32) },
    { seq: 3, at: "2026-10-15T09:59:10.000Z", agentId: "agt_9f3a2b000001", tool: "gmail", action: "delete_all", result: "denied", reason: "agent has no live scope for gmail.delete_all", hash: "c3".repeat(32) },
    { seq: 4, at: "2026-10-15T10:00:00.000Z", agentId: "agt_9f3a2b000001", tool: "gmail", action: "send_email", result: "pending_approval", reason: "rule mail-ask says require_approval", hash: "d4".repeat(32) },
  ];
  async listAgents(): Promise<AgentView[]> {
    return [{ agentId: "agt_9f3a2b000001", name: "calendar-bot", createdAt: "2026-10-14T08:00:00.000Z", revoked: false, scopes: [
      { id: "scp_1", tool: "google_calendar", action: "create_event", calls: 1, maxCalls: 50, expiresAt: "2026-10-15T18:00:00.000Z" }, { id: "scp_2", tool: "gmail", action: "send_email", calls: 0, maxCalls: 5, expiresAt: "2026-10-15T18:00:00.000Z" }] },
      { agentId: "agt_71c0de000002", name: "research-agent", createdAt: "2026-10-10T08:00:00.000Z", revoked: true, scopes: [] }];
  }
  async listApprovals() { return [...this.approvals]; }
  async decide(id: string, approve: boolean, by: string) {
    const a = this.approvals.find((x) => x.id === id); if (!a) throw new RuntimeError("no pending approval with that id (it may have been decided or expired)", 404);
    this.approvals = this.approvals.filter((x) => x.id !== id);
    this.log.push({ seq: this.log.length + 1, at: new Date().toISOString(), agentId: a.agentId, tool: a.tool, action: a.action, result: approve ? "allowed" : "denied", reason: `${approve ? "approved" : "rejected"} by ${by}`, humanApproved: approve, hash: String(this.log.length + 1).repeat(64).slice(0, 64) });
  }
  private spaces: SpaceView[] = [{ id: "spc_demo0001", agentId: "agt_9f3a2b000001", name: "Weekly team sync", purpose: "Book the Monday sync and invite the team", state: "active",
    tools: [{ tool: "google_calendar", action: "create_event" }, { tool: "gmail", action: "send_email", approval: "always" }], calls: 1, maxCalls: 20,
    spend: { currency: "INR", spentMinor: 0, limitMinor: 50_000 }, expiresAt: "2026-10-22T10:00:00.000Z" }];
  async listSpaces() { return this.spaces.map((s) => ({ ...s })); }
  async stopSpace(id: string, by: string) {
    const s = this.spaces.find((x) => x.id === id && x.state === "active"); if (!s) throw new RuntimeError("no active Space with that id", 404);
    s.state = "stopped"; s.stoppedBy = by;
  }
  async audit(): Promise<AuditReport> { return { total: this.log.length, entries: [...this.log], verification: { ok: true, entries: this.log.length } }; }
}

export function runtimeClientFromEnv(env: Record<string, string | undefined>): RuntimeClient {
  if (env.RUNTIME_URL && env.RUNTIME_ADMIN_TOKEN && env.RUNTIME_TENANT_ID) return new HttpRuntimeClient({ baseUrl: env.RUNTIME_URL, adminToken: env.RUNTIME_ADMIN_TOKEN, tenantId: env.RUNTIME_TENANT_ID });
  return new DemoRuntimeClient();
}
