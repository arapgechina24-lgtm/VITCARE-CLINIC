-- VITCARE-CLINIC — the 237 services this facility offers, at its own prices
-- ---------------------------------------------------------------------------
-- Source: VITCARE_Level3_Clinic_Price_Catalogue.xlsx ("Master Catalogue" sheet)
-- and vitcare_service_catalogue_seed.csv, supplied together. Both were parsed
-- and compared field by field before this file was generated: 237 codes in
-- each, identical sets, and zero differences across name, category,
-- sub-category, unit, module, both prices, SHA status and notes. Either could
-- have been the source; that they agree is why this seed can be trusted.
--
-- Derived here rather than copied, from rules stated in the workbook's
-- "Pricing Policy" sheet:
--
--   billable = false   for the 19 lines the workbook marks zero-rated. Those
--                      are government or donor commodities (KEPI, HIV testing,
--                      PrEP, PEP, condoms, TB/GeneXpert), statutory services
--                      (P3 forms, birth notification), facility-absorbed
--                      services (SMS results, claim processing), and PHA-005
--                      medicines, which VITCARE-POS prices on a fiscal
--                      receipt. The workbook's instruction is literal: "Enforce
--                      this in code: block cash capture on those service
--                      codes." 0025 does.
--
--   active = false     for the 35 Conditional lines — Imaging (12), Dental (9),
--                      Maternity (8), Radiology (3), Ambulance (2), Visiting
--                      Specialist (1). "Conditional lines should be loaded into
--                      VITCARE-CLINIC as disabled until the module goes live,
--                      so they cannot be billed prematurely." Turn one on with
--                      an UPDATE when the licence, equipment and registered
--                      personnel are in place — not before.
--
--   vat_rate = 0       everywhere, by omission: "Medical services in Kenya are
--                      generally VAT-exempt. All prices are quoted gross with
--                      no VAT added." The column defaults to 0 in 0020.
--
--   prices in CENTS    the workbook is in whole shillings; ×100 here, because
--                      every money column in both systems is integer cents.
--
-- ── TWO THINGS TO KNOW BEFORE THIS GOES LIVE ───────────────────────────────
-- 1. EFFECTIVE DATE. The workbook is "v1.0 (DRAFT - pending board approval)",
--    effective 01-Sep-2026. That date is seeded as written and 0025 refuses to
--    charge from a line before it, so nobody bills an unapproved figure by
--    accident. If the board has already ratified the catalogue, bring it
--    forward deliberately:
--        update service_catalog set effective_from = current_date
--        where site_id = '<site>' and effective_from = date '2026-09-01';
--
-- 2. THESE ARE BENCHMARKS, NOT QUOTATIONS. The workbook says so of itself:
--    "constructed benchmarks based on prevailing private-sector ranges in
--    Kenya... Validate each line against at least three local facilities
--    before publishing." Seeding them makes them operable, not verified.
--
-- ── ON CONFLICT DO NOTHING, DELIBERATELY ───────────────────────────────────
-- The review cycle is quarterly. If this folder is ever replayed for disaster
-- recovery — which is the whole reason 0014 exists — a `do update` here would
-- silently roll every price back to August 2026 and nobody would see it
-- happen. Seeding only what is missing means a replay restores a missing
-- catalogue and leaves a revised one alone. Price changes belong in their own
-- migration, where they are reviewable.
--
-- Seeded for every site, since a catalogue is per-site and this facility has
-- one. No site id is hardcoded.

insert into service_catalog (
  site_id, code, name, category, sub_category, unit, module,
  cash_price_cents, insurance_price_cents, sha_phc_status,
  billable, active, billing_notes, effective_from
)
select
  s.id, v.code, v.name, v.category, v.sub_category, v.unit, v.module,
  v.cash_price_cents, v.insurance_price_cents, v.sha_phc_status,
  v.billable, v.active, v.billing_notes, date '2026-09-01'
