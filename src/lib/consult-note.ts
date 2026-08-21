/**
 * Consultation notes, in sections.
 *
 * ── WHY THIS IS A PARSER AND NOT A COLUMN ──────────────────────────────────
 * The obvious move is four columns on `encounters`. This deliberately does not
 * do that, for one reason: `clinical_notes` is already read by
 * get_patient_record, projected by role in 0013, and shown on the chart, the
 * patient record and the prescribing screen. Splitting it into four would mean
 * every one of those readers has to be changed in step or start showing an
 * empty note — and 0014 exists precisely because this schema has drifted
 * before, silently, in a way only a disaster-recovery replay would have
 * revealed.
 *
 * So the note stays ONE text field, which every existing reader already
 * handles, and gains a structure the clinician can actually fill in. The format
 * is plain enough to survive being read by a human who has never seen this file
 * — headings on their own line, blank line between sections — because that is
 * what a paper chart looks like and what a court would be shown.
 *
 * The round-trip is the property that matters and it is tested both ways:
 * anything this file writes, it reads back identically.
 *
 * ── LEGACY NOTES ───────────────────────────────────────────────────────────
 * Notes written before this existed are unstructured text. They land in
 * ASSESSMENT, because the box they were typed into was labelled "Assessment /
 * diagnosis" — so that is what they are. Putting them in Subjective would be
 * tidier and wrong.
 */

export const SECTIONS = ['Subjective', 'Objective', 'Assessment', 'Plan'] as const;
export type Section = (typeof SECTIONS)[number];

export type ConsultNote = Record<Section, string>;

export const EMPTY_NOTE: ConsultNote = {
  Subjective: '', Objective: '', Assessment: '', Plan: '',
};

/** What each box is actually asking for. Shown as placeholder text, because
 *  "Objective" alone does not tell a new clinical officer what goes in it. */
export const SECTION_HINT: Record<Section, string> = {
  Subjective: 'What the patient reports — history, symptoms, duration.',
  Objective: 'What you found — examination findings, vitals already recorded above.',
  Assessment: 'Diagnosis or working impression, and differentials.',
  Plan: 'Investigations, treatment, follow-up, referral, advice given.',
};

const HEADING = new RegExp(`^(${SECTIONS.join('|')})\\s*$`);

/** Sections → the single text field the database stores. Empty sections are
 *  left out entirely rather than written as an empty heading, so a note with
 *  only an assessment reads as one paragraph and not as three blank prompts. */
export function serializeNote(note: ConsultNote): string {
  return SECTIONS
    .filter((s) => note[s].trim() !== '')
    .map((s) => `${s}\n${note[s].trim()}`)
    .join('\n\n');
}

/**
 * The stored text → sections.
 *
 * A heading is recognised only when it is alone on its line, so a plan reading
 * "review the assessment in a week" is not mistaken for a section break.
 * Anything before the first heading is legacy free text; see the note above.
 */
export function parseNote(text: string | null | undefined): ConsultNote {
  const out: ConsultNote = { ...EMPTY_NOTE };
  if (!text || text.trim() === '') return out;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let current: Section | null = null;
  const buffers: Record<Section, string[]> = {
    Subjective: [], Objective: [], Assessment: [], Plan: [],
  };
  const preamble: string[] = [];

  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      current = match[1] as Section;
      continue;
    }
    (current ? buffers[current] : preamble).push(line);
  }

  for (const s of SECTIONS) out[s] = buffers[s].join('\n').trim();

  const legacy = preamble.join('\n').trim();
  if (legacy !== '') {
    // Prepended, not appended: if a note somehow has both, the older text came
    // first and should stay first.
    out.Assessment = out.Assessment === '' ? legacy : `${legacy}\n\n${out.Assessment}`;
  }
  return out;
}

/** save_consult_notes requires a note. Mirrors that so the button can be
 *  disabled rather than the save failing. */
export const noteIsEmpty = (note: ConsultNote) => serializeNote(note).trim() === '';
