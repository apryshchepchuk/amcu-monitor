import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PRACTICE_PATH = path.join(ROOT, 'data', 'practice', 'amku_practice.json');
const FALLBACK_RESULTS_PATH = path.join(ROOT, 'data', 'amku_results.json');
const OUT_DIR = path.join(ROOT, 'docs', 'amku', 'data');
const PRACTICE_OUT = path.join(OUT_DIR, 'practice.json');
const INDEX_OUT = path.join(OUT_DIR, 'dashboard_index.json');

const PRIMARY_CODE_ORDER = [
  'zek:50:1', 'zek:50:2', 'zek:50:3', 'zek:50:4', 'zek:50:5', 'zek:50:6', 'zek:50:7', 'zek:50:8', 'zek:50:9',
  'zek:50:10', 'zek:50:11', 'zek:50:12', 'zek:50:13', 'zek:50:14', 'zek:50:15', 'zek:50:16', 'zek:50:17',
  'zek:50:18', 'zek:50:19', 'zek:50:20', 'zek:50:21',
  'unfair:4', 'unfair:5', 'unfair:6', 'unfair:7', 'unfair:8', 'unfair:10', 'unfair:11', 'unfair:13', 'unfair:14',
  'unfair:15', 'unfair:15-1', 'unfair:16', 'unfair:17', 'unfair:18', 'unfair:19'
];

const DECISION_OUTCOME_LABELS = {
  violation_found: 'Порушення встановлено',
  proceeding_closed_no_violation: 'Провадження закрито / порушення не доведено',
  permit_granted: 'Дозвіл надано',
  other: 'Інший результат'
};

function normalizeDecisionOutcome(value) {
  const raw = String(value || '').toLowerCase().trim();

  if (raw === 'proceeding_closed_no_violation' || raw === 'closed_no_violation' || raw === 'no_violation_found') {
    return 'proceeding_closed_no_violation';
  }

  if (raw === 'permit_granted') return 'permit_granted';
  if (raw === 'other') return 'other';

  return 'violation_found';
}

function decisionOutcomeLabel(code, fallback = '') {
  const normalized = normalizeDecisionOutcome(code);
  return fallback || DECISION_OUTCOME_LABELS[normalized] || DECISION_OUTCOME_LABELS.other;
}

