/** @type {import('next').NextConfig} */
// The website only queues searches and shows results; scraping runs in the local worker
// (src/worker.js), so no browser is bundled into the Vercel functions.
const nextConfig = {};

export default nextConfig;
