/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't bundle the browser packages; load them from node_modules at runtime.
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  // Make sure the compressed Chromium binary ships with the API function on Vercel.
  outputFileTracingIncludes: {
    '/api/jobs': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
};

export default nextConfig;
