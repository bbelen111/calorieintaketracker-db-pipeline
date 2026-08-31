// From-scratch food catalog builder.
//
// Ingests raw FDC CSV downloads (fdc-download/) for Foundation + SR Legacy
// (+ Survey/FNDDS when enabled, default on) and produces the curated sql.js
// catalog used by the consumer app (foodDatabase.sqlite at repo root).
// Curation rules live in ./config/curation.js; every decision is reported to
// reports/curation.json.
//
// Usage:
//   node build.js                # dry-run: reports only
//   node build.js --replace      # write foodDatabase.sqlite (backup first)
//   node build.js --write        # write foodDatabase.curated.sqlite only
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import initSqlJs from 'sql.js';
import {
  CATEGORY_ALIASES,
  CANONICAL_SUBCATEGORY_BY_CATEGORY,
  SUBCATEGORY_ALIASES,
  INVALID_PORTION_LABELS,
} from './config/taxonomy.js';
import { CURATION } from './config/curation.js';

const PROJECT_ROOT = globalThis.process.cwd();
const FDC_DOWNLOAD_DIR = path.resolve(PROJECT_ROOT, 'fdc-download');
const SOURCE_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.sqlite');
const REPORTS_DIR = path.resolve(PROJECT_ROOT, 'reports');
const BACKUP_DB_PATH = path.resolve(
  PROJECT_ROOT,
  'foodDatabase.backup.sqlite'
);
const CURATED_DB_PATH = path.resolve(
  PROJECT_ROOT,
  'foodDatabase.curated.sqlite'
);

const NUTRIENT_NBR_TO_FIELD = {
  208: 'calories',
  203: 'protein',
  205: 'carbs',
  204: 'fats',
  291: 'fiber',
  307: 'sodium',
  606: 'saturatedFats',
  269: 'sugars',
};

const DATASET_KINDS = [
  { keyword: 'foundation', label: 'foundation', dataType: 'foundation_food' },
  { keyword: 'sr_legacy', label: 'sr', dataType: 'sr_legacy_food' },
  { keyword: 'survey', label: 'survey', dataType: 'survey_fndds_food' },
];

const parseArgs = () => {
  const args = new Set(globalThis.process.argv.slice(2));
  return {
    dryRun:
      args.has('--dry-run') || !(args.has('--replace') || args.has('--write')),
    replace: args.has('--replace'),
    write: args.has('--write'),
    useSurvey: args.has('--survey') ? true : CURATION.useSurvey,
  };
};

