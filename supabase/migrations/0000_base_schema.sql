-- VITCARE-CLINIC — Phase 0 base schema
-- ---------------------------------------------------------------------------
-- This runs BEFORE any feature migration. It establishes:
--   1. Sites, staff (users), and site membership (who can see what).
--   2. Patients + encounters — the clinical core.
--   3. has_role() / user_sites() — the two functions every RLS policy in this
--      project is built on.
--   4. audit_log — append-only, and the only writable path onto it is via
--      trigger (writes) or a SECURITY DEFINER RPC (reads). Direct table
--      access to patients/encounters is revoked from `authenticated` below —
--      the RPC functions are the only door in, so a read cannot happen
--      without also being audited. This is what makes "audit on every
--      patient-record access" a property of the schema, not a habit an
--      individual route handler has to remember.
-- Kenya's Data Protection Act 2019 classifies health data as sensitive
-- personal data — access logging is a compliance requirement, not a nicety.

create extension if not exists "pgcrypto";

-- ── Base grants ──────────────────────────────────────────────────────────
-- Explicit on purpose: RLS policies restrict rows, but a role still needs the
-- underlying table privilege before a policy is even consulted. A fresh
-- Supabase project's default privileges aren't something this migration
-- should depend on implicitly — every grant this schema relies on is spelled
-- out here or beside the table it applies to (patients' SELECT revoke, near
-- the end of this file, is the one deliberate exception).
grant usage on schema public to authenticated;

-- ── Sites ────────────────────────────────────────────────────────────────
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  county text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table sites enable row level security;
-- Every authenticated staff member can see the list of sites (needed to pick
-- a fulfillment_site_id, show a site selector, etc.) — no patient data here.
create policy sites_read_all on sites for select using (auth.role() = 'authenticated');

-- ── Staff (mirrors auth.users; one row per staff member) ────────────────
create table if not exists users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('ADMIN','CLINICIAN','NURSE','RECEPTIONIST','PHARMACIST','AUDITOR')),
  license_no text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table users enable row level security;
create policy users_read_self on users for select using (id = auth.uid());
create policy users_admin_read_all on users for select using (
  exists (select 1 from users u where u.id = auth.uid() and u.role = 'ADMIN')
);

