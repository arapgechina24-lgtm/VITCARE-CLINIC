import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_NOTE, SECTIONS, noteIsEmpty, parseNote, serializeNote,
  type ConsultNote,
} from './consult-note';

const note = (over: Partial<ConsultNote> = {}): ConsultNote => ({ ...EMPTY_NOTE, ...over });

describe('round trip', () => {
  test('anything written is read back identically', () => {
    const original = note({
      Subjective: 'Cough for 3 days, no fever.\nNo sputum.',
      Objective: 'Chest clear. Temp 36.8.',
      Assessment: 'Viral URTI',
      Plan: 'Symptomatic. Review if worse in 5 days.',
    });
    assert.deepEqual(parseNote(serializeNote(original)), original);
  });

  test('a partly filled note round-trips without inventing sections', () => {
    const original = note({ Assessment: 'Malaria, confirmed on mRDT.', Plan: 'AL per weight.' });
    const text = serializeNote(original);
    assert.doesNotMatch(text, /Subjective/);
    assert.deepEqual(parseNote(text), original);
  });

  test('an empty note serialises to nothing and parses back to nothing', () => {
    assert.equal(serializeNote(EMPTY_NOTE), '');
    assert.deepEqual(parseNote(''), EMPTY_NOTE);
    assert.deepEqual(parseNote(null), EMPTY_NOTE);
    assert.equal(noteIsEmpty(EMPTY_NOTE), true);
    assert.equal(noteIsEmpty(note({ Plan: 'x' })), false);
    assert.equal(noteIsEmpty(note({ Plan: '   ' })), true);
  });
});

describe('parsing', () => {
  test('a heading is only a heading when it is alone on its line', () => {
    // "review the assessment in a week" must not split the note in two.
    const parsed = parseNote('Assessment\nAsthma\n\nPlan\nReview the assessment in a week.');
    assert.equal(parsed.Assessment, 'Asthma');
    assert.equal(parsed.Plan, 'Review the assessment in a week.');
  });

  test('a legacy free-text note becomes the assessment', () => {
    // It was typed into a box labelled "Assessment / diagnosis", so that is
    // what it is. Anything else would relabel a clinical record after the fact.
    const parsed = parseNote('Suspected typhoid, started on ciprofloxacin.');
    assert.equal(parsed.Assessment, 'Suspected typhoid, started on ciprofloxacin.');
    assert.equal(parsed.Subjective, '');
  });

  test('legacy text alongside sections keeps its position at the front', () => {
    const parsed = parseNote('Old note.\n\nAssessment\nNewer finding.');
    assert.equal(parsed.Assessment, 'Old note.\n\nNewer finding.');
  });

  test('tolerates CRLF and trailing whitespace on headings', () => {
    const parsed = parseNote('Subjective  \r\nHeadache\r\n\r\nPlan\r\nParacetamol');
    assert.equal(parsed.Subjective, 'Headache');
    assert.equal(parsed.Plan, 'Paracetamol');
  });

  test('blank lines inside a section are preserved', () => {
    const parsed = parseNote('Plan\nFirst line.\n\nSecond paragraph.');
    assert.equal(parsed.Plan, 'First line.\n\nSecond paragraph.');
  });

  test('every section is always present, so the form never reads undefined', () => {
    const parsed = parseNote('Assessment\nx');
    for (const s of SECTIONS) assert.equal(typeof parsed[s], 'string');
  });
});
