-- VITCARE-CLINIC — Pharmacy queue (the clinic's view of the POS pipeline)
-- ---------------------------------------------------------------------------
-- WHAT THIS IS NOT
-- This is not a dispensing screen and must never become one. VITCARE-POS owns
-- stock, pricing, dispensing and payment for medicines; the two systems share
-- no database and meet only at the HMAC contract in
-- src/modules/prescriptions/integration/. A second place that can mark a drug
-- dispensed is a second source of truth about whether a patient received their
-- medication, and the two will disagree.
--
-- What the clinic genuinely needs, and had no way to see:
--   1. Where each prescription has got to (PENDING → PRICED → DISPENSED →
--      COLLECTED), so a clinician can answer "has my patient got their drugs?"
--   2. Whether the prescription ever REACHED the pharmacy at all. That is the
--      failure this module exists for: the outbox retries silently, so a POS
--      outage looks identical to a pharmacy that simply has not got to it yet.
--      The clinic README records that the outbox "has not yet been run live" —
--      a queue that cannot show its own delivery health is how that stays true
--      without anyone noticing.

-- ── The queue ─────────────────────────────────────────────────────────────
create or replace function list_pharmacy_queue(
  p_site_id uuid,
  p_include_closed boolean default false
)
returns table (
  id uuid,
  patient_id uuid,
  patient_full_name text,
  patient_mrn text,
  prescriber_name text,
  status text,
  payer text,
  total_amount_cents integer,
  item_count integer,
  dispensed_item_count integer,
  note text,
  created_at timestamptz,
  updated_at timestamptz,
  -- Derived, not stored: what the outbox says about getting this to POS.
  delivery_state text,
  delivery_attempts integer,
  delivery_next_attempt_at timestamptz,
  delivery_last_error text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_is_admin boolean := has_role(auth.uid(), 'ADMIN');
begin
  -- `us` alias: site_id is also an output column of this function, which
  -- PL/pgSQL treats as a local for the whole body. Same note as 0003.
  if not (
    v_is_admin or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients',
          jsonb_build_object('fn', 'list_pharmacy_queue', 'site_id', p_site_id));

  return query
    select
      rx.id, rx.patient_id, p.full_name, p.mrn, u.full_name,
      rx.status, rx.payer, rx.total_amount_cents,
      coalesce(it.n, 0)::integer,
      coalesce(it.dispensed, 0)::integer,
      rx.note, rx.created_at, rx.updated_at,
      case
        when ob.id is null then 'NONE'
        when ob.delivered then 'DELIVERED'
        -- attempts > 0 with a recorded error means POS has actively refused or
        -- been unreachable, which reads differently from "queued, not tried".
        when ob.attempts >= 8 then 'FAILED'
        when ob.attempts > 0 then 'RETRYING'
        else 'QUEUED'
      end::text,
      ob.attempts,
      ob.next_attempt_at,
      -- The error text can carry the POS base URL and upstream response bodies.
      -- Useful to whoever operates the integration, not something to put on a
      -- screen a receptionist has open all day.
      case when v_is_admin then ob.last_error else null end
    from prescriptions rx
    join patients p on p.id = rx.patient_id
    left join users u on u.id = rx.prescriber_id
    left join lateral (
      select count(*) as n,
             count(*) filter (where coalesce(i.dispensed_quantity, 0) > 0) as dispensed
      from prescription_items i
      where i.prescription_id = rx.id
    ) it on true
    -- One prescription has at most one outbox row (it is written in the same
    -- transaction as the prescription); DISTINCT ON keeps this honest if that
    -- ever stops being true rather than multiplying the queue rows.
    left join lateral (
      select o.id, o.delivered, o.attempts, o.next_attempt_at, o.last_error
      from integration_outbox o
      where o.prescription_id = rx.id
      order by o.created_at desc
      limit 1
    ) ob on true
    where rx.site_id = p_site_id
      and rx.status <> 'DRAFT'
      and (p_include_closed or rx.status not in ('COLLECTED', 'CANCELLED'))
    order by rx.created_at desc;
end;
$$;
revoke execute on function list_pharmacy_queue(uuid, boolean) from anon;
grant execute on function list_pharmacy_queue(uuid, boolean) to authenticated;

-- ── Delivery health, in one row ───────────────────────────────────────────
-- Deliberately aggregate-only and ADMIN/AUDITOR-only. It answers "is the link
-- to the pharmacy working" without exposing per-prescription error text, and
-- it is the number that should be on a wall, not discovered during an incident.
create or replace function pharmacy_link_health(p_site_id uuid)
returns table (
  queued integer,
  retrying integer,
  failed integer,
  delivered_today integer,
  oldest_undelivered_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')) then
    raise exception 'not authorized';
  end if;

  return query
    select
      count(*) filter (where not o.delivered and o.attempts = 0)::integer,
      count(*) filter (where not o.delivered and o.attempts between 1 and 7)::integer,
      count(*) filter (where not o.delivered and o.attempts >= 8)::integer,
      count(*) filter (where o.delivered and o.created_at >= date_trunc('day', now()))::integer,
      min(o.created_at) filter (where not o.delivered)
    from integration_outbox o
    join prescriptions rx on rx.id = o.prescription_id
    where rx.site_id = p_site_id;
end;
$$;
revoke execute on function pharmacy_link_health(uuid) from anon;
grant execute on function pharmacy_link_health(uuid) to authenticated;

-- ── Cancel ────────────────────────────────────────────────────────────────
-- The one write the clinic legitimately owns over a prescription after it has
-- been sent: withdrawing it. Prescribing is a clinical act and so is
-- un-prescribing, hence can_prescribe() rather than the desk roles.
--
-- It deliberately does NOT recall anything from POS. Once a medicine is
-- DISPENSED or COLLECTED the patient physically has it, and a status flip here
-- would be a lie; those states are refused. Anything earlier is fair game, and
-- POS learns about it through the normal status contract rather than through a
-- second, private channel.
create or replace function cancel_prescription(p_prescription_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not can_prescribe(auth.uid()) then
    raise exception 'only a prescriber can cancel a prescription';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a cancellation reason is required';
  end if;

  select rx.site_id, rx.status into v_site_id, v_status
  from prescriptions rx where rx.id = p_prescription_id;

  if v_site_id is null then
    raise exception 'unknown prescription';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status in ('DISPENSED', 'COLLECTED') then
    raise exception 'the patient already has this medicine — record a clinical note instead';
  end if;
  if v_status = 'CANCELLED' then
    return;  -- idempotent
  end if;

  update prescriptions
  set status = 'CANCELLED',
      note = coalesce(note || ' | ', '') || 'Cancelled: ' || btrim(p_reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_prescription_id;
end;
$$;
revoke execute on function cancel_prescription(uuid, text) from anon;
grant execute on function cancel_prescription(uuid, text) to authenticated;
