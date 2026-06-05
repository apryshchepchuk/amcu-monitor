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
const PRACTICE_RESULTS_PATH = path.join(DATA_DIR, 'practice', 'amku_practice.json');
const EVENTS_PATH = path.join(DATA_DIR, 'amku_events.jsonl');

const DATASET_ID = env('DATASET_ID', '8bdd45b8-0684-463a-ba76-26361c32841a');
const CKAN_PACKAGE_SHOW_URL = env(
  'CKAN_PACKAGE_SHOW_URL',
  `https://data.gov.ua/api/3/action/package_show?id=${encodeURIComponent(DATASET_ID)}`
);

const LOOKBACK_MONTHS = intEnv('LOOKBACK_MONTHS', 3);
const MAX_RESOURCES = intEnv('MAX_RESOURCES', 12);
const FORCE_RESOURCES = boolEnv('FORCE_RESOURCES', boolEnv('FORCE', false));
const FORCE_REANALYZE_DECISIONS = boolEnv('FORCE_REANALYZE_DECISIONS', false);
const DRY_RUN = boolEnv('DRY_RUN', false);
const SKIP_GEMINI = boolEnv('SKIP_GEMINI', false);
const INCLUDE_PROCEDURAL_DECISIONS = boolEnv('INCLUDE_PROCEDURAL_DECISIONS', false);
const MAX_TEXT_CHARS = intEnv('MAX_TEXT_CHARS', 90000);
const MAX_GEMINI_CALLS = intEnv('MAX_GEMINI_CALLS', 50);
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-3.1-flash-lite');
const LOCAL_ZIP = process.env.LOCAL_ZIP || '';

// Practice database mode: by default we do not send email and do not exclude p.12 ст. 50.
const EMAIL_DISABLED = boolEnv('EMAIL_DISABLED', true);
const PRACTICE_DB_ENABLED = boolEnv('PRACTICE_DB_ENABLED', true);
const INCLUDE_CONCENTRATION_P12 = boolEnv('INCLUDE_CONCENTRATION_P12', true);
const PROMPT_VERSION = intEnv('PROMPT_VERSION', 4);


// Historical backfill mode: process only the next unfinished month(s), skipping fully clean months.
const BACKFILL_ENABLED = boolEnv('BACKFILL_ENABLED', false);
const BACKFILL_MONTHS_PER_RUN = intEnv('BACKFILL_MONTHS_PER_RUN', 1);
const BACKFILL_FROM_MONTH = env('BACKFILL_FROM_MONTH', ''); // YYYY-MM, optional lower bound
const BACKFILL_TO_MONTH = env('BACKFILL_TO_MONTH', '');     // YYYY-MM, optional upper bound

// Conservative Gemini quota controls.
// Free-tier observed limits can be around 15 RPM / 250k input TPM, so defaults keep a buffer.
const GEMINI_RPM_LIMIT = intEnv('GEMINI_RPM_LIMIT', 5);
const GEMINI_TPM_LIMIT = intEnv('GEMINI_TPM_LIMIT', 120000);
const GEMINI_RETRY_MAX = intEnv('GEMINI_RETRY_MAX', 4);
const GEMINI_RETRY_BUFFER_MS = intEnv('GEMINI_RETRY_BUFFER_MS', 1500);
const GEMINI_TOKEN_ESTIMATE_CHARS_PER_TOKEN = Number.parseFloat(
  env('GEMINI_TOKEN_ESTIMATE_CHARS_PER_TOKEN', '2.0')
) || 2.0;
const GEMINI_QUOTA_WINDOW_MS = 60_000;
const geminiUsageWindow = [];

// Resource-level state version. Increment when resource skip / classification logic changes.
const RESOURCE_STATE_VERSION = 4;

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


