-- VITCARE-CLINIC — the farm is billed for the medicines, at the till's prices
-- ---------------------------------------------------------------------------
-- 0039 told the pharmacy not to collect. This is the other half: if the till
-- does not collect, somebody has to bill, and nothing here knew what a
-- medicine costs.
--
-- ── WHY THE FIGURE COMES FROM THE TILL ─────────────────────────────────────
-- It is the only place it exists. PHA-005 is marked non-billable with the note
-- "PRICED IN VITCARE-POS - not in this catalogue. Do not double-maintain," and
-- that instruction is followed here rather than worked around: no PHARMACY
-- tariff is consulted for drugs, and no drug price is copied into this
-- database. The till reports the value of what it handed over, on the status
-- event, and this files it.
--
-- The alternative was a per-scheme drug price list. It fails the first time a
-- pack price changes on the shelf and not in the tariff table — and it fails
-- silently, producing a statement that is merely wrong rather than obviously
-- broken. The August failure was a blank column; this would have been a full
-- one full of stale numbers, which is harder to notice and worse to explain.
--
-- ── ONE DISPENSING, ONE ROW, EVEN UNDER RETRIES ────────────────────────────
-- The webhook is at-least-once by design. `scheme_dispensings.prescription_id`
-- is UNIQUE, so a redelivered event corrects the row it already wrote instead
-- of adding a second one. Without that, a farm's pharmacy column would grow by
-- the value of one prescription every time the till's connection dropped
-- mid-ack — and every individual figure on the statement would look plausible.
--
-- ── A DISPENSING IS RECORDED EVEN WHEN IT CANNOT BE BILLED YET ─────────────
-- The charge for a visit may not exist when the medicine is handed over (the
-- clinician posts the visit at the end), and the month's statement may already
-- have been issued (a prescription collected in the first days of the next
-- month). Neither is a reason to drop the fact.
--
-- So the row is always written and `charge_id` says whether it reached a bill.
-- An unbilled dispensing is then a query, not an absence — which is the whole
-- difference between this and the blank pharmacy column it replaces.

