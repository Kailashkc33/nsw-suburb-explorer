const API = '/api';
const RECENT_KEY = 'nsw-suburbs-recent';
const RECENT_MAX = 8;

const els = {
  form: document.querySelector('#searchForm'),
  input: document.querySelector('#searchInput'),
  suggest: document.querySelector('#suggestPanel'),
  section: document.querySelector('#resultsSection'),
  title: document.querySelector('#resultsTitle'),
  status: document.querySelector('#searchStatus'),
  results: document.querySelector('#searchResults'),
  clear: document.querySelector('#clearSearch'),
  regionGrid: document.querySelector('#regionGrid'),
  regionStatus: document.querySelector('#regionStatus'),
  regionCount: document.querySelector('#regionCount'),
  regionFilter: document.querySelector('#regionFilter'),
  dialog: document.querySelector('#detailDialog'),
  detail: document.querySelector('#detailContent'),
  closeDialog: document.querySelector('#closeDialog'),
  liveStats: document.querySelector('#liveStats'),
  recentSection: document.querySelector('#recentSection'),
  recentList: document.querySelector('#recentList'),
  clearRecent: document.querySelector('#clearRecent'),
  viewGrid: document.querySelector('#viewGrid'),
  viewList: document.querySelector('#viewList'),
  toast: document.querySelector('#toast'),
  year: document.querySelector('#year'),
};

let searchTimer;
let suggestTimer;
let suggestItems = [];
let suggestIndex = -1;
let regionsCache = [];
let regionSort = 'name';
let toastTimer;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[char]));

const normalise = (value) => String(value || '').toLocaleLowerCase('en-AU');

function titleCase(value) {
  return String(value || '')
    .toLocaleLowerCase('en-AU')
    .replace(/(^|[\s\-'/])([a-z])/g, (_, boundary, letter) => boundary + letter.toLocaleUpperCase('en-AU'));
}

function displaySuburb(item) {
  return {
    ...item,
    suburb: titleCase(item.suburb),
    region: titleCase(item.region),
  };
}

async function getJSON(path) {
  const response = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Request failed');
  }
  return response.json();
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.hidden = false;
  els.toast.textContent = message;
  requestAnimationFrame(() => els.toast.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 250);
  }, 2200);
}

function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecent(items) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_MAX)));
  renderRecent();
}

function rememberSuburb(suburb) {
  const next = [
    { id: suburb.id, suburb: suburb.suburb, postcode: suburb.postcode, region: suburb.region },
    ...readRecent().filter((item) => String(item.id) !== String(suburb.id)),
  ];
  writeRecent(next);
}

function renderRecent() {
  const items = readRecent();
  if (!items.length) {
    els.recentSection.hidden = true;
    els.recentList.innerHTML = '';
    return;
  }

  els.recentSection.hidden = false;
  els.recentList.innerHTML = items.map((item, index) => `
    <button class="recent-chip" type="button" data-id="${escapeHtml(item.id)}" role="listitem" style="animation-delay:${index * 40}ms">
      ${escapeHtml(titleCase(item.suburb))}
      <small>${escapeHtml(item.postcode)}</small>
    </button>
  `).join('');

  els.recentList.querySelectorAll('[data-id]').forEach((button) => {
    button.addEventListener('click', () => showDetail(button.dataset.id));
  });
}

function card(item, index = 0) {
  const place = displaySuburb(item);
  return `
    <button class="suburb-card" type="button" data-id="${escapeHtml(place.id)}" style="--delay:${Math.min(index, 12) * 35}ms">
      <span class="postcode">${escapeHtml(place.postcode)}</span>
      <h3>${escapeHtml(place.suburb)}</h3>
      <p>${escapeHtml(place.region)}</p>
      <span class="card-arrow">Open →</span>
    </button>
  `;
}

function bindCards(root = els.results) {
  root.querySelectorAll('[data-id]').forEach((button) => {
    button.addEventListener('click', () => showDetail(button.dataset.id));
  });
}

function setSuggestOpen(open) {
  els.suggest.hidden = !open;
  els.input.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) {
    suggestIndex = -1;
    suggestItems = [];
  }
}

