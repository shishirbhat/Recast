-- Recast API: tenants, keys (hashed), usage, and opt-in corrections.
-- The API server uses the service role (bypasses RLS) to authenticate keys; these policies protect the dashboard path.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text not null default 'free' check (tier in ('free','pro','scale','enterprise')),
  corrections_opt_in boolean not null default false,
  created_at timestamptz not null default now()
);

create table tenant_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','member')),
  primary key (tenant_id, user_id)
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key_hash text not null unique,                 -- sha256 of the key. The key itself is shown once and never stored.
  label text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table api_usage (
  tenant_id uuid not null references tenants(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  resolutions bigint not null default 0,
  primary key (tenant_id, month)
);

create table api_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  object_id text not null,
  field text,
  old_value jsonb,
  new_value jsonb,
  kind text not null check (kind in ('undo','reject','edit')),
  at timestamptz not null default now()
);

-- Consent is enforced where the data lands, not just in application code:
-- a correction cannot be stored for a tenant that has not opted in, whoever is writing (service role included).
create function require_corrections_opt_in() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from tenants t where t.id = new.tenant_id and t.corrections_opt_in) then
    raise exception 'tenant has not opted in to storing corrections' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger corrections_need_consent before insert on api_corrections for each row execute function require_corrections_opt_in();

-- Atomic usage counting: no read-modify-write race between concurrent requests.
create function record_usage(p_tenant uuid, p_month text, p_n bigint) returns bigint language sql as $$
  insert into api_usage(tenant_id, month, resolutions) values (p_tenant, p_month, p_n)
  on conflict (tenant_id, month) do update set resolutions = api_usage.resolutions + excluded.resolutions
  returning resolutions $$;

alter table tenants enable row level security;
alter table tenant_members enable row level security;
alter table api_keys enable row level security;
alter table api_usage enable row level security;
alter table api_corrections enable row level security;

create function is_member(p_tenant uuid, p_owner_only boolean default false) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tenant_members m where m.tenant_id = p_tenant and m.user_id = auth.uid() and (not p_owner_only or m.role = 'owner')) $$;

create policy tenants_read on tenants for select using (is_member(id));
create policy tenants_update on tenants for update using (is_member(id, true)) with check (is_member(id, true));
create policy members_read on tenant_members for select using (is_member(tenant_id));
create policy keys_read on api_keys for select using (is_member(tenant_id));
create policy keys_insert on api_keys for insert with check (is_member(tenant_id, true));
create policy keys_revoke on api_keys for update using (is_member(tenant_id, true)) with check (is_member(tenant_id, true));
create policy usage_read on api_usage for select using (is_member(tenant_id));
create policy corrections_read on api_corrections for select using (is_member(tenant_id));
-- No insert/update/delete policies on usage or corrections: only the server (service role) writes them.
