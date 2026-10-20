-- A Space's own rules (a recipe's policy pack, docs/19-recipes.md): deny or require_approval only, checked here too.
alter table agent_spaces add column rules jsonb not null default '[]'::jsonb
  check (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) <= 100);
create function agent_spaces_rules_only_tighten() returns trigger language plpgsql as $$
begin
  if exists (select 1 from jsonb_array_elements(new.rules) r where r->>'then' not in ('deny','require_approval') or r ? 'agent') then
    raise exception 'a Space may only add deny or require_approval rules';
  end if;
  return new;
end $$;
create trigger agent_spaces_rules_only_tighten before insert or update on agent_spaces for each row execute function agent_spaces_rules_only_tighten();
