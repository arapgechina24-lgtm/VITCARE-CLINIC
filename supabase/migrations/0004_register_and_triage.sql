-- VITCARE-CLINIC — register_patient / submit_triage / save_consult_notes RPCs
-- ---------------------------------------------------------------------------
-- Same reasoning as submit_prescription: patients has no direct SELECT grant
-- to `authenticated` (0000_base_schema.sql), and PostgREST's `.insert().select()`
-- needs SELECT privilege to return the inserted row (RETURNING requires SELECT
-- on Postgres). So patient creation — like patient reads — goes through a
-- SECURITY DEFINER RPC rather than a direct client-side insert.

create or replace function register_patient(
  p_full_name text,
  p_dob date,
  p_sex text,
  p_phone text,
  p_national_id text,
  p_site_id uuid,
  p_chief_complaint text
)
returns table(patient_id uuid, encounter_id uuid)
language plpgsql security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
  v_encounter_id uuid;
  v_mrn text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to register patients';
  end if;
  if p_site_id not in (select site_id from user_sites(auth.uid())) then
    raise exception 'not authorized for this site';
  end if;

  -- VC-YYYYMMDD-xxxxxx — human-readable, collision-safe enough for a single
  -- clinic's daily volume without needing a sequence table.
  v_mrn := 'VC-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  insert into patients (mrn, full_name, dob, sex, phone, national_id, site_id, created_by)
  values (v_mrn, p_full_name, p_dob, p_sex, p_phone, p_national_id, p_site_id, auth.uid())
  returning id into v_patient_id;

  insert into encounters (patient_id, site_id, status, chief_complaint, created_by)
  values (v_patient_id, p_site_id, 'TRIAGE', p_chief_complaint, auth.uid())
  returning id into v_encounter_id;

  return query select v_patient_id, v_encounter_id;
end;
$$;

revoke execute on function register_patient(text, date, text, text, text, uuid, text) from anon;
grant execute on function register_patient(text, date, text, text, text, uuid, text) to authenticated;

-- ── Triage ────────────────────────────────────────────────────────────────
create or replace function submit_triage(
  p_encounter_id uuid,
  p_vitals jsonb,
  p_chief_complaint text,
  p_priority text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
begin
  if not (has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'only a nurse can record triage';
  end if;

  select site_id into v_site_id from encounters where id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select site_id from user_sites(auth.uid())) then
    raise exception 'not authorized for this site';
  end if;

  update encounters
  set vitals = p_vitals,
      chief_complaint = coalesce(p_chief_complaint, chief_complaint),
      triage_priority = p_priority,
      status = 'IN_CONSULT',
      updated_at = now()
  where id = p_encounter_id;
end;
$$;

revoke execute on function submit_triage(uuid, jsonb, text, text) from anon;
grant execute on function submit_triage(uuid, jsonb, text, text) to authenticated;

-- ── Consult notes ─────────────────────────────────────────────────────────
create or replace function save_consult_notes(p_encounter_id uuid, p_clinical_notes text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
begin
  if not has_role(auth.uid(), 'CLINICIAN') then
    raise exception 'only a clinician can record consult notes';
  end if;

  select site_id into v_site_id from encounters where id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select site_id from user_sites(auth.uid())) then
    raise exception 'not authorized for this site';
  end if;

  update encounters
  set clinical_notes = p_clinical_notes,
      clinician_id = auth.uid(),
      updated_at = now()
  where id = p_encounter_id;
end;
$$;

revoke execute on function save_consult_notes(uuid, text) from anon;
grant execute on function save_consult_notes(uuid, text) to authenticated;
