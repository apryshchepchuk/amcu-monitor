import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');

const RESULTS_PATH = path.join(DATA_DIR, 'amku_pharma_events.json');
const STATE_PATH = path.join(DATA_DIR, 'amku_pharma_events_state.json');
// No persistent diagnostics/event log: keep the repository compact.

const TIMELINE_API_URL = env('TIMELINE_API_URL', 'https://amcu.gov.ua/api/timeline');
const TIMELINE_LANG = env('TIMELINE_LANG', 'uk');

const AMCU_ORIGIN = new URL(TIMELINE_API_URL).origin;

const AMCU_SESSION = {
  bootstrapped: false,
  cookies: new Map(),
  csrfToken: null
};

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

const EMAIL_SUBJECT_PREFIX = env('EMAIL_SUBJECT_PREFIX', 'Щотижневий дайджест фарм-подій АМКУ');
const PRACTICE_DB_URL = env('PRACTICE_DB_URL', 'https://apryshchepchuk.github.io/amcu-monitor/amku/');

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
  // Diagnostics are intentionally not persisted to a separate repository file.
  console.log(`EVENT ${event?.type || 'event'}: ${JSON.stringify(event)}`);
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

function extractJsonLdArticleBody(html) {
  const bodies = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  function visit(value) {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (typeof value !== 'object') return;

    if (typeof value.articleBody === 'string') {
      const text = normalizeSpaces(stripTags(value.articleBody));
      if (text.length >= 60) bodies.push(text);
    }

    for (const nested of Object.values(value)) {
      if (nested && (Array.isArray(nested) || typeof nested === 'object')) visit(nested);
    }
  }

  for (const match of String(html || '').matchAll(re)) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;

    try {
      visit(JSON.parse(raw));
      continue;
    } catch {}

    try {
      visit(JSON.parse(decodeHtmlEntities(raw)));
    } catch {}
  }

  if (!bodies.length) return '';
  return bodies.sort((a, b) => b.length - a.length)[0];
}

