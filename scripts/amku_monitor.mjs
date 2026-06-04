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
  return String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeHashUnicodeName(s) {
  return String(s || '').replace(/#U([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
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
    // In dry-run mode do not mutate repository files at all.
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
  const title = typeof resourceOrTitle === 'string' ? resourceOrTitle : resourceTitle(resourceOrTitle);
  const text = String(title || '').toLowerCase();

  // Modern monthly resources usually look like: "Рішення АМКУ за квітень 2026 ..."
  for (const [name, month] of UA_MONTHS.entries()) {
    const re = new RegExp(`${name}\\s+(20\\d{2})`, 'i');
    const m = text.match(re);
    if (m) return { year: Number(m[1]), month, day: 1, source: 'ua_month' };
  }

  // Older resources often look like: "Рішення АМКУ від 18.04.2019 №238-269-р.zip"
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
  // If a resource date cannot be parsed, do not include it in normal scheduled runs.
  // This prevents old archive-style resources from leaking into recent monitoring.
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
  if (!pkg.success) throw new Error(`CKAN package_show returned success=false`);
  const resources = pkg.result?.resources || [];
  return resources
    .filter(isDecisionZipResource)
    .filter(isWithinLookback)
    .sort((a, b) => resourceSortTime(b) - resourceSortTime(a))
    .slice(0, MAX_RESOURCES);
}

async function extractZip(zipPath, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  // Some AMCU ZIPs contain mismatching local/central filenames. unzip may return code 1
  // while still extracting the files; for this source code 1 is treated as recoverable.
  await runCmd('unzip', ['-qq', '-o', zipPath, '-d', outDir], { allowCodes: [0, 1], maxBuffer: 1024 * 1024 * 10 });
}

async function listDocumentFiles(dir) {
  const found = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(current, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(docx?|rtf)$/i.test(e.name)) found.push(p);
    }
  }
  await walk(dir);
  return found.sort((a, b) => a.localeCompare(b, 'uk'));
}

async function extractText(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.docx')) {
    const { stdout } = await runCmd('pandoc', ['-t', 'plain', filePath], { maxBuffer: 1024 * 1024 * 50 });
    return normalizeSpaces(stdout);
  }
  if (lower.endsWith('.doc')) {
    try {
      const { stdout } = await runCmd('antiword', ['-m', 'UTF-8.txt', filePath], { maxBuffer: 1024 * 1024 * 50 });
      return normalizeSpaces(stdout);
    } catch (err) {
      if (boolEnv('USE_LIBREOFFICE_FALLBACK', false)) {
        return await extractTextViaLibreOffice(filePath);
      }
      throw err;
    }
  }
  if (lower.endsWith('.rtf')) {
    const { stdout } = await runCmd('pandoc', ['-t', 'plain', filePath], { maxBuffer: 1024 * 1024 * 50 });
    return normalizeSpaces(stdout);
  }
  return '';
}

async function extractTextViaLibreOffice(filePath) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amku-lo-'));
  await runCmd('libreoffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', outDir, filePath], { maxBuffer: 1024 * 1024 * 20 });
  const files = await fs.readdir(outDir);
  const txt = files.find((f) => f.toLowerCase().endsWith('.txt'));
  if (!txt) throw new Error(`LibreOffice did not create txt for ${filePath}`);
  return normalizeSpaces(await fs.readFile(path.join(outDir, txt), 'utf8'));
}

function classifyDecision(text) {
  const head = normalizeSpaces(text).slice(0, 25000);
  const include = INCLUDE_PATTERNS.some((re) => re.test(head));
  if (!include) return { relevant: false, reason: 'not_violation_decision' };
  const procedural = PROCEDURAL_PATTERNS.some((re) => re.test(head));
  if (procedural && !INCLUDE_PROCEDURAL_DECISIONS) {
    return { relevant: false, reason: 'procedural_decision' };
  }
  let lawArea = 'economic_competition';
  if (/недобросовісної\s+конкуренції/i.test(head)) lawArea = 'unfair_competition';
  return { relevant: true, reason: 'included_by_regex', lawArea };
}

