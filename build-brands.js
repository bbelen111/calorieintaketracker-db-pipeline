// FDC Branded -> curated brand catalog (cloud-only).
//
// Reads the FDC "Branded Food Products" CSV download (fdc-download/), applies
// brand curation (config/brands.js), and writes foodDatabase.branded.sqlite
// with a `foods` table mirroring the staple catalog + a `brand` column. The app
// bundle NEVER includes brands - they are seeded into the Supabase `foods`
// table (same table, brand set) and served by the search_foods RPC with
// brand-intent ranking.
//
// Need the data? Download "FoodData Central CSV (Branded Food Products)" from
//   https://fdc.nal.usda.gov/download-datasets.html
// and unzip into fdc-download/ keeping the FoodData_Central_branded_food_csv_*/
// folder. The raw dumps are large, so they are intentionally gitignored.
//
// Usage:
//   node build-brands.js            # dry-run: reports/brands.json only
//   node build-brands.js --replace  # write foodDatabase.branded.sqlite (backup first)
//   node build-brands.js --write    # write foodDatabase.branded.curated.sqlite only
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import initSqlJs from 'sql.js';
import { BRAND_CURATION } from './config/brands.js';

const PROJECT_ROOT = globalThis.process.cwd();
const FDC_DOWNLOAD_DIR = path.resolve(PROJECT_ROOT, 'fdc-download');
const BRANDED_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.branded.sqlite');
const HEADLESS_DB_PATH = path.resolve(
  PROJECT_ROOT,
  'foodDatabase.branded.curated.sqlite'
);
const REPORTS_DIR = path.resolve(PROJECT_ROOT, 'reports');

// Branded food_nutrient.csv uses the legacy nutrient-id scheme (1008 Energy,
// 1003 Protein, ...) but older dumps mix in survey-style numbers (208/203/...).
// Match both schemes defensively.
const NUTRIENT_KEY_BY_ID = {
  1008: 'calories',
  208: 'calories',
  1003: 'protein',
  203: 'protein',
  1005: 'carbs',
  205: 'carbs',
  1004: 'fats',
  204: 'fats',
  1079: 'fiber',
  291: 'fiber',
  1093: 'sodium',
  307: 'sodium',
  1258: 'saturated_fats',
  606: 'saturated_fats',
  2000: 'sugars',
  269: 'sugars',
};

const parseArgs = () => {
  const args = new Set(globalThis.process.argv.slice(2));
  return {
    dryRun: !(args.has('--replace') || args.has('--write')),
    replace: args.has('--replace'),
    write: args.has('--write'),
  };
};

// ---- CSV plumbing (mirrors build.js) ---------------------------------------

const parseCsvRows = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      if (row.length || field) rows.push(row.concat(field));
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (row.length || field) rows.push(row.concat(field));
  return rows;
};

const readCsvFile = async (filePath) => {
  const text = await fs.readFile(filePath, 'utf8');
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { header: [], rows: [] };
  return { header: rows[0], rows: rows.slice(1) };
};

const getColumnIndex = (header, name) => header.indexOf(name);