-- Which site(s) each staff member belongs to (many-to-many: a clinician can
-- rotate between sites; Phase 1 only ever populates one row per user, but
-- the model shouldn't need a migration to support a second clinic later).
create table if not exists user_site_memberships (
  user_id uuid not null references users(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  primary key (user_id, site_id)
);
alter table user_site_memberships enable row level security;
create policy user_site_memberships_read_self on user_site_memberships
  for select using (user_id = auth.uid());

-- ── RLS helper functions ─────────────────────────────────────────────────
-- SECURITY DEFINER: these run with the privilege to read `users`/
-- `user_site_memberships` directly, bypassing RLS ON THOSE TWO TABLES ONLY,
-- so that a policy on (say) `patients` can call has_role()/user_sites()
-- without recursing into patients' own RLS. Never widen what these touch.
create or replace function has_role(p_user uuid, p_role text)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (select 1 from users where id = p_user and role = p_role and active);
$$;

create or replace function user_sites(p_user uuid)
returns table(site_id uuid)
language sql security definer stable
set search_path = public
as $$
  select site_id from user_site_memberships where user_id = p_user;
$$;

-- ── Patients ─────────────────────────────────────────────────────────────
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  mrn text not null unique,
  full_name text not null,
  dob date,
  sex text check (sex in ('M','F','OTHER')),
  phone text,
  national_id text,
  site_id uuid not null references sites(id),   -- registering/home site
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table patients enable row level security;

-- Direct SELECT is intentionally NOT granted here — see get_patient()/
-- list_patients() below and the REVOKE at the bottom of this file. RLS
-- policies still exist (defense in depth if a future migration re-grants
-- SELECT by mistake) but the normal path is the audited RPCs only.
create policy patients_site_read on patients
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
create policy patients_registration_write on patients
  for insert with check (
    created_by = auth.uid()
    and (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN'))
  );
create policy patients_clinical_update on patients
  for update using (site_id in (select site_id from user_sites(auth.uid())));

-- ── Encounters (one visit: triage → consult → prescribe) ────────────────
create table if not exists encounters (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  site_id uuid not null references sites(id),
  clinician_id uuid references users(id),
  status text not null default 'TRIAGE'
    check (status in ('TRIAGE','IN_CONSULT','COMPLETED','CANCELLED')),
  chief_complaint text,
  vitals jsonb,
  triage_priority text check (triage_priority in ('EMERGENCY','URGENT','ROUTINE')),
  clinical_notes text,                  -- consult diagnosis/assessment, free text
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table encounters enable row level security;
create policy encounters_site_read on encounters
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
create policy encounters_site_write on encounters
  for insert with check (
    created_by = auth.uid()
    and site_id in (select site_id from user_sites(auth.uid()))
  );
create policy encounters_site_update on encounters
  for update using (site_id in (select site_id from user_sites(auth.uid())));

-- ── Audit log — append-only ──────────────────────────────────────────────
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid references users(id),
  action text not null,                 -- 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT'
  table_name text not null,
  record_id uuid,
  patient_id uuid,                      -- denormalized for fast "who saw this patient" queries
  details jsonb
);
alter table audit_log enable row level security;
-- No insert/update/delete policy for any client role — every row is written
-- by a SECURITY DEFINER function (see below) or a trigger, both of which run
-- as the function owner and bypass RLS. Only ADMIN/AUDITOR can read it back.
create policy audit_log_admin_read on audit_log
  for select using (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR'));

-- ── Write-side audit trigger ─────────────────────────────────────────────
-- IMPORTANT: this one function is attached to patients/encounters/
-- prescriptions/prescription_items, which don't share a column set. PL/pgSQL
-- resolves a named field on NEW/OLD (new.patient_id) against the actual row
-- type of whichever table fired the trigger — even inside a CASE branch that
-- isn't selected at runtime — so a direct `new.patient_id` reference breaks
-- the moment this fires on `patients` (no patient_id column there). Every
-- field that isn't common to all four tables goes through
-- to_jsonb(...)->>'field' instead: a plain key lookup that can't error on a
-- missing key, unlike a compiled attribute reference. `id` IS common to all
-- four (every table's PK), so coalesce(new.id, old.id) stays a direct access.
create or replace function audit_row_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
  v_row jsonb := to_jsonb(coalesce(new, old));
begin
  v_patient_id := case
    when TG_TABLE_NAME = 'patients' then coalesce(new.id, old.id)
    when TG_TABLE_NAME in ('encounters', 'prescriptions') then (v_row ->> 'patient_id')::uuid
    when TG_TABLE_NAME = 'prescription_items' then (
      select patient_id from prescriptions where id = (v_row ->> 'prescription_id')::uuid
    )
    else null
  end;
  insert into audit_log(actor_id, action, table_name, record_id, patient_id, details)
  values (auth.uid(), TG_OP, TG_TABLE_NAME, coalesce(new.id, old.id), v_patient_id, v_row);
  return coalesce(new, old);
end;
$$;

create trigger trg_audit_patients after insert or update or delete on patients
  for each row execute function audit_row_change();
create trigger trg_audit_encounters after insert or update or delete on encounters
  for each row execute function audit_row_change();

-- ── Read-side audit RPCs — the only sanctioned way to read patient rows ──
-- Postgres has no SELECT trigger, so read-auditing can't be done mechanically
-- at the table level the way write-auditing can. Instead: revoke direct
-- SELECT on `patients` from `authenticated` (bottom of file) and expose reads
-- only through these two functions, each of which logs before it returns.
create or replace function get_patient(p_patient_id uuid)
returns setof patients
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or exists (
      select 1 from patients p
      where p.id = p_patient_id and p.site_id in (select site_id from user_sites(auth.uid()))
    )
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, record_id, patient_id, details)
  values (auth.uid(), 'SELECT', 'patients', p_patient_id, p_patient_id, jsonb_build_object('fn', 'get_patient'));

  return query select * from patients where id = p_patient_id;
end;
$$;

create or replace function list_patients(p_site_id uuid, p_search text default null)
returns setof patients
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select site_id from user_sites(auth.uid()))
  ) then
    raise exception 'not authorized';
  end if;

  -- One audit row per call (not per patient row) — a list view is a single
  -- access event; logging every row in a 500-patient list would bury the
  -- signal a reviewer actually cares about ("who pulled this list, when").
  insert into audit_log(actor_id, action, table_name, patient_id, details)
  values (auth.uid(), 'SELECT', 'patients', null, jsonb_build_object('fn', 'list_patients', 'site_id', p_site_id, 'search', p_search));

  return query
    select * from patients
    where site_id = p_site_id
      and (p_search is null or full_name ilike '%' || p_search || '%' or mrn ilike '%' || p_search || '%');
end;
$$;

-- Supabase's own project template grants EXECUTE on every new public-schema
-- function to BOTH `anon` and `authenticated` by default (via `alter default
-- privileges ... grant execute on functions to anon, authenticated`) — this
-- is NOT Postgres's own PUBLIC-grant default, it's a Supabase convention, and
-- `revoke ... from public` does nothing against it. Confirmed by inspecting
-- pg_proc.proacl directly: anon had an explicit `anon=X/postgres` entry.
-- Every SECURITY DEFINER function here must revoke from `anon` BY NAME. The
-- internal has_role()/user_sites() checks would still reject an anon caller
-- (auth.uid() is null for them), but there's no reason that surface should be
-- reachable at all.
revoke execute on function get_patient(uuid) from anon;
revoke execute on function list_patients(uuid, text) from anon;
revoke execute on function has_role(uuid, text) from anon;
revoke execute on function user_sites(uuid) from anon;
revoke execute on function audit_row_change() from anon;
revoke execute on function audit_row_change() from authenticated;

grant execute on function get_patient(uuid) to authenticated;
grant execute on function list_patients(uuid, text) to authenticated;
grant execute on function has_role(uuid, text) to authenticated;
grant execute on function user_sites(uuid) to authenticated;
-- audit_row_change() is trigger-only — nobody, not even `authenticated`, calls
-- it directly, so no grant-back after the revoke above.

-- Stop any *future* function created in this schema from silently
-- re-acquiring anon EXECUTE the moment it's created.
alter default privileges in schema public revoke execute on functions from anon;

-- ── Table grants (RLS policies above decide which rows; these decide which
-- operations are even on the table). `patients` gets insert/update but
-- deliberately no select — see the revoke just below.
grant select on sites to authenticated;
grant select on users to authenticated;
grant select on user_site_memberships to authenticated;
grant insert, update on patients to authenticated;
grant select, insert, update on encounters to authenticated;

-- Direct table SELECT stays revoked for normal staff roles — RPCs above are
-- SECURITY DEFINER and read the table as their owner regardless of this
-- revoke, so they keep working. Anything reading `patients` straight via
-- supabase.from('patients').select(...) from the app will now fail loudly
-- instead of silently skipping the audit log.
revoke select on patients from authenticated;
