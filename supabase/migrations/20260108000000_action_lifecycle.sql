-- Placements follow the shared action lifecycle (packages/core/src/lifecycle.ts, docs/DECISIONS.md D16).
-- Every placement keeps its history of steps; an unknown outcome keeps the reference used to reconcile it with the provider.
alter table api_placements add column action jsonb not null default '[]'::jsonb;
alter table api_placements add column reconcile_ref text;
alter table api_placements drop constraint api_placements_status_check;
update api_placements set status = case status when 'done' then 'succeeded' when 'undoing' then 'reversing' when 'undone' then 'reversed' else status end;
alter table api_placements alter column status set default 'succeeded';
alter table api_placements add constraint api_placements_status_check
  check (status in ('succeeded', 'reversing', 'reversed', 'outcome_unknown', 'failed'));
alter table api_placements rename column undone_at to reversed_at;
