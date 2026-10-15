-- Shared API state, so every server instance enforces the same limits and replays the same idempotent responses.
-- Written only by the server (service role). RLS on, no policies: no signed-in user can read or write these.

create table api_rate_buckets (
  bucket text primary key,
  tokens double precision not null,
  at_ms bigint not null
);

-- Token bucket in one transaction with the row locked: concurrent requests cannot both spend the last token.
-- Returns tokens left after taking one (>= 0) when allowed, or tokens - 1 (< 0) when refused; the caller derives Retry-After.
create function take_token(p_bucket text, p_rps double precision, p_burst double precision, p_now_ms bigint) returns double precision
language plpgsql as $$
declare t double precision;
begin
  if p_rps <= 0 or p_burst < 1 then raise exception 'rps must be > 0 and burst >= 1' using errcode = 'check_violation'; end if;
  insert into api_rate_buckets(bucket, tokens, at_ms) values (p_bucket, p_burst, p_now_ms) on conflict (bucket) do nothing;
  select least(p_burst, tokens + greatest(0, p_now_ms - at_ms) / 1000.0 * p_rps) into t from api_rate_buckets where bucket = p_bucket for update;
  if t >= 1 then
    update api_rate_buckets set tokens = t - 1, at_ms = greatest(at_ms, p_now_ms) where bucket = p_bucket;
  else
    update api_rate_buckets set tokens = t, at_ms = greatest(at_ms, p_now_ms) where bucket = p_bucket;
  end if;
  return t - 1;
end $$;

-- An idempotency key is reserved before the work runs (status null), then completed with the response.
-- The primary key makes the reservation atomic: of two concurrent requests with the same key, exactly one runs.
create table api_idempotency (
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null check (length(key) between 1 and 255),
  body_hash text not null,
  status int,
  response jsonb,
  created_ms bigint not null,
  primary key (tenant_id, key)
);

-- Housekeeping, safe to run on a schedule: drops expired idempotency records and idle buckets.
create function purge_api_state(p_now_ms bigint, p_idem_ttl_ms bigint default 86400000, p_bucket_idle_ms bigint default 3600000) returns void
language sql as $$
  delete from api_idempotency where created_ms < p_now_ms - p_idem_ttl_ms;
  delete from api_rate_buckets where at_ms < p_now_ms - p_bucket_idle_ms;
$$;

alter table api_rate_buckets enable row level security;
alter table api_idempotency enable row level security;
