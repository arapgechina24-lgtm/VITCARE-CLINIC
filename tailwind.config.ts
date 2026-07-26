import type { Config } from 'tailwindcss';

export default {
  // .tsx only — see vitcare-pos's tailwind.config.ts for why plain .ts is excluded
  // (JIT candidate-extractor false positives under Turbopack's stricter CSS parser).
  content: ['./src/**/*.tsx'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Clinical palette, deliberately distinct from POS's "Greenhouse Glass"
        // brand — this is a separate system with its own identity. Cool clinical
        // blue as structural brand, a calm teal accent, amber reserved for
        // clinical alerts (allergies, drug interactions, overdue triage).
        clinic: { DEFAULT: '#1D4ED8', deep: '#0F1E4D', soft: '#3B6EF0' },
        teal: { DEFAULT: '#0EA5A0', soft: '#5FD8D3' },
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        paper: 'var(--paper)',
        alert: { DEFAULT: '#DC2626' },
        warn: { DEFAULT: '#F59E0B' },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
