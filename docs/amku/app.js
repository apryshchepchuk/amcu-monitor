const DATA_INDEX_URL = './data/dashboard_index.json';
const DATA_PRACTICE_URL = './data/practice.json';

const ICONS = {
  default: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35"/><circle cx="11" cy="11" r="6.5"/></svg>`,
  economic: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 18h16"/><path d="M7 18V9"/><path d="M12 18V6"/><path d="M17 18v-4"/></svg>`,
  unfair: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 17l10-10"/><path d="M9 7h8v8"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8"/><path d="M12 10v5"/><path d="M12 7h.01"/></svg>`,
  collusion: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10"/><path d="M7 16h10"/><path d="M9 8v8"/><path d="M15 8v8"/></svg>`,
  concentration: `<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="12" r="4"/><circle cx="15" cy="12" r="4"/></svg>`,
  dominance: `<svg viewBox="0 0 24 24" fill="none"><path d="M5 18l4-6 3 3 7-9"/><path d="M15 6h4v4"/></svg>`,
  sanction: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18"/><path d="M16.5 7.5c0-1.9-1.8-3-4.2-3-2.2 0-4 1-4 2.8 0 4.7 8.5 2 8.5 6.6 0 1.9-1.9 3.1-4.5 3.1-2.5 0-4.6-1.2-4.8-3.3"/></svg>`,
  party: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 20v-2a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v2"/><circle cx="12" cy="8" r="4"/></svg>`,
  summary: `<svg viewBox="0 0 24 24" fill="none"><path d="M8 6h8"/><path d="M6 10h12"/><path d="M6 14h12"/><path d="M6 18h8"/></svg>`,
  source: `<svg viewBox="0 0 24 24" fill="none"><path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 1 1 7 7l-1 1"/><path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"/></svg>`,
  evidence: `<svg viewBox="0 0 24 24" fill="none"><path d="M9 11l2 2 4-5"/><path d="M5 4h14v16H5z"/></svg>`,
  lightbulb: `<svg viewBox="0 0 24 24" fill="none"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8 14a6 6 0 1 1 8 0c-.7.6-1 1.4-1 2H9c0-.6-.3-1.4-1-2z"/></svg>`,
  response: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>`,
};

const state = {
  index: null,
  practice: [],
  filtered: [],
  selectedKey: null,
  activeCode: null,
  activeFamily: 'all',
  activeYear: 'all',
  query: '',
  sort: 'date_desc',
  readingMode: false,
  urlSyncEnabled: true,
};

const els = {};
let searchTimer = null;

function withCacheBuster(url) {
  const glue = url.includes('?') ? '&' : '?';
  return `${url}${glue}v=${Date.now()}`;
}

async function fetchJson(url) {
  const res = await fetch(withCacheBuster(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function setupEls() {
  Object.assign(els, {
    heroFacts: document.getElementById('heroFacts'),
    economicCards: document.getElementById('economicCards'),
    unfairCards: document.getElementById('unfairCards'),
    economicCount: document.getElementById('economicCount'),
    unfairCount: document.getElementById('unfairCount'),
    searchInput: document.getElementById('searchInput'),
    yearFilter: document.getElementById('yearFilter'),
    sortSelect: document.getElementById('sortSelect'),
    clearFiltersBtn: document.getElementById('clearFiltersBtn'),
    lawFamilyTabs: document.getElementById('lawFamilyTabs'),
    activeContext: document.getElementById('activeContext'),
    workspace: document.getElementById('workspace'),
    resultsList: document.getElementById('resultsList'),
    resultsMeta: document.getElementById('resultsMeta'),
    detailEmpty: document.getElementById('detailEmpty'),
    detailCard: document.getElementById('detailCard'),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[¹]/g, '-1')
    .replace(/[–—]/g, '-')
    .replace(/[^0-9a-zа-яіїєґ'\-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTerms(query) {
  return normalizeSearchText(query).split(' ').filter((term) => term.length > 1);
}

function rowMatchesQuery(row, terms) {
  if (!terms.length) return true;
  const blob = row.normalized_search_blob || normalizeSearchText(row.search_blob || '');
  return terms.every((term) => blob.includes(term));
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (!n) return '—';
  return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(n) + ' грн';
}

function outcomeMeta(row) {
  const code = row?.decision_outcome || 'violation_found';

  if (code === 'proceeding_closed_no_violation') {
    return {
      code,
      label: 'Провадження закрито',
      summary: row.outcome_summary || row.outcome_label || 'Провадження закрито / порушення не доведено.',
      className: 'closed'
    };
  }

  if (code === 'permit_granted') {
    return {
      code,
      label: row.outcome_label || 'Дозвіл надано',
      summary: row.outcome_summary || 'Дозвіл надано.',
      className: 'permit'
    };
  }

  if (code === 'other') {
    return {
      code,
      label: row.outcome_label || 'Інший результат',
      summary: row.outcome_summary || 'Результат потребує перевірки.',
      className: 'other'
    };
  }

  return {
    code: 'violation_found',
    label: row?.outcome_label || 'Порушення встановлено',
    summary: row?.outcome_summary || 'АМКУ встановив порушення / застосував наслідки.',
    className: 'violation'
  };
}

function sanctionDisplay(row) {
  if (row?.sanction) return row.sanction;
  if (row?.decision_outcome === 'proceeding_closed_no_violation') {
    return 'Санкція не застосовувалась: провадження закрито / порушення не доведено.';
  }
  if (row?.decision_outcome === 'permit_granted') return 'Санкція не застосовувалась.';
  return 'Не виявлено';
}

function getCodeMeta(code) {
  return state.index.categories.find((c) => c.code === code) || null;
}

function shortCodeBadge(code) {
  return String(code || '')
    .replace(/^zek:/, '')
    .replace(/^unfair:/, 'НДК ');
}

function categoryCodeLabel(code) {
  const value = String(code || '');

  const zek = value.match(/^zek:50:(\d+)$/);
  if (zek) return `п. ${zek[1]} ст. 50`;

  const unfair = value.match(/^unfair:(.+)$/);
  if (unfair) return `ст. ${unfair[1]}`;

  return shortCodeBadge(value);
}

function categoryCountLabel(count) {
  return `${count} ріш.`;
}

function pluralize(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

function loadStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.activeCode = params.get('code') || null;
  state.activeFamily = params.get('family') || 'all';
  state.activeYear = params.get('year') || 'all';
  state.query = params.get('q') || '';
  state.sort = params.get('sort') || 'date_desc';
  state.selectedKey = params.get('decision') || null;
}

function syncStateToUrl() {
  if (!state.urlSyncEnabled) return;
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.activeCode) params.set('code', state.activeCode);
  if (state.activeFamily !== 'all') params.set('family', state.activeFamily);
  if (state.activeYear !== 'all') params.set('year', state.activeYear);
  if (state.sort !== 'date_desc') params.set('sort', state.sort);
  if (state.selectedKey) params.set('decision', state.selectedKey);
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
}

function renderHeroFacts() {
  const total = state.index.total_decisions || 0;
  const categories = state.index.categories?.length || 0;
  const years = state.index.years?.length || 0;
  const updated = formatDateTime(state.index.updated_at);
  const period = `${formatDate(state.index.oldest_decision_date)} — ${formatDate(state.index.newest_decision_date)}`;

  els.heroFacts.innerHTML = `
    <div class="fact-line"><strong>${total}</strong> ${pluralize(total, ['рішення', 'рішення', 'рішень'])}</div>
    <div class="fact-line"><strong>${categories}</strong> ${pluralize(categories, ['категорія', 'категорії', 'категорій'])}</div>
    <div class="fact-line"><strong>${years}</strong> ${pluralize(years, ['рік', 'роки', 'років'])}</div>
    <div class="fact-line"><span>Оновлено:</span> <strong>${escapeHtml(updated)}</strong></div>
    <div class="fact-subline">Період: ${escapeHtml(period)}</div>
  `;
}

function renderYearFilter() {
  const options = ['<option value="all">Усі роки</option>']
    .concat(state.index.years.map((year) => `<option value="${year}">${year}</option>`));
  els.yearFilter.innerHTML = options.join('');
  els.yearFilter.value = state.activeYear;
}

function renderFamilyTabs() {
  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.family === state.activeFamily);
  });
}

function renderCategoryPills() {
  const categories = state.index.categories || [];
  const economic = categories.filter((c) => c.law_family === 'economic_competition');
  const unfair = categories.filter((c) => c.law_family === 'unfair_competition');

  if (els.economicCount) {
    els.economicCount.textContent = `${economic.length} ${pluralize(economic.length, ['категорія', 'категорії', 'категорій'])}`;
  }

  if (els.unfairCount) {
    els.unfairCount.textContent = `${unfair.length} ${pluralize(unfair.length, ['категорія', 'категорії', 'категорій'])}`;
  }

  const render = (list) => list.map((item) => {
    const active = state.activeCode === item.code ? 'active' : '';
    const codeLabel = categoryCodeLabel(item.code);
    const title = item.short_label || item.label;
    const familyClass = item.law_family === 'unfair_competition' ? 'unfair' : 'economic';

    return `
      <button class="category-row ${familyClass} ${active}" data-code="${escapeHtml(item.code)}" aria-pressed="${state.activeCode === item.code}">
        <span class="category-row-code">${escapeHtml(codeLabel)}</span>
        <span class="category-row-title">${escapeHtml(title)}</span>
        <span class="category-row-count">${escapeHtml(categoryCountLabel(item.count))}</span>
        <span class="category-row-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }).join('');

  els.economicCards.innerHTML = render(economic) || '<div class="empty-state small">Поки що немає даних.</div>';
  els.unfairCards.innerHTML = render(unfair) || '<div class="empty-state small">Поки що немає даних.</div>';

  document.querySelectorAll('.category-row').forEach((button) => {
    button.addEventListener('click', () => {
      const code = button.dataset.code;
      state.activeCode = state.activeCode === code ? null : code;
      applyFilters({ scrollToResults: true });
    });
  });
}