from sites s
cross join (values
  ('CON-001', 'New patient registration & file opening', 'Consultation & Registration', 'Registration', 'Per patient', 'Core', 10000, 10000, 'Covered', true, true, 'One-off. Waive for SHA-registered members to drive capitation enrolment.'),
  ('CON-002', 'Outpatient consultation - Clinical Officer', 'Consultation & Registration', 'Outpatient', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, 'Baseline OPD rate; benchmark against nearest competitor quarterly.'),
  ('CON-003', 'Outpatient consultation - Medical Officer', 'Consultation & Registration', 'Outpatient', 'Per visit', 'Core', 100000, 120000, 'Covered', true, true, 'Charged only when a Medical Officer is on duty.'),
  ('CON-004', 'Review / follow-up consultation (same complaint, within 14 days)', 'Consultation & Registration', 'Outpatient', 'Per visit', 'Core', 20000, 25000, 'Covered', true, true, 'Retention lever - keeps the patient in-network for the treatment episode.'),
  ('CON-005', 'Specialist / visiting consultant clinic', 'Consultation & Registration', 'Specialist', 'Per visit', 'Conditional - Visiting Specialist', 250000, 300000, 'Not covered', true, false, 'Revenue-share with the visiting specialist; set split in contract.'),
  ('CON-006', 'Teleconsultation (phone / video)', 'Consultation & Registration', 'Digital', 'Per session', 'Core', 50000, 60000, 'Not covered', true, true, 'Requires documented consult note in VITCARE-CLINIC to be billable.'),
  ('CON-007', 'After-hours / night consultation surcharge (2000h-0600h)', 'Consultation & Registration', 'Outpatient', 'Per visit', 'Core', 50000, 60000, 'Not covered', true, true, 'Surcharge on top of CON-002/CON-003.'),
  ('CON-008', 'Home visit - within Naivasha town', 'Consultation & Registration', 'Domiciliary', 'Per visit', 'Core', 300000, 360000, 'Not covered', true, true, 'Inclusive of clinician time and transport within 10 km.'),
  ('CON-009', 'Home visit - mileage beyond 10 km', 'Consultation & Registration', 'Domiciliary', 'Per km', 'Core', 10000, 10000, 'Not covered', true, true, 'Charged in addition to CON-008.'),
  ('CON-010', 'Second medical opinion / case file review', 'Consultation & Registration', 'Outpatient', 'Per case', 'Core', 150000, 180000, 'Not covered', true, true, 'Includes written summary.'),
  ('EMR-001', 'Triage and vital signs (BP, temp, SpO2, pulse, weight)', 'Emergency & Observation', 'Triage', 'Per episode', 'Core', 10000, 10000, 'Covered', true, true, 'Bundle free into any paid consultation; charge only for walk-in checks.'),
  ('EMR-002', 'Emergency resuscitation & stabilisation', 'Emergency & Observation', 'Resuscitation', 'Per episode', 'Core', 350000, 420000, 'Partial', true, true, 'Excludes drugs and consumables, billed via VITCARE-POS.'),
  ('EMR-003', 'Observation bed - per 6 hours', 'Emergency & Observation', 'Observation', 'Per 6 hrs', 'Core', 80000, 95000, 'Partial', true, true, 'Level 3 short-stay only; escalate beyond 12 hrs.'),
  ('EMR-004', 'Day-care observation (up to 12 hours)', 'Emergency & Observation', 'Observation', 'Per episode', 'Core', 150000, 180000, 'Partial', true, true, 'Includes nursing review; excludes drugs and IV fluids.'),
  ('EMR-005', 'Oxygen therapy - per hour', 'Emergency & Observation', 'Respiratory', 'Per hour', 'Core', 50000, 60000, 'Partial', true, true, 'Track cylinder consumption against this line for true margin.'),
  ('EMR-006', 'Nebulisation - per session', 'Emergency & Observation', 'Respiratory', 'Per session', 'Core', 50000, 60000, 'Covered', true, true, 'Excludes salbutamol/ipratropium, billed separately.'),
  ('EMR-007', 'Ambulance / referral transport - within Naivasha', 'Emergency & Observation', 'Transport', 'Per trip', 'Conditional - Ambulance', 500000, 600000, 'Partial', true, false, 'Only if the facility operates a licensed ambulance.'),
  ('EMR-008', 'Ambulance - mileage beyond 20 km', 'Emergency & Observation', 'Transport', 'Per km', 'Conditional - Ambulance', 12000, 15000, 'Partial', true, false, 'Charged in addition to EMR-007.'),
  ('EMR-009', 'Referral coordination & clinical escort', 'Emergency & Observation', 'Transport', 'Per trip', 'Core', 200000, 240000, 'Not covered', true, true, 'Staff time when escorting a patient to a Level 4/5 facility.'),
  ('NUR-001', 'Intramuscular / subcutaneous injection (excl. drug)', 'Nursing & Treatment Room', 'Injections', 'Per injection', 'Core', 20000, 25000, 'Covered', true, true, 'Drug billed separately at VITCARE-POS retail.'),
  ('NUR-002', 'Intravenous injection / slow push (excl. drug)', 'Nursing & Treatment Room', 'Injections', 'Per injection', 'Core', 30000, 35000, 'Covered', true, true, 'Requires prescriber sign-off in the EMR.'),
  ('NUR-003', 'IV cannulation', 'Nursing & Treatment Room', 'Injections', 'Per cannula', 'Core', 30000, 35000, 'Covered', true, true, 'Includes cannula and dressing.'),
  ('NUR-004', 'IV infusion administration - per drip (excl. fluid)', 'Nursing & Treatment Room', 'Injections', 'Per drip', 'Core', 50000, 60000, 'Covered', true, true, 'Giving set included; IV fluid billed separately.'),
  ('NUR-005', 'Wound dressing - simple / small', 'Nursing & Treatment Room', 'Wound Care', 'Per dressing', 'Core', 30000, 35000, 'Covered', true, true, 'Standard dressing pack included.'),
  ('NUR-006', 'Wound dressing - medium', 'Nursing & Treatment Room', 'Wound Care', 'Per dressing', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('NUR-007', 'Wound dressing - large / complex / infected', 'Nursing & Treatment Room', 'Wound Care', 'Per dressing', 'Core', 80000, 95000, 'Covered', true, true, 'Includes irrigation and antiseptics.'),
  ('NUR-008', 'Burns dressing - minor (<10% TBSA)', 'Nursing & Treatment Room', 'Wound Care', 'Per dressing', 'Core', 100000, 120000, 'Covered', true, true, 'Refer if >10% TBSA or airway involvement.'),
  ('NUR-009', 'Burns dressing - extensive', 'Nursing & Treatment Room', 'Wound Care', 'Per dressing', 'Core', 200000, 240000, 'Partial', true, true, 'Stabilise and refer to Level 4/5.'),
  ('NUR-010', 'Suture removal', 'Nursing & Treatment Room', 'Wound Care', 'Per episode', 'Core', 30000, 35000, 'Covered', true, true, 'Free if the suturing was done at this facility.'),
  ('NUR-011', 'Urethral catheterisation (incl. catheter & bag)', 'Nursing & Treatment Room', 'Urology', 'Per procedure', 'Core', 150000, 180000, 'Covered', true, true, null),
  ('NUR-012', 'Catheter removal / change (excl. catheter)', 'Nursing & Treatment Room', 'Urology', 'Per procedure', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('NUR-013', 'Nasogastric tube insertion (incl. tube)', 'Nursing & Treatment Room', 'Gastro', 'Per procedure', 'Core', 100000, 120000, 'Covered', true, true, null),
  ('NUR-014', 'Enema administration', 'Nursing & Treatment Room', 'Gastro', 'Per procedure', 'Core', 80000, 95000, 'Covered', true, true, null),
  ('NUR-015', 'Ear syringing / wax removal - both ears', 'Nursing & Treatment Room', 'ENT', 'Per session', 'Core', 80000, 95000, 'Covered', true, true, 'Single ear charged at the same rate.'),
  ('NUR-016', 'Eye irrigation / superficial foreign body removal', 'Nursing & Treatment Room', 'Ophthalmic', 'Per episode', 'Core', 80000, 95000, 'Covered', true, true, 'Refer corneal injuries.'),
  ('NUR-017', 'Random blood sugar check (glucometer)', 'Nursing & Treatment Room', 'Point of Care', 'Per test', 'Core', 10000, 10000, 'Covered', true, true, 'Loss-leader for NCD clinic recruitment.'),
  ('NUR-018', 'Blood pressure check (walk-in)', 'Nursing & Treatment Room', 'Point of Care', 'Per check', 'Core', 10000, 10000, 'Covered', true, true, 'Free during screening campaigns.'),
  ('NUR-019', 'Weight, height & BMI assessment', 'Nursing & Treatment Room', 'Point of Care', 'Per check', 'Core', 10000, 10000, 'Covered', true, true, null),
  ('NUR-020', 'Vitamin / mineral infusion administration (excl. drug)', 'Nursing & Treatment Room', 'Injections', 'Per session', 'Core', 50000, 60000, 'Not covered', true, true, 'Elective wellness service; requires prescriber authorisation.'),
  ('NUR-021', 'Treatment-room consumables pack', 'Nursing & Treatment Room', 'Consumables', 'Per procedure', 'Core', 20000, 25000, 'Not covered', true, true, 'Apply only where consumables are not already bundled in the procedure.'),
  ('SUR-001', 'Incision & drainage - small abscess', 'Minor Surgical Procedures', 'Abscess', 'Per procedure', 'Core', 150000, 180000, 'Covered', true, true, 'Includes local anaesthesia and first dressing.'),
  ('SUR-002', 'Incision & drainage - large / multiple abscess', 'Minor Surgical Procedures', 'Abscess', 'Per procedure', 'Core', 300000, 360000, 'Covered', true, true, null),
  ('SUR-003', 'Suturing - simple laceration (<=5 cm)', 'Minor Surgical Procedures', 'Suturing', 'Per procedure', 'Core', 200000, 240000, 'Covered', true, true, 'Includes suture material, local anaesthesia, dressing.'),
  ('SUR-004', 'Suturing - complex / multi-layer / facial', 'Minor Surgical Procedures', 'Suturing', 'Per procedure', 'Core', 350000, 420000, 'Covered', true, true, null),
  ('SUR-005', 'Excision of sebaceous cyst / lipoma', 'Minor Surgical Procedures', 'Excision', 'Per procedure', 'Core', 500000, 600000, 'Partial', true, true, 'Histology billed separately as a send-out.'),
  ('SUR-006', 'Nail avulsion - partial', 'Minor Surgical Procedures', 'Nail', 'Per procedure', 'Core', 250000, 300000, 'Covered', true, true, null),
  ('SUR-007', 'Nail avulsion - complete', 'Minor Surgical Procedures', 'Nail', 'Per procedure', 'Core', 350000, 420000, 'Covered', true, true, null),
  ('SUR-008', 'Foreign body removal - soft tissue (minor)', 'Minor Surgical Procedures', 'Foreign Body', 'Per procedure', 'Core', 200000, 240000, 'Covered', true, true, null),
  ('SUR-009', 'Wart / skin tag cauterisation', 'Minor Surgical Procedures', 'Dermatology', 'Per session', 'Core', 200000, 240000, 'Not covered', true, true, 'Multiple lesions in one session count as one charge.'),
  ('SUR-010', 'Punch / incisional biopsy (excl. histology)', 'Minor Surgical Procedures', 'Biopsy', 'Per procedure', 'Core', 350000, 420000, 'Partial', true, true, 'Histopathology is a send-out; quote separately.'),
  ('SUR-011', 'Male circumcision - paediatric (under 12 yrs)', 'Minor Surgical Procedures', 'Circumcision', 'Per procedure', 'Core', 500000, 600000, 'Partial', true, true, 'Seasonal demand spike in December and April.'),
  ('SUR-012', 'Male circumcision - adult', 'Minor Surgical Procedures', 'Circumcision', 'Per procedure', 'Core', 800000, 960000, 'Partial', true, true, 'Free under VMMC campaigns where the facility is a partner site.'),
  ('SUR-013', 'Plaster of Paris (POP) application - limb', 'Minor Surgical Procedures', 'Orthopaedic', 'Per procedure', 'Conditional - Imaging', 350000, 420000, 'Partial', true, false, 'Only after X-ray confirmation; otherwise splint and refer.'),
  ('SUR-014', 'POP removal', 'Minor Surgical Procedures', 'Orthopaedic', 'Per procedure', 'Core', 80000, 95000, 'Covered', true, true, null),
  ('SUR-015', 'Splinting / strapping (minor injury)', 'Minor Surgical Procedures', 'Orthopaedic', 'Per procedure', 'Core', 150000, 180000, 'Covered', true, true, null),
  ('SUR-016', 'Post-abortion care - manual vacuum aspiration (MVA)', 'Minor Surgical Procedures', 'Gynaecological', 'Per procedure', 'Core', 600000, 720000, 'Covered', true, true, 'Statutory emergency service; never deny on inability to pay.'),
  ('SUR-017', 'Wound / abscess debridement', 'Minor Surgical Procedures', 'Wound Care', 'Per procedure', 'Core', 300000, 360000, 'Covered', true, true, null),
  ('SUR-018', 'Local anaesthesia & minor theatre pack', 'Minor Surgical Procedures', 'Consumables', 'Per procedure', 'Core', 80000, 95000, 'Not covered', true, true, 'Apply only where not already bundled in the procedure fee.'),
  ('MCH-001', 'Antenatal clinic (ANC) visit', 'Maternal & Child Health', 'Antenatal', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, 'SHA PHC covers ANC; charge cash patients only.'),
  ('MCH-002', 'Focused ANC package (4 visits + ANC profile + 2 scans)', 'Maternal & Child Health', 'Antenatal', 'Per pregnancy', 'Core', 800000, 960000, 'Covered', true, true, 'Prepaid package - improves ANC completion and cash flow.'),
  ('MCH-003', 'Postnatal clinic visit (mother)', 'Maternal & Child Health', 'Postnatal', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('MCH-004', 'Newborn / postnatal check (baby)', 'Maternal & Child Health', 'Postnatal', 'Per visit', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('MCH-005', 'Child welfare clinic - growth monitoring & counselling', 'Maternal & Child Health', 'Child Health', 'Per visit', 'Core', 20000, 25000, 'Covered', true, true, 'Anchor service for the under-5 population; keep price low.'),
  ('MCH-006', 'KEPI routine immunisation (BCG, OPV, Penta, PCV, Rota, MR, YF)', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 0, 0, 'Free', false, true, 'Government commodity - MUST NOT be charged. Report doses via DHIS2/KHIS.'),
  ('MCH-007', 'Vitamin A supplementation & deworming (under-5)', 'Maternal & Child Health', 'Child Health', 'Per dose', 'Core', 0, 0, 'Free', false, true, 'Government commodity.'),
  ('MCH-008', 'Tetanus toxoid (TT/Td) - per dose', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 50000, 60000, 'Partial', true, true, 'Free for pregnant women under the national programme.'),
  ('MCH-009', 'Hepatitis B vaccine - adult dose', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 150000, 180000, 'Not covered', true, true, '3-dose schedule; sell as a course to improve completion.'),
  ('MCH-010', 'Rabies vaccine - post-exposure dose', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 350000, 420000, 'Partial', true, true, 'High-value line; maintain cold-chain stock given local dog-bite volume.'),
  ('MCH-011', 'Typhoid vaccine', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 300000, 360000, 'Not covered', true, true, null),
  ('MCH-012', 'Influenza vaccine (seasonal)', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 250000, 300000, 'Not covered', true, true, 'Target corporate accounts.'),
  ('MCH-013', 'HPV vaccine (girls 10-14 yrs, national programme)', 'Maternal & Child Health', 'Immunisation', 'Per dose', 'Core', 0, 0, 'Free', false, true, 'Government commodity.'),
  ('MCH-014', 'Nutrition assessment & counselling (MUAC / IMAM)', 'Maternal & Child Health', 'Nutrition', 'Per session', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('MCH-015', 'Antenatal ultrasound - dating / viability', 'Maternal & Child Health', 'Antenatal', 'Per scan', 'Conditional - Imaging', 200000, 240000, 'Partial', true, false, 'Requires an ultrasound machine and a trained sonographer.'),
  ('FPL-001', 'Family planning counselling session', 'Family Planning & Reproductive Health', 'Counselling', 'Per session', 'Core', 0, 0, 'Free', false, true, 'Never charged - it is the funnel into all FP services.'),
  ('FPL-002', 'Combined oral contraceptive pills', 'Family Planning & Reproductive Health', 'Commodities', 'Per cycle', 'Core', 20000, 25000, 'Free', true, true, 'Charge 0 where the commodity is donor or government supplied (TIKO / MOH).'),
  ('FPL-003', 'Progestin-only pills', 'Family Planning & Reproductive Health', 'Commodities', 'Per cycle', 'Core', 20000, 25000, 'Free', true, true, 'As above.'),
  ('FPL-004', 'Emergency contraceptive pill', 'Family Planning & Reproductive Health', 'Commodities', 'Per dose', 'Core', 30000, 35000, 'Not covered', true, true, null),
  ('FPL-005', 'DMPA (Depo-Provera) injection', 'Family Planning & Reproductive Health', 'Injectables', 'Per dose', 'Core', 50000, 60000, 'Free', true, true, 'Charge 0 where commodity is donor supplied; bill administration only.'),
  ('FPL-006', 'Sayana Press (subcutaneous DMPA)', 'Family Planning & Reproductive Health', 'Injectables', 'Per dose', 'Core', 60000, 70000, 'Free', true, true, null),
  ('FPL-007', 'Contraceptive implant insertion (Jadelle / Implanon)', 'Family Planning & Reproductive Health', 'Long Acting', 'Per procedure', 'Core', 150000, 180000, 'Free', true, true, 'Reimbursable under TIKO where the client qualifies.'),
  ('FPL-008', 'Contraceptive implant removal', 'Family Planning & Reproductive Health', 'Long Acting', 'Per procedure', 'Core', 200000, 240000, 'Free', true, true, 'Removal must never be denied or delayed for non-payment.'),
  ('FPL-009', 'IUCD insertion (Copper T)', 'Family Planning & Reproductive Health', 'Long Acting', 'Per procedure', 'Core', 250000, 300000, 'Free', true, true, null),
  ('FPL-010', 'IUCD removal', 'Family Planning & Reproductive Health', 'Long Acting', 'Per procedure', 'Core', 150000, 180000, 'Free', true, true, null),
  ('FPL-011', 'Male / female condoms', 'Family Planning & Reproductive Health', 'Commodities', 'Per pack', 'Core', 0, 0, 'Free', false, true, 'Government commodity.'),
  ('FPL-012', 'Cervical cancer screening - VIA / VILI', 'Family Planning & Reproductive Health', 'Screening', 'Per screen', 'Core', 100000, 120000, 'Covered', true, true, 'Free during county screening campaigns.'),
  ('FPL-013', 'Pap smear (send-out cytology)', 'Family Planning & Reproductive Health', 'Screening', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, 'Send-out; add LAB-MIC-018 handling fee if not bundled.'),
  ('FPL-014', 'Clinical breast examination & counselling', 'Family Planning & Reproductive Health', 'Screening', 'Per session', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('FPL-015', 'STI syndromic management consultation', 'Family Planning & Reproductive Health', 'STI', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('FPL-016', 'HIV testing services (HTS) & counselling', 'Family Planning & Reproductive Health', 'HIV', 'Per test', 'Core', 0, 0, 'Free', false, true, 'Government / donor commodity - MUST NOT be charged.'),
  ('FPL-017', 'PrEP initiation & refill review', 'Family Planning & Reproductive Health', 'HIV', 'Per visit', 'Core', 0, 0, 'Free', false, true, 'Programme commodity.'),
  ('FPL-018', 'Post-exposure prophylaxis (PEP) initiation', 'Family Planning & Reproductive Health', 'HIV', 'Per episode', 'Core', 0, 0, 'Free', false, true, 'Time-critical - initiate within 72 hours, never delay for payment.'),
  ('MAT-001', 'Normal vaginal delivery (incl. delivery pack & 24 hr stay)', 'Maternity Services', 'Delivery', 'Per delivery', 'Conditional - Maternity', 1500000, 1800000, 'Covered', true, false, 'SHA / Linda Mama covers this; cash rate applies to non-members.'),
  ('MAT-002', 'Assisted vaginal delivery (vacuum extraction)', 'Maternity Services', 'Delivery', 'Per delivery', 'Conditional - Maternity', 2000000, 2400000, 'Covered', true, false, null),
  ('MAT-003', 'Maternity bed - per additional night', 'Maternity Services', 'Delivery', 'Per night', 'Conditional - Maternity', 200000, 240000, 'Covered', true, false, null),
  ('MAT-004', 'Manual removal of retained placenta', 'Maternity Services', 'Complications', 'Per procedure', 'Conditional - Maternity', 600000, 720000, 'Covered', true, false, 'Stabilise and refer if bleeding is not controlled.'),
  ('MAT-005', 'Episiotomy / perineal tear repair', 'Maternity Services', 'Complications', 'Per procedure', 'Conditional - Maternity', 300000, 360000, 'Covered', true, false, null),
  ('MAT-006', 'Newborn resuscitation & stabilisation', 'Maternity Services', 'Newborn', 'Per episode', 'Conditional - Maternity', 300000, 360000, 'Covered', true, false, null),
  ('MAT-007', 'Caesarean referral - stabilisation & transfer', 'Maternity Services', 'Referral', 'Per episode', 'Conditional - Maternity', 600000, 720000, 'Partial', true, false, 'Level 3 cannot perform caesarean section; refer to Level 4+.'),
  ('MAT-008', 'Birth notification & records processing', 'Maternity Services', 'Documentation', 'Per birth', 'Conditional - Maternity', 0, 0, 'Free', false, false, 'Statutory - never charged.'),
  ('LAB-HAE-001', 'Full haemogram / complete blood count (automated)', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 80000, 95000, 'Covered', true, true, 'Highest-volume lab line; protect reagent supply.'),
  ('LAB-HAE-002', 'Haemoglobin (Hb) estimation', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 20000, 25000, 'Covered', true, true, null),
  ('LAB-HAE-003', 'Erythrocyte sedimentation rate (ESR)', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-HAE-004', 'Blood group & Rhesus factor', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-HAE-005', 'Peripheral blood film / slide review', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-HAE-006', 'Reticulocyte count', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 50000, 60000, 'Partial', true, true, null),
  ('LAB-HAE-007', 'Sickling test', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-HAE-008', 'Haemoglobin electrophoresis', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 350000, 420000, 'Partial', true, true, 'Send-out to a reference laboratory.'),
  ('LAB-HAE-009', 'Bleeding time & clotting time', 'Laboratory - Haematology', 'Coagulation', 'Per test', 'Core', 40000, 50000, 'Covered', true, true, null),
  ('LAB-HAE-010', 'Prothrombin time / INR', 'Laboratory - Haematology', 'Coagulation', 'Per test', 'Core', 120000, 145000, 'Partial', true, true, null),
  ('LAB-HAE-011', 'Total & differential white cell count', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 40000, 50000, 'Covered', true, true, null),
  ('LAB-HAE-012', 'Platelet count', 'Laboratory - Haematology', 'Haematology', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-CHE-001', 'Random blood sugar (RBS)', 'Laboratory - Clinical Chemistry', 'Glucose', 'Per test', 'Core', 20000, 25000, 'Covered', true, true, null),
  ('LAB-CHE-002', 'Fasting blood sugar (FBS)', 'Laboratory - Clinical Chemistry', 'Glucose', 'Per test', 'Core', 20000, 25000, 'Covered', true, true, null),
  ('LAB-CHE-003', '2-hour post-prandial glucose', 'Laboratory - Clinical Chemistry', 'Glucose', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-CHE-004', 'Oral glucose tolerance test (OGTT)', 'Laboratory - Clinical Chemistry', 'Glucose', 'Per test', 'Core', 120000, 145000, 'Partial', true, true, 'Includes glucose load and serial sampling.'),
  ('LAB-CHE-005', 'Glycated haemoglobin (HbA1c)', 'Laboratory - Clinical Chemistry', 'Glucose', 'Per test', 'Core', 150000, 180000, 'Covered', true, true, 'Core NCD monitoring line; SHA covers diabetic panels.'),
  ('LAB-CHE-006', 'Urea, electrolytes & creatinine (U/E/C)', 'Laboratory - Clinical Chemistry', 'Renal', 'Per panel', 'Core', 200000, 240000, 'Covered', true, true, null),
  ('LAB-CHE-007', 'Serum creatinine (single analyte)', 'Laboratory - Clinical Chemistry', 'Renal', 'Per test', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('LAB-CHE-008', 'Blood urea (single analyte)', 'Laboratory - Clinical Chemistry', 'Renal', 'Per test', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('LAB-CHE-009', 'Serum electrolytes (Na, K, Cl)', 'Laboratory - Clinical Chemistry', 'Renal', 'Per panel', 'Core', 120000, 145000, 'Covered', true, true, null),
  ('LAB-CHE-010', 'Liver function tests (full LFT)', 'Laboratory - Clinical Chemistry', 'Hepatic', 'Per panel', 'Core', 200000, 240000, 'Covered', true, true, null),
  ('LAB-CHE-011', 'Total & direct bilirubin', 'Laboratory - Clinical Chemistry', 'Hepatic', 'Per test', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('LAB-CHE-012', 'Serum albumin / total protein', 'Laboratory - Clinical Chemistry', 'Hepatic', 'Per test', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('LAB-CHE-013', 'Lipid profile (full)', 'Laboratory - Clinical Chemistry', 'Lipids', 'Per panel', 'Core', 180000, 215000, 'Covered', true, true, null),
  ('LAB-CHE-014', 'Serum uric acid', 'Laboratory - Clinical Chemistry', 'Metabolic', 'Per test', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('LAB-CHE-015', 'Serum amylase', 'Laboratory - Clinical Chemistry', 'Pancreatic', 'Per test', 'Core', 120000, 145000, 'Partial', true, true, null),
  ('LAB-CHE-016', 'Serum calcium', 'Laboratory - Clinical Chemistry', 'Metabolic', 'Per test', 'Core', 70000, 85000, 'Partial', true, true, null),
  ('LAB-CHE-017', 'Thyroid function test (TSH, T3, T4)', 'Laboratory - Clinical Chemistry', 'Endocrine', 'Per panel', 'Core', 350000, 420000, 'Partial', true, true, 'Send-out unless an immunoassay analyser is installed.'),
  ('LAB-CHE-018', 'Serum iron / ferritin', 'Laboratory - Clinical Chemistry', 'Haematinics', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, 'Send-out.'),
  ('LAB-SER-001', 'HIV rapid test (screening & confirmatory)', 'Laboratory - Serology & Immunology', 'HIV', 'Per test', 'Core', 0, 0, 'Free', false, true, 'Government / donor commodity - MUST NOT be charged.'),
  ('LAB-SER-002', 'Syphilis - VDRL / RPR', 'Laboratory - Serology & Immunology', 'STI', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, 'Free for antenatal clients under the national programme.'),
  ('LAB-SER-003', 'Hepatitis B surface antigen (HBsAg)', 'Laboratory - Serology & Immunology', 'Hepatitis', 'Per test', 'Core', 60000, 70000, 'Covered', true, true, null),
  ('LAB-SER-004', 'Hepatitis C antibody (anti-HCV)', 'Laboratory - Serology & Immunology', 'Hepatitis', 'Per test', 'Core', 80000, 95000, 'Partial', true, true, null),
  ('LAB-SER-005', 'H. pylori antibody / stool antigen', 'Laboratory - Serology & Immunology', 'Gastro', 'Per test', 'Core', 80000, 95000, 'Covered', true, true, 'High-volume line in this market; stock consistently.'),
  ('LAB-SER-006', 'Widal test (typhoid)', 'Laboratory - Serology & Immunology', 'Febrile', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, 'Interpret with clinical correlation; avoid over-testing.'),
  ('LAB-SER-007', 'Brucella agglutination test (BAT)', 'Laboratory - Serology & Immunology', 'Febrile', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-SER-008', 'Rheumatoid factor (RF)', 'Laboratory - Serology & Immunology', 'Inflammatory', 'Per test', 'Core', 60000, 70000, 'Covered', true, true, null),
  ('LAB-SER-009', 'Anti-streptolysin O (ASO) titre', 'Laboratory - Serology & Immunology', 'Inflammatory', 'Per test', 'Core', 60000, 70000, 'Covered', true, true, null),
  ('LAB-SER-010', 'C-reactive protein (CRP)', 'Laboratory - Serology & Immunology', 'Inflammatory', 'Per test', 'Core', 80000, 95000, 'Covered', true, true, null),
  ('LAB-SER-011', 'Urine pregnancy test (hCG)', 'Laboratory - Serology & Immunology', 'Pregnancy', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-SER-012', 'Serum beta-hCG (quantitative)', 'Laboratory - Serology & Immunology', 'Pregnancy', 'Per test', 'Core', 200000, 240000, 'Partial', true, true, 'Send-out.'),
  ('LAB-SER-013', 'Prostate specific antigen (PSA)', 'Laboratory - Serology & Immunology', 'Oncology', 'Per test', 'Core', 200000, 240000, 'Covered', true, true, 'Promote in men''s health screening campaigns.'),
  ('LAB-SER-014', 'Troponin I rapid test', 'Laboratory - Serology & Immunology', 'Cardiac', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, 'Stabilise and refer any positive result immediately.'),
  ('LAB-SER-015', 'D-dimer', 'Laboratory - Serology & Immunology', 'Cardiac', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, 'Send-out.'),
  ('LAB-SER-016', 'COVID-19 antigen rapid test', 'Laboratory - Serology & Immunology', 'Respiratory', 'Per test', 'Core', 150000, 180000, 'Partial', true, true, null),
  ('LAB-SER-017', 'Malaria rapid diagnostic test (mRDT)', 'Laboratory - Serology & Immunology', 'Febrile', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, 'Free where government commodity is in stock.'),
  ('LAB-SER-018', 'Dengue NS1 / IgM-IgG rapid test', 'Laboratory - Serology & Immunology', 'Febrile', 'Per test', 'Core', 150000, 180000, 'Partial', true, true, null),
  ('LAB-MIC-001', 'Malaria parasite - blood slide (microscopy)', 'Laboratory - Microbiology & Parasitology', 'Parasitology', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-MIC-002', 'Stool for ova & cysts (microscopy)', 'Laboratory - Microbiology & Parasitology', 'Parasitology', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('LAB-MIC-003', 'Stool occult blood', 'Laboratory - Microbiology & Parasitology', 'Parasitology', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-MIC-004', 'Urinalysis - dipstick & microscopy', 'Laboratory - Microbiology & Parasitology', 'Urinalysis', 'Per test', 'Core', 30000, 35000, 'Covered', true, true, 'Second-highest volume lab line after the haemogram.'),
  ('LAB-MIC-005', 'Urine microscopy, culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 180000, 215000, 'Covered', true, true, '48-72 hr turnaround; set patient expectations at collection.'),
  ('LAB-MIC-006', 'Stool culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 180000, 215000, 'Covered', true, true, null),
  ('LAB-MIC-007', 'High vaginal swab - wet prep & gram stain', 'Laboratory - Microbiology & Parasitology', 'Genital', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-MIC-008', 'High vaginal swab - culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 180000, 215000, 'Covered', true, true, null),
  ('LAB-MIC-009', 'Urethral swab - gram stain', 'Laboratory - Microbiology & Parasitology', 'Genital', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-MIC-010', 'Pus swab - culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 180000, 215000, 'Covered', true, true, null),
  ('LAB-MIC-011', 'Throat swab - culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 180000, 215000, 'Partial', true, true, null),
  ('LAB-MIC-012', 'Blood culture & sensitivity', 'Laboratory - Microbiology & Parasitology', 'Culture', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, null),
  ('LAB-MIC-013', 'Sputum for AAFB / GeneXpert MTB-RIF', 'Laboratory - Microbiology & Parasitology', 'TB', 'Per test', 'Core', 0, 0, 'Free', false, true, 'National TB (NTLD) programme - MUST NOT be charged.'),
  ('LAB-MIC-014', 'Fungal studies - KOH mount / skin snip', 'Laboratory - Microbiology & Parasitology', 'Mycology', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-MIC-015', 'Gram stain (any specimen)', 'Laboratory - Microbiology & Parasitology', 'Microscopy', 'Per test', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('LAB-MIC-016', 'Semen analysis', 'Laboratory - Microbiology & Parasitology', 'Andrology', 'Per test', 'Core', 150000, 180000, 'Partial', true, true, 'Requires a private collection room and 2-7 day abstinence advice.'),
  ('LAB-MIC-017', 'Body fluid analysis (pleural, ascitic, CSF)', 'Laboratory - Microbiology & Parasitology', 'Body Fluids', 'Per test', 'Core', 250000, 300000, 'Partial', true, true, 'Send-out.'),
  ('LAB-MIC-018', 'Sample collection & handling fee (send-out tests)', 'Laboratory - Microbiology & Parasitology', 'Logistics', 'Per specimen', 'Core', 20000, 25000, 'Not covered', true, true, 'Applies only to referred-out specimens.'),
  ('LAB-PKG-001', 'Antenatal profile (Hb, blood group, VDRL, HBsAg, urinalysis, RBS)', 'Laboratory - Panels & Packages', 'Antenatal', 'Per panel', 'Core', 180000, 215000, 'Covered', true, true, 'HIV testing included at no charge. ~25% discount vs. itemised.'),
  ('LAB-PKG-002', 'Basic health screen (haemogram, RBS, urinalysis, BP & BMI)', 'Laboratory - Panels & Packages', 'Wellness', 'Per panel', 'Core', 150000, 180000, 'Partial', true, true, 'Entry-level screening offer for camps and walk-ins.'),
  ('LAB-PKG-003', 'Diabetic profile (FBS, HbA1c, U/E/C, lipid profile, urinalysis)', 'Laboratory - Panels & Packages', 'NCD', 'Per panel', 'Core', 550000, 660000, 'Covered', true, true, 'SHA covers essential diabetic investigations.'),
  ('LAB-PKG-004', 'Cardiac / hypertension profile (U/E/C, lipids, ECG, urinalysis, RBS)', 'Laboratory - Panels & Packages', 'NCD', 'Per panel', 'Conditional - Imaging', 550000, 660000, 'Covered', true, false, 'ECG component requires the cardiology module.'),
  ('LAB-PKG-005', 'Executive wellness profile (comprehensive)', 'Laboratory - Panels & Packages', 'Wellness', 'Per panel', 'Core', 950000, 1140000, 'Not covered', true, true, 'Target corporate and KenGen scheme members.'),
  ('LAB-PKG-006', 'Febrile illness panel (mRDT, haemogram, Widal, urinalysis)', 'Laboratory - Panels & Packages', 'Acute', 'Per panel', 'Core', 150000, 180000, 'Covered', true, true, 'Highest-frequency diagnostic bundle in OPD.'),
  ('LAB-PKG-007', 'STI screen (VDRL, HBsAg, HVS/urethral swab, urinalysis)', 'Laboratory - Panels & Packages', 'STI', 'Per panel', 'Core', 250000, 300000, 'Covered', true, true, 'HIV testing included at no charge.'),
  ('LAB-PKG-008', 'Food handler''s screen (stool O/C, stool C/S, TB screen, VDRL)', 'Laboratory - Panels & Packages', 'Occupational', 'Per panel', 'Core', 250000, 300000, 'Not covered', true, true, 'Excludes the county public health certificate levy.'),
  ('LAB-PKG-009', 'Pre-employment screen + medical report', 'Laboratory - Panels & Packages', 'Occupational', 'Per panel', 'Core', 350000, 420000, 'Not covered', true, true, 'B2B line - price per-contract for volume employers.'),
  ('LAB-PKG-010', 'Child wellness profile (haemogram, stool O/C, urinalysis, nutrition)', 'Laboratory - Panels & Packages', 'Paediatric', 'Per panel', 'Core', 150000, 180000, 'Covered', true, true, null),
  ('LAB-PKG-011', 'Renal profile (U/E/C, uric acid, urinalysis)', 'Laboratory - Panels & Packages', 'Renal', 'Per panel', 'Core', 250000, 300000, 'Covered', true, true, null),
  ('LAB-PKG-012', 'Liver profile (LFT, HBsAg, anti-HCV)', 'Laboratory - Panels & Packages', 'Hepatic', 'Per panel', 'Core', 250000, 300000, 'Covered', true, true, null),
  ('LAB-PKG-013', 'Anaemia workup (haemogram, PBF, stool O/C, ferritin)', 'Laboratory - Panels & Packages', 'Haematology', 'Per panel', 'Core', 350000, 420000, 'Covered', true, true, null),
  ('LAB-PKG-014', 'Male fertility screen (semen analysis + urinalysis)', 'Laboratory - Panels & Packages', 'Andrology', 'Per panel', 'Core', 200000, 240000, 'Not covered', true, true, null),
  ('IMG-001', 'Obstetric ultrasound (dating / growth / wellbeing)', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 200000, 240000, 'Partial', true, false, null),
  ('IMG-002', 'Abdominal ultrasound', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 250000, 300000, 'Partial', true, false, null),
  ('IMG-003', 'Pelvic ultrasound', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 250000, 300000, 'Partial', true, false, null),
  ('IMG-004', 'Abdominopelvic ultrasound (combined)', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 300000, 360000, 'Partial', true, false, null),
  ('IMG-005', 'Soft tissue / thyroid / breast ultrasound', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 250000, 300000, 'Partial', true, false, null),
  ('IMG-006', 'Scrotal ultrasound', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 250000, 300000, 'Partial', true, false, null),
  ('IMG-007', 'Renal / KUB ultrasound', 'Diagnostic Imaging & Cardiology', 'Ultrasound', 'Per scan', 'Conditional - Imaging', 250000, 300000, 'Partial', true, false, null),
  ('IMG-008', 'Duplicate scan report / image copy', 'Diagnostic Imaging & Cardiology', 'Records', 'Per copy', 'Conditional - Imaging', 20000, 25000, 'Not covered', true, false, null),
  ('IMG-009', '12-lead ECG with interpretation', 'Diagnostic Imaging & Cardiology', 'Cardiology', 'Per test', 'Conditional - Imaging', 200000, 240000, 'Covered', true, false, null),
  ('IMG-010', 'Digital X-ray - chest (PA)', 'Diagnostic Imaging & Cardiology', 'Radiography', 'Per film', 'Conditional - Radiology', 150000, 180000, 'Partial', true, false, 'Requires a KNRA radiation licence and a registered radiographer.'),
  ('IMG-011', 'Digital X-ray - limb / extremity', 'Diagnostic Imaging & Cardiology', 'Radiography', 'Per film', 'Conditional - Radiology', 150000, 180000, 'Partial', true, false, 'As above.'),
  ('IMG-012', 'Digital X-ray - additional view', 'Diagnostic Imaging & Cardiology', 'Radiography', 'Per film', 'Conditional - Radiology', 80000, 95000, 'Partial', true, false, null),
  ('DEN-001', 'Dental consultation & examination', 'Dental Services', 'Consultation', 'Per visit', 'Conditional - Dental', 50000, 60000, 'Partial', true, false, null),
  ('DEN-002', 'Simple tooth extraction', 'Dental Services', 'Extraction', 'Per tooth', 'Conditional - Dental', 150000, 180000, 'Covered', true, false, null),
  ('DEN-003', 'Surgical / impacted tooth extraction', 'Dental Services', 'Extraction', 'Per tooth', 'Conditional - Dental', 350000, 420000, 'Partial', true, false, null),
  ('DEN-004', 'Scaling & polishing (full mouth)', 'Dental Services', 'Preventive', 'Per session', 'Conditional - Dental', 300000, 360000, 'Partial', true, false, null),
  ('DEN-005', 'Composite filling', 'Dental Services', 'Restorative', 'Per tooth', 'Conditional - Dental', 250000, 300000, 'Partial', true, false, null),
  ('DEN-006', 'Temporary dressing / sedative filling', 'Dental Services', 'Restorative', 'Per tooth', 'Conditional - Dental', 100000, 120000, 'Partial', true, false, null),
  ('DEN-007', 'Fluoride application / fissure sealant', 'Dental Services', 'Preventive', 'Per tooth', 'Conditional - Dental', 150000, 180000, 'Not covered', true, false, null),
  ('DEN-008', 'Dental abscess drainage', 'Dental Services', 'Emergency', 'Per procedure', 'Conditional - Dental', 200000, 240000, 'Covered', true, false, null),
  ('DEN-009', 'Root canal therapy', 'Dental Services', 'Restorative', 'Per tooth', 'Conditional - Dental', 800000, 960000, 'Not covered', true, false, 'Visiting dentist or referral.'),
  ('CDM-001', 'NCD clinic enrolment & baseline assessment', 'Chronic Disease Management', 'NCD', 'Per patient', 'Core', 100000, 120000, 'Covered', true, true, 'One-off; drives recurring monthly revenue.'),
  ('CDM-002', 'Diabetes follow-up clinic visit (incl. RBS)', 'Chronic Disease Management', 'NCD', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('CDM-003', 'Hypertension follow-up clinic visit (incl. BP)', 'Chronic Disease Management', 'NCD', 'Per visit', 'Core', 50000, 60000, 'Covered', true, true, null),
  ('CDM-004', 'Asthma / COPD review', 'Chronic Disease Management', 'Respiratory', 'Per visit', 'Core', 70000, 85000, 'Covered', true, true, null),
  ('CDM-005', 'HIV care & treatment (CCC) follow-up', 'Chronic Disease Management', 'HIV', 'Per visit', 'Core', 0, 0, 'Free', false, true, 'Programme-funded - MUST NOT be charged.'),
  ('CDM-006', 'TB treatment follow-up (NTLD programme)', 'Chronic Disease Management', 'TB', 'Per visit', 'Core', 0, 0, 'Free', false, true, 'Programme-funded - MUST NOT be charged.'),
  ('CDM-007', 'Diabetic foot assessment & dressing', 'Chronic Disease Management', 'NCD', 'Per session', 'Core', 100000, 120000, 'Covered', true, true, null),
  ('CDM-008', 'Health education / lifestyle counselling session', 'Chronic Disease Management', 'Education', 'Per session', 'Core', 30000, 35000, 'Covered', true, true, null),
  ('CDM-009', 'Mental health screening & brief counselling', 'Chronic Disease Management', 'Mental Health', 'Per session', 'Core', 100000, 120000, 'Partial', true, true, 'Refer complex cases to a Level 4/5 mental health unit.'),
  ('CDM-010', 'Substance use screening & referral', 'Chronic Disease Management', 'Mental Health', 'Per session', 'Core', 50000, 60000, 'Partial', true, true, null),
  ('PHA-001', 'Dispensing fee - external prescription', 'Pharmacy Interface', 'Dispensing', 'Per prescription', 'Core', 10000, 10000, 'Not covered', true, true, 'Waived for prescriptions generated in VITCARE-CLINIC.'),
  ('PHA-002', 'Medication counselling / adherence session', 'Pharmacy Interface', 'Clinical', 'Per session', 'Core', 0, 0, 'Free', false, true, 'Value-add; drives pharmacy loyalty.'),
  ('PHA-003', 'Supervised drug administration (excl. drug)', 'Pharmacy Interface', 'Administration', 'Per dose', 'Core', 20000, 25000, 'Covered', true, true, null),
  ('PHA-004', 'Prescription refill authorisation / re-issue', 'Pharmacy Interface', 'Dispensing', 'Per prescription', 'Core', 20000, 25000, 'Not covered', true, true, 'Requires clinician review in the EMR.'),
  ('PHA-005', 'Medicines, consumables & medical devices', 'Pharmacy Interface', 'Dispensing', 'Per item', 'Core', 0, 0, 'Partial', false, true, 'PRICED IN VITCARE-POS - not in this catalogue. Do not double-maintain.'),
  ('OCC-001', 'Pre-employment medical examination & report', 'Occupational Health & Certification', 'Examination', 'Per person', 'Core', 350000, 420000, 'Not covered', true, true, 'Discount to 2,500 for contracts above 20 staff.'),
  ('OCC-002', 'Periodic / annual occupational medical examination', 'Occupational Health & Certification', 'Examination', 'Per person', 'Core', 300000, 360000, 'Not covered', true, true, null),
  ('OCC-003', 'Food handler''s medical certificate (excl. county levy)', 'Occupational Health & Certification', 'Certification', 'Per person', 'Core', 250000, 300000, 'Not covered', true, true, 'County public health levy paid separately by the client.'),
  ('OCC-004', 'Driving licence medical examination', 'Occupational Health & Certification', 'Certification', 'Per person', 'Core', 200000, 240000, 'Not covered', true, true, null),
  ('OCC-005', 'Insurance medical examination & report', 'Occupational Health & Certification', 'Examination', 'Per person', 'Core', 350000, 420000, 'Not covered', true, true, null),
  ('OCC-006', 'Sick-off / fitness-to-work certificate', 'Occupational Health & Certification', 'Documentation', 'Per certificate', 'Core', 30000, 35000, 'Not covered', true, true, 'Free when issued during a paid consultation.'),
  ('OCC-007', 'Detailed medical report on request', 'Occupational Health & Certification', 'Documentation', 'Per report', 'Core', 200000, 240000, 'Not covered', true, true, null),
  ('OCC-008', 'P3 form completion', 'Occupational Health & Certification', 'Documentation', 'Per form', 'Core', 0, 0, 'Free', false, true, 'Statutory - MUST NOT be charged.'),
  ('OCC-009', 'School / college entry medical examination', 'Occupational Health & Certification', 'Examination', 'Per person', 'Core', 150000, 180000, 'Not covered', true, true, 'Seasonal - January and September peaks.'),
  ('OCC-010', 'Corporate staff medical camp - per head (min. 30 pax)', 'Occupational Health & Certification', 'Corporate', 'Per person', 'Core', 150000, 180000, 'Not covered', true, true, null),
  ('OCC-011', 'Travel / visa medical examination', 'Occupational Health & Certification', 'Examination', 'Per person', 'Core', 350000, 420000, 'Not covered', true, true, 'Excludes gazetted yellow fever certification.'),
  ('ADM-001', 'Duplicate copy of laboratory results', 'Records & Administration', 'Records', 'Per copy', 'Core', 10000, 10000, 'Not covered', true, true, null),
  ('ADM-002', 'Replacement of lost patient card', 'Records & Administration', 'Records', 'Per card', 'Core', 10000, 10000, 'Not covered', true, true, null),
  ('ADM-003', 'Medical records retrieval / photocopy', 'Records & Administration', 'Records', 'Per page', 'Core', 2000, 2000, 'Not covered', true, true, null),
  ('ADM-004', 'Electronic results delivery (SMS / email / portal)', 'Records & Administration', 'Digital', 'Per result', 'Core', 0, 0, 'Free', false, true, 'Differentiator against paper-only competitors.'),
  ('ADM-005', 'SHA / private insurance claim processing', 'Records & Administration', 'Claims', 'Per claim', 'Core', 0, 0, 'Free', false, true, 'Never charged to the patient.'),
  ('ADM-006', 'Refill & appointment SMS reminder service', 'Records & Administration', 'Digital', 'Per patient/month', 'Core', 0, 0, 'Free', false, true, 'Retention tooling; cost carried by the facility.'),
  ('OUT-001', 'Medical camp - basic screening per participant', 'Community Outreach & Corporate', 'Camps', 'Per person', 'Core', 50000, 60000, 'Not covered', true, true, 'Often sponsored; bill the sponsor, not the participant.'),
  ('OUT-002', 'School health screening - per learner', 'Community Outreach & Corporate', 'Schools', 'Per learner', 'Core', 30000, 35000, 'Not covered', true, true, null),
  ('OUT-003', 'Corporate wellness day - per site (up to 50 staff)', 'Community Outreach & Corporate', 'Corporate', 'Per event', 'Core', 6000000, 7200000, 'Not covered', true, true, 'Quote per scope; includes screening, labs and a summary report.'),
  ('OUT-004', 'Health talk / CME session', 'Community Outreach & Corporate', 'Corporate', 'Per session', 'Core', 1500000, 1800000, 'Not covered', true, true, null),
  ('OUT-005', 'Workplace first-aid training', 'Community Outreach & Corporate', 'Corporate', 'Per group', 'Core', 2500000, 3000000, 'Not covered', true, true, 'Requires a certified trainer.')
) as v (
  code, name, category, sub_category, unit, module,
  cash_price_cents, insurance_price_cents, sha_phc_status,
  billable, active, billing_notes
)
on conflict (site_id, code) do nothing;
