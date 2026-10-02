import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
const TEST_EMAIL_SEND = boolEnv('TEST_EMAIL_SEND', false);
const SEND_EMPTY_EMAIL = boolEnv('SEND_EMPTY_EMAIL', true);

const MAX_GEMINI_CALLS = intEnv('MAX_GEMINI_CALLS', 20);
const MAX_PAGE_TEXT_CHARS = intEnv('MAX_PAGE_TEXT_CHARS', 60000);
const MAX_FETCH_RETRIES = intEnv('MAX_FETCH_RETRIES', 4);
const PDF_FALLBACK_ENABLED = boolEnv('PDF_FALLBACK_ENABLED', true);
const PDF_PREFILTER_PAGES = intEnv('PDF_PREFILTER_PAGES', 3);
const MAX_PDFS_PER_PAGE = intEnv('MAX_PDFS_PER_PAGE', 3);
const MAX_PDF_BYTES = intEnv('MAX_PDF_BYTES', 25_000_000);

const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-3.1-flash-lite');
const GEMINI_RETRY_MAX = intEnv('GEMINI_RETRY_MAX', 3);
const GEMINI_RETRY_BUFFER_MS = intEnv('GEMINI_RETRY_BUFFER_MS', 1500);

const EMAIL_SUBJECT_PREFIX = env('EMAIL_SUBJECT_PREFIX', 'Тижневий вісник АМКУ');
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

function extractDivByClass(html, className) {
  const source = String(html || '');
  const wantedClass = String(className || '').trim();
  if (!wantedClass) return '';

  // Find opening <div> tags and inspect the class attribute as tokens.
  // This matches editor-content regardless of whether it is the first,
  // middle, or last class in the attribute.
  const openTagRe = /<div\b[^>]*>/gi;
  let match;

  while ((match = openTagRe.exec(source))) {
    const tag = match[0];
    const classMatch = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    if (!classMatch) continue;

    const classes = String(classMatch[2] || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!classes.includes(wantedClass)) continue;

    const contentStart = match.index + tag.length;
    const tokenRe = /<div\b[^>]*>|<\/div>/gi;
    tokenRe.lastIndex = contentStart;

    let depth = 1;
    let token;

    while ((token = tokenRe.exec(source))) {
      if (/^<div\b/i.test(token[0])) {
        depth += 1;
      } else {
        depth -= 1;
        if (depth === 0) {
          return source.slice(contentStart, token.index);
        }
      }
    }

    return '';
  }

  return '';
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

function trimPrimaryContent(text, pageTitle = '') {
  const rawLines = String(text || '')
    .split(/\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);

  if (!rawLines.length) return '';

  const titleNorm = normalizeSpaces(pageTitle).toLowerCase();
  let start = 0;

  if (titleNorm.length >= 8) {
    const titleIndex = rawLines.findIndex((line) => {
      const normalized = line.toLowerCase();
      return normalized === titleNorm || normalized.includes(titleNorm) || titleNorm.includes(normalized);
    });

    // Keep a few lines before the H1 because NPA pages often place
    // document type/date/number immediately above the title.
    if (titleIndex >= 0) start = Math.max(0, titleIndex - 3);
  }

  const stopPatterns = [
    /^Попередня\b/i,
    /^Наступна\b/i,
    /^Більше за темою\b/i,
    /^Часто шукають\b/i,
    /^Останні новини\b/i,
    /^Інші новини\b/i,
    /^Схожі новини\b/i,
    /^Схожі матеріали\b/i,
    /^Читайте також\b/i,
    /^Рекомендовані матеріали\b/i,
    /^Усі новини\b/i,
    /^Усі рішення\b/i,
    /^Підписатися\b/i,
    /^Мапа порталу\b/i
  ];

  let end = rawLines.length;
  for (let i = start + 1; i < rawLines.length; i += 1) {
    if (stopPatterns.some((re) => re.test(rawLines[i]))) {
      end = i;
      break;
    }
  }

  return normalizeSpaces(rawLines.slice(start, end).join('\n'));
}

function extractContentText(html, pageTitle = '') {
  const jsonLdBody = extractJsonLdArticleBody(html);
  if (jsonLdBody) {
    return {
      text: trimPrimaryContent(jsonLdBody, pageTitle),
      source: 'jsonld_article_body'
    };
  }

  const editorContent = extractDivByClass(html, 'editor-content');
  const editorContentText = normalizeSpaces(stripTags(removeSemanticNoise(editorContent)));
  if (editorContentText.length >= 60) {
    return {
      text: editorContentText,
      source: 'editor_content'
    };
  }

  const article = extractBetween(html, 'article');
  const articleText = trimPrimaryContent(stripTags(removeSemanticNoise(article)), pageTitle);
  if (articleText.length >= 60) {
    return {
      text: articleText,
      source: 'article_tag'
    };
  }

  const main = extractBetween(html, 'main');
  const mainText = trimPrimaryContent(stripTags(removeSemanticNoise(main)), pageTitle);
  if (mainText.length >= 60) {
    return {
      text: mainText,
      source: 'main_fallback_trimmed'
    };
  }

  const body = extractBetween(html, 'body');
  const bodyText = trimPrimaryContent(stripTags(removeSemanticNoise(body || html)), pageTitle);

  return {
    text: bodyText,
    source: 'body_fallback_trimmed'
  };
}

function extractPdfUrls(html, baseUrl) {
  const found = [];
  const re = /href=["']([^"']+?\.pdf(?:\?[^"']*)?)["']/gi;

  for (const match of String(html || '').matchAll(re)) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl).toString();
      if (new URL(url).origin !== AMCU_ORIGIN) continue;
      if (!found.includes(url)) found.push(url);
    } catch {}
  }

  return found;
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

async function fetchBuffer(url, label, accept = 'application/octet-stream,*/*') {
  const res = await fetchWithRetry(url, { label, accept });
  const declaredLength = Number(res.headers.get('content-length') || 0);

  if (declaredLength && declaredLength > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${declaredLength} bytes > ${MAX_PDF_BYTES}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(`PDF too large: ${buffer.length} bytes > ${MAX_PDF_BYTES}`);
  }

  return buffer;
}