// ---- CSV plumbing ----------------------------------------------------------

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
  if (value === null || value === undefined) return NaN;
  return Number(String(value).replace(/"/g, '').trim());
};

// ---- Nutrient assembly -----------------------------------------------------

const roundMacro = (value) => {
  const numeric = toNumber(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
};

const loadNutrientPer100g = (
  nutritionHeader,
  nutrientRows,
  nutrientIdByNbr
) => {
  const fdcIndex = getColumnIndex(nutritionHeader, 'fdc_id');
  const nutrientIdIndex = getColumnIndex(nutritionHeader, 'nutrient_id');
  const amountIndex = getColumnIndex(nutritionHeader, 'amount');
  const medianIndex = getColumnIndex(nutritionHeader, 'median');

  // FDC bulk releases don't agree on what `food_nutrient.nutrient_id` means:
  //   - SR Legacy (2018) and Foundation (2024+): the internal FDC nutrient id
  //     (energy = 1008, protein = 1003, fat = 1004, carbs = 1005, ...).
  //   - Survey/FNDDS (2024+): the nutrient NUMBER directly (energy = 208).
  // Map both schemes onto the same fields. (Nutrient id 1002 is NITROGEN, not
  // an energy alias — never map it to calories.)
  const fieldByNutrientId = new Map();
  for (const [nbr, field] of Object.entries(NUTRIENT_NBR_TO_FIELD)) {
    fieldByNutrientId.set(String(nbr), field); // survey: direct nutrient number
    const legacyId = nutrientIdByNbr.get(String(nbr)); // sr/foundation: internal id
    if (legacyId !== undefined) fieldByNutrientId.set(String(legacyId), field);
  }

  const byFdc = new Map();
  for (const row of nutrientRows) {
    const fdcId = getCsvValue(row, fdcIndex);
    const nutrientId = getCsvValue(row, nutrientIdIndex);
    if (!fdcId || !nutrientId) continue;

    const target = fieldByNutrientId.get(String(nutrientId));
    if (!target) continue;

    const amount = toNumber(getCsvValue(row, amountIndex));
    const median = toNumber(getCsvValue(row, medianIndex));
    const value = Number.isFinite(median) ? median : amount;

    let food = byFdc.get(fdcId);
    if (!food) {
      food = {};
      for (const field of Object.values(NUTRIENT_NBR_TO_FIELD))
        food[field] = null;
      byFdc.set(fdcId, food);
    }
    if (Number.isFinite(value) && food[target] === null) {
      food[target] = roundMacro(value);
    }
  }
  return byFdc;
};

const loadMeasureUnits = (header, rows) => {
  const idIdx = getColumnIndex(header, 'id');
  const nameIdx = getColumnIndex(header, 'name');
  const map = new Map();
  for (const row of rows) {
    const id = getCsvValue(row, idIdx);
    const name = getCsvValue(row, nameIdx);
    if (id && name) map.set(String(id), name);
  }
  return map;
};

const sanitizeFoodName = (rawName) =>
  String(rawName ?? '')
    .replace(/\uFFFD/g, ' ')
    .replace(/\(includes foods for[^)]*\)/gi, ' ')
    .replace(/\(food distribution program[^)]*\)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .trim();

const cleanAmount = (amount) =>
  /^\d+\.0+$/.test(amount) ? String(parseInt(amount, 10)) : amount;

// Display-name normalization for the meat section. SR Legacy names are verbose
// ("Chicken, broilers or fryers, breast, meat only, raw") which reads badly and
// breaks contiguous-phrase search ("chicken breast"). Collapse keeps the raw
// data; this pass rewrites just the DISPLAY name into "Chicken breast, raw".
const POULTRY_VARIANT_RE =
  /^(Chicken), (?:broilers? or fryers?|broiler[- ]fryers?|broilers?|fryers?|roasters?|capons?|hens? and cocks?|stewing hens?|young hens?|mature hens?|old hens?|young chickens?), /i;
const POULTRY_PARTS_RE =
  /^(breast|thigh|drumstick|wing|back|neck|whole|dark meat|light meat|skin|giblets)$/i;
const PORK_PARTS_RE =
  /^(loin|shoulder|ribs|spareribs|leg|ham|tenderloin|butt|picnic|belly|side)$/i;

const friendlyMeatName = (name) => {
  const original = String(name ?? '').trim();
  if (!/^(chicken|turkey|duck|goose|pork)\b/i.test(original)) return original;

  let out = original;
  out = out.replace(POULTRY_VARIANT_RE, 'Chicken, ').replace(/, fresh/gi, '');

  // "Chicken, breast, meat only, raw" -> "Chicken breast, meat only, raw"
  out = out.replace(
    /^(Chicken|Turkey|Duck|Goose|Pork), ([a-z]+(?: [a-z]+)?), /i,
    (match, animal, part) => {
      const partPattern = /^(chicken|turkey|duck|goose)$/i.test(animal)
        ? POULTRY_PARTS_RE
        : PORK_PARTS_RE;
      return partPattern.test(part) ? `${animal} ${part}, ` : match;
    }
  );

  // USDA has no plain "Chicken, ..., breast, meat only, raw" row — the raw
  // skinless-boneless breast is that food. Drop the redundant qualifiers for
  // the raw form only so the canonical "Chicken breast, raw" label exists;
  // cooked variants (braised/grilled...) keep the qualifiers for clarity.
  out = out.replace(/, skinless, boneless(?:, meat only)?(?=, raw$)/gi, '');

  out = out
    .replace(/, meat only/gi, '')
    .replace(/, meat and skin/gi, ', with skin')
    .replace(/, separable lean and fat/gi, '')
    .replace(/, separable lean only/gi, '')
    .replace(/, separable fat\b/gi, '')
    .replace(/, whole\b/gi, '');

  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^\s+|\s+$/g, '');
};

const buildPortions = (portionRows, unitById, maxPortions) => {
  const NAUGHTY_UNITS = new Set([
    'undetermined',
    'not specified',
    'unspecified',
    'unknown',
    'none',
    'n/a',
    'no unit',
    'serving',
    '',
  ]);
  const meaningfulUnit = (unitId) => {
    const name = unitById.get(String(unitId ?? ''));
    if (!name) return '';
    const lower = String(name).toLowerCase().replace(/[".']/g, '').trim();
    return NAUGHTY_UNITS.has(lower) ? '' : lower;
  };
  const meaningfulDescription = (description) => {
    const value = String(description ?? '')
      .trim()
      .toLowerCase();
    if (!value || value === 'undetermined') return '';
    return INVALID_PORTION_LABELS.has(value) ? '' : value;
  };

  const entries = [];
  let fallbackServing = null;
  const sorted = portionRows
    .slice()
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));

  for (const p of sorted) {
    const gramWeight = toNumber(p.gramWeight);
    if (!Number.isFinite(gramWeight) || gramWeight <= 0) continue;

    const amount = cleanAmount(String(p.amount ?? '').trim());
    if (!amount) continue;

    const unit = meaningfulUnit(p.unitId);
    const description = meaningfulDescription(p.description);

    // SR Legacy "undetermined" rows are just canonical serving-size grams with
    // no real household unit. Remember the first one as a fallback.
    if (!unit && !description) {
      if (fallbackServing === null) {
        fallbackServing = { gramWeight };
      }
      continue;
    }

    if (entries.length >= maxPortions) break;

    let label = `${amount} ${unit}`.trim();
    if (description) label += ` ${description}`;
    label += ` (${fmtGrams(gramWeight)}g)`;
    entries.push({
      id: `portion_${entries.length + 1}`,
      label,
      grams: Math.round(gramWeight * 10) / 10,
    });
  }

  // No real household portions: expose the canonical serving-size grams as an
  // honest "1 serving (Ng)" quick portion instead of nothing (100g is always
  // present, but an SR serving size is more useful than a bare "undetermined").
  if (entries.length === 0 && fallbackServing) {
    entries.push({
      id: 'portion_1',
      label: `1 serving (${fmtGrams(fallbackServing.gramWeight)}g)`,
      grams: Math.round(fallbackServing.gramWeight * 10) / 10,
    });
  }

  return [{ id: 'p_100g', label: '100g', grams: 100 }, ...entries];
};

