import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');

const RESULTS_PATH = path.join(DATA_DIR, 'amku_pharma_case_starts.json');
const STATE_PATH = path.join(DATA_DIR, 'amku_pharma_case_starts_state.json');
const EVENTS_PATH = path.join(DATA_DIR, 'amku_pharma_case_starts_events.jsonl');

const TIMELINE_API_URL = env('TIMELINE_API_URL', 'https://amcu.gov.ua/api/timeline');
const TIMELINE_TAG = env('TIMELINE_TAG', 'про початок розгляду справи');
const TIMELINE_LANG = env('TIMELINE_LANG', 'uk');

const PERIOD_MODE = env('PERIOD_MODE', 'weekly'); // weekly | monthly | custom
const DATE_FROM = env('DATE_FROM', '');
const DATE_TO = env('DATE_TO', '');

const DRY_RUN = boolEnv('DRY_RUN', false);
const SKIP_GEMINI = boolEnv('SKIP_GEMINI', false);
const FORCE_SEND = boolEnv('FORCE_SEND', false);
const SEND_EMAIL = boolEnv('SEND_EMAIL', true);
const SEND_EMPTY_EMAIL = boolEnv('SEND_EMPTY_EMAIL', true);

const MAX_GEMINI_CALLS = intEnv('MAX_GEMINI_CALLS', 20);
const MAX_PAGE_TEXT_CHARS = intEnv('MAX_PAGE_TEXT_CHARS', 60000);
const MAX_FETCH_RETRIES = intEnv('MAX_FETCH_RETRIES', 4);

const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-3.1-flash-lite');
const GEMINI_RETRY_MAX = intEnv('GEMINI_RETRY_MAX', 3);
const GEMINI_RETRY_BUFFER_MS = intEnv('GEMINI_RETRY_BUFFER_MS', 1500);

const EMAIL_SUBJECT_PREFIX = env('EMAIL_SUBJECT_PREFIX', 'АМКУ: нові справи у фармсекторі');

