-- VITCARE-CLINIC — stop emitting JSON nulls for absent optional fields
-- ---------------------------------------------------------------------------
-- THE BUG
-- Every CASH prescription silently failed to reach the pharmacy.
--
-- jsonb_build_object('insurerCode', p_insurer_code) with a NULL argument
-- produces `"insurerCode": null` — the key is PRESENT with a null value. The
-- shared contract declares it `z.string().min(1).optional()`, and Zod's
-- .optional() accepts `undefined`, not `null`. So the till rejected the
-- payload with a 422, the outbox classified 4xx as permanent, and the row was
-- marked failed forever.
--
-- Payer defaults to CASH, so insurerCode is null on the overwhelming majority
-- of prescriptions. The failure mode was total for the primary use case and
-- completely silent at the counter: the clinician saw "sent", the pharmacist
-- saw nothing, and the only evidence was a `failed` flag in a table nobody
-- was watching. Two real prescriptions from 2026-08-03 sat that way for five
-- days.
--
-- THE FIX
-- jsonb_strip_nulls() over the finished payload, so an absent optional field
-- is an absent KEY rather than a null one — which is exactly what
-- JSON.stringify does on the TypeScript side of the same contract, and why
-- the POS -> CLINIC direction never had this problem.
--
-- Safe across the whole payload: every field that can be null here is
-- optional in the contract (note, patient.phone, patient.insurerCode,
-- prescriber.licenseNo, and per-item drugCode, strength, durationDays,
-- instructions). The required ones are either NOT NULL in the schema or
-- coalesced before this point — substitutionAllowed is coalesced to false,
-- quantity is `not null check (quantity > 0)`.
--
-- Carries forward 0011's allergy gate and 0007's can_prescribe concession.
-- Do not reintroduce has_role(…, 'CLINICIAN') here; see 0011's header.

create or replace function submit_prescription(
  p_encounter_id uuid,
  p_fulfillment_site_id uuid,
  p_payer text,
  p_insurer_code text,
  p_note text,
  p_items jsonb
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
  if v_encounter.site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

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

  -- The fix. Everything above is unchanged; this one call turns
  -- `"insurerCode": null` into no insurerCode key at all.
  v_payload := jsonb_strip_nulls(jsonb_build_object(
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
  ));

  insert into integration_outbox (prescription_id, payload) values (v_prescription_id, v_payload);

  update encounters set status = 'COMPLETED', updated_at = now() where id = p_encounter_id;

  return v_prescription_id;
end;
$$;

revoke execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) to authenticated;

-- ── Rescue the prescriptions this bug stranded ─────────────────────────────
-- Their stored payloads still carry the null keys, so strip those too and put
-- the rows back in the queue. attempts resets to 0 because the previous
-- attempts failed for a reason that no longer exists — they should not inherit
-- a backoff earned by a bug.
update integration_outbox
   set payload         = jsonb_strip_nulls(payload),
       failed          = false,
       attempts        = 0,
       last_error      = null,
       next_attempt_at = now()
 where failed = true
   and delivered = false;
