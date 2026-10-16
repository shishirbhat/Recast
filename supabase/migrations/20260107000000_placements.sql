-- Placements through the API: the tenant's destination credentials (encrypted by the server) and every receipt, for undo.

-- Access tokens are encrypted with AES-256-GCM by the API server before they reach the database, bound to (tenant, destination)
-- so a row copied to another tenant does not decrypt. The database never sees a plain token. No policies: users cannot read these.
create table api_credentials (
  tenant_id uuid not null references tenants(id) on delete cascade,
  destination text not null check (destination ~ '^[a-z_]{1,64}$'),
  sealed text not null check (sealed like 'v1:%'),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, destination)
);
alter table api_credentials enable row level security;

create table api_placements (
  receipt_id text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  destination text not null,
  target jsonb not null,
  receipt jsonb not null,
  data_moved jsonb not null,
  status text not null default 'done' check (status in ('done','undoing','undone')),
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index api_placements_tenant on api_placements(tenant_id, created_at desc);
alter table api_placements enable row level security;
create policy placements_read on api_placements for select using (is_member(tenant_id));
-- Writes go through the server (service role): it holds the credentials and runs the bridge.
