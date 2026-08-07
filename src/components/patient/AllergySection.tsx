'use client';
import { useState } from 'react';
import { AllergyBanner } from './AllergyBanner';
import { AllergyEditor } from './AllergyEditor';
import type { AllergyStatus, RecordedAllergy } from '@/lib/allergy-check';

/**
 * The allergy banner on a patient's chart, with the editor attached.
 *
 * Sits above the tabs and outside them on purpose: allergies are not one view
 * among five. A clinician reading the vitals tab still needs to know this
 * patient reacts to penicillin, and a fact that can be tabbed away from is a
 * fact that will be.
 */
export function AllergySection({
  patientId,
  status,
  allergies,
  reviewedAt,
  canEdit,
}: {
  patientId: string;
  status: AllergyStatus;
  allergies: RecordedAllergy[];
  reviewedAt?: string | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <AllergyBanner
        status={status}
        allergies={allergies}
        reviewedAt={reviewedAt}
        onRecord={
          canEdit ? (
            <button
              onClick={() => setEditing(true)}
              className="rounded-lg border border-current px-2 py-1 text-xs font-medium"
            >
              {status === 'UNRECORDED' ? 'Record now' : 'Update'}
            </button>
          ) : undefined
        }
      />
      {editing && (
        <AllergyEditor
          patientId={patientId}
          status={status}
          allergies={allergies}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