function renderSuggestions(results, query) {
  if (!results.length) {
    els.suggest.innerHTML = `<div class="suggest-empty">No live matches for “${escapeHtml(query)}”. Press Enter to search fully.</div>`;
    setSuggestOpen(true);
    return;
  }

  suggestItems = results;
  suggestIndex = -1;
  els.suggest.innerHTML = results.map((item, index) => {
    const place = displaySuburb(item);
    return `
    <button class="suggest-item" type="button" role="option" id="suggest-${index}" data-index="${index}" data-id="${escapeHtml(place.id)}">
      <span class="suggest-code">${escapeHtml(place.postcode)}</span>
      <span>
        <strong>${escapeHtml(place.suburb)}</strong>
        <span>${escapeHtml(place.region)}</span>
      </span>
      <span aria-hidden="true">↗</span>
    </button>
  `;
  }).join('');

  els.suggest.querySelectorAll('.suggest-item').forEach((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      showDetail(button.dataset.id);
      setSuggestOpen(false);
    });
  });

  setSuggestOpen(true);
}

function highlightSuggestion(nextIndex) {
  const buttons = [...els.suggest.querySelectorAll('.suggest-item')];
  if (!buttons.length) return;

  suggestIndex = (nextIndex + buttons.length) % buttons.length;
  buttons.forEach((button, index) => {
    button.classList.toggle('is-active', index === suggestIndex);
  });
  buttons[suggestIndex].scrollIntoView({ block: 'nearest' });
  els.input.setAttribute('aria-activedescendant', `suggest-${suggestIndex}`);
}

async function updateSuggestions(query) {
  const value = query.trim();
  if (value.length < 2) {
    setSuggestOpen(false);
    return;
  }

  try {
    const { results } = await getJSON(`/suburbs/search?query=${encodeURIComponent(value)}&limit=8`);
    if (els.input.value.trim() !== value) return;
    renderSuggestions(results, value);
  } catch {
    setSuggestOpen(false);
  }
}

async function search(query, label = query, { scroll = false, keepSuggest = false } = {}) {
  const value = query.trim();
  if (value.length < 2) {
    clearResults();
    return;
  }

  if (!keepSuggest) setSuggestOpen(false);
  els.section.hidden = false;
  els.title.textContent = label;
  els.status.textContent = 'Searching…';
  els.results.innerHTML = '';

  try {
    const { results } = await getJSON(`/suburbs/search?query=${encodeURIComponent(value)}`);
    els.status.textContent = results.length
      ? `${results.length} ${results.length === 1 ? 'match' : 'matches'} found`
      : `No matches for “${value}”. Try a suburb, postcode or broader region.`;
    els.results.innerHTML = results.map((item, index) => card(item, index)).join('');
    bindCards();
    history.replaceState(null, '', `?search=${encodeURIComponent(value)}`);
    if (scroll) els.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    els.status.textContent = 'Search is temporarily unavailable. Please try again.';
  }
}

async function browseRegion(region) {
  setSuggestOpen(false);
  els.section.hidden = false;
  els.title.textContent = region;
  els.status.textContent = 'Loading suburbs…';
  els.results.innerHTML = '';
  els.section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const { suburbs } = await getJSON(`/suburbs/region/${encodeURIComponent(region)}`);
    els.status.textContent = suburbs.length
      ? `${suburbs.length} ${suburbs.length === 1 ? 'suburb' : 'suburbs'}`
      : 'No suburbs are available for this region yet.';
    els.results.innerHTML = suburbs.map((item, index) => card(item, index)).join('');
    bindCards();
    history.replaceState(null, '', `?region=${encodeURIComponent(region)}`);
  } catch {
    els.status.textContent = 'This region could not be loaded. Please try again.';
  }
}

function formatNumber(value, options = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return Number(value).toLocaleString('en-AU', options);
}

