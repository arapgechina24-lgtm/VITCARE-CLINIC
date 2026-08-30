-- VITCARE-CLINIC — "settled by scheme — dispense, don't collect"
-- ---------------------------------------------------------------------------
-- 0038 left the PHARMACY column empty on purpose and said why: medicines are
-- PHA-005, PHA-005 is non-billable because it is "PRICED IN VITCARE-POS - not
-- in this catalogue. Do not double-maintain", and putting drugs on a farm's
-- statement while the till still asked the patient to pay would be one
-- dispensing and two bills. It named the condition for lifting that: "until
-- the prescription contract carries the instruction that makes it safe."
--
-- The contract now carries it. A prescription for a covered patient goes to the
-- till stamped with a settlement block, and the till hands the medicine over
-- without opening the drawer.
--
-- ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
-- It does not price anything. PHA-005 stays non-billable and no PHARMACY
-- tariff is consulted for drugs, because the shelf's prices live in the POS
-- catalogue and a second copy here would drift from the first the day someone
-- edited one of them. The clinic says WHO settles; the till says HOW MUCH.
-- The figure comes back on the status event and 0040 posts it.
--
-- ── WHY A PER-SCHEME SWITCH, DEFAULTING TO OFF ─────────────────────────────
-- "The visit is on a scheme" does not imply "the farm pays for medicines".
-- Those are two clauses of a contract and a facility can hold one without the
-- other. Deriving the second from the first would put drugs on the statement
-- of every farm the moment this migration applied — including any whose
-- contract covers consultations only, which is a bill the facility cannot
-- support when finance queries it.
--
-- So it is declared, once per scheme, by someone reading the contract. The
-- default is false, which reproduces today's behaviour exactly: every existing
-- scheme keeps collecting at the till until an administrator says otherwise.
-- Same rule as 0036's tariffs — nobody has agreed a thing until they say so,
-- and silence is not agreement.
--
-- ── WHY LAPSED COVER DOWNGRADES RATHER THAN REFUSES ────────────────────────
-- post_scheme_charge_from_encounter RAISES when cover did not run on the day
-- of the visit. This must not. A prescription is a clinical act, and refusing
-- to let a clinician prescribe because a membership expired would turn a
-- billing problem into a treatment problem — the exact inversion 0026's
-- principle exists to prevent.
--
-- So an uncovered patient simply gets an ordinary prescription and pays at the
-- window, which is what happens today and is the correct outcome: the farm is
-- not billed for someone it does not cover. start_encounter already refuses
-- lapsed cover at check-in, so this is the second line, not the first.

-- ── The contract clause ────────────────────────────────────────────────────
alter table schemes
  add column if not exists settles_pharmacy boolean not null default false;

comment on column schemes.settles_pharmacy is
  'True when this scheme''s contract covers medicines dispensed at the pharmacy. Off by default: a farm is never billed for drugs until somebody reads the contract and says it agreed to them.';