async function extractPdfTextFirstPages(pdfUrl) {
  const buffer = await fetchBuffer(pdfUrl, `PDF ${pdfUrl}`, 'application/pdf,application/octet-stream,*/*');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amku-pdf-'));
  const pdfPath = path.join(tempDir, 'document.pdf');

  try {
    await fs.writeFile(pdfPath, buffer);
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-f', '1', '-l', String(PDF_PREFILTER_PAGES), '-layout', pdfPath, '-'],
      { maxBuffer: 12 * 1024 * 1024 }
    );

    const text = normalizeSpaces(stdout || '');
    if (text.length < 20) {
      throw new Error(`PDF has no extractable text in first ${PDF_PREFILTER_PAGES} pages`);
    }
    return text;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
    /справ[аи]\s*№\s*([0-9]{2,4}[-–—][0-9]{1,3}(?:\.[0-9]{1,3})?\/[0-9]{1,4}[-–—][0-9]{2})(?![0-9A-Za-zА-Яа-яІіЇїЄєҐґ])/giu,
    /№\s*([0-9]{2,4}[-–—][0-9]{1,3}(?:\.[0-9]{1,3})?\/[0-9]{1,4}[-–—][0-9]{2})(?![0-9A-Za-zА-Яа-яІіЇїЄєҐґ])/giu
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
  const content = extractContentText(html, pageTitle);
  const bodyText = content.text;
  const htmlCombinedText = normalizeSpaces([
    item.title,
    item.excerpt,
    pageTitle,
    bodyText
  ].filter(Boolean).join('\n\n'));

  const htmlSignals = findPharmaSignals(htmlCombinedText);
  const htmlCandidate = htmlSignals.length > 0;
  const pdfUrls = extractPdfUrls(html, item.url);

  let pdfText = '';
  let pdfSignals = [];
  let pdfCheckedCount = 0;
  let pdfPositiveUrl = null;
  const pdfErrors = [];

  const isNpaPage = /\/npas\//i.test(item.url || '');
  const shouldInspectPdf = PDF_FALLBACK_ENABLED && pdfUrls.length > 0 && (!htmlCandidate || isNpaPage);

  if (shouldInspectPdf) {
    const urlsToCheck = pdfUrls.slice(0, MAX_PDFS_PER_PAGE);

    for (const pdfUrl of urlsToCheck) {
      try {
        const text = await extractPdfTextFirstPages(pdfUrl);
        pdfCheckedCount += 1;
        if (!text) continue;

        const signals = findPharmaSignals(text);
        if (signals.length) {
          pdfText = text;
          pdfSignals = [...new Set([...pdfSignals, ...signals])];
          pdfPositiveUrl = pdfUrl;
          break;
        }

        // On an already-positive NPA page, retain the first PDF text as
        // supporting context even when the keyword itself was in HTML.
        if (htmlCandidate && !pdfText) {
          pdfText = text;
          pdfPositiveUrl = pdfUrl;
          break;
        }
      } catch (err) {
        pdfErrors.push({ pdf_url: pdfUrl, error: String(err.message || err).slice(0, 500) });
        console.warn(`PDF fallback failed for ${pdfUrl}: ${String(err.message || err).slice(0, 500)}`);
      }
    }
  }

  const pharmaSignals = [...new Set([...htmlSignals, ...pdfSignals])];
  const pharmaCandidate = pharmaSignals.length > 0;
  const discoverySource = htmlSignals.length && pdfSignals.length
    ? 'html+pdf'
    : pdfSignals.length
      ? 'pdf'
      : htmlSignals.length
        ? 'html'
        : 'none';

  const combinedText = normalizeSpaces([
    htmlCombinedText,
    pdfText ? `PDF (перші ${PDF_PREFILTER_PAGES} сторінки):\n${pdfText}` : ''
  ].filter(Boolean).join('\n\n'));

  // An unreadable PDF does not establish pharma relevance. Keep the error
  // in diagnostics, but do not block the whole digest: if neither readable
  // HTML nor readable PDF confirms a pharma signal, the item is simply skipped.
  const pdfFallbackCriticalError = false;

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
    html_pharma_signals: htmlSignals,
    pdf_pharma_signals: pdfSignals,
    discovery_source: discoverySource,
    pdf_urls: pdfUrls,
    pdf_checked_count: pdfCheckedCount,
    pdf_source_url: pdfPositiveUrl,
    pdf_fallback_errors: pdfErrors,
    pdf_fallback_critical_error: pdfFallbackCriticalError,
    case_numbers_basic: extractCaseNumbers(combinedText),
    qualification_basic: extractBasicQualification(combinedText),
    summary_basic: extractFallbackSummary(combinedText)
  };
}

