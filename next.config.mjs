/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't bundle the browser packages; load them from node_modules at runtime.
  serverExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
  // Ship files these packages load dynamically (file tracing can't see them):
  // the compressed Chromium binary, and playwright-core's browsers.json etc.
  outputFileTracingIncludes: {
    '/api/jobs': ['./node_modules/@sparticuz/chromium/**', './node_modules/playwright-core/**'],
  },
};

export default nextConfig;