const ZEK_ARTICLE_50_TAXONOMY = {
  1: 'антиконкурентні узгоджені дії',
  2: 'зловживання монопольним (домінуючим) становищем',
  3: 'антиконкурентні дії органів влади, органів місцевого самоврядування, органів адміністративно-господарського управління та контролю',
  4: 'невиконання рішення, попереднього рішення органів АМКУ або їх виконання не в повному обсязі',
  5: 'дії учасників узгоджених дій, заборонені згідно з ч. 5 ст. 10 Закону',
  6: 'делегування повноважень у випадках, заборонених ст. 16 Закону',
  7: 'вчинення дій, заборонених ст. 17 Закону',
  8: 'обмежувальна та дискримінаційна діяльність, заборонена ч. 2 ст. 18, ст. 19 і 20 Закону',
  9: 'обмежувальна діяльність, заборонена ч. 1 ст. 18 Закону',
  10: 'недотримання умов, передбачених пунктами 2, 5 та 6 ч. 3 ст. 22 Закону',
  11: 'порушення положень погоджених установчих документів суб’єкта, створеного в результаті концентрації',
  12: 'концентрація без отримання відповідного дозволу органів АМКУ',
  13: 'неподання інформації у встановлені строки',
  14: 'подання інформації в неповному обсязі у встановлені строки',
  15: 'подання недостовірної інформації',
  16: 'створення перешкод працівникам АМКУ у проведенні перевірок, огляду, вилученні чи накладенні арешту',
  17: 'надання рекомендацій, що схиляють до вчинення порушень або сприяють таким порушенням',
  18: 'обмеження в господарській діяльності у відповідь на звернення до АМКУ',
  19: 'невиконання вимог і зобов’язань, якими було обумовлене рішення про надання дозволу',
  20: 'обмежувальна діяльність об’єднань, заборонена ст. 21 Закону',
  21: 'розпломбування приміщень, систем електронних комунікацій, інших володінь чи місць зберігання інформації'
};

const UNFAIR_COMPETITION_TAXONOMY = {
  '4': 'неправомірне використання позначень',
  '5': 'неправомірне використання товару іншого виробника',
  '6': 'копіювання зовнішнього вигляду виробу',
  '7': 'порівняльна реклама',
  '8': 'дискредитація суб’єкта господарювання',
  '10': 'схилення до бойкоту суб’єкта господарювання',
  '11': 'схилення постачальника до дискримінації покупця (замовника)',
  '13': 'підкуп працівника, посадової особи постачальника',
  '14': 'підкуп працівника, посадової особи покупця (замовника)',
  '15': 'досягнення неправомірних переваг у конкуренції',
  '15-1': 'поширення інформації, що вводить в оману',
  '16': 'неправомірне збирання комерційної таємниці',
  '17': 'розголошення комерційної таємниці',
  '18': 'схилення до розголошення комерційної таємниці',
  '19': 'неправомірне використання комерційної таємниці'
};

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