function lower(v) {
  return String(v || '').toLowerCase();
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

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function listToSearch(list) {
  return Array.isArray(list) ? list.join(' | ') : '';
}

function buildSearchBlob(row) {
  return lower([
    row.decision_number,
    row.decision_date,
    row.primary_code,
    row.primary_label,
    row.decision_outcome,
    row.outcome_label,
    row.outcome_summary,
    row.classification?.primary_label,
    listToSearch(row.liable_parties),
    row.violation_summary,
    row.amcu_reasoning,
    row.respondent_position,
    row.sanction,
    listToSearch(row.key_takeaways),
    listToSearch(row.evidence_factors),
    row.market_or_sector,
    listToSearch(row.search_keywords),
    row.source_resource,
    row.source_file
  ].filter(Boolean).join(' || '));
}

function sumSanctions(row) {
  return (row.sanction_amounts || []).reduce((acc, item) => acc + (Number(item?.amount_uah) || 0), 0);
}

function normalizeRow(row) {
  const lawFamily = row.classification?.law_family || row.law_area || 'other';
  const primaryCode = row.primary_code || row.classification?.primary_code || 'other';
  const primaryLabel = row.primary_label || row.classification?.primary_label || 'Без класифікації';
  const decisionOutcome = normalizeDecisionOutcome(row.decision_outcome);
  const article50Points = Array.isArray(row.classification?.article_50_points)
    ? row.classification.article_50_points
    : [];
  const unfairArticles = Array.isArray(row.classification?.unfair_competition_articles)
    ? row.classification.unfair_competition_articles
    : [];

  const out = {
    decision_key: row.decision_key || `${row.decision_date || ''}|${row.decision_number || ''}`,
    decision_number: row.decision_number || null,
    decision_date: row.decision_date || null,
    year: Number(row.year) || null,
    month: Number(row.month) || null,
    primary_code: primaryCode,
    primary_label: primaryLabel,
    law_family: lawFamily,
    decision_outcome: decisionOutcome,
    outcome_label: decisionOutcomeLabel(decisionOutcome, row.outcome_label),
    outcome_summary: compactText(row.outcome_summary),
    classification: {
      primary_code: primaryCode,
      primary_label: primaryLabel,
      primary_article: row.classification?.primary_article || null,
      article_50_points: article50Points,
      unfair_competition_articles: unfairArticles,
      secondary_legal_basis: Array.isArray(row.classification?.secondary_legal_basis) ? row.classification.secondary_legal_basis : []
    },
    liable_parties: Array.isArray(row.liable_parties) ? row.liable_parties : [],
    violation_summary: compactText(row.violation_summary),
    amcu_reasoning: compactText(row.amcu_reasoning),
    respondent_position: compactText(row.respondent_position),
    sanction: compactText(row.sanction),
    sanction_amounts: Array.isArray(row.sanction_amounts) ? row.sanction_amounts : [],
    sanction_total_uah: sumSanctions(row),
    key_takeaways: Array.isArray(row.key_takeaways) ? row.key_takeaways : [],
    evidence_factors: Array.isArray(row.evidence_factors) ? row.evidence_factors : [],
    market_or_sector: compactText(row.market_or_sector),
    search_keywords: Array.isArray(row.search_keywords) ? row.search_keywords : [],
    confidence: row.confidence || null,
    legal_basis: Array.isArray(row.legal_basis) ? row.legal_basis : [],
    source: row.source || {
      resource_title: row.source_resource || null,
      file: row.source_file || null,
      url: row.source_url || null,
      resource_id: row.source_resource_id || null
    },
    analyzed_at: row.analyzed_at || row.analysis?.analyzed_at || null,
    search_blob: buildSearchBlob(row),
  };

  out.sort_key = `${out.decision_date || '9999-99-99'}|${out.decision_number || ''}`;
  return out;
}

function buildCodeMeta(code, label, lawFamily) {
  return {
    code,
    label,
    law_family: lawFamily,
    short_label: label.replace(/^п\.\s*\d+\s*ст\.\s*50\s*—\s*/i, '').replace(/^ст\.\s*[^—]+—\s*/i, ''),
    count: 0,
  };
}

function compareCodes(a, b) {
  const ia = PRIMARY_CODE_ORDER.indexOf(a.code);
  const ib = PRIMARY_CODE_ORDER.indexOf(b.code);
  const va = ia >= 0 ? ia : Number.MAX_SAFE_INTEGER;
  const vb = ib >= 0 ? ib : Number.MAX_SAFE_INTEGER;
  if (va !== vb) return va - vb;
  return a.label.localeCompare(b.label, 'uk');
}

async function main() {
  const sourcePath = (await fileExists(PRACTICE_PATH)) ? PRACTICE_PATH : FALLBACK_RESULTS_PATH;
  const raw = await readJson(sourcePath, []);
  const practice = (raw || []).map(normalizeRow).sort((a, b) => String(a.sort_key).localeCompare(String(b.sort_key), 'uk'));

  const years = [...new Set(practice.map((r) => r.year).filter(Boolean))].sort((a, b) => b - a);
  const byCode = new Map();
  const byFamily = new Map();
  let sanctionTotalUah = 0;

  for (const row of practice) {
    sanctionTotalUah += row.sanction_total_uah || 0;

    const familyCount = byFamily.get(row.law_family) || 0;
    byFamily.set(row.law_family, familyCount + 1);

    const current = byCode.get(row.primary_code)
      || buildCodeMeta(row.primary_code, row.primary_label, row.law_family);
    current.count += 1;
    byCode.set(row.primary_code, current);
  }

  const categories = [...byCode.values()].sort(compareCodes);

  const index = {
    updated_at: new Date().toISOString(),
    source_file: path.relative(ROOT, sourcePath),
    total_decisions: practice.length,
    total_sanction_uah: sanctionTotalUah,
    years,
    by_law_family: {
      economic_competition: byFamily.get('economic_competition') || 0,
      unfair_competition: byFamily.get('unfair_competition') || 0,
      other: byFamily.get('other') || 0
    },
    categories,
    newest_decision_date: practice.at(-1)?.decision_date || null,
    oldest_decision_date: practice[0]?.decision_date || null,
  };

  await writeJson(PRACTICE_OUT, practice);
  await writeJson(INDEX_OUT, index);

  console.log(`Dashboard data written:`);
  console.log(`- ${PRACTICE_OUT}`);
  console.log(`- ${INDEX_OUT}`);
  console.log(`Rows: ${practice.length}`);
  console.log(`Categories: ${categories.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
