-- Erasure versus an append-only audit log.
-- The audit log refuses every update, delete and truncate. A customer still has the right to have their data erased.
-- The one way through is erase_tenant(): it writes a receipt first, and the audit guard lets a delete through only for
-- the tenant named on an in-progress receipt created in the same transaction. Nothing else can delete audit history.

create table tenant_erasures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,                   -- no foreign key: the tenant is gone afterwards; the receipt stays
  tenant_name text not null,
  requested_by text not null check (length(requested_by) between 1 and 200),
  reason text not null check (length(reason) between 1 and 1000),
  audit_entries bigint not null,
  audit_head_hash text,                      -- the chain's last hash before erasure: ties the receipt to an exported copy
  txid bigint not null default txid_current(),
  status text not null default 'in_progress' check (status in ('in_progress','done')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table tenant_erasures enable row level security;   -- no policies: only the server reads receipts

-- Receipts are themselves append-only, except for finishing an erasure inside its own transaction.
create function tenant_erasures_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'in_progress' and old.txid = txid_current() and new.status = 'done'
     and new.id = old.id and new.tenant_id = old.tenant_id and new.audit_entries = old.audit_entries
     and new.audit_head_hash is not distinct from old.audit_head_hash and new.requested_by = old.requested_by and new.reason = old.reason then
    return new;
  end if;
  raise exception 'tenant_erasures is append-only (% not allowed)', tg_op using errcode = 'insufficient_privilege';
end $$;
create trigger erasures_no_update before update on tenant_erasures for each row execute function tenant_erasures_guard();
create trigger erasures_no_delete before delete on tenant_erasures for each row execute function tenant_erasures_guard();
create trigger erasures_no_truncate before truncate on tenant_erasures for each statement execute function tenant_erasures_guard();

-- The audit guard, now aware of erasure. Security definer so it can read receipts whoever is deleting.
create or replace function audit_log_is_append_only() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from tenant_erasures e where e.tenant_id = old.tenant_id and e.status = 'in_progress' and e.txid = txid_current()
  ) then
    return old;
  end if;
  raise exception 'agent_audit_log is append-only (% not allowed)', tg_op using errcode = 'insufficient_privilege';
end $$;

-- Erase one tenant and everything it owns: keys, usage, corrections, members, agents, scopes, policies, approvals,
-- revocations, proofs seen, idempotency records, rate-limit bucket and the audit log. Returns the receipt id.
-- Export first (recast-keys tenant export); the receipt's audit_head_hash lets anyone check that export later.
create function erase_tenant(p_tenant uuid, p_confirm text, p_requested_by text, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_name text; v_n bigint; v_head text; v_id uuid;
begin
  if p_confirm is distinct from 'ERASE ' || p_tenant::text then
    raise exception 'confirmation must be exactly: ERASE %', p_tenant using errcode = 'check_violation';
  end if;
  select name into v_name from tenants where id = p_tenant for update;
  if not found then raise exception 'no such tenant' using errcode = 'no_data_found'; end if;
  select count(*) into v_n from agent_audit_log where tenant_id = p_tenant;
  select hash into v_head from agent_audit_log where tenant_id = p_tenant order by seq desc limit 1;
  insert into tenant_erasures(tenant_id, tenant_name, requested_by, reason, audit_entries, audit_head_hash)
    values (p_tenant, v_name, p_requested_by, p_reason, v_n, v_head) returning id into v_id;
  delete from api_rate_buckets where bucket = p_tenant::text;
  delete from tenants where id = p_tenant;              -- every tenant-owned table cascades from here
  update tenant_erasures set status = 'done', finished_at = now() where id = v_id;
  return v_id;
end $$;
revoke all on function erase_tenant(uuid, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function erase_tenant(uuid, text, text, text) to service_role; end if;
end $$;
