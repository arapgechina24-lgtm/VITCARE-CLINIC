/**
 * MOCK DATA — not real, not from the database.
 *
 * Everything in this file backs a screen whose tables don't exist yet
 * (appointments, billing). It lives in one clearly-named file, and every view
 * that consumes it renders a visible "Sample data" marker, so nobody mistakes
 * a demo surface for a clinical one. In a system that will hold real patient
 * records, plausible-looking fake data on an unmarked screen is a hazard, not
 * a convenience.
 *
 * Delete this file as each module gets a real backend.
 */

export interface MockAppointment {
  id: string;
  patientName: string;
  /** Minutes from midnight — keeps the timeline arithmetic trivial. */
  startMin: number;
  durationMin: number;
  reason: string;
  status: 'checked-in' | 'scheduled' | 'in-progress' | 'done';
}

export interface MockClinician {
  id: string;
  name: string;
  speciality: string;
  appointments: MockAppointment[];
}

const t = (h: number, m = 0) => h * 60 + m;

export const MOCK_DAY_SCHEDULE: MockClinician[] = [
  {
    id: 'c1',
    name: 'Dr. Peter Kamau',
    speciality: 'General practice',
    appointments: [
      { id: 'a1', patientName: 'Mary Wanjiku', startMin: t(8, 30), durationMin: 30, reason: 'Persistent cough', status: 'done' },
      { id: 'a2', patientName: 'Joseph Otieno', startMin: t(9, 30), durationMin: 30, reason: 'Hypertension review', status: 'done' },
      { id: 'a3', patientName: 'Grace Achieng', startMin: t(10, 30), durationMin: 45, reason: 'Antenatal check', status: 'in-progress' },
      { id: 'a4', patientName: 'Samuel Kiprop', startMin: t(12, 0), durationMin: 30, reason: 'Diabetes follow-up', status: 'checked-in' },
      { id: 'a5', patientName: 'Alice Njeri', startMin: t(14, 0), durationMin: 30, reason: 'Skin rash', status: 'scheduled' },
    ],
  },
  {
    id: 'c2',
    name: 'Dr. Aisha Mohamed',
    speciality: 'Paediatrics',
    appointments: [
      { id: 'b1', patientName: 'Baby Njoroge', startMin: t(9, 0), durationMin: 30, reason: 'Immunisation', status: 'done' },
      { id: 'b2', patientName: 'Brian Mutua', startMin: t(11, 0), durationMin: 30, reason: 'Fever, 3 days', status: 'in-progress' },
      { id: 'b3', patientName: 'Faith Wambui', startMin: t(13, 30), durationMin: 30, reason: 'Growth review', status: 'scheduled' },
      { id: 'b4', patientName: 'Daniel Kimani', startMin: t(15, 0), durationMin: 45, reason: 'Asthma review', status: 'scheduled' },
    ],
  },
  {
    id: 'c3',
    name: 'Sr. Grace Njoroge',
    speciality: 'Triage & dressing',
    appointments: [
      { id: 'd1', patientName: 'Walk-in clinic', startMin: t(8, 0), durationMin: 120, reason: 'Triage block', status: 'done' },
      { id: 'd2', patientName: 'Wound dressing', startMin: t(11, 0), durationMin: 60, reason: 'Scheduled dressings', status: 'in-progress' },
      { id: 'd3', patientName: 'Walk-in clinic', startMin: t(14, 0), durationMin: 120, reason: 'Triage block', status: 'scheduled' },
    ],
  },
];

/** Timeline bounds — a clinic day, not a 24h axis nobody looks at. */
export const DAY_START_MIN = t(8);
export const DAY_END_MIN = t(17);

/** 12-point trends for the KPI sparklines. Shape only; the tile states the value. */
export const MOCK_TRENDS = {
  patientVolume: [18, 22, 19, 26, 24, 31, 28, 25, 33, 29, 35, 32],
  pharmacyQueue: [4, 6, 5, 8, 7, 5, 9, 11, 8, 6, 7, 9],
  appointments: [12, 14, 11, 16, 15, 18, 17, 14, 19, 21, 18, 20],
};