create table if not exists scheme_dispensings (
  id uuid primary key default gen_random_uuid(),
  -- One row per prescription. THE idempotency guarantee of this file.
  prescription_id uuid not null references prescriptions(id) unique,
  encounter_id uuid not null references encounters(id),
  member_id uuid not null references scheme_members(id),
  scheme_id uuid not null references schemes(id),
  site_id uuid not null references sites(id),
  -- What the till says the medicines were worth. Zero is legitimate — a script
  -- cancelled at the counter after the shelf was checked — and is not the same
  -- as no dispensing at all, which is an absent row.
  amount_cents integer not null check (amount_cents >= 0),
  -- The till's invoice number. What the farm's finance office quotes when it
  -- queries a line, and what makes the figure traceable to a sale rather than
  -- an assertion this database cannot support.
  invoice_no text not null,
  -- The charge this landed on, once it lands on one. Null means recorded but
  -- not yet billed — see the header.
  charge_id uuid references scheme_charges(id),
  dispensed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table scheme_dispensings enable row level security;
create policy scheme_dispensings_site_read on scheme_dispensings
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
grant select on scheme_dispensings to authenticated;

-- The project template hands anon and authenticated every verb on a new table
-- in public, so `grant select` above adds nothing and the table would ship with
-- INSERT/UPDATE/DELETE/TRUNCATE open. RLS refuses the DML verbs; it does NOT
-- police TRUNCATE, for which the grant is the entire control — 0028 found this
-- on audit_log and PR #9 found it again on scheme_tariffs. Revoked explicitly,
-- including from PUBLIC, because revoking from a named role leaves the default
-- grant that PUBLIC holds in place.
revoke insert, update, delete, truncate on scheme_dispensings from public;
revoke insert, update, delete, truncate on scheme_dispensings from anon;
revoke insert, update, delete, truncate on scheme_dispensings from authenticated;

create index if not exists scheme_dispensings_encounter_idx on scheme_dispensings (encounter_id);
create index if not exists scheme_dispensings_scheme_idx on scheme_dispensings (scheme_id, dispensed_at);
-- Finds the dispensings that never reached a bill. The point of the nullable
-- charge_id is that this query is cheap and somebody runs it.
create index if not exists scheme_dispensings_unbilled_idx
  on scheme_dispensings (scheme_id) where charge_id is null;

-- ── The pharmacy column, recomputed from the dispensings ───────────────────
-- Derived, never accumulated. The column is always the SUM of the rows, so a
-- corrected dispensing produces a corrected column and a redelivered one
-- produces no change at all. An `update ... set pharmacy_cents = pharmacy_cents
-- + x` would be right exactly once per event and wrong forever after a retry.
--
-- Same shape as the rest of this system: stock is the sum of its movements,
-- a batch's balance is that ledger filtered, and a farm's pharmacy column is
-- the dispensings that named its visit.
create or replace function sync_scheme_charge_pharmacy(p_encounter_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_charge uuid;
  v_status text;
  v_cents integer;
  v_desc text;
  v_scheme uuid;
  v_period date;
  v_cap integer;
  v_spent integer;
  v_total integer;
begin
  select c.id, c.status into v_charge, v_status
  from scheme_charges c
  where c.encounter_id = p_encounter_id and c.status <> 'VOID'
  limit 1;

  -- No charge yet: the clinician has not posted the visit. The dispensing is
  -- already recorded and will be picked up when they do — see
  -- post_scheme_charge_from_encounter, which reads the same rows.
  if v_charge is null then
    return null;
  end if;

  -- An issued statement is not repriced. The farm has the document; changing
  -- what it says now would make the copy in their finance office disagree with
  -- ours. The dispensing keeps its null charge_id and shows up as unbilled,
  -- which is a conversation somebody can have rather than a silent edit.
  if v_status = 'STATEMENTED' then
    return null;
  end if;

  select coalesce(sum(d.amount_cents), 0),
         string_agg('Medicines dispensed (' || d.invoice_no || ')', '; ' order by d.dispensed_at)
    into v_cents, v_desc
  from scheme_dispensings d
  where d.encounter_id = p_encounter_id;

  -- The table's description-implies-a-price CHECK runs in both directions, so
  -- a column that priced to nothing must carry no description. A dispensing
  -- worth zero is real (a script cancelled at the counter) and lands here.
  if coalesce(v_cents, 0) = 0 then
    v_desc := null;
  end if;

  -- ── The cap has to be re-judged, not left as posted ─────────────────────
  -- A dispensing changes this charge's total, and the total is what the
  -- month is measured against. Updating the column without re-judging the cap
  -- would let medicines carry a farm past its agreed ceiling with over_limit
  -- still reading false — and over_limit is what puts a charge in the column
  -- the farm has to approve separately. The overspend would reach the
  -- statement as ordinary, approved spending.
  --
  -- Same advisory lock and the same key as both posting paths, so all three
  -- queue behind each other rather than two of them reading a figure under
  -- the cap and both writing over it.
  select c.period into v_period from scheme_charges c where c.id = v_charge;
  select c.scheme_id into v_scheme from scheme_charges c where c.id = v_charge;
  perform pg_advisory_xact_lock(hashtext(v_scheme::text || v_period::text));

  v_cap := scheme_cap_cents(v_scheme, v_period);
  -- This charge's own total is excluded, exactly as
  -- post_scheme_charge_from_encounter excludes it, so recomputing measures the
  -- month without double-counting the visit being changed.
  select coalesce(sum(c.total_cents), 0)::integer into v_spent
  from scheme_charges c
  where c.scheme_id = v_scheme and c.period = v_period and c.status <> 'VOID'
    and c.id <> v_charge;

  -- The new total, computed the same way the trigger will compute it. Read
  -- from the row rather than re-derived, so the two cannot disagree about
  -- anything except the bucket being changed here.
  select c.consultation_cents + c.lab_cents + c.surgical_cents + coalesce(v_cents, 0)
    into v_total
  from scheme_charges c where c.id = v_charge;

  -- total_cents itself follows from the four buckets via the trigger 0030
  -- installed, so it is deliberately not set here: two places computing one
  -- total is how they come to disagree.
  update scheme_charges
  set pharmacy_description = v_desc,
      pharmacy_cents = coalesce(v_cents, 0),
      over_limit = (v_cap is not null and (v_spent + v_total) > v_cap),
      cap_at_post_cents = v_cap,
      spent_before_cents = v_spent,
      updated_at = now()
  where id = v_charge;

  update scheme_dispensings
  set charge_id = v_charge, updated_at = now()
  where encounter_id = p_encounter_id and charge_id is distinct from v_charge;

  return v_charge;
end;
$$;

revoke execute on function sync_scheme_charge_pharmacy(uuid) from public;
revoke execute on function sync_scheme_charge_pharmacy(uuid) from anon;
revoke execute on function sync_scheme_charge_pharmacy(uuid) from authenticated;

-- ── Filing what the till reported ──────────────────────────────────────────
-- Called only from apply_status_event, inside the same transaction as the
-- status change. If the prescription moved to DISPENSED, the farm's bill moved
-- with it or neither did — a status that advanced without the charge following
-- is the blank pharmacy column reappearing one prescription at a time.
create or replace function record_scheme_dispensing(
  p_prescription_id uuid,
  p_member_id uuid,
  p_amount_cents integer,
  p_invoice_no text
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_encounter uuid;
  v_expected_member uuid;
  v_scheme uuid;
  v_site uuid;
  v_id uuid;
begin
  select p.encounter_id, e.scheme_member_id, e.site_id
    into v_encounter, v_expected_member, v_site
  from prescriptions p join encounters e on e.id = p.encounter_id
  where p.id = p_prescription_id;

  if v_encounter is null then
    raise exception 'unknown prescription';
  end if;

  -- The visit decides which farm is billed, not the message. The till echoes
  -- back the membership it was given so that a mismatch is caught rather than
  -- believed: without this check a malformed or replayed event could move a
  -- dispensing onto another company's statement, and it would look entirely
  -- ordinary when it arrived there.
  if v_expected_member is null then
    raise exception 'this prescription is not on a scheme visit';
  end if;
  if p_member_id is distinct from v_expected_member then
    raise exception 'the till settled this against a different membership than the visit names';
  end if;

  select m.scheme_id into v_scheme from scheme_members m where m.id = v_expected_member;

  insert into scheme_dispensings (
    prescription_id, encounter_id, member_id, scheme_id, site_id, amount_cents, invoice_no
  )
  values (
    p_prescription_id, v_encounter, v_expected_member, v_scheme, v_site,
    greatest(coalesce(p_amount_cents, 0), 0), p_invoice_no
  )
  on conflict (prescription_id) do update
    set amount_cents = excluded.amount_cents,
        invoice_no = excluded.invoice_no,
        updated_at = now()
  returning id into v_id;

  perform sync_scheme_charge_pharmacy(v_encounter);
  return v_id;
end;
$$;

revoke execute on function record_scheme_dispensing(uuid, uuid, integer, text) from public;
revoke execute on function record_scheme_dispensing(uuid, uuid, integer, text) from anon;
revoke execute on function record_scheme_dispensing(uuid, uuid, integer, text) from authenticated;


-- ── apply_status_event gains the settlement report ─────────────────────────
-- Carries forward everything 0009 established: the atomic dedupe on
-- processed_webhook_events, the row lock, the transition re-check under that
-- lock, and the `and pi.prescription_id = p_prescription_id` that stops a
-- payload writing another patient's line items.
--
-- The new argument is DEFAULTED so that the six-argument call a running clinic
-- process is still making keeps resolving during the deploy. A signature that
-- demanded seven would take the pharmacy webhook down for the length of the
-- rollout.
create or replace function apply_status_event(
  p_event_id           uuid,
  p_prescription_id    uuid,
  p_status             text,
  p_total_amount_cents integer default null,
  p_reason             text default null,
  p_lines              jsonb default null,  -- [{itemId, dispensedQuantity, substitutedWith, lineStatus}]
  p_scheme_settled     jsonb default null   -- {amountCents, invoiceNo, memberId}
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  -- Atomic dedupe. event_id is the primary key, so a replay collides HERE
  -- rather than in a check-then-act window between two statements.
  begin
    insert into processed_webhook_events (event_id, prescription_id, status)
    values (p_event_id, p_prescription_id, p_status);
  exception when unique_violation then
    return 'DEDUPED';
  end;

  -- Lock the prescription for the remainder of the transaction. Two concurrent
  -- events now serialise here instead of both passing the handler's pre-flight.
  select status into v_current
    from prescriptions
   where id = p_prescription_id
     for update;

  if v_current is null then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not is_allowed_transition(v_current, p_status) then
    raise exception 'ILLEGAL_TRANSITION:%->%', v_current, p_status
      using errcode = 'P0001';
  end if;

  update prescriptions
     set status             = p_status,
         total_amount_cents = coalesce(p_total_amount_cents, total_amount_cents),
         note               = case
                                when p_reason is null then note
                                else coalesce(note || E'\n', '') || '[POS] ' || p_reason
                              end,
         updated_at         = now()
   where id = p_prescription_id;

  -- Per-line outcomes. The `and pi.prescription_id = p_prescription_id` is the
  -- security fix from note (1) above: without it, any itemId in the payload
  -- could be written, including one belonging to another patient.
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    update prescription_items pi
       set dispensed_quantity = l."dispensedQuantity",
           line_status        = l."lineStatus"
      from jsonb_to_recordset(p_lines) as l(
        "itemId" uuid,
        "dispensedQuantity" int,
        "substitutedWith" text,
        "lineStatus" text
      )
     where pi.id = l."itemId"
       and pi.prescription_id = p_prescription_id;
  end if;

  -- ── The farm's bill moves with the status, or neither moves ─────────────
  -- Inside this transaction on purpose. A DISPENSED that commits without the
  -- charge following would be a medicine handed over for free with nothing left
  -- to invoice, and the webhook would never retry because it succeeded.
  --
  -- Only on a TERMINAL dispensing status. A PRICED carries no settlement (the
  -- till does not report one until the medicine leaves the counter), and
  -- billing a farm for a prescription the patient walked away from would be
  -- inventing a dispensing.
  if p_scheme_settled is not null and p_status in ('DISPENSED', 'PARTIAL') then
    perform record_scheme_dispensing(
      p_prescription_id,
      (p_scheme_settled->>'memberId')::uuid,
      (p_scheme_settled->>'amountCents')::integer,
      p_scheme_settled->>'invoiceNo'
    );
  end if;

  return 'APPLIED';
end;
$$;

-- Only the service role calls this — the webhook path has no interactive user.
-- Re-stated for the new signature: a grant follows the argument list, so the
-- seven-argument function is a different object to Postgres and inherits
-- nothing from the six-argument one, including its revokes. Left implicit, the
-- new overload would be executable by PUBLIC.
revoke execute on function apply_status_event(uuid, uuid, text, integer, text, jsonb, jsonb) from public;
revoke execute on function apply_status_event(uuid, uuid, text, integer, text, jsonb, jsonb) from anon;
revoke execute on function apply_status_event(uuid, uuid, text, integer, text, jsonb, jsonb) from authenticated;

-- Dropping the six-argument version is REQUIRED, not tidiness. `create or
-- replace` on a different argument list creates a second function rather than
-- replacing the first, and with both present a six-argument call matches both
-- and Postgres refuses it as ambiguous — which would break exactly the
-- in-flight callers the default argument above exists to protect.
--
-- Ordered after the new function is created, so there is no instant where
-- neither exists.
drop function if exists apply_status_event(uuid, uuid, text, integer, text, jsonb);
