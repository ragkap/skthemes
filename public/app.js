/* ── State ────────────────────────────────────────────────────────────────── */
const state = {
  tab: 'followed',
  hideCS: true,
  discover: { page: 1, search: '', cluster: '' },
  followed: new Set(JSON.parse(localStorage.getItem('sk_followed') || '[]')),
  selectedFollowedTheme: null,
  drawerTheme: null,
};

function saveFollowed() { localStorage.setItem('sk_followed', JSON.stringify([...state.followed])); }

const $ = id => document.getElementById(id);

/* ── AI Summary Cache ─────────────────────────────────────────────────────── */
const AI_CACHE_KEY = 'sk_ai_cache';
const AI_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCachedSummary(theme) {
  try {
    const cache = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}');
    const entry = cache[theme];
    if (!entry) return null;
    if (Date.now() - entry.ts > AI_CACHE_TTL) { delete cache[theme]; localStorage.setItem(AI_CACHE_KEY, JSON.stringify(cache)); return null; }
    return entry;
  } catch { return null; }
}

function setCachedSummary(theme, data) {
  try {
    const cache = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}');
    cache[theme] = { ...data, ts: Date.now() };
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

/* ── Header CS Toggle (universal) ────────────────────────────────────────── */
function applyCSToggle() {
  $('csToggleHeader').dataset.active = state.hideCS;
  $('mobileCSToggle').dataset.active = state.hideCS;
  state.discover.page = 1;
  loadDiscover();
  trendingLoaded = false;
  if (state.tab === 'trending') loadTrending();
}
$('csToggleHeader').addEventListener('click', () => { state.hideCS = !state.hideCS; applyCSToggle(); });

/* ── Mobile 3-dot menu ────────────────────────────────────────────────────── */
$('mobileMenuBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('mobileMenuDropdown').classList.toggle('open');
});
$('mobileCSToggle').addEventListener('click', () => {
  state.hideCS = !state.hideCS;
  applyCSToggle();
  $('mobileMenuDropdown').classList.remove('open');
});
document.addEventListener('click', () => $('mobileMenuDropdown').classList.remove('open'));

/* ── Empty state tab links ────────────────────────────────────────────────── */
document.querySelectorAll('.empty-tab-link').forEach(a => {
  a.addEventListener('click', () => {
    const name = a.dataset.tab;
    state.tab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'discover') loadDiscover();
    if (name === 'trending') loadTrending();
  });
});

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    if (name === state.tab) return;
    state.tab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'discover') loadDiscover();
    if (name === 'trending') loadTrending();
    if (name === 'followed') renderFollowed();
  });
});

function updateBadge() {
  const badge = $('followedBadge');
  badge.textContent = state.followed.size;
  badge.style.display = state.followed.size ? 'inline' : 'none';
}

/* ══════════════════════════════════════════════════════════════════════════
   DISCOVER
═══════════════════════════════════════════════════════════════════════════ */
async function loadDiscover() {
  const { page, search, cluster } = state.discover;
  const params = new URLSearchParams({ page, search, cluster, hideCountrySector: state.hideCS });
  const grid = $('discoverGrid');
  grid.innerHTML = '<div class="spinner"></div>';
  const data = await fetch(`/api/themes/discover?${params}`).then(r => r.json());
  state.discover.total = data.total;
  grid.innerHTML = '';

  if (cluster && page === 1 && !search) {
    // Cluster hero view — switch container out of grid layout
    grid.style.display = 'block';
    $('discoverCount').textContent = `${data.total.toLocaleString()} themes in ${cluster}`;
    renderClusterHero(data.themes, cluster, data.total, grid);
  } else {
    grid.style.display = '';
    $('discoverCount').textContent = `${data.total.toLocaleString()} themes found`;
    data.themes.forEach(t => grid.appendChild(makeThemeCard(t)));
  }
  renderPagination(data.total, page);
}