// ---- Dataset loading -------------------------------------------------------

const loadDataset = async (dirPath, dataType) => {
  const foodCsv = await readCsvFile(path.join(dirPath, 'food.csv'));
  const foodHeader = foodCsv.header;
  const foodIdIdx = getColumnIndex(foodHeader, 'fdc_id');
  const foodDescIdx = getColumnIndex(foodHeader, 'description');
  const foodTypeIdx = getColumnIndex(foodHeader, 'data_type');

  const foods = [];
  for (const row of foodCsv.rows) {
    const type = getCsvValue(row, foodTypeIdx) ?? '';
    if (dataType && type !== dataType) continue;

    const fdcId = getCsvValue(row, foodIdIdx);
    const name = getCsvValue(row, foodDescIdx);
    if (!fdcId || !name) continue;
    foods.push({ fdcId: String(fdcId), name: sanitizeFoodName(name) });
  }

  const nutrientCsv = await readCsvFile(path.join(dirPath, 'nutrient.csv'));
  const nutrientIdByNbr = new Map();
  const nbrIdx = getColumnIndex(nutrientCsv.header, 'nutrient_nbr');
  const idIdx = getColumnIndex(nutrientCsv.header, 'id');
  for (const row of nutrientCsv.rows) {
    const nbr = getCsvValue(row, nbrIdx);
    const id = getCsvValue(row, idIdx);
    if (nbr && id) nutrientIdByNbr.set(String(nbr), String(id));
  }

  const nutritionCsv = await readCsvFile(
    path.join(dirPath, 'food_nutrient.csv')
  );
  const nutrients = loadNutrientPer100g(
    nutritionCsv.header,
    nutritionCsv.rows,
    nutrientIdByNbr
  );

  const unitCsv = await readCsvFile(path.join(dirPath, 'measure_unit.csv'));
  const units = loadMeasureUnits(unitCsv.header, unitCsv.rows);

  const portionsByFdc = new Map();
  const portionCsv = await readCsvFile(path.join(dirPath, 'food_portion.csv'));
  const pFdcIdx = getColumnIndex(portionCsv.header, 'fdc_id');
  const pSeqIdx = getColumnIndex(portionCsv.header, 'seq_num');
  const pAmountIdx = getColumnIndex(portionCsv.header, 'amount');
  const pUnitIdx = getColumnIndex(portionCsv.header, 'measure_unit_id');
  const pDescIdx = getColumnIndex(portionCsv.header, 'portion_description');
  const pGramsIdx = getColumnIndex(portionCsv.header, 'gram_weight');
  for (const row of portionCsv.rows) {
    const fdcId = getCsvValue(row, pFdcIdx);
    if (!fdcId) continue;
    const portion = {
      seq: getCsvValue(row, pSeqIdx) ?? '0',
      amount: getCsvValue(row, pAmountIdx) ?? '',
      unitId: getCsvValue(row, pUnitIdx) ?? '',
      description: getCsvValue(row, pDescIdx) ?? '',
      gramWeight: getCsvValue(row, pGramsIdx) ?? '',
    };
    if (!portionsByFdc.has(fdcId)) portionsByFdc.set(fdcId, []);
    portionsByFdc.get(fdcId).push(portion);
  }

  return { foods, nutrients, units, portionsByFdc };
};

