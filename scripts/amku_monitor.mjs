import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'amku_state.json');
const RESULTS_PATH = path.join(DATA_DIR, 'amku_results.json');
const EVENTS_PATH = path.join(DATA_DIR, 'amku_events.jsonl');

const DATASET_ID = env('DATASET_ID', '8bdd45b8-0684-463a-ba76-26361c32841a');
const CKAN_PACKAGE_SHOW_URL = env(
  'CKAN_PACKAGE_SHOW_URL',
  `https://data.gov.ua/api/3/action/package_show?id=${encodeURIComponent(DATASET_ID)}`
);

const LOOKBACK_MONTHS = intEnv('LOOKBACK_MONTHS', 3);
const MAX_RESOURCES = intEnv('MAX_RESOURCES', 12);
const FORCE = boolEnv('FORCE', false);
const DRY_RUN = boolEnv('DRY_RUN', false);
const SKIP_GEMINI = boolEnv('SKIP_GEMINI', false);
const INCLUDE_PROCEDURAL_DECISIONS = boolEnv('INCLUDE_PROCEDURAL_DECISIONS', false);
const MAX_TEXT_CHARS = intEnv('MAX_TEXT_CHARS', 180000);
const MAX_GEMINI_CALLS = intEnv('MAX_GEMINI_CALLS', 50);
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-3.1-flash-lite');

// Version marker for resource-level state.
// If we change processing logic, old resource state will be rechecked once.
const RESOURCE_STATE_VERSION = 2;

// Conservative defaults based on observed free-tier quota:
// RPM around 20, input TPM error showed 250000.
// We keep headroom to avoid 429.
const GEMINI_RPM_LIMIT = intEnv('GEMINI_RPM_LIMIT', 10);
const GEMINI_TPM_LIMIT = intEnv('GEMINI_TPM_LIMIT', 220000);
const GEMINI_RETRY_MAX = intEnv('GEMINI_RETRY_MAX', 4);
const GEMINI_RETRY_BUFFER_MS = intEnv('GEMINI_RETRY_BUFFER_MS', 1500);
const GEMINI_QUOTA_WINDOW_MS = 60_000;

const geminiUsageWindow = [];

const LOCAL_ZIP = process.env.LOCAL_ZIP || '';

const UA_MONTHS = new Map([
  ['січень', 1], ['січня', 1],
  ['лютий', 2], ['лютого', 2],
  ['березень', 3], ['березня', 3],
  ['квітень', 4], ['квітня', 4],
  ['травень', 5], ['травня', 5],
  ['червень', 6], ['червня', 6],
  ['липень', 7], ['липня', 7],
  ['серпень', 8], ['серпня', 8],
  ['вересень', 9], ['вересня', 9],
  ['жовтень', 10], ['жовтня', 10],
  ['листопад', 11], ['листопада', 11],
  ['грудень', 12], ['грудня', 12]
]);

const INCLUDE_PATTERNS = [
  /про\s+порушення\s+законодавства\s+про\s+захист\s+економічної\s+конкуренції/i,
  /про\s+порушення\s+законодавства\s+про\s+захист\s+від\s+недобросовісної\s+конкуренції/i,
  /порушення\s+законодавства\s+про\s+захист\s+від\s+недобросовісної\s+конкуренції/i
];

const PROCEDURAL_PATTERNS = [
  /про\s+розстрочення\s+сплати\s+штрафу/i,
  /про\s+відстрочення\s+сплати\s+штрафу/i,
  /про\s+перевірку\s+рішення/i,
  /про\s+перегляд\s+рішення/i,
  /про\s+внесення\s+змін/i
];

const CONCENTRATION_WITHOUT_PERMIT_PATTERNS = [
  /пункт(?:ом|у)?\s*12\s+статті\s*50\s+Закону\s+України\s+«?Про\s+захист\s+економічної\s+конкуренції»?/i,
  /п\.?\s*12\s+ст\.?\s*50\s+Закону\s+України\s+«?Про\s+захист\s+економічної\s+конкуренції»?/i,
  /здійснення\s+концентрації\s+без\s+отримання\s+(?:відповідного\s+)?дозволу/i,
  /концентраці[яї]\s+без\s+отримання\s+(?:відповідного\s+)?дозволу/i,
  /без\s+отримання\s+(?:відповідного\s+)?дозволу\s+органів\s+Антимонопольного\s+комітету\s+України/i,
  /у\s+разі\s+якщо\s+наявність\s+такого\s+дозволу\s+необхідна/i
];

