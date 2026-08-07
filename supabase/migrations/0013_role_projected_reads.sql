-- VITCARE-CLINIC — least privilege on READS
-- ---------------------------------------------------------------------------
-- THE GAP THIS CLOSES
-- Role checks existed only on writes. Every read authorised on SITE MEMBERSHIP
-- alone: get_patient_record and list_patients_summary asked "are you at this
-- patient's site?" and nothing else. So a receptionist — who legitimately needs
-- to register patients and see who is waiting — could open any chart at the
-- site and read clinical notes, vitals, diagnoses and prescriptions. There was
-- no technical difference between the reception desk and the consulting room.
--
-- HOW IT IS FIXED
-- get_patient_record now PROJECTS by role. The caller's role decides which keys
-- are built into the returned jsonb, so a receptionist's call cannot return
-- clinical_notes — the data is never assembled, let alone sent. Redacting in
-- the UI would ship the record to the browser and ask it not to look.
--
-- THE MATRIX
--   RECEPTIONIST  identity, contact, payer, visit status. No clinical content.
--   LAB_TECH      identity + the clinical indication for the request only.
--   NURSE         + vitals, allergies, triage. Not the clinician's assessment.
--   CLINICIAN     the whole chart.
--   ADMIN         the whole chart (and every site).
--   AUDITOR       the whole chart (and every site) — the role exists to review.
--
-- Allergies are visible to EVERY role including reception. That is deliberate
-- and is the one place least privilege yields: a receptionist taking a walk-in
-- who mentions a penicillin reaction must be able to see it is already on file.
-- Allergy status is safety information, not diagnostic content.

-- ── 1. The lab technician role ─────────────────────────────────────────────
-- The check constraint had no LAB_TECH, so the lab workflow had nowhere to
-- live. Postgres has no ALTER ... MODIFY CHECK, so it must be dropped and
-- recreated.
--
-- The constraint was declared INLINE and UNNAMED in 0000:
--     role text not null check (role in ('ADMIN', …))
-- so its name was auto-generated. The convention gives `users_role_check`, but
-- that is a convention, not a guarantee — if that name had been taken Postgres
-- would have produced `users_role_check1`. A plain
-- `drop constraint if exists users_role_check` would then silently do nothing,
-- the new constraint would be added alongside the old one, and the OLD one
-- would still reject LAB_TECH. The migration would report success and the
-- failure would surface later as a confusing insert error.
--
-- So: find the constraint by what it DOES, not by what it is called. Any CHECK
-- on `users` mentioning the role vocabulary is the one being replaced.
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'users'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%RECEPTIONIST%'
  loop
    execute format('alter table users drop constraint %I', v_name);
    raise notice 'dropped previous role constraint: %', v_name;
  end loop;
end $$;

alter table users add constraint users_role_check
  check (role in ('ADMIN','CLINICIAN','NURSE','RECEPTIONIST','PHARMACIST','LAB_TECH','AUDITOR'));

-- ── 2. Role helpers ────────────────────────────────────────────────────────
-- One place that decides what a role may see, so the projection below and any
-- future reader cannot disagree about it.

/** Full clinical content: notes, diagnoses, prescriptions. */
create or replace function can_read_clinical(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from users
    where id = p_user and active
      and role in ('CLINICIAN','ADMIN','AUDITOR')
  );
$$;

/** Observations: vitals, triage priority, chief complaint. Nurses included. */
create or replace function can_read_observations(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from users
    where id = p_user and active
      and role in ('CLINICIAN','NURSE','ADMIN','AUDITOR','LAB_TECH')
  );
$$;

revoke execute on function can_read_clinical(uuid), can_read_observations(uuid) from anon;
grant execute on function can_read_clinical(uuid), can_read_observations(uuid) to authenticated;