function monthKeyValue(key) {
  const m = String(key || '').match(/^(20\d{2})-(\d{2})$/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  return year * 12 + month;
}

function isWithinBackfillMonthRange(resource) {
  const key = resourcePeriodKey(resource);
  if (!key) return false;

  const current = monthKeyValue(key);
  const from = BACKFILL_FROM_MONTH ? monthKeyValue(BACKFILL_FROM_MONTH) : null;
  const to = BACKFILL_TO_MONTH ? monthKeyValue(BACKFILL_TO_MONTH) : null;

  if (from !== null && current < from) return false;
  if (to !== null && current > to) return false;

  return true;
}

function isResourceCleanInState(resource, state) {
  if (!state?.processed_resources) return false;

  const id = resource.id || resource.url || resourceTitle(resource);
  const prev = state.processed_resources[id];

  return Boolean(
    prev?.state_version === RESOURCE_STATE_VERSION
    && Number(prev?.errors || 0) === 0
    && prev?.incomplete !== true
  );
}

async function getCandidateResources(state = null) {
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
  const decisionZipResources = resources.filter(isDecisionZipResource);

  if (BACKFILL_ENABLED) {
    const backfillResources = selectBestResourcePerMonth(decisionZipResources)
      .filter(isWithinBackfillMonthRange)
      .filter((resource) => !isResourceCleanInState(resource, state));

    return backfillResources.slice(0, Math.max(1, BACKFILL_MONTHS_PER_RUN));
  }

  const recentResources = decisionZipResources.filter(isWithinLookback);

  // data.gov.ua often stores several ZIPs for one month; keep the most complete one.
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

  // У режимі бази практики за замовчуванням п. 12 ст. 50 НЕ відсікаємо.
  // Для вузької email-розсилки можна встановити INCLUDE_CONCENTRATION_P12=false.
  if (!INCLUDE_CONCENTRATION_P12 && isConcentrationWithoutPermitP12(normalized)) {
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


function uniqueArray(values) {
  return [...new Set((values || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map((v) => String(v).trim()))];
}

function compactTextParts(...parts) {
  return normalizeSpaces(
    parts
      .flatMap((part) => {
        if (Array.isArray(part)) return part;
        if (part && typeof part === 'object') return Object.values(part);
        return [part];
      })
      .filter(Boolean)
      .join('\n')
  );
}

function normalizeUnfairArticle(raw) {
  if (raw === null || raw === undefined) return null;

  const s = String(raw)
    .toLowerCase()
    .replace(/¹/g, '-1')
    .replace(/прим\.\s*1/g, '-1')
    .replace(/примітка\s*1/g, '-1')
    .replace(/\s+/g, '')
    .replace(/[–—]/g, '-');

  if (/^15-?1$/.test(s)) return '15-1';

  const n = Number.parseInt(s, 10);
  if (Number.isFinite(n) && Object.hasOwn(UNFAIR_COMPETITION_TAXONOMY, String(n))) {
    return String(n);
  }

  return null;
}

function normalizePrimaryCode(raw) {
  if (!raw) return null;

  const s = String(raw).toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');

  let m = s.match(/^zek:50:(\d{1,2})$/);
  if (m) {
    const p = Number(m[1]);
    if (Object.hasOwn(ZEK_ARTICLE_50_TAXONOMY, p)) return `zek:50:${p}`;
  }

  m = s.match(/^unfair:(15-?1|\d{1,2})$/);
  if (m) {
    const art = normalizeUnfairArticle(m[1]);
    if (art) return `unfair:${art}`;
  }

  return null;
}

function article50Label(point) {
  const p = Number(point);
  const label = ZEK_ARTICLE_50_TAXONOMY[p] || 'невизначене порушення';
  return `п. ${p} ст. 50 — ${label}`;
}

function unfairArticleLabel(article) {
  const art = normalizeUnfairArticle(article);
  const label = UNFAIR_COMPETITION_TAXONOMY[art] || 'невизначене порушення';
  return `ст. ${art} — ${label}`;
}

function classificationFromPrimaryCode(primaryCode, fallback = {}) {
  const code = normalizePrimaryCode(primaryCode);
  if (!code) return null;

  // Dashboard classification must be strict and canonical:
  // - zek:* cards are driven only by article_50_points;
  // - unfair:* cards are driven only by unfair_competition_articles.
  // Contextual references to other laws/articles are preserved only in secondary_legal_basis.
  if (code.startsWith('zek:50:')) {
    const point = Number(code.split(':').pop());
    return {
      law_family: 'economic_competition',
      primary_code: code,
      primary_article: `п. ${point} ст. 50`,
      primary_label: article50Label(point),
      article_50_points: [point],
      unfair_competition_articles: [],
      secondary_legal_basis: uniqueArray(fallback.secondary_legal_basis || [])
    };
  }

  if (code.startsWith('unfair:')) {
    const article = normalizeUnfairArticle(code.replace('unfair:', ''));
    return {
      law_family: 'unfair_competition',
      primary_code: `unfair:${article}`,
      primary_article: `ст. ${article}`,
      primary_label: unfairArticleLabel(article),
      article_50_points: [],
      unfair_competition_articles: [article],
      secondary_legal_basis: uniqueArray(fallback.secondary_legal_basis || [])
    };
  }

  return null;
}

function extractArticle50Points(text) {
  const s = normalizeSpaces(text);
  const points = [];

  const patterns = [
    /пункт(?:ом|у|а|і)?\s*(\d{1,2})\s+статті\s*50/gi,
    /п\.?\s*(\d{1,2})\s*ст\.?\s*50/gi,
    /пункт(?:ом|у|а|і)?\s*(\d{1,2})\s+частини\s+першої\s+статті\s*50/gi
  ];

  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const p = Number(m[1]);
      if (Object.hasOwn(ZEK_ARTICLE_50_TAXONOMY, p)) points.push(p);
    }
  }

  // Часто рішення описує тендерні змови через "пункт 4 частини другої статті 6",
  // але безпосередня кваліфікація за ст. 50 все одно зазвичай п. 1 ст. 50.
  if (
    /пункт(?:ом|у|а|і)?\s*4\s+частини\s+другої\s+статті\s*6/i.test(s)
    && /антиконкурентн[іи]\s+узгоджен[іи]\s+ді[їй]/i.test(s)
  ) {
    points.push(1);
  }

  if (/частин[аи]\s+перш[аої]+\s+статті\s*13/i.test(s) && /зловживан/i.test(s)) {
    points.push(2);
  }

  return uniqueArray(points).map(Number).sort((a, b) => a - b);
}

function extractUnfairCompetitionArticles(text) {
  const s = normalizeSpaces(text);
  const articles = [];

  const patterns = [
    /статт(?:і|ею|я)\s*(15\s*[-–—]?\s*1|15\s*¹|15¹|\d{1,2})\s+Закону\s+України\s+«?Про\s+захист\s+від\s+недобросовісної\s+конкуренції»?/gi,
    /ст\.?\s*(15\s*[-–—]?\s*1|15\s*¹|15¹|\d{1,2})\s+Закону\s+України\s+«?Про\s+захист\s+від\s+недобросовісної\s+конкуренції»?/gi
  ];

  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      const art = normalizeUnfairArticle(m[1]);
      if (art) articles.push(art);
    }
  }

  return uniqueArray(articles).sort((a, b) => Number(a.replace('-1', '.1')) - Number(b.replace('-1', '.1')));
}

