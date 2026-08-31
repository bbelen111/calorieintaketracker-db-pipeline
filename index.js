import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import initSqlJs from 'sql.js';
import {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  CANONICAL_SUBCATEGORY_BY_CATEGORY,
  SUBCATEGORY_ALIASES,
  INVALID_PORTION_LABELS,
} from './config/taxonomy.js';

const PROJECT_ROOT = globalThis.process.cwd();
const SOURCE_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.sqlite');
const REPORTS_DIR = path.resolve(PROJECT_ROOT, 'reports');
const BACKUP_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.backup.sqlite');

const parseArgs = () => {
  const args = new Set(globalThis.process.argv.slice(2));
  return {
    mode: args.has('--clean') ? 'clean' : 'audit',
    dryRun: args.has('--dry-run'),
    replace: args.has('--replace'),
  };
};

const normalizeToken = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

const parsePortions = (rawPortions) => {
  if (!rawPortions) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawPortions);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const getNumeric = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMacro = (value) => Math.round(getNumeric(value, 0) * 1000) / 1000;

const sanitizeFoodName = (rawName) => {
  const original = String(rawName ?? '').trim();
  if (!original) {
    return { name: '', changed: false };
  }

  let name = original;

  name = name
    .replace(/\uFFFD/g, ' ')
    .replace(/\b(?:not\s+specified|unspecified|unknown)\b/gi, ' ')
    .replace(/\btype\s+of\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .trim();

  return { name, changed: name !== original };
};

const inferProteinSubcategory = (name, existingSubcategory = null) => {
  const lowered = String(name ?? '').toLowerCase();
  const shellfishPattern =
    /(shrimp|prawn|crab|lobster|mussel|clam|oyster|scallop|octopus|squid|mollusk|whelk|abalone|cuttlefish)/;
  const fishPattern =
    /(fish|salmon|tuna|cod|sardine|anchovy|mackerel|herring|trout|tilapia|halibut|snapper)/;
  const mixedMealPattern =
    /(\bwith\b|\band\b|platter|fries|sandwich|rolls?\b|pizza|burrito|taco|soup|salad|stew|casserole|combo|restaurant|frozen\s+dinner)/;

  if (existingSubcategory) {
    if (existingSubcategory === 'fish' && shellfishPattern.test(lowered)) {
      return 'shellfish';
    }

    return existingSubcategory;
  }

  if (mixedMealPattern.test(lowered)) {
    return null;
  }

  if (shellfishPattern.test(lowered)) {
    return 'shellfish';
  }

  if (fishPattern.test(lowered)) {
    return 'fish';
  }

  if (/(beef|veal|bison|buffalo|steak|brisket|sirloin)/.test(lowered)) {
    return 'beef';
  }

  if (/(pork|ham|bacon|prosciutto|sausage)/.test(lowered)) {
    return 'pork';
  }

  if (/(chicken|turkey|duck|goose)/.test(lowered)) {
    return 'poultry';
  }

  if (/\b(egg|eggs|omelette|omelet)\b/.test(lowered)) {
    return 'eggs';
  }

  if (/(whey|casein|protein\s*powder|isolate|concentrate)/.test(lowered)) {
    return 'protein_powder';
  }

  return null;
};

const inferSubcategory = ({ category, subcategory, name }) => {
  if (category === 'protein') {
    return inferProteinSubcategory(name, subcategory);
  }

  return subcategory;
};

const getDedupKey = (row) =>
  [
    normalizeToken(row.name),
    row.category,
    row.subcategory ?? '',
    roundMacro(row.calories),
    roundMacro(row.protein),
    roundMacro(row.carbs),
    roundMacro(row.fats),
  ].join('|');

const getDedupScore = (row) => {
  let score = 0;
  if (String(row.id ?? '').startsWith('usda_')) {
    score += 2;
  }

  const portions = parsePortions(row.portions);
  score += Math.min(portions.length, 10) * 0.1;
  score += Math.min(String(row.name ?? '').length, 120) * 0.001;
  return score;
};

const hasValidMacros = (row) =>
  ['calories', 'protein', 'carbs', 'fats'].every(
    (key) => Number.isFinite(getNumeric(row[key])) && getNumeric(row[key]) >= 0
  );

const inferCategoryFromNameAndMacros = (row) => {
  const name = String(row?.name ?? '').toLowerCase();
  const protein = getNumeric(row?.protein);
  const carbs = getNumeric(row?.carbs);
  const fats = getNumeric(row?.fats);

  if (
    /(protein|whey|casein|bcaa|creatine|electrolyte|pre\s*-?workout|vitamin|supplement)/.test(
      name
    )
  ) {
    return 'supplements';
  }

  if (
    /(oil|butter|lard|blubber|tallow|margarine|mayonnaise|mayo|nuts?|seeds?)/.test(
      name
    )
  ) {
    return 'fats';
  }

  if (
    /(beef|pork|lamb|mutton|veal|venison|bison|buffalo|elk|moose|caribou|chicken|turkey|duck|goose|ham|bacon|sausage|steak|fish|tuna|salmon|cod|shrimp|crab|lobster|mussel|clam|oyster|anchovy|sardine|egg|meat|seal|whale|walrus)/.test(
      name
    )
  ) {
    return 'protein';
  }

  if (
    /(spinach|broccoli|cauliflower|cabbage|lettuce|kale|zucchini|cucumber|celery|carrot|onion|pepper|tomato|asparagus|radish|eggplant|okra|leek|greens?|vegetable|squash)/.test(
      name
    )
  ) {
    return 'vegetables';
  }

  if (
    /(bread|rice|pasta|corn|potato|yam|oat|oats|barley|grain|flour|tortilla|bagel|biscuit|pizza|burrito|pretzel|popcorn|granola|trail mix|snack|chips|fries|syrup|sugar|sweet|candy|chocolate|jam|jelly|ice cream|dessert|pudding|juice|soda|cola|fruit|banana|apple|orange|berry|grape|pear|peach|plum|apricot|cherry|watermelon|pineapple|mango|papaya|guava|lychee|drink|beverage)/.test(
      name
    )
  ) {
    return 'carbs';
  }

  if (protein >= 10 && protein >= carbs && protein >= fats) {
    return 'protein';
  }

  if (fats >= 10 && fats >= carbs && fats >= protein) {
    return 'fats';
  }

  if (carbs >= 10 && carbs >= protein && carbs >= fats) {
    return 'carbs';
  }

  return null;
};

const normalizeCategory = (rawCategory, row) => {
  const token = normalizeToken(rawCategory);
  if (!token) {
    return { category: null, reason: 'missing_category' };
  }

  const aliasMapped = CATEGORY_ALIASES[token] ?? token;
  if (!CANONICAL_CATEGORIES.has(aliasMapped)) {
    return {
      category: null,
      reason: 'unknown_category',
      original: token,
    };
  }

  if (aliasMapped === 'custom' || aliasMapped === 'manual') {
    const id = String(row?.id ?? '').toLowerCase();
    if (id.startsWith('usda_')) {
      const inferredCategory = inferCategoryFromNameAndMacros(row);
      if (inferredCategory) {
        return {
          category: inferredCategory,
          reason: 'reclassified_from_custom_usda',
          original: aliasMapped,
        };
      }

      return {
        category: null,
        reason: 'custom_usda_unclassified',
        original: aliasMapped,
      };
    }
  }

  return { category: aliasMapped, reason: null };
};

const normalizeSubcategory = (rawSubcategory, category) => {
  const token = normalizeToken(rawSubcategory);
  if (!token) {
    return { subcategory: null, reason: null };
  }

  const aliasMapped = SUBCATEGORY_ALIASES[token] ?? token;
  if (aliasMapped === null) {
    return {
      subcategory: null,
      reason: 'subcategory_mapped_to_null',
      original: token,
    };
  }

  const allowedForCategory = CANONICAL_SUBCATEGORY_BY_CATEGORY[category];
  if (!allowedForCategory || allowedForCategory.has(aliasMapped)) {
    return { subcategory: aliasMapped, reason: null };
  }

  return {
    subcategory: null,
    reason: 'subcategory_not_allowed_for_category',
    original: token,
  };
};

const extractGramsFromLabel = (label) => {
  const match = String(label ?? '').match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (!match) {
    return null;
  }

  const grams = Number(match[1]);
  return Number.isFinite(grams) && grams > 0 ? grams : null;
};

const sanitizePortions = ({ row, portions, quarantine, stats }) => {
  const repaired = [];
  const byLabel = new Map();

  for (const portion of portions) {
    const rawLabel = String(portion?.label ?? '').trim();
    const normalizedLabel = normalizeToken(rawLabel).replaceAll('_', ' ');
    let grams = getNumeric(portion?.grams, NaN);
    let label = rawLabel;

    const labelInvalid =
      !normalizedLabel || INVALID_PORTION_LABELS.has(normalizedLabel);

    if (!Number.isFinite(grams) || grams <= 0) {
      grams = extractGramsFromLabel(label);
      if (Number.isFinite(grams) && grams > 0) {
        stats.portionsRepairedByLabel += 1;
      }
    }

    if ((!label || labelInvalid) && Number.isFinite(grams) && grams > 0) {
      label = `Serving (${Math.round(grams * 10) / 10}g)`;
      stats.portionLabelsRepaired += 1;
    }

    if (labelInvalid && (!Number.isFinite(grams) || grams <= 0)) {
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'portion',
        reason: 'invalid_portion_label_and_grams',
        value: rawLabel,
      });
      stats.portionsDropped += 1;
      continue;
    }

    if (!Number.isFinite(grams) || grams <= 0) {
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'portion',
        reason: 'missing_portion_grams',
        value: rawLabel || null,
      });
      stats.portionsDropped += 1;
      continue;
    }

    const safeLabel = String(label).trim().slice(0, 100);
    const key = normalizeToken(safeLabel);
    const value = {
      id: String(portion?.id ?? key ?? `portion_${repaired.length + 1}`),
      label: safeLabel,
      grams: Math.round(grams * 10) / 10,
    };

    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, value);
      continue;
    }

    if (existing.grams <= 0 && value.grams > 0) {
      byLabel.set(key, value);
    }
  }

  for (const value of byLabel.values()) {
    repaired.push(value);
  }

  if (!repaired.some((portion) => Math.abs(portion.grams - 100) < 0.0001)) {
    repaired.unshift({
      id: 'p_100g',
      label: '100g',
      grams: 100,
    });
    stats.portionsAdded100g += 1;
  }

  return repaired;
};