const getCsvValue = (row, index) => {
  if (index < 0 || index >= row.length) return null;
  const value = String(row[index] ?? '').trim();
  return value === '' ? null : value;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// ---- category best-effort (brands keep honest "uncategorized" when unknown) --

const guessCategory = (name) => {
  const lower = String(name ?? '').toLowerCase();
  if (
    /(supplement|protein powder|pre-workout|creatine|electrolyte|multivitamin|omega[- ]?3|vitamin)/.test(
      lower
    )
  ) {
    return 'supplements';
  }
  if (
    /(oil|butter|margarine|nuts?|almond|peanut|cashew|walnut|seed|chia|flax|mayonnaise)/.test(
      lower
    )
  ) {
    return 'fats';
  }
  if (
    /(vegetable|broccoli|spinach|kale|lettuce|salad|tomato|carrot|corn|peas|onion|garlic|potato|mushroom|avocado)/.test(
      lower
    )
  ) {
    return 'vegetables';
  }
  if (
    /(chicken|beef|pork|turkey|ham|bacon|sausage|hot dog|meat|fish|shrimp|salmon|tuna|egg|yogurt|cheese|milk|jerky|collagen|whey)/.test(
      lower
    )
  ) {
    return 'protein';
  }
  return 'carbs'; // branded products skew heavily to packaged/processed foods
};

const titleCaseAllCaps = (name) => {
  if (/[a-z]/.test(name)) {
    return name; // already has lowercase - leave FDC's casing alone
  }
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
};

// ---- portions ---------------------------------------------------------------

const roundGrams = (value) => {
  const parsed = toNumber(value);
  return parsed && parsed > 0 ? Math.round(parsed) : null;
};

const isGramUnit = (unit) => /^g(ram|rams)?$/i.test(String(unit || ''));

const buildPortions = ({ servingSize, servingUnit, householdServing }) => {
  const portions = [{ id: 'p_100g', label: '100g', grams: 100 }];
  const grams = roundGrams(servingSize);

  if (grams && isGramUnit(servingUnit)) {
    portions.push({ id: 'portion_1', label: `1 serving (${grams}g)`, grams });
  } else if (grams && householdServing) {
    portions.push({ id: 'portion_1', label: `1 serving (${grams}g)`, grams });
  }

  return portions;
};

// ---- data loading -----------------------------------------------------------

const findBrandedDir = async () => {
  let entries = [];
  try {
    entries = await fs.readdir(FDC_DOWNLOAD_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const dir = entries.find(
    (entry) =>
      entry.isDirectory() &&
      /^FoodData_Central_branded_food_csv_/i.test(entry.name)
  );
  return dir ? path.join(FDC_DOWNLOAD_DIR, dir.name) : null;
};

const loadBrandedRows = async (dir) => {
  const food = await readCsvFile(path.join(dir, 'food.csv'));
  const branded = await readCsvFile(path.join(dir, 'branded_food.csv'));
  const nutrients = await readCsvFile(path.join(dir, 'food_nutrient.csv'));

  const fc = getColumnIndex(food.header, 'fdc_id');
  const dc = getColumnIndex(food.header, 'description');
  const tc = getColumnIndex(food.header, 'data_type');
  if (fc < 0 || dc < 0 || tc < 0) {
    throw new Error('food.csv is missing expected columns (fdc_id/description/data_type).');
  }
  const foodsById = new Map();
  for (const row of food.rows) {
    if (String(getCsvValue(row, tc) || '').toLowerCase() !== 'branded') continue;
    const fdcId = getCsvValue(row, fc);
    if (!fdcId) continue;
    foodsById.set(fdcId, { fdcId, name: getCsvValue(row, dc) || '' });
  }

  const fdcNc = getColumnIndex(nutrients.header, 'fdc_id');
  const nc = getColumnIndex(nutrients.header, 'nutrient_id');
  const ac = getColumnIndex(nutrients.header, 'amount');
  const nutrientsByFood = new Map();
  if (fdcNc >= 0 && nc >= 0 && ac >= 0) {
    for (const row of nutrients.rows) {
      const fdcId = getCsvValue(row, fdcNc);
      const key = NUTRIENT_KEY_BY_ID[Number(getCsvValue(row, nc))];
      const amount = toNumber(getCsvValue(row, ac));
      if (!fdcId || !key || amount === null) continue;
      let rec = nutrientsByFood.get(fdcId);
      if (!rec) {
        rec = {};
        nutrientsByFood.set(fdcId, rec);
      }
      rec[key] = amount;
    }
  }

  const bc = getColumnIndex(branded.header, 'fdc_id');
  const bo = getColumnIndex(branded.header, 'brand_owner');
  const bn = getColumnIndex(branded.header, 'brand_name');
  const ss = getColumnIndex(branded.header, 'serving_size');
  const su = getColumnIndex(branded.header, 'serving_size_unit');
  const hs = getColumnIndex(branded.header, 'household_serving_full_text');
  if (bc < 0 || bo < 0) {
    throw new Error('branded_food.csv is missing expected columns.');
  }
  const metaByFood = new Map();
  for (const row of branded.rows) {
    const fdcId = getCsvValue(row, bc);
    if (!fdcId) continue;
    metaByFood.set(fdcId, {
      brandOwner: getCsvValue(row, bo) || null,
      brandName: getCsvValue(row, bn) || null,
      servingSize: ss >= 0 ? getCsvValue(row, ss) : null,
      servingUnit: su >= 0 ? getCsvValue(row, su) : null,
      householdServing: hs >= 0 ? getCsvValue(row, hs) : null,
    });
  }

  return { foodsById, metaByFood, nutrientsByFood };
};

// ---- curation + assembly ----------------------------------------------------

const meetsExcludePattern = (name) =>
  BRAND_CURATION.excludePatterns.some((pattern) => pattern.test(name));

const assembleRows = ({ foodsById, metaByFood, nutrientsByFood }) => {
  const kept = [];
  const dropped = {};
  const reasons = (key) => {
    dropped[key] = (dropped[key] || 0) + 1;
  };

  for (const food of foodsById.values()) {
    const meta = metaByFood.get(food.fdcId) || {};
    const nutrients = nutrientsByFood.get(food.fdcId) || {};
    const name = titleCaseAllCaps(food.name || '').trim();
    const category = guessCategory(name);
    const brand =
      String(meta.brandOwner || meta.brandName || '').trim() || null;

    const ownerLower = String(brand || '').toLowerCase();
    const ownerExcluded =
      BRAND_CURATION.excludeOwners.size > 0 &&
      [...BRAND_CURATION.excludeOwners].some((owner) =>
        ownerLower.includes(owner.toLowerCase())
      );
    if (ownerExcluded) {
      reasons('exclude_owner');
      continue;
    }

    if (BRAND_CURATION.requireName && !name) {
      reasons('no_name');
      continue;
    }
    if (meetsExcludePattern(name)) {
      reasons('exclude_pattern');
      continue;
    }

    const calories = nutrients.calories ?? null;
    if (BRAND_CURATION.requireCalories && (calories === null || calories <= 0)) {
      reasons('no_calories');
      continue;
    }

    kept.push({
      id: `usda_${food.fdcId}`,
      name,
      brand,
      category,
      subcategory: null,
      calories: calories ?? 0,
      protein: nutrients.protein ?? 0,
      carbs: nutrients.carbs ?? 0,
      fats: nutrients.fats ?? 0,
      fiber: nutrients.fiber ?? null,
      sodium: nutrients.sodium ?? null,
      saturated_fats: nutrients.saturated_fats ?? null,
      sugars: nutrients.sugars ?? null,
      portions: JSON.stringify(
        buildPortions({
          servingSize: meta.servingSize,
          servingUnit: meta.servingUnit,
          householdServing: meta.householdServing,
        })
      ),
    });
  }

  return { kept, dropped };
};

// ---- sqlite output ----------------------------------------------------------

const writeBrandedDb = async (rows, targetPath) => {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      category TEXT,
      subcategory TEXT,
      calories REAL,
      protein REAL,
      carbs REAL,
      fats REAL,
      fiber REAL,
      sodium REAL,
      saturated_fats REAL,
      sugars REAL,
      portions TEXT
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO foods
      (id, name, brand, category, subcategory, calories, protein, carbs, fats,
       fiber, sodium, saturated_fats, sugars, portions)
    VALUES
      (:id, :name, :brand, :category, :subcategory, :calories, :protein, :carbs, :fats,
       :fiber, :sodium, :saturated_fats, :sugars, :portions)
  `);

  for (const row of rows) {
    stmt.run({
      ':id': row.id,
      ':name': row.name,
      ':brand': row.brand,
      ':category': row.category,
      ':subcategory': row.subcategory,
      ':calories': row.calories,
      ':protein': row.protein,
      ':carbs': row.carbs,
      ':fats': row.fats,
      ':fiber': row.fiber,
      ':sodium': row.sodium,
      ':saturated_fats': row.saturated_fats,
      ':sugars': row.sugars,
      ':portions': row.portions,
    });
  }
  stmt.free();

  const data = db.export();
  db.close();
  await fs.writeFile(targetPath, Buffer.from(data));
};

const main = async () => {
  const { dryRun, replace, write: writeHeadless } = parseArgs();

  const brandedDir = await findBrandedDir();
  if (!brandedDir) {
    console.error(
      `build-brands: FDC Branded download not found under ${FDC_DOWNLOAD_DIR}\n` +
        'Download "FoodData Central CSV (Branded Food Products)" from\n' +
        '  https://fdc.nal.usda.gov/download-datasets.html\n' +
        'and unzip it into fdc-download/ keeping the FoodData_Central_branded_food_csv_* folder.'
    );
    process.exit(1);
  }

  const joined = await loadBrandedRows(brandedDir);
  const { kept, dropped } = assembleRows(joined);
  const capped = BRAND_CURATION.maxRows ? kept.slice(0, BRAND_CURATION.maxRows) : kept;

  const report = {
    sourceDir: brandedDir,
    inputFoods: joined.foodsById.size,
    keptRows: kept.length,
    writtenRows: capped.length,
    dropped,
    categoryCounts: capped.reduce((acc, row) => {
      acc[row.category] = (acc[row.category] || 0) + 1;
      return acc;
    }, {}),
    dryRun,
  };

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(REPORTS_DIR, 'brands.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(`build-brands: report -> reports/brands.json`);
  console.log(
    `build-brands: ${kept.length} kept (capped ${capped.length}) of ${report.inputFoods} branded foods`
  );
  Object.entries(report.categoryCounts).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });

  if (dryRun) {
    console.log('build-brands: --dry-run — no database written.');
    return;
  }

  if (replace) {
    try {
      await fs.copyFile(BRANDED_DB_PATH, `${BRANDED_DB_PATH}.backup`);
    } catch {
      // no previous artifact
    }
    await writeBrandedDb(capped, BRANDED_DB_PATH);
    console.log(`build-brands: wrote ${capped.length} rows -> ${BRANDED_DB_PATH}`);
  }

  if (writeHeadless) {
    await writeBrandedDb(capped, HEADLESS_DB_PATH);
    console.log(`build-brands: wrote ${capped.length} rows -> ${HEADLESS_DB_PATH}`);
  }
};

main().catch((error) => {
  console.error(`build-brands: fatal: ${error.message}`);
  process.exit(1);
});