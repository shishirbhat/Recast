-- What the Postgres-backed stores need beyond the first agent-runtime migration.

-- The exact audit entry as it was signed. Verification must hash the original object, and a relational row cannot tell
-- "field absent" from "field false", so the signed body is kept whole. The columns stay for querying.
alter table agent_audit_log add column entry jsonb;

-- Same atomic spend, but against the caller's clock (the gateway injects time; tests control it).
create function consume_scope(p_scope uuid, p_now timestamptz) returns boolean language sql as $$
  with s as (update agent_scopes set calls = calls + 1 where id = p_scope and calls < max_calls and expires_at > p_now returning 1)
  select exists (select 1 from s) $$;

create table agent_approvals (
  id text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  tool text not null,
  action text not null,
  request_hash text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','used')),
  created_ms bigint not null,
  decided_by text
);
create index agent_approvals_lookup on agent_approvals(tenant_id, request_hash, status);
alter table agent_approvals enable row level security;
create policy approvals_read on agent_approvals for select using (is_member(tenant_id));
-- Decisions go through the server (service role) so that a person's identity is verified there, not asserted by a client.

create table agent_revoked_tokens (
  jti text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  primary key (tenant_id, jti)
);
alter table agent_revoked_tokens enable row level security;
create policy revoked_read on agent_revoked_tokens for select using (is_member(tenant_id));

-- Replace the active policy with a new version in one step (the partial unique index allows only one active row).
create function activate_policy(p_tenant uuid, p_name text, p_yaml text) returns int language plpgsql as $$
declare v int;
begin
  select coalesce(max(version), 0) + 1 into v from agent_policies where tenant_id = p_tenant and name = p_name;
  update agent_policies set active = false where tenant_id = p_tenant and active;
  insert into agent_policies(tenant_id, name, version, rule_yaml, active) values (p_tenant, p_name, v, p_yaml, true);
  return v;
end $$;

-- DPoP proofs: a proof id may be used once per tenant inside its window. The primary key makes "first use" atomic.
create table agent_dpop_seen (
  tenant_id uuid not null references tenants(id) on delete cascade,
  jti text not null,
  seen_ms bigint not null,
  primary key (tenant_id, jti)
);
create index agent_dpop_seen_age on agent_dpop_seen(seen_ms);
alter table agent_dpop_seen enable row level security;      -- written only by the gateway (service role); no policies for users