const loadRows = async (SQL) => {
  const buffer = await fs.readFile(SOURCE_DB_PATH);
  const db = new SQL.Database(new Uint8Array(buffer));

  // Detect columns first so legacy DBs (without micro columns) can still be
  // loaded; the rebuild step always writes the full nullable schema.
  const columnsResult = db.exec("PRAGMA table_info('foods')");
  const tableColumns = new Set(
    (columnsResult?.[0]?.values ?? []).map((row) => String(row[1] ?? '').trim())
  );
  const microSelect = ['fiber', 'sodium', 'saturated_fats', 'sugars']
    .filter((column) => tableColumns.has(column))
    .map((column) => `, ${column}`)
    .join('');

  const query = db.exec(`
    SELECT id, name, category, subcategory, calories, protein, carbs, fats${microSelect}, portions
    FROM foods
  `);

  if (!query.length) {
    db.close();
    return [];
  }

  const [{ columns, values }] = query;
  const rows = values.map((valueRow) =>
    Object.fromEntries(
      columns.map((column, index) => [column, valueRow[index]])
    )
  );

  db.close();
  return rows;
};

const summarize = (rows) => {
  const categoryCounts = new Map();
  const subcategoryCounts = new Map();

  for (const row of rows) {
    const category = normalizeToken(row.category) || '(empty)';
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

    const subcategory = normalizeToken(row.subcategory) || '(empty)';
    subcategoryCounts.set(
      subcategory,
      (subcategoryCounts.get(subcategory) ?? 0) + 1
    );
  }

  return {
    totalRows: rows.length,
    categories: Object.fromEntries(
      [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    subcategories: Object.fromEntries(
      [...subcategoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)
    ),
  };
};

const cleanRows = (rows) => {
  const quarantine = [];
  const dedupedByKey = new Map();
  const stats = {
    rowsDropped: 0,
    categoriesRemapped: 0,
    customCategoriesReclassified: 0,
    subcategoriesRemapped: 0,
    subcategoriesInferred: 0,
    subcategoriesCorrectedByHeuristic: 0,
    namesSanitized: 0,
    exactDuplicatesDropped: 0,
    portionsDropped: 0,
    portionsRepairedByLabel: 0,
    portionLabelsRepaired: 0,
    portionsAdded100g: 0,
  };

  for (const row of rows) {
    const nameResult = sanitizeFoodName(row.name);
    if (!nameResult.name || !hasValidMacros(row)) {
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'row',
        reason: 'invalid_name_or_macros',
        value: null,
      });
      stats.rowsDropped += 1;
      continue;
    }

    if (nameResult.changed) {
      stats.namesSanitized += 1;
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'name',
        reason: 'name_artifacts_sanitized',
        value: nameResult.name,
      });
    }

    const categoryResult = normalizeCategory(row.category, row);
    if (!categoryResult.category) {
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'category',
        reason: categoryResult.reason,
        value: categoryResult.original ?? row.category ?? null,
      });
      stats.rowsDropped += 1;
      continue;
    }

    if (normalizeToken(row.category) !== categoryResult.category) {
      stats.categoriesRemapped += 1;
    }
    if (categoryResult.reason === 'reclassified_from_custom_usda') {
      stats.customCategoriesReclassified += 1;
    }

    const subcategoryResult = normalizeSubcategory(
      row.subcategory,
      categoryResult.category
    );

    if (subcategoryResult.reason) {
      stats.subcategoriesRemapped += 1;
      quarantine.push({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        field: 'subcategory',
        reason: subcategoryResult.reason,
        value: subcategoryResult.original ?? row.subcategory ?? null,
      });
    }

    const portions = sanitizePortions({
      row,
      portions: parsePortions(row.portions),
      quarantine,
      stats,
    });

    const inferredSubcategory = inferSubcategory({
      category: categoryResult.category,
      subcategory: subcategoryResult.subcategory,
      name: nameResult.name,
    });

    if (!subcategoryResult.subcategory && inferredSubcategory) {
      stats.subcategoriesInferred += 1;
      quarantine.push({
        id: String(row.id ?? ''),
        name: nameResult.name,
        field: 'subcategory',
        reason: 'subcategory_inferred_from_name',
        value: inferredSubcategory,
      });
    }

    if (
      subcategoryResult.subcategory &&
      inferredSubcategory &&
      subcategoryResult.subcategory !== inferredSubcategory
    ) {
      stats.subcategoriesCorrectedByHeuristic += 1;
      quarantine.push({
        id: String(row.id ?? ''),
        name: nameResult.name,
        field: 'subcategory',
        reason: 'subcategory_corrected_by_heuristic',
        value: `${subcategoryResult.subcategory} -> ${inferredSubcategory}`,
      });
    }

    const candidate = {
      id: String(row.id),
      name: nameResult.name,
      category: categoryResult.category,
      subcategory: inferredSubcategory ?? subcategoryResult.subcategory,
      calories: Math.max(0, getNumeric(row.calories)),
      protein: Math.max(0, getNumeric(row.protein)),
      carbs: Math.max(0, getNumeric(row.carbs)),
      fats: Math.max(0, getNumeric(row.fats)),
      // Micro nutrients pass through untouched; `null` = untracked (preserved),
      // `0` = legitimately measured zero. Never coerce missing to 0 here.
      fiber: row.fiber == null ? null : Math.max(0, Number(row.fiber)),
      sodium: row.sodium == null ? null : Math.max(0, Number(row.sodium)),
      saturatedFats:
        row.saturated_fats == null ? null : Math.max(0, Number(row.saturated_fats)),
      sugars: row.sugars == null ? null : Math.max(0, Number(row.sugars)),
      portions: JSON.stringify(portions),
    };

    const dedupKey = getDedupKey(candidate);
    const existing = dedupedByKey.get(dedupKey);

    if (!existing) {
      dedupedByKey.set(dedupKey, candidate);
      continue;
    }

    const existingScore = getDedupScore(existing);
    const candidateScore = getDedupScore(candidate);

    if (candidateScore > existingScore) {
      quarantine.push({
        id: String(existing.id ?? ''),
        name: String(existing.name ?? ''),
        field: 'row',
        reason: 'exact_duplicate_replaced_by_higher_quality_entry',
        value: String(candidate.id ?? ''),
      });
      dedupedByKey.set(dedupKey, candidate);
    } else {
      quarantine.push({
        id: String(candidate.id ?? ''),
        name: String(candidate.name ?? ''),
        field: 'row',
        reason: 'exact_duplicate_dropped',
        value: String(existing.id ?? ''),
      });
    }

    stats.exactDuplicatesDropped += 1;
  }

  const cleanedRows = [...dedupedByKey.values()];
  return { cleanedRows, quarantine, stats };
};