const PHARMA_PATTERNS = [
  /фармац/i,
  /фарма\b/i,
  /лікарськ/i,
  /лікарські\s+засоби/i,
  /лікарський\s+засіб/i,
  /препарат/i,
  /аптек/i,
  /медичн/i,
  /медвироб/i,
  /вироб[аи]\s+медичного\s+призначення/i,
  /дієтичн/i,
  /добавк/i,
  /\bбад\b/i,
  /активн[іи]\s+фармацевтичн[іи]\s+інгредієнт/i,
  /дистрибуц[іії]\s+лікарськ/i,
  /оптов[аої]\s+торгівл[яі]\s+лікарськ/i,
  /роздрібн[аої]\s+торгівл[яі]\s+лікарськ/i,
  /виробництв[оа]\s+лікарськ/i
];

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intEnv(name, fallback) {
  const raw = env(name, String(fallback));
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function appendEvent(event) {
  if (DRY_RUN) {
    console.log(`DRY_RUN event skipped: ${event?.type || 'event'}`);
    return;
  }

  await fs.mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  await fs.appendFile(
    EVENTS_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
    'utf8'
  );
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value.length ? value[0] : fallback;
  return value ?? fallback;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDateUTC(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDaysUTC(date, days) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUTCDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolvePeriod() {
  if (PERIOD_MODE === 'custom') {
    if (!DATE_FROM || !DATE_TO) {
      throw new Error('DATE_FROM and DATE_TO are required when PERIOD_MODE=custom');
    }

    return {
      mode: 'custom',
      from: DATE_FROM,
      to: DATE_TO,
      label: `${DATE_FROM} — ${DATE_TO}`
    };
  }

  const today = startOfUTCDate(new Date());

  if (PERIOD_MODE === 'monthly') {
    const firstDayThisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const lastDayPrevMonth = addDaysUTC(firstDayThisMonth, -1);
    const firstDayPrevMonth = new Date(Date.UTC(lastDayPrevMonth.getUTCFullYear(), lastDayPrevMonth.getUTCMonth(), 1));

    return {
      mode: 'monthly',
      from: isoDateUTC(firstDayPrevMonth),
      to: isoDateUTC(lastDayPrevMonth),
      label: `${isoDateUTC(firstDayPrevMonth)} — ${isoDateUTC(lastDayPrevMonth)}`
    };
  }

  // weekly by default: previous calendar Monday-Sunday.
  // getUTCDay(): Sun=0, Mon=1, ... Sat=6.
  const day = today.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const thisMonday = addDaysUTC(today, -daysSinceMonday);
  const prevMonday = addDaysUTC(thisMonday, -7);
  const prevSunday = addDaysUTC(thisMonday, -1);

  return {
    mode: 'weekly',
    from: isoDateUTC(prevMonday),
    to: isoDateUTC(prevSunday),
    label: `${isoDateUTC(prevMonday)} — ${isoDateUTC(prevSunday)}`
  };
}

function formatApiDate(iso) {
  const m = String(iso || '').match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return iso;

  return `${m[1]}-${Number(m[2])}-${Number(m[3])}`;
}

function formatDateUk(isoOrDateTime) {
  const s = String(isoOrDateTime || '').slice(0, 10);
  const m = s.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function normalizeSpaces(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripTags(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<(br|p|div|li|tr|h1|h2|h3|h4|section|article|main)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|section|article|main)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

function extractBetween(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = String(html || '').match(re);
  return m ? m[1] : '';
}

function extractTitle(html) {
  const h1 = extractBetween(html, 'h1');
  if (h1) return normalizeSpaces(stripTags(h1));

  const title = extractBetween(html, 'title');
  if (title) return normalizeSpaces(stripTags(title));

  return '';
}

function extractMainText(html) {
  const main = extractBetween(html, 'main');
  const article = extractBetween(html, 'article');
  const body = extractBetween(html, 'body');

  const candidate = main || article || body || html;
  return normalizeSpaces(stripTags(candidate));
}

function hasPharmaSignals(text) {
  const s = normalizeSpaces(text);
  return PHARMA_PATTERNS.some((re) => re.test(s));
}

function buildTimelineUrl(page, period) {
  const url = new URL(TIMELINE_API_URL);
  url.searchParams.set('page', String(page));
  url.searchParams.set('type', 'all');
  url.searchParams.set('tag', TIMELINE_TAG);
  url.searchParams.set('date_from', formatApiDate(period.from));
  url.searchParams.set('date_to', formatApiDate(period.to));
  url.searchParams.set('lang', TIMELINE_LANG);
  return url.toString();
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || MAX_FETCH_RETRIES;
  const baseDelayMs = options.baseDelayMs || 3500;
  const label = options.label || url;

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'amku-pharma-case-starts/0.1',
          'Accept': options.accept || '*/*',
          ...(options.headers || {})
        }
      });

      if (res.ok) return res;

      const message = `HTTP ${res.status} for ${label}`;

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(message);
      }

      lastError = new Error(message);
    } catch (err) {
      lastError = err;
    }

    if (attempt < attempts) {
      const delayMs = baseDelayMs * attempt;
      console.warn(
        `Fetch failed (${attempt}/${attempts}) for ${label}: `
        + `${String(lastError?.message || lastError).slice(0, 500)}. `
        + `Retrying in ${Math.ceil(delayMs / 1000)}s...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`Fetch failed for ${label}`);
}

async function fetchJson(url, label) {
  const res = await fetchWithRetry(url, {
    label,
    accept: 'application/json'
  });

  return await res.json();
}

async function fetchText(url, label) {
  const res = await fetchWithRetry(url, {
    label,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  });

  return await res.text();
}

function flattenTimelineData(payload) {
  const data = payload?.data || {};
  const rows = [];

  for (const [day, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      rows.push({
        timeline_day: day,
        time: item.time || null,
        date_from: item.date_from || null,
        title: item.title || '',
        url: item.url || '',
        source: item.source || null,
        tags: Array.isArray(item.tags) ? item.tags.map((tag) => tag.name || '').filter(Boolean) : [],
        excerpt: item.excerpt || ''
      });
    }
  }

  return rows;
}

async function fetchTimelineItems(period) {
  const all = [];
  let page = 1;
  let lastPage = 1;

  while (page <= lastPage) {
    const url = buildTimelineUrl(page, period);
    const payload = await fetchJson(url, `AMCU timeline page ${page}`);

    const currentPage = Number(firstValue(payload.current_page, page)) || page;
    lastPage = Number(firstValue(payload.last_page, page)) || page;

    const items = flattenTimelineData(payload);
    console.log(`Timeline page ${currentPage}/${lastPage}: ${items.length} items`);

    all.push(...items);
    page += 1;
  }

  const byUrl = new Map();

  for (const item of all) {
    if (!item.url) continue;
    byUrl.set(item.url, item);
  }

  return [...byUrl.values()];
}

function extractCaseNumbers(text) {
  const s = normalizeSpaces(text);
  const found = [];

  const patterns = [
    /справ[аи]\s*№\s*([0-9]{2,4}[-–—][0-9]{1,3}(?:\.[0-9]{1,3})?\/[0-9]{1,4}[-–—][0-9]{2})/gi,
    /№\s*([0-9]{2,4}[-–—][0-9]{1,3}(?:\.[0-9]{1,3})?\/[0-9]{1,4}[-–—][0-9]{2})/gi
  ];

  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      found.push(m[1].replace(/[–—]/g, '-'));
    }
  }

  return [...new Set(found)];
}

function extractBasicQualification(text) {
  const s = normalizeSpaces(text);
  const matches = [];

  const article50 = [
    /пункт(?:ом|у)?\s*(\d{1,2})\s+статті\s*50\s+Закону\s+України\s+«?Про\s+захист\s+економічної\s+конкуренції»?/i,
    /п\.?\s*(\d{1,2})\s*ст\.?\s*50\s+Закону\s+України\s+«?Про\s+захист\s+економічної\s+конкуренції»?/i
  ];

  for (const re of article50) {
    const m = s.match(re);
    if (m) {
      matches.push({
        law: 'Закон України «Про захист економічної конкуренції»',
        article: 'ст. 50',
        point: `п. ${m[1]}`,
        text: `п. ${m[1]} ст. 50 Закону України «Про захист економічної конкуренції»`
      });
      break;
    }
  }

  const unfair = s.match(/статт(?:і|ею|я)\s*(15\s*[-–—]?\s*1|15\s*¹|15¹|\d{1,2})\s+Закону\s+України\s+«?Про\s+захист\s+від\s+недобросовісної\s+конкуренції»?/i);
  if (unfair) {
    const article = unfair[1].replace(/\s+/g, '').replace(/[–—]/g, '-').replace(/¹/g, '-1');
    matches.push({
      law: 'Закон України «Про захист від недобросовісної конкуренції»',
      article: `ст. ${article}`,
      point: null,
      text: `ст. ${article} Закону України «Про захист від недобросовісної конкуренції»`
    });
  }

  return matches[0] || {
    law: null,
    article: null,
    point: null,
    text: 'Не зазначено в повідомленні'
  };
}

function extractFallbackSummary(text) {
  const paragraphs = normalizeSpaces(text)
    .split(/\n+/)
    .map((p) => normalizeSpaces(p))
    .filter((p) => p.length > 80);

  const useful = paragraphs.find((p) =>
    /розпочато\s+розгляд\s+справ/i.test(p)
    || /ознаками\s+вчинення/i.test(p)
    || /порушення/i.test(p)
    || /концентрац/i.test(p)
  );

  return (useful || paragraphs[0] || '').slice(0, 900);
}

function normalizeUrlKey(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function fetchAndPreparePage(item) {
  const html = await fetchText(item.url, `page ${item.url}`);
  const pageTitle = extractTitle(html) || item.title || '';
  const bodyText = extractMainText(html);
  const combinedText = normalizeSpaces([
    item.title,
    item.excerpt,
    pageTitle,
    bodyText
  ].filter(Boolean).join('\n\n'));

  const pharmaCandidate = hasPharmaSignals(combinedText);

  return {
    ...item,
    page_title: pageTitle,
    body_text: bodyText,
    combined_text: combinedText,
    text_sha256: sha256Text(combinedText),
    pharma_candidate: pharmaCandidate,
    case_numbers_basic: extractCaseNumbers(combinedText),
    qualification_basic: extractBasicQualification(combinedText),
    summary_basic: extractFallbackSummary(combinedText)
  };
}

function buildGeminiPrompt(page) {
  const text = String(page.combined_text || '').slice(0, MAX_PAGE_TEXT_CHARS);

  return `Ти юрист-аналітик у сфері конкурентного права та фармацевтичного ринку України.

Проаналізуй повідомлення АМКУ про початок розгляду справи.

Завдання:
1. Визнач, чи стосується повідомлення учасників фармринку:
   - лікарські засоби;
   - дієтичні добавки;
   - медичні вироби;
   - аптеки / аптечний ритейл;
   - дистрибуція / оптова торгівля;
   - виробництво / імпорт / реєстрація / промоція такої продукції.
2. Витягни суб'єкта/суб'єктів потенційного порушення.
3. Витягни номер/номери справ.
4. Витягни попередню кваліфікацію: закон, стаття, пункт, якщо це прямо зазначено.
5. Коротко опиши суть потенційного порушення.
6. Дай короткий коментар щодо ризику/важливості для моніторингу.
7. Не вигадуй. Якщо норма або суб'єкт прямо не визначені — так і напиши.

Поверни виключно валідний JSON без Markdown.

Очікувана структура:
{
  "is_pharma_market": true,
  "sector": "medicines | dietary_supplements | medical_devices | pharmacy_retail | distribution | manufacturing | mixed | other",
  "case_numbers": [],
  "potential_violation_subjects": [],
  "preliminary_qualification": {
    "law": "",
    "article": "",
    "point": "",
    "text": ""
  },
  "short_description": "",
  "risk_comment": "",
  "confidence": "high | medium | low"
}

Службові дані:
- Title from timeline: ${page.title || ''}
- Page title: ${page.page_title || ''}
- URL: ${page.url || ''}
- Basic detected case numbers: ${(page.case_numbers_basic || []).join(', ') || 'none'}
- Basic detected qualification: ${page.qualification_basic?.text || 'none'}

Текст повідомлення:
${text}`;
}

async function analyzeWithGemini(page) {
  if (SKIP_GEMINI) {
    return {
      is_pharma_market: page.pharma_candidate,
      sector: 'other',
      case_numbers: page.case_numbers_basic || [],
      potential_violation_subjects: [],
      preliminary_qualification: page.qualification_basic,
      short_description: page.summary_basic || '',
      risk_comment: '[SKIP_GEMINI] AI-аналіз пропущено.',
      confidence: 'low'
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required unless SKIP_GEMINI=true');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const promptText = buildGeminiPrompt(page);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  let lastError = null;

  for (let attempt = 0; attempt <= GEMINI_RETRY_MAX; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const payload = await res.json().catch(() => null);

    if (res.ok) {
      const rawText =
        payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';

      return parseJsonLenient(rawText);
    }

    const message = `Gemini HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1200)}`;
    lastError = new Error(message);

    if ((res.status === 429 || payload?.error?.status === 'RESOURCE_EXHAUSTED') && attempt < GEMINI_RETRY_MAX) {
      const waitMs = parseGeminiRetryDelayMs(payload);
      console.warn(`Gemini quota error. Retry ${attempt + 1}/${GEMINI_RETRY_MAX} after ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500 && attempt < GEMINI_RETRY_MAX) {
      const waitMs = 10_000 + GEMINI_RETRY_BUFFER_MS;
      console.warn(`Gemini server error. Retry ${attempt + 1}/${GEMINI_RETRY_MAX} after ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
      continue;
    }

    throw lastError;
  }

  throw lastError || new Error('Gemini request failed');
}

function parseGeminiRetryDelayMs(payload) {
  const retryDelay =
    payload?.error?.details?.find((d) => d?.['@type']?.includes('RetryInfo'))?.retryDelay;

  if (typeof retryDelay === 'string') {
    const seconds = retryDelay.match(/^([\d.]+)s$/i);
    if (seconds) return Math.ceil(Number(seconds[1]) * 1000) + GEMINI_RETRY_BUFFER_MS;

    const millis = retryDelay.match(/^([\d.]+)ms$/i);
    if (millis) return Math.ceil(Number(millis[1])) + GEMINI_RETRY_BUFFER_MS;
  }

  return 60_000 + GEMINI_RETRY_BUFFER_MS;
}

function parseJsonLenient(rawText) {
  const raw = String(rawText || '').trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const fencedText = fenced[1].trim();

    try {
      return JSON.parse(fencedText);
    } catch {}

    const firstFencedObject = extractFirstJsonObject(fencedText);
    if (firstFencedObject) return JSON.parse(firstFencedObject);
  }

  const firstObject = extractFirstJsonObject(raw);
  if (firstObject) return JSON.parse(firstObject);

  throw new Error(`Could not parse Gemini JSON: ${raw.slice(0, 800)}`);
}

function extractFirstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return null;
}

function normalizeAnalysis(analysis, page, period) {
  const qualification = analysis?.preliminary_qualification && typeof analysis.preliminary_qualification === 'object'
    ? analysis.preliminary_qualification
    : page.qualification_basic;

  const caseNumbers = Array.isArray(analysis?.case_numbers) && analysis.case_numbers.length
    ? analysis.case_numbers
    : page.case_numbers_basic || [];

  return {
    case_start_key: normalizeUrlKey(page.url) || sha256Text(`${page.title}|${page.date_from}`),
    period_mode: period.mode,
    period_from: period.from,
    period_to: period.to,

    publication_date: String(page.date_from || '').slice(0, 10) || null,
    publication_datetime: page.date_from || null,
    timeline_day: page.timeline_day || null,

    title: page.page_title || page.title || null,
    timeline_title: page.title || null,
    url: page.url,

    source: page.source || null,
    tags: page.tags || [],

    is_pharma_market: Boolean(analysis?.is_pharma_market),
    sector: analysis?.sector || 'other',
    case_numbers: caseNumbers,
    potential_violation_subjects: Array.isArray(analysis?.potential_violation_subjects)
      ? analysis.potential_violation_subjects.filter(Boolean)
      : [],
    preliminary_qualification: {
      law: qualification?.law || null,
      article: qualification?.article || null,
      point: qualification?.point || null,
      text: qualification?.text || 'Не зазначено в повідомленні'
    },
    short_description: analysis?.short_description || page.summary_basic || null,
    risk_comment: analysis?.risk_comment || null,
    confidence: analysis?.confidence || null,

    page_text_sha256: page.text_sha256,
    analyzed_at: new Date().toISOString(),
    analysis: {
      model: SKIP_GEMINI ? null : GEMINI_MODEL,
      skipped: SKIP_GEMINI,
      analyzed_at: new Date().toISOString()
    }
  };
}

function mergeResults(existing, additions) {
  const map = new Map();

  for (const row of existing || []) {
    if (!row?.case_start_key) continue;
    map.set(row.case_start_key, row);
  }

  for (const row of additions || []) {
    if (!row?.case_start_key) continue;
    map.set(row.case_start_key, row);
  }

  return [...map.values()].sort((a, b) =>
    String(b.publication_datetime || '').localeCompare(String(a.publication_datetime || ''), 'uk')
  );
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainList(values, fallback = 'Не зазначено') {
  if (!Array.isArray(values) || !values.length) return fallback;
  return values.filter(Boolean).join('; ');
}

function qualificationText(row) {
  return row?.preliminary_qualification?.text || 'Не зазначено в повідомленні';
}

function sectorLabel(value) {
  const map = {
    medicines: 'лікарські засоби',
    dietary_supplements: 'дієтичні добавки',
    medical_devices: 'медичні вироби',
    pharmacy_retail: 'аптечний ритейл',
    distribution: 'дистрибуція / опт',
    manufacturing: 'виробництво',
    mixed: 'змішаний фармсектор',
    other: 'інше / потребує перевірки'
  };

  return map[value] || value || 'інше / потребує перевірки';
}

function renderEmailText({ period, relevantRows, allItemsCount, candidateCount }) {
  const header = [
    `${EMAIL_SUBJECT_PREFIX}`,
    `Період: ${period.label}`,
    `Усього повідомлень про початок розгляду справи: ${allItemsCount}`,
    `Фарм-кандидатів після keyword-фільтра: ${candidateCount}`,
    `Релевантних справ: ${relevantRows.length}`,
    ''
  ].join('\n');

  if (!relevantRows.length) {
    return `${header}За період не виявлено релевантних повідомлень щодо учасників фармринку.`;
  }

  const body = relevantRows.map((row, index) => [
    `${index + 1}. ${row.title || row.timeline_title || 'Без назви'}`,
    `Дата публікації: ${formatDateUk(row.publication_date)}`,
    `Справи: ${plainList(row.case_numbers)}`,
    `Суб'єкти: ${plainList(row.potential_violation_subjects)}`,
    `Сектор: ${sectorLabel(row.sector)}`,
    `Попередня кваліфікація: ${qualificationText(row)}`,
    `Короткий опис: ${row.short_description || 'Не зазначено'}`,
    `Коментар: ${row.risk_comment || '—'}`,
    `Джерело: ${row.url}`
  ].join('\n')).join('\n\n---\n\n');

  return header + body;
}

