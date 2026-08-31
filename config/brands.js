// Brand curation for build-brands.js (FDC Branded Food Products dataset).
//
// The staple catalog intentionally junk-filters brands; the cloud catalog
// instead CLEANS them into `foods` rows (same table, `brand` set). This file
// is the refinement dial for that pass: tweak and re-run
//   node build-brands.js --dry-run
// then inspect reports/brands.json for every drop/keep decision.

export const BRAND_CURATION = {
  // Branded rows only count when they carry an edible macro profile.
  requireCalories: true,
  requireName: true,

  // Placeholder / non-food detectors matched against the DESCRIPTION. Branded
  // rows still pass the regular junk filters where applicable, but the brand
  // pass is deliberately more permissive than the staple pass — missing or bad
  // rows just get dropped (one row = one product).
  excludePatterns: [
    /^product$/i,
    /^undefined$/i,
    /^null$/i,
    /^n\/a$/i,
    /\bUNKNOWN\b/i,
    /PET FOOD|CAT FOOD|DOG FOOD|BABY FORMULA|BABY FOOD|ELECTRONIC|CLEANER|SOAP|SHAMPOO/i,
  ],

  // Force-keep brand owners even if a description hits an exclude pattern.
  includeOwners: new Set(),

  // Force-drop brand owners wholesale (multi-level-marketing / bulk powders etc.).
  excludeOwners: new Set(['THRIVE LIFE']),

  // Row cap when writing (0 = unlimited). Keeps early cloud seeds sane while
  // the curation rules are dialed in; raise or remove once audits look right.
  maxRows: 0,
};