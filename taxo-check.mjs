#!/usr/bin/env node
/**
 * Taxonomy + curation consistency validator for the food DB pipeline.
 *
 *   node taxo-check.mjs                    # validate config files only
 *   node taxo-check.mjs --db <sqlite>       # also validate a built catalog DB
 *
 * Exit code is 1 when any FATAL violation is found (warnings are non-fatal).
 * Run this after every change to config/curation.js or config/taxonomy.js,
 * and before shipping a built catalog (see README.md).
 */
import fs from 'node:fs/promises';
import {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  CANONICAL_SUBCATEGORY_BY_CATEGORY,
  SUBCATEGORY_ALIASES,
} from './config/taxonomy.js';
import { CURATION } from './config/curation.js';

const errors = [];
const warnings = [];

const normalizeCategory = (category) => {
  const key = String(category ?? '')
    .trim()
    .toLowerCase();
  const alias = CATEGORY_ALIASES[key];
  return alias ?? (CANONICAL_CATEGORIES.has(key) ? key : null);
};

// ---- Config validation ------------------------------------------------

const assertConfig = () => {
  for (const manual of CURATION.manualFoods || []) {
    if (!manual.key) {
      errors.push("manualFoods entry is missing 'key'");
      continue;
    }
    const cat = normalizeCategory(manual.category);
    if (!cat) {
      errors.push(
        `manualFoods '${manual.key}': category '${manual.category}' is not canonical`
      );
    } else {
      const subs = CANONICAL_SUBCATEGORY_BY_CATEGORY[cat];
      if (!subs?.has(manual.subcategory)) {
        errors.push(
          `manualFoods '${manual.key}': subcategory '${manual.subcategory}' is not canonical for '${cat}'`
        );
      }
    }
    if (!manual.basedOnFdcId) {
      warnings.push(
        `manualFoods '${manual.key}': no basedOnFdcId donor — explicit nutrition values must be supplied and reviewed`
      );
    }
  }

  for (const id of CURATION.includeFdcIds || []) {
    if (!/^\d+$/.test(String(id))) {
      errors.push(`includeFdcIds contains a non-digit id: '${id}'`);
    }
  }
  for (const id of CURATION.excludeFdcIds || []) {
    if (!/^\d+$/.test(String(id))) {
      errors.push(`excludeFdcIds contains a non-digit id: '${id}'`);
    }
  }

  for (const sub of CURATION.collapseEnabledSubcategories || []) {
    const isCanonical = Object.values(CANONICAL_SUBCATEGORY_BY_CATEGORY).some(
      (set) => set.has(sub)
    );
    if (!isCanonical) {
      errors.push(
        `collapseEnabledSubcategories '${sub}' is not a canonical subcategory`
      );
    }
  }
};

// ---- DB validation -----------------------------------------------------

const assertDb = async (dbPath, branded) => {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const buffer = await fs.readFile(dbPath);
  const db = new SQL.Database(new Uint8Array(buffer));
  const run = (q) => db.exec(q)?.[0]?.values ?? [];

  const integrity = run('PRAGMA integrity_check')?.[0]?.[0];
  if (integrity !== 'ok') errors.push(`DB integrity check failed: ${integrity}`);

  // Duplicate guard: staple catalogs dedupe on (name, category); the branded
  // catalog legitimately repeats product names across brands, so it keys on
  // (name, category, brand) instead.
  const groupCols = branded
    ? 'LOWER(name), category, LOWER(brand)'
    : 'LOWER(name), category';
  const dupeCount =
    run(
      `SELECT COUNT(*) FROM (SELECT ${groupCols}, COUNT(*) c FROM foods GROUP BY ${groupCols} HAVING c > 1)`
    )[0]?.[0] ?? 0;
  if (dupeCount > 0) {
    errors.push(
      `${dupeCount} duplicate (${branded ? 'name, category, brand' : 'name, category'}) rows in ${dbPath}`
    );
  }

  const categories = run('SELECT DISTINCT category FROM foods');
  let pairCount = 0;
  for (const [cat] of categories) {
    if (!CANONICAL_CATEGORIES.has(String(cat)) && String(cat) !== 'uncategorized') {
      errors.push(`DB category '${cat}' is not canonical`);
    }
  }

  const pairs = run('SELECT DISTINCT category, subcategory FROM foods');
  for (const [cat, sub] of pairs) {
    if (!sub) continue; // null subcategory is legal (e.g. catch-all food)
    pairCount += 1;
    const resolved = normalizeCategory(cat);
    if (!resolved) continue; // category already flagged above
    const canonical = CANONICAL_SUBCATEGORY_BY_CATEGORY[resolved]?.has(String(sub));
    if (canonical) continue;
    const aliasTarget = SUBCATEGORY_ALIASES[String(sub).toLowerCase().trim()];
    if (aliasTarget !== undefined) {
      warnings.push(
        `DB subcategory '${sub}' under '${cat}' is an alias (resolves to '${aliasTarget}') — should be normalized`
      );
      continue;
    }
    errors.push(`orphan subcategory '${sub}' under category '${cat}'`);
  }

  console.log(`Validated ${pairCount} non-null (category, subcategory) pairs in ${dbPath}`);
  db.close();
};

// ---- Entry ---------------------------------------------------------------

const dbArgIndex = globalThis.process.argv.indexOf('--db');
const dbPath =
  dbArgIndex > -1 ? globalThis.process.argv[dbArgIndex + 1] : null;
const branded = globalThis.process.argv.includes('--branded');

assertConfig();
if (dbPath) {
  try {
    await assertDb(dbPath, branded);
  } catch (error) {
    errors.push(`failed to validate DB '${dbPath}': ${error.message}`);
  }
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);
console.log(
  errors.length === 0
    ? 'taxo: PASS (no violations)'
    : `taxo: FAIL (${errors.length} violation(s) — see FAIL lines)`
);
globalThis.process.exitCode = errors.length === 0 ? 0 : 1;