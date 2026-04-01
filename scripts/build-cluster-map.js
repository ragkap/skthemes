#!/usr/bin/env node
/**
 * build-cluster-map.js
 *
 * Fetches all distinct cached_cluster_name values from the DB, then uses
 * Gemini to assign each one to a canonical macro-cluster.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/build-cluster-map.js
 *
 * Output:
 *   cluster_canonical.json   { "raw cluster name": "Macro Category", ... }
 *   cluster_macros.json      [ "Macro Category", ... ]  (sorted list)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const OUT_MAP = path.join(__dirname, '..', 'cluster_canonical.json');
const OUT_MACROS = path.join(__dirname, '..', 'cluster_macros.json');
const BATCH_SIZE = 120;

if (!process.env.GEMINI_API_KEY) {
  console.error('Set GEMINI_API_KEY first.');
  process.exit(1);
}

const pool = new Pool({
  host: 'clients-api-prod-read-replica.c8z9wqzjlfg3.ap-southeast-1.rds.amazonaws.com',
  user: 'skuser',
  password: '3hkh8eDkQxe7EmzQgqHK',
  database: 'clients_api_prod',
  ssl: { rejectUnauthorized: false },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── Step 1: fetch all clusters ordered by usage (most used first) ────────────
async function fetchClusters() {
  const { rows } = await pool.query(`
    SELECT cached_cluster_name, COUNT(*) as cnt
    FROM insight_themes
    WHERE cached_cluster_name IS NOT NULL
    GROUP BY cached_cluster_name
    ORDER BY cnt DESC
  `);
  return rows.map(r => r.cached_cluster_name);
}

// ── Step 2: ask Claude to define the macro-category taxonomy ─────────────────
async function defineMacros(sample200) {
  const prompt = `You are a financial research taxonomy expert.

Below are 200 cluster names from a financial research platform. Study them and define exactly 100 canonical macro-categories that best cover the full range of investment research topics. These macro-categories will be used to group ALL ~5000 cluster variants.

Rules:
- Each macro-category must be a clean, short title (2-5 words)
- Must cover: geographies, sectors, asset classes, macro themes, corporate actions, ESG, technology, and any other major investment research domains
- No overlap — each raw cluster should map cleanly to exactly one macro
- Include a catch-all "Other" category

Sample cluster names:
${sample200.join('\n')}

Return ONLY a JSON array of exactly 100 macro-category strings, no explanation.`;

  const result = await gemini.generateContent(prompt);
  const text = result.response.text().trim();
  const match = text.match(/\[[\s\S]+\]/);
  if (!match) throw new Error('Could not parse macro list: ' + text);
  return JSON.parse(match[0]);
}

// ── Step 3: classify a batch of clusters into macros ─────────────────────────
async function classifyBatch(batch, macros, retries = 2) {
  const prompt = `You are a financial research taxonomy classifier.

Map each cluster name below to exactly one of the canonical macro-categories.

Macro-categories:
${macros.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Cluster names to classify (one per line):
${batch.join('\n')}

Return ONLY a JSON object where each key is the cluster name and the value is the exact macro-category string from the list above. No explanation.`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await gemini.generateContent(prompt);
      const text = result.response.text().trim();
      const match = text.match(/\{[\s\S]+\}/);
      if (!match) throw new Error('No JSON object found');
      return JSON.parse(match[0]);
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  Retry ${attempt + 1} for batch...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Fetching clusters from DB...');
  const all = await fetchClusters();
  console.log(`Found ${all.length} distinct clusters.`);
  await pool.end();

  // Load existing map if resuming
  let mapping = {};
  if (fs.existsSync(OUT_MAP)) {
    mapping = JSON.parse(fs.readFileSync(OUT_MAP, 'utf8'));
    console.log(`Resuming — ${Object.keys(mapping).length} already mapped.`);
  }

  // Define macros from top 200 clusters (most representative)
  let macros;
  if (fs.existsSync(OUT_MACROS)) {
    macros = JSON.parse(fs.readFileSync(OUT_MACROS, 'utf8'));
    console.log(`Loaded existing ${macros.length} macro-categories.`);
  } else {
    console.log('Defining macro-categories from top 200 clusters...');
    macros = await defineMacros(all.slice(0, 200));
    fs.writeFileSync(OUT_MACROS, JSON.stringify(macros, null, 2));
    console.log(`Defined ${macros.length} macro-categories:`, macros);
  }

  // Classify in batches, skip already-mapped
  const todo = all.filter(c => !mapping[c]);
  console.log(`Classifying ${todo.length} remaining clusters in batches of ${BATCH_SIZE}...`);

  const total = Math.ceil(todo.length / BATCH_SIZE);
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Batch ${batchNum}/${total}... `);

    try {
      const result = await classifyBatch(batch, macros);
      // Merge — validate each value is a known macro
      for (const [k, v] of Object.entries(result)) {
        mapping[k] = macros.includes(v) ? v : 'Other';
      }
      // Any in batch not returned by Claude → Other
      for (const c of batch) {
        if (!mapping[c]) mapping[c] = 'Other';
      }
      console.log('done');
      // Save incrementally after every batch
      fs.writeFileSync(OUT_MAP, JSON.stringify(mapping, null, 2));
    } catch (err) {
      console.error('FAILED:', err.message);
      for (const c of batch) if (!mapping[c]) mapping[c] = 'Other';
    }

    // Small delay to avoid rate limits
    if (i + BATCH_SIZE < todo.length) await new Promise(r => setTimeout(r, 300));
  }

  const macroCount = {};
  for (const v of Object.values(mapping)) macroCount[v] = (macroCount[v] || 0) + 1;
  const sorted = Object.entries(macroCount).sort((a, b) => b[1] - a[1]);
  console.log('\nFinal macro distribution (top 20):');
  sorted.slice(0, 20).forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)}  ${k}`));
  console.log(`\nDone! Mapped ${Object.keys(mapping).length} clusters → ${sorted.length} macros`);
  console.log(`Output: ${OUT_MAP}`);
})();