function renderActiveContext() {
  if (!state.activeCode) {
    els.activeContext.classList.add('hidden');
    els.activeContext.innerHTML = '';
    return;
  }

  const meta = getCodeMeta(state.activeCode);
  const count = state.filtered.length;
  els.activeContext.classList.remove('hidden');
  els.activeContext.innerHTML = `
    <div>
      <div class="context-kicker">Активний фільтр</div>
      <h2>${escapeHtml(meta?.label || state.activeCode)}</h2>
      <p>${count} ${pluralize(count, ['рішення', 'рішення', 'рішень'])} за поточними умовами пошуку.</p>
    </div>
    <button class="ghost-btn" id="clearCodeBtn">Очистити категорію</button>
  `;

  document.getElementById('clearCodeBtn')?.addEventListener('click', () => {
    state.activeCode = null;
    applyFilters();
  });
}

function applyFilters(options = {}) {
  const terms = queryTerms(state.query);
  let rows = [...state.practice];

  if (state.activeFamily !== 'all') rows = rows.filter((row) => row.law_family === state.activeFamily);
  if (state.activeYear !== 'all') rows = rows.filter((row) => String(row.year) === String(state.activeYear));
  if (state.activeCode) rows = rows.filter((row) => row.primary_code === state.activeCode);
  rows = rows.filter((row) => rowMatchesQuery(row, terms));

  rows.sort((a, b) => {
    switch (state.sort) {
      case 'date_asc': return String(a.sort_key).localeCompare(String(b.sort_key), 'uk');
      case 'sanction_desc': return (b.sanction_total_uah || 0) - (a.sanction_total_uah || 0) || String(b.sort_key).localeCompare(String(a.sort_key), 'uk');
      case 'title_asc': return `${a.decision_date}|${a.decision_number}`.localeCompare(`${b.decision_date}|${b.decision_number}`, 'uk');
      case 'date_desc':
      default: return String(b.sort_key).localeCompare(String(a.sort_key), 'uk');
    }
  });

  state.filtered = rows;
  if (!rows.some((row) => row.decision_key === state.selectedKey)) {
    state.selectedKey = rows[0]?.decision_key || null;
  }

  renderFamilyTabs();
  renderCategoryPills();
  renderActiveContext();
  renderResults();
  renderDetail();
  syncStateToUrl();

  if (options.scrollToResults && window.matchMedia('(max-width: 900px)').matches) {
    els.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function firstParty(row) {
  return row.liable_parties?.[0] || 'Суб’єкт не визначений';
}

function renderResults() {
  const rows = state.filtered;
  const count = rows.length;
  els.resultsMeta.textContent = `${count} ${pluralize(count, ['рішення', 'рішення', 'рішень'])}`;

  if (!rows.length) {
    els.resultsList.innerHTML = '<div class="empty-state">За поточними фільтрами нічого не знайдено.</div>';
    return;
  }

  els.resultsList.innerHTML = rows.map((row) => {
    const active = row.decision_key === state.selectedKey ? 'active' : '';
    const party = firstParty(row);
    const extra = row.liable_parties?.length > 1 ? ` +${row.liable_parties.length - 1}` : '';
    const amount = row.sanction_total_uah ? formatMoney(row.sanction_total_uah) : null;
    const outcome = outcomeMeta(row);

    return `
      <button class="result-item ${active}" data-key="${escapeHtml(row.decision_key)}">
        <div class="result-title-row">
          <div class="result-title">${escapeHtml(`${formatDate(row.decision_date)} · № ${row.decision_number || '—'}`)}</div>
          <span class="tag primary">${escapeHtml(shortCodeBadge(row.primary_code))}</span>
        </div>
        <div class="result-party">${escapeHtml(party)}${escapeHtml(extra)}</div>
        <div class="result-meta-row">
          <span>${escapeHtml(row.primary_label)}</span>
          ${amount ? `<strong>${escapeHtml(amount)}</strong>` : ''}
        </div>
        <div class="result-outcome-row">
          <span class="outcome-badge ${outcome.className}">${escapeHtml(outcome.label)}</span>
        </div>
        <div class="result-summary">${escapeHtml(row.violation_summary || '')}</div>
      </button>
    `;
  }).join('');

  document.querySelectorAll('.result-item').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedKey = button.dataset.key;
      renderResults();
      renderDetail();
      syncStateToUrl();
      if (window.matchMedia('(max-width: 900px)').matches) {
        document.querySelector('.detail-pane')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function renderListItems(values, fallback = 'Не виявлено') {
  if (!Array.isArray(values) || !values.length) return `<li>${escapeHtml(fallback)}</li>`;
  return values.map((value) => `<li>${escapeHtml(value)}</li>`).join('');
}

function renderPills(values, fallback = 'Не виявлено') {
  if (!Array.isArray(values) || !values.length) return `<span class="tag">${escapeHtml(fallback)}</span>`;
  return values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join('');
}

function renderPartyIdentity(row) {
  const parties = Array.isArray(row.liable_parties)
    ? row.liable_parties.filter(Boolean)
    : [];

  if (!parties.length) {
    return `
      <section class="party-identity">
        <div class="party-identity-head">
          <span class="detail-icon">${ICONS.party}</span>
          <span>Суб’єкт порушення</span>
        </div>
        <div class="party-name-list">
          <div class="party-name muted-party">Не виявлено</div>
        </div>
      </section>
    `;
  }

  const label = parties.length > 1 ? 'Суб’єкти порушення' : 'Суб’єкт порушення';

  const partyRows = parties.map((party) => `
    <div class="party-name">${escapeHtml(party)}</div>
  `).join('');

  return `
    <section class="party-identity">
      <div class="party-identity-head">
        <span class="detail-icon">${ICONS.party}</span>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="party-name-list">
        ${partyRows}
      </div>
    </section>
  `;
}

function sourceTitle(row) {
  const resource = row.source?.resource_title || row.source_resource || 'джерело не визначено';
  return resource.replace(/Рішення Антимонопольного комітету України/g, 'Рішення АМКУ');
}

function citationText(row) {
  const party = firstParty(row);
  return `АМКУ, рішення від ${formatDate(row.decision_date)} № ${row.decision_number || '—'}, ${row.primary_label}, ${party}.`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Скопійовано';
    setTimeout(() => { button.textContent = old; }, 1400);
  } catch {
    window.prompt('Скопіюйте текст:', text);
  }
}

function renderDetail() {
  const row = state.filtered.find((item) => item.decision_key === state.selectedKey);
  document.body.classList.toggle('reading-mode', state.readingMode);

  if (!row) {
    els.detailEmpty.classList.remove('hidden');
    els.detailCard.classList.add('hidden');
    els.detailCard.innerHTML = '';
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailCard.classList.remove('hidden');

  const outcome = outcomeMeta(row);

  const sanctions = row.sanction_amounts?.length
    ? row.sanction_amounts.map((item) => `
        <div class="detail-mini-card">
          <span>${escapeHtml(item.party || 'Суб’єкт')}</span>
          <strong>${escapeHtml(formatMoney(item.amount_uah))}</strong>
          ${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}
        </div>
      `).join('')
    : `<div class="detail-mini-card"><span>Санкція</span><strong>${escapeHtml(sanctionDisplay(row))}</strong></div>`;

  els.detailCard.innerHTML = `
    <header class="decision-hero">
      <div class="decision-main">
        <div class="decision-kicker">${escapeHtml(row.primary_label)}</div>
        <h2>№ ${escapeHtml(row.decision_number || '—')}</h2>
        <div class="decision-meta">
          <span>${escapeHtml(formatDate(row.decision_date))}</span>
          <span>${escapeHtml(row.law_family === 'unfair_competition' ? 'Недобросовісна конкуренція' : 'Захист економічної конкуренції')}</span>
          <span class="outcome-badge ${outcome.className}">${escapeHtml(outcome.label)}</span>
          ${row.sanction_total_uah ? `<span>${escapeHtml(formatMoney(row.sanction_total_uah))}</span>` : ''}
        </div>
      </div>
      <div class="decision-actions">
        <button class="ghost-btn small" id="readingModeBtn">${state.readingMode ? 'Звичайний режим' : 'Режим читання'}</button>
        <button class="ghost-btn small" id="copyCitationBtn">Скопіювати цитату</button>
        <button class="ghost-btn small" id="copyLinkBtn">Скопіювати посилання</button>
      </div>
    </header>

    ${renderPartyIdentity(row)}

    <section class="detail-section lead-section">
      <h3><span class="detail-icon">${ICONS.summary}</span>Суть порушення</h3>
      <p>${escapeHtml(row.violation_summary || 'Не виявлено')}</p>
      <div class="info-grid">
        <div class="info-card"><span>Категорія</span><strong>${escapeHtml(row.primary_label)}</strong></div>
        <div class="info-card"><span>Результат рішення</span><strong>${escapeHtml(outcome.summary || outcome.label)}</strong></div>
        <div class="info-card"><span>Ринок / сектор</span><strong>${escapeHtml(row.market_or_sector || 'Не виявлено')}</strong></div>
      </div>
    </section>

    <section class="detail-section practice-section">
      <h3><span class="detail-icon">${ICONS.lightbulb}</span>Ключові висновки для практики</h3>
      <ul class="bullet-list emphatic">${renderListItems(row.key_takeaways)}</ul>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.economic}</span>Ключовий висновок / обґрунтування АМКУ</h3>
      <p>${escapeHtml(row.amcu_reasoning || 'Не виявлено')}</p>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.evidence}</span>Фактори та докази</h3>
      <ul class="bullet-list">${renderListItems(row.evidence_factors)}</ul>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.response}</span>Позиція порушника</h3>
      <p>${escapeHtml(row.respondent_position || 'Не виявлено')}</p>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.sanction}</span>Санкція</h3>
      <div class="info-grid sanctions-grid">${sanctions}</div>
      ${row.sanction ? `<p class="muted-block">${escapeHtml(row.sanction)}</p>` : ''}
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.default}</span>Норми</h3>
      <ul class="bullet-list legal-list">${renderListItems(row.legal_basis)}</ul>
    </section>

    <section class="detail-section source-section">
      <h3><span class="detail-icon">${ICONS.source}</span>Джерело</h3>
      <p><strong>${escapeHtml(sourceTitle(row))}</strong></p>
      <p class="source-file">${escapeHtml(row.source?.file || row.source_file || 'Файл не визначено')}</p>
      <div class="source-actions">
        ${row.source?.url ? `<a class="ghost-link" href="${escapeHtml(row.source.url)}" target="_blank" rel="noopener">ZIP на data.gov.ua</a>` : ''}
      </div>
    </section>

    <details class="service-details">
      <summary>Службові поля</summary>
      <div class="keyword-row">${renderPills(row.search_keywords, 'Немає keywords')}</div>
    </details>
  `;

  document.getElementById('readingModeBtn')?.addEventListener('click', () => {
    state.readingMode = !state.readingMode;
    renderDetail();
  });
  document.getElementById('copyCitationBtn')?.addEventListener('click', (event) => copyText(citationText(row), event.currentTarget));
  document.getElementById('copyLinkBtn')?.addEventListener('click', (event) => copyText(window.location.href, event.currentTarget));
}

function wireEvents() {
  els.searchInput.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value || '';
      applyFilters();
    }, 120);
  });

  els.yearFilter.addEventListener('change', (event) => {
    state.activeYear = event.target.value;
    applyFilters();
  });

  els.sortSelect.addEventListener('change', (event) => {
    state.sort = event.target.value;
    applyFilters();
  });

  els.clearFiltersBtn.addEventListener('click', () => {
    state.activeCode = null;
    state.activeFamily = 'all';
    state.activeYear = 'all';
    state.query = '';
    state.sort = 'date_desc';
    state.selectedKey = null;
    state.readingMode = false;
    els.searchInput.value = '';
    els.yearFilter.value = 'all';
    els.sortSelect.value = 'date_desc';
    applyFilters();
  });

  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeFamily = btn.dataset.family;
      applyFilters();
    });
  });
}

async function init() {
  setupEls();
  loadStateFromUrl();
  const [index, practice] = await Promise.all([fetchJson(DATA_INDEX_URL), fetchJson(DATA_PRACTICE_URL)]);
  state.index = index;
  state.practice = practice.map((row) => ({
    ...row,
    normalized_search_blob: normalizeSearchText(row.search_blob || '')
  }));
  renderHeroFacts();
  renderYearFilter();
  renderFamilyTabs();
  wireEvents();
  els.searchInput.value = state.query;
  els.yearFilter.value = state.activeYear;
  els.sortSelect.value = state.sort;
  applyFilters();
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `
    <div class="page-shell">
      <div class="empty-state" style="margin-top:48px;">
        <h2>Не вдалося завантажити дашборд</h2>
        <p>${escapeHtml(err.message || String(err))}</p>
      </div>
    </div>
  `;
});