const rebuildDatabase = async (SQL, cleanedRows) => {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      calories REAL NOT NULL CHECK (calories >= 0),
      protein REAL NOT NULL CHECK (protein >= 0),
      carbs REAL NOT NULL CHECK (carbs >= 0),
      fats REAL NOT NULL CHECK (fats >= 0),
      fiber REAL,
      sodium REAL,
      saturated_fats REAL,
      sugars REAL,
      portions TEXT NOT NULL
    );

    CREATE INDEX idx_food_name ON foods(name);
    CREATE INDEX idx_food_category ON foods(category);
    CREATE INDEX idx_food_subcategory ON foods(subcategory);
  `);

  const insertStatement = db.prepare(`
    INSERT INTO foods (id, name, category, subcategory, calories, protein, carbs, fats, fiber, sodium, saturated_fats, sugars, portions)
    VALUES (:id, :name, :category, :subcategory, :calories, :protein, :carbs, :fats, :fiber, :sodium, :saturated_fats, :sugars, :portions)
  `);

  for (const row of cleanedRows) {
    insertStatement.run({
      ':id': row.id,
      ':name': row.name,
      ':category': row.category,
      ':subcategory': row.subcategory,
      ':calories': row.calories,
      ':protein': row.protein,
      ':carbs': row.carbs,
      ':fats': row.fats,
      ':fiber': row.fiber ?? null,
      ':sodium': row.sodium ?? null,
      ':saturated_fats': row.saturatedFats ?? null,
      ':sugars': row.sugars ?? null,
      ':portions': row.portions,
    });
  }

  insertStatement.free();

  const integrity = db.exec('PRAGMA integrity_check');
  const integrityMessage = integrity?.[0]?.values?.[0]?.[0] ?? 'unknown';
  if (integrityMessage !== 'ok') {
    db.close();
    throw new Error(`Integrity check failed: ${integrityMessage}`);
  }

  const bytes = db.export();
  db.close();
  return bytes;
};

const ensureReportsDir = async () => {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
};

const writeJsonReport = async (fileName, payload) => {
  await ensureReportsDir();
  const filePath = path.resolve(REPORTS_DIR, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
};

const replaceDatabaseFile = async (bytes) => {
  const tempPath = `${SOURCE_DB_PATH}.tmp`;

  const sourceBuffer = await fs.readFile(SOURCE_DB_PATH);
  await fs.writeFile(BACKUP_DB_PATH, sourceBuffer);
  await fs.writeFile(tempPath, Buffer.from(bytes));
  await fs.rename(tempPath, SOURCE_DB_PATH);
};

const main = async () => {
  const args = parseArgs();
  const SQL = await initSqlJs();
  const rows = await loadRows(SQL);
  const beforeSummary = summarize(rows);

  await writeJsonReport('audit.before.json', beforeSummary);

  if (args.mode === 'audit') {
    console.log(
      `Audit complete. Rows: ${beforeSummary.totalRows}. Report: reports/audit.before.json`
    );
    return;
  }

  const { cleanedRows, quarantine, stats } = cleanRows(rows);
  const afterSummary = summarize(cleanedRows);

  const report = {
    inputRows: rows.length,
    outputRows: cleanedRows.length,
    quarantineCount: quarantine.length,
    stats,
    beforeSummary,
    afterSummary,
  };

  await writeJsonReport('audit.after.json', report);
  await writeJsonReport('quarantine.json', quarantine);

  if (args.dryRun) {
    console.log(
      `Dry-run complete. Output rows: ${cleanedRows.length}. Reports written to reports/`
    );
    return;
  }

  const bytes = await rebuildDatabase(SQL, cleanedRows);

  if (args.replace) {
    await replaceDatabaseFile(bytes);
    console.log(
      `Clean complete. Replaced ${SOURCE_DB_PATH} (backup: ${BACKUP_DB_PATH}).`
    );
    return;
  }

  const outputPath = path.resolve(
    PROJECT_ROOT,
    'foodDatabase.cleaned.sqlite'
  );
  await fs.writeFile(outputPath, Buffer.from(bytes));
  console.log(`Clean complete. Wrote ${outputPath}`);
};

main().catch((error) => {
  console.error('Food DB pipeline failed:', error);
  globalThis.process.exitCode = 1;
});