function collectLegalBasis(analysis) {
  return uniqueArray([
    ...(Array.isArray(analysis?.legal_basis) ? analysis.legal_basis : []),
    ...(Array.isArray(analysis?.classification?.secondary_legal_basis) ? analysis.classification.secondary_legal_basis : []),
    ...(Array.isArray(analysis?.classification?.legal_basis) ? analysis.classification.legal_basis : []),
    analysis?.classification?.primary_article,
    analysis?.classification?.primary_label
  ]);
}

function inferPrimaryCodeFromText(text, analysis = {}) {
  const legalBasisText = compactTextParts(
    collectLegalBasis(analysis),
    analysis?.violation_summary,
    analysis?.amcu_reasoning,
    analysis?.classification?.primary_code,
    analysis?.classification?.primary_article,
    analysis?.classification?.primary_label
  );

  const article50Points = extractArticle50Points(legalBasisText);
  const unfairArticles = extractUnfairCompetitionArticles(legalBasisText);

  // Якщо безпосередня норма ст. 50 є в legal_basis, вона має пріоритет.
  // Це захищає кейси "неподання інформації у справі про недобросовісну конкуренцію":
  // primary має бути zek:50:13, а не unfair:*.
  if (article50Points.length) return `zek:50:${article50Points[0]}`;
  if (unfairArticles.length) return `unfair:${unfairArticles[0]}`;

  const broaderText = compactTextParts(
    legalBasisText,
    String(text || '').slice(0, 25000),
    String(text || '').slice(-12000)
  );

  const broaderArticle50Points = extractArticle50Points(broaderText);
  const broaderUnfairArticles = extractUnfairCompetitionArticles(broaderText);

  if (broaderArticle50Points.length) return `zek:50:${broaderArticle50Points[0]}`;
  if (broaderUnfairArticles.length) return `unfair:${broaderUnfairArticles[0]}`;

  return null;
}

function buildCanonicalClassification(analysis, text, fallbackLawArea = null) {
  const secondaryLegalBasis = collectLegalBasis(analysis);
  const relevantText = compactTextParts(
    secondaryLegalBasis,
    analysis?.violation_summary,
    analysis?.amcu_reasoning,
    analysis?.sanction,
    String(text || '').slice(0, 25000),
    String(text || '').slice(-12000)
  );

  const article50Points = uniqueArray([
    ...(Array.isArray(analysis?.classification?.article_50_points) ? analysis.classification.article_50_points : []),
    ...extractArticle50Points(relevantText)
  ]).map(Number).filter((p) => Object.hasOwn(ZEK_ARTICLE_50_TAXONOMY, p)).sort((a, b) => a - b);

  const unfairCompetitionArticles = uniqueArray([
    ...(Array.isArray(analysis?.classification?.unfair_competition_articles) ? analysis.classification.unfair_competition_articles : []),
    ...extractUnfairCompetitionArticles(relevantText)
  ]).map(normalizeUnfairArticle).filter(Boolean);

  const geminiPrimary = normalizePrimaryCode(analysis?.classification?.primary_code);
  const inferredPrimary = inferPrimaryCodeFromText(text, analysis);
  const primaryCode = inferredPrimary || geminiPrimary;

  const built = classificationFromPrimaryCode(primaryCode, {
    article_50_points: article50Points,
    unfair_competition_articles: unfairCompetitionArticles,
    secondary_legal_basis: secondaryLegalBasis
  });

  if (built) return built;

  const lawFamily =
    analysis?.classification?.law_family
    || fallbackLawArea
    || analysis?.law_area
    || 'other';

  return {
    law_family: lawFamily,
    primary_code: 'other',
    primary_article: null,
    primary_label: 'Інше / потребує перевірки',
    article_50_points: article50Points,
    unfair_competition_articles: unfairCompetitionArticles,
    secondary_legal_basis: secondaryLegalBasis
  };
}