function removeSemanticNoise(html) {
  return String(html || '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form>/gi, ' ');
}

function truncateKnownSiteTail(text) {
  const s = normalizeSpaces(text);
  if (s.length < 300) return s;

  const tailMarkers = [
    /(?:^|\n)\s*Останні новини\b/i,
    /(?:^|\n)\s*Інші новини\b/i,
    /(?:^|\n)\s*Схожі новини\b/i,
    /(?:^|\n)\s*Схожі матеріали\b/i,
    /(?:^|\n)\s*Читайте також\b/i,
    /(?:^|\n)\s*Рекомендовані матеріали\b/i,
    /(?:^|\n)\s*Усі новини\b/i,
    /(?:^|\n)\s*Усі рішення\b/i,
    /(?:^|\n)\s*Підписатися\b/i,
    /(?:^|\n)\s*Поділитися\b/i
  ];

  let cutAt = s.length;

  for (const re of tailMarkers) {
    const m = re.exec(s);
    if (m && m.index >= 250) cutAt = Math.min(cutAt, m.index);
  }

  return s.slice(0, cutAt).trim();
}

function extractContentText(html) {
  const jsonLdBody = extractJsonLdArticleBody(html);
  if (jsonLdBody) {
    return {
      text: truncateKnownSiteTail(jsonLdBody),
      source: 'jsonld_article_body'
    };
  }

  const article = extractBetween(html, 'article');
  const articleText = truncateKnownSiteTail(normalizeSpaces(stripTags(removeSemanticNoise(article))));
  if (articleText.length >= 60) {
    return {
      text: articleText,
      source: 'article_tag'
    };
  }

  const main = extractBetween(html, 'main');
  const mainText = truncateKnownSiteTail(normalizeSpaces(stripTags(removeSemanticNoise(main))));
  if (mainText.length >= 60) {
    return {
      text: mainText,
      source: 'main_fallback'
    };
  }

  const body = extractBetween(html, 'body');
  const bodyText = truncateKnownSiteTail(normalizeSpaces(stripTags(removeSemanticNoise(body || html))));

  return {
    text: bodyText,
    source: 'body_fallback'
  };
}

function findPharmaSignals(text) {
  const s = normalizeSpaces(text);
  return PHARMA_PATTERNS
    .filter((re) => re.test(s))
    .map((re) => re.source);
}

function hasPharmaSignals(text) {
  return findPharmaSignals(text).length > 0;
}

function buildTimelineUrl(page, period) {
  const url = new URL(TIMELINE_API_URL);
  url.searchParams.set('page', String(page));
  url.searchParams.set('type', 'all');
  url.searchParams.set('date_from', formatApiDate(period.from));
  url.searchParams.set('date_to', formatApiDate(period.to));
  url.searchParams.set('lang', TIMELINE_LANG);
  return url.toString();
}

function isAmcuUrl(url) {
  try {
    return new URL(url).origin === AMCU_ORIGIN;
  } catch {
    return false;
  }
}

function splitSetCookieHeader(value) {
  if (!value) return [];

  return String(value)
    .split(/,(?=\s*[^;,]+=)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const combined = headers.get('set-cookie');
  return splitSetCookieHeader(combined);
}

function storeResponseCookies(res) {
  const setCookies = getSetCookieHeaders(res.headers);

  for (const header of setCookies) {
    const firstPart = String(header).split(';')[0];
    const eq = firstPart.indexOf('=');
    if (eq <= 0) continue;

    const name = firstPart.slice(0, eq).trim();
    const value = firstPart.slice(eq + 1).trim();

    if (name) AMCU_SESSION.cookies.set(name, value);
  }
}

function buildCookieHeader() {
  return [...AMCU_SESSION.cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function getCookieValue(name) {
  return AMCU_SESSION.cookies.get(name) || null;
}

function decodeCookieValue(value) {
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractCsrfFromHtml(html) {
  const s = String(html || '');

  const meta = s.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  if (meta?.[1]) return meta[1];

  const input = s.match(/<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']/i);
  if (input?.[1]) return input[1];

  return null;
}

function extractCsrfFromJsonOrText(text) {
  const raw = String(text || '').trim();

  try {
    const json = JSON.parse(raw);

    if (typeof json === 'string') {
      return json.trim() || null;
    }

    if (json && typeof json === 'object') {
      return (
        json.csrfToken
        || json.csrf_token
        || json.csrf
        || json.token
        || json._token
        || json.data?.csrfToken
        || json.data?.csrf_token
        || json.data?.csrf
        || json.data?.token
        || null
      );
    }
  } catch {}

  const cleaned = raw.replace(/^"+|"+$/g, '').trim();

  if (cleaned && cleaned.length >= 20 && !cleaned.includes('<')) {
    return cleaned;
  }

  return null;
}

async function rawAmcuFetch(url, options = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(options.headers || {})
  };

  const cookie = buildCookieHeader();
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers
  });

  storeResponseCookies(res);
  return res;
}

async function bootstrapAmcuSession() {
  if (AMCU_SESSION.bootstrapped) return;

  console.log('Bootstrapping AMCU CSRF session...');

  const timelinePageUrl = `${AMCU_ORIGIN}/timeline`;

  const timelineRes = await rawAmcuFetch(timelinePageUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const timelineHtml = await timelineRes.text().catch(() => '');
  const htmlToken = extractCsrfFromHtml(timelineHtml);

  if (htmlToken) {
    AMCU_SESSION.csrfToken = htmlToken;
  }

  const csrfCandidateUrls = [
    `${AMCU_ORIGIN}/csrf-token`,
    `${AMCU_ORIGIN}/api/csrf-token`,
    `${AMCU_ORIGIN}/sanctum/csrf-cookie`
  ];

  for (const csrfUrl of csrfCandidateUrls) {
    try {
      const res = await rawAmcuFetch(csrfUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: timelinePageUrl,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      const body = await res.text().catch(() => '');

      if (!res.ok) {
        console.log(`CSRF candidate skipped: ${csrfUrl} -> HTTP ${res.status}`);
        continue;
      }

      const tokenFromBody = extractCsrfFromJsonOrText(body);
      const tokenFromCookie = decodeCookieValue(getCookieValue('XSRF-TOKEN'));

      AMCU_SESSION.csrfToken = tokenFromBody || tokenFromCookie || AMCU_SESSION.csrfToken;

      if (AMCU_SESSION.csrfToken) {
        console.log(`CSRF candidate accepted with token: ${csrfUrl}`);
        break;
      }

      console.log(`CSRF candidate responded but no token found: ${csrfUrl}`);
    } catch (err) {
      console.log(`CSRF candidate failed: ${csrfUrl}: ${String(err.message || err).slice(0, 300)}`);
    }
  }

  const tokenFromCookie = decodeCookieValue(getCookieValue('XSRF-TOKEN'));
  if (!AMCU_SESSION.csrfToken && tokenFromCookie) {
    AMCU_SESSION.csrfToken = tokenFromCookie;
  }

  AMCU_SESSION.bootstrapped = true;

  console.log(
    `AMCU session ready: cookies=${AMCU_SESSION.cookies.size}, `
    + `csrf=${AMCU_SESSION.csrfToken ? 'yes' : 'no'}`
  );
}

function resetAmcuSession() {
  AMCU_SESSION.bootstrapped = false;
  AMCU_SESSION.cookies = new Map();
  AMCU_SESSION.csrfToken = null;
}

async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || MAX_FETCH_RETRIES;
  const baseDelayMs = options.baseDelayMs || 3500;
  const label = options.label || url;
  const amcuRequest = isAmcuUrl(url);

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (amcuRequest) {
        await bootstrapAmcuSession();
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': options.accept || 'application/json, text/plain, */*',
        'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(options.headers || {})
      };

      if (amcuRequest) {
        headers.Referer = `${AMCU_ORIGIN}/timeline`;
        headers.Origin = AMCU_ORIGIN;
        headers['X-Requested-With'] = 'XMLHttpRequest';

        const cookie = buildCookieHeader();
        if (cookie) headers.Cookie = cookie;

        const xsrfToken = decodeCookieValue(getCookieValue('XSRF-TOKEN'));
        if (AMCU_SESSION.csrfToken) headers['X-CSRF-TOKEN'] = AMCU_SESSION.csrfToken;
        if (xsrfToken || AMCU_SESSION.csrfToken) headers['X-XSRF-TOKEN'] = xsrfToken || AMCU_SESSION.csrfToken;
      }

      const res = await fetch(url, { headers });

      if (amcuRequest) {
        storeResponseCookies(res);
      }

      if (res.ok) return res;

      const bodyText = await res.text().catch(() => '');
      const message =
        `HTTP ${res.status} for ${label}. `
        + `URL: ${url}. `
        + `Body: ${bodyText.slice(0, 700)}`;

      if (/CSRF token mismatch/i.test(bodyText) && attempt < attempts) {
        console.warn('AMCU CSRF mismatch detected. Resetting session and retrying...');
        resetAmcuSession();
        lastError = new Error(message);
      } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(message);
      } else {
        lastError = new Error(message);
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < attempts) {
      const delayMs = baseDelayMs * attempt;
      console.warn(
        `Fetch failed (${attempt}/${attempts}) for ${label}: `
        + `${String(lastError?.message || lastError).slice(0, 1000)}. `
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
    accept: 'application/json, text/plain, */*'
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
    console.log(`Timeline request URL: ${url}`);
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
  const content = extractContentText(html);
  const bodyText = content.text;
  const combinedText = normalizeSpaces([
    item.title,
    item.excerpt,
    pageTitle,
    bodyText
  ].filter(Boolean).join('\n\n'));

  const pharmaSignals = findPharmaSignals(combinedText);
  const pharmaCandidate = pharmaSignals.length > 0;

  return {
    ...item,
    page_title: pageTitle,
    body_text: bodyText,
    content_source: content.source,
    body_text_chars: bodyText.length,
    combined_text: combinedText,
    text_sha256: sha256Text(combinedText),
    pharma_candidate: pharmaCandidate,
    pharma_signals: pharmaSignals,
    case_numbers_basic: extractCaseNumbers(combinedText),
    qualification_basic: extractBasicQualification(combinedText),
    summary_basic: extractFallbackSummary(combinedText)
  };
}

function buildGeminiPrompt(page) {
  const text = String(page.combined_text || '').slice(0, MAX_PAGE_TEXT_CHARS);

  return `Ти юрист-аналітик у сфері конкурентного права та фармацевтичного ринку України.

Проаналізуй матеріал офіційного сайту Антимонопольного комітету України.

Мета моніторингу — виявляти події АМКУ, які стосуються фармацевтичного ринку, зокрема:
- початок розгляду справ;
- рішення у справах / встановлення або невстановлення порушення;
- накладення штрафів;
- надання рекомендацій;
- інші суттєві процесуальні або правозастосовні події, безпосередньо пов'язані з фармринком.

До фармринку віднось лікарські засоби, дієтичні добавки, медичні вироби, аптеки/аптечний ритейл,
дистрибуцію/оптову торгівлю, виробництво, імпорт, реєстрацію та промоцію такої продукції.
Рекомендації органам влади також є релевантними, якщо їх предмет прямо стосується фармринку.

ВАЖЛИВО:
1. Одна вебсторінка може містити кілька окремих рішень/справ. Поверни окремий event для КОЖНОЇ фарм-релевантної події.
2. Не повертай нерелевантні нефaрмацевтичні рішення з тієї самої сторінки.
3. Не вигадуй номер справи, номер/дату рішення, суму штрафу, суб'єктів або кваліфікацію.
4. Якщо новина повідомляє про штраф як наслідок рішення у справі, класифікуй подію як case_decided, а штраф відобрази окремими полями.
5. case_started — розпочато розгляд справи.
6. case_decided — прийнято рішення по суті справи / встановлено або не встановлено порушення / закрито справу / накладено штраф.
7. recommendation_issued — АМКУ надав рекомендації компанії, органу влади або іншому адресату.
8. other_relevant — лише якщо подія прямо стосується правозастосування/розгляду АМКУ у фармсекторі, але не підпадає під попередні типи.

Поверни виключно валідний JSON без Markdown.

Очікувана структура:
{
  "is_pharma_relevant": true,
  "events": [
    {
      "event_type": "case_started | case_decided | recommendation_issued | other_relevant",
      "sector": "medicines | dietary_supplements | medical_devices | pharmacy_retail | distribution | manufacturing | mixed | other",
      "case_numbers": [],
      "decision_number": null,
      "decision_date": null,
      "subjects": [],
      "recommendation_addressees": [],
      "qualification": {
        "law": null,
        "article": null,
        "point": null,
        "text": null
      },
      "outcome": "violation_found | no_violation | case_closed | recommendation | other | unknown",
      "fine_imposed": false,
      "fine_amount_uah": null,
      "short_description": "",
      "confidence": "high | medium | low"
    }
  ]
}

Якщо матеріал не містить жодної фарм-релевантної події, поверни:
{"is_pharma_relevant": false, "events": []}

Службові дані:
- Timeline title: ${page.title || ''}
- Page title: ${page.page_title || ''}
- URL: ${page.url || ''}
- Source tags: ${(page.tags || []).join(', ') || 'none'}
- Basic detected case numbers: ${(page.case_numbers_basic || []).join(', ') || 'none'}
- Basic detected qualification: ${page.qualification_basic?.text || 'none'}

Текст матеріалу:
${text}`;
}

async function analyzeWithGemini(page) {
  if (SKIP_GEMINI) {
    return {
      is_pharma_relevant: page.pharma_candidate,
      events: page.pharma_candidate ? [{
        event_type: 'other_relevant',
        sector: 'other',
        case_numbers: page.case_numbers_basic || [],
        decision_number: null,
        decision_date: null,
        subjects: [],
        recommendation_addressees: [],
        qualification: page.qualification_basic,
        outcome: 'unknown',
        fine_imposed: false,
        fine_amount_uah: null,
        short_description: page.summary_basic || page.page_title || page.title || '',
        confidence: 'low'
      }] : []
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required unless SKIP_GEMINI=true');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildGeminiPrompt(page) }] }],
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
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
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

function normalizedStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => normalizeSpaces(x)).filter(Boolean))];
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100) / 100;

  const cleaned = String(value)
    .replace(/\s+/g, '')
    .replace(/грн\.?/gi, '')
    .replace(',', '.')
    .replace(/[^0-9.\-]/g, '');

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeDecisionNumber(value) {
  return normalizeSpaces(value).replace(/^№\s*/u, '') || null;
}

function normalizeEventType(value) {
  const allowed = new Set(['case_started', 'case_decided', 'recommendation_issued', 'other_relevant']);
  return allowed.has(value) ? value : 'other_relevant';
}

function normalizeOutcome(value, eventType) {
  const allowed = new Set(['violation_found', 'no_violation', 'case_closed', 'recommendation', 'other', 'unknown']);
  if (allowed.has(value)) return value;
  if (eventType === 'recommendation_issued') return 'recommendation';
  return 'unknown';
}

function buildEventKey(event, page) {
  const eventType = normalizeEventType(event.event_type);
  const decisionNumber = normalizeDecisionNumber(event.decision_number);
  const decisionDate = String(event.decision_date || '').slice(0, 10);
  const cases = normalizedStringArray(event.case_numbers).sort();

  if (decisionNumber && decisionDate) {
    return `decision|${decisionDate}|${decisionNumber.toLowerCase()}`;
  }

  if (cases.length) {
    return `${eventType}|case|${cases.join('|').toLowerCase()}`;
  }

  // Conservative fallback: do not merge different source pages unless we have a legal identifier.
  const urlKey = normalizeUrlKey(page.url) || sha256Text(`${page.title}|${page.date_from}`);
  const ordinal = Number.isInteger(event.__ordinal) ? event.__ordinal : 0;
  return `${eventType}|url|${urlKey}|${ordinal}`;
}

function normalizeEvents(analysis, page, period) {
  const rawEvents = Array.isArray(analysis?.events) ? analysis.events : [];
  const normalized = [];

  rawEvents.forEach((rawEvent, index) => {
    if (!rawEvent || typeof rawEvent !== 'object') return;

    const eventType = normalizeEventType(rawEvent.event_type);
    const qualification = rawEvent.qualification && typeof rawEvent.qualification === 'object'
      ? rawEvent.qualification
      : page.qualification_basic;

    const eventWithOrdinal = { ...rawEvent, __ordinal: index };
    const row = {
      event_key: buildEventKey(eventWithOrdinal, page),
      event_type: eventType,
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
      source_tags: page.tags || [],

      sector: rawEvent.sector || 'other',
      case_numbers: normalizedStringArray(rawEvent.case_numbers?.length ? rawEvent.case_numbers : page.case_numbers_basic),
      decision_number: normalizeDecisionNumber(rawEvent.decision_number),
      decision_date: rawEvent.decision_date ? String(rawEvent.decision_date).slice(0, 10) : null,
      subjects: normalizedStringArray(rawEvent.subjects),
      recommendation_addressees: normalizedStringArray(rawEvent.recommendation_addressees),
      qualification: {
        law: qualification?.law || null,
        article: qualification?.article || null,
        point: qualification?.point || null,
        text: qualification?.text || 'Не зазначено в повідомленні'
      },
      outcome: normalizeOutcome(rawEvent.outcome, eventType),
      fine_imposed: Boolean(rawEvent.fine_imposed),
      fine_amount_uah: normalizeMoney(rawEvent.fine_amount_uah),
      short_description: normalizeSpaces(rawEvent.short_description || page.summary_basic || ''),
      confidence: rawEvent.confidence || null,

      page_text_sha256: page.text_sha256,
      analyzed_at: new Date().toISOString(),
      analysis: {
        model: SKIP_GEMINI ? null : GEMINI_MODEL,
        skipped: SKIP_GEMINI,
        analyzed_at: new Date().toISOString()
      }
    };

    normalized.push(row);
  });

  return normalized;
}

function mergeResults(existing, additions) {
  const map = new Map();

  for (const row of existing || []) {
    if (!row?.event_key) continue;
    map.set(row.event_key, row);
  }

  for (const row of additions || []) {
    if (!row?.event_key) continue;
    // A newer source page can enrich the same identified legal event.
    const prev = map.get(row.event_key);
    if (!prev || String(row.publication_datetime || '') >= String(prev.publication_datetime || '')) {
      map.set(row.event_key, row);
    }
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
  return row?.qualification?.text || 'Не зазначено в повідомленні';
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

function eventTypeLabel(type) {
  const map = {
    case_started: 'Розпочато справу',
    case_decided: 'Прийнято рішення',
    recommendation_issued: 'Надано рекомендації',
    other_relevant: 'Інша релевантна подія'
  };
  return map[type] || type;
}

function eventTypeHeading(type) {
  const map = {
    case_started: 'Розпочато справи',
    case_decided: 'Прийнято рішення',
    recommendation_issued: 'Надано рекомендації',
    other_relevant: 'Інші релевантні події'
  };
  return map[type] || type;
}

function outcomeLabel(value) {
  const map = {
    violation_found: 'Порушення встановлено',
    no_violation: 'Порушення не встановлено',
    case_closed: 'Справу закрито',
    recommendation: 'Надано рекомендації',
    other: 'Інший результат',
    unknown: 'Результат не визначено'
  };
  return map[value] || value || 'Результат не визначено';
}

function formatMoneyUah(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(Number(value))} грн`;
}

function periodIntro(period) {
  const from = formatDateUk(period.from);
  const to = formatDateUk(period.to);
  if (period.mode === 'monthly') return `За місяць з ${from} по ${to}`;
  if (period.mode === 'custom') return `За період з ${from} по ${to}`;
  return `За тиждень з ${from} по ${to}`;
}

function formatCaseNumbers(values) {
  if (!Array.isArray(values) || !values.length) return 'не зазначено';
  return values.map((v) => String(v).trim().replace(/^№\s*/u, '')).map((v) => `№ ${v}`).join(', ');
}

function sourceLinkLabel() {
  return 'Відкрити матеріал АМКУ';
}

function practiceDbFooterText() {
  return [
    'Моніторинг охоплює публічні матеріали АМКУ, відібрані як релевантні фармацевтичному ринку.',
    'Для аналізу вже сформованої практики доступна База практики АМКУ:',
    PRACTICE_DB_URL
  ].join('\n');
}

function practiceDbFooterHtml() {
  return `
    <div style="margin:24px 0 0 0;padding:14px 0 0 0;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:13px;line-height:1.5;color:#374151;">
        Моніторинг охоплює публічні матеріали АМКУ, відібрані як релевантні фармацевтичному ринку.
        Для аналізу вже сформованої практики доступна
        <a href="${htmlEscape(PRACTICE_DB_URL)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;">
          База практики АМКУ
        </a>.
      </p>
    </div>
  `;
}

function groupEvents(rows) {
  const order = ['case_started', 'case_decided', 'recommendation_issued', 'other_relevant'];
  return order
    .map((type) => [type, (rows || []).filter((r) => r.event_type === type)])
    .filter(([, items]) => items.length);
}

function renderEventText(row, index) {
  const lines = [
    `${index + 1}. ${formatDateUk(row.publication_date)} — ${eventTypeLabel(row.event_type)}`,
    `Суб’єкт/адресат: ${plainList(row.event_type === 'recommendation_issued' ? row.recommendation_addressees : row.subjects)}`,
    `Сектор: ${sectorLabel(row.sector)}`
  ];

  if (row.case_numbers?.length) lines.push(`Справа: ${formatCaseNumbers(row.case_numbers)}`);
  if (row.decision_number) lines.push(`Рішення: № ${row.decision_number}${row.decision_date ? ` від ${formatDateUk(row.decision_date)}` : ''}`);
  if (row.event_type === 'case_decided') lines.push(`Результат: ${outcomeLabel(row.outcome)}`);
  if (row.fine_imposed) lines.push(`Штраф: ${formatMoneyUah(row.fine_amount_uah) || 'накладено, сума не визначена'}`);
  if (qualificationText(row) !== 'Не зазначено в повідомленні') lines.push(`Кваліфікація: ${qualificationText(row)}`);
  lines.push('', row.short_description || 'Без опису', '', `Джерело: ${row.url}`);
  return lines.join('\n');
}

function renderEmailText({ period, relevantRows }) {
  const header = `${periodIntro(period)} виявлено ${relevantRows.length} фарм-релевантних подій АМКУ.`;
  const groups = groupEvents(relevantRows);

  if (!relevantRows.length) {
    return [EMAIL_SUBJECT_PREFIX, '', header, '', 'Релевантних подій за цей період не виявлено.', '', practiceDbFooterText()].join('\n');
  }

  const body = groups.map(([type, rows]) => {
    const items = rows.map((row, index) => renderEventText(row, index)).join('\n\n---\n\n');
    return `${eventTypeHeading(type)} — ${rows.length}\n\n${items}`;
  }).join('\n\n====================\n\n');

  return [EMAIL_SUBJECT_PREFIX, '', header, '', body, '', practiceDbFooterText()].join('\n');
}

function renderEventHtml(row, index) {
  const actorValues = row.event_type === 'recommendation_issued' ? row.recommendation_addressees : row.subjects;
  const extra = [];

  if (row.case_numbers?.length) extra.push(`<p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Справа:</strong> ${htmlEscape(formatCaseNumbers(row.case_numbers))}</p>`);
  if (row.decision_number) extra.push(`<p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Рішення:</strong> № ${htmlEscape(row.decision_number)}${row.decision_date ? ` від ${htmlEscape(formatDateUk(row.decision_date))}` : ''}</p>`);
  if (row.event_type === 'case_decided') extra.push(`<p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Результат:</strong> ${htmlEscape(outcomeLabel(row.outcome))}</p>`);
  if (row.fine_imposed) extra.push(`<p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Штраф:</strong> ${htmlEscape(formatMoneyUah(row.fine_amount_uah) || 'накладено, сума не визначена')}</p>`);
  if (qualificationText(row) !== 'Не зазначено в повідомленні') extra.push(`<p style="margin:0 0 8px 0;font-size:14px;line-height:1.5;"><strong>Кваліфікація:</strong> ${htmlEscape(qualificationText(row))}</p>`);

  return `
    <div style="margin:18px 0 0 0;padding:0 0 18px 0;border-bottom:1px solid #e5e7eb;">
      <p style="margin:0 0 8px 0;font-size:15px;line-height:1.45;"><strong>${index + 1}. ${htmlEscape(formatDateUk(row.publication_date))} — ${htmlEscape(eventTypeLabel(row.event_type))}</strong></p>
      <p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Суб’єкт/адресат:</strong> ${htmlEscape(plainList(actorValues))}</p>
      <p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;"><strong>Сектор:</strong> ${htmlEscape(sectorLabel(row.sector))}</p>
      ${extra.join('\n')}
      <p style="margin:8px 0 10px 0;font-size:14px;line-height:1.5;">${htmlEscape(row.short_description || 'Без опису')}</p>
      <p style="margin:0;font-size:14px;line-height:1.5;"><strong>Джерело:</strong> <a href="${htmlEscape(row.url)}" target="_blank" rel="noopener">${htmlEscape(sourceLinkLabel())}</a></p>
    </div>
  `;
}

function renderEmailHtml({ period, relevantRows }) {
  const header = `${periodIntro(period)} виявлено ${relevantRows.length} фарм-релевантних подій АМКУ.`;
  const groups = groupEvents(relevantRows);

  const body = relevantRows.length
    ? groups.map(([type, rows]) => `
        <div style="margin:24px 0 0 0;">
          <h3 style="margin:0 0 8px 0;font-size:16px;line-height:1.35;">${htmlEscape(eventTypeHeading(type))} — ${rows.length}</h3>
          ${rows.map((row, index) => renderEventHtml(row, index)).join('\n')}
        </div>
      `).join('\n')
    : `<p style="margin:18px 0 0 0;font-size:14px;line-height:1.5;">Релевантних подій за цей період не виявлено.</p>`;

  return `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;background:#ffffff;padding:0;margin:0;">
  <div style="max-width:860px;margin:0 auto;padding:22px 20px;">
    <h2 style="margin:0 0 14px 0;font-size:18px;line-height:1.35;font-weight:700;">${htmlEscape(EMAIL_SUBJECT_PREFIX)}</h2>
    <p style="margin:0 0 18px 0;font-size:14px;line-height:1.5;">${htmlEscape(header)}</p>
    ${body}
    ${practiceDbFooterHtml()}
  </div>
</body>
</html>`;
}

async function sendEmailDigest({ period, relevantRows }) {
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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: env('EMAIL_FROM', process.env.SMTP_USER || ''),
    to: emailTo,
    subject: EMAIL_SUBJECT_PREFIX,
    text: renderEmailText({ period, relevantRows }),
    html: renderEmailHtml({ period, relevantRows })
  });

  console.log(`Email sent to ${emailTo}`);
  return true;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const period = resolvePeriod();
  const digestKey = `${period.mode}:${period.from}:${period.to}`;
  const state = await readJson(STATE_PATH, { sent_digests: {}, seen_urls: {}, last_run: null });
  state.sent_digests ||= {};
  state.seen_urls ||= {};

  const existingResults = await readJson(RESULTS_PATH, []);

  console.log('AMCU pharma events digest');
  console.log(`Period: ${period.mode} ${period.from}..${period.to}`);
  console.log(`Digest key: ${digestKey}`);

  if (state.sent_digests[digestKey] && !FORCE_SEND) {
    console.log(`Digest already sent for ${digestKey}. Set FORCE_SEND=true to resend.`);
    return;
  }

  const timelineItems = await fetchTimelineItems(period);
  console.log(`Timeline items (type=all, no tag filter): ${timelineItems.length}`);

  const preparedPages = [];
  const relevantRows = [];
  const itemErrors = [];
  let geminiCalls = 0;
  let budgetExceeded = false;

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

      console.log(
        `Pharma candidate [source=${page.content_source}, chars=${page.body_text_chars}, signals=${page.pharma_signals.join(', ')}]: ${item.title}`
      );

      if (!SKIP_GEMINI && geminiCalls >= MAX_GEMINI_CALLS) {
        budgetExceeded = true;
        console.warn(`Gemini budget exceeded: ${geminiCalls}/${MAX_GEMINI_CALLS}. Unprocessed pharma candidate: ${item.url}`);
        continue;
      }

      if (!SKIP_GEMINI) geminiCalls += 1;
      const analysis = await analyzeWithGemini(page);

      if (!analysis?.is_pharma_relevant || !Array.isArray(analysis?.events) || !analysis.events.length) {
        console.log(`Gemini marked as no relevant pharma events: ${item.title}`);
        continue;
      }

      const rows = normalizeEvents(analysis, page, period);
      relevantRows.push(...rows);
      console.log(`Relevant pharma events: ${rows.length} from ${page.title || page.url}`);
      for (const row of rows) {
        console.log(`EVENT_FOUND ${row.event_type} | ${row.decision_number || row.case_numbers?.join(', ') || 'no-id'} | ${row.short_description?.slice(0, 240) || ''} | ${row.url}`);
      }
    } catch (err) {
      console.error(`Item error: ${item.url}: ${err.message}`);
      itemErrors.push({ url: item.url, error: String(err.message || err).slice(0, 1000) });
    }
  }

  const runComplete = !budgetExceeded && itemErrors.length === 0;
  const digestRows = mergeResults([], relevantRows);
  const merged = mergeResults(existingResults, digestRows);
  let emailSent = false;

  if (!runComplete) {
    console.warn(`Run incomplete: budgetExceeded=${budgetExceeded}, itemErrors=${itemErrors.length}. Email will NOT be sent and period will NOT be marked as sent.`);
  } else if (!state.sent_digests[digestKey] || FORCE_SEND) {
    emailSent = await sendEmailDigest({ period, relevantRows: digestRows });
  }

  state.last_run = {
    at: new Date().toISOString(),
    period,
    digest_key: digestKey,
    timeline_items: timelineItems.length,
    pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length,
    relevant_events: digestRows.length,
    gemini_calls: geminiCalls,
    email_sent: emailSent,
    technically_complete: runComplete,
    budget_exceeded: budgetExceeded,
    item_errors: itemErrors,
    settings: {
      period_mode: PERIOD_MODE,
      skip_gemini: SKIP_GEMINI,
      max_gemini_calls: MAX_GEMINI_CALLS,
      send_email: SEND_EMAIL,
      send_empty_email: SEND_EMPTY_EMAIL,
      force_send: FORCE_SEND
    }
  };

  if (runComplete && (emailSent || (!relevantRows.length && SEND_EMPTY_EMAIL && SEND_EMAIL && !DRY_RUN))) {
    state.sent_digests[digestKey] = {
      sent_at: new Date().toISOString(),
      relevant_count: digestRows.length,
      timeline_items: timelineItems.length,
      pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length
    };
  }

  console.log(`Pharma candidates: ${preparedPages.filter((p) => p.pharma_candidate).length}`);
  console.log(`Relevant events before event-level dedup: ${relevantRows.length}`);
  console.log(`Relevant events after event-level dedup: ${digestRows.length}`);
  console.log(`Gemini calls used: ${geminiCalls}/${MAX_GEMINI_CALLS}`);
  console.log(`Run technically complete: ${runComplete ? 'YES' : 'NO'}`);

  if (!DRY_RUN) {
    await writeJson(RESULTS_PATH, merged);
    await writeJson(STATE_PATH, state);
  } else {
    console.log('DRY_RUN=true: files were not written.');
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
