-- VITCARE-CLINIC — terminal failure state for the outbox
-- ---------------------------------------------------------------------------
-- Found by running the real loop end to end against VITCARE-POS.
--
-- markFailed() previously only recorded last_error. The claim query selects
-- `delivered = false`, so a permanently-failed row (illegal transition, bad
-- signature, a payload POS rejects) still matched it and was re-sent on EVERY
-- subsequent drain — forever, at whatever the scheduler interval is.
--
-- `failed` is deliberately separate from `delivered`: the row must stop being
-- claimed without ever being mistaken for one that actually reached the
-- pharmacy, and it must stay visible to whoever investigates why a
-- prescription never arrived.
alter table integration_outbox add column if not exists failed boolean not null default false;

drop index if exists idx_outbox_pending;
create index if not exists idx_outbox_pending
  on integration_outbox (next_attempt_at) where delivered = false and failed = false;