function normalizeSanctionAmounts(value) {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    if (item && typeof item === 'object') {
      const amount = item.amount_uah ?? item.amount ?? item.value ?? null;
      const normalizedAmount = typeof amount === 'number'
        ? amount
        : Number(String(amount || '').replace(/[^\d.,]/g, '').replace(',', '.')) || null;

      return {
        party: item.party || item.subject || null,
        amount_uah: normalizedAmount,
        note: item.note || null
      };
    }

    return null;
  }).filter(Boolean);
}

function buildGeminiPrompt({ text, meta, fileName, resourceTitle }) {
  const article50List = Object.entries(ZEK_ARTICLE_50_TAXONOMY)
    .map(([point, label]) => `- zek:50:${point}: п. ${point} ст. 50 — ${label}`)
    .join('\n');

  const unfairList = Object.entries(UNFAIR_COMPETITION_TAXONOMY)
    .map(([article, label]) => `- unfair:${article}: ст. ${article} — ${label}`)
    .join('\n');

  return `Ти юрист у сфері конкурентної практики Антимонопольного комітету України.

Проаналізуй текст рішення АМКУ і сформуй структурований JSON для бази практики та майбутнього дашборду.

Поверни виключно валідний JSON без Markdown, без коментарів і без пояснень поза JSON.

Ключове правило класифікації:
Класифікуй рішення за безпосереднім порушенням, за яке суб’єкта притягнуто до відповідальності / на яке накладено санкцію.

Важливі уточнення:
- Якщо рішення про неподання інформації у межах розслідування недобросовісної конкуренції, primary_code має бути "zek:50:13", а не "unfair:*".
- Якщо рішення про подання інформації в неповному обсязі, primary_code має бути "zek:50:14".
- Якщо рішення про подання недостовірної інформації, primary_code має бути "zek:50:15".
- Якщо рішення про концентрацію без дозволу АМКУ, primary_code має бути "zek:50:12".
- Якщо рішення про поширення інформації, що вводить в оману, primary_code має бути "unfair:15-1".
- Якщо рішення містить кілька порушень, article_50_points або unfair_competition_articles мають містити всі знайдені норми, але primary_code постав за основним/першим порушенням, за яке накладена санкція.
- Не вигадуй інформацію. Якщо певне поле не встановлюється з тексту — постав null або порожній масив.

Довідник primary_code для ст. 50 Закону України «Про захист економічної конкуренції»:
${article50List}

Довідник primary_code для Закону України «Про захист від недобросовісної конкуренції»:
${unfairList}

Завдання:
1. Визнач реквізити рішення: номер і дата.
2. Визнач суб’єкта/суб’єктів, яких притягнуто до відповідальності.
3. Визнач чітку юридичну класифікацію за довідниками вище.
4. Коротко опиши суть порушення і порушену норму.
5. Сформулюй ключовий висновок / правову кваліфікацію АМКУ.
6. Витягни позицію порушника, заперечення або зауваження, якщо вони є.
7. Витягни санкцію: розмір штрафу, зобов’язання, інші наслідки.
8. Сформуй 3-7 ключових практичних висновків для юриста.
9. Витягни ключові докази / фактори, на які спирався АМКУ.
10. Визнач ринок або сектор, якщо це можливо.
11. Сформуй 10-20 search_keywords українською для пошуку по дашборду.

Очікувана JSON-структура:
{
  "is_relevant": true,
  "decision_number": "",
  "decision_date": "YYYY-MM-DD",
  "classification": {
    "law_family": "economic_competition | unfair_competition | other",
    "primary_code": "zek:50:1 | zek:50:2 | ... | unfair:4 | unfair:15-1 | other",
    "primary_article": "",
    "primary_label": "",
    "article_50_points": [],
    "unfair_competition_articles": [],
    "secondary_legal_basis": []
  },
  "liable_parties": [""],
  "violation_summary": "",
  "legal_basis": [""],
  "amcu_reasoning": "",
  "respondent_position": "",
  "sanction": "",
  "sanction_amounts": [
    {
      "party": "",
      "amount_uah": 0,
      "note": ""
    }
  ],
  "key_takeaways": [""],
  "evidence_factors": [""],
  "market_or_sector": "",
  "search_keywords": [""],
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
      classification: {
        law_family: input.classification.lawArea || 'economic_competition',
        primary_code: null,
        primary_article: null,
        primary_label: null,
        article_50_points: [],
        unfair_competition_articles: [],
        secondary_legal_basis: []
      },
      law_area: input.classification.lawArea || 'economic_competition',
      liable_parties: [],
      violation_summary: '[SKIP_GEMINI] Рішення відібрано regex-фільтром як потенційно релевантне.',
      legal_basis: [],
      amcu_reasoning: null,
      respondent_position: null,
      sanction: null,
      sanction_amounts: [],
      key_takeaways: [],
      evidence_factors: [],
      market_or_sector: null,
      search_keywords: [],
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

function normalizeAnalysis(analysis, meta, extra) {
  const canonicalClassification = buildCanonicalClassification(
    analysis,
    extra.text || '',
    extra.classification?.lawArea || analysis.law_area || null
  );

  const legalBasis = uniqueArray([
    ...(Array.isArray(analysis.legal_basis) ? analysis.legal_basis : []),
    ...(canonicalClassification.secondary_legal_basis || [])
  ]);

  const out = {
    decision_key: null,
    decision_number: analysis.decision_number || meta.decision_number || null,
    decision_date: normalizeDateValue(analysis.decision_date) || meta.decision_date || null,
    year: null,
    month: null,

    classification: canonicalClassification,
    primary_code: canonicalClassification.primary_code,
    primary_label: canonicalClassification.primary_label,

    // Backward-compatible fields for older scripts / temporary views.
    law_area: canonicalClassification.law_family || analysis.law_area || extra.classification?.lawArea || null,
    legal_basis: legalBasis,

    liable_parties: Array.isArray(analysis.liable_parties) ? analysis.liable_parties.filter(Boolean) : [],
    violation_summary: analysis.violation_summary || null,
    amcu_reasoning: analysis.amcu_reasoning || null,
    respondent_position: analysis.respondent_position || null,
    sanction: analysis.sanction || null,
    sanction_amounts: normalizeSanctionAmounts(analysis.sanction_amounts),

    key_takeaways: Array.isArray(analysis.key_takeaways) ? analysis.key_takeaways.filter(Boolean) : [],
    evidence_factors: Array.isArray(analysis.evidence_factors) ? analysis.evidence_factors.filter(Boolean) : [],
    market_or_sector: analysis.market_or_sector || null,
    search_keywords: Array.isArray(analysis.search_keywords) ? uniqueArray(analysis.search_keywords) : [],

    important_notes: Array.isArray(analysis.important_notes) ? analysis.important_notes.filter(Boolean) : [],
    confidence: analysis.confidence || null,

    source_file: extra.fileName,
    source_resource: extra.resourceTitle,
    source_resource_id: extra.resourceId,
    source_url: extra.resourceUrl,
    source: {
      resource_id: extra.resourceId,
      resource_title: extra.resourceTitle,
      file: extra.fileName,
      url: extra.resourceUrl
    },

    file_sha256: extra.fileHash,
    analyzed_at: new Date().toISOString(),
    analysis: {
      model: GEMINI_MODEL,
      prompt_version: PROMPT_VERSION,
      analyzed_at: new Date().toISOString()
    }
  };

  if (out.decision_date) {
    const [year, month] = out.decision_date.split('-').map((x) => Number.parseInt(x, 10));
    out.year = Number.isFinite(year) ? year : null;
    out.month = Number.isFinite(month) ? month : null;
  }

  out.decision_key = `${out.decision_date || 'unknown-date'}|${out.decision_number || extra.fileHash}`;
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
  if (EMAIL_DISABLED) {
    console.log('Email disabled: EMAIL_DISABLED=true.');
    return;
  }

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

async function processResource(resource, state, runBudget) {
  const title = resourceTitle(resource);
  const id = resource.id || resource.url || title;
  const signature = resourceSignature(resource);
  const prev = state.processed_resources[id];

  const prevResourceClean =
    prev?.state_version === RESOURCE_STATE_VERSION
    && Number(prev?.errors || 0) === 0
    && prev?.incomplete !== true;

  if (!LOCAL_ZIP && !FORCE_RESOURCES && prevResourceClean && prev?.signature && signature && prev.signature === signature) {
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

  if (!FORCE_RESOURCES && prevResourceClean && prev?.zip_sha256 && prev.zip_sha256 === zipSha) {
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

  for (const file of files) {
    const decodedFileName = decodeHashUnicodeName(path.relative(extractDir, file));

    try {
      const fileHash = await sha256File(file);
      const text = await extractText(file);
      const meta = parseDecisionMeta(text, decodedFileName);
      const key = decisionKey(meta, fileHash);
      const known = state.processed_decisions[key];

      if (!FORCE_REANALYZE_DECISIONS && known?.file_sha256 === fileHash && known?.status === 'analyzed') {
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

      if (runBudget.geminiCalls >= MAX_GEMINI_CALLS) {
        stats.errors += 1;
        await appendEvent({
          type: 'gemini_budget_exceeded',
          resource_id: id,
          file: decodedFileName,
          key,
          max_gemini_calls: MAX_GEMINI_CALLS
        });
        console.log(`Gemini run budget exceeded: ${runBudget.geminiCalls}/${MAX_GEMINI_CALLS}. Skipping ${decodedFileName}`);
        continue;
      }

      runBudget.geminiCalls += 1;

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
        fileHash,
        text
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

  const resources = await getCandidateResources(state);

  console.log(`Candidate resources: ${resources.length}`);
  console.log(
    `Gemini settings: model=${GEMINI_MODEL}, maxCalls=${MAX_GEMINI_CALLS}, `
    + `rpm=${GEMINI_RPM_LIMIT}, tpm≈${GEMINI_TPM_LIMIT}, `
    + `maxTextChars=${MAX_TEXT_CHARS}, charsPerToken≈${GEMINI_TOKEN_ESTIMATE_CHARS_PER_TOKEN}`
  );
  console.log(
    `Backfill settings: enabled=${BACKFILL_ENABLED}, monthsPerRun=${BACKFILL_MONTHS_PER_RUN}, `
    + `from=${BACKFILL_FROM_MONTH || '-'}, to=${BACKFILL_TO_MONTH || '-'}`
  );
  for (const r of resources) {
    console.log(`- ${resourceTitle(r)} (${r.format || ''})`);
  }

  const additions = [];
  const totalStats = blankStats();
  const runBudget = { geminiCalls: 0 };

  for (const resource of resources) {
    console.log(`Processing: ${resourceTitle(resource)}`);

    try {
      const result = await processResource(resource, state, runBudget);

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
    stats: totalStats,
    gemini_calls: runBudget.geminiCalls,
    settings: {
      force_resources: FORCE_RESOURCES,
      force_reanalyze_decisions: FORCE_REANALYZE_DECISIONS,
      max_gemini_calls: MAX_GEMINI_CALLS,
      resource_state_version: RESOURCE_STATE_VERSION,
      backfill_enabled: BACKFILL_ENABLED,
      backfill_months_per_run: BACKFILL_MONTHS_PER_RUN,
      gemini_rpm_limit: GEMINI_RPM_LIMIT,
      gemini_tpm_limit: GEMINI_TPM_LIMIT,
      max_text_chars: MAX_TEXT_CHARS,
      gemini_token_estimate_chars_per_token: GEMINI_TOKEN_ESTIMATE_CHARS_PER_TOKEN
    }
  };

  console.log(`New/updated relevant rows: ${uniqueAdditions.length}`);

  if (duplicatesInRun > 0) {
    console.log(`Duplicate rows skipped before email/results: ${duplicatesInRun}`);
  }

  console.log(`Stats: ${JSON.stringify(totalStats)}`);
  console.log(`Gemini calls used: ${runBudget.geminiCalls}/${MAX_GEMINI_CALLS}`);

  if (!DRY_RUN) {
    await writeJson(STATE_PATH, state);
    await writeJson(RESULTS_PATH, merged);

    if (PRACTICE_DB_ENABLED) {
      await writeJson(PRACTICE_RESULTS_PATH, merged);
      console.log(`Practice DB written: ${PRACTICE_RESULTS_PATH}`);
    }
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
