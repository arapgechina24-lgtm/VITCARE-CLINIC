'use client';
import { FlaskConical } from 'lucide-react';
import { Tabs } from '@/components/ui/Tabs';
import { VitalsPanel } from './VitalsPanel';
import { HistoryPanel } from './HistoryPanel';
import { PrescriptionsPanel } from './PrescriptionsPanel';
import { ClinicalNoteEditor } from './ClinicalNoteEditor';
import { RestrictedPanel } from './RestrictedPanel';
import { activeEncounter, type PatientRecord } from '@/lib/patient-record';

/**
 * The tabbed record. Client-side only for tab state — all the data is fetched
 * on the server by the page and handed down, so nothing here re-queries and no
 * patient data is embedded in a client-side fetch.
 */
export function PatientRecordTabs({
  record,
  canWriteNotes,
  noteBlockedReason,
  role,
}: {
  record: PatientRecord;
  canWriteNotes: boolean;
  noteBlockedReason?: string;
  role: string;
}) {
  const open = activeEncounter(record.encounters);

  // Derived from what the SERVER said it returned, not from the role string.
  // If the two ever disagree the server is right — it is the one that decided
  // which keys to build into the payload.
  const scope = record.scope ?? 'FULL';
  const seesClinical = scope === 'FULL';
  const seesObservations = scope === 'FULL' || scope === 'OBSERVATIONS';

  return (
    <Tabs
      tabs={[
        {
          id: 'consultation',
          label: 'Consultation',
          content: (
            <div className="space-y-4">
              {open && (
                <div className="rounded-lg bg-brand-wash px-3 py-2 text-xs text-brand-ink">
                  Open visit started{' '}
                  {new Date(open.created_at).toLocaleString('en-KE', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {open.chief_complaint ? ` · ${open.chief_complaint}` : ''}
                </div>
              )}
              <ClinicalNoteEditor
                encounterId={open?.id ?? null}
                initialNote={open?.clinical_notes ?? ''}
                canWrite={canWriteNotes && Boolean(open)}
                reason={
                  !open
                    ? 'This patient has no visit in progress. Register them for a visit to add a note.'
                    : noteBlockedReason
                }
              />
            </div>
          ),
        },
        {
          id: 'vitals',
          label: 'Vitals',
          content: seesObservations ? (
            <VitalsPanel encounters={record.encounters} />
          ) : (
            <RestrictedPanel what="Vitals" role={role} />
          ),
        },
        {
          id: 'history',
          label: 'Medical history',
          // No count when restricted: "0" would read as "this patient has never
          // been seen", and a real count would itself disclose how much history
          // there is.
          count: seesClinical ? record.encounters.length : undefined,
          content: seesClinical ? (
            <HistoryPanel encounters={record.encounters} />
          ) : (
            <RestrictedPanel what="Consultation notes" role={role} />
          ),
        },
        {
          id: 'prescriptions',
          label: 'Prescriptions',
          count: seesClinical ? record.prescriptions.length : undefined,
          content: seesClinical ? (
            <PrescriptionsPanel prescriptions={record.prescriptions} />
          ) : (
            <RestrictedPanel what="Prescriptions" role={role} />
          ),
        },
        {
          id: 'labs',
          label: 'Lab results',
          sample: true,
          content: (
            <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
              <FlaskConical className="mx-auto mb-3 h-7 w-7 text-ink-muted" aria-hidden />
              <p className="text-sm font-medium text-ink">Lab results aren&apos;t connected yet</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">
                There is no laboratory module in this system yet — no results table, no analyser
                integration. Rather than show plausible-looking sample results inside a real
                patient&apos;s chart, this tab stays empty until it is real.
              </p>
            </div>
          ),
        },
      ]}
    />
  );
}
