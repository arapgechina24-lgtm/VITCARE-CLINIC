/**
 * Tests for drug-allergy checking.
 *
 * Two failure modes are being defended against, and they pull in opposite
 * directions. Missing a real conflict can kill a patient. Firing on unrelated
 * drugs trains clinicians to dismiss every alert, including the real one — and
 * that kills patients too, more quietly. Nearly every case below pins one side
 * or the other.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDrug, classesOf, tokenize, evaluateGate, overrideNote,
  type RecordedAllergy,
} from './allergy-check';

const allergy = (substance: string, over: Partial<RecordedAllergy> = {}): RecordedAllergy => ({
  substance,
  severity: 'SEVERE',
  ...over,
});

describe('tokenize', () => {
  test('splits on punctuation and lowercases', () => {
    assert.deepEqual(tokenize('Co-Trimoxazole'), ['co', 'trimoxazole']);
  });

  test('drops dosage-form noise that would otherwise match everything', () => {
    assert.deepEqual(tokenize('Amoxicillin 500mg Capsules'), ['amoxicillin']);
  });

  test('drops single letters', () => {
    assert.deepEqual(tokenize('Vitamin B'), ['vitamin']);
  });
});

describe('classesOf', () => {
  test('places amoxicillin in the penicillin class', () => {
    assert.deepEqual(classesOf('Amoxicillin'), ['penicillin']);
  });

  test('recognises a brand name', () => {
    assert.deepEqual(classesOf('Augmentin 625'), ['penicillin']);
  });

  test('recognises a hyphenated spelling', () => {
    assert.deepEqual(classesOf('Co-trimoxazole'), ['sulfonamide']);
  });

  test('beta-lactam sits in both penicillin and cephalosporin', () => {
    // The escape hatch for a prescriber who wants the broader warning.
    const classes = classesOf('beta-lactam');
    assert.ok(classes.includes('penicillin'));
    assert.ok(classes.includes('cephalosporin'));
  });

  test('cephalosporins are NOT in the penicillin class', () => {
    // Deliberate. Cross-reactivity is low single-digit; linking them would fire
    // on a large share of antibiotic prescriptions and train clinicians to
    // dismiss the penicillin alert that actually matters.
    assert.deepEqual(classesOf('Ceftriaxone'), ['cephalosporin']);
  });

  test('an unknown drug belongs to no class', () => {
    assert.deepEqual(classesOf('Metformin'), []);
  });
});

describe('checkDrug — the matches that must not be missed', () => {
  test('PENICILLIN ALLERGY → AMOXICILLIN is caught', () => {
    // The case that motivates the whole cross-reactivity table. Plain substring
    // matching returns false here: "amoxicillin".includes("penicillin") is
    // false, and a patient would be handed it with no warning at all.
    const { conflicts } = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'class');
    assert.equal(conflicts[0].via, 'penicillin');
  });

  test('penicillin allergy → Augmentin is caught by brand name', () => {
    const { conflicts } = checkDrug({ drugName: 'Augmentin 625mg' }, [allergy('penicillin')]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].via, 'penicillin');
  });

  test('"sulfa" allergy → Cotrimoxazole is caught', () => {
    const { conflicts } = checkDrug({ drugName: 'Cotrimoxazole' }, [allergy('Sulfa')]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].via, 'sulfonamide');
  });

  test('"sulfa" allergy → Sulfamethoxazole is caught by stem', () => {
    const { conflicts } = checkDrug({ drugName: 'Sulfamethoxazole' }, [allergy('sulfa')]);
    assert.equal(conflicts.length, 1);
  });

  test('aspirin allergy → Ibuprofen is caught as an NSAID', () => {
    const { conflicts } = checkDrug({ drugName: 'Ibuprofen' }, [allergy('Aspirin')]);
    assert.equal(conflicts[0].via, 'nsaid');
  });

  test('an exact name match is reported as direct, not class', () => {
    const { conflicts } = checkDrug({ drugName: 'Amoxicillin' }, [allergy('amoxicillin')]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'direct');
  });

  test('one allergy never produces both a direct and a class conflict', () => {
    // Two warnings about one fact is how a screen becomes noise.
    const { conflicts } = checkDrug({ drugName: 'Amoxicillin 500mg' }, [allergy('Amoxicillin')]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'direct');
  });

  test('the generic name is checked as well as the brand', () => {
    // The clinician typed a brand the table has never heard of; the catalogue
    // knows what it actually is.
    const { conflicts } = checkDrug(
      { drugName: 'Betamox', genericName: 'Amoxicillin' },
      [allergy('Penicillin')],
    );
    assert.equal(conflicts.length, 1);
  });

  test('case and spacing are irrelevant', () => {
    assert.equal(checkDrug({ drugName: '  AMOXICILLIN  ' }, [allergy('penicillin')]).conflicts.length, 1);
  });

  test('every conflicting allergy is reported, not just the first', () => {
    const { conflicts } = checkDrug({ drugName: 'Amoxicillin' }, [
      allergy('Penicillin'),
      allergy('Amoxil'),
    ]);
    assert.equal(conflicts.length, 2);
  });

  test('a brand-name allergy flags the generic it contains', () => {
    // "amoxicillin".startsWith("amoxil") is false, so this can only work
    // through the class table — which is why common brands belong in it.
    assert.equal(checkDrug({ drugName: 'Amoxicillin' }, [allergy('Amoxil')]).conflicts.length, 1);
    assert.equal(checkDrug({ drugName: 'Ampiclox' }, [allergy('penicillin')]).conflicts.length, 1);
  });
});

describe('checkDrug — the false alarms that must not fire', () => {
  test('an "ASA" allergy does NOT fire on Asacol', () => {
    // The three-character floor. Substring matching gets this wrong, and enough
    // wrong alerts trains clinicians to click through the right ones.
    const { conflicts } = checkDrug({ drugName: 'Asacol' }, [allergy('ASA')]);
    assert.deepEqual(conflicts, []);
  });

  test('a penicillin allergy does NOT fire on Paracetamol', () => {
    assert.deepEqual(checkDrug({ drugName: 'Paracetamol' }, [allergy('Penicillin')]).conflicts, []);
  });

  test('a penicillin allergy does NOT fire on Ceftriaxone', () => {
    assert.deepEqual(checkDrug({ drugName: 'Ceftriaxone' }, [allergy('Penicillin')]).conflicts, []);
  });

  test('a dosage form in the drug name does not match a dosage form in the allergy', () => {
    // Without stopwords, "…tablets" against "…tablets" is a match on nothing.
    assert.deepEqual(
      checkDrug({ drugName: 'Metformin 500mg tablets' }, [allergy('Penicillin tablets')]).conflicts,
      [],
    );
  });

  test('an empty or whitespace substance is skipped, not matched', () => {
    assert.deepEqual(checkDrug({ drugName: 'Amoxicillin' }, [allergy('   ')]).conflicts, []);
  });

  test('an empty drug name matches nothing', () => {
    assert.deepEqual(checkDrug({ drugName: '' }, [allergy('Penicillin')]).conflicts, []);
  });

  test('no recorded allergies means no conflicts', () => {
    const result = checkDrug({ drugName: 'Amoxicillin' }, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.comparedAgainst, 0);
  });

  test('reports how many allergies were compared', () => {
    // So the UI can say "none found among these 3" rather than implying safety.
    const result = checkDrug({ drugName: 'Metformin' }, [allergy('a'), allergy('Penicillin'), allergy('Sulfa')]);
    assert.equal(result.comparedAgainst, 3);
  });
});

describe('evaluateGate', () => {
  test('UNRECORDED blocks, and offers nothing to override', () => {
    const gate = evaluateGate('UNRECORDED', [[]], [false]);
    assert.equal(gate.blocked, true);
    assert.deepEqual(gate.needsOverride, []);
    assert.match(gate.reason ?? '', /never been recorded/);
  });

  test('UNRECORDED blocks even with no conflicts at all', () => {
    // The point of the state: absence of a conflict is not evidence of safety
    // when nobody has asked.
    assert.equal(evaluateGate('UNRECORDED', [[], []], [true, true]).blocked, true);
  });

  test('NONE_KNOWN with no conflicts lets the prescription through', () => {
    assert.equal(evaluateGate('NONE_KNOWN', [[]], [false]).blocked, false);
  });

  test('an unacknowledged conflict blocks and names the item', () => {
    const conflict = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]).conflicts;
    const gate = evaluateGate('PRESENT', [[], conflict], [false, false]);
    assert.equal(gate.blocked, true);
    assert.deepEqual(gate.needsOverride, [1]);
  });

  test('acknowledging the conflict clears the block', () => {
    const conflict = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]).conflicts;
    assert.equal(evaluateGate('PRESENT', [conflict], [true]).blocked, false);
  });

  test('acknowledging one item does not clear another', () => {
    const c = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]).conflicts;
    const gate = evaluateGate('PRESENT', [c, c], [true, false]);
    assert.equal(gate.blocked, true);
    assert.deepEqual(gate.needsOverride, [1]);
  });

  test('the message counts the items, singular and plural', () => {
    const c = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]).conflicts;
    assert.match(evaluateGate('PRESENT', [c], [false]).reason ?? '', /^One item/);
    assert.match(evaluateGate('PRESENT', [c, c], [false, false]).reason ?? '', /^2 items/);
  });
});

describe('overrideNote', () => {
  test('names the drug and the substance, for the pharmacist as well as the record', () => {
    const conflicts = checkDrug({ drugName: 'Amoxicillin' }, [allergy('Penicillin')]).conflicts;
    const note = overrideNote('Amoxicillin', conflicts);
    assert.match(note, /ALLERGY OVERRIDE/);
    assert.match(note, /Amoxicillin/);
    assert.match(note, /Penicillin/);
  });

  test('lists each distinct substance once', () => {
    const conflicts = checkDrug({ drugName: 'Amoxicillin' }, [
      allergy('Penicillin'),
      allergy('Penicillin'),
      allergy('Amoxil'),
    ]).conflicts;
    const note = overrideNote('Amoxicillin', conflicts);
    assert.equal(note.match(/Penicillin/g)?.length, 1);
    assert.match(note, /Amoxil/);
  });
});
