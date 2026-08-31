export const CANONICAL_CATEGORIES = new Set([
  'protein',
  'carbs',
  'vegetables',
  'fats',
  'supplements',
  'custom',
  'manual',
]);

export const CATEGORY_ALIASES = {
  proteins: 'protein',
  protein_food: 'protein',
  carbohydrate: 'carbs',
  carbohydrates: 'carbs',
  vegetable: 'vegetables',
  veggie: 'vegetables',
  fat: 'fats',
  oils: 'fats',
  oil: 'fats',
  supplement: 'supplements',
  other: 'supplements',
};

export const CANONICAL_SUBCATEGORY_BY_CATEGORY = {
  protein: new Set([
    'poultry',
    'beef',
    'pork',
    'fish',
    'shellfish',
    'dairy',
    'eggs',
    'plant_based',
    'protein_powder',
    'processed_meat',
  ]),
  carbs: new Set([
    'grains',
    'bread',
    'fruit',
    'starchy_vegetable',
    'legumes',
    'beverages',
    'sweets',
    'condiments',
    'alcohol',
  ]),
  vegetables: new Set([
    'leafy_green',
    'cruciferous',
    'root',
    'allium',
    'nightshade',
    'other_vegetable',
  ]),
  fats: new Set(['oil', 'nuts', 'seeds', 'dairy_fat', 'animal_fat', 'spread']),
  supplements: new Set([
    'protein',
    'amino_acids',
    'vitamin_mineral',
    'electrolytes',
    'preworkout',
    'general',
  ]),
  custom: new Set(['custom']),
  manual: new Set(['manual']),
};

export const SUBCATEGORY_ALIASES = {
  // Generic cleanup
  uncategorized: null,
  unknown: null,
  unspecified: null,
  mixed_meal: null,
  mixedmeal: null,
  mixed_meals: null,

  // Protein
  fish_and_seafood: 'fish',
  seafood: 'shellfish',
  dairy_alt: 'dairy',
  dairy_alternative: 'dairy',
  plantbased: 'plant_based',
  plant_based_protein: 'plant_based',
  protein_powder: 'protein_powder',

  // Carbs
  potato: 'starchy_vegetable',
  starch: 'starchy_vegetable',
  sweetener: 'sweets',
  soft_drink: 'beverages',

  // Vegetables
  green: 'leafy_green',
  cruciferous_veg: 'cruciferous',
  other: 'other_vegetable',

  // Fats
  butter: 'dairy_fat',
  oils: 'oil',

  // Supplements
  other_supplement: 'general',
};

export const INVALID_PORTION_LABELS = new Set([
  'quantity not specified',
  'qty not specified',
  'not specified',
  'unknown',
  'unspecified',
  'n/a',
  '-',
  'serving',
  'portion',
]);