function renderClusterHero(themes, clusterName, total, container) {
  const top5 = themes.slice(0, 5);
  const rest = themes.slice(5);

  // Header + Follow All
  const header = document.createElement('div');
  header.className = 'cluster-explore-header';
  const allFollowing = top5.every(t => state.followed.has(t.theme_name));
  header.innerHTML = `
    <div>
      <div class="cluster-explore-title">${esc(clusterName)}</div>
      <div class="cluster-explore-sub">${total.toLocaleString()} themes · top 5 by insight volume</div>
    </div>
    <button class="follow-all-btn ${allFollowing ? 'all-following' : ''}" id="followAllBtn">
      ${allFollowing ? '✓ All Following' : '⚡ Follow Top 5'}
    </button>`;
  container.appendChild(header);

  // Hero grid
  const heroGrid = document.createElement('div');
  heroGrid.className = 'cluster-hero-grid';
  const heroMax = top5[0]?.insight_count || 1;
  top5.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'hero-card';
    const following = state.followed.has(t.theme_name);
    const pct = Math.round((t.insight_count / heroMax) * 100);
    card.innerHTML = `
      <div class="hero-card-rank">#${i + 1}</div>
      <div class="hero-card-name">${esc(t.theme_name)}</div>
      <div class="hero-card-count">${Number(t.insight_count).toLocaleString()}</div>
      <div class="hero-card-count-label">insights (90 days)</div>
      <div class="hero-bar-wrap"><div class="hero-bar-fill" style="width:${pct}%"></div></div>
      <button class="hero-card-follow ${following ? 'following' : ''}" data-name="${esc(t.theme_name)}">
        ${following ? 'Following' : '+ Follow'}
      </button>`;
    card.addEventListener('click', () => openDrawer(t));
    card.querySelector('.hero-card-follow').addEventListener('click', e => {
      e.stopPropagation();
      toggleFollow(t.theme_name, e.currentTarget); syncFollowAllBtn();
    });
    heroGrid.appendChild(card);
  });
  container.appendChild(heroGrid);

  // Follow All button logic
  function syncFollowAllBtn() {
    const btn = $('followAllBtn');
    if (!btn) return;
    const allF = top5.every(t => state.followed.has(t.theme_name));
    btn.classList.toggle('all-following', allF);
    btn.textContent = allF ? '✓ All Following' : '⚡ Follow Top 5';
  }
  header.querySelector('#followAllBtn').addEventListener('click', () => {
    top5.forEach(t => state.followed.add(t.theme_name));
    saveFollowed(); updateBadge();
    heroGrid.querySelectorAll('.hero-card-follow').forEach((btn, i) => {
      btn.classList.add('following'); btn.textContent = 'Following';
    });
    syncFollowAllBtn();
  });

  // Remaining as compact list
  if (rest.length) {
    const moreTitle = document.createElement('div');
    moreTitle.className = 'cluster-more-title';
    moreTitle.textContent = `More in ${clusterName}`;
    container.appendChild(moreTitle);

    const list = document.createElement('div');
    list.className = 'cluster-theme-list';
    rest.forEach(t => {
      const row = document.createElement('div');
      row.className = 'cluster-theme-row';
      const following = state.followed.has(t.theme_name);
      row.innerHTML = `
        <span class="cluster-theme-row-name">${esc(t.theme_name)} <span class="trend-count-inline">(${Number(t.insight_count).toLocaleString()})</span></span>
        <button class="cluster-theme-row-follow ${following ? 'following' : ''}" data-name="${esc(t.theme_name)}">
          ${following ? 'Following' : '+ Follow'}
        </button>`;
      row.addEventListener('click', e => { if (!e.target.classList.contains('cluster-theme-row-follow')) openDrawer(t); });
      row.querySelector('.cluster-theme-row-follow').addEventListener('click', e => { e.stopPropagation(); toggleFollow(t.theme_name, e.currentTarget); });
      list.appendChild(row);
    });
    container.appendChild(list);
  }
}

