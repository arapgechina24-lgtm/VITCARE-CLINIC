import { Activity, Droplets, HeartPulse, Thermometer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  flagBp, flagPulse, flagSpo2, flagTemp, latestVitals,
  type RecordEncounter, type VitalFlag,
} from '@/lib/patient-record';

/**
 * Vitals — the latest reading up top, then every prior reading as a table.
 *
 * Out-of-range values are marked "Outside usual range", never "abnormal" and
 * never in red. The bands are broad adult screening ranges (see
 * lib/patient-record.ts) that do not account for age, pregnancy or chronic
 * conditions, so the flag exists to draw a clinician's eye — not to assert a
 * finding. Overstating certainty here would be actively unsafe.
 */

const CARDS: Array<{
  key: keyof NonNullable<RecordEncounter['vitals']>;
  label: string;
  unit: string;
  icon: LucideIcon;
  flag: (v?: string | null) => VitalFlag;
}> = [
  { key: 'tempC', label: 'Temperature', unit: '°C', icon: Thermometer, flag: flagTemp },
  { key: 'bp', label: 'Blood pressure', unit: 'mmHg', icon: Activity, flag: flagBp },
  { key: 'pulseBpm', label: 'Pulse', unit: 'bpm', icon: HeartPulse, flag: flagPulse },
  { key: 'spo2Pct', label: 'Oxygen saturation', unit: '%', icon: Droplets, flag: flagSpo2 },
];

export function VitalsPanel({ encounters }: { encounters: RecordEncounter[] }) {
  const latest = latestVitals(encounters);
  const withVitals = encounters.filter((e) => e.vitals && Object.values(e.vitals).some((v) => v));

  if (!latest) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-muted">
        No vitals recorded yet. They&apos;re captured during triage.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs text-ink-muted">
          Latest reading ·{' '}
          {new Date(latest.at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CARDS.map(({ key, label, unit, icon: Icon, flag }) => {
            const raw = latest.vitals[key];
            const state = flag(raw);
            return (
              <div key={key} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center gap-1.5 text-ink-muted">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="text-xs font-medium text-ink-secondary">{label}</span>
                </div>
                <p className="mt-2 text-2xl font-semibold leading-none tracking-tight text-ink">
                  {raw || <span className="text-base font-normal text-ink-muted">Not recorded</span>}
                  {raw && <span className="ml-1 text-sm font-medium text-ink-muted">{unit}</span>}
                </p>
                {state !== 'none' && (
                  <p
                    className={`mt-2 text-2xs font-medium ${
                      state === 'normal' ? 'text-good-ink' : 'text-warning-ink'
                    }`}
                  >
                    {state === 'normal' ? 'Within usual range' : 'Outside usual range'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {withVitals.length > 1 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">History</h3>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-sunken text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Date</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Temp</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">BP</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">Pulse</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-secondary">SpO₂</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {withVitals.map((e) => (
                  <tr key={e.id} className="bg-surface">
                    <td className="whitespace-nowrap px-4 py-2.5 text-ink-secondary">
                      {new Date(e.created_at).toLocaleDateString('en-KE', { dateStyle: 'medium' })}
                    </td>
                    {/* tabular-nums here: these ARE columns that must align. */}
                    <td className="tabular px-4 py-2.5 text-ink">{e.vitals?.tempC ?? '—'}</td>
                    <td className="tabular px-4 py-2.5 text-ink">{e.vitals?.bp ?? '—'}</td>
                    <td className="tabular px-4 py-2.5 text-ink">{e.vitals?.pulseBpm ?? '—'}</td>
                    <td className="tabular px-4 py-2.5 text-ink">{e.vitals?.spo2Pct ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
