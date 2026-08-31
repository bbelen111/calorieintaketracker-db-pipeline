/**
 * Canonical micronutrient definitions for the Energy Map nutrition system.
 *
 * Added nutrients: Fiber, Sodium, Saturated Fat, Sugars.
 *
 * Units:
 *   - fiber / saturatedFats / sugars -> grams (1 decimal)
 *   - sodium -> milligrams (whole integer)
 *
 * Null semantics: `null` means "untracked / unknown" (rendered as —).
 * A numeric `0` means "measured zero" and is a real value. This distinction
 * matters for data honesty: an apple with no fiber backfill must not render
 * as "0g fiber", while pure olive oil's ~0 sodium may legitimately be 0.
 *
 * Soft invariants (source-scoped): we never hard-reject data. Violations
 * clamp the child value and are flagged in `relaxedKeys` / `warnings`,
 * mirroring the app's soft-anchor philosophy (macro locks, NEAT clamps).
 *
 * Carb standard note: USDA "Carbohydrate, by difference" (and the bundled
 * USDA-derived catalog) INCLUDES fiber inside total carbohydrates, so
 * (sugars + fiber) must fit. OpenFoodFacts / EU labels report net
 * (digestible) carbohydrates with fiber listed completely separately, so
 * fiber may legitimately exceed the reported carbohydrate figure (oats,
 * bran, chia) - the fiber invariant only applies to verified US sources.
 */

export const NUTRIENT_KEYS = ['fiber', 'sodium', 'saturatedFats', 'sugars'];

export const NUTRIENT_UNIT = Object.freeze({
  fiber: 'g',
  sodium: 'mg',
  saturatedFats: 'g',
  sugars: 'g',
});

export const NUTRIENT_DECIMALS = Object.freeze({
  fiber: 1,
  sodium: 0,
  saturatedFats: 1,
  sugars: 1,
});

export const NUTRIENT_BOUNDS = Object.freeze({
  fiber: { min: 0, max: 1000 },
  sodium: { min: 0, max: 10000 }, // mg
  saturatedFats: { min: 0, max: 1000 },
  sugars: { min: 0, max: 1000 },
});

export const NUTRIENT_META = Object.freeze({
  fiber: { label: 'Fiber', unit: 'g', color: 'green', decimals: 1 },
  sodium: { label: 'Sodium', unit: 'mg', color: 'indigo', decimals: 0 },
  saturatedFats: {
    label: 'Sat. Fat',
    unit: 'g',
    color: 'yellow',
    decimals: 1,
  },
  sugars: { label: 'Sugars', unit: 'g', color: 'pink', decimals: 1 },
});

export const EMPTY_NUTRIENTS = Object.freeze({
  fiber: null,
  sodium: null,
  saturatedFats: null,
  sugars: null,
});

// Source-scoped soft invariant rules. `usda` also applies the stricter
// sugars + fiber <= carbs rule because US "carb by difference" includes fiber.
export const NUTRIENT_INVARIANT_SCOPES = Object.freeze({
  usda: [
    'saturated_fat_le_total_fat',
    'sugars_le_carbs',
    'sugars_plus_fiber_le_carbs',
  ],
  off: ['saturated_fat_le_total_fat', 'sugars_le_carbs'],
  default: ['saturated_fat_le_total_fat', 'sugars_le_carbs'],
});

// Acceptance tolerance for the sugars rule. Small violations caused by label
// rounding / net-carbs subtleties are allowed through; only larger gaps clamp.
const SUGARS_CARBS_TOLERANCE = 1.05;

// Sodium from salt: NaCl is ~39.34% sodium by mass (22.99 / 58.44).
const OFF_SALT_TO_SODIUM_FACTOR = 393.4;