function renderEmailHtml({ period, relevantRows, allItemsCount, candidateCount }) {
  const cards = relevantRows.length
    ? relevantRows.map((row, index) => `
      <div style="border:1px solid #d9e2ef;border-radius:12px;padding:14px 16px;margin:14px 0;background:#fff;">
        <h3 style="margin:0 0 8px 0;font-size:16px;line-height:1.35;">${index + 1}. ${htmlEscape(row.title || row.timeline_title || 'Без назви')}</h3>

        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;line-height:1.45;">
          <tr>
            <td style="width:190px;color:#6b7280;padding:4px 0;">Дата публікації</td>
            <td style="padding:4px 0;"><b>${htmlEscape(formatDateUk(row.publication_date))}</b></td>
          </tr>
          <tr>
            <td style="color:#6b7280;padding:4px 0;">Справи</td>
            <td style="padding:4px 0;">${htmlEscape(plainList(row.case_numbers))}</td>
          </tr>
          <tr>
            <td style="color:#6b7280;padding:4px 0;">Суб'єкти</td>
            <td style="padding:4px 0;"><b>${htmlEscape(plainList(row.potential_violation_subjects))}</b></td>
          </tr>
          <tr>
            <td style="color:#6b7280;padding:4px 0;">Сектор</td>
            <td style="padding:4px 0;">${htmlEscape(sectorLabel(row.sector))}</td>
          </tr>
          <tr>
            <td style="color:#6b7280;padding:4px 0;">Попередня кваліфікація</td>
            <td style="padding:4px 0;">${htmlEscape(qualificationText(row))}</td>
          </tr>
        </table>

        <p style="margin:12px 0 4px 0;"><b>Короткий опис</b></p>
        <p style="margin:0 0 10px 0;">${htmlEscape(row.short_description || 'Не зазначено')}</p>

        ${row.risk_comment ? `
          <p style="margin:10px 0 4px 0;"><b>Коментар щодо ризику / моніторингу</b></p>
          <p style="margin:0 0 10px 0;">${htmlEscape(row.risk_comment)}</p>
        ` : ''}

        <p style="margin:10px 0 0 0;">
          <a href="${htmlEscape(row.url)}" target="_blank" rel="noopener">Відкрити повідомлення на сайті АМКУ</a>
        </p>
      </div>
    `).join('\n')
    : `<p>За період не виявлено релевантних повідомлень щодо учасників фармринку.</p>`;

  return `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.45;background:#f8fafc;padding:0;margin:0;">
  <div style="max-width:860px;margin:0 auto;background:#ffffff;padding:22px;">
    <h2 style="margin:0 0 10px 0;">${htmlEscape(EMAIL_SUBJECT_PREFIX)}</h2>
    <p style="margin:0 0 14px 0;color:#4b5563;">
      Період: <b>${htmlEscape(period.label)}</b>
    </p>

    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 18px 0;background:#f9fafb;">
      <div>Усього повідомлень про початок розгляду справи: <b>${allItemsCount}</b></div>
      <div>Фарм-кандидатів після keyword-фільтра: <b>${candidateCount}</b></div>
      <div>Релевантних справ: <b>${relevantRows.length}</b></div>
    </div>

    ${cards}
  </div>
</body>
</html>`;
}

