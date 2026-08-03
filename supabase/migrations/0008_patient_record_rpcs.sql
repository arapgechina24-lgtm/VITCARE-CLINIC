-- VITCARE-CLINIC — reads backing the patient directory and the EMR view
-- ---------------------------------------------------------------------------
-- Both are SECURITY DEFINER and both write an audit row BEFORE returning,
-- because `patients` has no direct SELECT grant to `authenticated` — these
-- RPCs are the only door in (see 0000_base_schema.sql).
--
-- get_patient_record returns the entire chart in one call. That coupling is
-- deliberate: there is no way for the UI to render a patient's record without
-- the access being logged, because the data and the log entry come from the
-- same function. Opening a full medical record is exactly what a Data
-- Protection Act 2019 audit asks about, so it carries its own labelled entry
-- rather than being inferred from a generic patient read.
--
-- One audit row per call, not per row returned — a chart view is one access
-- event, and logging every encounter inside it would bury the signal a
-- reviewer actually wants ("who opened this chart, when").
--
-- NOTE on list_patients_summary's output columns: none is named `site_id`.
-- A RETURNS TABLE column name becomes an implicit PL/pgSQL variable for the
-- whole body, and `site_id` would then be ambiguous against user_sites()'s own
-- column — the exact bug that broke list_encounters in 0003.

create or replace function list_patients_summary(p_site_id uuid, p_search text default null)
returns table (
  patient_id uuid,
  mrn text,
  full_name text,
  dob date,
  sex text,
  phone text,
  registered_at timestamptz,
  last_visit_at timestamptz,
  visit_count bigint,
  open_encounter_id uuid,
  open_encounter_status text
)
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

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients',
          jsonb_build_object('fn', 'list_patients_summary', 'site_id', p_site_id, 'search', p_search));

  return query
    select
      p.id,
      p.mrn,
      p.full_name,
      p.dob,
      p.sex,
      p.phone,
      p.created_at,
      (select max(e.created_at) from encounters e where e.patient_id = p.id),
      (select count(*) from encounters e where e.patient_id = p.id),
      (select e.id from encounters e
         where e.patient_id = p.id and e.status in ('TRIAGE','IN_CONSULT')
         order by e.created_at desc limit 1),
      (select e.status from encounters e
         where e.patient_id = p.id and e.status in ('TRIAGE','IN_CONSULT')
         order by e.created_at desc limit 1)
    from patients p
    where p.site_id = p_site_id
      and (
        p_search is null
        or p.full_name ilike '%' || p_search || '%'
        or p.mrn ilike '%' || p_search || '%'
        or coalesce(p.phone, '') ilike '%' || p_search || '%'
      )
    order by coalesce((select max(e.created_at) from encounters e where e.patient_id = p.id), p.created_at) desc;
end;
$$;

revoke execute on function list_patients_summary(uuid, text) from anon;
grant execute on function list_patients_summary(uuid, text) to authenticated;

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

revoke execute on function get_patient_record(uuid) from anon;
grant execute on function get_patient_record(uuid) to authenticated;
