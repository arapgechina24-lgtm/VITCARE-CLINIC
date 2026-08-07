/**
 * Checking a prescribed drug against a patient's recorded allergies.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
 * This is decision SUPPORT. It raises a prompt for a human to judge. It is not
 * a safety interlock and must never be presented as one, because it cannot be
 * one: there is no drug dictionary in this system, allergies are free text, and
 * the cross-reactivity table below is a deliberately small hand-written list,
 * not a pharmacological knowledge base.
 *
 * The dangerous failure is not a missed match — it is a missed match displayed
 * as reassurance. A checker that says "no conflicts" while silently failing to
 * connect a penicillin allergy to amoxicillin is WORSE than no checker, because
 * it manufactures confidence. So `check()` reports what it compared and how
 * many allergies it knew about, and the UI is required to state the limits
 * rather than print a green tick.
 *
 * ── WHY NOT SUBSTRING MATCHING ────────────────────────────────────────────
 * The obvious implementation — `drug.includes(allergy) || allergy.includes(drug)`
 * — fails in both directions, and both failures are clinical:
 *
 *   · "amoxicillin".includes("penicillin") is FALSE. A patient with a recorded
 *     penicillin allergy would be handed amoxicillin with no warning at all.
 *     That is the single most common serious drug-allergy event in primary
 *     care, and plain string matching cannot see it. Hence CROSS_REACTIVITY.
 *
 *   · "asacol".includes("asa") is TRUE. An aspirin allergy recorded as "ASA"
 *     would fire on mesalazine, which is unrelated. Enough false alarms and
 *     clinicians click through every one of them, including the real ones —
 *     alert fatigue is itself a documented cause of patient harm. Hence the
 *     token rules and the four-character floor on stem matching.
 */

export type AllergyStatus = 'UNRECORDED' | 'NONE_KNOWN' | 'PRESENT';
export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE';

export interface RecordedAllergy {
  id?: string;
  substance: string;
  reaction?: string | null;
  severity?: AllergySeverity | null;
}

export type ConflictKind =
  /** The prescribed name and the recorded substance are the same thing. */
  | 'direct'
  /** Different drugs that share a class known to cross-react. */
  | 'class';

export interface AllergyConflict {
  allergy: RecordedAllergy;
  kind: ConflictKind;
  /** The class that links them, for a `class` conflict. */
  via?: string;
  /** Plain-language reason, shown to the clinician. */
  explanation: string;
}

/**
 * Drug classes whose members cross-react, keyed by class name.
 *
 * NON-EXHAUSTIVE AND KNOWN TO BE SO. It covers the classes that account for
 * most serious allergy events in Kenyan primary care. It is not a substitute
 * for a formulary, and a drug absent from it is not thereby safe.
 *
 * Cephalosporins are deliberately a SEPARATE class from penicillins. They do
 * cross-react, but at a low single-digit rate that modern evidence has revised
 * downward considerably. Linking them would fire on a large share of antibiotic
 * prescriptions, and an alert that cries wolf gets dismissed reflexively —
 * including on the penicillin match that matters. If a prescriber wants that
 * link they can record the allergy as "beta-lactam", which sits in both.
 */