const RESOURCE_EXCLUDE_PATTERNS = [
  /рекомендац/i,
  /список/i,
  /розпоряджен/i
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

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHashUnicodeName(s) {
  return String(s || '').replace(/#U([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function sha256File(filePath) {
  const buf = await fs.readFile(filePath);
  return sha256Buffer(buf);
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

async function runCmd(command, args, options = {}) {
  const allowCodes = options.allowCodes || [0];

  try {
    return await execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 1024 * 1024 * 20,
      cwd: options.cwd || ROOT
    });
  } catch (err) {
    if (allowCodes.includes(err.code)) {
      return { stdout: err.stdout || '', stderr: err.stderr || '' };
    }

    const stderr = (err.stderr || err.message || '').toString().slice(0, 2000);
    throw new Error(`${command} failed: ${stderr}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'amku-monitor/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function downloadFile(url, filePath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'amku-monitor/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading ${url}`);

  const arrayBuffer = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buf);

  return sha256Buffer(buf);
}

function resourceTitle(resource) {
  return resource.name || resource.title || resource.description || resource.id || '';
}

function resourceSignature(resource) {
  return [
    resource.hash,
    resource.last_modified,
    resource.revision_timestamp,
    resource.created,
    resource.size,
    resource.url
  ].filter(Boolean).join('|');
}

function isDecisionZipResource(resource) {
  const title = resourceTitle(resource);
  const format = String(resource.format || '').toLowerCase();
  const url = String(resource.url || '').toLowerCase();

  if (!format.includes('zip') && !url.endsWith('.zip')) return false;
  if (!/рішен/i.test(title)) return false;
  if (!/(амку|антимонополь)/i.test(title)) return false;
  if (RESOURCE_EXCLUDE_PATTERNS.some((re) => re.test(title))) return false;

  return true;
}

function parseResourceDate(resourceOrTitle) {
  const resource = typeof resourceOrTitle === 'string' ? null : resourceOrTitle;
  const title = typeof resourceOrTitle === 'string' ? resourceOrTitle : resourceTitle(resourceOrTitle);
  const text = String(title || '').toLowerCase();

  // 1) Якщо в назві є місяць словами, вважаємо його періодом ресурсу.
  // Це важливо для назв:
  // - "Рішення АМКУ за квітень № 302-р - № 378-р" — місяць без року;
  // - "Рішення ... за лютий станом на 03.03.2026" — дата "станом на" не є періодом.
  for (const [name, month] of UA_MONTHS.entries()) {
    const monthRe = new RegExp(`(?:за\\s+)?${name}(?![а-яіїєґ])`, 'i');
    if (!monthRe.test(text)) continue;

    let year = null;

    const adjacentYear = text.match(new RegExp(`${name}\\s+(20\\d{2})`, 'i'));
    if (adjacentYear) year = Number(adjacentYear[1]);

    if (!year) {
      const anyYear = text.match(/20\d{2}/);
      if (anyYear) year = Number(anyYear[0]);
    }

    if (!year && resource) year = yearFromResourceDates(resource);
    if (!year) year = new Date().getUTCFullYear();

    return { year, month, day: 1, source: 'ua_month_period' };
  }

  // 2) Якщо місяця словами немає, пробуємо числову дату.
  // Старі ресурси часто мають вигляд: "Рішення АМКУ від 18.04.2019 №238-269-р.zip".
  const numeric = text.match(/(?:від\s*)?(\d{1,2})[.\s-]+(\d{1,2})[.\s-]+(20\d{2})/i);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3]);

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day, source: 'numeric_date' };
    }
  }

  return null;
}

function yearFromResourceDates(resource) {
  for (const field of ['last_modified', 'revision_timestamp', 'created']) {
    const value = resource?.[field];
    if (!value) continue;

    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).getUTCFullYear();
  }

  return null;
}

function resourcePeriodKey(resource) {
  const parsed = parseResourceDate(resource);
  if (!parsed) return null;

  return `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;
}

function parseDecisionRange(resourceOrTitle) {
  const title = typeof resourceOrTitle === 'string' ? resourceOrTitle : resourceTitle(resourceOrTitle);
  const text = String(title || '').replace(/\u00a0/g, ' ');

  const m = text.match(/№{1,2}\s*(\d{1,5})(?:\s*[-–—]\s*[рp])?\s*[-–—]\s*(?:№\s*)?(\d{1,5})(?:\s*[-–—]\s*[рp])?/i);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);

    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      width: Math.abs(end - start) + 1
    };
  }

  const single = text.match(/№{1,2}\s*(\d{1,5})(?:\s*[-–—]\s*[рp])?/i);
  if (single) {
    const n = Number(single[1]);
    return { start: n, end: n, width: 1 };
  }

  return { start: 0, end: 0, width: 0 };
}

function resourceUpdatedTime(resource) {
  for (const field of ['last_modified', 'revision_timestamp', 'created']) {
    const value = resource?.[field];
    if (!value) continue;

    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }

  return Number.NEGATIVE_INFINITY;
}

function compareResourcesForSamePeriod(a, b) {
  const ar = parseDecisionRange(a);
  const br = parseDecisionRange(b);

  if (ar.end !== br.end) return ar.end - br.end;
  if (ar.width !== br.width) return ar.width - br.width;

  const at = resourceUpdatedTime(a);
  const bt = resourceUpdatedTime(b);

  if (at !== bt) return at - bt;

  const as = Number(a?.size || 0);
  const bs = Number(b?.size || 0);

  if (as !== bs) return as - bs;

  return String(resourceTitle(a)).localeCompare(String(resourceTitle(b)), 'uk');
}

function selectBestResourcePerMonth(resources) {
  const byPeriod = new Map();

  for (const resource of resources) {
    const key = resourcePeriodKey(resource);
    if (!key) continue;

    const current = byPeriod.get(key);
    if (!current || compareResourcesForSamePeriod(current, resource) < 0) {
      byPeriod.set(key, resource);
    }
  }

  return [...byPeriod.values()].sort((a, b) => resourceSortTime(b) - resourceSortTime(a));
}

function resourceSortTime(resource) {
  const parsed = parseResourceDate(resource);
  if (parsed) return Date.UTC(parsed.year, parsed.month - 1, parsed.day || 1);

  for (const field of ['last_modified', 'revision_timestamp', 'created']) {
    const value = resource?.[field];
    if (value) {
      const t = Date.parse(value);
      if (Number.isFinite(t)) return t;
    }
  }

  return Number.NEGATIVE_INFINITY;
}

function monthsDiffFromNow(year, month) {
  const now = new Date();
  return (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month);
}

function isWithinLookback(resource) {
  if (LOOKBACK_MONTHS <= 0) return true;

  const parsed = parseResourceDate(resource);

  // Якщо дату ресурсу не вдалося розпізнати, у звичайному моніторингу його не беремо.
  // Це захищає від випадкового підтягування старих архівних ресурсів.
  if (!parsed) return false;

  const diff = monthsDiffFromNow(parsed.year, parsed.month);
  return diff >= 0 && diff <= LOOKBACK_MONTHS;
}

async function getCandidateResources() {
  if (LOCAL_ZIP) {
    return [{
      id: 'local-zip-sample',
      name: `LOCAL_ZIP ${LOCAL_ZIP}`,
      title: `LOCAL_ZIP ${LOCAL_ZIP}`,
      format: 'ZIP',
      url: `file://${LOCAL_ZIP}`,
      localPath: LOCAL_ZIP
    }];
  }

  const pkg = await fetchJson(CKAN_PACKAGE_SHOW_URL);
  if (!pkg.success) throw new Error('CKAN package_show returned success=false');

  const resources = pkg.result?.resources || [];

  const recentResources = resources
    .filter(isDecisionZipResource)
    .filter(isWithinLookback);

  // data.gov.ua часто зберігає кілька ZIP за один місяць:
  // наприклад, частковий березень і пізніше повний березень.
  // Щоб не було дублів і зайвих Gemini-викликів, беремо найкращий ресурс за місяць.
  const bestByMonth = selectBestResourcePerMonth(recentResources);

  return bestByMonth.slice(0, MAX_RESOURCES);
}

