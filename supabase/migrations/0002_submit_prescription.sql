-- VITCARE-CLINIC — submit_prescription RPC
-- ---------------------------------------------------------------------------
-- The design doc's non-negotiable: prescription + prescription_items +
-- integration_outbox must land in ONE transaction, or a crash between two
-- separate client-side inserts could queue an outbox row for a prescription
-- that never actually got its line items. The Supabase JS client has no
-- multi-table transaction primitive, so that atomicity has to live in a
-- single Postgres function — a plpgsql function body is one transaction by
-- default (whole thing commits, or none of it does, e.g. on the `raise
-- exception` calls below).
--
-- The itemId in the outbox payload MUST equal prescription_items.id, because
-- webhook-handler.ts's applyStatusEvent() (via supabase-deps.ts) matches
-- incoming line updates from POS back to a row with `.eq('id', line.itemId)`.
-- That's why items are inserted first (letting Postgres assign each id) and
-- the payload is built from the returned ids, not from client-supplied ones.

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
  if not has_role(auth.uid(), 'CLINICIAN') then
    raise exception 'only a clinician can submit a prescription';
  end if;

  if jsonb_array_length(p_items) < 1 then
    raise exception 'a prescription needs at least one item';
  end if;

  select * into v_encounter from encounters where id = p_encounter_id;
  if not found then
    raise exception 'unknown encounter';
  end if;
  if v_encounter.site_id not in (select site_id from user_sites(auth.uid())) then
    raise exception 'not authorized for this site';
  end if;

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

-- See 0000_base_schema.sql's comment: Supabase's template auto-grants EXECUTE
-- to `anon` on every new function, so it must be revoked from anon by name.
revoke execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) to authenticated;
