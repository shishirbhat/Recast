-- Spaces: bounded configurations for one agent (docs/16-spaces.md). A Space narrows what scopes and policy already allow:
-- a list of tool actions with constraints, a call budget, an optional money budget, an expiry, and a permanent stop.
create table agent_spaces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  purpose text,
  tools jsonb not null check (jsonb_typeof(tools) = 'array' and jsonb_array_length(tools) between 1 and 50),
  max_calls int not null check (max_calls between 1 and 100000),
  calls int not null default 0 check (calls >= 0),
  spend_currency text check (spend_currency ~ '^[A-Z]{3}$'),
  spend_limit_minor bigint check (spend_limit_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active','stopped')),
  created_at timestamptz not null default now(),
  created_by text,
  stopped_at timestamptz,
  stopped_by text,
  check ((spend_currency is null) = (spend_limit_minor is null)),
  check (expires_at <= created_at + interval '30 days'),
  check ((status = 'stopped') = (stopped_at is not null))
);
create index agent_spaces_agent on agent_spaces(tenant_id, agent_id);
alter table agent_spaces enable row level security;
create policy spaces_read on agent_spaces for select using (is_member(tenant_id));

-- A stopped Space never starts again.
create function agent_spaces_no_restart() returns trigger language plpgsql as $$
begin
  if old.status = 'stopped' and new.status <> 'stopped' then raise exception 'a stopped Space cannot be restarted; create a new one'; end if;
  return new;
end $$;
create trigger agent_spaces_no_restart before update on agent_spaces for each row execute function agent_spaces_no_restart();

-- Take one call and p_cost from the budget, re-checking status and expiry under a row lock: two callers never share the last unit.
create function reserve_space(p_space uuid, p_cost bigint, p_now timestamptz) returns text language plpgsql as $$
declare s agent_spaces;
begin
  select * into s from agent_spaces where id = p_space for update;
  if not found then return 'not_found'; end if;
  if s.status = 'stopped' then return 'stopped'; end if;
  if s.expires_at <= p_now then return 'expired'; end if;
  if s.calls >= s.max_calls then return 'calls_exhausted'; end if;
  if p_cost > 0 and (s.spend_limit_minor is null or s.spent_minor + p_cost > s.spend_limit_minor) then return 'spend_exhausted'; end if;
  update agent_spaces set calls = calls + 1, spent_minor = spent_minor + p_cost where id = p_space;
  return 'ok';
end $$;
