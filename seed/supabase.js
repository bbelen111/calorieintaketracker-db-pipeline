#!/usr/bin/env node
/**
 * Seed a Supabase `foods` table from a curated catalog SQLite file.
 *
 *   node seed/supabase.js                     # uses ./foodDatabase.sqlite (repo build output)
 *   node seed/supabase.js --db <path>         # seed any catalog (e.g. the consumer app's DB)
 *   node seed/supabase.js --dry-run           # report the batch plan without calling Supabase
 *   node seed/supabase.js --batch 1000        # set batch size (default 500)
 *
 * Credentials come from the environment / a local `.env`:
 *   SUPABASE_URL              e.g. https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service-role key (server-side only — never ship to a client)
 *
 * The upsert is idempotent (ON CONFLICT (id)) so re-running is safe and can be
 * used to sync updates from a rebuilt catalog. Requires the Postgres `foods`
 * table — apply the idempotent DDL in ./supabase.sql first (table, indexes,
 * RLS with public read / service-role write).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const PROJECT_ROOT = process.cwd();
const args = process.argv.slice(2);
const flagValue = (name) => {
  const idx = args.indexOf(name);
  return idx > -1 ? args[idx + 1] : undefined;
};
const dbPath = flagValue('--db') ?? path.resolve(PROJECT_ROOT, 'foodDatabase.sqlite');
const batchSize = Number.parseInt(flagValue('--batch') ?? '500', 10);
const dryRun = args.includes('--dry-run');

// --- minimal .env loader (no extra dependency; Node 22 loadEnvFile is optional) ---
const loadEnv = async () => {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile();
      return;
    } catch {
      // .env missing — env vars may be set in the shell instead.
    }
  }
  try {
    const text = await fs.readFile(path.resolve(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // no .env file — rely on shell env
  }
};

// --- catalog reader (sql.js) ---
const readCatalog = async (sqlitePath, SQL) => {
  const buffer = await fs.readFile(sqlitePath);
  const db = new SQL.Database(new Uint8Array(buffer));
  const cols = db.exec('PRAGMA table_info(foods)')[0].values.map((r) => r[1]);
  const values = db.exec('SELECT * FROM foods')[0].values;
  db.close();
  return values.map((row) => {
    const rec = {};
    cols.forEach((c, i) => {
      rec[c] = row[i] === null || row[i] === undefined ? null : row[i];
    });
    if (rec.portions !== null && typeof rec.portions !== 'string') {
      rec.portions = JSON.stringify(rec.portions);
    }
    return rec;
  });
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Transient network failures (fetch failed / 5xx) are retried with backoff so
// a long seed can survive a blip instead of failing half-way. The upsert stays
// idempotent (ON CONFLICT (id)), so interrupted runs are safe to re-run.
const upsertWithRetry = async (supabase, batch, attempts = 3) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { error } = await supabase
      .from('foods')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
    if (!error) return { error: null };
    lastError = error;
    if (attempt < attempts) {
      const delay = 1500 * attempt;
      console.log(`seed: batch attempt ${attempt} failed (${error.message}) — retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { error: lastError };
};

const main = async () => {
  await loadEnv();
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!dryRun && (!url || !serviceKey)) {
    console.error(
      'seed: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use an actual .env — never commit it, see .env.example).'
    );
    process.exit(1);
  }

  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  console.log(`seed: reading catalog ${dbPath}`);
  const rows = await readCatalog(dbPath, SQL);
  console.log(`seed: ${rows.length} food rows, batch size ${batchSize} (${Math.ceil(rows.length / batchSize)} batches)`);

  if (dryRun) {
    console.log('seed: --dry-run — no rows were written to Supabase.');
    return;
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  let errorCount = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await upsertWithRetry(supabase, batch);
    if (error) {
      errorCount += 1;
      console.error(`seed: batch ${i / batchSize + 1} failed after retries: ${error.message}`);
    } else {
      console.log(
        `seed: batch ${i / batchSize + 1}/${Math.ceil(rows.length / batchSize)} upserted (rows ${i + 1}-${i + batch.length} of ${rows.length})`
      );
    }
  }

  if (errorCount > 0) {
    console.error(`seed: finished with ${errorCount} failed batch(es).`);
    process.exit(1);
  }
  console.log('seed: complete — foods table synced. Verify RLS/read policies before exposing.');
};

main().catch((error) => {
  console.error(`seed: fatal: ${error.message}`);
  process.exit(1);
});