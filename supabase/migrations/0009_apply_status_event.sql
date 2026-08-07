-- VITCARE-CLINIC — atomic application of a POS status webhook
-- ---------------------------------------------------------------------------
-- Replaces the four separate round-trips that makeWebhookDeps.applyStatusEvent
-- used to make (update prescription, update each item, insert the processed
-- event). Three defects motivated this, in descending order of severity:
--
--   1. The per-item update was scoped ONLY by prescription_items.id. The HMAC
--      proves the request came from the pharmacy; it proves nothing about which
--      prescription an itemId belongs to. A malformed or malicious event could
--      therefore write dispensed_quantity and line_status onto line items of a
--      DIFFERENT prescription — a different patient's record. Every write here
--      is now scoped by prescription_id as well.
--
--   2. There was no transaction. A failure between the prescription update and
--      the processed_webhook_events insert left the status applied but the
--      event unrecorded; POS would retry, the transition check would reject the
--      repeat as illegal (DISPENSED → DISPENSED), and POS would file a
--      permanent failure for an event that had actually succeeded. Worse, a
--      failure part-way through the item loop left a prescription marked
--      DISPENSED with stale per-line quantities — the EMR would show the
--      patient received medicine it has no record of handing over.
--
--   3. The status check was check-then-act across two round-trips, so two
--      concurrent events could both pass it.
--
-- The fix is the ordinary one: do it in the database, in one transaction, with
-- the row locked. The handler's TypeScript check stays as a fast path that
-- returns a clean 404/409 without a write; THIS is the authority.
--
-- Defining the transition table twice is a real cost, paid deliberately. The
-- guard against drift is src/modules/prescriptions/integration/
-- state-machine-parity.test.ts, which parses this file and compares it to
-- ALLOWED_TRANSITIONS. Do not delete that test.

-- ── Transition table — MUST mirror ALLOWED_TRANSITIONS in prescription-contract.ts
create or replace function is_allowed_transition(p_current text, p_next text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select exists (
    select 1
    from (values
      ('DRAFT','PENDING'), ('DRAFT','CANCELLED'),
      ('PENDING','PRICED'), ('PENDING','OUT_OF_STOCK'), ('PENDING','CANCELLED'),
      ('PRICED','DISPENSED'), ('PRICED','PARTIAL'), ('PRICED','SUBSTITUTED'),
      ('PRICED','OUT_OF_STOCK'), ('PRICED','CANCELLED'),
      ('OUT_OF_STOCK','PRICED'), ('OUT_OF_STOCK','CANCELLED'),
      ('SUBSTITUTED','DISPENSED'), ('SUBSTITUTED','PARTIAL'), ('SUBSTITUTED','CANCELLED'),
      ('PARTIAL','DISPENSED'), ('PARTIAL','COLLECTED'), ('PARTIAL','CANCELLED'),
      ('DISPENSED','COLLECTED')
    ) as t(cur, nxt)
    where t.cur = p_current and t.nxt = p_next
  );
$$;

-- ── apply_status_event ──────────────────────────────────────────────────────
-- RETURNS 'APPLIED' or 'DEDUPED'.
-- RAISES  P0002 (prescription not found) or P0001 (illegal transition).
--
-- Raising rather than returning a code is deliberate: it rolls back the
-- processed_webhook_events row as well, so the eventId is NOT recorded as
-- handled. POS can retry and the event will be judged again once the
-- prescription exists or reaches a legal state. Returning a code would burn the
-- eventId permanently and the retry would silently dedupe into a no-op.
create or replace function apply_status_event(
  p_event_id           uuid,
  p_prescription_id    uuid,
  p_status             text,
  p_total_amount_cents integer default null,
  p_reason             text default null,
  p_lines              jsonb default null   -- [{itemId, dispensedQuantity, substitutedWith, lineStatus}]
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

  return 'APPLIED';
end;
$$;

-- Only the service role calls this — it is the webhook path, which has no
-- interactive user. Same posture as the rest of 0001: these tables have no
-- client-role policies by design.
revoke execute on function apply_status_event(uuid, uuid, text, integer, text, jsonb) from anon, authenticated;
revoke execute on function is_allowed_transition(text, text) from anon;
