-- VITCARE-CLINIC — allergies must be reviewed before a prescription can be sent
-- ---------------------------------------------------------------------------
-- Depends on 0010_patient_allergies.sql (assert_allergies_reviewed).
--
-- WHY THIS IS IN THE DATABASE AND NOT ONLY THE UI
-- The prescribe form already blocks sending while allergy_status is UNRECORDED,
-- and that is where the clinician gets told why. But a UI check is a courtesy,
-- not a control. It protects only the one screen it lives on, and it is gone
-- the moment anyone writes a second client, a bulk import, or a script. The
-- rule this enforces — nobody prescribes for a patient whose allergies have
-- never been asked about — is categorical enough to belong where it cannot be
-- bypassed.
--
-- WHAT IS *NOT* ENFORCED HERE, DELIBERATELY
-- The conflict check (does this drug match something the patient reacts to)
-- stays in TypeScript. It is a heuristic over free text with an explicit,
-- non-exhaustive cross-reactivity table; re-implementing that in SQL would
-- duplicate a fuzzy matcher across two languages and give it a drift problem
-- while adding no real guarantee. What is categorical goes in the database.
-- What is clinical judgement stays in front of the clinician, who overrides it
-- explicitly and on the record. See src/lib/allergy-check.ts.
--
-- ⚠ THIS FILE ALSO CARRIES THE 0007 CONCESSION.
-- 0007_admin_can_prescribe_TEMPORARY.sql notes that submit_prescription was
-- recreated *in the live database* to call can_prescribe() rather than
-- has_role(..., 'CLINICIAN'), but 0002 on disk was never updated — so the file
-- and the database had already drifted. Recreating the function from 0002's
-- body would have silently reverted admin prescribing. This version uses
-- can_prescribe(), which is a superset of the CLINICIAN check, so it is correct
-- whichever of the two the live database currently holds. To end the testing
-- concession, change can_prescribe's body in 0007 — still the single revert
-- point. Do not re-add has_role here.

create or replace function submit_prescription(
  p_encounter_id uuid,
  p_fulfillment_site_id uuid,
  p_payer text,
  p_insurer_code text,
  p_note text,
  p_items jsonb -- [{ drugCode?, drugName, strength?, dose, frequency, durationDays?, quantity, instructions?, substitutionAllowed? }, ...]
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_encounter encounters%rowtype;
  v_patient patients%rowtype;
  v_prescriber users%rowtype;
  v_prescription_id uuid;
  v_item jsonb;
  v_item_id uuid;
  v_payload_items jsonb := '[]'::jsonb;
  v_payload jsonb;
begin
  -- can_prescribe, not has_role — see the note at the top of this file.
  if not can_prescribe(auth.uid()) then
    raise exception 'only a clinician can submit a prescription';
  end if;

  if jsonb_array_length(p_items) < 1 then
    raise exception 'a prescription needs at least one item';
  end if;

  select * into v_encounter from encounters where id = p_encounter_id;
  if not found then
    raise exception 'unknown encounter';
  end if;
  -- `us.site_id`, aliased. 0002 on disk has this unaliased, but the function
  -- actually running in the database was changed to alias it — a second, quieter
  -- instance of the same file/database drift 0007 recorded. Matching the version
  -- that is proven in production rather than the one in the file, and aliasing
  -- is unambiguously safe regardless: an unqualified `site_id` inside a function
  -- is one RETURNS TABLE column away from resolving to the wrong thing, which is
  -- exactly how list_encounters broke in 0003.
  if v_encounter.site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  -- The gate. Raises P0003 when nobody has taken an allergy history yet. It is
  -- placed before any write so the whole call is a clean no-op on rejection.
  perform assert_allergies_reviewed(v_encounter.patient_id);

  select * into v_patient from patients where id = v_encounter.patient_id;
  select * into v_prescriber from users where id = auth.uid();

  insert into prescriptions (
    encounter_id, patient_id, prescriber_id, fulfillment_site_id,
    status, payer, insurer_code, note, site_id, created_by
  ) values (
    p_encounter_id, v_encounter.patient_id, auth.uid(), p_fulfillment_site_id,
    'PENDING', coalesce(p_payer, 'CASH'), p_insurer_code, p_note, v_encounter.site_id, auth.uid()
  ) returning id into v_prescription_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into prescription_items (
      prescription_id, drug_code, drug_name, strength, dose, frequency,
      duration_days, quantity, instructions, substitution_allowed
    ) values (
      v_prescription_id,
      v_item->>'drugCode', v_item->>'drugName', v_item->>'strength',
      v_item->>'dose', v_item->>'frequency',
      nullif(v_item->>'durationDays', '')::int,
      (v_item->>'quantity')::int,
      v_item->>'instructions',
      coalesce((v_item->>'substitutionAllowed')::boolean, false)
    ) returning id into v_item_id;

    v_payload_items := v_payload_items || jsonb_build_object(
      'itemId', v_item_id,
      'drugCode', v_item->'drugCode',
      'drugName', v_item->'drugName',
      'strength', v_item->'strength',
      'dose', v_item->'dose',
      'frequency', v_item->'frequency',
      'durationDays', v_item->'durationDays',
      'quantity', v_item->'quantity',
      'instructions', v_item->'instructions',
      'substitutionAllowed', coalesce(v_item->'substitutionAllowed', 'false'::jsonb)
    );
  end loop;

  v_payload := jsonb_build_object(
    'contractVersion', '1.0.0',
    'prescriptionId', v_prescription_id,
    'fulfillmentSiteId', p_fulfillment_site_id,
    'encounterId', p_encounter_id,
    'issuedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'note', p_note,
    'patient', jsonb_build_object(
      'mrn', v_patient.mrn,
      'fullName', v_patient.full_name,
      'phone', v_patient.phone,
      'payer', coalesce(p_payer, 'CASH'),
      'insurerCode', p_insurer_code
    ),
    'prescriber', jsonb_build_object(
      'userId', v_prescriber.id,
      'name', v_prescriber.full_name,
      'licenseNo', v_prescriber.license_no
    ),
    'items', v_payload_items
  );

  insert into integration_outbox (prescription_id, payload) values (v_prescription_id, v_payload);

  update encounters set status = 'COMPLETED', updated_at = now() where id = p_encounter_id;

  return v_prescription_id;
end;
$$;

revoke execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) to authenticated;
