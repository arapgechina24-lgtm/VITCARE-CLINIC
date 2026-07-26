import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vitcare Clinic',
  description: 'Vitcare Health Center & Medical Centre — clinical workflow: Register, Triage, Consult, Prescribe.',
};

export const viewport: Viewport = {
  themeColor: '#0F1E4D',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