const fmtGrams = (grams) => {
  const rounded = Math.round(grams * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};

// ---- Taxonomy ---------------------------------------------------------------

const normalizeCategory = (category) => {
  const key = String(category ?? '')
    .trim()
    .toLowerCase();
  const alias = CATEGORY_ALIASES[key];
  if (alias) return alias;
  return CANONICAL_SUBCATEGORY_BY_CATEGORY[key] ? key : null;
};

const normalizeSubcategory = (category, subcategory) => {
  const raw = String(subcategory ?? '')
    .trim()
    .toLowerCase();
  const alias = SUBCATEGORY_ALIASES[raw];
  if (alias === null) return null;
  const resolved = alias ?? raw;
  const allowed = CANONICAL_SUBCATEGORY_BY_CATEGORY[category];
  return allowed && allowed.has(resolved) ? resolved : null;
};

// Category guess used only when the previous catalog has no taxonomy for an id
// (mainly Foundation foods). Existing ids carry their prior assignment forward.
const categorizeByName = (name) => {
  const n = String(name ?? '').toLowerCase();
  const has = (regex) => regex.test(n);

  if (has(/^salt\b|^sea salt\b|^kosher salt\b|^pickling salt\b/)) {
    return { category: 'carbs', subcategory: 'condiments' };
  }

  if (
    has(
      /protein powder|whey|casein|creatine|isolate|bcaa|amino acid|multivitamin|fish oil|cod liver oil|electrolyte|pre[- ]workout|formulated bar|protein bar|energy bar|meal replacement|sports bar/i
    )
  ) {
    return {
      category: 'supplements',
      subcategory: /protein powder|whey|casein|isolate/.test(n)
        ? 'protein'
        : 'general',
    };
  }
  // Meatless substitutes named after their meat analogue (Bacon, meatless).
  if (
    has(/meatless|meat substitute|plant.based|\bvegan\b|\bvegetarian\b/) &&
    has(
      /bacon|sausage|chicken|beef|burger|meatball|salami|pepperoni|hot dog|pork|ham|kielbasa|frankfurter|sandwich|luncheon|loaf\b|\bpatty\b/i
    )
  ) {
    return { category: 'protein', subcategory: 'plant_based' };
  }
  // Legume-based dishes first so "Beans, baked, canned, with pork" stays a
  // LEGUME, not a pork cut.
  if (
    has(
      /baked beans|\bbeans?,?\s*baked\b|\bpork and beans\b|cowpeas|\blentils?\b|\bchickpeas?\b|\bhummus\b|\bedamame\b|\bblack[e ]?yed peas?\b|\b(?:pinto|kidney|navy|black|white|lima|refried|great northern|adzuki|mung|cranberry|fava|faba|soy) beans?\b/i
    )
  ) {
    return { category: 'carbs', subcategory: 'legumes' };
  }
  if (has(/chicken|turkey|duck|goose|pheasant|quail|hen\b|game hen|poultry/i)) {
    return { category: 'protein', subcategory: 'poultry' };
  }
  if (
    has(
      /beef|veal|bison|buffalo|lamb|mutton|\bgame meat\b|venison|\bdeer\b|\belk\b|antelope|\bboar\b|\bgoat\b|\bhorse\b|rabbit|raccoon|steak|brisket|sirloin|chuck|ribeye|flank|skirt|tri-tip/i
    )
  ) {
    return { category: 'protein', subcategory: 'beef' };
  }
  if (
    has(
      /pork|bacon|ham|prosciutto|sausage|pepperoni|chorizo|bologna|salami|hot dog|frankfurter|bratwurst|kielbasa|meatball|meatballs|\bpate\b/i
    )
  ) {
    return {
      category: 'protein',
      subcategory: has(
        /hot dog|sausage|pepperoni|chorizo|bologna|salami|frankfurter|bratwurst|kielbasa|meatball|meatballs|\bpate\b/
      )
        ? 'processed_meat'
        : 'pork',
    };
  }
  if (has(/egg(s| white| yolk)?\b|omelet|omelette|deviled egg/i)) {
    return { category: 'protein', subcategory: 'eggs' };
  }
  if (
    has(
      /milk|cheese|yogurt|yoghurt|ricotta|cottage cheese|kefir|cream cheese|sour cream|parmesan|mozzarella|cheddar|queso/i
    )
  ) {
    if (has(/cream cheese|butter|cream\b/i)) {
      return {
        category: 'fats',
        subcategory: has(/margarine|spread/) ? 'spread' : 'dairy_fat',
      };
    }
    return { category: 'protein', subcategory: 'dairy' };
  }
  if (
    has(
      /shrimp|prawn|crab|lobster|mussel|clam|oyster|scallop|octopus|squid|whelk|abalone|cuttlefish|calamari/i
    )
  ) {
    return { category: 'protein', subcategory: 'shellfish' };
  }
  if (
    has(
      /fish|salmon|tuna|cod|sardine|anchovy|mackerel|herring|trout|tilapia|halibut|snapper|fish stick/i
    )
  ) {
    return { category: 'protein', subcategory: 'fish' };
  }
  if (
    has(
      /tofu|tempeh|seitan|meat substitute|plant.based|vegan protein|soy protein/i
    )
  ) {
    return { category: 'protein', subcategory: 'plant_based' };
  }
  if (has(/avocado|oil\b|olive oil|canola oil|sunflower oil|vegetable oil/i)) {
    return { category: 'fats', subcategory: has(/avocado/) ? 'nuts' : 'oil' };
  }
  if (
    has(
      /almond|walnut|pecan|cashew|peanut|pistachio|macadamia|hazelnut|brazil nut|peanut butter|nut butter|trail mix/i
    )
  ) {
    return { category: 'fats', subcategory: 'nuts' };
  }
  if (
    has(
      /sesame|sunflower seed|pumpkin seed|flax|chia seed|hemp seed|poppy seed/i
    )
  ) {
    return { category: 'fats', subcategory: 'seeds' };
  }
  if (has(/butter|ghee|margarine|shortening|lard|tallow/i)) {
    return {
      category: 'fats',
      subcategory: has(/margarine|spread/) ? 'spread' : 'dairy_fat',
    };
  }
  if (has(/potato|sweet potato|yam\b|taro|plantain|cassava|yucca/i)) {
    return { category: 'carbs', subcategory: 'starchy_vegetable' };
  }
  if (
    has(
      /rice|wheat|oats|oatmeal|barley|quinoa|corn|popcorn|pasta|noodle|spaghetti|penne|farfalle|macaroni|flour|semolina|cereal|grain|granola/i
    )
  ) {
    return { category: 'carbs', subcategory: 'grains' };
  }
  if (
    has(
      /bread|bagel|bun\b|roll\b|tortilla|pita|naan|cracker|pretzel|pancake|waffle|muffin|croissant|english muffin|toast|biscuit\b|baguette|zwieback|rusk/i
    )
  ) {
    return { category: 'carbs', subcategory: 'bread' };
  }
  if (has(/bean|lentil|chickpea|hummus|edamame|black eyed pea/i)) {
    return { category: 'carbs', subcategory: 'legumes' };
  }
  // Vegetables before fruit/beverages so "Tomatoes, grape", "Tomatoes, orange"
  // and "Broccoli, frozen, spears" stay vegetables.
  if (
    has(
      /lettuce|spinach|kale|chard|arugula|collard|mustard green|turnip green|greens\b/i
    )
  ) {
    return { category: 'vegetables', subcategory: 'leafy_green' };
  }
  if (
    has(
      /broccoli|cauliflower|cabbage|brussels|bok choy|broccolini|kohlrabi|broccoli rabe/i
    )
  ) {
    return { category: 'vegetables', subcategory: 'cruciferous' };
  }
  if (has(/carrot|beet\b|radish|turnip|rutabaga|parsnip|celery root/i)) {
    return { category: 'vegetables', subcategory: 'root' };
  }
  if (has(/onion|garlic|leek|shallot|scallion|chive/i)) {
    return { category: 'vegetables', subcategory: 'allium' };
  }
  if (has(/tomato|bell pepper|pepper\b|eggplant|chile|jalapeno|tomatillo/i)) {
    return { category: 'vegetables', subcategory: 'nightshade' };
  }
  if (
    has(
      /cucumber|celery|zucchini|squash|pumpkin|mushroom|asparagus|green bean|peas|okra|artichoke|olives?/i
    )
  ) {
    return { category: 'vegetables', subcategory: 'other_vegetable' };
  }
  if (
    has(
      /apple|banana|orange|grape\b|strawberr|blueberr|raspberr|blackberr|peach|pear|plum|cherry|watermelon|cantaloupe|melon|kiwi|mango|pineapple|papaya|clementine|tangerine|grapefruit|nectarine|apricot|figs?\b|dates?\b|raisin|cranberr|pomegranate|lemon|limes?\b/i
    )
  ) {
    return { category: 'carbs', subcategory: 'fruit' };
  }
  if (
    has(
      /beer|ale\b|stout|lager|wine|vodka|whiskey|whisky|rum\b|gin\b|tequila|bourbon|scotch|hard cider/i
    )
  ) {
    return { category: 'carbs', subcategory: 'alcohol' };
  }
  if (
    has(
      /juice|cola|soda|soft drink|sport drink|energy drink|smoothie|beverage|lemonade|iced tea|coffee|tea\b|water\b/i
    )
  ) {
    return { category: 'carbs', subcategory: 'beverages' };
  }
  if (
    has(
      /sugar|honey|syrup|molasses|candy|candied|candies|fudge|caramel|toffee|chocolate|cocoa|cookie|cake|brownie|ice cream|sherbet|sorbet|jelly|jams?|jellies|jam\b|jello|gelatin|pudding|doughnut|donut|custard|meringue|frosting|chewing gum|gum\b|fruit leather|sweetener|frozen novelties|ice pop|novelty/i
    )
  ) {
    return { category: 'carbs', subcategory: 'sweets' };
  }
  if (
    has(
      /ketchup|mustard|mayonnaise|mayo|sauce|dressing|vinegar|relish|salsa|dip\b|spread|gravy|pesto|paste|marinade|worcestershire|soy sauce|wasabi|seasoning|sazon/i
    )
  ) {
    return { category: 'carbs', subcategory: 'condiments' };
  }
  return null;
};

const resolveTaxonomy = (fdcId, name, legacyByFdc) => {
  const guessed = categorizeByName(name);
  if (guessed) {
    return {
      category: normalizeCategory(guessed.category) || 'uncategorized',
      subcategory: normalizeSubcategory(guessed.category, guessed.subcategory),
    };
  }
  const legacy = legacyByFdc.get(fdcId);
  if (legacy && legacy.category) {
    const category = normalizeCategory(legacy.category);
    if (category) {
      const subcategory = normalizeSubcategory(category, legacy.subcategory);
      return { category, subcategory };
    }
  }
  return { category: 'uncategorized', subcategory: null };
};

// ---- Curation ---------------------------------------------------------------

const COOKED_METHOD_RE =
  /,\s*cooked,\s*(roasted|braised|broiled|grilled|pan[- ]fried|fried|microwaved|baked|boiled|stewed|sauteed)/i;
const COOKED_GENERIC_RE = /,\s*cooked\b/i;

const describeState = (name) => {
  const lower = String(name ?? '').toLowerCase();
  const methodMatch = COOKED_METHOD_RE.exec(lower);
  if (methodMatch) {
    return { state: 'cooked', method: methodMatch[1].toLowerCase() };
  }
  if (COOKED_GENERIC_RE.test(lower))
    return { state: 'cooked', method: 'cooked' };
  if (/\braw\b/i.test(lower)) return { state: 'raw', method: 'raw' };
  if (/\bfresh\b/i.test(lower)) return { state: 'raw', method: 'raw' };
  return { state: 'cooked', method: 'cooked' };
};

const buildGroupKey = (name, category, subcategory) => {
  if (!CURATION.collapseEnabledSubcategories.includes(subcategory)) {
    return `kept|${category}|${subcategory}|${String(name).toLowerCase()}`;
  }
  let key = String(name).toLowerCase();
  for (const pattern of CURATION.purgeTokens) key = key.replace(pattern, ' ');
  key = key
    .replace(COOKED_METHOD_RE, ' ')
    .replace(COOKED_GENERIC_RE, ' ')
    .replace(/,?\s*\braw\b/gi, ' ')
    .replace(/,?\s*\bfresh\b/gi, ' ');
  key = key.replace(/[(),./]/g, ' ');
  key = key.replace(/\s+/g, ' ').trim();
  return `collapse|${category}|${subcategory}|${key}`;
};

const pickGroupRepresentatives = (members) => {
  const byState = {};
  const prefer = CURATION.cookedPreference;
  const rank = (member) => {
    const index = prefer.indexOf(member.state.method);
    return index === -1 ? prefer.length : index;
  };

  for (const member of members) {
    const state = member.state.state;
    if (!byState[state]) {
      byState[state] = member;
    } else if (state === 'cooked' && rank(member) < rank(byState[state])) {
      byState[state] = member;
    }
  }

  const picks = [];
  if (byState.raw) picks.push(byState.raw);
  if (byState.cooked) picks.push(byState.cooked);
  return picks.slice(0, CURATION.maxStatesPerGroup);
};

const isExcludedJunk = (name) =>
  CURATION.excludePatterns.some((regex) => regex.test(name));

const isForceIncluded = (name, fdcId) =>
  CURATION.includeFdcIds.has(fdcId) ||
  CURATION.includePatterns.some((regex) => regex.test(name));

const isCapsBrand = (name) => {
  if (!CURATION.excludeCapsTokens) return false;
  const allowlist = new Set(
    (CURATION.capsAllowlist || []).map((token) => token.toUpperCase())
  );
  const capsTokenPattern = /\b[A-Z]{3,}(?:['\u2019]S)?\b/g;
  let match;
  while ((match = capsTokenPattern.exec(name)) !== null) {
    const token = match[0].replace(/['\u2019]S$/i, '');
    if (!allowlist.has(token)) return true;
  }
  return false;
};

const assembleCandidates = ({ datasets, legacyByFdc }) => {
  const candidates = [];
  const droppedJunk = [];
  const nutrientGaps = [];
  const byDatasetCounts = {};

  for (const ds of datasets) {
    byDatasetCounts[ds.label] = 0;
    for (const food of ds.foods) {
      const fdcId = food.fdcId;
      const nutrients = ds.nutrients.get(fdcId);
      if (!nutrients || !Number.isFinite(nutrients.calories)) {
        nutrientGaps.push({
          id: fdcId,
          name: food.name.slice(0, 160),
          dataset: ds.label,
          reason: !nutrients ? 'no_nutrient_rows' : 'no_energy',
        });
        continue;
      }

      if (CURATION.excludeFdcIds.has(fdcId)) {
        droppedJunk.push({
          id: fdcId,
          name: food.name.slice(0, 160),
          reason: 'exclude_fdc_id',
        });
        continue;
      }

      const junk = isExcludedJunk(food.name);
      if (junk && !isForceIncluded(food.name, fdcId)) {
        droppedJunk.push({
          id: fdcId,
          name: food.name.slice(0, 160),
          reason: 'junk_pattern',
        });
        continue;
      }

      const capsBrand = isCapsBrand(food.name);
      if (capsBrand && !isForceIncluded(food.name, fdcId)) {
        droppedJunk.push({
          id: fdcId,
          name: food.name.slice(0, 160),
          reason: 'caps_brand',
        });
        continue;
      }

      const { category, subcategory } = resolveTaxonomy(
        fdcId,
        food.name,
        legacyByFdc
      );
      const state = describeState(food.name);

      candidates.push({
        id: `usda_${fdcId}`,
        fdcId,
        name: food.name,
        category,
        subcategory,
        calories: nutrients.calories,
        protein: nutrients.protein,
        carbs: nutrients.carbs,
        fats: nutrients.fats,
        fiber: nutrients.fiber,
        sodium: nutrients.sodium,
        saturatedFats: nutrients.saturatedFats,
        sugars: nutrients.sugars,
        portions: buildPortions(
          ds.portionsByFdc.get(fdcId) || [],
          ds.units,
          CURATION.maxPortionsPerFood
        ),
        groupKey: buildGroupKey(food.name, category, subcategory),
        state,
        dataset: ds.label,
      });
      byDatasetCounts[ds.label] += 1;
    }
  }

  // Curated manual rows: clone canonical nutrition + portions from a donor row
  // (see CURATION.manualFoods) so they are never invented numbers, and pin a
  // "kept" group key so they can never be collapsed away by variant rules.
  for (const manual of CURATION.manualFoods || []) {
    const donor = candidates.find(
      (candidate) => candidate.fdcId === String(manual.basedOnFdcId)
    );
    if (!donor) {
      droppedJunk.push({
        id: manual.key,
        name: manual.name,
        reason: 'manual_no_donor',
      });
      continue;
    }
    candidates.push({
      id: `curated_${manual.key}`,
      fdcId: manual.key,
      name: manual.name,
      category: manual.category,
      subcategory: manual.subcategory,
      calories: donor.calories,
      protein: donor.protein,
      carbs: donor.carbs,
      fats: donor.fats,
      fiber: donor.fiber,
      sodium: donor.sodium,
      saturatedFats: donor.saturatedFats,
      sugars: donor.sugars,
      portions: donor.portions,
      groupKey: `kept|${manual.category}|${manual.subcategory}|${manual.name.toLowerCase()}`,
      state: donor.state,
      dataset: 'curated',
    });
  }

  return { candidates, droppedJunk, nutrientGaps, byDatasetCounts };
};

const collapseCandidates = (candidates) => {
  const groups = new Map();
  const keptRows = [];
  const collapseStats = { groups: 0, collapsedMembers: 0, duplicateNames: 0 };

  for (const candidate of candidates) {
    if (candidate.groupKey.startsWith('collapse')) {
      if (!groups.has(candidate.groupKey)) groups.set(candidate.groupKey, []);
      const list = groups.get(candidate.groupKey);
      const existing = list.some((member) => member.id === candidate.id);
      if (!existing) list.push(candidate);
      else collapseStats.collapsedMembers += 1;
    } else {
      keptRows.push(candidate);
    }
  }

  const groupDecisions = [];
  for (const [key, members] of groups) {
    if (members.length <= 1) {
      keptRows.push(members[0]);
      continue;
    }
    const representatives = pickGroupRepresentatives(members);
    collapseStats.groups += 1;
    collapseStats.collapsedMembers += members.length - representatives.length;
    groupDecisions.push({
      key: String(key).split('|').pop(),
      category: members[0].category,
      subcategory: members[0].subcategory,
      memberCount: members.length,
      members: members.map((member) => ({
        id: member.id,
        name: member.name.slice(0, 140),
        state: member.state.state,
        method: member.state.method,
      })),
      kept: representatives.map((row) => ({
        id: row.id,
        name: row.name.slice(0, 140),
        state: row.state.state,
        method: row.state.method,
      })),
    });
    keptRows.push(...representatives);
  }

  // Exact same-name+category guard across datasets (e.g., SR vs Survey).
  const seen = new Set();
  const deduped = [];
  for (const row of keptRows) {
    const dedupeKey = `${row.name.toLowerCase()}|${row.category}`;
    if (seen.has(dedupeKey)) {
      collapseStats.duplicateNames += 1;
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(row);
  }

  return { rows: deduped, groupDecisions, collapseStats };
};

// ---- Database writer --------------------------------------------------------

const buildDatabaseSqliteBytes = async (SQL, rows) => {
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE foods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
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

  const insert = db.prepare(`
    INSERT INTO foods (id, name, category, subcategory, calories, protein, carbs, fats, fiber, sodium, saturated_fats, sugars, portions)
    VALUES (:id, :name, :category, :subcategory, :calories, :protein, :carbs, :fats, :fiber, :sodium, :saturated_fats, :sugars, :portions)
  `);

  const sorted = rows.slice().sort((a, b) => {
    const cat = (a.category || '').localeCompare(b.category || '');
    if (cat !== 0) return cat;
    const sub = (a.subcategory || '').localeCompare(b.subcategory || '');
    if (sub !== 0) return sub;
    return a.name.localeCompare(b.name);
  });

  for (const row of sorted) {
    insert.run({
      ':id': row.id,
      ':name': row.name,
      ':category': row.category || null,
      ':subcategory': row.subcategory || null,
      ':calories': row.calories,
      ':protein': row.protein ?? null,
      ':carbs': row.carbs ?? null,
      ':fats': row.fats ?? null,
      ':fiber': row.fiber ?? null,
      ':sodium': row.sodium ?? null,
      ':saturated_fats': row.saturatedFats ?? null,
      ':sugars': row.sugars ?? null,
      ':portions': JSON.stringify(row.portions || []),
    });
  }

  insert.free();

  const integrity = db.exec('PRAGMA integrity_check');
  const message = integrity?.[0]?.values?.[0]?.[0] ?? 'unknown';
  if (message !== 'ok') {
    db.close();
    throw new Error(`Integrity check failed: ${message}`);
  }

  const bytes = db.export();
  db.close();
  return bytes;
};

// ---- Reports ----------------------------------------------------------------

const summarizeRows = (rows) => {
  const categories = {};
  const subcategories = {};
  for (const row of rows) {
    const category = String(row.category || '(none)');
    const subcategory = String(row.subcategory || '(empty)');
    categories[category] = (categories[category] || 0) + 1;
    subcategories[subcategory] = (subcategories[subcategory] || 0) + 1;
  }
  return { totalRows: rows.length, categories, subcategories };
};

const writeJsonReport = async (fileName, payload) => {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const filePath = path.resolve(REPORTS_DIR, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
};

const sampleVisual = (list, count) => {
  if (list.length === 0) return [];
  const result = [];
  const step = Math.max(1, Math.floor(list.length / count));
  for (
    let offset = 0;
    offset < list.length && result.length < count;
    offset += step
  ) {
    const name = list[offset].name;
    result.push(name.length > 105 ? `${name.slice(0, 102)}...` : name);
  }
  return result;
};

// ---- Main -------------------------------------------------------------------

const findDatasetDirs = async () => {
  const entries = await fs.readdir(FDC_DOWNLOAD_DIR, { withFileTypes: true });
  const found = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    for (const kind of DATASET_KINDS) {
      if (lower.includes(kind.keyword) && !found[kind.label]) {
        found[kind.label] = path.join(FDC_DOWNLOAD_DIR, entry.name);
      }
    }
  }
  return found;
};

const loadLegacyTaxonomy = async (SQL) => {
  try {
    const buffer = await fs.readFile(SOURCE_DB_PATH);
    const db = new SQL.Database(new Uint8Array(buffer));
    const result = db.exec('SELECT id, category, subcategory FROM foods');
    db.close();
    const map = new Map();
    if (result[0]) {
      for (const [id, category, subcategory] of result[0].values) {
        map.set(String(id).replace(/^usda_/, ''), {
          category: category || null,
          subcategory: subcategory || null,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
};

const main = async () => {
  const args = parseArgs();
  const SQL = await initSqlJs();

  const dirs = await findDatasetDirs();
  const datasetKeys = ['foundation', 'sr'];
  if (args.useSurvey) datasetKeys.push('survey');

  const missing = datasetKeys.filter((key) => !dirs[key]);
  if (missing.length) {
    console.error(
      `Missing dataset folders in ${FDC_DOWNLOAD_DIR}: ${missing.join(', ')}`
    );
    globalThis.process.exitCode = 1;
    return;
  }

  const datasets = [];
  for (const key of datasetKeys) {
    const kind = DATASET_KINDS.find((entry) => entry.label === key);
    const dataset = await loadDataset(dirs[key], kind.dataType);
    dataset.label = key;
    datasets.push(dataset);
    console.log(`Loaded ${key}: ${dataset.foods.length} foods`);
  }

  const legacyByFdc = await loadLegacyTaxonomy(SQL);
  const { candidates, droppedJunk, nutrientGaps, byDatasetCounts } =
    assembleCandidates({ datasets, legacyByFdc });

  const { rows, groupDecisions, collapseStats } =
    collapseCandidates(candidates);

  // Friendly display names ("Chicken breast, raw") plus a guard against the
  // collisions the rename can introduce (two verbatim groups can normalize to
  // the same label).
  const seenNames = new Set();
  const finalRows = [];
  for (const row of rows) {
    const displayName = friendlyMeatName(row.name);
    const key = `${displayName.toLowerCase()}|${row.category}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    finalRows.push({ ...row, name: displayName });
  }

  const auditAfter = summarizeRows(finalRows);
  const auditBefore = summarizeRows(candidates);

  const keptByCategory = {};
  for (const row of finalRows) {
    const category = String(row.category || '(none)');
    if (!keptByCategory[category]) keptByCategory[category] = [];
    keptByCategory[category].push(row);
  }
  const keptSamplesByCategory = Object.fromEntries(
    Object.keys(keptByCategory).map((category) => [
      category,
      sampleVisual(keptByCategory[category], 24),
    ])
  );

  const emptySubRows = finalRows.filter(
    (row) => row.category && !row.subcategory
  );
  const emptySubsByCategory = {};
  for (const row of emptySubRows) {
    const cat = String(row.category);
    emptySubsByCategory[cat] = (emptySubsByCategory[cat] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    settings: {
      useSurvey: args.useSurvey,
      excludePatternCount: CURATION.excludePatterns.length,
      includePatternCount: CURATION.includePatterns.length,
      collapseEnabledSubcategories: CURATION.collapseEnabledSubcategories,
      maxStatesPerGroup: CURATION.maxStatesPerGroup,
      maxPortionsPerFood: CURATION.maxPortionsPerFood,
    },
    inputs: byDatasetCounts,
    candidatesPreCollapse: candidates.length,
    outputRows: finalRows.length,
    junkDropped: droppedJunk.length,
    nutrientGapsSkipped: nutrientGaps.length,
    collapseStats,
    audit: { before: auditBefore, after: auditAfter },
    emptySubsByCategory,
    emptySubSamples: emptySubRows.slice(0, 60).map((row) => row.name),
    keptSamplesByCategory,
    collapseGroups: groupDecisions.length > 0 ? groupDecisions : undefined,
    droppedJunkSample: droppedJunk.slice(0, 120),
    nutrientGapSample: nutrientGaps.slice(0, 60),
  };

  await writeJsonReport('curation.json', report);
  await writeJsonReport('curated.audit.json', {
    generatedAt: report.generatedAt,
    settings: report.settings,
    inputRows: candidates.length,
    outputRows: finalRows.length,
    junkDropped: droppedJunk.length,
    collapseStats,
    audit: auditAfter,
  });

  console.log(
    `Curated rows: ${finalRows.length} (candidates: ${candidates.length}). Junk dropped: ${droppedJunk.length}. Collapsed: ${collapseStats.groups} groups / ${collapseStats.collapsedMembers} members.`
  );
  console.log(`Reports written to ${path.join(REPORTS_DIR, 'curation.json')}`);

  if (args.dryRun) {
    console.log('Dry-run complete (no DB written).');
    return;
  }

  const bytes = await buildDatabaseSqliteBytes(SQL, finalRows);

  if (args.replace) {
    let backedUp = false;
    try {
      const sourceBuffer = await fs.readFile(SOURCE_DB_PATH);
      await fs.writeFile(BACKUP_DB_PATH, sourceBuffer);
      backedUp = true;
    } catch {
      // First run in a fresh repo: there is no previous catalog to back up.
    }
    const tempPath = `${SOURCE_DB_PATH}.tmp`;
    await fs.writeFile(tempPath, Buffer.from(bytes));
    await fs.rename(tempPath, SOURCE_DB_PATH);
    console.log(
      backedUp
        ? `Replaced ${SOURCE_DB_PATH} (backup: ${BACKUP_DB_PATH}).`
        : `Replaced ${SOURCE_DB_PATH} (no prior DB to back up).`
    );
  } else {
    await fs.writeFile(CURATED_DB_PATH, Buffer.from(bytes));
    console.log(`Wrote ${CURATED_DB_PATH}`);
  }
};

main().catch((error) => {
  console.error('Food DB build failed:', error);
  globalThis.process.exitCode = 1;
});
