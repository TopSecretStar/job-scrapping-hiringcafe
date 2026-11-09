/** @type {import('next').NextConfig} */
// Runs locally only (npm run dev / npm start): the API route drives a Chromium window on this PC.
const nextConfig = {
  serverExternalPackages: ['playwright'],
};

export default nextConfig;
