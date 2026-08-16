-- VITCARE-CLINIC — Appointments
-- ---------------------------------------------------------------------------
-- Replaces the mock schedule that has backed the overview screen since Phase 0
-- (src/lib/mock.ts said "delete this file as each module gets a real backend" —
-- this is that).
--
-- ── THE DESIGN DECISION THAT MATTERS ────────────────────────────────────────
-- A booking system's job is not to store appointments. It is to refuse the
-- ones that cannot happen. Double-booking is therefore prevented by an
-- EXCLUSION CONSTRAINT in the database, not by a check in the booking form:
-- two receptionists on two machines can pass the same application-level check
-- simultaneously and both write. Postgres taking the second one's lock and
-- rejecting the row is the only version of this that is actually true under
-- concurrency, which is precisely the condition a busy front desk creates.
--
-- ── WHY ARRIVAL CREATES AN ENCOUNTER ────────────────────────────────────────
-- The clinic already has one clinical spine: Register → Triage → Consult →
-- Prescribe, carried by `encounters`. An appointments module that kept its own
-- parallel notion of "the patient is here" would fork that spine, and the two
-- would disagree within a week. So arrive_appointment() does not invent a
-- state — it opens a real encounter in TRIAGE and links to it. A booked
-- patient who walks in lands in exactly the same queue as a walk-in, which is
-- what the nurse on the floor already understands.
--
-- ── READS GO THROUGH AN RPC, AS EVERYWHERE ELSE ─────────────────────────────
-- A schedule shows patient names, so it is a patient-data read, so it goes
-- through the same audited SECURITY DEFINER door as list_encounters (0003).
-- Direct SELECT on `patients` stays revoked; nothing here re-grants it.

-- Required for the exclusion constraint below: it mixes an equality test on
-- clinician_id (btree semantics) with an overlap test on a range (gist
-- semantics) in a single index, which core Postgres cannot do alone.
create extension if not exists btree_gist;

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  site_id uuid not null references sites(id),
  -- Nullable on purpose: reception routinely books "first available" before a
  -- clinician is named. An unassigned appointment is a real, plannable thing;
  -- forcing a placeholder clinician would corrupt the utilisation figures that
  -- make this module worth having.
  clinician_id uuid references users(id),
  starts_at timestamptz not null,
  duration_min integer not null default 30 check (duration_min between 5 and 480),
  -- Derived from starts_at + duration_min, maintained by the trigger below,
  -- and NOT a generated column. The obvious spelling —
  --   exclude using gist (tstzrange(starts_at, starts_at + make_interval(...)))
  -- — is rejected by Postgres with 42P17 "functions in index expression must be
  -- marked IMMUTABLE, because timestamptz + interval is only STABLE: interval
  -- arithmetic can consult the TimeZone setting, so its result is not a pure
  -- function of its inputs. A generated column fails for the same reason.
  -- Materialising the instant makes the index expression tstzrange(ts, ts),
  -- which is immutable, and leaves a directly queryable end time behind.
  ends_at timestamptz not null,
  reason text,
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED','CONFIRMED','ARRIVED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW')),
  -- Set by arrive_appointment(). Null until the patient is actually here.
  encounter_id uuid references encounters(id),
  cancel_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table appointments enable row level security;

-- The constraint described at the top of this file. Scoped by a WHERE clause
-- to clinician-assigned appointments in a live state: a cancelled or no-show
-- slot must be re-bookable, and unassigned appointments cannot clash with
-- anything because they are not yet anybody's time.
-- Keeps ends_at honest no matter which path writes the row — the RPCs below,
-- a future bulk import, or a hand-run UPDATE during an incident. Putting this
-- in the RPCs instead would mean the constraint silently stops matching
-- reality the first time anything else writes.
create or replace function appointments_set_ends_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.ends_at := new.starts_at + make_interval(mins => new.duration_min);
  return new;
end;
$$;
revoke execute on function appointments_set_ends_at() from anon;
revoke execute on function appointments_set_ends_at() from authenticated;

drop trigger if exists trg_appointments_ends_at on appointments;
create trigger trg_appointments_ends_at before insert or update on appointments
  for each row execute function appointments_set_ends_at();

