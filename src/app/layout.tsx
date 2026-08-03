import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

/**
 * Inter, self-hosted by next/font.
 *
 * This was previously named in the Tailwind config but never actually loaded,
 * so the whole app silently fell back to system-ui. next/font downloads and
 * serves it from our own origin at build time, which also means no runtime
 * request to fonts.googleapis.com — so the CSP doesn't need to allow Google's
 * font hosts at all, and there's no flash of unstyled text.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Vitcare Clinic',
  description: 'Vitcare Health Center — patient records, consultations and dispensing.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1116' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="font-sans">{children}</body>
    </html>
  );
}