function buildGeminiPrompt(page) {
  const text = String(page.combined_text || '').slice(0, MAX_PAGE_TEXT_CHARS);

  return `Ти юрист-аналітик у сфері конкурентного права та фармацевтичного ринку України.

Проаналізуй матеріал офіційного сайту Антимонопольного комітету України.

Мета — витягнути ФАКТИ про кожну окрему фарм-релевантну юридичну подію.
НЕ вигадуй власну класифікацію event_type: тип події буде присвоєний кодом після твого аналізу.

До фармринку віднось лікарські засоби, дієтичні добавки, медичні вироби, аптеки/аптечний ритейл,
дистрибуцію/оптову торгівлю, виробництво, імпорт, реєстрацію та промоцію такої продукції.
Рекомендації органам влади також релевантні, якщо їх предмет прямо стосується фармринку.

ВАЖЛИВО:
1. Одна сторінка може містити кілька різних справ/рішень. Поверни окремий об'єкт для КОЖНОЇ фарм-релевантної події.
2. Не повертай нефaрмацевтичні події з тієї самої сторінки.
3. Не вигадуй номер справи, номер/дату рішення, суму штрафу, суб'єктів або норму.
4. Поля facts — лише true/false за змістом конкретної події:
   - case_started: прямо повідомлено про початок/відкриття розгляду справи;
   - decision_adopted: прийнято рішення по суті, у т.ч. встановлено порушення, закрито провадження, накладено штраф, надано/відмовлено у дозволі на концентрацію;
   - recommendation_issued: АМКУ надав рекомендації;
   - procedural_update: інша проміжна процесуальна подія у вже існуючій справі (попередні висновки, засідання, слухання тощо).
5. Якщо новина повідомляє про штраф як наслідок рішення, decision_adopted=true, fine_imposed=true.
6. Якщо матеріал є лише аналітикою/адвокатуванням, але прямо релевантний фармринку, усі four facts можуть бути false — такий матеріал піде в other_relevant.
7. Для КОЖНОЇ події поле source_excerpt є обов'язковим. Скопіюй дослівно достатній фрагмент саме того пункту/абзацу наданого матеріалу АМКУ, щоб у ньому одночасно було видно, про яку подію/суб'єкта йдеться, і прямий фарм-сигнал (лікарські засоби, дієтичні добавки, медичні вироби, аптеки, фармацевтика тощо), якщо вони містяться в одному фрагменті.
8. Не використовуй власні знання про компанії, бренди або ринки. Якщо в тексті конкретного пункту немає прямого фарм-сигналу, НЕ повертай цей пункт як фарм-релевантну подію, навіть якщо тобі відомо, що компанія працює у фармі.
9. Фарм-релевантність одного пункту багатопунктової сторінки не поширюється на інші пункти.
10. Поле headline — це готовий для публікації заголовок-опис події одним повним реченням українською мовою. Він має самодостатньо повідомляти головне: що зробив/вирішив АМКУ, щодо кого або чого, за що/з якого питання, а для штрафу — також суму штрафу, якщо вона прямо зазначена в матеріалі. Не додавай службові мітки на кшталт «Результат:», «Штраф:», «Кваліфікація:», номер справи чи номер рішення, якщо без них зміст зрозумілий.
11. Поле short_description — ОПЦІЙНА конкретизація headline. Заповнюй його лише тоді, коли в матеріалі є важливий конкретний факт, приклад або деталь, яка НЕ повторює headline: наприклад, точне рекламне формулювання, конкретне твердження на упаковці, спосіб/структура концентрації, зміст рекомендації або інший показовий прояв порушення. Максимум 1–2 короткі речення. Якщо додаткової конкретики немає або вона лише повторює headline — поверни порожній рядок.
12. Не повторюй у short_description суб’єкта, суму штрафу, результат або кваліфікацію лише заради дублювання вже викладених у headline фактів.

Поверни виключно валідний JSON без Markdown.

Очікувана структура:
{
  "is_pharma_relevant": true,
  "events": [
    {
      "facts": {
        "case_started": false,
        "decision_adopted": false,
        "recommendation_issued": false,
        "procedural_update": false
      },
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
      "outcome": "violation_found | proceeding_closed_no_violation | proceeding_closed_other | permit_granted | permit_denied | recommendation | procedural | other | unknown",
      "fine_imposed": false,
      "fine_amount_uah": null,
      "headline": "Готовий газетний заголовок-опис події одним повним реченням",
      "short_description": "Опційна конкретизація, яка додає новий факт; інакше порожній рядок",
      "source_excerpt": "Дослівний фрагмент саме цього пункту/абзацу матеріалу АМКУ, який прямо підтверджує фарм-релевантність події",
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
- Discovery source: ${page.discovery_source || 'unknown'}
- Supporting PDF: ${page.pdf_source_url || 'none'}
- Basic detected qualification: ${page.qualification_basic?.text || 'none'}

Текст матеріалу (для NPA може включати текст перших ${PDF_PREFILTER_PAGES} сторінок PDF):
${text}`;
}

