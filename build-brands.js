// FDC Branded -> curated brand catalog (cloud-only).
//
// Reads the FDC "Branded Food Products" CSV download (fdc-download/ — an NTFS
// junction to a big external drive is fine), applies brand curation
// (config/brands.js), and writes foodDatabase.branded.sqlite with a `foods`
// table mirroring the staple catalog + a `brand` column. The app bundle NEVER
// includes brands — they are seeded into the Supabase `foods` table (same
// table, brand set) and served by the search_foods RPC with brand-intent
// ranking.
//
// Design notes:
//   * Big CSVs are STREAMED (food_nutrient.csv alone is ~1.4GB), never slurped.
//   * The nutrient-id scheme is verified against the release's nutrient.csv
//     before any number is trusted (1008=Energy, 1002=Nitrogen — never energy).
//   * Only "verified-complete" rows ship (see config/brands.js): all 4 macros
//     present and a serving size convertible to grams.
//   * Values are label/per-100g from FDC; we never rescale to serving size.
//
// Usage:
//   node build-brands.js            # dry-run: reports/brands.json only
//   node build-brands.js --replace  # write foodDatabase.branded.sqlite (backup first)
//   node build-brands.js --write    # write foodDatabase.branded.curated.sqlite only
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import readline from 'node:readline';
import { BRAND_CURATION, SERVING_UNIT_TO_GRAMS, BRAND_CLASSIFY_RULES } from './config/brands.js';
import { normalizeNutrients } from './config/nutrients.js';
import { CANONICAL_SUBCATEGORY_BY_CATEGORY } from './config/taxonomy.js';

const PROJECT_ROOT = globalThis.process.cwd();
const FDC_DOWNLOAD_DIR = path.resolve(PROJECT_ROOT, 'fdc-download');
const BRANDED_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.branded.sqlite');
const HEADLESS_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.branded.curated.sqlite');
const STAPLES_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.sqlite');
const REPORTS_DIR = path.resolve(PROJECT_ROOT, 'reports');

// ---- Nutrient-id scheme (legacy ids + survey-number fallbacks) ---------------
// Branded food_nutrient.csv uses the legacy internal ids (1008 Energy, ...);
// some releases mix in survey-style nutrient numbers (208/203/...). 1002 is
// NITROGEN — never aliased to energy.
const NUTRIENT_KEY_BY_ID = {
  1008: 'calories', 208: 'calories',
  1003: 'protein', 203: 'protein',
  1005: 'carbs', 205: 'carbs',
  1004: 'fats', 204: 'fats',
  1079: 'fiber', 291: 'fiber',
  1093: 'sodium', 307: 'sodium',
  1258: 'saturated_fats', 606: 'saturated_fats',
  2000: 'sugars', 269: 'sugars',
};
// Lower wins when the same field is reported twice (prefer the legacy id).
const NUTRIENT_ID_PRIORITY = {
  1008: 0, 1003: 0, 1005: 0, 1004: 0, 1079: 0, 1093: 0, 1258: 0, 2000: 0,
  208: 1, 203: 1, 205: 1, 204: 1, 291: 1, 307: 1, 606: 1, 269: 1,
};
// Expected nutrient_nbr per nutrient_id for the scheme gate (verified against
// this release: 1008->208, 1003->203, 1004->204, 1005->205, 1079->291,
// 1093->307, 1258->606, 2000->269).
const EXPECTED_NUTRIENT_NBR = {
  1008: '208', 1003: '203', 1004: '204', 1005: '205',
  1079: '291', 1093: '307', 1258: '606', 2000: '269',
};

const parseArgs = () => {
  const args = new Set(globalThis.process.argv.slice(2));
  return {
    dryRun: !(args.has('--replace') || args.has('--write')),
    replace: args.has('--replace'),
    writeHeadless: args.has('--write'),
  };
};

// ---- tiny helpers ------------------------------------------------------------

const toNumber = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);

const getColumnIndex = (header, name) => header.indexOf(name);

const getCsvValue = (row, index) => {
  if (index < 0 || index >= row.length) return null;
  const value = String(row[index] ?? '').trim();
  return value === '' ? null : value;
};

// ---- streaming CSV plumbing --------------------------------------------------

const parseCsvLine = (line) => {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
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
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
};

