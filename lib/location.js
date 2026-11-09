// Location + workplace filtering for scraped jobs.
// "Europe Remote" -> { regions: ["Europe"], workplaceTypes: ["remote"] }

const US_STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

export const REGIONS = {
  Europe: {
    aliases: ['europe', 'eu', 'european union', 'eea', 'emea'],
    terms: [
      'europe', 'european', 'eu', 'eea', 'emea', 'cet', 'cest', 'schengen',
      'albania', 'andorra', 'austria', 'belarus', 'belgium', 'bosnia', 'bulgaria', 'croatia', 'cyprus', 'czech republic',
      'czechia', 'denmark', 'estonia', 'finland', 'france', 'germany', 'deutschland', 'greece', 'hungary', 'iceland',
      'ireland', 'italy', 'kosovo', 'latvia', 'liechtenstein', 'lithuania', 'luxembourg', 'malta', 'moldova', 'monaco',
      'montenegro', 'netherlands', 'the netherlands', 'holland', 'north macedonia', 'norway', 'poland', 'portugal',
      'romania', 'san marino', 'serbia', 'slovakia', 'slovenia', 'spain', 'sweden', 'switzerland', 'ukraine',
      'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
      'london', 'manchester', 'edinburgh', 'dublin', 'berlin', 'munich', 'hamburg', 'frankfurt', 'cologne', 'paris',
      'lyon', 'amsterdam', 'rotterdam', 'utrecht', 'brussels', 'antwerp', 'madrid', 'barcelona', 'valencia', 'lisbon',
      'porto', 'milan', 'rome', 'turin', 'vienna', 'zurich', 'geneva', 'stockholm', 'gothenburg', 'copenhagen', 'oslo',
      'helsinki', 'tallinn', 'riga', 'vilnius', 'warsaw', 'krakow', 'wroclaw', 'gdansk', 'prague', 'brno', 'budapest',
      'bucharest', 'cluj', 'sofia', 'athens', 'belgrade', 'zagreb', 'ljubljana', 'bratislava', 'kyiv', 'lviv',
    ],
  },
  'United Kingdom': {
    aliases: ['uk', 'united kingdom', 'great britain', 'britain', 'england'],
    terms: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'london', 'manchester', 'edinburgh', 'bristol', 'cambridge', 'oxford'],
  },
  'North America': {
    aliases: ['north america', 'na', 'us', 'usa', 'united states', 'america', 'canada'],
    terms: ['north america', 'united states', 'usa', 'us', 'u.s.', 'america', 'canada', 'mexico', 'est', 'pst', 'cst', 'mst'],
    patterns: [new RegExp(`,\\s*(${US_STATES})\\b`)],
  },
  'Latin America': {
    aliases: ['latin america', 'latam', 'south america', 'central america'],
    terms: ['latin america', 'latam', 'south america', 'central america', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru', 'uruguay', 'paraguay', 'bolivia', 'ecuador', 'venezuela', 'costa rica', 'panama', 'guatemala', 'dominican republic'],
  },
  'Asia Pacific': {
    aliases: ['apac', 'asia', 'asia pacific', 'oceania'],
    terms: ['apac', 'asia', 'asia pacific', 'oceania', 'australia', 'new zealand', 'india', 'singapore', 'japan', 'south korea', 'korea', 'china', 'hong kong', 'taiwan', 'philippines', 'indonesia', 'malaysia', 'thailand', 'vietnam', 'pakistan', 'bangladesh', 'sri lanka'],
  },
  'Middle East & Africa': {
    aliases: ['mena', 'middle east', 'africa', 'middle east & africa', 'mea'],
    terms: ['mena', 'middle east', 'africa', 'emea', 'united arab emirates', 'uae', 'dubai', 'abu dhabi', 'saudi arabia', 'qatar', 'israel', 'turkey', 'türkiye', 'egypt', 'south africa', 'nigeria', 'kenya', 'morocco', 'ghana'],
  },
};

const WORKPLACE = {
  remote: /\b(remote|distributed|work from home|wfh|anywhere)\b/i,
  hybrid: /\bhybrid\b/i,
  onsite: /\b(on-?site|in-?office|in office|office-based)\b/i,
};
const WORKPLACE_WORDS = { remote: 'remote', 'fully remote': 'remote', wfh: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite', 'in-office': 'onsite', office: 'onsite' };
const WORLDWIDE = /\b(worldwide|anywhere|global|globally|international)\b/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse user input like "Europe Remote", "Germany, Hybrid", "remote".
 * Explicit workplaceTypes (from UI checkboxes) are merged with any found in the text.
 */
export function parseLocationInput(text = '', workplaceTypes = []) {
  const types = new Set(workplaceTypes.map((t) => t.toLowerCase()).filter((t) => t in WORKPLACE));
  let rest = ` ${text.toLowerCase()} `;
  for (const [word, type] of Object.entries(WORKPLACE_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(^|[^a-z])${escapeRe(word)}(?=[^a-z]|$)`, 'g');
    if (re.test(rest)) {
      types.add(type);
      rest = rest.replace(re, '$1 ');
    }
  }
  const places = rest
    .split(/,|\/|;|\bor\b|\band\b/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { places, workplaceTypes: [...types] };
}

/** Returns { describe, matches(locationText, workplaceText) }. */
export function buildLocationFilter({ location = '', workplaceTypes = [], includeWorldwide = true } = {}) {
  const { places, workplaceTypes: types } = parseLocationInput(location, workplaceTypes);

  const terms = new Set();
  const patterns = [];
  const regionNames = [];
  for (const place of places) {
    const region = Object.entries(REGIONS).find(([name, r]) => name.toLowerCase() === place || r.aliases.includes(place));
    if (region) {
      regionNames.push(region[0]);
      region[1].terms.forEach((t) => terms.add(t));
      patterns.push(...(region[1].patterns || []));
    } else {
      regionNames.push(place);
      terms.add(place);
    }
  }
  const placeRe = terms.size
    ? new RegExp(`(^|[^a-z])(${[...terms].map(escapeRe).join('|')})(?=[^a-z]|$)`, 'i')
    : null;

  const active = Boolean(placeRe || types.length);

  function matches(locationText = '', workplaceText = '') {
    const text = `${locationText} ${workplaceText}`;
    const workplaceOk = !types.length || types.some((t) => WORKPLACE[t].test(text));
    if (!workplaceOk) return false;
    if (!placeRe) return true;
    if (placeRe.test(locationText) || patterns.some((p) => p.test(locationText))) return true;
    // "Remote - Worldwide" jobs are open to people in any region.
    return includeWorldwide && WORLDWIDE.test(text);
  }

  return {
    active,
    places: regionNames,
    workplaceTypes: types,
    describe: [regionNames.join(', '), types.join('/')].filter(Boolean).join(' · ') || 'anywhere',
    matches,
  };
}

/** Collect location-ish string values from a raw API job object. */
export function collectLocationText(raw, depth = 0, out = []) {
  if (!raw || typeof raw !== 'object' || depth > 4) return out;
  for (const [key, val] of Object.entries(raw)) {
    const locKey = /locat|countr|continent|region|city|state|address|workplace|remote|geo|timezone/i.test(key);
    if (locKey && (typeof val === 'string' || typeof val === 'boolean')) out.push(typeof val === 'boolean' ? (val ? key.replace(/_/g, ' ') : '') : val);
    else if (locKey && Array.isArray(val)) val.forEach((v) => (typeof v === 'string' ? out.push(v) : collectLocationText(v, depth + 1, out)));
    else if (val && typeof val === 'object') collectLocationText(val, depth + 1, out);
  }
  return out;
}
