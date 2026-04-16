require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ── Canonical cluster mapping ────────────────────────────────────────────────
const CANONICAL_MAP_PATH = path.join(__dirname, 'cluster_canonical.json');
const BUILD_STATUS_PATH = path.join(__dirname, 'build-status.json');

let clusterMap = {};
let macroList = [];

function loadClusterMap() {
  if (fs.existsSync(CANONICAL_MAP_PATH)) {
    clusterMap = JSON.parse(fs.readFileSync(CANONICAL_MAP_PATH, 'utf8'));
    // Derive macroList from actual values in clusterMap (source of truth)
    macroList = [...new Set(Object.values(clusterMap))].sort();
    console.log(`Cluster map: ${Object.keys(clusterMap).length} entries, ${macroList.length} macro clusters`);
  }
}
loadClusterMap();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 15000,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// ── Discover ─────────────────────────────────────────────────────────────────
app.get('/api/themes/discover', async (req, res) => {
  const { search = '', cluster = '', page = 1, hideCountrySector = 'false' } = req.query;
  const limit = 9;
  const offset = (parseInt(page) - 1) * limit;
  try {
    let where = [], params = [], idx = 1;

    if (search) { where.push(`theme_name ILIKE $${idx++}`); params.push(`%${search}%`); }

    if (cluster) {
      if (macroList.length > 0 && macroList.includes(cluster)) {
        const rawClusters = Object.entries(clusterMap).filter(([, v]) => v === cluster).map(([k]) => k);
        if (rawClusters.length) { where.push(`cached_cluster_name = ANY($${idx++})`); params.push(rawClusters); }
      } else {
        where.push(`cached_cluster_name ILIKE $${idx++}`); params.push(`%${cluster}%`);
      }
    }

    if (hideCountrySector === 'true') where.push(`cached_cluster_name != 'country/sector'`);

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM (
         SELECT theme_name FROM insight_themes ${whereClause}
         GROUP BY theme_name HAVING COUNT(*) >= 10
       ) t`,
      params
    );
    const rows = await pool.query(
      `SELECT theme_name, cached_cluster_name, COUNT(*) as insight_count, MAX(created_at) as latest_at
       FROM insight_themes ${whereClause}
       GROUP BY theme_name, cached_cluster_name
       HAVING COUNT(*) >= 10
       ORDER BY insight_count DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );

    const themes = rows.rows.map(r => ({
      ...r,
      macro_cluster: clusterMap[r.cached_cluster_name] || r.cached_cluster_name,
    }));

    res.json({ total: parseInt(countQ.rows[0].count), page: parseInt(page), themes });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Trending ─────────────────────────────────────────────────────────────────
app.get('/api/themes/trending', async (req, res) => {
  const { hideCountrySector = 'false' } = req.query;
  try {
    const csFilter = hideCountrySector === 'true' ? `AND cached_cluster_name != 'country/sector'` : '';
    const rows = await pool.query(`
      SELECT theme_name, cached_cluster_name, COUNT(*) as insight_count, MAX(created_at) as latest_at
      FROM insight_themes
      WHERE created_at > NOW() - INTERVAL '90 days' ${csFilter}
      GROUP BY theme_name, cached_cluster_name
      HAVING COUNT(*) >= 10
      ORDER BY insight_count DESC LIMIT 100`);
    res.json(rows.rows.map(r => ({ ...r, macro_cluster: clusterMap[r.cached_cluster_name] || r.cached_cluster_name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Clusters list ─────────────────────────────────────────────────────────────
app.get('/api/clusters', async (req, res) => {
  if (macroList.length > 0) return res.json(macroList);
  try {
    const rows = await pool.query(`SELECT DISTINCT cached_cluster_name FROM insight_themes WHERE cached_cluster_name IS NOT NULL ORDER BY cached_cluster_name LIMIT 300`);
    res.json(rows.rows.map(r => r.cached_cluster_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Theme insights with source links ─────────────────────────────────────────
app.get('/api/themes/:name/insights', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT it.id, it.insight_id, it.bullet_points, it.created_at,
              i.tagline, i.slug, 'https://www.smartkarma.com/insights/' || i.slug AS url
       FROM insight_themes it
       INNER JOIN insights i ON i.id = it.insight_id
       WHERE it.theme_name = $1
       ORDER BY it.created_at DESC LIMIT 15`,
      [req.params.name]
    );
    res.json(rows.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Markdown → HTML post-processor (in case model slips into markdown) ───────
function mdToHtml(text) {
  if (!text) return text;
  return text
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/^[-*•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
}

// ── Upstash Redis (optional) ──────────────────────────────────────────────────
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    console.log('Upstash Redis connected');
  } catch (e) { console.warn('Upstash Redis not available:', e.message); }
}

// ── AI Summary — per theme, detailed HTML ─────────────────────────────────────
app.post('/api/themes/summarize', async (req, res) => {
  const { theme, force } = req.body;
  if (!theme) return res.status(400).json({ error: 'No theme provided' });
  if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set.' });

  // Check Upstash cache (skip if force=true)
  if (redis && !force) {
    try {
      const cached = await redis.get(`sk_summary:${theme}`);
      if (cached) return res.json({ ...cached, fromCache: true });
    } catch (e) { console.warn('Redis get error:', e.message); }
  }

  try {
    const rows = await pool.query(
      `SELECT it.bullet_points, it.created_at, i.tagline, i.slug,
              'https://www.smartkarma.com/insights/' || i.slug AS url
       FROM insight_themes it
       INNER JOIN insights i ON i.id = it.insight_id
       WHERE it.theme_name = $1
       ORDER BY it.created_at DESC LIMIT 20`,
      [theme]
    );
    if (!rows.rows.length) return res.status(404).json({ error: 'No insights found for this theme.' });

    const sources = rows.rows.map((r, i) => ({
      num: i + 1, tagline: r.tagline || 'Smartkarma Insight',
      url: r.url, date: r.created_at, bullets: r.bullet_points || [],
    }));

    const sourceContext = sources.map(s =>
      `[${s.num}] "${s.tagline}" (${new Date(s.date).toDateString()})\n    URL: ${s.url}\n    Key points:\n${s.bullets.map(b => `    - ${b}`).join('\n')}`
    ).join('\n\n');

    const prompt = `You are a senior equity research analyst writing an investment research briefing for institutional investors.

THEME: "${theme}"

You have ${sources.length} recent research insights on this theme (numbered for citation):

${sourceContext}

Write a detailed, professional HTML research briefing on "${theme}".

HTML requirements:
1. Structure with <h2> section headings: Executive Summary, Key Developments, Risks & Headwinds, Opportunities & Catalysts, Outlook
2. Use <ul><li> bullet points extensively — prefer bullets over prose for all key points (4-8 bullets per section)
3. Cite sources inline as hyperlinks: <a href="URL" target="_blank" rel="noopener">brief description</a>
4. Write for institutional analysts: precise, data-driven, no filler phrases
5. Use <strong> for key company names, metrics, and critical terms
6. Clean HTML only — no markdown, no code fences, no <html>/<body> tags, start directly with first <h2>
7. Cite at least 8 of the provided sources

Also assess:
- sentiment: "Bullish", "Bearish", "Neutral", or "Mixed" (weight of evidence)
- sentiment_reason: one concise sentence
- actionability: integer 1–5 (1=watch only, 5=high-conviction time-sensitive opportunity)
- actionability_reason: one concise sentence

CRITICAL: The "html" field must use only HTML tags — absolutely NO markdown syntax (no **, no ##, no -, no *). Use <strong>, <h2>, <ul>, <li>, <a> tags only.

Return ONLY a valid JSON object — no markdown wrapper, no code fences, no explanation outside the JSON:
{"sentiment":"...","sentiment_reason":"...","actionability":N,"actionability_reason":"...","html":"..."}`;

    const model = genAI.getGenerativeModel(
      { model: 'gemini-2.5-flash' },
      { generationConfig: { maxOutputTokens: 8192 } }
    );
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw.trim());
    } catch {
      // Partial/truncated JSON — extract fields via regex rather than showing raw JSON
      const extract = (key) => { const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)); return m ? m[1] : null; };
      const extractNum = (key) => { const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`)); return m ? parseInt(m[1]) : null; };
      // Extract html: find the opening of the html field value and take everything after it
      const htmlMatch = raw.match(/"html"\s*:\s*"([\s\S]*)/);
      const htmlRaw = htmlMatch ? htmlMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t').replace(/\\\\/g, '\\') : '';
      parsed = {
        sentiment: extract('sentiment'),
        sentiment_reason: extract('sentiment_reason'),
        actionability: extractNum('actionability'),
        actionability_reason: extract('actionability_reason'),
        html: htmlRaw,
      };
    }
    // Strip trailing JSON/markdown artifacts (e.g. `" } ``` `) after the last HTML closing tag
    const lastAngle = (parsed.html || '').lastIndexOf('>');
    if (lastAngle !== -1) parsed.html = parsed.html.substring(0, lastAngle + 1);
    // Post-process: convert any residual markdown to HTML
    parsed.html = mdToHtml(parsed.html || '');

    const payload = { html: parsed.html, sentiment: parsed.sentiment, sentimentReason: parsed.sentiment_reason, actionability: parsed.actionability, actionabilityReason: parsed.actionability_reason, theme, sourceCount: sources.length };

    // Cache in Upstash for 7 days
    if (redis) {
      try { await redis.set(`sk_summary:${theme}`, payload, { ex: 7 * 24 * 60 * 60 }); }
      catch (e) { console.warn('Redis set error:', e.message); }
    }

    res.json(payload);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Admin: rebuild ────────────────────────────────────────────────────────────
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
function getBuildStatus() {
  if (!fs.existsSync(BUILD_STATUS_PATH)) return { lastRun: null, running: false };
  return JSON.parse(fs.readFileSync(BUILD_STATUS_PATH, 'utf8'));
}
function setBuildStatus(data) { fs.writeFileSync(BUILD_STATUS_PATH, JSON.stringify(data, null, 2)); }

app.get('/api/admin/rebuild-status', (req, res) => {
  const status = getBuildStatus();
  const canRun = !status.running && (!status.lastRun || Date.now() - new Date(status.lastRun).getTime() > THREE_MONTHS_MS);
  const nextAllowed = status.lastRun ? new Date(new Date(status.lastRun).getTime() + THREE_MONTHS_MS).toISOString() : null;
  res.json({ ...status, canRun, nextAllowed });
});

app.post('/api/admin/rebuild-clusters', (req, res) => {
  const status = getBuildStatus();
  if (status.running) return res.status(409).json({ error: 'Build already running.' });
  if (status.lastRun && Date.now() - new Date(status.lastRun).getTime() < THREE_MONTHS_MS) {
    return res.status(429).json({ error: `Next rebuild allowed after ${new Date(new Date(status.lastRun).getTime() + THREE_MONTHS_MS).toDateString()}.` });
  }
  const geminiKey = process.env.GEMINI_API_KEY || '';
  if (!geminiKey) return res.status(400).json({ error: 'GEMINI_API_KEY not available.' });
  setBuildStatus({ lastRun: status.lastRun, running: true, startedAt: new Date().toISOString() });
  const child = spawn('node', [path.join(__dirname, 'scripts/build-cluster-map.js')], {
    env: { ...process.env, GEMINI_API_KEY: geminiKey }, detached: true, stdio: 'ignore',
  });
  child.unref();
  child.on('exit', code => setBuildStatus({ lastRun: new Date().toISOString(), running: false, lastExitCode: code }));
  setBuildStatus({ lastRun: status.lastRun, running: true, startedAt: new Date().toISOString(), pid: child.pid });
  res.json({ started: true, pid: child.pid });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => console.log(`SK Theme Explorer running at http://localhost:${PORT}`));
}
module.exports = app;