async function extractZip(zipPath, outDir) {
  await fs.mkdir(outDir, { recursive: true });

  // У ZIP АМКУ інколи буває mismatch local/central filenames.
  // unzip може повернути code 1, але файли при цьому фактично розпаковуються.
  await runCmd('unzip', ['-qq', '-o', zipPath, '-d', outDir], {
    allowCodes: [0, 1],
    maxBuffer: 1024 * 1024 * 10
  });
}

async function listDocumentFiles(dir) {
  const found = [];

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const e of entries) {
      const p = path.join(current, e.name);

      if (e.isDirectory()) {
        await walk(p);
      } else if (/\.(docx?|rtf)$/i.test(e.name)) {
        found.push(p);
      }
    }
  }

  await walk(dir);

  return found.sort((a, b) => a.localeCompare(b, 'uk'));
}

async function extractText(filePath) {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.docx')) {
    const { stdout } = await runCmd('pandoc', ['-t', 'plain', filePath], {
      maxBuffer: 1024 * 1024 * 50
    });
    return normalizeSpaces(stdout);
  }

  if (lower.endsWith('.doc')) {
    try {
      const { stdout } = await runCmd('antiword', ['-m', 'UTF-8.txt', filePath], {
        maxBuffer: 1024 * 1024 * 50
      });
      return normalizeSpaces(stdout);
    } catch (err) {
      if (boolEnv('USE_LIBREOFFICE_FALLBACK', false)) {
        return await extractTextViaLibreOffice(filePath);
      }
      throw err;
    }
  }

  if (lower.endsWith('.rtf')) {
    const { stdout } = await runCmd('pandoc', ['-t', 'plain', filePath], {
      maxBuffer: 1024 * 1024 * 50
    });
    return normalizeSpaces(stdout);
  }

  return '';
}

async function extractTextViaLibreOffice(filePath) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amku-lo-'));

  await runCmd(
    'libreoffice',
    ['--headless', '--convert-to', 'txt:Text', '--outdir', outDir, filePath],
    { maxBuffer: 1024 * 1024 * 20 }
  );

  const files = await fs.readdir(outDir);
  const txt = files.find((f) => f.toLowerCase().endsWith('.txt'));

  if (!txt) throw new Error(`LibreOffice did not create txt for ${filePath}`);

  return normalizeSpaces(await fs.readFile(path.join(outDir, txt), 'utf8'));
}

function isConcentrationWithoutPermitP12(text) {
  const normalized = normalizeSpaces(text);

  const hasPoint12 =
    /пункт(?:ом|у)?\s*12\s+статті\s*50/i.test(normalized)
    || /п\.?\s*12\s+ст\.?\s*50/i.test(normalized);

  const hasConcentration =
    /здійснення\s+концентрації/i.test(normalized)
    || /концентраці[яї]\s+без\s+отримання/i.test(normalized)
    || /набуття\s+контролю/i.test(normalized)
    || /придбання\s+акці[йї]/i.test(normalized)
    || /придбання\s+активів/i.test(normalized);

  const hasWithoutPermit =
    /без\s+отримання\s+(?:відповідного\s+)?дозволу/i.test(normalized)
    || /наявність\s+такого\s+дозволу\s+необхідна/i.test(normalized);

  return hasPoint12 && hasConcentration && hasWithoutPermit;
}

