// Browser-safe helpers shared by the web page and the Node CLI.

/** Recursively find arrays of objects that look like job postings. */
export function findJobArrays(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && looksLikeJob(node[0])) {
      out.push(...node);
      return out;
    }
    node.forEach((x) => findJobArrays(x, depth + 1, out));
  } else {
    Object.values(node).forEach((v) => findJobArrays(v, depth + 1, out));
  }
  return out;
}

function looksLikeJob(o) {
  const s = JSON.stringify(o).slice(0, 5000).toLowerCase();
  return (s.includes('title') || s.includes('job')) && (s.includes('company') || s.includes('apply') || s.includes('location'));
}

/** Pick the first non-empty value among several possible paths (API shape may vary). */
function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

export function normalizeJob(raw) {
  const v5 = 'v5_processed_job_data';
  const info = 'job_information';
  const company = 'v5_processed_company_data';
  const min = pick(raw, `${v5}.yearly_min_compensation`, 'salary_min', 'min_salary');
  const max = pick(raw, `${v5}.yearly_max_compensation`, 'salary_max', 'max_salary');
  const job = {
    id: String(pick(raw, 'id', 'objectID', '_id', 'job_id', 'requisition_id', 'apply_url') ?? ''),
    title: pick(raw, `${info}.title`, `${v5}.core_job_title`, 'title', 'job_title', 'name'),
    company: pick(raw, `${v5}.company_name`, `${company}.name`, 'company_name', 'company.name', 'company'),
    location: pick(raw, `${v5}.formatted_workplace_location`, 'location', 'locations', 'job_location'),
    workplace: pick(raw, `${v5}.workplace_type`, 'workplace_type', 'remote'),
    commitment: pick(raw, `${v5}.commitment`, 'employment_type', 'job_type'),
    seniority: pick(raw, `${v5}.seniority_level`, 'seniority'),
    salary: min || max ? `${min ?? '?'} - ${max ?? '?'} ${pick(raw, `${v5}.listed_compensation_currency`) ?? ''}`.trim() : pick(raw, 'salary', 'compensation'),
    postedAt: pick(raw, `${v5}.estimated_publish_date`, 'estimated_publish_date', 'posted_at', 'created_at', 'date_posted'),
    url: pick(raw, 'apply_url', 'url', 'job_url', 'link'),
    source: pick(raw, 'source', 'board_token'),
  };
  for (const k of ['location', 'commitment', 'workplace', 'seniority']) {
    if (Array.isArray(job[k])) job[k] = job[k].join(', ');
  }
  if (job.company && typeof job.company === 'object') job.company = job.company.name ?? JSON.stringify(job.company);
  if (!job.id) job.id = `${job.title}|${job.company}|${job.location}`;
  return job;
}

export function toCsv(jobs) {
  if (!jobs.length) return '';
  const cols = [...new Set(jobs.flatMap(Object.keys))];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...jobs.map((j) => cols.map((c) => esc(j[c])).join(','))].join('\n');
}
