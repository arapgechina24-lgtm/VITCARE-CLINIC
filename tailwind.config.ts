import type { Config } from 'tailwindcss';

/**
 * Tokens map 1:1 onto the CSS custom properties in globals.css, so a colour is
 * defined in exactly one place and light/dark swap without a single `dark:`
 * prefix scattered through the components.
 *
 * darkMode: 'media' — dark follows the OS. There's no toggle to persist, no
 * theme script, and therefore no inline <script> fighting the CSP.
 */
export default {
  // .tsx only — see the note in vitcare-pos's config: Tailwind's JIT candidate
  // extractor can misread plain .ts (a regex character class as an arbitrary
  // value), and Turbopack's stricter CSS parser hard-fails on the result.
  content: ['./src/**/*.tsx'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        page: 'var(--page)',
        surface: {
          DEFAULT: 'var(--surface)',
          sunken: 'var(--surface-sunken)',
          hover: 'var(--surface-hover)',
        },
        ink: {
          DEFAULT: 'var(--ink)',
          secondary: 'var(--ink-secondary)',
          muted: 'var(--ink-muted)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          ink: 'var(--brand-ink)',
          wash: 'var(--brand-wash)',
          'wash-strong': 'var(--brand-wash-strong)',
        },
        good: { DEFAULT: 'var(--good)', ink: 'var(--good-ink)', wash: 'var(--good-wash)' },
        warning: { DEFAULT: 'var(--warning)', ink: 'var(--warning-ink)', wash: 'var(--warning-wash)' },
        serious: { DEFAULT: 'var(--serious)', ink: 'var(--serious-ink)', wash: 'var(--serious-wash)' },
        critical: { DEFAULT: 'var(--critical)', ink: 'var(--critical-ink)', wash: 'var(--critical-wash)' },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      borderRadius: {
        // Rounded, not pill-shaped — the brief's "not too exaggerated".
        lg: '10px',
        xl: '12px',
        '2xl': '16px',
      },
      fontSize: {
        // A deliberately small type scale. Fewer sizes = clearer hierarchy.
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
      },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      // No fill-mode: a retained `transform` makes the element a containing
      // block for fixed/absolute descendants forever after, which silently
      // breaks modals nested inside. (This exact bug bit vitcare-pos.)
      animation: { rise: 'rise .3s ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
