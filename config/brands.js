// Brand curation for build-brands.js (FDC Branded Food Products dataset).
//
// The staple catalog intentionally junk-filters brands; the cloud catalog
// instead CLEANS them into `foods` rows (same table, `brand` set). This file
// is the refinement dial for that pass: tweak and re-run
//   node build-brands.js --dry-run
// then inspect reports/brands.json for every drop/keep decision.
//
// Seed policy (first pass): only "verified-complete" rows ship — every kept
// row carries all four macros (calories > 0, protein/carbs/fats present) AND a
// serving size convertible to grams, so every row has a real household
// portion on top of the always-first `100g` entry. Everything else is dropped
// with a reason in reports/brands.json.

export const BRAND_CURATION = {
  // ---- Verified-complete gate ------------------------------------------------
  requireName: true,
  // Branded rows must carry a brand (brand_owner / brand_name). NULL brand is
  // reserved for staple/generic rows in the shared `foods` table, so rows that
  // FDC lists with no brand at all are dropped as `no_brand`.
  requireBrand: true,
  // All four macros must be present (calories > 0, protein/carbs/fats in
  // macroBounds). Rows missing any macro are dropped as `missing_macro`.
  requireCompleteMacros: true,
  // The serving size must convert to positive grams (well-defined unit or an
  // embedded "(N g)"/(N ml) in the household text). Rows that cannot are
  // dropped as `no_convertible_serving`.
  requireConvertibleServing: true,

  // ---- Deduplication ----------------------------------------------------------
  // 'gtin' collapses rows that share a zero-padded gtin_upc (preferring the
  // as-purchased preparation state); 'fingerprint' collapses rows (no GTIN)
  // with identical normalized name + brand + macro signature. Empty/[] to
  // disable a pass.
  dedupeBy: ['gtin', 'fingerprint'],

  // Brand rows that are near-identical twins of an existing staple
  // (same lowercase name + category in foodDatabase.sqlite) are dropped so
  // online search never shadows the curated staple. 'keep' to disable.
  stapleCollisionMode: 'drop',

  // Row cap when writing (0 = unlimited). Keeps early cloud seeds sane while
  // the curation rules are dialed in; raise or remove once audits look right.
  maxRows: 0,

  // Category assigned when no BRAND_CLASSIFY_RULES entry matches. 'uncategorized'
  // is legal for taxo-check (NULL subcategory stays honest); switch to 'carbs'
  // if you would rather overweight the processed-food long tail.
  fallbackCategory: 'uncategorized',

  // ---- Placeholder / non-food detectors (matched against the DESCRIPTION) ----
  // Branded rows are deliberately more permissive than the staple pass — bad
  // rows just get dropped (one row = one product).
  excludePatterns: [
    /^product$/i,
    /^undefined$/i,
    /^null$/i,
    /^n\/a$/i,
    /\bUNKNOWN\b/i,
    // Pet / infant / formula (not staple-compatible)
    /PET FOOD|CAT FOOD|DOG FOOD|KITTEN|PUPPY|\bPET\b|BABY FORMULA|TODDLER FORMULA|INFANT FORMULA|\bBABY FOOD\b|\bBABYFOOD\b|\bINFANT\b/,
    // Vapes / devices / non-edible consumables
    /E[- ]?CIGARETTE|\bVAPE\b|VAPORIZER|NICOTINE|E[- ]?LIQUID/i,
    // Personal care / household (GDSN mislabeled food GTINs surface here)
    /ELECTRONIC|DEVICE|CLEANER|\bSOAP\b|SHAMPOO|DETERGENT|DISINFECTANT|MOUTHWASH|TOOTHPASTE|DEODORANT|\bLOTION\b|SUNSCREEN|CANDLE|AIR FRESHENER|LAUNDRY|DISHWASHER/i,
    // Food intended for animals (spelled out — keep the exotic-wildlife list out)
    /FOOD (?:FOR|WITH) (?:DOGS|CATS)|\bFOR (?:DOGS|CATS)\b/i,
    // Script junk / obvious non-Latin products (CJK, Cyrillic, Hangul, Kana…)
    /[\u0400-\u04FF\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/,
    // Control characters (unprintable garbage)
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/,
  ],
// Force-keep brand owners even if a description hits an exclude pattern.
  includeOwners: new Set(),

  // Force-drop brand owners wholesale (multi-level-marketing / bulk powders etc.).
  excludeOwners: new Set(['THRIVE LIFE']),

  // ---- Per-100g bounds (post-normalization sanity) --------------------------
  macroBounds: {
    calories: { min: 1, max: 900 }, // per 100g; pure fats cap ~884
    grams: { min: 0, max: 100 }, // protein / carbs / fats per 100g
  },

  // ---- Calorie consistency (4/4/9 Atwater, per 100g) -------------------------
  // Label calories vs macros-derived calories. Rows only get DROPPED when the
  // gap is severe AND macros are complete (they are here); smaller gaps land
  // in the report as warn buckets so no data is silently discarded.
  calorieConsistency: {
    enabled: true,
    warnGapPercent: 0.25, // warn when |calc - label| > 25%…
    warnGapKcal: 50, // …and > 50 kcal absolute
    dropGapPercent: 0.5, // drop only when > 50% off…
    dropGapKcal: 200, // …and > 200 kcal absolute
  },
};

// ---- Portion unit -> grams-per-unit (water-density approx for ml/fl-oz) -----
// Well-defined mass/volume units only; cooking-ish guesses (slice/piece/bar)
// are deliberately absent — household text like "1 slice (28g)" is handled by
// the embedded-grams parser instead, so we never invent conversions.
export const SERVING_UNIT_TO_GRAMS = Object.freeze({
  g: 1, gram: 1, grams: 1, gr: 1,
  kg: 1000,
  mg: 0.001,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, pound: 453.592, pounds: 453.592,
  ml: 1, milliliter: 1, milliliters: 1,
  l: 1000, liter: 1000, liters: 1000,
  tsp: 4.92892, teaspoon: 4.92892, teaspoons: 4.92892,
  tbsp: 14.7868, tablespoon: 14.7868, tablespoons: 14.7868,
  cup: 240, cups: 240,
  pint: 473.176, pints: 473.176,
  quart: 946.353, quarts: 946.353,
  gal: 3785.41, gallon: 3785.41, gallons: 3785.41,
  'fl oz': 29.5735, 'fl fluid ounce': 29.5735, 'fluid ounce': 29.5735,
});

// ---- Brand classification rules -> canonical (category, subcategory) --------
// First matching rule wins; order matters (specific before general). Subcategories
// reference config/taxonomy.js CANONICAL_SUBCATEGORY_BY_CATEGORY — build-brands
// fails fast if a rule points at a non-canonical value.
export const BRAND_CLASSIFY_RULES = [
  // Supplements / performance
  { category: 'protein', subcategory: 'protein_powder', patterns: [/protein powder|whey protein|whey isolate|casein protein|casein isolate|pea protein|soy protein|rice protein|hemp protein|mass gainer|protein supplement/] },
  { category: 'supplements', subcategory: 'electrolytes', patterns: [/electrolyte/] },
  { category: 'supplements', subcategory: 'preworkout', patterns: [/pre[- ]?workout|creatine|beta[- ]?alanine|nitric oxide|caffeine (?:pills|tablets|caps)|thermogenic/] },
  { category: 'supplements', subcategory: 'amino_acids', patterns: [/\bamino\b|\bbcaa(?:s)?\b|glutamine|leucine|taurine/] },
  { category: 'supplements', subcategory: 'vitamin_mineral', patterns: [/multivitamin|vitamin (?:[a-z]|[0-9])|vitamin[- ]|mineral (?:supplement|tablet)|calcium|magnesium|zinc|lutein|antioxidant|omega[- ]?3|fish oil/] },
  { category: 'supplements', subcategory: 'general', patterns: [/probiotic|collagen|digestive enzyme|ashwagandha|melatonin|\bsupplement\b/] },

  // Protein (higher-specificity cuts first)
  { category: 'protein', subcategory: 'processed_meat', patterns: [/\bbacon\b|sausage|hot dog|pepperoni|salami|prosciutto|chorizo|\bham\b|deli meat|lunch meat|jerky|bologna|baloney|corned beef|pastrami/] },
  { category: 'protein', subcategory: 'plant_based', patterns: [/almond milk|oat milk|soy milk|coconut milk|cashew milk|tofu|tempeh|seitan|plant[- ]?based|vegan|vegetarian|meat(?:less|\s+substitute)|textured vegetable protein|\bTVP\b|impossible burger|beyond meat/] },
  { category: 'protein', subcategory: 'poultry', patterns: [/\bchicken\b|\bturkey\b|\bduck\b|\bgoose\b|\bquail\b|\bpoultry\b|pheasant|\bhen\b|\bbroiler\b|chicken nugget|chicken tender|chicken wing/] },
  { category: 'protein', subcategory: 'beef', patterns: [/\bbeef\b|\bsteak\b|ground beef|burger (?:patty|patties)|ribeye|sirloin|tenderloin|brisket|meatloaf|beef jerky/] },
  { category: 'protein', subcategory: 'pork', patterns: [/\bpork\b|pork chop|pork loin|pulled pork|spareribs|baby back ribs|pork belly/] },
  { category: 'protein', subcategory: 'fish', patterns: [/\bsalmon\b|\btuna\b|\bcod\b|\btilapia\b|halibut|trout|sardine|anchov|mackerel|\bfish\b|flounder|catfish|fish stick|fish fillet/] },
  { category: 'protein', subcategory: 'shellfish', patterns: [/\bshrimps?\b|\bprawns?\b|\bcrabs?\b|\blobsters?\b|\boysters?\b|\bclams?\b|\bmussels?\b|\bscallops?\b|\bsquid\b|calamari/] },

  // Baked goods first so "cheese bread"/"garlic bread" beat the dairy/allium cuts.
  { category: 'carbs', subcategory: 'bread', patterns: [/\bbreads?\b|\bbagels?\b|brioche|croissant|\bmuffins?\b|\brolls?\b|\bbuns?\b|\btoasts?\b|english muffin|\btortillas?\b|\bwrap\b|\bpita\b|\bnaan\b|\bbiscuits?\b|flatbread/] },
  { category: 'protein', subcategory: 'dairy', patterns: [/\bcheeses?\b|\byogurts?\b|\byoghurts?\b|\bkefir\b|buttermilk|\bmilks?\b|creamer|cream cheese|ricotta|mozzarella|parmesan|feta\b|half[ -]?and[ -]?half|sour cream|cottage cheese|quesos?\b|quesadillas?\b/] },
  { category: 'protein', subcategory: 'eggs', patterns: [/\beggs?\b(?!plant)|egg white|egg yolk|omelet|omelette|frittata|quiche|egg salad|deviled egg/] },

  // Fats & spreads
  { category: 'fats', subcategory: 'spread', patterns: [/\bpeanut butter\b|almond butter|cashew butter|nut butter|margarine|butter alternative|cream cheese spread|yogurt spread|\bspread\b/] },
  { category: 'fats', subcategory: 'dairy_fat', patterns: [/\bbutter\b|\bghee\b|clarified butter/] },
  { category: 'fats', subcategory: 'oil', patterns: [/\boil\b|cooking spray|shortening/] },
  { category: 'fats', subcategory: 'nuts', patterns: [/\bnuts?\b|\bwalnuts?\b|\bpecans?\b|hazelnuts?\b|macadamias?\b|pistachios?\b|\btrail mix\b/] },
  { category: 'fats', subcategory: 'seeds', patterns: [/chia seeds?\b|flax seeds?\b|\bflax\b|hemp seeds?\b|sesame seeds?\b|sunflower seeds?\b|pumpkin seeds?\b|poppy seeds?\b|seed mix/] },
  { category: 'fats', subcategory: 'animal_fat', patterns: [/\blard\b|\btallow\b|bacon fat|duck fat|schmaltz/] },

  // Vegetables
  { category: 'vegetables', subcategory: 'leafy_green', patterns: [/\bspinach\b|\bkale\b|\blettuce\b|arugula|romaine|collard greens|\bchard\b|spring greens|\bmixed greens\b/] },
  { category: 'vegetables', subcategory: 'cruciferous', patterns: [/\bbroccoli\b|cauliflower|brussels sprout|\bcabbage\b|bok choy|kohlrabi|\bradish\b/] },
  { category: 'vegetables', subcategory: 'allium', patterns: [/\bonion\b|\bgarlic\b|\bleek\b|\bshallot\b|scallion|\bchive\b/] },
  { category: 'vegetables', subcategory: 'nightshade', patterns: [/\btomatoes?\b|salsa verde|tomatillo|\bpeppers?\b(?! ?jack)|\bchiles?\b|chili peppers?\b|jalapenos?\b|habaneros?\b|anaheim peppers?\b|bell peppers?\b/] },
  { category: 'vegetables', subcategory: 'root', patterns: [/\bcarrot\b|\bbeet\b|\bparsnip\b|\bturnip\b|rutabaga|\byam\b/] },
  { category: 'vegetables', subcategory: 'other_vegetable', patterns: [/\bavocado\b|\bmushroom\b|\bzucchini\b|\bsquash\b|\bcucumber\b|\bcelery\b|asparagus|green bean|snap pea|snow pea|\bartichoke\b|\bokra\b|(?:sweet )?corn\b(?! chips| meal)|\bpeas?\b/] },

  // Carbs
  { category: 'carbs', subcategory: 'starchy_vegetable', patterns: [/\bpotatoes?\b|french fr(?:y|ies)|hash brown|tater|\bplantains?\b/] },
  { category: 'carbs', subcategory: 'legumes', patterns: [/\bbeans?\b|\blentils?\b|\bchickpeas?\b|garbanzo|\bhummus\b|refried beans?\b|baked beans?\b|soybeans?\b|edamame/] },
  { category: 'carbs', subcategory: 'sweets', patterns: [/\bchocolates?\b|\bcand(?:y|ies)\b|gummy|caramel|toffee|marshmallow|\bcookies?\b|\bcakes?\b|\bbrownies?\b|\bdonuts?\b|\bdoughnuts?\b|\bpie(?:s)?\b|pastry|ice cream|gelato|sorbet|custard|\bpuddings?\b|cheesecake|\bmousse\b|fruit snack|granola bar|energy bar|candy bar|\bsyrups?\b|\bhoney\b|\bjams?\b|\bjellies?\b|marmalade|lollipops?|licorice|topping|frosting|\bicing\b|sweetener/] },
  { category: 'carbs', subcategory: 'bread', patterns: [/\bbread\b|\bbagel\b|brioche|croissant|\bmuffin\b|\brolls?\b|\bbuns?\b|toast|english muffin|\btortilla\b|\bwrap\b|\bpita\b|\bnaan\b/] },
  { category: 'carbs', subcategory: 'grains', patterns: [/\brice\b|\boats?\b|oatmeal|quinoa|\bpastas?\b|\bspaghetti\b|\bmacaroni\b|\bpenne\b|noodles?\b|ramen|\bcereals?\b|muesli|\bgrits\b|\bbarley\b|farro|couscous|\bmillet\b|\bcrackers?\b|\bpretzels?\b|\bpopcorn\b|chips?\b|bread crumbs?\b|corn meal|flour\b/] },
  { category: 'carbs', subcategory: 'beverages', patterns: [/\bsodas?\b|\bcolas?\b|lemonade|iced tea|sweet tea|\bjuices?\b|smoothies?\b|energy drinks?\b|sports drinks?\b|powerade|gatorade|coconut water|\bcoffees?\b|espresso|cappuccino|\blattes?\b|\bteas?\b|hot chocolate|\bcocoa\b|\bwater\b|sparkling water|\bseltzers?\b|tonic water|milkshakes?\b|protein shakes?\b|drink mix|powdered drink/] },
  { category: 'carbs', subcategory: 'fruit', patterns: [/\bapples?\b|\bbananas?\b|\boranges?\b|\bgrapes?\b|strawberr|blueberr|raspberr|blackberr|\bpeaches?\b|\bpears?\b|pineapple|\bmango(?:es)?\b|\bkiwis?\b|\bmelons?\b|watermelon|\bcherries?\b|\bplums?\b|\bapricots?\b|\bfruits?\b|\bberries?\b/] },
  { category: 'carbs', subcategory: 'condiments', patterns: [/\bketchup\b|mustard|\bmayo\b|mayonnaise|\brelish\b|\bsalsa\b|bbq sauce|hot sauce|soy sauce|teriyaki|marinara|pasta sauce|tomato sauce|\bgravy\b|hollandaise|\bdressing\b|vinaigrette|ranch dip|\bguacamole\b|\bpesto\b|sriracha|\btahini\b|\bpickle\b|\bolives?\b|\bolive oil\b|vinegar|worcestershire|cocktail sauce|horseradish|chutney|taco sauce|enchilada sauce/] },
  { category: 'carbs', subcategory: 'alcohol', patterns: [/\bbeer\b|\bale\b|\blager\b|\bstout\b|\bporter\b|whiskey|whisky|bourbon|\bscotch\b|\bvodka\b|\bgin\b|\btequila\b|\bmead\b|brandy|cognac|champagne|prosecco|\brum\b|hard cider|hard seltzer|\bwine\b(?! vinegar)|liqueur|mezcal|\bsake\b/] },
];
