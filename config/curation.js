// Curation config for the from-scratch food catalog builder (scripts/food-db/build.js).
//
// This file is the refinement dial: edit the arrays below, re-run
//   node scripts/food-db/build.js --dry-run
// and inspect scripts/food-db/reports/curation.json to see every decision.

export const CURATION = {
  // Include the Survey/FNDDS 2024-10-31 dataset by default. The lean baseline
  // (scope B) builds from Foundation + SR Legacy + Survey; FNDDS adds the
  // grocery-fridge staples (milks, milk alternatives like almond/oat milk,
  // cereals, cheeses, soups). Foods still pass the same junk + caps + collapse
  // filters. Set to false for the Foundation+SR-only baseline; the --survey CLI
  // flag can only force it ON, never off.
  useSurvey: true,

  // Junk detectors (case-insensitive, matched against the full food name).
  // Anything matching is dropped UNLESS it also matches an INCLUDE rule.
  excludePatterns: [
    // Fast food / restaurant chains
    /MCDONALD|BURGER KING|TACO BELL|PIZZA HUT|DOMINO|SUBWAY|ARBY|KFC|WENDY|CHICK.FIL|WHITE CASTLE|HARDEE|CARL.S JR|DAIRY QUEEN|LONG JOHN SILVER|PAPA JOHN|POPEYES|FIVE GUYS|JACK IN THE BOX|STEAK N SHAKE|CULVER|WHATABURGER|CHECKERS|BOJANGLES|ZAXBY|MOE.S|BUFFALO WILD|RUBY TUESDAY|TGI FRIDAY|T\.G\.I\.|DENNY|IHOP|APPLEBEE|OUTBACK|OLIVE GARDEN|RED LOBSTER|CHEESECAKE FACTORY|BOSTON MARKET|CHURCH.S|CARRABBA/i,
    // National food brands that bracket SR Legacy rows
    /KRAFT|KELLOGG|GENERAL MILLS|NESTLE|STOUFFER|LEAN CUISINE|HEALTHY CHOICE|SMART ONES|OREO|RITZ|CORNNUTS|BIRDS EYE|ORE.IDA|KASHI|LIPTON|KNORR|CAMPBELL|PROGRESSO|PREGO|CLASSICO|RAGU|WISH.BONE|HIDDEN VALLEY|FRENCH.S|HEINZ|HUNT.S|SKIPPY|PLANTERS|PETER PAN|QUAKER|GENERAL FOODS|HERB.OX|WYLER|SWANSON|CARNATION|GOYA|KROGER|GREAT VALUE|STORE BRAND|HERSHEY|GRANDMA|PENNILESS|MARS|MUSKETEERS|\bYORK\b|HEATH|KIT KAT|SMUCKER|CADBURY|SNICKERS|MILKY WAY|TWIX|REESE|SKITTLES|M&M\b|ROLLO|TABASCO|DIGIORNO|MEAD JOHNSON|ENFAGROW|ENFAMIL|SMART SOUP|LITTLE CAESARS|ABBOTT|PEDIASURE|SOUTH BEACH|ZONE PERFECT|BALANCE BAR|\bCLIF\b|HAIN|TERRA CHIPS|GATORADE|CHOBANI|OIKOS|SILK|RALSTON|BREYERS|BOLTHOUSE|HORMEL|OVALTINE|BIMBO|VITASOY|NASOYA|AZUMAYA/i,
    // Meaningless / survey-quality descriptors
    /FAST FOOD|RESTAURANT|FROM KID.S MENU|COMBO MEAL|NS AS TO|NOT FURTHER SPECIFIED|NOT SPECIFIED|UNSPECIFIED|TYPE NOT SPECIFIED|AS PURCHASED|\bNFS\b|COMMERCIALLY PREPARED|USDA COMMODITY|SCHOOL LUNCH|CHILD NUTRITION|WIC PROGRAM|BABY FOOD|BABYFOOD|\bINFANT\b|TODDLER FORMULA|LIQUID FROM|CANNOT READ|UNABLE TO|WHITE SPOTS|WATER, LOW MINERAL|CANNED, MIXED|IT'S A\u2122/i,
    // Wildlife / indigenous-program foods (rare or unusable for normal logging)
    /ALASKA NATIVE|AMERICAN INDIAN|NAVAJO|SHOSHONE BANNOCK|NATIVE AMERICAN|SOUTHWEST|NORTHERN PLAINS INDIANS|\bKLAMATH\b|\bMOOSE\b|\bWALRUS\b|\bCARIBOU\b|\bSEAL\b|\bOWL\b|\bSQUIRREL\b|\bOPOSSUM\b|\bMUSKRAT\b|\bGROUNDHOG\b|\bPORCUPINE\b|\bBEAVER\b|\bBEAR\b/i,
    // Niche offal by-products (keep the common heart/liver/kidneys/tongue)
    /variety meats and by-products, (?:brain|ears|feet|jowl|leaf fat|lungs|pancreas|spleen|stomach|tail|chitterlings|mechanically separated)|headcheese/i,
  ],

  // Force-keep rules (case-insensitive). Matches here survive any exclude match
  // and are never collapsed away. Add your own lines to protect foods you want.
  includePatterns: [
    /\bTVP\b|TEXTURED VEGETABLE PROTEIN/i,
    /NUTRITIONAL YEAST/i,
  ],

  // Per-food overrides by fdc_id (raw digits, no "usda_" prefix).
  excludeFdcIds: new Set(),

  // Force-keep rows whose ALL-CAPS product names get flagged by the caps-brand
  // detector (e.g. "Cereals, CREAM OF WHEAT, ..."). Real SR staples that should
  // survive the long-tail brand filter.
  includeFdcIds: new Set([
    '171657', // CREAM OF WHEAT, regular (10 minute), cooked
    '171658', // farina (incl. CREAM OF WHEAT), quick, dry
    '171659', // farina (incl. CREAM OF WHEAT), quick, cooked
    '171660', // CREAM OF WHEAT, instant, dry
    '173900', // CREAM OF RICE, dry
    '173914', // CREAM OF RICE, cooked with water
  ]),

  // Curated rows that don't exist in FDC's Foundation/SR CSV datasets (they are
  // branded-only foods, or common consumer forms USDA never published). Each
  // entry CLONES the per-100g nutrition + portions from a donor fdc_id so the
  // numbers stay canonical and reviewable, and always gets a "kept" group key so
  // it can never be collapsed away. Prove your numbers by checking the donor.
  manualFoods: [
    {
      key: 'chicken_breast_raw_frozen',
      name: 'Chicken breast, raw, frozen',
      category: 'protein',
      subcategory: 'poultry',
      basedOnFdcId: '171077', // SR raw skinless-boneless breast (120 kcal/100g)
    },
    {
      key: 'rice_jasmine_raw',
      name: 'Rice, jasmine, raw',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '168877', // long-grain white rice, raw
    },
    {
      key: 'rice_jasmine_cooked',
      name: 'Rice, jasmine, cooked',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '168878', // long-grain white rice, cooked
    },
    {
      key: 'rice_basmati_raw',
      name: 'Rice, basmati, raw',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '168877', // long-grain white rice, raw
    },
    {
      key: 'rice_basmati_cooked',
      name: 'Rice, basmati, cooked',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '168878', // long-grain white rice, cooked
    },
    {
      key: 'pasta_penne_dry',
      name: 'Penne pasta, dry',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '169736', // pasta, dry, enriched
    },
    {
      key: 'pasta_penne_cooked',
      name: 'Penne pasta, cooked',
      category: 'carbs',
      subcategory: 'grains',
      basedOnFdcId: '169737', // pasta, cooked, enriched
    },
  ],

  // Drop rows whose name contains an ALL-CAPS token (3+ letters) outside the
  // allowlist. SR Legacy encodes brand blocks in ALL CAPS (RED BULL, EVIAN,
  // BUDWEISER, DASANI, V8 SPLASH...) and the explicit lists never fully cover
  // that long tail. Legit descriptions are sentence-case and never trigger it.
  excludeCapsTokens: true,
  capsAllowlist: ['USDA', 'USA', 'NS', 'NFS', 'TVP', 'WIC', 'NLEA', 'BBQ'],

  // ---- Variant collapsing -------------------------------
  // Turns "Pork, fresh, loin, whole, separable lean and fat, cooked, roasted"
  // (+ braised/broiled/... plus raw rows) into a single group kept as at most
  // `maxStatesPerGroup` representatives.
  collapseEnabledSubcategories: [
    'beef',
    'pork',
    'poultry',
    'fish',
    'shellfish',
    'eggs',
  ],
  maxStatesPerGroup: 2,

  // Tokens stripped (with surrounding punctuation) before building a group key.
  purgeTokens: [
    /\bfresh\b/gi,
    /,?\s*separable lean and fat/gi,
    /,?\s*separable lean only/gi,
    /,?\s*separable fat/gi,
    /,?\s*with separable[^,]*/gi,
    /,?\s*\[?all classes\]?/gi,
    /,?\s*(?:choice|select|prime)\b/gi,
    /,?\s*as purchased/gi,
    /,?\s*not further specified/gi,
    /,?\s*NS as to[^,]*/gi,
    /\bgrass[ -]?fed\b/gi,
    /\borganic\b/gi,
    /\bimported\b/gi,
    /\baustralian\b/gi,
    /\bnew zealand\b/gi,
    /\bcanadian\b/gi,
    /\bcommodity\b/gi,
    /\benhanced\b/gi,
    /,?\s*with added solution\b/gi,
    /,?\s*without added solution\b/gi,
    /,?\s*without solution\b/gi,
    /\bbone-in\b/gi,
    /\bboneless\b/gi,
    /\bfrozen\b/gi,
    /,?\s*trimmed to[^,]*/gi,
    /,?\s*untrimmed\b/gi,
  ],

  // Which cook/prep method to keep when several cooked variants exist in a group.
  cookedPreference: [
    'roasted',
    'braised',
    'broiled',
    'grilled',
    'pan-fried',
    'pan fried',
    'fried',
    'microwaved',
    'baked',
    'boiled',
    'stewed',
    'sautéed',
    'sauteed',
    'cooked',
  ],

  // Max household portions stored per food (the "100g" entry is always added).
  maxPortionsPerFood: 8,
};
