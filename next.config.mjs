// Same reasoning as vitcare-pos's next.config.mjs: scope connect-src to this
// exact Supabase project (both https REST and wss Realtime) instead of a
// broad https://*.supabase.co wildcard.
const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host
  : null;
const connectSrc = ["'self'", ...(supabaseHost ? [`https://${supabaseHost}`, `wss://${supabaseHost}`] : [])].join(' ');

// script-src needs 'unsafe-inline' for the same Next.js App Router RSC-hydration
// reason documented in vitcare-pos's next.config.mjs — this app has no inline
// <script> of its own (service worker registration, if added later, must be an
// external file for the same reason register-sw.js is external in POS).
const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src 'self' https://fonts.gstatic.com data:`,
  `img-src 'self' data: blob:`,
  `connect-src ${connectSrc}`,
  `worker-src 'self'`,
  `manifest-src 'self'`,
  `frame-ancestors 'none'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), geolocation=()' },
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
      ],
    },
  ],
};
export default nextConfig;