export const CROSS_REACTIVITY: Readonly<Record<string, readonly string[]>> = {
  penicillin: [
    'penicillin', 'benzylpenicillin', 'phenoxymethylpenicillin', 'amoxicillin',
    'amoxycillin', 'ampicillin', 'cloxacillin', 'flucloxacillin', 'dicloxacillin',
    'piperacillin', 'ticarcillin',
    // Brands, because that is how they are written on a Kenyan prescription and
    // how a patient reports the drug that gave them a rash. Amoxil is not a
    // stem-match for amoxicillin ("amoxicillin".startsWith("amoxil") is false),
    // so leaving it out meant an allergy recorded as "Amoxil" silently failed
    // to flag amoxicillin. Ampiclox is ampicillin + cloxacillin.
    'augmentin', 'amoxiclav', 'coamoxiclav', 'amoxil', 'ampiclox',
    'betalactam', 'penicillins',
  ],
  cephalosporin: [
    'cephalosporin', 'cefalexin', 'cephalexin', 'cefuroxime', 'ceftriaxone',
    'cefixime', 'cefotaxime', 'ceftazidime', 'cefazolin', 'cefaclor', 'betalactam',
  ],
  sulfonamide: [
    'sulfonamide', 'sulphonamide', 'sulfa', 'sulpha', 'sulfamethoxazole',
    'sulphamethoxazole', 'cotrimoxazole', 'septrin', 'septran', 'bactrim',
    'sulfadoxine', 'sulfasalazine', 'sulfadiazine',
  ],
  nsaid: [
    'nsaid', 'nsaids', 'aspirin', 'acetylsalicylic', 'asa', 'ibuprofen', 'brufen',
    'diclofenac', 'voltaren', 'naproxen', 'indomethacin', 'piroxicam', 'meloxicam',
    'ketoprofen', 'celecoxib',
  ],
  macrolide: ['macrolide', 'erythromycin', 'azithromycin', 'clarithromycin'],
  quinolone: [
    'quinolone', 'fluoroquinolone', 'ciprofloxacin', 'levofloxacin',
    'norfloxacin', 'ofloxacin', 'moxifloxacin',
  ],
  tetracycline: ['tetracycline', 'doxycycline', 'minocycline', 'oxytetracycline'],
};

/**
 * Shortest allergy token that may match a longer drug name by prefix.
 *
 * Four, because "sulfa" (5) must reach "sulfamethoxazole" while "ASA" (3) must
 * NOT reach "Asacol". Lowering this re-opens the false-alarm problem; raising
 * it drops "sulfa" itself.
 */
const MIN_STEM_LENGTH = 4;

/** Words that carry no identity and would otherwise match everything. */
const STOPWORDS = new Set([
  'tablet', 'tablets', 'capsule', 'capsules', 'syrup', 'suspension', 'injection',
  'cream', 'drops', 'oral', 'iv', 'im', 'mg', 'ml', 'g', 'and', 'the', 'drug', 'drugs',
]);