alter table appointments drop constraint if exists appointments_no_double_booking;
alter table appointments add constraint appointments_no_double_booking
  exclude using gist (
    clinician_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (clinician_id is not null and status in ('SCHEDULED','CONFIRMED','ARRIVED','IN_PROGRESS'));

-- Day and week views always filter by site and scan a time window; the
-- clinician index serves the per-clinician timeline rows.
create index if not exists appointments_site_start_idx on appointments (site_id, starts_at);
create index if not exists appointments_clinician_start_idx on appointments (clinician_id, starts_at);
create index if not exists appointments_patient_idx on appointments (patient_id);

-- Policies mirror `encounters`: readable within your site, written by the
-- desk roles. As with patients, the RPCs below are the intended door — these
-- policies are the defence-in-depth layer under them.
create policy appointments_site_read on appointments
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
create policy appointments_desk_write on appointments
  for insert with check (
    created_by = auth.uid()
    and site_id in (select site_id from user_sites(auth.uid()))
    and (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN'))
  );
create policy appointments_site_update on appointments
  for update using (site_id in (select site_id from user_sites(auth.uid())));

grant select, insert, update on appointments to authenticated;

-- ── Audit ─────────────────────────────────────────────────────────────────
-- audit_row_change() is recreated rather than left alone because its CASE has
-- to learn one new table name. Everything else about it is byte-identical to
-- 0000_base_schema.sql — including the to_jsonb(...)->>'field' access pattern,
-- which is load-bearing: a direct new.patient_id reference breaks the moment
-- this trigger fires on `patients`, which has no such column. Appointments do
-- have patient_id, so they join the encounters/prescriptions branch.
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
    when TG_TABLE_NAME in ('encounters', 'prescriptions', 'appointments') then (v_row ->> 'patient_id')::uuid
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
revoke execute on function audit_row_change() from anon;
revoke execute on function audit_row_change() from authenticated;

drop trigger if exists trg_audit_appointments on appointments;
create trigger trg_audit_appointments after insert or update or delete on appointments
  for each row execute function audit_row_change();

-- ── Read: the schedule ────────────────────────────────────────────────────
create or replace function list_appointments(
  p_site_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  id uuid,
  patient_id uuid,
  patient_full_name text,
  patient_mrn text,
  patient_phone text,
  clinician_id uuid,
  clinician_name text,
  starts_at timestamptz,
  duration_min integer,
  reason text,
  status text,
  encounter_id uuid
)
language plpgsql security definer
set search_path = public
as $$
begin
  -- The `us` alias is not cosmetic: site_id is also an output column of some
  -- functions in this schema, and PL/pgSQL treats those as locals for the whole
  -- body. list_encounters (0003) carries the same note for the same reason.
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  -- One audit row per call, not per appointment — same reasoning as
  -- list_patients: a day view is a single access event, and logging each row
  -- would bury "who opened the schedule, when" under the noise.
  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients',
          jsonb_build_object('fn', 'list_appointments', 'site_id', p_site_id, 'from', p_from, 'to', p_to));

  return query
    select a.id, a.patient_id, p.full_name, p.mrn, p.phone,
           a.clinician_id, u.full_name, a.starts_at, a.duration_min,
           a.reason, a.status, a.encounter_id
    from appointments a
    join patients p on p.id = a.patient_id
    left join users u on u.id = a.clinician_id
    where a.site_id = p_site_id
      and a.starts_at >= p_from
      and a.starts_at < p_to
    order by a.starts_at asc;
end;
$$;
revoke execute on function list_appointments(uuid, timestamptz, timestamptz) from anon;
grant execute on function list_appointments(uuid, timestamptz, timestamptz) to authenticated;

-- ── Read: who can be booked ───────────────────────────────────────────────
-- `users` is readable only by yourself or an ADMIN (0000_base_schema.sql), so
-- a receptionist cannot populate a clinician picker with a plain select. This
-- exposes exactly the three columns a picker needs and nothing else — not
-- license_no, not the full row.
create or replace function list_site_clinicians(p_site_id uuid)
returns table (id uuid, full_name text, role text)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select u.id, u.full_name, u.role
    from users u
    join user_site_memberships m on m.user_id = u.id
    where m.site_id = p_site_id
      and u.active
      and u.role in ('CLINICIAN', 'NURSE', 'ADMIN')
    order by u.full_name;
end;
$$;
revoke execute on function list_site_clinicians(uuid) from anon;
grant execute on function list_site_clinicians(uuid) to authenticated;

-- ── Write: book ───────────────────────────────────────────────────────────
create or replace function book_appointment(
  p_patient_id uuid,
  p_site_id uuid,
  p_clinician_id uuid,
  p_starts_at timestamptz,
  p_duration_min integer,
  p_reason text
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to book appointments';
  end if;
  if p_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if not exists (select 1 from patients where id = p_patient_id and site_id = p_site_id) then
    raise exception 'unknown patient for this site';
  end if;

  insert into appointments (patient_id, site_id, clinician_id, starts_at, duration_min, reason, created_by)
  values (p_patient_id, p_site_id, p_clinician_id, p_starts_at, coalesce(p_duration_min, 30), p_reason, auth.uid())
  returning id into v_id;

  return v_id;

-- The exclusion constraint speaks in Postgres ("conflicting key value violates
-- exclusion constraint"). A receptionist with a patient at the desk needs to be
-- told what to DO, so it is translated here rather than leaked to the UI.
exception when exclusion_violation then
  raise exception 'That clinician is already booked over this time — pick another slot or clinician.';
end;
$$;
revoke execute on function book_appointment(uuid, uuid, uuid, timestamptz, integer, text) from anon;
grant execute on function book_appointment(uuid, uuid, uuid, timestamptz, integer, text) to authenticated;

-- ── Write: reschedule ─────────────────────────────────────────────────────
create or replace function reschedule_appointment(
  p_appointment_id uuid,
  p_starts_at timestamptz,
  p_duration_min integer,
  p_clinician_id uuid default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to reschedule appointments';
  end if;

  select a.site_id, a.status into v_site_id, v_status from appointments a where a.id = p_appointment_id;
  if v_site_id is null then
    raise exception 'unknown appointment';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  -- Moving a visit that already happened would rewrite history, and the
  -- encounter it produced is already timestamped elsewhere.
  if v_status in ('COMPLETED', 'CANCELLED', 'NO_SHOW') then
    raise exception 'a % appointment cannot be rescheduled', lower(v_status);
  end if;

  update appointments
  set starts_at = p_starts_at,
      duration_min = coalesce(p_duration_min, duration_min),
      clinician_id = coalesce(p_clinician_id, clinician_id),
      updated_at = now()
  where id = p_appointment_id;

exception when exclusion_violation then
  raise exception 'That clinician is already booked over this time — pick another slot or clinician.';
end;
$$;
revoke execute on function reschedule_appointment(uuid, timestamptz, integer, uuid) from anon;
grant execute on function reschedule_appointment(uuid, timestamptz, integer, uuid) to authenticated;

-- ── Write: status ─────────────────────────────────────────────────────────
-- ARRIVED is deliberately NOT settable here — it is the one transition with a
-- side effect (it opens an encounter), so it has its own function below. A
-- status enum that can be set freely from the client is how an appointment
-- ends up marked arrived with nobody in the queue.
create or replace function set_appointment_status(
  p_appointment_id uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if p_status not in ('SCHEDULED','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW') then
    raise exception 'unsupported status %', p_status;
  end if;

  select a.site_id, a.status into v_site_id, v_status from appointments a where a.id = p_appointment_id;
  if v_site_id is null then
    raise exception 'unknown appointment';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status in ('COMPLETED', 'CANCELLED') then
    raise exception 'a % appointment is closed', lower(v_status);
  end if;

  update appointments
  set status = p_status,
      cancel_reason = case when p_status in ('CANCELLED','NO_SHOW') then p_reason else cancel_reason end,
      updated_at = now()
  where id = p_appointment_id;
end;
$$;
revoke execute on function set_appointment_status(uuid, text, text) from anon;
grant execute on function set_appointment_status(uuid, text, text) to authenticated;

-- ── Write: arrival — the join onto the clinical spine ─────────────────────
-- Idempotent by design. "Patient is here" is a button a busy front desk will
-- press twice; the second press must return the same encounter rather than
-- open a second one and split the patient's visit in half.
create or replace function arrive_appointment(p_appointment_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_patient_id uuid;
  v_reason text;
  v_encounter_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to check patients in';
  end if;

  select a.site_id, a.status, a.patient_id, a.reason, a.encounter_id
    into v_site_id, v_status, v_patient_id, v_reason, v_encounter_id
  from appointments a where a.id = p_appointment_id;

  if v_site_id is null then
    raise exception 'unknown appointment';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status in ('CANCELLED', 'NO_SHOW') then
    raise exception 'a % appointment cannot be checked in', lower(v_status);
  end if;

  if v_encounter_id is not null then
    return v_encounter_id;
  end if;

  insert into encounters (patient_id, site_id, status, chief_complaint, created_by)
  values (v_patient_id, v_site_id, 'TRIAGE', v_reason, auth.uid())
  returning id into v_encounter_id;

  update appointments
  set status = 'ARRIVED', encounter_id = v_encounter_id, updated_at = now()
  where id = p_appointment_id;

  return v_encounter_id;
end;
$$;
revoke execute on function arrive_appointment(uuid) from anon;
grant execute on function arrive_appointment(uuid) to authenticated;