function makeThemeCard(t) {
  const card = document.createElement('div');
  card.className = 'theme-card';
  const following = state.followed.has(t.theme_name);
  const displayCluster = t.macro_cluster || t.cached_cluster_name || '—';
  card.innerHTML = `
    <div>
      <div class="theme-card-name">${esc(t.theme_name)}</div>
      <span class="cluster-pill" title="${esc(t.cached_cluster_name || '')}">${esc(displayCluster)}</span>
    </div>
    <div class="theme-card-footer">
      <span class="insight-count">${Number(t.insight_count || 0).toLocaleString()} insights</span>
      <button class="follow-btn ${following ? 'following' : ''}" data-name="${esc(t.theme_name)}">
        ${following ? 'Following' : '+ Follow'}
      </button>
    </div>`;
  card.addEventListener('click', () => openDrawer(t));
  card.querySelector('.follow-btn').addEventListener('click', e => { e.stopPropagation(); toggleFollow(t.theme_name, e.currentTarget); });
  return card;
}

function renderPagination(total, page) {
  const totalPages = Math.ceil(total / 9);
  const el = $('discoverPagination');
  el.innerHTML = '';
  if (totalPages <= 1) return;

  const pages = [1];
  if (page > 3) pages.push('…');
  for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) pages.push(p);
  if (page < totalPages - 2) pages.push('…');
  if (totalPages > 1) pages.push(totalPages);

  const prev = document.createElement('button');
  prev.className = 'page-btn'; prev.textContent = '← Prev'; prev.disabled = page === 1;
  prev.onclick = () => { state.discover.page--; loadDiscover(); };
  el.appendChild(prev);

  pages.forEach(p => {
    if (p === '…') {
      const sep = document.createElement('span');
      sep.textContent = '…'; sep.style.cssText = 'color:var(--text-muted);padding:0 6px';
      el.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `page-btn ${p === page ? 'active' : ''}`;
      btn.textContent = p;
      btn.onclick = () => { state.discover.page = p; loadDiscover(); };
      el.appendChild(btn);
    }
  });

  const next = document.createElement('button');
  next.className = 'page-btn'; next.textContent = 'Next →'; next.disabled = page === totalPages;
  next.onclick = () => { state.discover.page++; loadDiscover(); };
  el.appendChild(next);
}

function updateClearBtn() {
  const active = state.discover.search || state.discover.cluster;
  $('clearFiltersBtn').style.display = active ? '' : 'none';
}

let searchTimer;
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.discover.search = e.target.value; state.discover.page = 1; updateClearBtn(); loadDiscover(); }, 350);
});
$('clusterFilter').addEventListener('change', e => { state.discover.cluster = e.target.value; state.discover.page = 1; updateClearBtn(); loadDiscover(); });
$('clearFiltersBtn').addEventListener('click', () => {
  state.discover.search = ''; state.discover.cluster = ''; state.discover.page = 1;
  $('searchInput').value = ''; $('clusterFilter').value = '';
  updateClearBtn(); loadDiscover();
});