/** Lowercase, split on anything that is not a letter, drop noise. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Collapsed spelling used for class lookup — "co-trimoxazole" → "cotrimoxazole". */
function collapse(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The classes a name belongs to.
 *
 * Matches a class member against the whole collapsed name AND against each
 * token, so both "Co-trimoxazole" and "Septrin Forte 960mg" resolve.
 */
export function classesOf(name: string): string[] {
  const whole = collapse(name);
  const tokens = tokenize(name);
  const found: string[] = [];

  for (const [className, members] of Object.entries(CROSS_REACTIVITY)) {
    const hit = members.some(
      (m) =>
        whole === m ||
        tokens.includes(m) ||
        // Stem match: "amoxicillin500" → "amoxicillin". Guarded by length so
        // short members like "asa" cannot latch onto unrelated words.
        (m.length >= MIN_STEM_LENGTH && (whole.startsWith(m) || tokens.some((t) => t.startsWith(m)))),
    );
    if (hit) found.push(className);
  }
  return found;
}

/** True when a recorded substance names the same drug as the prescribed name. */
function directlyMatches(substance: string, drugName: string): boolean {
  const aTokens = tokenize(substance);
  const dTokens = tokenize(drugName);
  if (aTokens.length === 0 || dTokens.length === 0) return false;

  return aTokens.some((a) =>
    dTokens.some(
      (d) =>
        a === d ||
        // Prefix only, and only for tokens long enough to be a drug stem.
        (a.length >= MIN_STEM_LENGTH && d.startsWith(a)) ||
        (d.length >= MIN_STEM_LENGTH && a.startsWith(d)),
    ),
  );
}

export interface CheckInput {
  /** As typed on the prescription. */
  drugName: string;
  /** The generic name, when known. Checked as well as the brand. */
  genericName?: string | null;
}

export interface CheckResult {
  conflicts: AllergyConflict[];
  /** How many recorded allergies were compared. Shown so "none found" can be
   *  read as "none found among these N", never as "safe". */
  comparedAgainst: number;
}

/**
 * Compares one prescribed drug against every recorded allergy.
 *
 * A direct match outranks a class match for the same allergy — reporting both
 * would show a clinician two warnings about one fact.
 */
export function checkDrug(input: CheckInput, allergies: readonly RecordedAllergy[]): CheckResult {
  const names = [input.drugName, input.genericName ?? ''].filter((n) => n.trim().length > 0);
  const drugClasses = new Set(names.flatMap(classesOf));
  const conflicts: AllergyConflict[] = [];

  for (const allergy of allergies) {
    if (!allergy.substance?.trim()) continue;

    if (names.some((n) => directlyMatches(allergy.substance, n))) {
      conflicts.push({
        allergy,
        kind: 'direct',
        explanation: `${input.drugName} matches the recorded allergy to ${allergy.substance}.`,
      });
      continue;
    }

    const shared = classesOf(allergy.substance).find((c) => drugClasses.has(c));
    if (shared) {
      conflicts.push({
        allergy,
        kind: 'class',
        via: shared,
        explanation:
          `${input.drugName} is ${article(shared)} ${shared}, the same class as the recorded ` +
          `allergy to ${allergy.substance}. Drugs in this class can cross-react.`,
      });
    }
  }

  return { conflicts, comparedAgainst: allergies.length };
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/* ── Prescription-level gate ────────────────────────────────────────────── */

export interface PrescriptionGate {
  /** Sending is impossible until this clears. Not overridable. */
  blocked: boolean;
  /** Why, in words a clinician can act on. Null when nothing blocks. */
  reason: string | null;
  /** Item indices with an unacknowledged conflict. */
  needsOverride: number[];
}

/**
 * Whether this prescription may be sent.
 *
 * Two different kinds of stop, and the difference matters:
 *
 *   · UNRECORDED is NOT overridable. There is no clinical judgement to exercise
 *     about information nobody has gathered — the answer is to go and ask. The
 *     database enforces this too (assert_allergies_reviewed).
 *
 *   · A conflict IS overridable, because prescribing despite a known allergy is
 *     sometimes correct and the prescriber is the one who can weigh it. The
 *     override is per item, deliberate, and recorded.
 */
export function evaluateGate(
  status: AllergyStatus,
  itemConflicts: readonly AllergyConflict[][],
  acknowledged: readonly boolean[],
): PrescriptionGate {
  if (status === 'UNRECORDED') {
    return {
      blocked: true,
      reason:
        "This patient's allergies have never been recorded. Ask, then record the answer — " +
        'including "no known allergies" — before prescribing.',
      needsOverride: [],
    };
  }

  const needsOverride = itemConflicts
    .map((conflicts, i) => (conflicts.length > 0 && !acknowledged[i] ? i : -1))
    .filter((i) => i >= 0);

  if (needsOverride.length > 0) {
    return {
      blocked: true,
      reason:
        needsOverride.length === 1
          ? 'One item conflicts with a recorded allergy. Confirm it before sending.'
          : `${needsOverride.length} items conflict with recorded allergies. Confirm them before sending.`,
      needsOverride,
    };
  }

  return { blocked: false, reason: null, needsOverride: [] };
}

/**
 * The line appended to the prescription note when a conflict is overridden.
 *
 * It goes to the pharmacy as well as into the record, on purpose: a pharmacist
 * handing over a drug the patient is documented as reacting to should be able
 * to see that the prescriber knew, rather than having to phone and ask.
 */
export function overrideNote(drugName: string, conflicts: readonly AllergyConflict[]): string {
  const substances = [...new Set(conflicts.map((c) => c.allergy.substance))].join(', ');
  return `[ALLERGY OVERRIDE] ${drugName} prescribed despite recorded allergy to ${substances} — prescriber assessed the risk.`;
}
