// Turn raw data collected by the browser extension into filtered, normalized jobs.
// Browser-safe (runs in the web page).
import { normalizeJob } from './parse.js';
import { buildLocationFilter, collectLocationText } from './location.js';

/**
 * @param {object} collected  { rawJobs: object[], domJobs: object[], meta }
 * @param {object} opts       { location, workplaceTypes, includeWorldwide, max }
 */
export function buildResults(collected, { location = '', workplaceTypes = [], includeWorldwide = true, max = 50 } = {}) {
  const filter = buildLocationFilter({ location, workplaceTypes, includeWorldwide });
  const jobs = [];
  const seen = new Set();
  let scanned = 0;

  for (const raw of collected.rawJobs || []) {
    const job = normalizeJob(raw);
    if (!job.title || seen.has(job.id)) continue;
    seen.add(job.id);
    scanned++;
    const locText = [job.location, ...collectLocationText(raw)].filter(Boolean).join(' | ');
    if (filter.matches(locText, job.workplace || '')) jobs.push(job);
  }

  // DOM fallback (only used when no API data was captured).
  for (const job of collected.domJobs || []) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    scanned++;
    if (filter.matches(`${job.location || ''} | ${job.text || ''}`, job.text || '')) jobs.push(job);
  }

  return {
    jobs: jobs.slice(0, max),
    count: Math.min(jobs.length, max),
    scanned,
    filter: { location, places: filter.places, workplaceTypes: filter.workplaceTypes, includeWorldwide },
    filterActive: filter.active,
  };
}