async function analyzeWithGemini(page) {
  if (SKIP_GEMINI) {
    return {
      is_pharma_relevant: page.pharma_candidate,
      events: page.pharma_candidate ? [{
        facts: {
          case_started: false,
          decision_adopted: false,
          recommendation_issued: false,
          procedural_update: false
        },
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
        headline: page.summary_basic || page.page_title || page.title || '',
        short_description: '',
        source_excerpt: page.summary_basic || page.page_title || page.title || '',
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

function normalizeCaseNumber(value) {
  const s = normalizeSpaces(value).replace(/^№\s*/u, '').replace(/[–—]/g, '-');
  const m = s.match(/^([0-9]{2,4}-[0-9]{1,3}(?:\.[0-9]{1,3})?\/[0-9]{1,4}-[0-9]{2})$/u);
  return m ? m[1] : null;
}

function validatedCaseNumbers(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeCaseNumber).filter(Boolean))];
}

function normalizeEvidenceText(value) {
  return normalizeSpaces(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[«»„“”"'’‘`]/gu, ' ')
    .replace(/[^0-9a-zа-яіїєґ./\-]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function eventEvidenceAnchors(rawEvent) {
  return [...new Set([
    ...normalizedStringArray(rawEvent?.subjects),
    ...normalizedStringArray(rawEvent?.recommendation_addressees),
    ...normalizedStringArray(rawEvent?.case_numbers),
    normalizeSpaces(rawEvent?.decision_number || '')
  ].filter((value) => normalizeEvidenceText(value).length >= 5))];
}

function validateEventPharmaEvidence(rawEvent, page, totalEventsOnPage) {
  // For a single-event page, page-level discovery is enough: the pharma
  // signal belongs to that one event, even if Gemini chose a shorter quote.
  if (totalEventsOnPage <= 1) {
    return Boolean(page?.pharma_candidate);
  }

  const haystack = String(page?.combined_text || '');
  const haystackNormalized = normalizeEvidenceText(haystack);

  // On multi-event pages, an excerpt is useful only when it can be located
  // in the supplied AMCU text (punctuation/quotation differences ignored)
  // and that local excerpt itself contains a direct pharma signal.
  const excerpt = normalizeSpaces(rawEvent?.source_excerpt || '');
  const excerptNormalized = normalizeEvidenceText(excerpt);
  if (
    excerptNormalized.length >= 12
    && haystackNormalized.includes(excerptNormalized)
    && hasPharmaSignals(excerpt)
  ) {
    return true;
  }

  // Otherwise locate the concrete event by a factual anchor (subject,
  // case number, decision number) and require the pharma signal in the
  // same AMCU paragraph/item. This prevents a pharma item elsewhere on a
  // multi-item page from making unrelated Merck/Meyer items relevant.
  const anchors = eventEvidenceAnchors(rawEvent);
  if (!anchors.length) return false;

  const paragraphs = haystack
    .split(/\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (!hasPharmaSignals(paragraph)) continue;

    const paragraphNormalized = normalizeEvidenceText(paragraph);
    for (const anchor of anchors) {
      const anchorNormalized = normalizeEvidenceText(anchor);
      if (anchorNormalized.length < 5) continue;
      if (paragraphNormalized.includes(anchorNormalized)) return true;
    }
  }

  return false;
}

function isAgendaPage(page) {
  const text = normalizeSpaces([page?.title, page?.page_title].filter(Boolean).join(' '));
  return /про(?:є|е)кт\s+порядку\s+денного/iu.test(text);
}

function inferEventFacts(rawEvent, page) {
  const facts = rawEvent?.facts && typeof rawEvent.facts === 'object' ? rawEvent.facts : {};
  const text = normalizeSpaces([
    page?.title,
    page?.page_title,
    rawEvent?.short_description
  ].filter(Boolean).join(' '));

  if (isAgendaPage(page)) {
    return {
      case_started: false,
      decision_adopted: false,
      recommendation_issued: false,
      procedural_update: true
    };
  }

  return {
    case_started: Boolean(facts.case_started)
      || /розпочато\s+(?:розгляд\s+)?справ[иу]?/iu.test(text),
    decision_adopted: Boolean(facts.decision_adopted)
      || /оштраф/iu.test(text)
      || /накладен(?:о|ий|а|і)?\s+штраф/iu.test(text)
      || /визнан(?:о|ий|а|і)?\s+порушенням/iu.test(text)
      || /надано\s+дозвіл\s+на\s+концентрац/iu.test(text)
      || /відмовлен(?:о|ий|а|і)?\s+у\s+наданн(?:і|я)\s+дозвол/iu.test(text),
    recommendation_issued: Boolean(facts.recommendation_issued)
      || /надав(?:ав|ала|али|ано)?\s+рекомендац/iu.test(text)
      || /про\s+надання\s+рекомендац/iu.test(text),
    procedural_update: Boolean(facts.procedural_update)
      || /попередн(?:і|іх|ими)?\s+висновк/iu.test(text)
      || /засіданн/iu.test(text)
      || /слуханн/iu.test(text)
      || /розгляд\s+справи/iu.test(text)
  };
}

function deriveEventType(rawEvent, page) {
  if (isAgendaPage(page)) return 'case_procedural_update';

  const facts = inferEventFacts(rawEvent, page);
  if (facts.decision_adopted) return 'case_decided';
  if (facts.recommendation_issued) return 'recommendation_issued';
  if (facts.case_started) return 'case_started';
  if (facts.procedural_update) return 'case_procedural_update';
  return 'other_relevant';
}

function normalizeEventType(value) {
  const allowed = new Set(['case_started', 'case_decided', 'recommendation_issued', 'case_procedural_update', 'other_relevant']);
  return allowed.has(value) ? value : 'other_relevant';
}

function normalizeOutcome(value, eventType) {
  const aliases = {
    no_violation: 'proceeding_closed_no_violation',
    case_closed: 'proceeding_closed_other'
  };
  const normalized = aliases[value] || value;
  const allowed = new Set([
    'violation_found',
    'proceeding_closed_no_violation',
    'proceeding_closed_other',
    'permit_granted',
    'permit_denied',
    'recommendation',
    'procedural',
    'other',
    'unknown'
  ]);
  if (allowed.has(normalized)) return normalized;
  if (eventType === 'recommendation_issued') return 'recommendation';
  if (eventType === 'case_procedural_update') return 'procedural';
  return 'unknown';
}

function buildEventKey(event, page) {
  const eventType = deriveEventType(event, page);
  const decisionNumber = eventType === 'case_decided' ? normalizeDecisionNumber(event.decision_number) : null;
  const decisionDate = eventType === 'case_decided' ? String(event.decision_date || '').slice(0, 10) : '';
  const cases = validatedCaseNumbers(event.case_numbers).sort();

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
  const totalEventsOnPage = rawEvents.filter((event) => event && typeof event === 'object').length;

  rawEvents.forEach((rawEvent, index) => {
    if (!rawEvent || typeof rawEvent !== 'object') return;

    if (!validateEventPharmaEvidence(rawEvent, page, totalEventsOnPage)) {
      console.warn(`Dropped event without direct pharma evidence: ${page.title || page.url} | ${normalizeSpaces(rawEvent?.headline || rawEvent?.short_description || '').slice(0, 180)}`);
      return;
    }

    const eventType = deriveEventType(rawEvent, page);
    const qualification = rawEvent.qualification && typeof rawEvent.qualification === 'object'
      ? rawEvent.qualification
      : null;

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
      discovery_source: page.discovery_source || 'unknown',
      source_document_url: page.pdf_source_url || null,

      facts: inferEventFacts(rawEvent, page),
      sector: rawEvent.sector || 'other',
      case_numbers: validatedCaseNumbers(rawEvent.case_numbers),
      // Decision identifiers are useful only for a substantive decision.
      // For case starts/procedural items Gemini can mistake an order,
      // demand or other document number for a decision number, so omit it.
      decision_number: eventType === 'case_decided' ? normalizeDecisionNumber(rawEvent.decision_number) : null,
      decision_date: eventType === 'case_decided' && rawEvent.decision_date
        ? String(rawEvent.decision_date).slice(0, 10)
        : null,
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
      headline: normalizeSpaces(rawEvent.headline || rawEvent.short_description || page.summary_basic || page.page_title || page.title || ''),
      short_description: normalizeSpaces(rawEvent.headline ? (rawEvent.short_description || '') : ''),
      source_excerpt: normalizeSpaces(rawEvent.source_excerpt || ''),
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

function plainList(values, fallback = '') {
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
    other: 'інше'
  };
  return map[value] || value || 'інше';
}

function eventTypeLabel(type) {
  const map = {
    case_started: 'Розпочато справу',
    case_decided: 'Прийнято рішення',
    recommendation_issued: 'Надано рекомендації',
    case_procedural_update: 'Справа в розгляді',
    other_relevant: 'Ринкова подія'
  };
  return map[type] || type;
}

function eventTypeHeading(type) {
  const map = {
    case_decided: 'Рішення та штрафи',
    recommendation_issued: 'Рекомендації АМКУ',
    case_started: 'Нові справи',
    case_procedural_update: 'Справи в розгляді',
    other_relevant: 'Ринок та адвокатування'
  };
  return map[type] || type;
}

function outcomeLabel(value) {
  const map = {
    violation_found: 'Порушення встановлено',
    proceeding_closed_no_violation: 'Провадження закрито без встановлення порушення',
    proceeding_closed_other: 'Провадження закрито з іншої підстави',
    permit_granted: 'Дозвіл надано',
    permit_denied: 'У наданні дозволу відмовлено',
    recommendation: 'Надано рекомендації',
    procedural: 'Проміжна процесуальна подія',
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
  if (!Array.isArray(values) || !values.length) return '';
  return values
    .map((v) => String(v).trim().replace(/^№\s*/u, ''))
    .filter(Boolean)
    .map((v) => `№ ${v}`)
    .join(', ');
}

function sourceLinkLabel() {
  return 'Читати матеріал АМКУ';
}

function practiceDbFooterText() {
  return [
    '«Тижневий вісник АМКУ» — неофіційний автоматизований моніторинг публічних матеріалів Антимонопольного комітету України.',
    'Відбір охоплює матеріали, у яких фармацевтична релевантність прямо випливає з публікації АМКУ або доданого до неї документа.',
    'База практики АМКУ:',
    PRACTICE_DB_URL
  ].join('\n');
}

function practiceDbFooterHtml() {
  return `
    <div style="margin:32px 0 0 0;padding:16px 0 0 0;border-top:3px double #1f2937;">
      <p style="margin:0 0 6px 0;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.5;color:#374151;">
        <strong>Про видання.</strong> «Тижневий вісник АМКУ» — неофіційний автоматизований моніторинг публічних матеріалів Антимонопольного комітету України.
      </p>
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.5;color:#4b5563;">
        Відбір охоплює матеріали, у яких фармацевтична релевантність прямо випливає з публікації АМКУ або доданого до неї документа.
        Для аналізу вже сформованої практики доступна
        <a href="${htmlEscape(PRACTICE_DB_URL)}" target="_blank" rel="noopener" style="color:#111827;text-decoration:underline;">База практики АМКУ</a>.
      </p>
    </div>
  `;
}

function groupEvents(rows) {
  // Editorial order: the most consequential material first.
  const order = ['case_decided', 'recommendation_issued', 'case_started', 'case_procedural_update', 'other_relevant'];
  return order
    .map((type) => [type, (rows || []).filter((r) => r.event_type === type)])
    .filter(([, items]) => items.length);
}

function periodLabelShort(period) {
  return `${formatDateUk(period.from)} — ${formatDateUk(period.to)}`;
}

function buildEmailSubject(period) {
  return `${EMAIL_SUBJECT_PREFIX} — ${periodLabelShort(period)}`;
}

function actorValuesForRow(row) {
  return row.event_type === 'recommendation_issued' ? row.recommendation_addressees : row.subjects;
}

function actorTextForRow(row) {
  return plainList(actorValuesForRow(row), '');
}

function editorialTopic(row) {
  const text = normalizeSpaces([
    row.headline,
    row.short_description,
    row.title,
    row.timeline_title,
    qualificationText(row)
  ].filter(Boolean).join(' ')).toLowerCase();

  if (/концентрац|набуття\s+контрол|контроль\s+над/i.test(text)) return 'concentration';
  if (/недобросовісн|ввод[^.]{0,40}в\s+оман|оманлив|реклам|15\s*[-–—]?\s*1/i.test(text)) return 'unfair_competition';
  if (/рекомендац/i.test(text)) return 'recommendations';
  return 'other';
}

function topicHeading(topic) {
  const map = {
    unfair_competition: 'Недобросовісна конкуренція',
    concentration: 'Концентрації',
    recommendations: 'Рекомендації'
  };
  return map[topic] || null;
}

function topicOrderForType(type) {
  if (type === 'case_decided') return ['unfair_competition', 'concentration', 'other'];
  if (type === 'case_started') return ['unfair_competition', 'concentration', 'other'];
  if (type === 'case_procedural_update') return ['unfair_competition', 'concentration', 'other'];
  return ['recommendations', 'unfair_competition', 'concentration', 'other'];
}

function groupRowsByTopic(rows, type) {
  const order = topicOrderForType(type);
  const byTopic = new Map();
  for (const row of rows || []) {
    const topic = editorialTopic(row);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(row);
  }

  return order
    .filter((topic) => byTopic.has(topic))
    .map((topic) => [topic, byTopic.get(topic)]);
}

function buildStoryGroups(rows, type, topic) {
  const buckets = new Map();

  for (const row of rows || []) {
    // Group only events originating from the same AMCU publication and the same topic.
    // The underlying events remain separate in JSON/state; this is presentation-only.
    const urlKey = normalizeUrlKey(row.url);
    const key = urlKey ? `${type}|${topic}|${urlKey}` : `${type}|${topic}|${row.event_key}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const stories = [];
  for (const items of buckets.values()) {
    if (items.length >= 2) {
      stories.push({ kind: 'group', type, topic, rows: items });
    } else {
      stories.push({ kind: 'single', type, topic, rows: items });
    }
  }

  return stories.sort((a, b) => {
    const ad = String(a.rows?.[0]?.publication_datetime || a.rows?.[0]?.publication_date || '');
    const bd = String(b.rows?.[0]?.publication_datetime || b.rows?.[0]?.publication_date || '');
    return bd.localeCompare(ad, 'uk');
  });
}

function countEditorialStories(rows) {
  let count = 0;
  for (const [type, sectionRows] of groupEvents(rows)) {
    for (const [topic, topicRows] of groupRowsByTopic(sectionRows, type)) {
      count += buildStoryGroups(topicRows, type, topic).length;
    }
  }
  return count;
}

function ukCount(n, one, few, many) {
  const abs = Math.abs(Number(n) || 0);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function groupedStoryHeadline(type, topic, count) {
  if (topic === 'concentration') {
    if (type === 'case_decided') {
      return `Концентрації: ${count} ${ukCount(count, 'рішення', 'рішення', 'рішень')} АМКУ`;
    }
    if (type === 'case_started') {
      return `Концентрації: ${count} ${ukCount(count, 'нова справа', 'нові справи', 'нових справ')}`;
    }
    if (type === 'case_procedural_update') {
      return `Концентрації: ${count} ${ukCount(count, 'справа в розгляді', 'справи в розгляді', 'справ у розгляді')}`;
    }
  }

  if (topic === 'unfair_competition') {
    if (type === 'case_decided') {
      return `Недобросовісна конкуренція: ${count} ${ukCount(count, 'рішення', 'рішення', 'рішень')}`;
    }
    if (type === 'case_started') {
      return `Недобросовісна конкуренція: ${count} ${ukCount(count, 'нова справа', 'нові справи', 'нових справ')}`;
    }
    if (type === 'case_procedural_update') {
      return `Недобросовісна конкуренція: ${count} ${ukCount(count, 'справа в розгляді', 'справи в розгляді', 'справ у розгляді')}`;
    }
  }

  return `${count} ${ukCount(count, 'подія', 'події', 'подій')} з одного матеріалу АМКУ`;
}

function editorialNormalize(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[«»„“”"'’‘`]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editorialTokens(value) {
  return new Set(
    editorialNormalize(value)
      .split(' ')
      .filter((token) => token.length >= 4)
  );
}

function shouldShowShortDescription(row) {
  const headline = normalizeSpaces(row?.headline || '');
  const detail = normalizeSpaces(row?.short_description || '');
  if (!detail) return false;
  if (!headline) return true;

  const h = editorialNormalize(headline);
  const d = editorialNormalize(detail);
  if (!d || d === h || h.includes(d) || d.includes(h)) return false;

  // Concrete quoted examples are especially useful in a digest.
  if (/[«»"“”]/.test(detail) && !headline.includes(detail)) return true;

  const hTokens = editorialTokens(headline);
  const dTokens = editorialTokens(detail);
  if (!hTokens.size || !dTokens.size) return true;

  let overlap = 0;
  for (const token of dTokens) if (hTokens.has(token)) overlap += 1;
  const overlapRatio = overlap / Math.min(hTokens.size, dTokens.size);

  // Hide near-duplicates; keep material that adds genuinely new content.
  return overlapRatio < 0.72;
}

function eventHeadline(row) {
  return normalizeSpaces(row?.headline || row?.short_description || row?.title || eventTypeLabel(row?.event_type));
}

function renderEventText(row, index) {
  const lines = [
    `${index + 1}. ${formatDateUk(row.publication_date)} · ${sectorLabel(row.sector)}`,
    eventHeadline(row)
  ];

  if (shouldShowShortDescription(row)) lines.push(row.short_description);
  lines.push(`Джерело: ${row.url}`);
  return lines.join('\n');
}

function renderGroupedStoryText(story) {
  const rows = story.rows || [];
  const first = rows[0] || {};
  const lines = [
    `${formatDateUk(first.publication_date)} · ${groupedStoryHeadline(story.type, story.topic, rows.length)}`
  ];

  for (const row of rows) {
    lines.push(`• ${eventHeadline(row)}`);
    if (shouldShowShortDescription(row)) lines.push(`  ${row.short_description}`);
  }

  if (first.url) lines.push(`Джерело: ${first.url}`);
  return lines.join('\n');
}

function renderEmailText({ period, relevantRows }) {
  const groups = groupEvents(relevantRows);
  const storyCount = countEditorialStories(relevantRows);
  const masthead = [
    EMAIL_SUBJECT_PREFIX.toUpperCase(),
    `Огляд подій АМКУ на фармацевтичному ринку · ${periodLabelShort(period)}`,
    `Неофіційний моніторинг · ${relevantRows.length} ${ukCount(relevantRows.length, 'подія', 'події', 'подій')} · ${storyCount} ${ukCount(storyCount, 'замітка', 'замітки', 'заміток')}`
  ].join('\n');

  if (!relevantRows.length) {
    return [masthead, '', 'Релевантних подій за цей період не виявлено.', '', practiceDbFooterText()].join('\n');
  }

  const sections = [];
  for (const [type, sectionRows] of groups) {
    const sectionParts = [`${eventTypeHeading(type).toUpperCase()} · ${sectionRows.length}`, '-'.repeat(48)];

    for (const [topic, topicRows] of groupRowsByTopic(sectionRows, type)) {
      const stories = buildStoryGroups(topicRows, type, topic);
      const topicLabel = topicHeading(topic);
      if (topicLabel && stories.length) sectionParts.push(`\n${topicLabel.toUpperCase()}`);

      stories.forEach((story, index) => {
        sectionParts.push(
          story.kind === 'group'
            ? renderGroupedStoryText(story)
            : renderEventText(story.rows[0], index)
        );
      });
    }

    sections.push(sectionParts.join('\n\n'));
  }

  return [masthead, '', sections.join('\n\n' + '='.repeat(56) + '\n\n'), '', practiceDbFooterText()].join('\n');
}

function renderEventHtml(row) {
  const headline = eventHeadline(row);
  const detail = shouldShowShortDescription(row) ? normalizeSpaces(row.short_description) : '';

  return `
    <article style="margin:0;padding:15px 0 16px 0;border-bottom:1px solid #b6bbc3;">
      <div style="font-family:Arial,sans-serif;font-size:10px;line-height:1.3;letter-spacing:1.05px;text-transform:uppercase;color:#6b7280;margin:0 0 5px 0;">
        ${htmlEscape(formatDateUk(row.publication_date))} &nbsp;·&nbsp; ${htmlEscape(sectorLabel(row.sector))}
      </div>
      <h3 style="margin:0 0 ${detail ? '7px' : '10px'} 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.27;font-weight:700;color:#111827;">
        ${htmlEscape(headline)}
      </h3>
      ${detail ? `<p style="margin:0 0 10px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.52;color:#4b5563;">${htmlEscape(detail)}</p>` : ''}
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:12.5px;line-height:1.5;">
        <a href="${htmlEscape(row.url)}" target="_blank" rel="noopener" style="color:#111827;text-decoration:underline;">${htmlEscape(sourceLinkLabel())} →</a>
      </p>
    </article>
  `;
}

function renderGroupedStoryHtml(story) {
  const rows = story.rows || [];
  const first = rows[0] || {};
  const headline = groupedStoryHeadline(story.type, story.topic, rows.length);

  const items = rows.map((row) => {
    const detail = shouldShowShortDescription(row) ? normalizeSpaces(row.short_description) : '';
    return `
      <li style="margin:0 0 9px 0;padding:0 0 0 2px;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.45;color:#374151;">
        <strong>${htmlEscape(eventHeadline(row))}</strong>
        ${detail ? `<div style="margin-top:3px;font-weight:400;color:#4b5563;">${htmlEscape(detail)}</div>` : ''}
      </li>`;
  }).join('\n');

  return `
    <article style="margin:0;padding:15px 0 16px 0;border-bottom:1px solid #b6bbc3;">
      <div style="font-family:Arial,sans-serif;font-size:10px;line-height:1.3;letter-spacing:1.05px;text-transform:uppercase;color:#6b7280;margin:0 0 5px 0;">
        ${htmlEscape(formatDateUk(first.publication_date))} &nbsp;·&nbsp; ${htmlEscape(topicHeading(story.topic) || sectorLabel(first.sector))}
      </div>
      <h3 style="margin:0 0 9px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.27;font-weight:700;color:#111827;">
        ${htmlEscape(headline)}
      </h3>
      <ul style="margin:0 0 9px 19px;padding:0;">${items}</ul>
      ${first.url ? `<p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:12.5px;line-height:1.5;"><a href="${htmlEscape(first.url)}" target="_blank" rel="noopener" style="color:#111827;text-decoration:underline;">${htmlEscape(sourceLinkLabel())} →</a></p>` : ''}
    </article>
  `;
}

function renderTopicBlockHtml(type, topic, rows) {
  const stories = buildStoryGroups(rows, type, topic);
  const label = topicHeading(topic);
  const showSubheading = Boolean(label) && (type === 'case_decided' || rows.length >= 2);

  return `
    <div style="margin:${showSubheading ? '15px' : '0'} 0 0 0;">
      ${showSubheading ? `<div style="margin:0 0 2px 0;font-family:Arial,sans-serif;font-size:10px;line-height:1.2;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;color:#6b7280;">${htmlEscape(label)}</div>` : ''}
      ${stories.map((story) => story.kind === 'group' ? renderGroupedStoryHtml(story) : renderEventHtml(story.rows[0])).join('\n')}
    </div>
  `;
}

function renderSectionHtml(type, rows) {
  const topicBlocks = groupRowsByTopic(rows, type)
    .map(([topic, topicRows]) => renderTopicBlockHtml(type, topic, topicRows))
    .join('\n');

  return `
    <section style="margin:29px 0 0 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td style="border-top:3px solid #111827;border-bottom:1px solid #111827;padding:7px 0 6px 0;">
            <span style="font-family:Arial,sans-serif;font-size:11px;line-height:1.2;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:#111827;">${htmlEscape(eventTypeHeading(type))}</span>
          </td>
          <td align="right" style="border-top:3px solid #111827;border-bottom:1px solid #111827;padding:7px 0 6px 10px;font-family:Arial,sans-serif;font-size:11px;color:#6b7280;white-space:nowrap;">${rows.length}</td>
        </tr>
      </table>
      ${topicBlocks}
    </section>
  `;
}

function renderEmailHtml({ period, relevantRows }) {
  const groups = groupEvents(relevantRows);
  const storyCount = countEditorialStories(relevantRows);
  const body = relevantRows.length
    ? groups.map(([type, rows]) => renderSectionHtml(type, rows)).join('\n')
    : `<p style="margin:24px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;">Релевантних подій за цей період не виявлено.</p>`;

  const eventWord = ukCount(relevantRows.length, 'подія', 'події', 'подій');
  const storyWord = ukCount(storyCount, 'замітка', 'замітки', 'заміток');

  return `<!doctype html>
<html lang="uk">
<body style="padding:0;margin:0;background:#f3f1eb;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;background:#f3f1eb;">
    <tr>
      <td align="center" style="padding:24px 10px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:760px;border-collapse:collapse;background:#fffdf7;border:1px solid #d1d5db;">
          <tr>
            <td style="padding:28px 28px 26px 28px;">
              <div style="text-align:center;border-top:5px solid #111827;border-bottom:5px double #111827;padding:16px 0 14px 0;">
                <div style="font-family:Arial,sans-serif;font-size:9px;line-height:1.3;letter-spacing:2px;text-transform:uppercase;color:#6b7280;margin-bottom:7px;">неофіційний моніторинг публічних матеріалів</div>
                <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.05;font-weight:700;letter-spacing:-0.4px;color:#111827;">${htmlEscape(EMAIL_SUBJECT_PREFIX)}</h1>
                <div style="margin-top:8px;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.35;font-style:italic;color:#374151;">Огляд подій АМКУ на фармацевтичному ринку</div>
              </div>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:9px;">
                <tr>
                  <td style="font-family:Arial,sans-serif;font-size:10px;line-height:1.3;letter-spacing:.8px;text-transform:uppercase;color:#4b5563;padding:0 0 7px 0;">Випуск за ${htmlEscape(periodLabelShort(period))}</td>
                  <td align="right" style="font-family:Arial,sans-serif;font-size:10px;line-height:1.3;letter-spacing:.8px;text-transform:uppercase;color:#4b5563;padding:0 0 7px 10px;">${relevantRows.length} ${eventWord} · ${storyCount} ${storyWord}</td>
                </tr>
              </table>

              <p style="margin:12px 0 0 0;padding:12px 0;border-top:1px solid #d1d5db;border-bottom:1px solid #d1d5db;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.55;color:#374151;text-align:center;">
                Короткий огляд публічних матеріалів АМКУ, у яких прямо простежується зв’язок із фармацевтичним ринком.
              </p>

              ${body}
              ${practiceDbFooterHtml()}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendEmailDigest({ period, relevantRows }) {
  if (!SEND_EMAIL && !TEST_EMAIL_SEND) {
    console.log('Email skipped: SEND_EMAIL=false and TEST_EMAIL_SEND=false.');
    return false;
  }

  if (!relevantRows.length && !SEND_EMPTY_EMAIL) {
    console.log('Email skipped: no relevant rows and SEND_EMPTY_EMAIL=false.');
    return false;
  }

  if (DRY_RUN && !TEST_EMAIL_SEND) {
    console.log('Email skipped: DRY_RUN=true.');
    return false;
  }

  const emailTo = TEST_EMAIL_SEND
    ? (process.env.TEST_EMAIL_TO || process.env.EMAIL_TO)
    : process.env.EMAIL_TO;
  if (!emailTo) {
    console.log('Email skipped: recipient is not configured (TEST_EMAIL_TO/EMAIL_TO).');
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
    subject: TEST_EMAIL_SEND ? `[ТЕСТ] ${buildEmailSubject(period)}` : buildEmailSubject(period),
    text: renderEmailText({ period, relevantRows }),
    html: renderEmailHtml({ period, relevantRows })
  });

  console.log(`${TEST_EMAIL_SEND ? 'Test email' : 'Email'} sent to ${emailTo}`);
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
  let pdfFallbackChecked = 0;
  let pdfFallbackCandidates = 0;
  let pdfFallbackCriticalErrors = 0;

  for (const item of timelineItems) {
    try {
      const page = await fetchAndPreparePage(item);
      preparedPages.push(page);

      pdfFallbackChecked += page.pdf_checked_count || 0;
      if (page.discovery_source === 'pdf' || page.discovery_source === 'html+pdf') pdfFallbackCandidates += 1;
      if (page.pdf_fallback_critical_error) {
        pdfFallbackCriticalErrors += 1;
        console.warn(`Potential false-negative risk: PDF fallback incomplete for ${item.url}`);
      }

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
        `Pharma candidate [discovery=${page.discovery_source}, html_source=${page.content_source}, html_signals=${page.html_pharma_signals.join(', ') || 'none'}, pdf_signals=${page.pdf_pharma_signals.join(', ') || 'none'}, pdf_checked=${page.pdf_checked_count}]: ${item.title}`
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
        console.log(`EVENT_FOUND ${row.event_type} | ${row.case_numbers?.join(', ') || row.decision_number || 'no-id'} | ${row.headline?.slice(0, 240) || row.short_description?.slice(0, 240) || ''} | ${row.url}`);
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
  } else if (TEST_EMAIL_SEND || !state.sent_digests[digestKey] || FORCE_SEND) {
    emailSent = await sendEmailDigest({ period, relevantRows: digestRows });
  }

  state.last_run = {
    at: new Date().toISOString(),
    period,
    digest_key: digestKey,
    timeline_items: timelineItems.length,
    pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length,
    html_candidates: preparedPages.filter((p) => (p.html_pharma_signals || []).length > 0).length,
    pdf_fallback_checked: pdfFallbackChecked,
    pdf_fallback_candidates: pdfFallbackCandidates,
    pdf_fallback_critical_errors: pdfFallbackCriticalErrors,
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
      test_email_send: TEST_EMAIL_SEND,
      send_empty_email: SEND_EMPTY_EMAIL,
      force_send: FORCE_SEND,
      pdf_fallback_enabled: PDF_FALLBACK_ENABLED,
      pdf_prefilter_pages: PDF_PREFILTER_PAGES
    }
  };

  if (!TEST_EMAIL_SEND && runComplete && (emailSent || (!relevantRows.length && SEND_EMPTY_EMAIL && SEND_EMAIL && !DRY_RUN))) {
    state.sent_digests[digestKey] = {
      sent_at: new Date().toISOString(),
      relevant_count: digestRows.length,
      timeline_items: timelineItems.length,
      pharma_candidates: preparedPages.filter((p) => p.pharma_candidate).length
    };
  }

  console.log(`HTML pharma candidates: ${preparedPages.filter((p) => (p.html_pharma_signals || []).length > 0).length}`);
  console.log(`PDF fallback documents checked: ${pdfFallbackChecked}`);
  console.log(`Candidates with PDF evidence: ${pdfFallbackCandidates}`);
  console.log(`PDF fallback critical errors: ${pdfFallbackCriticalErrors}`);
  console.log(`Pharma candidates total: ${preparedPages.filter((p) => p.pharma_candidate).length}`);
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
