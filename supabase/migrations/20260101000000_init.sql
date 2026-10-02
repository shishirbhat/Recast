-- Recast control center. Every row belongs to one user; row-level security enforces it.
-- Local-first: this database holds only what the user chose to sync.

create table objects (
  id text not null,
  owner uuid not null default auth.uid(),
  kind text not null,
  title text not null,
  data jsonb not null,
  source text,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table relationships (
  id text not null,
  owner uuid not null default auth.uid(),
  relation text not null,
  from_id text not null,
  to_id text not null,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table integrations (
  destination text not null,
  owner uuid not null default auth.uid(),
  app text not null,
  reliability text not null check (reliability in ('official-api','accessibility','keyboard-simulation','visual','manual')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (owner, destination)
);

create table grants (
  id text not null,
  owner uuid not null default auth.uid(),
  destination text not null,
  scope text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (owner, id)
);

create table audit_events (
  seq bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  at timestamptz not null default now(),
  action text not null,
  subject text,
  detail jsonb not null default '{}'::jsonb
);

alter table objects enable row level security;
alter table relationships enable row level security;
alter table integrations enable row level security;
alter table grants enable row level security;
alter table audit_events enable row level security;

create policy own_objects on objects for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy own_relationships on relationships for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy own_integrations on integrations for all using (owner = auth.uid()) with check (owner = auth.uid());
create policy own_grants on grants for all using (owner = auth.uid()) with check (owner = auth.uid());

-- Audit is append-only: read and insert your own rows, never update or delete them.
create policy audit_read on audit_events for select using (owner = auth.uid());
create policy audit_insert on audit_events for insert with check (owner = auth.uid());

-- "Delete everything": one call removes the caller's data and records that it happened.
create function delete_my_data() returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from relationships where owner = auth.uid();
  delete from objects where owner = auth.uid();
  delete from grants where owner = auth.uid();
  delete from integrations where owner = auth.uid();
  insert into audit_events(owner, action, subject) values (auth.uid(), 'data.deleted', 'all');
end $$;
revoke all on function delete_my_data() from public;
grant execute on function delete_my_data() to authenticated;