function formatCurrency(value, { per = '' } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const formatted = Number(value).toLocaleString('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  });
  return per ? `${formatted}${per}` : formatted;
}

function censusSection(profile) {
  if (!profile) {
    return `
      <div class="census-block census-empty">
        <p class="eyebrow">ABS 2021 Census</p>
        <h3>Suburb profile unavailable</h3>
        <p class="muted">No confidently matched Census profile for this suburb yet.</p>
      </div>
    `;
  }

  const stats = [
    ['Population', formatNumber(profile.population)],
    ['Median age', formatNumber(profile.median_age, { maximumFractionDigits: 1 })],
    ['Median household income', formatCurrency(profile.median_weekly_household_income, { per: '/wk' })],
    ['Average household size', formatNumber(profile.average_household_size, { maximumFractionDigits: 2 })],
    ['Occupied private dwellings', formatNumber(profile.occupied_private_dwellings)],
    ['Owned outright', formatNumber(profile.owned_outright)],
    ['Owned with mortgage', formatNumber(profile.owned_with_mortgage)],
    ['Rented dwellings', formatNumber(profile.rented_dwellings)],
    ['Median weekly rent', formatCurrency(profile.median_weekly_rent, { per: '/wk' })],
    ['Median monthly mortgage', formatCurrency(profile.median_monthly_mortgage, { per: '/mo' })],
  ];

  return `
    <div class="census-block">
      <p class="eyebrow">ABS 2021 Census</p>
      <h3>Population and housing</h3>
      <dl class="census-grid">
        ${stats.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
      </dl>
      <p class="census-note">${escapeHtml(profile.disclaimer || 'Census rent and mortgage values are historical demographic indicators, not current market prices.')}</p>
    </div>
  `;
}

function formatDistance(metres) {
  if (metres === null || metres === undefined) return 'n/a';
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toLocaleString('en-AU', { maximumFractionDigits: 1 })} km`;
}

function transportSection(summary, nearby = []) {
  if (!summary) {
    return `
      <div class="census-block census-empty">
        <p class="eyebrow">Transport for NSW</p>
        <h3>Transport nearby unavailable</h3>
        <p class="muted">No confidently matched nearby stops for this suburb yet.</p>
      </div>
    `;
  }

  const modes = (summary.modes || []).join(', ') || 'n/a';
  const distanceBasis = summary.distance_basis || 'Approximate distance from suburb centre';
  const major = summary.nearest_major_stop_name
    ? `${escapeHtml(summary.nearest_major_stop_name)} (${escapeHtml((summary.nearest_major_stop_modes || []).join(', ') || 'major')}) · ${escapeHtml(formatDistance(summary.nearest_major_stop_distance_m))}`
    : 'No train, metro, ferry or light rail station within search radius';

  return `
    <div class="census-block">
      <p class="eyebrow">Transport for NSW</p>
      <h3>Nearby public transport</h3>
      <dl class="census-grid">
        <div><dt>Nearest major station</dt><dd>${major}</dd></div>
        <div><dt>Nearest stop</dt><dd>${escapeHtml(summary.nearest_stop_name || 'n/a')} · ${escapeHtml(formatDistance(summary.nearest_stop_distance_m))}</dd></div>
        <div><dt>Modes nearby</dt><dd>${escapeHtml(modes)}</dd></div>
        <div><dt>Routes nearby</dt><dd>${escapeHtml(formatNumber(summary.route_count))}</dd></div>
        <div><dt>Stops within 500 m</dt><dd>${escapeHtml(formatNumber(summary.stops_within_500m))}</dd></div>
        <div><dt>Stops within 1 km</dt><dd>${escapeHtml(formatNumber(summary.stops_within_1km))}</dd></div>
        <div><dt>Stops within 2 km</dt><dd>${escapeHtml(formatNumber(summary.stops_within_2km))}</dd></div>
        <div><dt>Stops in suburb</dt><dd>${escapeHtml(formatNumber(summary.stops_in_suburb))}</dd></div>
      </dl>
      ${nearby.length ? `<div class="nearby-list transport-stops">${nearby.slice(0, 8).map((stop) => `<span class="transport-chip">${escapeHtml(stop.stop_name)} · ${escapeHtml(formatDistance(stop.distance_m))}</span>`).join('')}</div>` : ''}
      <p class="census-note">${escapeHtml(distanceBasis)}. Distances are not walking times and are not measured from every property. Summary derived from the TfNSW GTFS timetable feed (21 July 2026). Attribution: Transport for NSW.</p>
    </div>
  `;
}

async function showDetail(id) {
  els.detail.innerHTML = '<div class="detail-body">Loading suburb details…</div>';
  if (!els.dialog.open) els.dialog.showModal();

  try {
    const {
      suburb,
      nearby,
      census_profile: censusProfile,
      transport_summary: transportSummary,
      nearby_transport: nearbyTransport,
    } = await getJSON(`/suburbs/${encodeURIComponent(id)}`);
    const place = displaySuburb(suburb);
    rememberSuburb(place);

    els.detail.innerHTML = `
      <div class="detail-hero">
        <span class="postcode">POSTCODE ${escapeHtml(place.postcode)}</span>
        <h2 id="detailTitle">${escapeHtml(place.suburb)}</h2>
        <p>${escapeHtml(place.region)}</p>
        <div class="detail-actions">
          <button class="action-btn" type="button" data-copy="${escapeHtml(place.postcode)}">Copy postcode</button>
          <button class="action-btn" type="button" data-share="1">Share place</button>
          <button class="action-btn" type="button" data-region="${escapeHtml(suburb.region)}">Browse region</button>
        </div>
      </div>
      <div class="detail-body">
        ${censusSection(censusProfile)}
        ${transportSection(transportSummary, nearbyTransport || [])}
        <p class="eyebrow">Explore nearby</p>
        <h3>Other places in this region</h3>
        <div class="nearby-list">
          ${nearby.length
            ? nearby.map((item) => `<button type="button" data-nearby="${escapeHtml(item.id)}">${escapeHtml(titleCase(item.suburb))}</button>`).join('')
            : '<p class="muted">More nearby suburbs will be added soon.</p>'}
        </div>
      </div>
    `;

    els.detail.querySelectorAll('[data-nearby]').forEach((button) => {
      button.addEventListener('click', () => showDetail(button.dataset.nearby));
    });

    els.detail.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      const postcode = event.currentTarget.dataset.copy;
      try {
        await navigator.clipboard.writeText(postcode);
        showToast(`Copied ${postcode}`);
      } catch {
        showToast('Could not copy postcode');
      }
    });

    els.detail.querySelector('[data-share]')?.addEventListener('click', async () => {
      const url = new URL(location.href);
      url.search = `?search=${encodeURIComponent(place.suburb)}`;
      try {
        if (navigator.share) {
          await navigator.share({ title: place.suburb, text: `${place.suburb} ${place.postcode}`, url: url.toString() });
        } else {
          await navigator.clipboard.writeText(url.toString());
          showToast('Link copied');
        }
      } catch {
        /* user cancelled share */
      }
    });

    els.detail.querySelector('[data-region]')?.addEventListener('click', (event) => {
      els.dialog.close();
      browseRegion(event.currentTarget.dataset.region);
    });
  } catch {
    els.detail.innerHTML = `
      <div class="detail-body">
        <h2 id="detailTitle">Unable to load details</h2>
        <p>Please close this window and try again.</p>
      </div>
    `;
  }
}

function clearResults() {
  els.section.hidden = true;
  els.results.innerHTML = '';
  els.status.textContent = '';
  setSuggestOpen(false);
  history.replaceState(null, '', location.pathname);
}

function renderRegions() {
  const filter = normalise(els.regionFilter.value.trim());
  let list = regionsCache.filter((region) => normalise(region.name).includes(filter));

  list = [...list].sort((a, b) => {
    if (regionSort === 'count') return b.count - a.count || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });

  const maxCount = Math.max(...regionsCache.map((region) => region.count), 1);

  if (!list.length) {
    els.regionGrid.innerHTML = '<p class="region-empty">No regions match that filter.</p>';
    return;
  }

  els.regionGrid.innerHTML = list.map((region, index) => {
    const pct = Math.max(8, Math.round((region.count / maxCount) * 100));
    return `
      <button class="region-button" type="button" data-region="${escapeHtml(region.name)}" style="animation-delay:${Math.min(index, 16) * 28}ms">
        <span class="region-top">
          <span class="region-name">${escapeHtml(titleCase(region.name))}</span>
          <span class="region-meta">${region.count} ${region.count === 1 ? 'suburb' : 'suburbs'}</span>
        </span>
        <span class="density" aria-hidden="true"><span style="--pct:${pct}%"></span></span>
      </button>
    `;
  }).join('');

  // Trigger density fill after paint so width animates
  requestAnimationFrame(() => {
    els.regionGrid.querySelectorAll('.density > span').forEach((bar) => {
      bar.style.width = getComputedStyle(bar).getPropertyValue('--pct');
    });
  });

  els.regionGrid.querySelectorAll('[data-region]').forEach((button) => {
    button.addEventListener('click', () => browseRegion(button.dataset.region));
  });
}

async function loadRegions() {
  try {
    const { regions } = await getJSON('/regions');
    regionsCache = regions;
    els.regionStatus.textContent = '';
    els.regionCount.textContent = `${regions.length} regions`;
    renderRegions();

    const totalSuburbs = regions.reduce((sum, region) => sum + region.count, 0);
    els.liveStats.innerHTML = `
      <span class="stat-pill"><em>${regions.length}</em> regions</span>
      <span class="stat-pill" style="animation-delay:80ms"><em>${totalSuburbs.toLocaleString('en-AU')}</em> suburbs</span>
    `;
  } catch {
    els.regionStatus.textContent = 'Regions are temporarily unavailable.';
  }
}

function setView(mode) {
  els.results.dataset.view = mode;
  els.viewGrid.classList.toggle('is-active', mode === 'grid');
  els.viewList.classList.toggle('is-active', mode === 'list');
  els.viewGrid.setAttribute('aria-pressed', mode === 'grid' ? 'true' : 'false');
  els.viewList.setAttribute('aria-pressed', mode === 'list' ? 'true' : 'false');
}

function focusSearch() {
  els.input.focus();
  els.input.select();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* --- Events --- */
els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  clearTimeout(suggestTimer);

  if (suggestIndex >= 0 && suggestItems[suggestIndex]) {
    showDetail(suggestItems[suggestIndex].id);
    setSuggestOpen(false);
    return;
  }

  search(els.input.value, `Results for “${els.input.value.trim()}”`, { scroll: true });
});

els.input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  clearTimeout(searchTimer);
  const value = els.input.value.trim();

  if (value.length < 2) {
    setSuggestOpen(false);
    clearResults();
    return;
  }

  suggestTimer = setTimeout(() => updateSuggestions(value), 180);
  searchTimer = setTimeout(() => search(value, 'Suggestions', { keepSuggest: true }), 500);
});

els.input.addEventListener('keydown', (event) => {
  if (els.suggest.hidden) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlightSuggestion(suggestIndex + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlightSuggestion(suggestIndex - 1);
  } else if (event.key === 'Escape') {
    setSuggestOpen(false);
  }
});

els.input.addEventListener('blur', () => {
  setTimeout(() => setSuggestOpen(false), 120);
});

els.clear.addEventListener('click', () => {
  els.input.value = '';
  clearResults();
  els.input.focus();
});

els.clearRecent.addEventListener('click', () => {
  writeRecent([]);
  showToast('Recent places cleared');
});

els.closeDialog.addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('click', (event) => {
  if (event.target === els.dialog) els.dialog.close();
});

els.regionFilter.addEventListener('input', () => renderRegions());

document.querySelectorAll('[data-sort]').forEach((button) => {
  button.addEventListener('click', () => {
    regionSort = button.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach((chip) => {
      chip.classList.toggle('is-active', chip === button);
    });
    renderRegions();
  });
});

els.viewGrid.addEventListener('click', () => setView('grid'));
els.viewList.addEventListener('click', () => setView('list'));

document.addEventListener('keydown', (event) => {
  const isMetaK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
  if (isMetaK) {
    event.preventDefault();
    focusSearch();
  }
});

els.year.textContent = new Date().getFullYear();
setView('grid');
renderRecent();
loadRegions();

const params = new URLSearchParams(location.search);
const initialSearch = params.get('search');
const initialRegion = params.get('region');

if (initialSearch) {
  els.input.value = initialSearch;
  search(initialSearch, `Results for “${initialSearch}”`, { scroll: true });
} else if (initialRegion) {
  browseRegion(initialRegion);
}
