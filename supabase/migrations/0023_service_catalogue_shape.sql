-- VITCARE-CLINIC — the service catalogue as the facility actually prices it
-- ---------------------------------------------------------------------------
-- 0020 gave service_catalog one price and a VAT rate, which was enough to prove
-- the billing machinery worked. The facility's real catalogue — 237 services,
-- reconciled from VITCARE_Level3_Clinic_Price_Catalogue.xlsx and
-- vitcare_service_catalogue_seed.csv, which agree on every field of every row —
-- does not fit that shape, and the gap is not cosmetic. Four things it carries
-- that the old table could not express, each of which changes what a patient is
-- charged:
--
--   1. TWO PRICES. Cash for uninsured walk-ins; a credit tariff, uplifted 20%
--      and rounded to KES 50, for schemes that settle on invoice. Which one
--      applies depends on WHO IS PAYING — so the payer has to be known before a
--      line is priced. 0021 asked for it at issue_invoice(), after every line
--      had already been priced. 0025 moves it to where the decision belongs.
--
--   2. SERVICES THAT MUST NEVER BE CHARGED. KEPI immunisation, HIV testing,
--      PEP, TB/GeneXpert, P3 forms, birth notification: government or donor
--      commodities and statutory services. The catalogue's own instruction is
--      "Enforce this in code: block cash capture on those service codes." A
--      price of zero is not enforcement — someone types over a zero. `billable`
--      is a refusal, and the CHECK below makes a non-billable line that somehow
--      reaches an invoice still worth nothing.
--
--   3. SHA CAPITATION. The Primary Healthcare Fund pays per registered person
--      per year, not per service, so an SHA patient must not be charged cash
--      for a covered service — AND the service must still be recorded, because
--      reported volume is what drives the disbursement. Those two requirements
--      together mean the line goes on the invoice at zero rather than being
--      refused. sha_phc_status is what lets 0025 tell the difference.
--
--   4. MODULES THE FACILITY DOES NOT YET RUN. 35 of the 237 lines are Imaging,
--      Radiology, Dental, Maternity, Ambulance or Visiting Specialist — legal
--      to offer only once the licence, equipment and registered staff exist.
--      They load inactive, so the desk cannot bill a caesarean referral at a
--      clinic that has no theatre.
--
-- ── VAT ────────────────────────────────────────────────────────────────────
-- The catalogue states it plainly: medical services in Kenya are generally
-- VAT-exempt, and every price in it is quoted gross with nothing added. So all
-- 237 lines seed at vat_rate 0. The column stays because an invoice is a tax
-- document and a rate of zero recorded is different from a rate not considered
-- — and because the day one line becomes standard-rated, the machinery in
-- billing_recalc_invoice already handles it.
--
-- ── PRICES ARE STILL EMPTY HERE ────────────────────────────────────────────
-- This file only changes shape. 0024 carries the 237 rows. The split is the
-- same discipline as 0020/0021: scripts/check-sql.mjs parses a whole migration
-- in one call and gives up on large files, so DDL, DML and RPCs stay apart.

-- ── Drop the single-price model ────────────────────────────────────────────
-- Safe and deliberate: service_catalog, invoices, invoice_items and payments
-- are all empty in production — verified before writing this — so there is no
-- historical row priced under the old column and nothing to migrate. Leaving
-- price_cents behind as a column nothing maintains would be worse than dropping
-- it: it is exactly the sort of field something later reads by accident and
-- charges a patient from.
alter table service_catalog drop column if exists price_cents;

alter table service_catalog
  add column if not exists sub_category text,
  -- "Per test", "Per visit", "Per tooth". Printed on the invoice line, because
  -- "Dental extraction × 3" is ambiguous in a way "× 3 teeth" is not.
  add column if not exists unit text,
  -- 'Core', or 'Conditional - <module>'. See the header.
  add column if not exists module text not null default 'Core',
  add column if not exists cash_price_cents integer not null default 0,
  add column if not exists insurance_price_cents integer not null default 0,
  add column if not exists sha_phc_status text not null default 'Not covered',
  -- False = this service must never appear as a charge. Two distinct reasons,
  -- both absolute, distinguished for the operator by billing_notes:
  --   · statutory or programme-funded (charging is a licensing risk), and
  --   · PHA-005 medicines, which VITCARE-POS prices on a fiscal receipt.
  add column if not exists billable boolean not null default true,
  -- The catalogue's own note. Not decoration: "Charge 0 where the commodity is
  -- donor supplied" is a judgement the desk has to make per patient, so it has
  -- to reach the desk.
  add column if not exists billing_notes text,
  -- Catalogue v1.0 is effective 01-Sep-2026 and DRAFT pending board approval.
  -- A price that is not yet approved is not a price, so 0025 refuses to charge
  -- from a line before this date rather than quietly billing a draft figure.
  add column if not exists effective_from date not null default current_date;

-- Prices are non-negative, and the credit tariff is an uplift over cash — never
-- below it. True for all 237 seeded rows; asserted so a future edit that
-- inverts them fails at the write rather than at the patient.
alter table service_catalog drop constraint if exists service_catalog_prices_sane;
alter table service_catalog add constraint service_catalog_prices_sane check (
  cash_price_cents >= 0
  and insurance_price_cents >= cash_price_cents
);

-- Defence in depth behind `billable`. 0025 refuses to raise a line for a
-- non-billable service; this makes the refusal survive being bypassed, because
-- a statutory service that somehow reaches an invoice must still cost nothing.
-- The converse half is just as load-bearing: a billable service with no price
-- is a line the desk will fill in by hand.
alter table service_catalog drop constraint if exists service_catalog_billable_pricing;
alter table service_catalog add constraint service_catalog_billable_pricing check (
  case when billable then cash_price_cents > 0
       else cash_price_cents = 0 and insurance_price_cents = 0 end
);

alter table service_catalog drop constraint if exists service_catalog_sha_status;
alter table service_catalog add constraint service_catalog_sha_status check (
  sha_phc_status in ('Covered', 'Partial', 'Not covered', 'Free')
);

alter table service_catalog drop constraint if exists service_catalog_module;
alter table service_catalog add constraint service_catalog_module check (
  module = 'Core' or module like 'Conditional - %'
);

-- (site_id, code) is already unique from 0020. The catalogue's instruction —
-- "Service Code is the immutable primary key. Never recycle a retired code" —
-- is enforced from both ends: retire by setting active = false, never by
-- deleting, and invoice_items.service_id is a foreign key, so any code that has
-- ever been charged cannot be removed and handed to a different service.
comment on column service_catalog.code is
  'Immutable. Retire with active = false; never delete, never reuse.';

-- The desk searches by name and browses by category; both go through
-- list_service_catalog with 237 rows behind them.
create index if not exists service_catalog_site_active_idx
  on service_catalog (site_id, active, category);

-- ── Why a line was priced the way it was ───────────────────────────────────
-- Reading unit_price_cents alone cannot distinguish "SHA covers this, so zero"
-- from "someone typed zero". An auditor asking why a line is free deserves an
-- answer from the row itself rather than from a reconstruction of what the
-- payer was on the day.
alter table invoice_items
  add column if not exists price_basis text not null default 'CASH';
alter table invoice_items drop constraint if exists invoice_items_price_basis;
alter table invoice_items add constraint invoice_items_price_basis check (
  price_basis in ('CASH', 'INSURANCE', 'SHA_COVERED')
);
-- The unit the quantity is counted in, snapshotted alongside the price for the
-- same reason the description is: the catalogue can be re-worded later.
alter table invoice_items add column if not exists unit text;