// A quoted field containing a real newline keeps an odd number of " escapes on
// a single line; the streamed row only gets emitted once the section is even.
const isRowComplete = (row) => {
  let quoteCount = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '"') {
      if (row[i + 1] === '"') {
        i += 1;
      } else {
        quoteCount += 1;
      }
    }
  }
  return quoteCount % 2 === 0;
};

const streamCsvRows = async (filePath, onRow) => {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let buffer = '';
  for await (const line of rl) {
    buffer = buffer.length ? `${buffer}\n${line}` : line;
    if (isRowComplete(buffer)) {
      onRow(parseCsvLine(buffer));
      buffer = '';
    }
  }
  if (buffer.length) onRow(parseCsvLine(buffer));
};

const readCsvHeader = async (filePath) => {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) return parseCsvLine(line);
  }
  return [];
};

// ---- source discovery (junction-aware) --------------------------------------
// NTFS junctions report as SYMLINKS via readdir withFileTypes, so plain
// isDirectory() would silently skip one; resolve with fs.stat (follows links).
const findBrandedDir = async () => {
  let entries = [];
  try {
    entries = await fs.readdir(FDC_DOWNLOAD_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const match = entries.find(
    (entry) =>
      /^FoodData_Central_branded_food_csv_/i.test(entry.name) &&
      (entry.isDirectory() || entry.isSymbolicLink())
  );
  if (!match) return null;
  const full = path.join(FDC_DOWNLOAD_DIR, match.name);
  try {
    const stats = await fs.stat(full);
    return stats.isDirectory() ? full : null;
  } catch {
    return null;
  }
};

// ---- nutrient-id scheme gate -------------------------------------------------

const loadNutrientScheme = async (dir) => {
  const nutrientCsvPath = path.join(dir, 'nutrient.csv');
  const nutrientById = new Map();
  let hasNutrientFile = true;
  try {
    await fs.access(nutrientCsvPath);
  } catch {
    hasNutrientFile = false;
  }

  if (hasNutrientFile) {
    const header = await readCsvHeader(nutrientCsvPath);
    const idIdx = getColumnIndex(header, 'id');
    const nbrIdx = getColumnIndex(header, 'nutrient_nbr');
    const nameIdx = getColumnIndex(header, 'name');
    if (idIdx >= 0 && nbrIdx >= 0) {
      const rows = [];
      await streamCsvRows(nutrientCsvPath, (row) => {
        const id = getCsvValue(row, idIdx);
        if (!id || !/^\d+$/.test(id)) return;
        rows.push({
          id: Number(id),
          nbr: getCsvValue(row, nbrIdx),
          name: getCsvValue(row, nameIdx),
        });
      });
      for (const rec of rows) nutrientById.set(rec.id, rec);
    }
  }

  const mismatches = [];
  for (const [id, expectedNbr] of Object.entries(EXPECTED_NUTRIENT_NBR)) {
    const rec = nutrientById.get(Number(id));
    if (!rec) {
      mismatches.push(`nutrient.csv is missing nutrient_id ${id}`);
    } else if (String(rec.nbr) !== String(expectedNbr)) {
      mismatches.push(
        `nutrient_id ${id} (${rec.name}) has nutrient_nbr ${rec.nbr}, expected ${expectedNbr}`
      );
    }
  }
  const nitrogen = nutrientById.get(1002);
  if (nitrogen && !/nitrogen/i.test(nitrogen.name || '')) {
    mismatches.push('nutrient_id 1002 should be Nitrogen — do not trust mappings');
  }

  return {
    nutrientById,
    hasNutrientFile,
    verified: mismatches.length === 0,
    mismatches,
  };
};

// ---- data loading (streamed, only branded fdc_ids retained) ------------------

const loadBrandedData = async (dir) => {
  const foodsById = new Map();
  const foodPath = path.join(dir, 'food.csv');
  const foodHeader = await readCsvHeader(foodPath);
  const fc = getColumnIndex(foodHeader, 'fdc_id');
  const dc = getColumnIndex(foodHeader, 'description');
  const tc = getColumnIndex(foodHeader, 'data_type');
  if (fc < 0 || dc < 0 || tc < 0) {
    throw new Error('food.csv is missing expected columns (fdc_id/description/data_type).');
  }
  let foodRows = 0;
  await streamCsvRows(foodPath, (row) => {
    foodRows += 1;
    const dataType = String(getCsvValue(row, tc) || '').toLowerCase();
    if (dataType !== 'branded' && dataType !== 'branded_food') return;
    const fdcId = getCsvValue(row, fc);
    if (!fdcId) return;
    foodsById.set(fdcId, { fdcId, name: getCsvValue(row, dc) || '' });
  });

  const nutrientsByFood = new Map();
  const nutrientPath = path.join(dir, 'food_nutrient.csv');
  const nh = await readCsvHeader(nutrientPath);
  const fdcNc = getColumnIndex(nh, 'fdc_id');
  const ncIdx = getColumnIndex(nh, 'nutrient_id');
  const amountIdx = getColumnIndex(nh, 'amount');
  const medianIdx = getColumnIndex(nh, 'median');
  let nutrientRows = 0;
  if (fdcNc >= 0 && ncIdx >= 0 && amountIdx >= 0) {
    await streamCsvRows(nutrientPath, (row) => {
      nutrientRows += 1;
      const fdcId = getCsvValue(row, fdcNc);
      if (!fdcId || !foodsById.has(fdcId)) return;
      const nutrientId = Number(getCsvValue(row, ncIdx));
      const key = NUTRIENT_KEY_BY_ID[nutrientId];
      if (!key) return;
      // median preferred when present (multi-sample convention), else amount.
      let raw = getCsvValue(row, medianIdx);
      if (raw == null) raw = getCsvValue(row, amountIdx);
      const amount = toNumber(raw);
      if (amount === null || amount < 0) return;
      let rec = nutrientsByFood.get(fdcId);
      if (!rec) {
        rec = {};
        nutrientsByFood.set(fdcId, rec);
      }
      const priority = NUTRIENT_ID_PRIORITY[nutrientId] ?? 1;
      const existingId = rec[`${key}ID`] ?? -1;
      const existingPriority =
        existingId === -1 ? Infinity : (NUTRIENT_ID_PRIORITY[existingId] ?? 1);
      if (priority < existingPriority) {
        rec[key] = amount;
        rec[`${key}ID`] = nutrientId;
      }
    });
  }

  const metaByFood = new Map();
  const brandedPath = path.join(dir, 'branded_food.csv');
  const bh = await readCsvHeader(brandedPath);
  const bfdc = getColumnIndex(bh, 'fdc_id');
  const bOwner = getColumnIndex(bh, 'brand_owner');
  const bName = getColumnIndex(bh, 'brand_name');
  const bSub = getColumnIndex(bh, 'subbrand_name');
  const bGtin = getColumnIndex(bh, 'gtin_upc');
  const bSize = getColumnIndex(bh, 'serving_size');
  const bUnit = getColumnIndex(bh, 'serving_size_unit');
  const bHouse = getColumnIndex(bh, 'household_serving_fulltext');
  const bCat = getColumnIndex(bh, 'branded_food_category');
  const bPrep = getColumnIndex(bh, 'preparation_state_code');
  const bDisc = getColumnIndex(bh, 'discontinued_date');
  const bCountry = getColumnIndex(bh, 'market_country');
  if (bfdc < 0 || bOwner < 0) {
    throw new Error('branded_food.csv is missing expected columns.');
  }
  await streamCsvRows(brandedPath, (row) => {
    const fdcId = getCsvValue(row, bfdc);
    if (!fdcId || !foodsById.has(fdcId)) return;
    metaByFood.set(fdcId, {
      brandOwner: getCsvValue(row, bOwner) || null,
      brandName: getCsvValue(row, bName) || null,
      subbrandName: getCsvValue(row, bSub) || null,
      gtinUpc: getCsvValue(row, bGtin) || null,
      servingSize: bSize >= 0 ? getCsvValue(row, bSize) : null,
      servingUnit: bUnit >= 0 ? getCsvValue(row, bUnit) : null,
      householdServing: bHouse >= 0 ? getCsvValue(row, bHouse) : null,
      brandedFoodCategory: bCat >= 0 ? getCsvValue(row, bCat) : null,
      preparationState: bPrep >= 0 ? getCsvValue(row, bPrep) : null,
      discontinuedDate: bDisc >= 0 ? getCsvValue(row, bDisc) : null,
      marketCountry: bCountry >= 0 ? getCsvValue(row, bCountry) : null,
    });
  });

  return {
    foodsById,
    nutrientsByFood,
    metaByFood,
    counts: { foodRows, nutrientRows },
  };
};

// ---- name + brand cleanup ---------------------------------------------------

const titleCaseAllCaps = (name) => {
  if (/[a-z]/.test(name)) return name; // already has lowercase - leave FDC's casing alone
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
};

const cleanName = (name) =>
  String(name || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// FDC repeats the brand owner at the start of the description ("HORMEL HORMEL
// Pepperoni"); strip a leading brand (full text, then first word) + punctuation.
const stripBrandPrefix = (name, brand) => {
  const text = cleanName(name);
  const b = cleanName(brand);
  if (!text || !b || text.length <= b.length) return text;
  const candidates = [b, b.split(/\s+/)[0] || ''];
  for (const prefix of candidates) {
    if (prefix.length < 4 || text.length <= prefix.length) continue;
    if (text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
      const rest = text
        .slice(prefix.length)
        .replace(/^[\s,;:.-]+/, '')
        .replace(/^'s\s+/i, '')
        .replace(/^s\s+/i, '')
        .trim();
      if (rest) return rest;
    }
  }
  return text;
};

const meetsExcludePattern = (name) =>
  BRAND_CURATION.excludePatterns.some((pattern) => pattern.test(name));

// ---- classification (config/taxonomy.js canonical pairs) --------------------

const assertClassifyRulesCanonical = () => {
  for (const rule of BRAND_CLASSIFY_RULES) {
    const subs = CANONICAL_SUBCATEGORY_BY_CATEGORY[rule.category];
    if (!subs || !subs.has(rule.subcategory)) {
      throw new Error(
        `BRAND_CLASSIFY_RULES: category '${rule.category}' / subcategory '${rule.subcategory}' is not canonical (fix config/taxonomy.js or the rule)`
      );
    }
  }
};

const classifyBrand = (name) => {
  const lower = name.toLowerCase();
  for (const rule of BRAND_CLASSIFY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(lower))) {
      return { category: rule.category, subcategory: rule.subcategory ?? null };
    }
  }
  return { category: BRAND_CURATION.fallbackCategory, subcategory: null };
};

// ---- portions ----------------------------------------------------------------

// Normalizes a unit string to a SERVING_UNIT_TO_GRAMS key (plural-tolerant).
const resolveUnitFactor = (rawUnit) => {
  let u = String(rawUnit || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, ' ');
  u = u.replace(/^fl ozs?$/, 'fl oz').replace(/^fluid ounces?$/, 'fluid ounce');
  if (Object.prototype.hasOwnProperty.call(SERVING_UNIT_TO_GRAMS, u)) {
    return SERVING_UNIT_TO_GRAMS[u];
  }
  if (u.endsWith('s') && Object.prototype.hasOwnProperty.call(SERVING_UNIT_TO_GRAMS, u.slice(0, -1))) {
    return SERVING_UNIT_TO_GRAMS[u.slice(0, -1)];
  }
  return null;
};

const normalizeFraction = (value) => {
  const parts = String(value).split('/');
  if (parts.length === 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p.trim()))) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den > 0) return num / den;
  }
  return toNumber(value);
};

