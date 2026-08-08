-- VITCARE-CLINIC — reconcile save_consult_notes with the running database
-- ---------------------------------------------------------------------------
-- 0007 recorded that save_consult_notes and submit_prescription were both
-- recreated directly in the live database to call can_prescribe() instead of
-- has_role(…, 'CLINICIAN'), and that the migration files were never updated.
-- 0011 reconciled submit_prescription. This reconciles the other one.
--
-- The drift was real and had two parts, verified by dumping
-- pg_get_functiondef before writing this file:
--
--   file 0004:  has_role(auth.uid(), 'CLINICIAN')
--   live:       can_prescribe(auth.uid())
--
--   file 0004:  select site_id from user_sites(auth.uid())
--   live:       select us.site_id from user_sites(auth.uid()) us
--
-- Rebuilding this database from the migrations folder would therefore have
-- silently revoked admin note-saving — a change nobody asked for, arriving
-- through a disaster-recovery procedure, which is the worst possible moment
-- to discover it.
--
-- This file makes a fresh replay produce what is actually running. It is a
-- no-op against the current database, which is the point: after it, the
-- migrations folder is once again a truthful description of production.
--
-- can_prescribe() remains the single revert point for the 0007 testing
-- concession. Do NOT put has_role(…, 'CLINICIAN') back here — that would
-- re-split the decision across two files.
--
-- The alias on user_sites is not cosmetic. An unqualified `site_id` inside a
-- function is one RETURNS TABLE column away from resolving to the wrong thing;
-- that is precisely how list_encounters broke in 0003.

create or replace function save_consult_notes(p_encounter_id uuid, p_clinical_notes text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
begin
  if not can_prescribe(auth.uid()) then
    raise exception 'only a clinician can record consult notes';
  end if;

  select site_id into v_site_id from encounters where id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
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
