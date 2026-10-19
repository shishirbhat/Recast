-- Release cohorts: which audience a tenant belongs to (docs/RELEASE_STATES.md).
-- A capability is available to a tenant when the tenant's cohort is at or before the capability's release state
-- (internal < private < preview < public). New tenants start in 'public', the narrowest access: they get only what is
-- generally released, and an operator moves design partners into 'private' or 'preview' deliberately.
-- This is not an authorisation boundary: keys, RLS, consent, grants and policy still apply on top.
alter table tenants add column cohort text not null default 'public'
  check (cohort in ('internal','private','preview','public'));