async function loadClusters() {
  const clusters = await fetch('/api/clusters').then(r => r.json());
  const sel = $('clusterFilter');
  clusters.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   TRENDING — hero (top 5) + list (6-100)
═══════════════════════════════════════════════════════════════════════════ */
let trendingLoaded = false;
async function loadTrending() {
  if (trendingLoaded) return;
  const hero = $('trendingHero');
  hero.innerHTML = '<div class="spinner"></div>';
  const params = new URLSearchParams({ hideCountrySector: state.hideCS });
  const data = await fetch(`/api/themes/trending?${params}`).then(r => r.json());
  hero.innerHTML = '';

  // Hero: top 5
  const top5 = data.slice(0, 5);

  // Follow Top 5 bar
  const trendingHeader = document.createElement('div');
  trendingHeader.className = 'cluster-explore-header';
  trendingHeader.style.marginBottom = '14px';
  const allF5 = top5.every(t => state.followed.has(t.theme_name));
  trendingHeader.innerHTML = `
    <div>
      <div class="cluster-explore-title">Trending Now</div>
      <div class="cluster-explore-sub">Top 100 themes by insight volume · last 90 days</div>
    </div>
    <button class="follow-all-btn ${allF5 ? 'all-following' : ''}" id="trendFollowAllBtn">
      ${allF5 ? '✓ All Following' : '⚡ Follow Top 5'}
    </button>`;
  hero.appendChild(trendingHeader);

  function syncTrendFollowAllBtn() {
    const btn = $('trendFollowAllBtn');
    if (!btn) return;
    const allF = top5.every(t => state.followed.has(t.theme_name));
    btn.classList.toggle('all-following', allF);
    btn.textContent = allF ? '✓ All Following' : '⚡ Follow Top 5';
  }
  trendingHeader.querySelector('#trendFollowAllBtn').addEventListener('click', () => {
    top5.forEach(t => state.followed.add(t.theme_name));
    saveFollowed(); updateBadge();
    heroGrid.querySelectorAll('.hero-card-follow').forEach(btn => { btn.classList.add('following'); btn.textContent = 'Following'; });
    syncTrendFollowAllBtn();
  });

  const heroGrid = document.createElement('div');
  heroGrid.className = 'hero-grid';
  const heroMax = top5[0]?.insight_count || 1;
  top5.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'hero-card';
    const following = state.followed.has(t.theme_name);
    const displayCluster = t.macro_cluster || t.cached_cluster_name || '—';
    const pct = Math.round((t.insight_count / heroMax) * 100);
    card.innerHTML = `
      <div class="hero-card-rank">#${i + 1}</div>
      <div class="hero-card-name">${esc(t.theme_name)}</div>
      <div class="hero-card-cluster">${esc(displayCluster)}</div>
      <div class="hero-card-count">${Number(t.insight_count).toLocaleString()}</div>
      <div class="hero-card-count-label">insights (90 days)</div>
      <div class="hero-bar-wrap"><div class="hero-bar-fill" style="width:${pct}%"></div></div>
      <button class="hero-card-follow ${following ? 'following' : ''}" data-name="${esc(t.theme_name)}">
        ${following ? 'Following' : '+ Follow'}
      </button>`;
    card.addEventListener('click', () => openDrawer(t));
    card.querySelector('.hero-card-follow').addEventListener('click', e => { e.stopPropagation(); toggleFollow(t.theme_name, e.currentTarget); });
    heroGrid.appendChild(card);
  });
  hero.appendChild(heroGrid);

  // List: items 6-100
  const listSection = $('trendingListSection');
  const list = $('trendingList');
  list.innerHTML = '';
  if (data.length > 5) {
    const rest = data.slice(5);
    const listMax = data[0]?.insight_count || 1;
    rest.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'trend-item';
      const pct = Math.round((t.insight_count / listMax) * 100);
      const following = state.followed.has(t.theme_name);
      const displayCluster = t.macro_cluster || t.cached_cluster_name || '—';
      item.innerHTML = `
        <span class="trend-rank">#${i + 6}</span>
        <div class="trend-bar-wrap">
          <span class="trend-name">${esc(t.theme_name)} <span class="trend-count-inline">(${Number(t.insight_count).toLocaleString()})</span></span>
          <div class="trend-bar-bg"><div class="trend-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <button class="trend-follow-btn ${following ? 'following' : ''}" data-name="${esc(t.theme_name)}">
          ${following ? 'Following' : '+ Follow'}
        </button>`;
      item.addEventListener('click', e => { if (!e.target.classList.contains('trend-follow-btn')) openDrawer(t); });
      item.querySelector('.trend-follow-btn').addEventListener('click', e => { e.stopPropagation(); toggleFollow(t.theme_name, e.currentTarget); });
      list.appendChild(item);
    });
    listSection.style.display = '';
  } else {
    listSection.style.display = 'none';
  }
  trendingLoaded = true;
}

