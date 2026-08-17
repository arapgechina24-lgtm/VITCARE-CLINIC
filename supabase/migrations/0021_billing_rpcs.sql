-- VITCARE-CLINIC — Billing RPCs
-- ---------------------------------------------------------------------------
-- Split out of 0020_billing.sql, which holds the tables, the RLS and the
-- derivation triggers. The split is not stylistic: scripts/check-sql.mjs
-- validates a migration by handing the WHOLE FILE to pg-query-emscripten in
-- one call, and that parser fails with an unlocalised
-- "syntax error at or near"" once a file carries enough plpgsql — 13 bodies
-- was over the line, while the same 13 pass in two halves. Real Postgres
-- accepts either. Keep new RPCs spread across files rather than growing one
-- until the gate stops being able to read it.
--
-- Depends on 0020_billing.sql.

-- ── RPCs ──────────────────────────────────────────────────────────────────
create or replace function list_service_catalog(p_site_id uuid)
returns table (id uuid, code text, name text, category text, price_cents integer, vat_rate numeric)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select s.id, s.code, s.name, s.category, s.price_cents, s.vat_rate
    from service_catalog s
    where s.site_id = p_site_id and s.active
    order by s.category nulls last, s.name;
end;
$$;
revoke execute on function list_service_catalog(uuid) from anon;
grant execute on function list_service_catalog(uuid) to authenticated;

