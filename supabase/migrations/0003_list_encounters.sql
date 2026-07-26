-- VITCARE-CLINIC — list_encounters RPC
-- ---------------------------------------------------------------------------
-- The work queue (Register → Triage → Consult → Prescribe) needs patient
-- name/MRN alongside each encounter. That's still a patient-data read, so it
-- goes through the same audited-RPC-only door as get_patient()/list_patients()
-- in 0000_base_schema.sql — direct `.from('patients')` access stays revoked.

create or replace function list_encounters(p_site_id uuid, p_status text default null)
returns table (
  id uuid,
  patient_id uuid,
  patient_full_name text,
  patient_mrn text,
  site_id uuid,
  clinician_id uuid,
  status text,
  chief_complaint text,
  vitals jsonb,
  triage_priority text,
  clinical_notes text,
  created_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  -- `site_id` is also this function's own RETURNS TABLE output column, which
  -- PL/pgSQL treats as an implicit local variable for the whole function body
  -- — `select site_id from user_sites(...)` would be ambiguous between that
  -- and user_sites()'s own site_id column. The `us` alias disambiguates it.
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients', jsonb_build_object('fn', 'list_encounters', 'site_id', p_site_id, 'status', p_status));

  return query
    select e.id, e.patient_id, p.full_name, p.mrn, e.site_id, e.clinician_id, e.status, e.chief_complaint, e.vitals, e.triage_priority, e.clinical_notes, e.created_at
    from encounters e
    join patients p on p.id = e.patient_id
    where e.site_id = p_site_id
      and (p_status is null or e.status = p_status)
    order by e.created_at desc;
end;
$$;

revoke execute on function list_encounters(uuid, text) from anon;
grant execute on function list_encounters(uuid, text) to authenticated;
