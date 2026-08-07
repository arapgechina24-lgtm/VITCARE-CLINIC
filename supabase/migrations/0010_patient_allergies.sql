-- VITCARE-CLINIC — drug allergies
-- ---------------------------------------------------------------------------
-- The single most important design decision in this file is that "no allergies
-- recorded" and "no known allergies" are DIFFERENT VALUES, not the same empty
-- list.
--
--   UNRECORDED  — nobody has asked this patient yet. We know nothing.
--   NONE_KNOWN  — somebody asked, and the answer was none.
--   PRESENT     — somebody asked, and there is a list.
--
-- Collapsing the first two into "no rows in the allergies table" is the classic
-- way an EMR kills someone: a clinician sees a blank allergy field, reads it as
-- reassurance, and prescribes. An empty list cannot distinguish "safe" from
-- "never asked", so the assertion is stored explicitly and the UI refuses to
-- let a prescription be sent while the status is UNRECORDED.
--
-- Allergies are health data under the Data Protection Act 2019 and are treated
-- exactly like the rest of the record: no direct SELECT grant, reads only
-- through the audited get_patient_record RPC, every write audited by trigger.

-- ── Patient-level assertion ────────────────────────────────────────────────
alter table patients
  add column if not exists allergy_status text not null default 'UNRECORDED';

-- Added separately so re-running against a table that already has the column
-- does not fail on a duplicate constraint name.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'patients_allergy_status_check') then
    alter table patients add constraint patients_allergy_status_check
      check (allergy_status in ('UNRECORDED', 'NONE_KNOWN', 'PRESENT'));
  end if;
end $$;

-- Who asked, and when. A five-year-old allergy review is not the same fact as
-- one taken this morning, and a reviewer needs to see which they are looking at.
alter table patients add column if not exists allergies_reviewed_at timestamptz;
alter table patients add column if not exists allergies_reviewed_by uuid references users(id);

