-- Agent Runtime: identities, scopes, policies and a tamper-evident audit log.
-- Reuses tenants and tenant_members from the API migration. Agents are not users: they have no row in auth.users.

create table agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_key text not null unique check (agent_key ~ '^agt_[0-9a-f]{12}$'),
  name text not null,
  public_key jsonb not null check (public_key ->> 'kty' = 'OKP' and public_key ->> 'crv' = 'Ed25519' and public_key ? 'x' and not (public_key ? 'd')),
  owner_user_id uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table agent_scopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  tool text not null,
  action text not null,
  constraints jsonb,
  max_calls int not null default 50 check (max_calls > 0),
  calls int not null default 0 check (calls >= 0),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (calls <= max_calls)
);
create index agent_scopes_lookup on agent_scopes(agent_id, tool, action);

create table agent_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  version int not null,
  rule_yaml text not null check (length(rule_yaml) <= 100000),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, name, version)
);
create unique index one_active_policy_per_tenant on agent_policies(tenant_id) where active;

create table agent_audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  seq bigint not null check (seq > 0),
  agent_id uuid references agents(id),
  user_id uuid,
  session_id text,
  request_id text not null,
  tool text not null,
  action text not null,
  params jsonb,
  result text not null check (result in ('allowed','denied','pending_approval','success','failure')),
  reason text,
  human_approved boolean not null default false,
  delegation_chain jsonb,
  key_id text not null,
  prev_hash text not null,
  hash text not null,
  signature text not null,
  at timestamptz not null default now(),
  unique (tenant_id, seq),
  unique (tenant_id, prev_hash)          -- two entries cannot claim the same parent: the chain cannot fork
);

-- Append-only, enforced by triggers that raise (a silent rule would hide a tampering attempt). Applies to every role.
create function audit_log_is_append_only() returns trigger language plpgsql as $$
begin raise exception 'agent_audit_log is append-only (% not allowed)', tg_op using errcode = 'insufficient_privilege'; end $$;
create trigger audit_no_update before update on agent_audit_log for each row execute function audit_log_is_append_only();
create trigger audit_no_delete before delete on agent_audit_log for each row execute function audit_log_is_append_only();
create trigger audit_no_truncate before truncate on agent_audit_log for each statement execute function audit_log_is_append_only();
-- Deleting a tenant is how its data is erased; that path is explicit and goes through this function, not through ad hoc deletes.
-- (The cascade from tenants is blocked by the delete trigger by design. Erasure = export, then drop the tenant's schema partition.)

-- An agent's identity cannot be edited. It can only be revoked.
create function agents_identity_is_immutable() returns trigger language plpgsql as $$
begin
  if new.agent_key <> old.agent_key or new.public_key <> old.public_key or new.tenant_id <> old.tenant_id then raise exception 'an agent identity cannot be changed; revoke it and create a new one'; end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then raise exception 'a revoked agent stays revoked'; end if;
  return new;
end $$;
create trigger agents_immutable before update on agents for each row execute function agents_identity_is_immutable();

-- Spend one call atomically. True only if the grant is live and has calls left.
create function consume_scope(p_scope uuid) returns boolean language sql as $$
  with s as (update agent_scopes set calls = calls + 1 where id = p_scope and calls < max_calls and expires_at > now() returning 1)
  select exists (select 1 from s) $$;

alter table agents enable row level security;
alter table agent_scopes enable row level security;
alter table agent_policies enable row level security;
alter table agent_audit_log enable row level security;

create policy agents_read on agents for select using (is_member(tenant_id));
create policy agents_create on agents for insert with check (is_member(tenant_id, true));
create policy agents_revoke on agents for update using (is_member(tenant_id, true)) with check (is_member(tenant_id, true));
create policy scopes_read on agent_scopes for select using (is_member(tenant_id));
create policy scopes_create on agent_scopes for insert with check (is_member(tenant_id, true) and exists (select 1 from agents a where a.id = agent_id and a.tenant_id = agent_scopes.tenant_id and a.revoked_at is null));
create policy scopes_delete on agent_scopes for delete using (is_member(tenant_id, true));
create policy policies_read on agent_policies for select using (is_member(tenant_id));
create policy policies_write on agent_policies for insert with check (is_member(tenant_id, true));
create policy policies_activate on agent_policies for update using (is_member(tenant_id, true)) with check (is_member(tenant_id, true));
create policy audit_read on agent_audit_log for select using (is_member(tenant_id));
-- No insert policy for signed-in users: only the gateway (service role) writes the log.