/* ══════════════════════════════════════════════════════════════════════════
   FOLLOWED
═══════════════════════════════════════════════════════════════════════════ */
function renderFollowed() {
  const empty = $('followedEmpty');
  const layout = $('followedLayout');
  if (state.followed.size === 0) { empty.style.display = ''; layout.style.display = 'none'; return; }
  empty.style.display = 'none';
  layout.style.display = '';
  $('followedLhsCount').textContent = state.followed.size;

  const list = $('followedThemeList');
  list.innerHTML = '';
  [...state.followed].sort((a, b) => a.localeCompare(b)).forEach(name => {
    const li = document.createElement('li');
    li.className = `followed-theme-item ${state.selectedFollowedTheme === name ? 'active' : ''}`;
    li.innerHTML = `<span class="fti-name">${esc(name)}</span>`;
    li.addEventListener('click', () => selectFollowedTheme(name));
    list.appendChild(li);
  });

  // Auto-select first item if nothing selected yet
  if (!state.selectedFollowedTheme) {
    const first = [...state.followed].sort((a, b) => a.localeCompare(b))[0];
    if (first) state.selectedFollowedTheme = first;
  }
  // Mark active in list
  document.querySelectorAll('.followed-theme-item').forEach(li => {
    li.classList.toggle('active', li.querySelector('.fti-name')?.textContent === state.selectedFollowedTheme);
  });
  $('followedRhsEmpty').style.display = state.selectedFollowedTheme ? 'none' : '';
  $('insightViewer').style.display = state.selectedFollowedTheme ? '' : 'none';
  if (state.selectedFollowedTheme) loadInsightViewer(state.selectedFollowedTheme);
}

function selectFollowedTheme(name) {
  state.selectedFollowedTheme = name;
  document.querySelectorAll('.followed-theme-item').forEach(li => {
    li.classList.toggle('active', li.querySelector('.fti-name')?.textContent === name);
  });
  $('followedRhsEmpty').style.display = 'none';
  $('insightViewer').style.display = '';
  loadInsightViewer(name);
}