// Returns positive gram-equivalent for a serving or null when not convertible.
const convertServingToGrams = ({ servingSize, servingUnit, householdServing }) => {
  const size = toNumber(servingSize);
  const unit = String(servingUnit || '').trim().toLowerCase();
  if (size != null && size > 0 && unit) {
    const factor = resolveUnitFactor(unit);
    if (factor != null) return Math.round(size * factor);
  }

  const house = String(householdServing || '').trim();
  if (house && /\d/.test(house)) {
    // "(N g)" embedded grams — the most trustworthy household form.
    let m = /\((\d+(?:\.\d+)?)\s*(g|gram|grams)\b/i.exec(house);
    if (m) return Math.round(Number(m[1]));
    // embedded "(N ml)" / "(N oz)" volume.
    m = /\((\d+(?:\.\d+)?)\s*(ml|milliliters?|oz|fl[\s-]?ozs?|fluid ounce)\b/i.exec(house);
    if (m) {
      const factor = resolveUnitFactor(m[2]);
      if (factor != null) return Math.round(Number(m[1]) * factor);
    }
    // "<amount> <unit>" incl. fractions ("1/2 cup") — well-defined units only.
    m = /(\d+(?:\.\d+)?|\d+\/\d+)\s*([a-z]+(?:[\s-][a-z]+)?)/i.exec(house);
    if (m) {
      const amount = normalizeFraction(m[1]);
      const factor = resolveUnitFactor(m[2]);
      if (amount != null && amount > 0 && factor != null) {
        return Math.round(amount * factor);
      }
    }
  }
  return null;
};

const cleanHouseholdText = (house) => {
  const t = String(house || '').trim();
  if (!t || !/\d/.test(t)) return null;
  if (/^(?:amount per serving|per\s*\d*\s*(?:container|can|serving|package|pack|bottle|bag|box|jar)|serves?\s*\d|makes\s*\d)/i.test(t)) {
    return null;
  }
  return t;
};

const buildPortions = (grams, houseClean) => {
  const portions = [{ id: 'p_100g', label: '100g', grams: 100 }];
  if (grams && grams > 0) {
    let label;
    if (houseClean) {
      label = /\(\s*\d+(?:\.\d+)?\s*g\b/i.test(houseClean)
        ? houseClean
        : `${houseClean} (${grams}g)`;
    } else {
      label = `1 serving (${grams}g)`;
    }
    portions.push({ id: 'portion_1', label, grams });
  }
  return JSON.stringify(portions);
};

// ---- assembly (per-food verified-complete gate) ------------------------------

const assembleCandidates = ({ foodsById, nutrientsByFood, metaByFood }) => {
  const b = BRAND_CURATION;
  const candidates = [];
  const dropped = {};
  const warnings = { calorieGap: 0, nutrientClamps: {} };
  const reason = (key) => {
    dropped[key] = (dropped[key] || 0) + 1;
  };

  for (const food of foodsById.values()) {
    const meta = metaByFood.get(food.fdcId) || {};
    if (meta.discontinuedDate) {
      reason('discontinued');
      continue;
    }

    const brand = String(meta.brandOwner || meta.brandName || '').trim() || null;
    if (b.requireBrand && !brand) {
      reason('no_brand');
      continue;
    }
    const ownerLower = String(brand || '').toLowerCase();
    if (
      b.excludeOwners.size > 0 &&
      [...b.excludeOwners].some((owner) => ownerLower.includes(owner.toLowerCase()))
    ) {
      reason('exclude_owner');
      continue;
    }

    const nameRaw = cleanName(titleCaseAllCaps(food.name));
    let name = stripBrandPrefix(nameRaw, brand);
    if (!name) name = nameRaw;
    if (b.requireName && !name) {
      reason('no_name');
      continue;
    }

    const forceKeep =
      b.includeOwners.size > 0 &&
      brand &&
      [...b.includeOwners].some((owner) => ownerLower.includes(owner.toLowerCase()));
    if (!forceKeep && meetsExcludePattern(name)) {
      reason('exclude_pattern');
      continue;
    }

    const nutrients = nutrientsByFood.get(food.fdcId) || {};
    const calories = toNumber(nutrients.calories);
    const protein = toNumber(nutrients.protein);
    const carbs = toNumber(nutrients.carbs);
    const fats = toNumber(nutrients.fats);

    if (b.requireCompleteMacros) {
      if (calories === null || calories <= 0) {
        reason('missing_calories');
        continue;
      }
      if (protein === null || carbs === null || fats === null) {
        reason('missing_macro');
        continue;
      }
    } else if (calories == null || calories <= 0) {
      reason('missing_calories');
      continue;
    }

    if (calories > b.macroBounds.calories.max) {
      reason('calorie_outlier');
      continue;
    }
    if (
      [protein, carbs, fats].some(
        (v) => v == null || v < b.macroBounds.grams.min || v > b.macroBounds.grams.max
      )
    ) {
      reason('macro_outlier');
      continue;
    }

    const caloriesR = Math.round(calories);
    const proteinR = round1(protein);
    const carbsR = round1(carbs);
    const fatsR = round1(fats);

    // 4/4/9 label-consistency check (per 100g). Severe gaps get dropped; the
    // rest are counted as warnings so no silent data loss.
    if (b.calorieConsistency.enabled && caloriesR > 0) {
      const calc = proteinR * 4 + carbsR * 4 + fatsR * 9;
      const gapAbs = Math.abs(calc - caloriesR);
      const gapPct = gapAbs / caloriesR;
      if (
        gapAbs > b.calorieConsistency.dropGapKcal &&
        gapPct > b.calorieConsistency.dropGapPercent
      ) {
        reason('calorie_inconsistent');
        continue;
      }
      if (
        gapAbs > b.calorieConsistency.warnGapKcal &&
        gapPct > b.calorieConsistency.warnGapPercent
      ) {
        warnings.calorieGap += 1;
      }
    }

    // Micro nutrients: NULL = untracked, 0 = measured zero (never 0-for-missing);
    // US invariants handled by config/nutrients.js (clamps recorded per reason).
    const { nutrients: micros, warnings: microWarnings } = normalizeNutrients(
      {
        fiber: toNumber(nutrients.fiber),
        sodium: toNumber(nutrients.sodium),
        saturatedFats: toNumber(nutrients.saturated_fats),
        sugars: toNumber(nutrients.sugars),
      },
      { source: 'usda', parentTotals: { fats: fatsR, carbs: carbsR } }
    );
    for (const msg of microWarnings) {
      const key = msg.split(' ')[0];
      warnings.nutrientClamps[key] = (warnings.nutrientClamps[key] || 0) + 1;
    }

    const grams = convertServingToGrams(meta);
    if (b.requireConvertibleServing && !grams) {
      reason('no_convertible_serving');
      continue;
    }
    const houseClean = cleanHouseholdText(meta.householdServing);
    const portions = buildPortions(grams, houseClean);

    const { category, subcategory } = classifyBrand(name);
    candidates.push({
      id: `usda_${food.fdcId}`,
      fdcId: food.fdcId,
      name,
      brand,
      category,
      subcategory,
      calories: caloriesR,
      protein: proteinR,
      carbs: carbsR,
      fats: fatsR,
      fiber: micros.fiber,
      sodium: micros.sodium,
      saturated_fats: micros.saturatedFats,
      sugars: micros.sugars,
      portions,
      gtin: meta.gtinUpc || null,
      preparationState: meta.preparationState || null,
    });
  }

  return { candidates, dropped, warnings };
};

// ---- deduplication -----------------------------------------------------------

const prepPriority = (state) => {
  const s = String(state || '').toUpperCase();
  if (!s || s.includes('AS PURCHASED')) return 0;
  return 1;
};

const collapseExactDuplicates = (rows, dropped) => {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    const key =
      `${row.name.trim().toLowerCase()}::${row.category}::` +
      String(row.brand || '').trim().toLowerCase();
    if (seen.has(key)) {
      dropped.dup_exact = (dropped.dup_exact || 0) + 1;
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return kept;
};

const dedupeCandidates = (candidates, dropped) => {
  const mode = BRAND_CURATION.dedupeBy || [];
  let rows = candidates;
  const reason = (key) => {
    dropped[key] = (dropped[key] || 0) + 1;
  };

  if (mode.includes('gtin')) {
    const best = new Map(); // normalized gtin -> index into kept
    const kept = [];
    for (const row of candidates) {
      const rawGtin = String(row.gtin || '');
      const normGtin = rawGtin.replace(/\D/g, '');
      if (!rawGtin || normGtin.length < 8 || normGtin.length > 14) {
        kept.push(row);
        continue;
      }
      const existingIdx = best.get(normGtin);
      if (existingIdx === undefined) {
        best.set(normGtin, kept.length);
        kept.push(row);
        continue;
      }
      const current = kept[existingIdx];
      if (prepPriority(row.preparationState) < prepPriority(current.preparationState)) {
        reason('dup_gtin');
        kept[existingIdx] = row; // prefer the as-purchased representation
      } else {
        reason('dup_gtin');
      }
    }
    rows = kept;
  }

  if (mode.includes('fingerprint')) {
    const seen = new Set();
    const kept = [];
    for (const row of rows) {
      // Fingerprint only applies to GTIN-less rows; different GTINs are
      // distinct pack sizes/products and must never collapse together.
      if (!row.gtin) {
        const fp =
          `${row.name.trim().toLowerCase()}|${String(row.brand || '').trim().toLowerCase()}|` +
          `${row.calories},${row.protein},${row.carbs},${row.fats}`;
        if (seen.has(fp)) {
          reason('dup_fingerprint');
          continue;
        }
        seen.add(fp);
      }
      kept.push(row);
    }
    rows = kept;
  }

  // Exact (name, category, brand) collapse — keeps first. FDC re-lists the
  // same product across GDSN updates/trade channels under fresh fdc_ids, so an
  // exact triple match is a true duplicate even when nutrients drifted.
  rows = collapseExactDuplicates(rows, dropped);

  return rows;
};

// ---- staple collision guard --------------------------------------------------

const loadStapleKeys = async () => {
  try {
    await fs.access(STAPLES_DB_PATH);
  } catch {
    return null;
  }
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const buffer = await fs.readFile(STAPLES_DB_PATH);
  const db = new SQL.Database(new Uint8Array(buffer));
  const rows =
    db.exec('SELECT LOWER(TRIM(name)), category FROM foods')?.[0]?.values ?? [];
  db.close();
  const keys = new Set();
  for (const [name, category] of rows) {
    if (name && category) keys.add(`${name}::${category}`);
  }
  return keys;
};

const filterStapleCollisions = async (rows, dropped) => {
  if (BRAND_CURATION.stapleCollisionMode !== 'drop') return rows;
  const keys = await loadStapleKeys();
  if (!keys) return rows;
  const kept = [];
  for (const row of rows) {
    const key = `${row.name.trim().toLowerCase()}::${row.category}`;
    if (keys.has(key)) {
      dropped.staple_collision = (dropped.staple_collision || 0) + 1;
      continue;
    }
    kept.push(row);
  }
  return kept;
};

// ---- post-assembly audit gate -------------------------------------------------

const runBrandAudit = (rows) => {
  const errors = [];
  const ids = new Set();
  const bounds = BRAND_CURATION.macroBounds;
  for (const row of rows) {
    if (!row.id) errors.push('row with empty id');
    else if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
    else ids.add(row.id);

    if (!row.name) errors.push(`row ${row.id || '?'} has an empty name`);
    if (!/[a-z0-9]/i.test(row.name)) errors.push(`row ${row.id} name has no letters/digits`);

    for (const key of ['calories', 'protein', 'carbs', 'fats']) {
      const v = row[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`row ${row.id} has non-finite ${key}=${v}`);
      }
    }
    if (row.calories <= 0 || row.calories > bounds.calories.max) {
      errors.push(`row ${row.id} calories ${row.calories} out of bounds`);
    }
    for (const key of ['protein', 'carbs', 'fats']) {
      if (row[key] < bounds.grams.min || row[key] > bounds.grams.max) {
        errors.push(`row ${row.id} ${key} ${row[key]} out of bounds`);
      }
    }

    let portions;
    try {
      portions = JSON.parse(row.portions);
    } catch {
      errors.push(`row ${row.id} has invalid portions JSON`);
      continue;
    }
    if (!Array.isArray(portions) || portions.length === 0) {
      errors.push(`row ${row.id} has empty portions`);
    } else {
      const first = portions[0];
      if (first.id !== 'p_100g' || first.grams !== 100) {
        errors.push(`row ${row.id} portions must start with the 100g entry`);
      }
      const portionIds = new Set();
      for (const p of portions) {
        if (!p || !p.id || !p.label) errors.push(`row ${row.id} has a malformed portion`);
        else if (portionIds.has(p.id)) errors.push(`row ${row.id} duplicate portion id ${p.id}`);
        else portionIds.add(p.id);
        if (!(typeof p.grams === 'number' && p.grams > 0)) {
          errors.push(`row ${row.id} portion grams must be a positive number`);
        }
      }
    }

    if (row.sodium != null && (row.sodium < 0 || row.sodium > 10000)) {
      errors.push(`row ${row.id} sodium ${row.sodium} out of bounds (mg)`);
    }
    for (const key of ['fiber', 'saturated_fats', 'sugars']) {
      if (row[key] != null && (row[key] < 0 || row[key] > 1000)) {
        errors.push(`row ${row.id} ${key} ${row[key]} out of bounds`);
      }
    }
    if (row.saturated_fats != null && row.saturated_fats > row.fats + 0.01) {
      errors.push(`row ${row.id} saturated_fats > fats`);
    }
    if (row.sugars != null && row.sugars > row.carbs * 1.06) {
      errors.push(`row ${row.id} sugars > carbs`);
    }
  }
  return errors;
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
      ':id': `usda_${row.fdcId}`,
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

// ---- entry point ------------------------------------------------------------

const main = async () => {
  const { dryRun, replace, writeHeadless } = parseArgs();
  assertClassifyRulesCanonical();

  const brandedDir = await findBrandedDir();
  if (!brandedDir) {
    console.error(
      `build-brands: FDC Branded download not found under ${FDC_DOWNLOAD_DIR}\n` +
        'Download "FoodData Central CSV (Branded Food Products)" from\n' +
        '  https://fdc.nal.usda.gov/download-datasets.html\n' +
        'and unzip it into fdc-download/ keeping the FoodData_Central_branded_food_csv_* folder\n' +
        '(an NTFS junction to an external drive is fully supported).'
    );
    process.exit(1);
  }
  console.log(`build-brands: source directory -> ${brandedDir}`);

  const scheme = await loadNutrientScheme(brandedDir);
  console.log(`build-brands: nutrient.csv present: ${scheme.hasNutrientFile}`);
  if (!scheme.verified) {
    console.error('build-brands: nutrient-id scheme verification FAILED — refusing to trust nutrient_ids:');
    for (const mismatch of scheme.mismatches) console.error(`  - ${mismatch}`);
    process.exit(1);
  }
  console.log('build-brands: nutrient-id scheme verified (1008=Energy; 1002=Nitrogen excluded)');

  const { foodsById, nutrientsByFood, metaByFood, counts } = await loadBrandedData(brandedDir);
  console.log(
    `build-brands: streams read — food.csv ${counts.foodRows} rows, food_nutrient.csv ${counts.nutrientRows} rows; ${foodsById.size} branded foods`
  );

  const { candidates, dropped, warnings } = assembleCandidates({
    foodsById,
    nutrientsByFood,
    metaByFood,
  });
  const deduped = dedupeCandidates(candidates, dropped);
  const kept = await filterStapleCollisions(deduped, dropped);
  const capped = BRAND_CURATION.maxRows ? kept.slice(0, BRAND_CURATION.maxRows) : kept;

  const auditErrors = runBrandAudit(capped);
  const categoryCounts = capped.reduce((acc, row) => {
    acc[row.category] = (acc[row.category] || 0) + 1;
    return acc;
  }, {});

  const report = {
    release: {
      brandedDir,
      hasNutrientFile: scheme.hasNutrientFile,
      foodCsvRows: counts.foodRows,
      nutrientRows: counts.nutrientRows,
    },
    policy: {
      requireCompleteMacros: BRAND_CURATION.requireCompleteMacros,
      requireConvertibleServing: BRAND_CURATION.requireConvertibleServing,
      dedupeBy: BRAND_CURATION.dedupeBy,
      stapleCollisionMode: BRAND_CURATION.stapleCollisionMode,
      maxRows: BRAND_CURATION.maxRows,
      fallbackCategory: BRAND_CURATION.fallbackCategory,
    },
    inputs: { brandedFoods: foodsById.size },
    outputs: { candidates: candidates.length, kept: kept.length, written: capped.length },
    dropped,
    warnings,
    categoryCounts,
    samples: capped.slice(0, 25).map((row) => ({
      id: row.id,
      name: row.name,
      brand: row.brand,
      category: row.category,
      subcategory: row.subcategory,
      calories: row.calories,
      protein: row.protein,
      carbs: row.carbs,
      fats: row.fats,
      portions: row.portions,
    })),
    audit: { errors: auditErrors.length, details: auditErrors.slice(0, 50) },
    dryRun,
  };

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  await fs.writeFile(path.join(REPORTS_DIR, 'brands.json'), JSON.stringify(report, null, 2));
  console.log('build-brands: report -> reports/brands.json');
  console.log(
    `build-brands: ${kept.length} kept (capped ${capped.length}) of ${foodsById.size} branded foods`
  );
  console.log(`build-brands: brand-audit ${auditErrors.length === 0 ? 'PASS' : `FAIL (${auditErrors.length} error(s))`}`);
  Object.entries(categoryCounts).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });
  if (auditErrors.length > 0) {
    for (const err of auditErrors.slice(0, 30)) console.error(`brand-audit ERROR: ${err}`);
    process.exit(1);
  }

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
  console.error(`build-brands: fatal: ${error.stack || error.message}`);
  process.exit(1);
});
