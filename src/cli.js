#!/usr/bin/env node
// Usage: node src/cli.js "AI Engineer" [--location "Europe Remote"] [--workplace remote,hybrid]
//        [--no-worldwide] [--max 100] [--out output] [--headless] [--debug]
import fs from 'node:fs';
import path from 'node:path';
import { scrapeJobs, toCsv } from '../lib/scraper.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const query = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(max|out|location|workplace)$/));

if (!query) {
  console.error(
    'Usage: node src/cli.js "<search query>" [--location "Europe Remote"] [--workplace remote,hybrid] [--no-worldwide] [--max 100] [--out output] [--headless] [--debug]'
  );
  process.exit(1);
}
const location = flag('location', '');
const outDir = flag('out', 'output');
const slug = `${query} ${location}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

console.log(`Searching hiringcafe.com for "${query}"${location ? ` in "${location}"` : ''}...`);
const { jobs, meta } = await scrapeJobs({
  query,
  location,
  workplaceTypes: flag('workplace', '').split(',').filter(Boolean),
  includeWorldwide: !args.includes('--no-worldwide'),
  maxJobs: Number(flag('max', 100)),
  timeBudgetMs: 180_000,
  headless: args.includes('--headless') || process.env.HEADLESS === '1',
  debugDir: args.includes('--debug') ? path.join(outDir, 'debug') : undefined,
  onStage: (stage) => console.log(`  ${stage}...`),
});

fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `${slug}_${stamp}`);
fs.writeFileSync(`${base}.json`, JSON.stringify(jobs, null, 2));
fs.writeFileSync(`${base}.csv`, toCsv(jobs));

console.log(`Found ${jobs.length} matching jobs (scanned ${meta.scanned}) via ${meta.source} in ${(meta.durationMs / 1000).toFixed(1)}s`);
console.table(jobs.slice(0, 10).map((j) => ({ title: j.title, company: j.company, location: j.location, workplace: j.workplace })));
console.log(`Saved: ${base}.json\n       ${base}.csv`);