create or replace function set_scheme_settles_pharmacy(
  p_scheme_id uuid,
  p_settles boolean
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_site uuid;
  v_name text;
begin
  -- Deliberately ADMIN-only, and narrower than set_scheme_tariff, which
  -- clinical leads may also call. A tariff is a price for one service; this
  -- decides whether an entire category of spending reaches a customer's
  -- monthly bill at all.
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can change what a scheme''s contract covers';
  end if;

  select s.site_id, s.name into v_site, v_name from schemes s where s.id = p_scheme_id;
  if v_site is null then
    raise exception 'unknown scheme';
  end if;
  if v_site not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  update schemes
  set settles_pharmacy = coalesce(p_settles, false), updated_at = now()
  where id = p_scheme_id;

  -- Auditable in its own right. Turning this on redirects money from the
  -- counter to a monthly statement, and six months later somebody will ask
  -- when that started and who decided it.
  insert into audit_log (actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'UPDATE', 'schemes', p_scheme_id,
          jsonb_build_object('fn', 'set_scheme_settles_pharmacy',
                             'scheme', v_name,
                             'settles_pharmacy', coalesce(p_settles, false)));

  return coalesce(p_settles, false);
end;
$$;

revoke execute on function set_scheme_settles_pharmacy(uuid, boolean) from public;
revoke execute on function set_scheme_settles_pharmacy(uuid, boolean) from anon;
grant execute on function set_scheme_settles_pharmacy(uuid, boolean) to authenticated;

-- ── submit_prescription stamps the instruction ─────────────────────────────
-- Carries forward everything 0016 carried: 0011's allergy gate, 0007's
-- can_prescribe concession, and the jsonb_strip_nulls that stopped every CASH
-- prescription failing silently. Do not reintroduce has_role(…, 'CLINICIAN')
-- here; see 0011's header.
--
-- The only behavioural change is the settlement block and the version stamp
-- that guards it. A prescription with no covered membership behind it produces
-- a payload byte-for-byte identical to the one this function produced before.
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
  v_settlement jsonb;
  v_visit_date date;
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

  -- ── Who settles this, if anyone ──────────────────────────────────────────
  -- Cover is judged on the DAY OF THE VISIT, not today, exactly as
  -- post_scheme_charge_from_encounter judges it, so a prescription written up
  -- the morning after a late visit settles the same way the visit does. Two
  -- different answers to "was this person covered" would put the medicines on
  -- a statement the consultation never reached, or the reverse.
  if v_encounter.scheme_member_id is not null then
    v_visit_date := (v_encounter.created_at at time zone 'Africa/Nairobi')::date;

    select jsonb_build_object(
             'memberId', m.id,
             'schemeCode', s.code,
             'schemeName', s.name,
             -- A dependant carries the employee's number: the farms bill the
             -- household, and member_no is null for everyone the farm never
             -- issued an individual card to. employee_no is NOT NULL, so this
             -- can never strip to an absent key and fail the till's schema.
             'memberNo', coalesce(nullif(btrim(m.member_no), ''), m.employee_no)
           )
      into v_settlement
    from scheme_members m
    join schemes s on s.id = m.scheme_id
    where m.id = v_encounter.scheme_member_id
      and s.active
      -- The contract clause. Off by default, so this selects nothing until an
      -- administrator has said the farm agreed to cover medicines.
      and s.settles_pharmacy
      and m.covered_from <= v_visit_date
      and (m.covered_to is null or m.covered_to >= v_visit_date);
  end if;

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

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    -- THE INTERLOCK. A settlement instruction must never travel under the
    -- baseline version: a till built before this feature parses 1.0.0 and
    -- would ignore the block it does not know about, dispense the medicine AND
    -- take the patient's money, while the farm was billed for the same drugs on
    -- its statement. Stamping 1.1.0 makes that till reject the payload outright
    -- — it stays queued and visible, and nobody is charged twice.
    --
    -- Ordinary prescriptions stay on 1.0.0 so an un-upgraded till keeps
    -- dispensing them normally throughout the rollout. The till's own schema
    -- refuses the mismatched combination from the other side.
    'contractVersion', case when v_settlement is null then '1.0.0' else '1.1.0' end,
    'prescriptionId', v_prescription_id,
    'fulfillmentSiteId', p_fulfillment_site_id,
    'encounterId', p_encounter_id,
    'issuedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'note', p_note,
    'patient', jsonb_build_object(
      'mrn', v_patient.mrn,
      'fullName', v_patient.full_name,
      'phone', v_patient.phone,
      -- Untouched, and deliberately so. The payer enum is written into
      -- invoices, into prescriptions, and into a Zod enum on both sides of a
      -- signed contract; adding a SCHEME value would break the wire silently.
      -- Settlement is a separate fact and travels separately.
      'payer', coalesce(p_payer, 'CASH'),
      'insurerCode', p_insurer_code
    ),
    'prescriber', jsonb_build_object(
      'userId', v_prescriber.id,
      'name', v_prescriber.full_name,
      'licenseNo', v_prescriber.license_no
    ),
    'items', v_payload_items,
    'settlement', v_settlement
  ));

  insert into integration_outbox (prescription_id, payload) values (v_prescription_id, v_payload);

  update encounters set status = 'COMPLETED', updated_at = now() where id = p_encounter_id;

  return v_prescription_id;
end;
$$;

revoke execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) from public;
revoke execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function submit_prescription(uuid, uuid, text, text, text, jsonb) to authenticated;

-- ── The screens need to see the clause they are setting ────────────────────
-- Appended to the end of the row rather than inserted among the existing
-- columns: this function returns a positional record, and moving a column
-- would silently re-map every field after it on a client that had not been
-- redeployed in the same breath.
create or replace function list_schemes(p_site_id uuid, p_include_inactive boolean default false)
returns table (
  id uuid, code text, name text, consultation_fee_cents integer,
  contact_name text, contact_email text, contact_phone text, active boolean,
  members integer, cap_cents integer, settles_pharmacy boolean
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  -- Carried forward from 0032 unchanged. `null in (subquery)` evaluates to
  -- NULL, not false, and PL/pgSQL's IF treats NULL as false — so without this
  -- an omitted site id would return an empty result rather than a refusal,
  -- which on a statement screen reads as "this farm has no activity" instead
  -- of "you asked the wrong question".
  if p_site_id is null then
    raise exception 'a site is required';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select s.id, s.code, s.name, s.consultation_fee_cents,
           s.contact_name, s.contact_email, s.contact_phone, s.active,
           (select count(*)::integer from scheme_members m
             where m.scheme_id = s.id and (m.covered_to is null or m.covered_to >= v_today)),
           scheme_cap_cents(s.id, v_today),
           s.settles_pharmacy
    from schemes s
    where s.site_id = p_site_id
      and (p_include_inactive or s.active)
    order by s.active desc, s.code;
end;
$$;
revoke execute on function list_schemes(uuid, boolean) from public, anon;
grant execute on function list_schemes(uuid, boolean) to authenticated;