function parseDecisionMeta(text, fileName = '') {
  const sample = normalizeSpaces(text).slice(0, 6000);
  const dateMatch = sample.match(/(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s+(20\d{2})\s*р?\.?/i);
  let isoDate = null;
  if (dateMatch) {
    const day = String(Number(dateMatch[1])).padStart(2, '0');
    const month = String(UA_MONTHS.get(dateMatch[2].toLowerCase())).padStart(2, '0');
    isoDate = `${dateMatch[3]}-${month}-${day}`;
  }

  let num = null;
  const afterDate = dateMatch ? sample.slice(dateMatch.index) : sample;
  const numberMatch = afterDate.match(/№\s*([0-9]{1,5}\s*[-–—]?\s*[а-яіїєґa-z]*)/i)
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

function buildGeminiPrompt({ text, meta, fileName, resourceTitle }) {
  return `Ти юрист у сфері конкурентної практики АМКУ.\n\nПроаналізуй текст рішення Антимонопольного комітету України.\n\nПоверни виключно валідний JSON без Markdown, без коментарів і без пояснень поза JSON.\n\nЗавдання:\n1. Визнач реквізити рішення: номер і дата.\n2. Визнач суб’єкта/суб’єктів, яких притягнуто до відповідальності.\n3. Коротко опиши суть порушення і вкажи порушену норму закону.\n4. Сформулюй ключовий висновок / правову кваліфікацію АМКУ. Зазвичай це розділ «Правова кваліфікація дій ...».\n5. Витягни позицію порушника, заперечення або зауваження, якщо вони є. Зазвичай це розділ «Заперечення та зауваження на подання ...».\n6. Витягни санкцію: розмір штрафу, зобов’язання, інші наслідки. Часто санкція є на початку і в резолютивній частині рішення.\n7. Якщо певної інформації немає в тексті — постав null.\n8. Не вигадуй інформацію. Якщо в тексті є прихована/обмежена інформація — так і зазнач.\n9. Якщо це не рішення про порушення законодавства про захист економічної конкуренції або законодавства про захист від недобросовісної конкуренції — постав is_relevant=false.\n\nОчікувана JSON-структура:\n{\n  "is_relevant": true,\n  "decision_number": "",\n  "decision_date": "YYYY-MM-DD",\n  "law_area": "economic_competition | unfair_competition | other",\n  "liable_parties": [""],\n  "violation_summary": "",\n  "legal_basis": [""],\n  "amcu_reasoning": "",\n  "respondent_position": "",\n  "sanction": "",\n  "important_notes": [""],\n  "confidence": "high | medium | low"\n}\n\nСлужбові дані для звірки:\n- Попередньо визначений номер: ${meta.decision_number || 'unknown'}\n- Попередньо визначена дата: ${meta.decision_date || 'unknown'}\n- Файл: ${fileName}\n- Ресурс: ${resourceTitle}\n\nТекст рішення:\n${fitTextForGemini(text)}`;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildGeminiPrompt(input) }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  const rawText = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  return parseJsonLenient(rawText);
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
  if (m) return `${m[3]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
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
  return [...map.values()].sort((a, b) => String(a.sort_key || '').localeCompare(String(b.sort_key || ''), 'uk'));
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map((x) => htmlEscape(x)).join('<br>');
}

function renderDigestHtml(rows, stats) {
  const title = 'Аналітичний огляд рішень АМКУ';
  const rowsHtml = rows.map((r) => `
    <tr>
      <td>${htmlEscape([r.decision_date, r.decision_number].filter(Boolean).join(' № '))}</td>
      <td>${renderList(r.liable_parties)}</td>
      <td>${htmlEscape(r.violation_summary)}${r.legal_basis?.length ? '<br><b>Норма:</b> ' + renderList(r.legal_basis) : ''}</td>
      <td>${htmlEscape(r.amcu_reasoning)}</td>
      <td>${htmlEscape(r.respondent_position)}</td>
      <td>${htmlEscape(r.sanction)}</td>
    </tr>`).join('\n');

  const table = rows.length ? `
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;vertical-align:top;">
      <thead>
        <tr style="background:#f2f2f2;">
          <th>Рішення</th>
          <th>Суб’єкт порушення</th>
          <th>Суть порушення</th>
          <th>Ключовий висновок АМКУ</th>
          <th>Позиція порушника</th>
          <th>Санкція</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : '<p>Нових релевантних рішень не виявлено.</p>';

  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#111;">
  <h2>${title}</h2>
  <p><b>Нових/оновлених релевантних рішень:</b> ${rows.length}</p>
  ${table}
  <hr>
  <p style="font-size:12px;color:#555;">
    Перевірено ZIP-ресурсів: ${stats.resourcesChecked}; оброблено документів: ${stats.docsSeen};
    відібрано regex-фільтром: ${stats.docsRelevant}; пропущено як нерелевантні: ${stats.docsSkipped};
    помилки конвертації/аналізу: ${stats.errors}.
  </p>
</body></html>`;
}

function renderDigestText(rows, stats) {
  if (!rows.length) return `Аналітичний огляд рішень АМКУ\n\nНових релевантних рішень не виявлено.\n\nСтатистика: ${JSON.stringify(stats)}`;
  return `Аналітичний огляд рішень АМКУ\n\n` + rows.map((r) => [
    `${r.decision_date || ''} № ${r.decision_number || ''}`,
    `Суб’єкт: ${(r.liable_parties || []).join('; ') || '-'}`,
    `Суть: ${r.violation_summary || '-'}`,
    `Норма: ${(r.legal_basis || []).join('; ') || '-'}`,
    `Ключовий висновок: ${r.amcu_reasoning || '-'}`,
    `Позиція: ${r.respondent_position || '-'}`,
    `Санкція: ${r.sanction || '-'}`
  ].join('\n')).join('\n\n---\n\n');
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
    text: renderDigestText(rows, stats),
    html: renderDigestHtml(rows, stats)
  });
  console.log(`Email sent to ${emailTo}`);
}

async function processResource(resource, state) {
  const title = resourceTitle(resource);
  const id = resource.id || resource.url || title;
  const signature = resourceSignature(resource);
  const prev = state.processed_resources[id];

  if (!LOCAL_ZIP && !FORCE && prev?.signature && signature && prev.signature === signature) {
    return { skippedResource: true, reason: 'metadata_signature_unchanged', additions: [], stats: blankStats() };
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

  if (!FORCE && prev?.zip_sha256 && prev.zip_sha256 === zipSha) {
    return { skippedResource: true, reason: 'zip_hash_unchanged', additions: [], stats: blankStats() };
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
        await appendEvent({ type: 'gemini_budget_exceeded', resource_id: id, file: decodedFileName, key });
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
      await appendEvent({ type: 'decision_analyzed', key, resource_id: id, file: decodedFileName, decision_number: row.decision_number, decision_date: row.decision_date });
    } catch (err) {
      stats.errors += 1;
      await appendEvent({ type: 'document_error', resource_id: id, file: decodedFileName, error: String(err.message || err).slice(0, 1500) });
      console.error(`Document error: ${decodedFileName}: ${err.message}`);
    }
  }

  state.processed_resources[id] = {
    title,
    url: resource.url,
    signature,
    zip_sha256: zipSha,
    processed_at: new Date().toISOString(),
    docs_seen: stats.docsSeen,
    docs_relevant: stats.docsRelevant
  };
  return { skippedResource: false, additions, stats };
}

function blankStats() {
  return { resourcesChecked: 0, docsSeen: 0, docsRelevant: 0, docsSkipped: 0, errors: 0 };
}

function addStats(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const state = await readJson(STATE_PATH, { processed_resources: {}, processed_decisions: {}, last_run: null });
  state.processed_resources ||= {};
  state.processed_decisions ||= {};
  const existingResults = await readJson(RESULTS_PATH, []);

  const resources = await getCandidateResources();
  console.log(`Candidate resources: ${resources.length}`);
  for (const r of resources) console.log(`- ${resourceTitle(r)} (${r.format || ''})`);

  const additions = [];
  const totalStats = blankStats();
  for (const resource of resources) {
    console.log(`Processing: ${resourceTitle(resource)}`);
    try {
      const result = await processResource(resource, state);
      addStats(totalStats, result.stats);
      additions.push(...result.additions);
      if (result.skippedResource) console.log(`Skipped resource: ${result.reason}`);
      else console.log(`Resource done: +${result.additions.length} analyzed rows`);
    } catch (err) {
      totalStats.errors += 1;
      await appendEvent({ type: 'resource_error', resource_id: resource.id, resource: resourceTitle(resource), error: String(err.message || err).slice(0, 1500) });
      console.error(`Resource error: ${resourceTitle(resource)}: ${err.message}`);
    }
  }

  const merged = mergeResults(existingResults, additions);
  state.last_run = {
    at: new Date().toISOString(),
    resources_considered: resources.length,
    additions: additions.length,
    stats: totalStats
  };

  console.log(`New/updated relevant rows: ${additions.length}`);
  console.log(`Stats: ${JSON.stringify(totalStats)}`);

  if (!DRY_RUN) {
    await writeJson(STATE_PATH, state);
    await writeJson(RESULTS_PATH, merged);
  } else {
    console.log('DRY_RUN=true: state/results files were not written.');
  }

  const rowsForDigest = additions.sort((a, b) => String(a.sort_key || '').localeCompare(String(b.sort_key || ''), 'uk'));
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
  try { await appendEvent({ type: 'fatal_error', error: String(err.message || err).slice(0, 2000) }); } catch {}
  process.exit(1);
});