async function loadInsightViewer(name) {
  $('insightViewerTitle').textContent = name;
  const body = $('insightViewerBody');
  body.innerHTML = '<div class="spinner"></div>';

  // Reset AI panel
  $('aiInline').style.display = 'none';
  $('aiResultBody').innerHTML = '';
  $('aiError').style.display = 'none';
  $('copyBtn').style.display = 'none';
  $('aiCacheLabel').style.display = 'none';
  $('aiMetaRow').style.display = 'none';
  $('actionabilityReason').style.display = 'none';

  // Check cache — if found, show immediately
  const cached = getCachedSummary(name);
  if (cached) {
    showAISummary(cached, true);
  } else {
    $('summarizeBtn').textContent = 'Summarise Latest Developments';
    $('summarizeBtn').disabled = false;
    $('summarizeBtn').style.display = '';
  }

  $('insightViewerUnfollow').onclick = () => {
    state.followed.delete(name);
    saveFollowed(); updateBadge();
    state.selectedFollowedTheme = null;
    renderFollowed();
  };

  const data = await fetch(`/api/themes/${encodeURIComponent(name)}/insights`).then(r => r.json());
  body.innerHTML = '';
  if (!data.length) { body.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No insights found.</p>'; return; }
  const countLabel = document.createElement('div');
  countLabel.style.cssText = 'font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:14px;padding-top:4px';
  countLabel.textContent = `${data.length} most recent insights · newest first`;
  body.appendChild(countLabel);
  data.forEach(item => {
    const div = document.createElement('div');
    div.className = 'insight-item';
    const bulletItems = (item.bullet_points || []).filter(b => b && b.trim());
    const bulletsHtml = bulletItems.length ? `<ul class="insight-bullets">${bulletItems.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
    const tagline = item.tagline ? esc(item.tagline) : 'View Insight';
    const url = esc(item.url || '#');
    div.innerHTML = `
      <div class="insight-source">
        <a class="insight-tagline" href="${url}" target="_blank" rel="noopener">${tagline}</a>
        <a class="insight-link" href="${url}" target="_blank" rel="noopener">↗ Read</a>
      </div>
      <div class="insight-date">${fmtDate(item.created_at)}</div>
      ${bulletsHtml}`;
    body.appendChild(div);
  });
}

function showAISummary(data, fromCache) {
  const { html, ts, sentiment, sentimentReason, actionability, actionabilityReason } = data;
  $('aiInline').style.display = '';
  $('aiLoading').style.display = 'none';
  $('aiResultBody').innerHTML = html;
  $('aiError').style.display = 'none';

  const d = new Date(ts);
  $('aiTimestamp').textContent = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (fromCache) {
    const ageMs = Date.now() - ts;
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    const ageLabel = ageDays >= 1 ? `${ageDays}d ago` : ageHours >= 1 ? `${ageHours}h ago` : 'just now';
    $('aiCacheLabel').textContent = `Cached · ${ageLabel}`;
    $('aiCacheLabel').style.display = '';
  } else {
    $('aiCacheLabel').style.display = 'none';
  }
  // Sentiment + Actionability
  if (sentiment) {
    const badge = $('sentimentBadge');
    const cls = sentiment.toLowerCase();
    const icon = cls === 'bullish' ? '▲' : cls === 'bearish' ? '▼' : cls === 'mixed' ? '◆' : '●';
    badge.className = `sentiment-badge ${cls}`;
    badge.textContent = `${icon} ${sentiment}`;
    $('sentimentReason').textContent = sentimentReason || '';
    $('aiMetaRow').style.display = '';
  }
  if (actionability) {
    const dots = $('actionabilityDots');
    dots.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const d = document.createElement('div');
      d.className = `actionability-dot ${i <= actionability ? 'active' : ''}`;
      dots.appendChild(d);
    }
    $('actionabilityNum').textContent = `${actionability}/5`;
    if (actionabilityReason) {
      $('actionabilityReason').textContent = actionabilityReason;
      $('actionabilityReason').style.display = '';
    }
  }

  $('copyBtn').style.display = '';
  $('aiCollapseBtn').textContent = 'Collapse ↑';
  $('summarizeBtn').style.display = 'none';
}

/* ── AI Summary ───────────────────────────────────────────────────────────── */
const LOADING_MSGS = [
  'Synthesising market signals…',
  'Reading analyst perspectives…',
  'Identifying key developments…',
  'Assessing risk factors…',
  'Building investment thesis…',
  'Evaluating sentiment signals…',
  'Connecting macro themes…',
  'Weighing the evidence…',
];
let _loadingTimer = null;
function startLoadingMessages() {
  const el = $('aiLoadingText');
  let i = 0;
  el.textContent = LOADING_MSGS[0];
  _loadingTimer = setInterval(() => { i = (i + 1) % LOADING_MSGS.length; el.textContent = LOADING_MSGS[i]; }, 2200);
}
function stopLoadingMessages() {
  if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
}

$('summarizeBtn').addEventListener('click', async () => {
  const theme = state.selectedFollowedTheme;
  if (!theme) return;
  const btn = $('summarizeBtn');
  btn.disabled = true;
  $('aiInline').style.display = '';
  $('aiLoading').style.display = '';
  startLoadingMessages();
  $('aiResultBody').innerHTML = '';
  $('aiError').style.display = 'none';
  $('copyBtn').style.display = 'none';
  $('aiCacheLabel').style.display = 'none';

  try {
    const data = await fetch('/api/themes/summarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const entry = { html: data.html, ts: Date.now(), sentiment: data.sentiment, sentimentReason: data.sentimentReason, actionability: data.actionability, actionabilityReason: data.actionabilityReason };
    setCachedSummary(theme, entry);
    if (state.selectedFollowedTheme === theme) showAISummary(entry, false);
  } catch (err) {
    if (state.selectedFollowedTheme === theme) {
      $('aiError').textContent = `Error: ${err.message}`;
      $('aiError').style.display = '';
      btn.textContent = 'Summarise Latest Developments';
    }
  } finally {
    stopLoadingMessages();
    if (state.selectedFollowedTheme === theme) {
      $('aiLoading').style.display = 'none';
      btn.disabled = false;
    }
  }
});

$('copyBtn').addEventListener('click', async () => {
  const btn = $('copyBtn');
  const theme = state.selectedFollowedTheme || '';
  const sentimentText = $('sentimentBadge').textContent.trim();
  const sentimentReasonText = $('sentimentReason').textContent.trim();
  const actionabilityText = $('actionabilityNum').textContent.trim();
  const actionabilityReasonText = $('actionabilityReason').textContent.trim();
  const bodyHTML = $('aiResultBody').innerHTML;

  const metaHTML = `<p><strong>Theme:</strong> ${theme}</p>
<p><strong>Sentiment:</strong> ${sentimentText}${sentimentReasonText ? ' — ' + sentimentReasonText : ''}</p>
<p><strong>Actionability:</strong> ${actionabilityText}${actionabilityReasonText ? ' — ' + actionabilityReasonText : ''}</p><hr>`;

  const fullHTML = metaHTML + bodyHTML;
  const metaText = `Theme: ${theme}\nSentiment: ${sentimentText}${sentimentReasonText ? ' — ' + sentimentReasonText : ''}\nActionability: ${actionabilityText}${actionabilityReasonText ? ' — ' + actionabilityReasonText : ''}\n\n`;
  const fullText = metaText + $('aiResultBody').innerText;

  try {
    const blob = new Blob([fullHTML], { type: 'text/html' });
    const textBlob = new Blob([fullText], { type: 'text/plain' });
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob })]);
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; btn.classList.remove('copied'); }, 2000);
  } catch {
    try {
      await navigator.clipboard.writeText(fullText);
      btn.textContent = 'Copied (text) ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy to clipboard'; btn.classList.remove('copied'); }, 2000);
    } catch {
      btn.textContent = 'Copy failed';
      setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 2000);
    }
  }
});

$('aiCollapseBtn').addEventListener('click', () => {
  const body = $('aiResultBody');
  const collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  $('aiCollapseBtn').textContent = collapsed ? 'Collapse ↑' : 'Expand ↓';
});

/* ── Follow / Unfollow ────────────────────────────────────────────────────── */
function toggleFollow(name, btn) {
  const nowFollowing = !state.followed.has(name);
  if (nowFollowing) state.followed.add(name); else state.followed.delete(name);
  btn.classList.toggle('following', nowFollowing);
  btn.textContent = nowFollowing ? 'Following' : '+ Follow';
  saveFollowed(); updateBadge();
  if (state.drawerTheme?.theme_name === name) {
    const dfBtn = $('drawerFollowBtn');
    dfBtn.classList.toggle('following', nowFollowing);
    dfBtn.textContent = nowFollowing ? 'Following' : '+ Follow';
    dfBtn.onclick = () => toggleFollow(name, dfBtn);
  }
  if (!nowFollowing && state.selectedFollowedTheme === name) renderFollowed();
}

/* ── Drawer ───────────────────────────────────────────────────────────────── */
async function openDrawer(t) {
  const themeName = typeof t === 'string' ? t : t.theme_name;
  const themeObj = typeof t === 'object' ? t : { theme_name: t };
  state.drawerTheme = themeObj;
  $('drawerTitle').textContent = themeName;
  const displayCluster = themeObj.macro_cluster || themeObj.cached_cluster_name || '';
  $('drawerCluster').textContent = displayCluster;
  const following = state.followed.has(themeName);
  const dfBtn = $('drawerFollowBtn');
  dfBtn.classList.toggle('following', following);
  dfBtn.textContent = following ? 'Following' : '+ Follow';
  dfBtn.onclick = () => toggleFollow(themeName, dfBtn);

  $('drawerInsights').innerHTML = '<div class="spinner"></div>';
  $('drawer').classList.add('active');
  $('drawerOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';

  const data = await fetch(`/api/themes/${encodeURIComponent(themeName)}/insights`).then(r => r.json());
  const ins = $('drawerInsights');
  ins.innerHTML = '';
  if (!data.length) { ins.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No insights yet.</p>'; return; }
  data.forEach(item => {
    const div = document.createElement('div');
    div.className = 'insight-item';
    const bulletItems = (item.bullet_points || []).filter(b => b && b.trim());
    const bulletsHtml = bulletItems.length ? `<ul class="insight-bullets">${bulletItems.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
    const tagline = item.tagline ? esc(item.tagline) : 'View Insight';
    const url = esc(item.url || '#');
    div.innerHTML = `
      <div class="insight-source">
        <a class="insight-tagline" href="${url}" target="_blank" rel="noopener">${tagline}</a>
        <a class="insight-link" href="${url}" target="_blank" rel="noopener">↗ Read</a>
      </div>
      <div class="insight-date">${fmtDate(item.created_at)}</div>
      ${bulletsHtml}`;
    ins.appendChild(div);
  });
}

function closeDrawer() {
  $('drawer').classList.remove('active');
  $('drawerOverlay').classList.remove('active');
  document.body.style.overflow = '';
}
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerOverlay').addEventListener('click', closeDrawer);

/* ── Rebuild modal ────────────────────────────────────────────────────────── */
async function openRebuildModal() {
  $('rebuildModal').style.display = '';
  $('rebuildModalBody').innerHTML = '<div class="spinner"></div>';
  const status = await fetch('/api/admin/rebuild-status').then(r => r.json()).catch(() => ({}));
  const canRun = status.canRun, running = status.running;
  const dotClass = running ? 'yellow' : canRun ? 'green' : 'red';
  const statusText = running ? 'Build in progress…' : canRun ? 'Ready to rebuild' : `Next rebuild: ${new Date(status.nextAllowed).toDateString()}`;
  $('rebuildModalBody').innerHTML = `
    <div class="status-line"><span class="status-dot ${dotClass}"></span><span>${statusText}</span></div>
    <p>${status.lastRun ? `Last run: ${new Date(status.lastRun).toLocaleString()}` : 'Never run'}</p>
    <p>Uses Gemini to classify ~5,000 cluster names into canonical macro-categories. Runs in background (~10 min). Limited to once every 3 months.</p>
    <div class="modal-actions">
      <button class="btn-primary" id="rebuildConfirmBtn" ${!canRun ? 'disabled' : ''}>${running ? 'Running…' : 'Start Rebuild'}</button>
      <button class="btn-secondary" id="rebuildCancelBtn">Cancel</button>
    </div>`;
  $('rebuildCancelBtn').onclick = () => { $('rebuildModal').style.display = 'none'; };
  if (canRun) {
    $('rebuildConfirmBtn').onclick = async () => {
      $('rebuildConfirmBtn').disabled = true; $('rebuildConfirmBtn').textContent = 'Starting…';
      try {
        const r = await fetch('/api/admin/rebuild-clusters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
        if (r.error) throw new Error(r.error);
        $('rebuildBtn').classList.add('running');
        $('rebuildModal').style.display = 'none';
      } catch (err) { $('rebuildConfirmBtn').textContent = `Error: ${err.message}`; }
    };
  }
}
$('rebuildBtn').addEventListener('click', openRebuildModal);
$('rebuildModalClose').addEventListener('click', () => { $('rebuildModal').style.display = 'none'; });

async function checkBuildStatus() {
  const s = await fetch('/api/admin/rebuild-status').then(r => r.json()).catch(() => null);
  if (!s) return;
  if (s.running) { $('rebuildBtn').classList.add('running'); return; }
  if (!s.canRun) $('rebuildBtn').style.display = 'none';
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(iso) { if (!iso) return ''; return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }


/* ── Init ─────────────────────────────────────────────────────────────────── */
$('csToggleHeader').dataset.active = 'true';
$('mobileCSToggle').dataset.active = 'true';
updateBadge();
loadClusters(); // preload clusters for when user navigates to Explore
renderFollowed();
checkBuildStatus();