const toFiniteNumberOrNull = (value) => {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const roundNutrientValue = (value, key) => {
  const decimals = NUTRIENT_DECIMALS[key] ?? 1;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Normalize a single nutrient value against its canonical bounds + rounding.
 * Returns `null` for untracked/unknown input, a numeric value otherwise.
 */
export const normalizeNutrientValue = (value, key) => {
  const raw = toFiniteNumberOrNull(value);
  if (raw == null) {
    return null;
  }
  const bounds = NUTRIENT_BOUNDS[key] ?? { min: 0, max: Infinity };
  const clamped = Math.min(Math.max(raw, bounds.min), bounds.max);
  return roundNutrientValue(clamped, key);
};

/**
 * Normalize a full nutrient payload (object keyed by NUTRIENT_KEYS) and apply
 * source-scoped soft invariants against the parent (macro) totals.
 *
 * `options.source` selects the invariant scope:
 *   - 'usda' | 'local' -> US carb standard (fiber inside carbs)
 *   - 'off'  -> EU net-carbs labeling (fiber unconstrained)
 *   - anything else -> conservative default (fiber unconstrained)
 *
 * Returns `{ nutrients, relaxedKeys, warnings }`. Child values that violate a
 * rule are clamped; the affected keys are listed in `relaxedKeys` and a human
 * readable reason is appended to `warnings`.
 */
export const normalizeNutrients = (value, options = {}) => {
  const { parentTotals = {}, source = null } = options;

  const nutrients = {};
  NUTRIENT_KEYS.forEach((key) => {
    nutrients[key] = normalizeNutrientValue(value?.[key], key);
  });

  const relaxedKeys = [];
  const warnings = [];
  const fats = toFiniteNumberOrNull(parentTotals?.fats);
  const carbs = toFiniteNumberOrNull(parentTotals?.carbs);

  const scope =
    NUTRIENT_INVARIANT_SCOPES[source] ?? NUTRIENT_INVARIANT_SCOPES.default;
  const rules = new Set(scope);

  if (
    rules.has('saturated_fat_le_total_fat') &&
    nutrients.saturatedFats != null &&
    fats != null &&
    nutrients.saturatedFats > fats
  ) {
    nutrients.saturatedFats = roundNutrientValue(
      Math.max(0, fats),
      'saturatedFats'
    );
    relaxedKeys.push('saturatedFats');
    warnings.push('Saturated fat exceeded total fat; clamped to total fat.');
  }

  if (
    rules.has('sugars_le_carbs') &&
    nutrients.sugars != null &&
    carbs != null &&
    nutrients.sugars > carbs * SUGARS_CARBS_TOLERANCE
  ) {
    nutrients.sugars = roundNutrientValue(Math.max(0, carbs), 'sugars');
    relaxedKeys.push('sugars');
    warnings.push('Sugars exceeded total carbohydrates; clamped to carbs.');
  }

  if (
    rules.has('sugars_plus_fiber_le_carbs') &&
    nutrients.fiber != null &&
    nutrients.sugars != null &&
    carbs != null &&
    nutrients.sugars + nutrients.fiber > carbs
  ) {
    const residual = Math.max(0, carbs - nutrients.sugars);
    nutrients.fiber = roundNutrientValue(
      Math.min(nutrients.fiber, residual),
      'fiber'
    );
    relaxedKeys.push('fiber');
    warnings.push(
      'Fiber + sugars exceeded total carbohydrates; fiber clamped to residual.'
    );
  }

  return { nutrients, relaxedKeys, warnings };
};

/**
 * Convert an OpenFoodFacts `nutriments` sodium value to milligrams.
 *
 * OFF reports sodium in GRAMS by default (e.g. sodium_100g: 0.0428 with
 * sodium_unit: "g"). Respect the explicit `_unit` when present; when sodium
 * is absent fall back to salt (grams) via the NaCl mass ratio. Returns null
 * when neither sodium nor salt is available. Never reads
 * `nutriments_estimated` - those values are not measured/authoritative.
 */
export const convertOpenFoodFactsSodium = (nutriments = {}) => {
  const sodium = toFiniteNumberOrNull(nutriments?.sodium_100g);
  if (sodium != null) {
    const unit = String(nutriments?.sodium_unit ?? '')
      .toLowerCase()
      .trim();
    const milligrams = unit === 'mg' ? sodium : sodium * 1000;
    return Math.round(Math.max(0, milligrams));
  }

  const salt = toFiniteNumberOrNull(nutriments?.salt_100g);
  if (salt != null) {
    return Math.round(Math.max(0, salt * OFF_SALT_TO_SODIUM_FACTOR));
  }

  return null;
};

/**
 * Scale nutrient values by a gram factor (e.g. grams/100 for per-serving
 * portions). Null inputs stay null (untracked); numeric inputs are scaled and
 * rounded to the canonical per-key decimals.
 */
export const scaleNutrientValues = (nutrients = {}, factor = 1) => {
  const scaled = {};
  const safeFactor = Math.max(0, Number(factor) || 0);
  NUTRIENT_KEYS.forEach((key) => {
    const raw = toFiniteNumberOrNull(nutrients?.[key]);
    if (raw == null) {
      scaled[key] = null;
      return;
    }
    const bounds = NUTRIENT_BOUNDS[key] ?? { min: 0, max: Infinity };
    const clamped = Math.min(
      Math.max(raw * safeFactor, bounds.min),
      bounds.max
    );
    scaled[key] = roundNutrientValue(clamped, key);
  });
  return scaled;
};

/**
 * Accumulate one entry's nutrient values into a running totals object.
 * Untracked (`null`) inputs leave the accumulator untouched for that key, so
 * an all-null accumulator stays null (renders as —) until real data arrives.
 */
export const accumulateNutrientTotals = (acc = {}, entry = {}) => {
  const next = { ...EMPTY_NUTRIENTS, ...(acc ?? {}) };
  NUTRIENT_KEYS.forEach((key) => {
    const num = toFiniteNumberOrNull(entry?.[key]);
    if (num == null) {
      return;
    }
    next[key] = roundNutrientValue((Number(next[key]) || 0) + num, key);
  });
  return next;
};

/**
 * Compute a per-nutrient coverage summary for a set of entries:
 * `{ fiber, sodium, saturatedFats, sugars }` each shaped
 * `{ knownCount, untrackedCount, hasUntracked }`.
 */
export const computeNutrientCoverage = (entries = []) => {
  const coverage = {};
  const safeEntries = Array.isArray(entries) ? entries : [];

  NUTRIENT_KEYS.forEach((key) => {
    let knownCount = 0;
    let untrackedCount = 0;
    safeEntries.forEach((entry) => {
      if (toFiniteNumberOrNull(entry?.[key]) == null) {
        untrackedCount += 1;
      } else {
        knownCount += 1;
      }
    });
    coverage[key] = {
      knownCount,
      untrackedCount,
      hasUntracked: knownCount > 0 && untrackedCount > 0,
    };
  });

  return coverage;
};

/**
 * Display helper. Returns '—' for untracked values, otherwise the rounded
 * value with its canonical unit (e.g. '200 mg', '3.5 g').
 */
export const formatNutrientValue = (value, key, options = {}) => {
  const meta = NUTRIENT_META[key];
  if (!meta) {
    return options.emptyText ?? '—';
  }
  const normalized = normalizeNutrientValue(value, key);
  if (normalized == null) {
    return options.emptyText ?? '—';
  }
  const decimals = options.decimals ?? meta.decimals;
  const unitText = options.unit === false ? '' : ` ${meta.unit}`;
  return `${normalized.toFixed(decimals)}${unitText}`;
};