async function sendEmailDigest({ period, relevantRows, allItemsCount, candidateCount }) {
  if (!SEND_EMAIL) {
    console.log('Email skipped: SEND_EMAIL=false.');
    return false;
  }

  if (!relevantRows.length && !SEND_EMPTY_EMAIL) {
    console.log('Email skipped: no relevant rows and SEND_EMPTY_EMAIL=false.');
    return false;
  }

  if (DRY_RUN) {
    console.log('Email skipped: DRY_RUN=true.');
    return false;
  }

  const emailTo = process.env.EMAIL_TO;
  if (!emailTo) {
    console.log('Email skipped: EMAIL_TO is not configured.');
    return false;
  }

  const nodemailer = await import('nodemailer');

  const transporter = nodemailer.default.createTransport({
    host: env('SMTP_HOST', 'smtp.gmail.com'),
    port: intEnv('SMTP_PORT', 465),
    secure: boolEnv('SMTP_SECURE', true),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const subject = relevantRows.length
    ? `${EMAIL_SUBJECT_PREFIX}: ${relevantRows.length} за ${period.label}`
    : `${EMAIL_SUBJECT_PREFIX}: не виявлено за ${period.label}`;

  await transporter.sendMail({
    from: env('EMAIL_FROM', process.env.SMTP_USER || ''),
    to: emailTo,
    subject,
    text: renderEmailText({ period, relevantRows, allItemsCount, candidateCount }),
    html: renderEmailHtml({ period, relevantRows, allItemsCount, candidateCount })
  });

  console.log(`Email sent to ${emailTo}`);
  return true;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const period = resolvePeriod();
  const digestKey = `${period.mode}:${period.from}:${period.to}`;

  const state = await readJson(STATE_PATH, {
    sent_digests: {},
    seen_urls: {},
    last_run: null
  });

  state.sent_digests ||= {};
  state.seen_urls ||= {};

  const existingResults = await readJson(RESULTS_PATH, []);

  console.log(`AMCU pharma case starts digest`);
  console.log(`Period: ${period.mode} ${period.from}..${period.to}`);
  console.log(`Digest key: ${digestKey}`);

  if (state.sent_digests[digestKey] && !FORCE_SEND) {
    console.log(`Digest already sent for ${digestKey}. Set FORCE_SEND=true to resend.`);
    return;
  }

  const timelineItems = await fetchTimelineItems(period);
  console.log(`Timeline items: ${timelineItems.length}`);

  const preparedPages = [];
  const relevantRows = [];
  let geminiCalls = 0;

  for (const item of timelineItems) {
    try {
      const page = await fetchAndPreparePage(item);
      preparedPages.push(page);

      state.seen_urls[normalizeUrlKey(item.url)] = {
        title: item.title,
        url: item.url,
        first_seen_at: state.seen_urls[normalizeUrlKey(item.url)]?.first_seen_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      };

      if (!page.pharma_candidate) {
        console.log(`Skipped non-pharma candidate: ${item.title}`);
        continue;
      }

      if (geminiCalls >= MAX_GEMINI_CALLS) {
        console.warn(`Gemini budget exceeded: ${geminiCalls}/${MAX_GEMINI_CALLS}. Skipping AI for ${item.url}`);
        await appendEvent({
          type: 'gemini_budget_exceeded',
          url: item.url,
          max_gemini_calls: MAX_GEMINI_CALLS
        });
        continue;
      }

      geminiCalls += 1;

      const analysis = await analyzeWithGemini(page);

      if (!analysis?.is_pharma_market) {
        console.log(`Gemini marked as non-pharma: ${item.title}`);
        continue;
      }

      const row = normalizeAnalysis(analysis, page, period);
      relevantRows.push(row);

      console.log(`Relevant pharma case: ${row.title || row.url}`);
    } catch (err) {
      console.error(`Item error: ${item.url}: ${err.message}`);

      await appendEvent({
        type: 'item_error',
        url: item.url,
        title: item.title,
        error: String(err.message || err).slice(0, 1500)
      });
    }
  }

  const merged = mergeResults(existingResults, relevantRows);

  let emailSent = false;

  if (!state.sent_digests[digestKey] || FORCE_SEND) {
    emailSent = await sendEmailDigest({
      period,
      relevantRows,
      allItemsCount: timelineItems.length,
      candidateCount: preparedPages.filter((p) => p.pharma_candidate).length
    });
  }

  state.last_run = {
    at: new Date().toISOString(),
    period,
    digest_key: digestKey,
    timeline_items: timelineItems.length,
    pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length,
    relevant_rows: relevantRows.length,
    gemini_calls: geminiCalls,
    email_sent: emailSent,
    settings: {
      period_mode: PERIOD_MODE,
      skip_gemini: SKIP_GEMINI,
      max_gemini_calls: MAX_GEMINI_CALLS,
      send_email: SEND_EMAIL,
      send_empty_email: SEND_EMPTY_EMAIL,
      force_send: FORCE_SEND
    }
  };

  if (emailSent || (!relevantRows.length && SEND_EMPTY_EMAIL && SEND_EMAIL && !DRY_RUN)) {
    state.sent_digests[digestKey] = {
      sent_at: new Date().toISOString(),
      relevant_count: relevantRows.length,
      timeline_items: timelineItems.length,
      pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length
    };
  }

  console.log(`Relevant rows: ${relevantRows.length}`);
  console.log(`Gemini calls used: ${geminiCalls}/${MAX_GEMINI_CALLS}`);

  if (!DRY_RUN) {
    await writeJson(RESULTS_PATH, merged);
    await writeJson(STATE_PATH, state);
  } else {
    console.log('DRY_RUN=true: files were not written.');
  }
}

main().catch(async (err) => {
  console.error(err);

  try {
    await appendEvent({
      type: 'fatal_error',
      error: String(err.message || err).slice(0, 2000)
    });
  } catch {}

  process.exit(1);
});
