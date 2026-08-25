import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_LABEL, auditContext, auditKind, auditRange, describeAuditEntry,
} from './audit';

describe('auditKind', () => {
  test('separates reads, writes and domain events', () => {
    assert.equal(auditKind('SELECT'), 'read');
    for (const a of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(auditKind(a), 'write');
    assert.equal(auditKind('prescription.out_of_stock'), 'event');
  });
});

describe('describeAuditEntry', () => {
  test('turns a recorded function name into something a manager can read', () => {
    assert.equal(
      describeAuditEntry({ action: 'SELECT', table_name: 'patients', details: { fn: 'get_patient_record' } }),
      'Opened a patient record',
    );
    assert.equal(
      describeAuditEntry({ action: 'INSERT', table_name: 'prescriptions', details: { fn: 'submit_prescription' } }),
      'Issued a prescription',
    );
  });

  test('reads a domain event out of the action itself', () => {
    // These come from the POS status webhook, not from an RPC, so there is no
    // `fn` to look up.
    assert.equal(
      describeAuditEntry({ action: 'prescription.out_of_stock', table_name: 'prescriptions', details: null }),
      'Prescription — out of stock',
    );
  });

  test('falls back to the raw action rather than inventing a label', () => {
    // The important property: an entry this file does not recognise is still
    // shown truthfully. Silently prettifying an unknown audit row would be a
    // rendering layer editing the record.
    assert.equal(
      describeAuditEntry({ action: 'UPDATE', table_name: 'invoice_items', details: { fn: 'something_new' } }),
      'Changed invoice items',
    );
    assert.equal(
      describeAuditEntry({ action: 'UPDATE', table_name: 'invoices', details: null }),
      'Changed invoices',
    );
  });

  test('an unmapped action verb passes through unchanged', () => {
    assert.equal(
      describeAuditEntry({ action: 'TRUNCATE', table_name: 'audit_log', details: null }),
      'TRUNCATE audit log',
    );
    assert.equal(ACTION_LABEL.SELECT, 'Viewed');
  });
});

describe('auditContext', () => {
  test('surfaces the search term that was actually used', () => {
    assert.equal(auditContext({ details: { fn: 'list_patients', search: 'wanjiku' } }), '“wanjiku”');
  });

  test('shows both sides of a role change', () => {
    assert.equal(
      auditContext({ details: { fn: 'set_user_role', subject: 'Paul Njenga', from: 'RECEPTIONIST', to: 'NURSE' } }),
      'Paul Njenga · RECEPTIONIST → NURSE',
    );
  });

  test('says which way a module was switched', () => {
    assert.equal(
      auditContext({ details: { fn: 'set_service_module_active', module: 'Conditional - Dental', active: true } }),
      'Dental · switched on',
    );
    assert.equal(
      auditContext({ details: { module: 'Conditional - Radiology', active: false } }),
      'Radiology · switched off',
    );
  });

  test('distinguishes a licence recorded from one cleared', () => {
    assert.equal(
      auditContext({ details: { subject: 'John Kariuki Waweru', had_licence: false, has_licence: true } }),
      'John Kariuki Waweru · licence recorded',
    );
    assert.equal(
      auditContext({ details: { subject: 'John Kariuki Waweru', had_licence: true, has_licence: false } }),
      'John Kariuki Waweru · licence cleared',
    );
  });

  test('is empty when there is nothing worth adding', () => {
    assert.equal(auditContext({ details: null }), '');
    assert.equal(auditContext({ details: { fn: 'list_encounters', site_id: 'x' } }), '');
  });

  test('ignores a blank or non-string value rather than printing it', () => {
    assert.equal(auditContext({ details: { search: '' } }), '');
    assert.equal(auditContext({ details: { search: 42 } }), '');
  });
});

describe('auditRange', () => {
  test('"everything" applies no bounds at all', () => {
    assert.deepEqual(auditRange('all'), { from: null, to: null });
  });

  test('today is a single clinic day, and the window is half-open', () => {
    const r = auditRange('today');
    assert.ok(r.from && r.to);
    const hours = (Date.parse(r.to!) - Date.parse(r.from!)) / 3_600_000;
    assert.equal(hours, 24);
  });

  test('7 and 30 day windows span the right number of clinic days', () => {
    for (const [preset, days] of [['7d', 7], ['30d', 30]] as const) {
      const r = auditRange(preset);
      const hours = (Date.parse(r.to!) - Date.parse(r.from!)) / 3_600_000;
      assert.equal(hours, days * 24, preset);
    }
  });

  test('the window ends at the end of the clinic day, not "now"', () => {
    // A log written at 16:00 must still fall inside "today" — an upper bound of
    // the current instant would hide the most recent entries, which on an audit
    // screen looks exactly like tampering.
    const r = auditRange('today');
    assert.ok(Date.parse(r.to!) > Date.now());
  });
});