-- Opens (or returns) the draft invoice for an encounter. Idempotent: a desk
-- that clicks twice must not create a second draft for one visit, which is how
-- half a patient's charges end up on an invoice nobody issues.
create or replace function open_invoice_for_encounter(p_encounter_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_patient_id uuid;
  v_invoice_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to raise invoices';
  end if;

  select e.site_id, e.patient_id into v_site_id, v_patient_id
  from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select i.id into v_invoice_id from invoices i
  where i.encounter_id = p_encounter_id and i.status = 'DRAFT'
  limit 1;
  if v_invoice_id is not null then
    return v_invoice_id;
  end if;

  insert into invoices (encounter_id, patient_id, site_id, created_by)
  values (p_encounter_id, v_patient_id, v_site_id, auth.uid())
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;
revoke execute on function open_invoice_for_encounter(uuid) from anon;
grant execute on function open_invoice_for_encounter(uuid) to authenticated;

-- Price and description are copied from the catalogue HERE, at the moment of
-- charging, and never read back through the service_id afterwards.
create or replace function add_invoice_item(
  p_invoice_id uuid,
  p_service_id uuid,
  p_quantity integer
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_item_id uuid;
  v_name text;
  v_price integer;
  v_vat numeric(4,2);
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to add charges';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'quantity must be at least 1';
  end if;

  select i.site_id, i.status into v_site_id, v_status from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  -- An issued invoice is a document the patient has seen. Changing what it
  -- says after the fact is a credit note, not an edit.
  if v_status <> 'DRAFT' then
    raise exception 'invoice is % — charges can only be added to a draft', lower(v_status);
  end if;

  select s.name, s.price_cents, s.vat_rate into v_name, v_price, v_vat
  from service_catalog s
  where s.id = p_service_id and s.site_id = v_site_id and s.active;
  if v_name is null then
    raise exception 'unknown or inactive service for this site';
  end if;

  insert into invoice_items (invoice_id, service_id, description, quantity, unit_price_cents, vat_rate)
  values (p_invoice_id, p_service_id, v_name, p_quantity, v_price, v_vat)
  returning id into v_item_id;

  return v_item_id;
end;
$$;
revoke execute on function add_invoice_item(uuid, uuid, integer) from anon;
grant execute on function add_invoice_item(uuid, uuid, integer) to authenticated;

create or replace function remove_invoice_item(p_item_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to remove charges';
  end if;

  select i.site_id, i.status into v_site_id, v_status
  from invoice_items it join invoices i on i.id = it.invoice_id
  where it.id = p_item_id;
  if v_site_id is null then
    raise exception 'unknown charge';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'invoice is % — charges can only be removed from a draft', lower(v_status);
  end if;

  delete from invoice_items where id = p_item_id;
end;
$$;
revoke execute on function remove_invoice_item(uuid) from anon;
grant execute on function remove_invoice_item(uuid) to authenticated;

-- Allocates the number and freezes the document.
create or replace function issue_invoice(
  p_invoice_id uuid,
  p_payer text default 'CASH',
  p_insurer_code text default null
)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_items integer;
  v_day date;
  v_seq integer;
  v_no text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to issue invoices';
  end if;
  if p_payer not in ('CASH','SHA','INSURER') then
    raise exception 'unsupported payer %', p_payer;
  end if;
  if p_payer = 'INSURER' and coalesce(btrim(p_insurer_code), '') = '' then
    raise exception 'an insurer-paid invoice needs an insurer code';
  end if;

  select i.site_id, i.status into v_site_id, v_status from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'invoice is already %', lower(v_status);
  end if;

  select count(*) into v_items from invoice_items where invoice_id = p_invoice_id;
  if v_items = 0 then
    raise exception 'cannot issue an invoice with no charges on it';
  end if;

  -- Clinic-local day, not UTC: at 01:00 in Nairobi a UTC date is still
  -- yesterday, which would file the invoice under the wrong day's sequence.
  v_day := (now() at time zone 'Africa/Nairobi')::date;

  -- Atomic allocate-and-advance. Two cashiers issuing at the same instant take
  -- different numbers because the upsert serialises on the primary key.
  insert into invoice_counters (site_id, day, next_seq)
  values (v_site_id, v_day, 2)
  on conflict (site_id, day) do update set next_seq = invoice_counters.next_seq + 1
  returning next_seq - 1 into v_seq;

  v_no := 'VC-CL-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  update invoices
  set invoice_no = v_no,
      payer = p_payer,
      insurer_code = nullif(btrim(coalesce(p_insurer_code, '')), ''),
      status = 'ISSUED',
      issued_at = now(),
      updated_at = now()
  where id = p_invoice_id;

  -- Re-derive so a zero-rated or already-prepaid invoice lands on the right
  -- status immediately rather than sitting on ISSUED with nothing owing.
  perform billing_recalc_invoice(p_invoice_id);

  return v_no;
end;
$$;
revoke execute on function issue_invoice(uuid, text, text) from anon;
grant execute on function issue_invoice(uuid, text, text) to authenticated;

create or replace function record_payment(
  p_invoice_id uuid,
  p_method text,
  p_amount_cents integer,
  p_reference text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_total integer;
  v_paid integer;
  v_payment_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to take payment';
  end if;
  if p_method not in ('CASH','MPESA','INSURER','WAIVER') then
    raise exception 'unsupported payment method %', p_method;
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'a payment must be greater than zero';
  end if;

  select i.site_id, i.status, i.total_cents, i.paid_cents
    into v_site_id, v_status, v_total, v_paid
  from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status = 'DRAFT' then
    raise exception 'issue the invoice before taking payment';
  end if;
  if v_status = 'VOID' then
    raise exception 'this invoice was voided';
  end if;
  -- Overpayment is refused rather than absorbed. A till that silently accepts
  -- more than is owed cannot be reconciled, and the patient has no record that
  -- they are owed change.
  if v_paid + p_amount_cents > v_total then
    raise exception 'that is more than the % cents outstanding', v_total - v_paid;
  end if;

  insert into payments (invoice_id, method, amount_cents, reference, received_by)
  values (p_invoice_id, p_method, p_amount_cents, nullif(btrim(coalesce(p_reference, '')), ''), auth.uid())
  returning id into v_payment_id;

  return v_payment_id;
end;
$$;
revoke execute on function record_payment(uuid, text, integer, text) from anon;
grant execute on function record_payment(uuid, text, integer, text) to authenticated;

-- Voiding keeps the number and the payments. A voided invoice that erased its
-- own history would leave money received against no document.
create or replace function void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_paid integer;
  v_status text;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can void an invoice';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a void reason is required';
  end if;

  select i.site_id, i.paid_cents, i.status into v_site_id, v_paid, v_status
  from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status = 'VOID' then
    return;  -- idempotent
  end if;
  if v_paid > 0 then
    raise exception 'this invoice has % cents paid against it — refund before voiding', v_paid;
  end if;

  update invoices
  set status = 'VOID', void_reason = btrim(p_reason), updated_at = now()
  where id = p_invoice_id;
end;
$$;
revoke execute on function void_invoice(uuid, text) from anon;
grant execute on function void_invoice(uuid, text) to authenticated;

-- ── Reads ─────────────────────────────────────────────────────────────────
create or replace function list_invoices(
  p_site_id uuid,
  p_status text default null,
  p_limit integer default 100
)
returns table (
  id uuid,
  invoice_no text,
  patient_id uuid,
  patient_full_name text,
  patient_mrn text,
  encounter_id uuid,
  status text,
  payer text,
  total_cents integer,
  paid_cents integer,
  issued_at timestamptz,
  created_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients',
          jsonb_build_object('fn', 'list_invoices', 'site_id', p_site_id, 'status', p_status));

  return query
    select i.id, i.invoice_no, i.patient_id, p.full_name, p.mrn, i.encounter_id,
           i.status, i.payer, i.total_cents, i.paid_cents, i.issued_at, i.created_at
    from invoices i
    join patients p on p.id = i.patient_id
    where i.site_id = p_site_id
      and (p_status is null or i.status = p_status)
    order by i.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke execute on function list_invoices(uuid, text, integer) from anon;
grant execute on function list_invoices(uuid, text, integer) to authenticated;

-- Header, lines and payments in one document-shaped payload, plus the POS
-- figure for the same visit so the desk can SEE what the pharmacy is charging
-- without this invoice ever absorbing it.
create or replace function get_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_out jsonb;
begin
  select i.site_id into v_site_id from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or v_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'SELECT', 'invoices', p_invoice_id, jsonb_build_object('fn', 'get_invoice'));

  select jsonb_build_object(
    'invoice', to_jsonb(i) - 'created_by',
    'patient', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'mrn', p.mrn, 'phone', p.phone),
    'items', coalesce((
      select jsonb_agg(to_jsonb(it) order by it.created_at)
      from invoice_items it where it.invoice_id = i.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pay.id, 'method', pay.method, 'amount_cents', pay.amount_cents,
        'reference', pay.reference, 'received_at', pay.received_at,
        'received_by_name', u.full_name
      ) order by pay.received_at)
      from payments pay left join users u on u.id = pay.received_by
      where pay.invoice_id = i.id
    ), '[]'::jsonb),
    -- Explicitly labelled as POS's, and deliberately not added to any total
    -- on this document. See the scope note at the top of this file.
    'pharmacy', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rx.id, 'status', rx.status, 'total_amount_cents', rx.total_amount_cents
      ) order by rx.created_at)
      from prescriptions rx
      where rx.encounter_id = i.encounter_id and rx.status <> 'DRAFT'
    ), '[]'::jsonb)
  ) into v_out
  from invoices i join patients p on p.id = i.patient_id
  where i.id = p_invoice_id;

  return v_out;
