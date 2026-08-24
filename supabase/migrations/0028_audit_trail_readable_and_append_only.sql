-- VITCARE-CLINIC — the audit trail: readable, and impossible to erase
-- ---------------------------------------------------------------------------
-- The log has been written faithfully since 3 August — 257 entries covering
-- reads, writes and domain events. Two things were missing.
--
-- ── 1. NOTHING COULD READ IT ───────────────────────────────────────────────
-- The sidebar has carried an "Audit log / Soon" chip since the shell was
-- built. An audit trail nobody can open is a compliance artefact, not a
-- control: the point of recording who opened which chart is that somebody
-- looks. list_audit_log() below is that somebody's tool.
--
-- ── 2. THE GRANTS DID NOT MATCH THE INTENT ─────────────────────────────────
-- `authenticated` held UPDATE, DELETE and TRUNCATE on audit_log — and on every
-- other table in the schema.
--
-- Being accurate about how bad that was, because overstating it would be its
-- own kind of error: it is NOT currently reachable. PostgREST exposes no
-- TRUNCATE verb, `authenticated` is a NOLOGIN role so nobody can open a direct
-- session as it, and UPDATE/DELETE are refused by RLS because audit_log has
-- only a SELECT policy. Nothing was exposed and nothing was lost.
--
-- It is still wrong, and worth fixing precisely because of the one asymmetry
-- in that paragraph: RLS DOES NOT APPLY TO TRUNCATE. Every other verb on these
-- tables is protected by a policy; TRUNCATE is protected only by the grant. So
-- the grant is the whole control, and it was open. A table whose entire value
-- is that it cannot be rewritten should not be one privilege away from being
-- emptied.
--
-- audit_log becomes APPEND-ONLY: insert yes, select by policy, and no verb that
-- can alter or remove a line. Same posture as `payments` in 0020, for the same
-- reason — a record of what happened is worthless if the person it implicates
-- can edit it.

-- ── Append-only ───────────────────────────────────────────────────────────
revoke update, delete, truncate on audit_log from authenticated;

-- TRUNCATE is revoked across the schema, not just here. No application role
-- has ever needed it, RLS cannot mitigate it, and leaving it granted means
-- every table's protection depends on a verb the policies never see.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke truncate on table %s from authenticated, anon', r.tbl);
  end loop;
end;
$$;

-- ── Reading it ────────────────────────────────────────────────────────────
-- ADMIN and AUDITOR, matching audit_log_admin_read and CAN.audit.
--
-- Deliberately NOT site-scoped. audit_log has no site_id column — a site lives
-- inside `details` for some rows and is absent for others — so a p_site_id
-- parameter could only ever be a filter that silently missed entries, which on
-- an audit screen is worse than no filter at all. The facility has one site;
-- when that changes, the column comes first and the parameter second.
--
-- Reading the audit log is itself audited, so this function writes one entry
-- per call. That means opening the screen shows your own previous visit near
-- the top. That is not noise — "who has been reading the audit trail" is
-- exactly the access an audit trail exists to record.
create or replace function list_audit_log(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor_id uuid default null,
  p_action text default null,
  p_table_name text default null,
  p_patient_id uuid default null,
  p_limit integer default 200
)
returns table (
  id bigint,
  occurred_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_role text,
  action text,
  table_name text,
  record_id uuid,
  patient_id uuid,
  patient_name text,
  patient_mrn text,
  details jsonb
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')) then
    raise exception 'not authorized to read the audit log';
  end if;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'audit_log',
          jsonb_build_object('fn', 'list_audit_log', 'actor', p_actor_id,
                             'action', p_action, 'table', p_table_name));

  return query
    select a.id, a.occurred_at, a.actor_id,
           -- A deactivated account keeps its name here on purpose: the entry
           -- records who did the thing at the time, and that does not change
           -- because the account was later closed.
           coalesce(u.full_name, '(account removed)'),
           u.role,
           a.action, a.table_name, a.record_id, a.patient_id,
           p.full_name, p.mrn,
           a.details
    from audit_log a
    left join users u on u.id = a.actor_id
    left join patients p on p.id = a.patient_id
    where (p_from is null or a.occurred_at >= p_from)
      and (p_to is null or a.occurred_at < p_to)
      and (p_actor_id is null or a.actor_id = p_actor_id)
      and (p_action is null or a.action = p_action)
      and (p_table_name is null or a.table_name = p_table_name)
      and (p_patient_id is null or a.patient_id = p_patient_id)
    order by a.occurred_at desc, a.id desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;
revoke execute on function list_audit_log(timestamptz, timestamptz, uuid, text, text, uuid, integer)
  from public, anon;
grant execute on function list_audit_log(timestamptz, timestamptz, uuid, text, text, uuid, integer)
  to authenticated;

-- ── What the screen puts at the top ───────────────────────────────────────
-- Counts for the window, so a reviewer sees the shape of the period before
-- reading 200 individual lines.
create or replace function audit_summary(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  total bigint,
  reads bigint,
  writes bigint,
  actors bigint,
  patients_touched bigint,
  oldest timestamptz,
  newest timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')) then
    raise exception 'not authorized to read the audit log';
  end if;

  return query
    select count(*),
           count(*) filter (where a.action = 'SELECT'),
           count(*) filter (where a.action in ('INSERT', 'UPDATE', 'DELETE')),
           count(distinct a.actor_id),
           count(distinct a.patient_id) filter (where a.patient_id is not null),
           min(a.occurred_at),
           max(a.occurred_at)
    from audit_log a
    where (p_from is null or a.occurred_at >= p_from)
      and (p_to is null or a.occurred_at < p_to);
end;
$$;
revoke execute on function audit_summary(timestamptz, timestamptz) from public, anon;
grant execute on function audit_summary(timestamptz, timestamptz) to authenticated;

-- ── The filter pickers ────────────────────────────────────────────────────
-- Actors and action/table names actually present in the log, so the screen
-- offers what exists rather than a hardcoded list that drifts.
create or replace function audit_filter_options()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_out jsonb;
begin
  if not (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')) then
    raise exception 'not authorized to read the audit log';
  end if;

  select jsonb_build_object(
    'actors', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.actor_id, 'name', x.name) order by x.name)
      from (
        select distinct a.actor_id, coalesce(u.full_name, '(account removed)') as name
        from audit_log a left join users u on u.id = a.actor_id
        where a.actor_id is not null
      ) x), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(distinct a.action order by a.action) from audit_log a), '[]'::jsonb),
    'tables',  coalesce((select jsonb_agg(distinct a.table_name order by a.table_name) from audit_log a), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke execute on function audit_filter_options() from public, anon;
grant execute on function audit_filter_options() to authenticated;