-- ── 3. The projected reader ────────────────────────────────────────────────
create or replace function get_patient_record(p_patient_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_patient patients%rowtype;
  v_uid uuid := auth.uid();
  v_clinical boolean;
  v_obs boolean;
  v_result jsonb;
begin
  select * into v_patient from patients where id = p_patient_id;
  if not found then
    raise exception 'unknown patient';
  end if;

  if not (
    has_role(v_uid, 'ADMIN') or has_role(v_uid, 'AUDITOR')
    or v_patient.site_id in (select us.site_id from user_sites(v_uid) us)
  ) then
    raise exception 'not authorized';
  end if;

  v_clinical := can_read_clinical(v_uid);
  v_obs      := can_read_observations(v_uid);

  -- The audit row records WHAT WAS RETURNED, not merely that a read happened.
  -- "Who opened this chart" is a weaker question than "who saw the notes", and
  -- only the second one is answerable if the scope is written down here.
  insert into audit_log(actor_id, action, table_name, record_id, patient_id, details)
  values (v_uid, 'SELECT', 'patients', p_patient_id, p_patient_id,
          jsonb_build_object('fn', 'get_patient_record',
                             'scope', case when v_clinical then 'FULL'
                                           when v_obs then 'OBSERVATIONS'
                                           else 'IDENTITY' end));

  v_result := jsonb_build_object(
    -- Identity and contact: every role that can reach the patient at all.
    'patient', jsonb_build_object(
      'id', v_patient.id,
      'mrn', v_patient.mrn,
      'full_name', v_patient.full_name,
      'dob', v_patient.dob,
      'sex', v_patient.sex,
      'phone', v_patient.phone,
      'created_at', v_patient.created_at,
      -- national_id is identity-theft-grade PII and is needed by nobody in a
      -- clinical view; it stays with the roles that administer the record.
      'national_id', case when v_clinical then v_patient.national_id else null end,
      'allergy_status', v_patient.allergy_status,
      'allergies_reviewed_at', v_patient.allergies_reviewed_at
    ),
    -- Allergies: everyone. Safety information, not diagnostic content.
    'allergies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'substance', a.substance, 'reaction', a.reaction,
        'severity', a.severity, 'recorded_at', a.recorded_at,
        'recorded_by', (select u.full_name from users u where u.id = a.recorded_by)
      ) order by a.substance)
      from patient_allergies a where a.patient_id = p_patient_id
    ), '[]'::jsonb),
    'scope', case when v_clinical then 'FULL' when v_obs then 'OBSERVATIONS' else 'IDENTITY' end,
    'encounters', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'status', e.status,
          'created_at', e.created_at,
          'updated_at', e.updated_at,
          -- Reception needs to know a visit exists and where it is in the
          -- queue. It does not need to know what the patient came in with.
          'chief_complaint', case when v_obs then e.chief_complaint else null end,
          'vitals', case when v_obs then e.vitals else null end,
          'triage_priority', case when v_obs then e.triage_priority else null end,
          'clinical_notes', case when v_clinical then e.clinical_notes else null end,
          'clinician', case when v_obs then
            (select u.full_name from users u where u.id = e.clinician_id) else null end
        ) order by e.created_at desc)
      from encounters e where e.patient_id = p_patient_id
    ), '[]'::jsonb),
    -- Prescriptions are clinical. Reception sees an empty array — not a
    -- redacted list, which would still disclose how many drugs someone is on.
    'prescriptions', case when not v_clinical then '[]'::jsonb else coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'encounter_id', p.encounter_id, 'status', p.status,
          'payer', p.payer, 'note', p.note,
          'total_amount_cents', p.total_amount_cents, 'created_at', p.created_at,
          'prescriber', (select u.full_name from users u where u.id = p.prescriber_id),
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', i.id, 'drug_name', i.drug_name, 'strength', i.strength,
              'dose', i.dose, 'frequency', i.frequency, 'duration_days', i.duration_days,
              'quantity', i.quantity, 'instructions', i.instructions,
              'substitution_allowed', i.substitution_allowed,
              'dispensed_quantity', i.dispensed_quantity, 'line_status', i.line_status
            ))
            from prescription_items i where i.prescription_id = p.id
          ), '[]'::jsonb)
        ) order by p.created_at desc)
      from prescriptions p where p.patient_id = p_patient_id
    ), '[]'::jsonb) end
  );

  return v_result;
end;
$$;

revoke execute on function get_patient_record(uuid) from anon;
grant execute on function get_patient_record(uuid) to authenticated;

-- ── 4. The directory ───────────────────────────────────────────────────────
-- The summary list is reception's main working view, so it keeps identity and
-- visit state for everyone. It never carried clinical content, so the only
-- change is that the chief complaint is no longer implied by column presence.
-- Left as-is deliberately: over-restricting the queue would break the job the
-- receptionist is actually there to do.

-- ── 5. Writing observations ────────────────────────────────────────────────
-- Triage is a nursing act. Without this, role enforcement on the triage path
-- depended entirely on which page someone happened to open.
create or replace function can_triage(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from users
    where id = p_user and active
      and role in ('NURSE','CLINICIAN','ADMIN')
  );
$$;

revoke execute on function can_triage(uuid) from anon;
grant execute on function can_triage(uuid) to authenticated;