function classifyDecision(text) {
  const normalized = normalizeSpaces(text);
  const head = normalized.slice(0, 25000);

  const include = INCLUDE_PATTERNS.some((re) => re.test(head));

  if (!include) return { relevant: false, reason: 'not_violation_decision' };

  const procedural = PROCEDURAL_PATTERNS.some((re) => re.test(head));
  if (procedural && !INCLUDE_PROCEDURAL_DECISIONS) {
    return { relevant: false, reason: 'procedural_decision' };
  }

  // Не передаємо в Gemini штрафи за gun-jumping:
  // здійснення концентрації без дозволу АМКУ, п. 12 ст. 50 Закону.
  if (isConcentrationWithoutPermitP12(normalized)) {
    return { relevant: false, reason: 'concentration_without_permit_p12' };
  }

  let lawArea = 'economic_competition';
  if (/недобросовісної\s+конкуренції/i.test(head)) lawArea = 'unfair_competition';

  return { relevant: true, reason: 'included_by_regex', lawArea };
}

function parseDecisionMeta(text, fileName = '') {
  const sample = normalizeSpaces(text).slice(0, 6000);

  const dateMatch = sample.match(
    /(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s+(20\d{2})\s*р?\.?/i
  );

  let isoDate = null;

  if (dateMatch) {
    const day = String(Number(dateMatch[1])).padStart(2, '0');
    const month = String(UA_MONTHS.get(dateMatch[2].toLowerCase())).padStart(2, '0');
    isoDate = `${dateMatch[3]}-${month}-${day}`;
  }

  let num = null;

  const afterDate = dateMatch ? sample.slice(dateMatch.index) : sample;

  const numberMatch =
    afterDate.match(/№\s*([0-9]{1,5}\s*[-–—]?\s*[а-яіїєґa-z]*)/i)
    || sample.match(/№\s*([0-9]{1,5}\s*[-–—]?\s*[а-яіїєґa-z]*)/i)
    || decodeHashUnicodeName(fileName).match(/№\s*([0-9]{1,5}\s*[-–—]?\s*[а-яіїєґa-z]*)/i)
    || decodeHashUnicodeName(fileName).match(/(\d{1,5})\s*[-–—]\s*р/i);

  if (numberMatch) {
    num = numberMatch[1].replace(/\s+/g, '').replace(/[–—]/g, '-');
    if (/^\d+$/.test(num)) num = `${num}-р`;
  }

  return { decision_date: isoDate, decision_number: num };
}

function decisionKey(meta, fileHash) {
  if (meta.decision_date && meta.decision_number) return `${meta.decision_date}|${meta.decision_number}`;
  if (meta.decision_number) return `unknown-date|${meta.decision_number}`;
  return `file-hash|${fileHash}`;
}

function fitTextForGemini(text) {
  if (text.length <= MAX_TEXT_CHARS) return text;

  const headChars = Math.floor(MAX_TEXT_CHARS * 0.7);
  const tailChars = MAX_TEXT_CHARS - headChars;

  return `${text.slice(0, headChars)}\n\n[... СЕРЕДИНУ ТЕКСТУ СКОРОЧЕНО АВТОМАТИЧНО ...]\n\n${text.slice(-tailChars)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateGeminiInputTokens(text) {
  // Rough but practical estimator for Ukrainian/English text.
  // We intentionally over-reserve a bit to avoid free-tier TPM errors.
  return Math.ceil(String(text || '').length / 3.5);
}

function pruneGeminiUsageWindow(now = Date.now()) {
  while (
    geminiUsageWindow.length
    && now - geminiUsageWindow[0].ts >= GEMINI_QUOTA_WINDOW_MS
  ) {
    geminiUsageWindow.shift();
  }
}

async function waitForGeminiQuota(estimatedInputTokens) {
  if (SKIP_GEMINI) return;

  const reservedTokens = Math.max(1, estimatedInputTokens || 1);

  while (true) {
    const now = Date.now();
    pruneGeminiUsageWindow(now);

    const usedRequests = geminiUsageWindow.length;
    const usedTokens = geminiUsageWindow.reduce((sum, item) => sum + item.tokens, 0);

    const wouldExceedRpm =
      GEMINI_RPM_LIMIT > 0
      && usedRequests + 1 > GEMINI_RPM_LIMIT;

    const wouldExceedTpm =
      GEMINI_TPM_LIMIT > 0
      && usedTokens + reservedTokens > GEMINI_TPM_LIMIT;

    if (!wouldExceedRpm && !wouldExceedTpm) {
      geminiUsageWindow.push({
        ts: Date.now(),
        tokens: reservedTokens
      });
      return;
    }

    const oldest = geminiUsageWindow[0];
    const waitMs = oldest
      ? Math.max(1000, GEMINI_QUOTA_WINDOW_MS - (now - oldest.ts) + GEMINI_RETRY_BUFFER_MS)
      : GEMINI_RETRY_BUFFER_MS;

    console.log(
      `Gemini quota throttle: waiting ${Math.ceil(waitMs / 1000)}s `
      + `(usedRequests=${usedRequests}/${GEMINI_RPM_LIMIT}, `
      + `usedInputTokens≈${usedTokens}/${GEMINI_TPM_LIMIT}, `
      + `nextInputTokens≈${reservedTokens})`
    );

    await sleep(waitMs);
  }
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

  const message = payload?.error?.message || '';
  const m = String(message).match(/retry\s+in\s+([\d.]+)s/i);
  if (m) return Math.ceil(Number(m[1]) * 1000) + GEMINI_RETRY_BUFFER_MS;

  return 60_000 + GEMINI_RETRY_BUFFER_MS;
}

function isGeminiQuotaError(status, payload) {
  return status === 429 || payload?.error?.status === 'RESOURCE_EXHAUSTED';
}

function buildGeminiPrompt({ text, meta, fileName, resourceTitle }) {
  return `Ти юрист у сфері конкурентної практики АМКУ.

Проаналізуй текст рішення Антимонопольного комітету України.

Поверни виключно валідний JSON без Markdown, без коментарів і без пояснень поза JSON.

Завдання:
1. Визнач реквізити рішення: номер і дата.
2. Визнач суб’єкта/суб’єктів, яких притягнуто до відповідальності.
3. Коротко опиши суть порушення і вкажи порушену норму закону.
4. Сформулюй ключовий висновок / правову кваліфікацію АМКУ. Зазвичай це розділ «Правова кваліфікація дій ...».
5. Витягни позицію порушника, заперечення або зауваження, якщо вони є. Зазвичай це розділ «Заперечення та зауваження на подання ...».
6. Витягни санкцію: розмір штрафу, зобов’язання, інші наслідки. Часто санкція є на початку і в резолютивній частині рішення.
7. Якщо певної інформації немає в тексті — постав null.
8. Не вигадуй інформацію. Якщо в тексті є прихована/обмежена інформація — так і зазнач.
9. Якщо це не рішення про порушення законодавства про захист економічної конкуренції або законодавства про захист від недобросовісної конкуренції — постав is_relevant=false.

Очікувана JSON-структура:
{
  "is_relevant": true,
  "decision_number": "",
  "decision_date": "YYYY-MM-DD",
  "law_area": "economic_competition | unfair_competition | other",
  "liable_parties": [""],
  "violation_summary": "",
  "legal_basis": [""],
  "amcu_reasoning": "",
  "respondent_position": "",
  "sanction": "",
  "important_notes": [""],
  "confidence": "high | medium | low"
}

Службові дані для звірки:
- Попередньо визначений номер: ${meta.decision_number || 'unknown'}
- Попередньо визначена дата: ${meta.decision_date || 'unknown'}
- Файл: ${fileName}
- Ресурс: ${resourceTitle}

Текст рішення:
${fitTextForGemini(text)}`;
}

async function analyzeWithGemini(input) {
  if (SKIP_GEMINI) {
    return {
      is_relevant: true,
      decision_number: input.meta.decision_number,
      decision_date: input.meta.decision_date,
      law_area: input.classification.lawArea || 'economic_competition',
      liable_parties: [],
      violation_summary: '[SKIP_GEMINI] Рішення відібрано regex-фільтром як потенційно релевантне.',
      legal_basis: [],
      amcu_reasoning: null,
      respondent_position: null,
      sanction: null,
      important_notes: ['Gemini-аналіз пропущено, бо SKIP_GEMINI=true.'],
      confidence: 'low'
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required unless SKIP_GEMINI=true');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const promptText = buildGeminiPrompt(input);
  const estimatedInputTokens = estimateGeminiInputTokens(promptText);

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
    await waitForGeminiQuota(estimatedInputTokens);

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

    if (isGeminiQuotaError(res.status, payload) && attempt < GEMINI_RETRY_MAX) {
      const waitMs = parseGeminiRetryDelayMs(payload);

      console.warn(
        `Gemini quota error. Retry ${attempt + 1}/${GEMINI_RETRY_MAX} `
        + `after ${Math.ceil(waitMs / 1000)}s.`
      );

      await sleep(waitMs);
      continue;
    }

    throw lastError;
  }

  throw lastError || new Error('Gemini request failed');
}

function parseJsonLenient(rawText) {
  const raw = String(rawText || '').trim();

  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');

    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));

    throw new Error(`Could not parse Gemini JSON: ${raw.slice(0, 800)}`);
  }
}

function normalizeAnalysis(analysis, meta, extra) {
  const out = {
    decision_number: analysis.decision_number || meta.decision_number || null,
    decision_date: normalizeDateValue(analysis.decision_date) || meta.decision_date || null,
    law_area: analysis.law_area || extra.classification?.lawArea || null,
    liable_parties: Array.isArray(analysis.liable_parties) ? analysis.liable_parties.filter(Boolean) : [],
    violation_summary: analysis.violation_summary || null,
    legal_basis: Array.isArray(analysis.legal_basis) ? analysis.legal_basis.filter(Boolean) : [],
    amcu_reasoning: analysis.amcu_reasoning || null,
    respondent_position: analysis.respondent_position || null,
    sanction: analysis.sanction || null,
    important_notes: Array.isArray(analysis.important_notes) ? analysis.important_notes.filter(Boolean) : [],
    confidence: analysis.confidence || null,
    source_file: extra.fileName,
    source_resource: extra.resourceTitle,
    source_resource_id: extra.resourceId,
    source_url: extra.resourceUrl,
    file_sha256: extra.fileHash,
    analyzed_at: new Date().toISOString()
  };

  out.sort_key = `${out.decision_date || '9999-99-99'}|${out.decision_number || ''}`;

  return out;
}

function normalizeDateValue(value) {
  if (!value) return null;

  const s = String(value).trim();

  if (/^20\d{2}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})/);
  if (m) {
    return `${m[3]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }

  return null;
}

function mergeResults(existing, additions) {
  const map = new Map();

  for (const row of existing || []) {
    const key = `${row.decision_date || ''}|${row.decision_number || ''}`;
    map.set(key, row);
  }

  for (const row of additions) {
    const key = `${row.decision_date || ''}|${row.decision_number || ''}`;
    map.set(key, row);
  }

  return [...map.values()].sort((a, b) =>
    String(a.sort_key || '').localeCompare(String(b.sort_key || ''), 'uk')
  );
}

function resultKey(row) {
  return `${row?.decision_date || ''}|${row?.decision_number || ''}`;
}

function resultQualityScore(row) {
  let score = 0;

  for (const field of ['violation_summary', 'amcu_reasoning', 'respondent_position', 'sanction']) {
    if (row?.[field]) score += String(row[field]).length;
  }

  if (Array.isArray(row?.liable_parties)) score += row.liable_parties.join(' ').length;
  if (Array.isArray(row?.legal_basis)) score += row.legal_basis.join(' ').length;

  if (row?.confidence === 'high') score += 1000;
  if (row?.confidence === 'medium') score += 500;

  return score;
}

function dedupeResults(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const key = resultKey(row);
    if (!key || key === '|') continue;

    const current = map.get(key);
    if (!current || resultQualityScore(row) >= resultQualityScore(current)) {
      map.set(key, row);
    }
  }

  return [...map.values()].sort((a, b) =>
    String(a.sort_key || '').localeCompare(String(b.sort_key || ''), 'uk')
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

function displayValue(value, fallback = 'Не подано / не виявлено в тексті рішення') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function renderText(value, fallback) {
  return htmlEscape(displayValue(value, fallback)).replace(/\n/g, '<br>');
}

function renderList(arr, fallback = 'Не подано / не виявлено в тексті рішення') {
  if (!Array.isArray(arr) || arr.length === 0) return htmlEscape(fallback);
  return arr.map((x) => htmlEscape(x)).join('<br>');
}

function plainList(arr, fallback = 'Не подано / не виявлено в тексті рішення') {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr.filter(Boolean).join('; ');
}

function lawAreaLabel(row) {
  if (row?.law_area === 'unfair_competition') return 'Захист від недобросовісної конкуренції';
  if (row?.law_area === 'economic_competition') return 'Захист економічної конкуренції';
  return 'Інше / потребує перевірки';
}

function violationBadge(row) {
  const basis = plainList(row?.legal_basis, '').toLowerCase();

  if (row?.law_area === 'unfair_competition' || /15\s*[¹1]/i.test(basis)) {
    return 'ст. 15¹';
  }

  if (/пункт\s*12|п\.?\s*12/i.test(basis)) return 'п. 12 ст. 50';
  if (/пункт\s*13|п\.?\s*13/i.test(basis)) return 'п. 13 ст. 50';
  if (/пункт\s*14|п\.?\s*14/i.test(basis)) return 'п. 14 ст. 50';
  if (/пункт\s*4|п\.?\s*4/i.test(basis)) return 'п. 4 ст. 50';

  return lawAreaLabel(row);
}

function decisionTitle(row) {
  return [row.decision_date, row.decision_number ? `№ ${row.decision_number}` : '']
    .filter(Boolean)
    .join(' ');
}

function renderDigestHtml(rows) {
  const title = 'Аналітичний огляд рішень АМКУ';

  if (!rows.length) {
    return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#111;">
  <h2>${title}</h2>
  <p>Нових релевантних рішень не виявлено.</p>
</body></html>`;
  }

  const summaryRows = rows.map((r) => `
    <tr>
      <td style="white-space:nowrap;vertical-align:top;">${htmlEscape(decisionTitle(r))}</td>
      <td style="vertical-align:top;">
        <span style="display:inline-block;padding:2px 6px;border:1px solid #999;border-radius:10px;background:#f7f7f7;">${htmlEscape(violationBadge(r))}</span><br>
        <span style="font-size:12px;color:#555;">${htmlEscape(lawAreaLabel(r))}</span>
      </td>
      <td style="vertical-align:top;">${renderList(r.liable_parties)}</td>
      <td style="vertical-align:top;">${renderText(r.sanction)}</td>
    </tr>`).join('\n');

  const cards = rows.map((r, index) => `
    <div style="border:1px solid #d9d9d9;border-radius:8px;padding:14px 16px;margin:18px 0;background:#fff;">
      <h3 style="margin:0 0 8px 0;font-size:17px;">${index + 1}. ${htmlEscape(decisionTitle(r))}</h3>
      <div style="margin:0 0 10px 0;color:#444;">${htmlEscape(violationBadge(r))} · ${htmlEscape(lawAreaLabel(r))}</div>

      <p style="margin:10px 0 4px 0;"><b>Суб’єкт порушення</b></p>
      <div style="margin:0 0 10px 0;">${renderList(r.liable_parties)}</div>

      <p style="margin:10px 0 4px 0;"><b>Суть порушення та норма</b></p>
      <div style="margin:0 0 10px 0;">
        ${renderText(r.violation_summary)}<br>
        <b>Норма:</b> ${renderList(r.legal_basis)}
      </div>

      <p style="margin:10px 0 4px 0;"><b>Ключовий висновок / обґрунтування АМКУ</b></p>
      <div style="margin:0 0 10px 0;">${renderText(r.amcu_reasoning)}</div>

      <p style="margin:10px 0 4px 0;"><b>Позиція порушника</b></p>
      <div style="margin:0 0 10px 0;">${renderText(r.respondent_position)}</div>

      <p style="margin:10px 0 4px 0;"><b>Санкція</b></p>
      <div style="margin:0 0 10px 0;">${renderText(r.sanction)}</div>

      <p style="margin:10px 0 4px 0;"><b>Джерело</b></p>
      <div style="font-size:12px;color:#555;">
        ${htmlEscape(r.source_resource || '')}<br>
        ${htmlEscape(r.source_file || '')}
        ${r.source_url ? `<br><a href="${htmlEscape(r.source_url)}">ZIP-ресурс на data.gov.ua</a>` : ''}
      </div>
    </div>`).join('\n');

  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#111;line-height:1.35;">
  <h2>${title}</h2>

  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;margin:0 0 18px 0;">
    <thead>
      <tr style="background:#f2f2f2;">
        <th>Рішення</th>
        <th>Тип / норма</th>
        <th>Суб’єкт</th>
        <th>Санкція</th>
      </tr>
    </thead>
    <tbody>${summaryRows}</tbody>
  </table>

  <h3 style="margin-top:18px;">Детальний аналіз</h3>
  ${cards}
</body></html>`;
}

function renderDigestText(rows) {
  if (!rows.length) {
    return 'Аналітичний огляд рішень АМКУ\n\nНових релевантних рішень не виявлено.';
  }

  return 'Аналітичний огляд рішень АМКУ\n\n' + rows.map((r, index) => [
    `${index + 1}. ${decisionTitle(r)}`,
    `Тип / норма: ${violationBadge(r)}; ${lawAreaLabel(r)}`,
    `Суб’єкт: ${plainList(r.liable_parties)}`,
    `Суть порушення та норма: ${displayValue(r.violation_summary)} Норма: ${plainList(r.legal_basis)}`,
    `Ключовий висновок / обґрунтування АМКУ: ${displayValue(r.amcu_reasoning)}`,
    `Позиція порушника: ${displayValue(r.respondent_position)}`,
    `Санкція: ${displayValue(r.sanction)}`,
    `Джерело: ${[r.source_resource, r.source_file, r.source_url].filter(Boolean).join(' | ')}`
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

async function sendDigest(rows, stats) {
  const emailTo = process.env.EMAIL_TO;
  const emailForce = boolEnv('EMAIL_FORCE', false);

  if (SKIP_GEMINI && !emailForce) {
    console.log('Email skipped: SKIP_GEMINI=true and EMAIL_FORCE=false.');
    return;
  }

  if ((!rows.length && !emailForce) || DRY_RUN) {
    console.log(`Email skipped. rows=${rows.length}, EMAIL_FORCE=${emailForce}, DRY_RUN=${DRY_RUN}`);
    return;
  }

  if (!emailTo) {
    console.log('Email skipped: EMAIL_TO is not configured.');
    return;
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

  const subject = rows.length
    ? `АМКУ: нові рішення про порушення — ${rows.length}`
    : 'АМКУ: нових рішень про порушення не виявлено';

  await transporter.sendMail({
    from: env('EMAIL_FROM', process.env.SMTP_USER || ''),
    to: emailTo,
    subject,
    text: renderDigestText(rows),
    html: renderDigestHtml(rows)
  });

  console.log(`Email sent to ${emailTo}`);
}

async function processResource(resource, state) {
  const title = resourceTitle(resource);
  const id = resource.id || resource.url || title;
  const signature = resourceSignature(resource);
  const prev = state.processed_resources[id];

  const prevResourceClean =
    prev?.state_version === RESOURCE_STATE_VERSION
    && Number(prev?.errors || 0) === 0
    && prev?.incomplete !== true;

  if (
    !LOCAL_ZIP
    && !FORCE
    && prevResourceClean
    && prev?.signature
    && signature
    && prev.signature === signature
  ) {
    return {
      skippedResource: true,
      reason: 'metadata_signature_unchanged',
      additions: [],
      stats: blankStats()
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amku-monitor-'));
  const zipPath = path.join(tmpDir, 'source.zip');

  let zipSha = null;

  if (resource.localPath) {
    await fs.copyFile(resource.localPath, zipPath);
    zipSha = await sha256File(zipPath);
  } else {
    zipSha = await downloadFile(resource.url, zipPath);
  }

  if (!FORCE && prevResourceClean && prev?.zip_sha256 && prev.zip_sha256 === zipSha) {
    return {
      skippedResource: true,
      reason: 'zip_hash_unchanged',
      additions: [],
      stats: blankStats()
    };
  }

  const extractDir = path.join(tmpDir, 'unzipped');

  await extractZip(zipPath, extractDir);

  const files = await listDocumentFiles(extractDir);

  const stats = blankStats();
  stats.resourcesChecked = 1;
  stats.docsSeen = files.length;

  const additions = [];
  let geminiCalls = 0;

  for (const file of files) {
    const decodedFileName = decodeHashUnicodeName(path.relative(extractDir, file));

    try {
      const fileHash = await sha256File(file);
      const text = await extractText(file);
      const meta = parseDecisionMeta(text, decodedFileName);
      const key = decisionKey(meta, fileHash);
      const known = state.processed_decisions[key];

      if (!FORCE && known?.file_sha256 === fileHash && known?.status === 'analyzed') {
        stats.docsSkipped += 1;
        continue;
      }

      const classification = classifyDecision(text);

      if (!classification.relevant) {
        stats.docsSkipped += 1;

        state.processed_decisions[key] = {
          status: 'skipped',
          reason: classification.reason,
          decision_number: meta.decision_number,
          decision_date: meta.decision_date,
          file_sha256: fileHash,
          source_resource_id: id,
          source_file: decodedFileName,
          updated_at: new Date().toISOString()
        };

        continue;
      }

      stats.docsRelevant += 1;

      if (geminiCalls >= MAX_GEMINI_CALLS) {
        stats.errors += 1;
        await appendEvent({
          type: 'gemini_budget_exceeded',
          resource_id: id,
          file: decodedFileName,
          key
        });
        continue;
      }

      geminiCalls += 1;

      const analysis = await analyzeWithGemini({
        text,
        meta,
        fileName: decodedFileName,
        resourceTitle: title,
        classification
      });

      if (analysis.is_relevant === false) {
        stats.docsSkipped += 1;

        state.processed_decisions[key] = {
          status: 'skipped_by_gemini',
          decision_number: meta.decision_number,
          decision_date: meta.decision_date,
          file_sha256: fileHash,
          source_resource_id: id,
          source_file: decodedFileName,
          updated_at: new Date().toISOString()
        };

        continue;
      }

      const row = normalizeAnalysis(analysis, meta, {
        classification,
        fileName: decodedFileName,
        resourceTitle: title,
        resourceId: id,
        resourceUrl: resource.url,
        fileHash
      });

      additions.push(row);

      state.processed_decisions[key] = {
        status: 'analyzed',
        decision_number: row.decision_number,
        decision_date: row.decision_date,
        file_sha256: fileHash,
        source_resource_id: id,
        source_file: decodedFileName,
        updated_at: new Date().toISOString()
      };

      await appendEvent({
        type: 'decision_analyzed',
        key,
        resource_id: id,
        file: decodedFileName,
        decision_number: row.decision_number,
        decision_date: row.decision_date
      });
    } catch (err) {
      stats.errors += 1;

      await appendEvent({
        type: 'document_error',
        resource_id: id,
        file: decodedFileName,
        error: String(err.message || err).slice(0, 1500)
      });

      console.error(`Document error: ${decodedFileName}: ${err.message}`);
    }
  }

  state.processed_resources[id] = {
    state_version: RESOURCE_STATE_VERSION,
    title,
    url: resource.url,
    signature,
    zip_sha256: zipSha,
    processed_at: new Date().toISOString(),
    docs_seen: stats.docsSeen,
    docs_relevant: stats.docsRelevant,
    errors: stats.errors,
    incomplete: stats.errors > 0
  };

  return { skippedResource: false, additions, stats };
}

function blankStats() {
  return {
    resourcesChecked: 0,
    docsSeen: 0,
    docsRelevant: 0,
    docsSkipped: 0,
    errors: 0
  };
}

function addStats(a, b) {
  for (const k of Object.keys(a)) {
    a[k] += b[k] || 0;
  }

  return a;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const state = await readJson(STATE_PATH, {
    processed_resources: {},
    processed_decisions: {},
    last_run: null
  });

  state.processed_resources ||= {};
  state.processed_decisions ||= {};

  const existingResults = await readJson(RESULTS_PATH, []);

  const resources = await getCandidateResources();

  console.log(`Candidate resources: ${resources.length}`);
  for (const r of resources) {
    console.log(`- ${resourceTitle(r)} (${r.format || ''})`);
  }

  const additions = [];
  const totalStats = blankStats();

  for (const resource of resources) {
    console.log(`Processing: ${resourceTitle(resource)}`);

    try {
      const result = await processResource(resource, state);

      addStats(totalStats, result.stats);
      additions.push(...result.additions);

      if (result.skippedResource) {
        console.log(`Skipped resource: ${result.reason}`);
      } else {
        console.log(`Resource done: +${result.additions.length} analyzed rows`);
      }
    } catch (err) {
      totalStats.errors += 1;

      await appendEvent({
        type: 'resource_error',
        resource_id: resource.id,
        resource: resourceTitle(resource),
        error: String(err.message || err).slice(0, 1500)
      });

      console.error(`Resource error: ${resourceTitle(resource)}: ${err.message}`);
    }
  }

  const uniqueAdditions = dedupeResults(additions);
  const duplicatesInRun = additions.length - uniqueAdditions.length;
  const merged = mergeResults(existingResults, uniqueAdditions);

  state.last_run = {
    at: new Date().toISOString(),
    resources_considered: resources.length,
    additions: uniqueAdditions.length,
    raw_additions: additions.length,
    duplicates_in_run: duplicatesInRun,
    stats: totalStats
  };

  console.log(`New/updated relevant rows: ${uniqueAdditions.length}`);

  if (duplicatesInRun > 0) {
    console.log(`Duplicate rows skipped before email/results: ${duplicatesInRun}`);
  }

  console.log(`Stats: ${JSON.stringify(totalStats)}`);

  if (!DRY_RUN) {
    await writeJson(STATE_PATH, state);
    await writeJson(RESULTS_PATH, merged);
  } else {
    console.log('DRY_RUN=true: state/results files were not written.');
  }

  const rowsForDigest = uniqueAdditions.sort((a, b) =>
    String(a.sort_key || '').localeCompare(String(b.sort_key || ''), 'uk')
  );

  await sendDigest(rowsForDigest, totalStats);

  if (DRY_RUN || SKIP_GEMINI) {
    console.log('\nRows selected in this run:');

    for (const row of rowsForDigest) {
      console.log(`- ${row.decision_date || '?'} № ${row.decision_number || '?'} | ${row.source_file}`);
    }
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