end;
$$;
revoke execute on function get_invoice(uuid) from anon;
grant execute on function get_invoice(uuid) to authenticated;

-- Day totals for the billing screen. Cash-up figures, not a report engine.
create or replace function billing_day_summary(p_site_id uuid, p_day date default null)
returns table (
  invoiced_cents bigint,
  collected_cents bigint,
  outstanding_cents bigint,
  invoice_count integer,
  unpaid_count integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Africa/Nairobi')::date);
  v_from timestamptz := (v_day::text || ' 00:00:00 Africa/Nairobi')::timestamptz;
  v_to timestamptz := v_from + interval '1 day';
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select
      coalesce(sum(i.total_cents) filter (where i.status <> 'VOID'), 0)::bigint,
      coalesce(sum(i.paid_cents) filter (where i.status <> 'VOID'), 0)::bigint,
      coalesce(sum(i.total_cents - i.paid_cents) filter (where i.status in ('ISSUED','PART_PAID')), 0)::bigint,
      count(*) filter (where i.status <> 'VOID')::integer,
      count(*) filter (where i.status in ('ISSUED','PART_PAID'))::integer
    from invoices i
    where i.site_id = p_site_id
      and i.issued_at >= v_from and i.issued_at < v_to;
end;
$$;
revoke execute on function billing_day_summary(uuid, date) from anon;
grant execute on function billing_day_summary(uuid, date) to authenticated;
