const DATA_INDEX_URL = './data/dashboard_index.json';
const DATA_PRACTICE_URL = './data/practice.json';

const ICONS = {
  default: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>`,
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
};

const els = {};

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function setupEls() {
  Object.assign(els, {
    summaryGrid: document.getElementById('summaryGrid'),
    updatedAt: document.getElementById('updatedAt'),
    periodRange: document.getElementById('periodRange'),
    economicCards: document.getElementById('economicCards'),
    unfairCards: document.getElementById('unfairCards'),
    searchInput: document.getElementById('searchInput'),
    yearFilter: document.getElementById('yearFilter'),
    sortSelect: document.getElementById('sortSelect'),
    clearFiltersBtn: document.getElementById('clearFiltersBtn'),
    lawFamilyTabs: document.getElementById('lawFamilyTabs'),
    resultsList: document.getElementById('resultsList'),
    resultsMeta: document.getElementById('resultsMeta'),
    activeFilterChip: document.getElementById('activeFilterChip'),
    detailEmpty: document.getElementById('detailEmpty'),
    detailCard: document.getElementById('detailCard'),
  });
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

function getCodeMeta(code) {
  return state.index.categories.find((c) => c.code === code) || null;
}

function categoryIcon(code, family) {
  if (code === 'zek:50:1') return ICONS.collusion;
  if (code === 'zek:50:2') return ICONS.dominance;
  if (code === 'zek:50:12') return ICONS.concentration;
  if (code === 'zek:50:13' || code === 'zek:50:14' || code === 'zek:50:15') return ICONS.info;
  if (family === 'unfair_competition') return ICONS.unfair;
  if (family === 'economic_competition') return ICONS.economic;
  return ICONS.default;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSummary() {
  const total = state.index.total_decisions || 0;
  const zec = state.index.by_law_family.economic_competition || 0;
  const unfair = state.index.by_law_family.unfair_competition || 0;
  const sanction = state.index.total_sanction_uah || 0;

  els.updatedAt.textContent = formatDateTime(state.index.updated_at);
  els.periodRange.textContent = `${formatDate(state.index.oldest_decision_date)} — ${formatDate(state.index.newest_decision_date)}`;

  const cards = [
    { title: 'Усього рішень', value: total, sub: `${state.index.years.length} рік(роки) у базі`, icon: ICONS.default },
    { title: 'ЗЕК', value: zec, sub: 'Порушення за ст. 50 ЗУ «Про захист економічної конкуренції»', icon: ICONS.economic },
    { title: 'НДК', value: unfair, sub: 'Порушення за ЗУ «Про захист від недобросовісної конкуренції»', icon: ICONS.unfair },
    { title: 'Сума штрафів', value: formatMoney(sanction), sub: 'За структурованими даними бази', icon: ICONS.sanction },
  ];

  els.summaryGrid.innerHTML = cards.map((card) => `
    <article class="summary-card">
      <div class="tag-row"><span class="category-icon kpi-icon">${card.icon}</span></div>
      <div class="summary-title">${escapeHtml(card.title)}</div>
      <div class="summary-value">${escapeHtml(card.value)}</div>
      <div class="summary-sub">${escapeHtml(card.sub)}</div>
    </article>
  `).join('');
}

function renderYearFilter() {
  const options = ['<option value="all">Усі роки</option>']
    .concat(state.index.years.map((year) => `<option value="${year}">${year}</option>`));
  els.yearFilter.innerHTML = options.join('');
}

function renderCategoryCards() {
  const categories = state.index.categories || [];
  const economic = categories.filter((c) => c.law_family === 'economic_competition');
  const unfair = categories.filter((c) => c.law_family === 'unfair_competition');

  const render = (list) => list.map((item) => {
    const active = state.activeCode === item.code ? 'active' : '';
    const codeLabel = item.code.replace(/^zek:/, '').replace(/^unfair:/, '');
    return `
      <button class="category-card ${active}" data-code="${escapeHtml(item.code)}" aria-pressed="${state.activeCode === item.code}">
        <div class="category-top">
          <div>
            <div class="category-code">${escapeHtml(codeLabel)}</div>
            <div class="category-title">${escapeHtml(item.label)}</div>
          </div>
          <div class="category-icon">${categoryIcon(item.code, item.law_family)}</div>
        </div>
        <div class="category-count">${item.count}</div>
      </button>
    `;
  }).join('');

  els.economicCards.innerHTML = render(economic) || '<div class="empty-state">Поки що немає даних.</div>';
  els.unfairCards.innerHTML = render(unfair) || '<div class="empty-state">Поки що немає даних.</div>';

  document.querySelectorAll('.category-card').forEach((button) => {
    button.addEventListener('click', () => {
      const code = button.dataset.code;
      state.activeCode = state.activeCode === code ? null : code;
      applyFilters();
    });
  });
}

function applyFilters() {
  const query = state.query.trim().toLowerCase();
  let rows = [...state.practice];

  if (state.activeFamily !== 'all') {
    rows = rows.filter((row) => row.law_family === state.activeFamily);
  }
  if (state.activeYear !== 'all') {
    rows = rows.filter((row) => String(row.year) === String(state.activeYear));
  }
  if (state.activeCode) {
    rows = rows.filter((row) => row.primary_code === state.activeCode);
  }
  if (query) {
    rows = rows.filter((row) => row.search_blob.includes(query));
  }

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
  renderCategoryCards();
  renderResults();
  renderDetail();
}

function renderResults() {
  const rows = state.filtered;
  const count = rows.length;
  els.resultsMeta.textContent = `${count} ${pluralize(count, ['рішення', 'рішення', 'рішень'])}`;

  if (state.activeCode) {
    const meta = getCodeMeta(state.activeCode);
    els.activeFilterChip.textContent = meta?.label || state.activeCode;
    els.activeFilterChip.classList.remove('hidden');
  } else {
    els.activeFilterChip.classList.add('hidden');
  }

  if (!rows.length) {
    els.resultsList.innerHTML = '<div class="empty-state">За поточними фільтрами нічого не знайдено.</div>';
    return;
  }

  els.resultsList.innerHTML = rows.map((row) => {
    const active = row.decision_key === state.selectedKey ? 'active' : '';
    const party = row.liable_parties[0] || 'Суб’єкт не визначений';
    const extra = row.liable_parties.length > 1 ? ` +${row.liable_parties.length - 1}` : '';
    return `
      <button class="result-item ${active}" data-key="${escapeHtml(row.decision_key)}">
        <div class="result-row-top">
          <div>
            <div class="result-title">${escapeHtml(`${formatDate(row.decision_date)} · № ${row.decision_number || '—'}`)}</div>
            <div class="result-subtitle">${escapeHtml(row.primary_label)}</div>
          </div>
          <span class="tag primary">${escapeHtml(shortCodeBadge(row.primary_code))}</span>
        </div>
        <div class="meta-row">
          <span class="meta-pill">${escapeHtml(party)}${escapeHtml(extra)}</span>
          ${row.sanction_total_uah ? `<span class="meta-pill">${escapeHtml(formatMoney(row.sanction_total_uah))}</span>` : ''}
        </div>
        <div class="result-summary">${escapeHtml(row.violation_summary)}</div>
      </button>
    `;
  }).join('');

  document.querySelectorAll('.result-item').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedKey = button.dataset.key;
      renderResults();
      renderDetail();
    });
  });
}

function renderDetail() {
  const row = state.filtered.find((item) => item.decision_key === state.selectedKey);
  if (!row) {
    els.detailEmpty.classList.remove('hidden');
    els.detailCard.classList.add('hidden');
    els.detailCard.innerHTML = '';
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailCard.classList.remove('hidden');

  const parties = row.liable_parties.length
    ? row.liable_parties.map((v) => `<span class="meta-pill">${escapeHtml(v)}</span>`).join('')
    : '<span class="meta-pill">Не виявлено</span>';

  const legalBasis = row.legal_basis.length
    ? row.legal_basis.map((v) => `<li>${escapeHtml(v)}</li>`).join('')
    : '<li>Не виявлено</li>';

  const takeaways = row.key_takeaways.length
    ? row.key_takeaways.map((v) => `<li>${escapeHtml(v)}</li>`).join('')
    : '<li>Не виявлено</li>';

  const evidence = row.evidence_factors.length
    ? row.evidence_factors.map((v) => `<li>${escapeHtml(v)}</li>`).join('')
    : '<li>Не виявлено</li>';

  const keywords = row.search_keywords.length
    ? row.search_keywords.map((v) => `<span class="tag">${escapeHtml(v)}</span>`).join('')
    : '<span class="tag">Немає</span>';

  const sanctions = row.sanction_amounts.length
    ? row.sanction_amounts.map((item) => `
        <div class="detail-block">
          <div class="detail-block-label">${escapeHtml(item.party || 'Суб’єкт')}</div>
          <div class="detail-block-value"><strong>${escapeHtml(formatMoney(item.amount_uah))}</strong>${item.note ? `<br><span class="muted">${escapeHtml(item.note)}</span>` : ''}</div>
        </div>
      `).join('')
    : `
      <div class="detail-block">
        <div class="detail-block-value">${escapeHtml(row.sanction || 'Не виявлено')}</div>
      </div>
    `;

  els.detailCard.innerHTML = `
    <header class="detail-header">
      <div>
        <h2 class="detail-title">${escapeHtml(`№ ${row.decision_number || '—'}`)}</h2>
        <div class="detail-subline">
          <span class="tag primary">${escapeHtml(row.primary_label)}</span>
          <span class="meta-pill">${escapeHtml(formatDate(row.decision_date))}</span>
          <span class="meta-pill">${escapeHtml(row.law_family === 'unfair_competition' ? 'Недобросовісна конкуренція' : 'Захист економічної конкуренції')}</span>
        </div>
      </div>
      <div class="detail-block" style="min-width:220px;">
        <div class="detail-block-label">Загальна сума штрафів</div>
        <div class="detail-block-value"><strong>${escapeHtml(formatMoney(row.sanction_total_uah))}</strong></div>
      </div>
    </header>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.party}</span>Суб’єкт / суб’єкти порушення</h3>
      <div class="tag-row">${parties}</div>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.summary}</span>Суть порушення</h3>
      <div class="detail-prose"><p>${escapeHtml(row.violation_summary || 'Не виявлено')}</p></div>
      <div class="detail-grid" style="margin-top:14px;">
        <div class="detail-block">
          <div class="detail-block-label">Основна категорія</div>
          <div class="detail-block-value">${escapeHtml(row.primary_label)}</div>
        </div>
        <div class="detail-block">
          <div class="detail-block-label">Ринок / сектор</div>
          <div class="detail-block-value">${escapeHtml(row.market_or_sector || 'Не виявлено')}</div>
        </div>
      </div>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.economic}</span>Норми та правова база</h3>
      <ul class="bullet-list">${legalBasis}</ul>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.default}</span>Ключові висновки АМКУ</h3>
      <div class="detail-prose"><p>${escapeHtml(row.amcu_reasoning || 'Не виявлено')}</p></div>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.unfair}</span>Позиція порушника</h3>
      <div class="detail-prose"><p>${escapeHtml(row.respondent_position || 'Не виявлено')}</p></div>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.sanction}</span>Санкція</h3>
      <div class="detail-grid">${sanctions}</div>
      ${row.sanction && row.sanction_amounts.length ? `<div class="detail-prose" style="margin-top:12px;"><p>${escapeHtml(row.sanction)}</p></div>` : ''}
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.default}</span>Ключові takeaway</h3>
      <ul class="bullet-list">${takeaways}</ul>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.info}</span>Фактори та докази</h3>
      <ul class="bullet-list">${evidence}</ul>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon">${ICONS.default}</span>Ключові слова для пошуку</h3>
      <div class="keyword-row">${keywords}</div>
    </section>

    <section class="detail-section">
      <h3><span class="detail-icon source-icon">${ICONS.source}</span>Джерело</h3>
      <div class="detail-grid source-links">
        <div class="detail-block">
          <div class="detail-block-label">Ресурс</div>
          <div class="detail-block-value">${escapeHtml(row.source?.resource_title || '—')}</div>
        </div>
        <div class="detail-block">
          <div class="detail-block-label">Файл</div>
          <div class="detail-block-value">${escapeHtml(row.source?.file || '—')}</div>
        </div>
      </div>
      ${row.source?.url ? `<p style="margin-top:12px;"><a href="${escapeHtml(row.source.url)}" target="_blank" rel="noopener">Відкрити ZIP-ресурс на data.gov.ua</a></p>` : ''}
    </section>
  `;
}

function pluralize(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

function shortCodeBadge(code) {
  return code.replace(/^zek:/, '').replace(/^unfair:/, 'НДК ');
}

function wireEvents() {
  els.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    applyFilters();
  });
  els.yearFilter.addEventListener('change', (e) => {
    state.activeYear = e.target.value;
    applyFilters();
  });
  els.sortSelect.addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFilters();
  });
  els.clearFiltersBtn.addEventListener('click', () => {
    state.activeCode = null;
    state.activeFamily = 'all';
    state.activeYear = 'all';
    state.query = '';
    state.sort = 'date_desc';
    els.searchInput.value = '';
    els.yearFilter.value = 'all';
    els.sortSelect.value = 'date_desc';
    document.querySelectorAll('.segmented-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.family === 'all'));
    applyFilters();
  });
  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeFamily = btn.dataset.family;
      document.querySelectorAll('.segmented-btn').forEach((item) => item.classList.toggle('active', item === btn));
      applyFilters();
    });
  });
}

async function init() {
  setupEls();
  const [index, practice] = await Promise.all([fetchJson(DATA_INDEX_URL), fetchJson(DATA_PRACTICE_URL)]);
  state.index = index;
  state.practice = practice;
  renderSummary();
  renderYearFilter();
  wireEvents();
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