-- ── The list itself ────────────────────────────────────────────────────────
create table if not exists patient_allergies (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  -- Free text on purpose. There is no drug dictionary in this system yet, and a
  -- constrained picker that cannot express "sulfa drugs" or a local brand name
  -- would push clinicians into recording nothing at all.
  substance text not null check (length(btrim(substance)) > 0),
  reaction text,                      -- "rash", "anaphylaxis", "swelling"
  severity text check (severity in ('MILD', 'MODERATE', 'SEVERE')),
  recorded_by uuid not null references users(id),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_patient_allergies_patient_id on patient_allergies(patient_id);

alter table patient_allergies enable row level security;

-- Defence in depth. The normal read path is get_patient_record; this policy
-- exists so a future migration that mistakenly re-grants SELECT still cannot
-- leak across sites.
create policy patient_allergies_site_read on patient_allergies
  for select using (
    exists (
      select 1 from patients p
      where p.id = patient_allergies.patient_id
        and (p.site_id in (select site_id from user_sites((select auth.uid())))
             or has_role((select auth.uid()), 'AUDITOR'))
    )
  );

revoke select on patient_allergies from authenticated, anon;

-- ── Audit ──────────────────────────────────────────────────────────────────
-- Extends the existing trigger function with the new table. patient_allergies
-- carries patient_id directly, so it joins the encounters/prescriptions branch.
-- Field access goes through to_jsonb rather than NEW.patient_id because
-- PL/pgSQL resolves NEW/OLD field references against the actual row type even
-- inside a CASE branch that does not match — the bug that broke this function
-- once already.
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
    when TG_TABLE_NAME in ('encounters', 'prescriptions', 'patient_allergies')
      then (v_row ->> 'patient_id')::uuid
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

drop trigger if exists trg_audit_patient_allergies on patient_allergies;
create trigger trg_audit_patient_allergies
  after insert or update or delete on patient_allergies
  for each row execute function audit_row_change();

-- ── Write path ─────────────────────────────────────────────────────────────
-- One RPC for the whole assertion, because the status and the list must agree.
-- Setting them separately would allow PRESENT with an empty list — a patient
-- flagged as allergic to nothing in particular, which blocks prescribing
-- forever and tells a clinician nothing.
create or replace function set_patient_allergies(
  p_patient_id uuid,
  p_status text,
  p_allergies jsonb default '[]'::jsonb   -- [{substance, reaction, severity}]
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_count int;
begin
  if p_status not in ('UNRECORDED', 'NONE_KNOWN', 'PRESENT') then
    raise exception 'invalid allergy status: %', p_status;
  end if;

  select site_id into v_site_id from patients where id = p_patient_id;
  if v_site_id is null then
    raise exception 'unknown patient';
  end if;

  -- Taking an allergy history is a clinical act. Reception can register a
  -- patient but must not assert what they are or are not allergic to.
  if not (
    has_role(auth.uid(), 'CLINICIAN') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')
  ) then
    raise exception 'not authorized to record allergies';
  end if;

  if not (
    has_role(auth.uid(), 'ADMIN')
    or v_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  v_count := coalesce(jsonb_array_length(p_allergies), 0);

  -- The status and the list are one assertion; they cannot disagree.
  if p_status = 'PRESENT' and v_count = 0 then
    raise exception 'PRESENT requires at least one allergy';
  end if;
  if p_status <> 'PRESENT' and v_count > 0 then
    raise exception 'allergies were supplied but status is %', p_status;
  end if;

  -- Replace wholesale. The audit trigger records every deleted and inserted
  -- row, so the previous list is fully recoverable from audit_log — a removed
  -- allergy is exactly the kind of change a reviewer needs to be able to see.
  delete from patient_allergies where patient_id = p_patient_id;

  if v_count > 0 then
    insert into patient_allergies (patient_id, substance, reaction, severity, recorded_by)
    select
      p_patient_id,
      btrim(a ->> 'substance'),
      nullif(btrim(coalesce(a ->> 'reaction', '')), ''),
      nullif(btrim(coalesce(a ->> 'severity', '')), ''),
      auth.uid()
    from jsonb_array_elements(p_allergies) a
    where length(btrim(coalesce(a ->> 'substance', ''))) > 0;
  end if;

  update patients
     set allergy_status        = p_status,
         allergies_reviewed_at = now(),
         allergies_reviewed_by = auth.uid(),
         updated_at            = now()
   where id = p_patient_id;
end;
$$;

revoke execute on function set_patient_allergies(uuid, text, jsonb) from anon;
grant execute on function set_patient_allergies(uuid, text, jsonb) to authenticated;

-- ── Read path ──────────────────────────────────────────────────────────────
-- get_patient_record gains the allergy block. Replacing the whole function
-- rather than adding a second RPC keeps the guarantee that opening a chart is
-- ONE audited call — a separate allergies fetch would be a second, unlogged
-- read of health data.
create or replace function get_patient_record(p_patient_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_patient patients%rowtype;
  v_result jsonb;
begin
  select * into v_patient from patients where id = p_patient_id;
  if not found then
    raise exception 'unknown patient';
  end if;

  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or v_patient.site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, record_id, patient_id, details)
  values (auth.uid(), 'SELECT', 'patients', p_patient_id, p_patient_id,
          jsonb_build_object('fn', 'get_patient_record'));

  select jsonb_build_object(
    'patient', to_jsonb(v_patient),
    'allergies', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'substance', a.substance,
          'reaction', a.reaction,
          'severity', a.severity,
          'recorded_at', a.recorded_at,
          'recorded_by', (select u.full_name from users u where u.id = a.recorded_by)
        ) order by a.substance)
      from patient_allergies a where a.patient_id = p_patient_id
    ), '[]'::jsonb),
    'encounters', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'status', e.status,
          'chief_complaint', e.chief_complaint,
          'vitals', e.vitals,
          'triage_priority', e.triage_priority,
          'clinical_notes', e.clinical_notes,
          'created_at', e.created_at,
          'updated_at', e.updated_at,
          'clinician', (select u.full_name from users u where u.id = e.clinician_id)
        ) order by e.created_at desc)
      from encounters e where e.patient_id = p_patient_id
    ), '[]'::jsonb),
    'prescriptions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'encounter_id', p.encounter_id,
          'status', p.status,
          'payer', p.payer,
          'note', p.note,
          'total_amount_cents', p.total_amount_cents,
          'created_at', p.created_at,
          'prescriber', (select u.full_name from users u where u.id = p.prescriber_id),
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', i.id,
              'drug_name', i.drug_name,
              'strength', i.strength,
              'dose', i.dose,
              'frequency', i.frequency,
              'duration_days', i.duration_days,
              'quantity', i.quantity,
              'instructions', i.instructions,
              'substitution_allowed', i.substitution_allowed,
              'dispensed_quantity', i.dispensed_quantity,
              'line_status', i.line_status
            ))
            from prescription_items i where i.prescription_id = p.id
          ), '[]'::jsonb)
        ) order by p.created_at desc)
      from prescriptions p where p.patient_id = p_patient_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ── Prescribing gate, enforced in the database ─────────────────────────────
-- The UI blocks sending while allergies are UNRECORDED. That is where the
-- clinician is told why, but it is not where the rule lives — a UI check is a
-- courtesy, not a control, and this one protects against a category of harm
-- that must not depend on which screen the request came from.
create or replace function assert_allergies_reviewed(p_patient_id uuid)
returns void
language plpgsql
stable
set search_path = public
as $$
declare
  v_status text;
begin
  select allergy_status into v_status from patients where id = p_patient_id;
  if v_status is null then
    raise exception 'unknown patient';
  end if;
  if v_status = 'UNRECORDED' then
    raise exception 'ALLERGIES_UNRECORDED' using errcode = 'P0003';
  end if;
end;
$$;
