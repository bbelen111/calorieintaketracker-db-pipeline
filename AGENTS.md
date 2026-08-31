# Energy Map — Food DB Pipeline: AI Coding Instructions

## Repository Purpose

A dedicated, source-first pipeline for **laundering USDA FDC data** into a
curated SQLite food catalog, **manually curating staples missing from raw
datasets**, **validating food taxonomies**, and **transitioning from local
SQLite exports to cloud (Supabase) batch ingestion**. It is the extraction /
curation / validation home for the catalog consumed by the
`calorieintaketracker` app. The consumer repo keeps its own *copy* of the
scripts for bundled local updates — treat them as mirrors, not the source of
truth.

## Architecture & Data Layers

```
fdc-download/                 RAW INGESTION — USDA FDC bulk dumps (gitignored)
  FoodData_Central_foundation_food_csv_2026-04-30/
  FoodData_Central_sr_legacy_food_csv_2018-04/
  FoodData_Central_survey_food_csv_2024-10-31/

config/                       CURATION + TAXONOMY LAYER
  curation.js                 junk/brand filters, include/exclude overrides,
                              manualFoods (donor-cloned staples), collapse rules
  brands.js                   brand-catalog dial: verified-complete gate, exclude
                              patterns/owners, serving-unit→grams units table,
                              BRAND_CLASSIFY_RULES → canonical taxonomy pairs
  taxonomy.js                 CANONICAL_CATEGORIES, CANONICAL_SUBCATEGORY_BY_CATEGORY,
                              CATEGORY_ALIASES, SUBCATEGORY_ALIASES,
                              INVALID_PORTION_LABELS
  nutrients.js                canonical micro-nutrient defs + normalizers

build.js                      PROCESSING — raw CSVs → curated sqlite catalog
build-brands.js               FDC Branded CSV → branded catalog (cloud-only, streamed)
index.js                      audit / clean / quarantine for built catalogs
enrich-nutrients.js           micro backfill from FDC bulk CSVs

taxo-check.mjs                VERIFICATION — taxonomy/curation consistency gate
reports/                      audit/anomaly/quarantine/curation JSON (gitignored)
```

### Data flow

1. Raw FDC CSVs land under `fdc-download/` (per-release `FoodData_Central_*` folders).
2. `build.js` assembles per-100g macros + micros + household portions in one
   pass, applies `config/curation.js` (junk → caps-brand → collapse →
   friendly-name → manual staples), and writes the curated catalog.
3. `index.js` audits / cleans / quarantines an existing catalog.
4. `enrich-nutrients.js` backfills micros from bulk CSVs (`usda_<fdcId>` rows).
5. `taxo-check.mjs` validates config and, in `--db` mode, the built catalog.

## Working Boundaries (critical)

- This repo is **source-first and reviewable**: nutrition values for manually
  curated rows must always originate from a documented donor, never invented.
- All runtime outputs (`*.sqlite`, `reports/*.json`) are gitignored. **Never**
  force-add or commit them, raw CSVs (`fdc-download/`), or `.env` secrets.
- Raw FDC dumps live **only** in this repo under `fdc-download/` (gitignored).
  The consumer repo reads them through a junction
  (`scripts/food-db/fdc-download` → this repo's `fdc-download`) so there is a
  single source of truth; restore that junction with
  `New-Item -ItemType Junction -Path <app>\scripts\food-db\fdc-download -Target <this repo>\fdc-download`.
- Every script is ESM (`"type": "module"` in `package.json`); tests/scripts use
  explicit relative paths.
- Do not embed dataset quality hacks in `build.js`; keep curation policy in
  `config/`. Build failures belong in reports, not silent skips.

## Execution Order (do not reorder)

```
1. edit config/curation.js + config/taxonomy.js
2. node taxo-check.mjs                      # config-only gate (no DB needed)
3. node build.js                            # dry-run → review reports/curation.json
4. node build.js --write                    # optional: foodDatabase.curated.sqlite
5. node build.js --replace                  # writes foodDatabase.sqlite (backs up prior)
6. node index.js [--clean [--dry-run|--replace]]
7. node enrich-nutrients.js [--dir <dir>] [--replace]
8. node taxo-check.mjs --db foodDatabase.sqlite   # zero violations before shipping
```

`--replace` tolerates a first run with no prior catalog (skips back-up); every
subsequent run backs up `foodDatabase.sqlite` to `foodDatabase.backup.sqlite`.

## Canonical Schema (must never change without coordinated app work)

```sql
CREATE TABLE foods (
  id TEXT PRIMARY KEY,          -- 'usda_<fdcId>' or 'curated_<key>'
  name TEXT NOT NULL,
  category TEXT,                -- canonical or NULL/'uncategorized'
  subcategory TEXT,
  calories REAL, protein REAL, carbs REAL, fats REAL,
  fiber REAL, sodium REAL,      -- sodium in mg; null = untracked (never 0-for-missing)
  saturated_fats REAL, sugars REAL,
  portions TEXT                 -- JSON array [{ id, label, grams }], '100g' always first
);
```

- **Micro nutrients are NULL-semantic**: `null`/absent = untracked, `0` =
  measured zero. `normalizeNutrientValue`/`normalizeNutrients` in
  `config/nutrients.js` own clamping and units (fiber/saturatedFats/sugars in g,
  sodium in mg); invariants are source-scoped
  (`saturated_fats <= fats`, `sugars <= carbs`, and for US "carb by difference"
  sources `sugars + fiber <= carbs`; OFF/EU net-carb entries never clamp fiber
  against carbs).
## Learned Quirks, Edge Cases & Data Pitfalls (do not relearn these)

### Nutrient id schemes are release-dependent (critical)
FDC bulk releases disagree on what `food_nutrient.nutrient_id` means. `build.js`
maps **both** schemes to the same fields:

- **SR Legacy (2018) and Foundation (2024+):** the internal FDC nutrient id —
  energy `1008`, protein `1003`, fat `1004`, carbs `1005`, fiber `1079`,
  sodium `1093`, saturated fat `1258`, sugars `2000` (resolved via
  `nutrient.csv` `nutrient_nbr`).
- **Survey/FNDDS (2024+):** the nutrient **number directly** — `208`, `203`,
  `204`, `205`, `291`, `307`, `606`, `269`.

> **`1002` is NITROGEN, never energy.** Do not alias it to calories (verified
> live: trimming `1002`-as-energy garbage that surfaced as 0.09 kcal on
> Foundation almond-milk rows). If a Foundation/survey food has no real energy
> row, it is dropped as a nutrient gap (`no_energy`) — that is correct.

### Survey/FNDDS is default-on
`CURATION.useSurvey: true`. The `--survey` CLI flag can only force it ON, never
off; edit the config to drop it. FNDDS brings grocery staples (milk varieties,
oat/almond milk, cheeses, RTE cereals, generic soups). The junk filter still
keeps fast food / `NFS` / `not further specified` rows out (verified: zero
leaks).

### ALL-CAPS brand detector drops legit staples
`excludeCapsTokens: true` removes rows with an ALL-CAPS token of 3+ letters
(allowlist: `USDA, USA, NS, NFS, TVP, WIC, NLEA, BBQ`). Legit products with
caps names get recovered via **`includeFdcIds`** — e.g.
`Cereals, CREAM OF WHEAT/CREAM OF RICE` (`171657`/`171660`/`171658`/`171659`,
`173900`/`173914`). When adding a force-keep, add a comment with the product.

### Raw SR data has gaps — the friendly-name pass exists for a reason
- USDA has **no plain "Chicken, …, breast, meat only, raw"** row; the raw
  skinless-boneless breast is that food. The display-name pass therefore maps
  it to the canonical `Chicken breast, raw`.
- Naming normalization (gated to `^(chicken|turkey|duck|goose|pork)`): strips
  flock jargon (`broilers or fryers`, `broiler-fryers`, `capons`, `stewing
  hens`…), glues body parts (`Chicken, breast` → `Chicken breast`), drops
  noise (`meat only`, `separable lean and fat`, `fresh`, `whole`), converts
  `meat and skin` → `with skin`, and strips redundant
  `skinless, boneless` **only** from the raw form. It must stay **gated** —
  do not apply generic rename rules to eggs/beef/fish.
- **Post-rename collision guard:** dedupe on `(lowercased name, category)` with
  first-wins after the display pass (two verbatim groups can normalize to the
  same label).

### `manualFoods` — donor-cloned staples only
`config/curation.js::manualFoods` adds foods USDA never published (branded-only
or common consumer forms) with `curated_<key>` ids. Rules:
- Every entry needs a **donor `basedOnFdcId`** whose per-100g nutrition +
  portions are cloned at build time (numbers are never invented). Proven
  examples: frozen chicken breast ← `171077`; jasmine/basmati ←
  `168877`/`168878` (long-grain white rice); penne ← `169736`/`169737` (pasta).
- They get a `kept` group key so variant-collapse can never absorb them.
- `taxo-check.mjs` verifies their `category`/`subcategory` are canonical and
  warns when a donor is missing.

### Portion handling
- `100g` entry is **always first** (`{ id: 'p_100g', label: '100g', grams: 100 }`).
- SR "undetermined"/`not specified` grams are exposed honestly as
  `1 serving (Ng)` instead of a meaningless unit; real household units are
  retained from Foundation/FNDDS.
- `cleanAmount('113.0') → '113'`; junk units (`undetermined`, `serving`, `n/a`,
  `-`… from `INVALID_PORTION_LABELS`) are rejected.

### Collapse invariants
- Only `beef, pork, poultry, fish, shellfish, eggs` collapse (config list).
- `maxStatesPerGroup: 2` → one raw + one cooked representative max.
- `purgeTokens` ship brand/solution/marketing noise out of group keys
  (`fresh`, `with added solution`, `grass-fed`, `organic`, `bone-in`…);
  `cookedPreference` ranks which cooked method survives (roasted > braised >
  broiled > grilled > fried > …).
- Do not add subcategories to the collapse list without extending
  `CANONICAL_SUBCATEGORY_BY_CATEGORY` first — `taxo-check` treats unknowns as
  failures.

### Dataset hygiene
- Foundation 2026 rows without an energy nutrient (e.g. lab-sample almond milk)
  drop as `no_energy` — expected; FNDDS/SR cover the consumer versions.
- Multi-sampled FDC rows: `median` is preferred over `amount` when present.
- `loadLegacyTaxonomy` (previous catalog → taxonomy hint) is advisory only;
  a fresh repo with no prior DB builds fine (~10-row drift vs the app's
  first-build, caused purely by that hint).

### Branded-product pitfalls (build-brands.js)
- The branded release `food.csv` `data_type` is **`branded_food`**, not
  `branded`, and the household column is **`household_serving_fulltext`** (not
  `_full_text`). Verify headers per release — both have changed historically.
- The 2026-04-30 branded dump is BIG: ~2.0 M `food.csv` rows and ~26 M
  `food_nutrient.csv` rows (~2.9 GB total). `build-brands.js` **streams** every
  CSV (`node:readline`); never slurp these files whole.
- Nutrient values are **per 100 g** label data (verified: energy `1008` →
  nutrient_nbr `208`; `1002` is Nitrogen — never energy). Do not rescale to
  serving size; prefer `median` over `amount` when present.
- GTIN duplicates dominate: ~1.19 M rows share a zero-padded `gtin_upc`. Dedupe
  prefers the as-purchased preparation state, then a fingerprint for GTIN-less
  rows, then an exact `(lower name, category, lower brand)` collapse — FDC
  re-lists the same product across GDSN updates/trade channels under fresh ids.
- `brand` is the shared table's staple-vs-branded discriminator (NULL = staple).
  `requireBrand` (config/brands.js) drops rows FDC lists without a brand owner —
  otherwise they would rank like staples in `search_foods`.
- `search_foods` ranks exact-name matches (500) above prefix (250) and only
  demotes brands (-40) in the residual arm: queries like "milk" surface brand
  rows literally named "Milk" ahead of the "Milk, whole,…" staples. That is
  contract behavior, not a data defect.
- NTFS junctions to an external drive work as the source
  (`fdc-download/FoodData_Central_branded_food_csv_*`), but Node's
  `readdir({withFileTypes:true})` reports junctions as SYMLINKS — discovery must
  accept `isSymbolicLink()` and resolve with `fs.stat` (build-brands does this).
- Seeding 348 k rows is network-heavy: `seed/supabase.js` retries each batch (3
  attempts, backoff) so transient `fetch failed` blips self-heal; interrupted
  runs are safe to re-run (idempotent upserts).
## Manual Curation Rules (add missing staples)

1. Prefer a real FDC row first — check FNDDS before curating (e.g. oat/almond
   milk are native FNDDS rows; do not duplicate them as `manualFoods`).
2. Add to `config/curation.js` `manualFoods` with a **documented donor
   `fdc_id`**; use standard 100g macro baselines.
3. Add explicit household conversions (e.g. `1 cup (240ml) (240g)`) on top of
   the auto `100g` entry (clone the donor's `portions`).
4. Run `taxo-check` + the audit routine afterwards — **zero** category
   mismatches or orphan items before `--replace`.

## Cloud Seeding (Supabase)

- `seed/supabase.js` is ready to use:
  - Reads any catalog SQLite via `--db <path>` (default: this repo's
    `foodDatabase.sqlite`); `--dry-run` plans batches without network.
  - Upserts batches (default 500, `--batch`) with the service-role client from
    `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), **`ON CONFLICT (id)`**
    so re-seeding is idempotent and incremental syncs are safe.
  - Requires the Postgres `foods` table — use the idempotent DDL in
    `seed/supabase.sql` (already applied to the EnergyMap project: migrations
    `create_foods_table`, `foods_security_hygiene`, `foods_add_brand_column`,
    `foods_search_rpc`). The migration ships RLS (`foods public read`), search
    RPCs (`search_foods` / `search_foods_total` — ranking mirrors the local
    catalog + brand-intent demotion/boost), and grant hygiene (anon/authenticated
    = SELECT only; RPC EXECUTE = service_role only).
- **The app's online search reads this catalog through the same Vercel
  gateway, at `api/foods.js` (`/api/foods` + a legacy `/api/usda` alias for
  already-shipped builds); FDC is never called at runtime.** The proxy uses the
  **read-only anon key** (`SUPABASE_URL` + `SUPABASE_ANON_KEY`/
  `SUPABASE_PUBLISHABLE_KEY`) — the service key never leaves this repo's
  seeder. Keep the RPCs and the canonical `catalogFoods` payload shape
  backward-compatible (`foods` legacy FDC envelope is for old native builds
  during the transition only).
- **Brands are a cloud-only pass (live):** `build-brands.js` (gated on the FDC
  Branded CSV download) → `foodDatabase.branded.sqlite` →
  `seed:supabase:brands` (idempotent `ON CONFLICT (id)` upserts with per-batch
  retry). Seeded: **348,459 branded rows** from the 2026-04-30 release
  (358,103 total in `public.foods`; `taxo-check.mjs --db foodDatabase.branded.sqlite --branded`
  passes with zero violations). The app bundle stays staples-only; do not ship
  brands in `foodDatabase.sqlite`. See "Branded-product pitfalls" below.
- **Catalog bootstrap & parity (greenfield builds):** the first build in a fresh
  repo has no prior catalog to seed `loadLegacyTaxonomy`, so a handful of FNDDS
  rows (e.g. Eggnog, miso, natto, radicchio, beets, sweet peppers) drop.
  Verified: copying the consumer app's `foodDatabase.sqlite` over this repo's
  `foodDatabase.sqlite` before the build converges to **exact id-parity**
  (9644/9644/0). Do this whenever you want the pipeline output to reproduce the
  app's shipped catalog bit-for-bit.
- Add RLS/read policies appropriate for a public read catalog; never expose the
  service-role key to clients.
- Regional ingestion to the same schema: PhilFCT, ASEAN FCD, Open Food Facts PH
  (normalize through `config/nutrients.js` + taxonomy maps; keep provenance in
  the `id` prefix, e.g. `philfct_`, `asean_`, `offph_` — extend the consumer
  app's `foodTags`-style source resolvers accordingly).

## Safety & Secrets

- Never commit: `fdc-download/` raw CSVs, `*.sqlite` / `*.db` /
  `*.sqlite-journal` binaries, `reports/*.json`, `.env` / `.env.local`.
- Service-role credentials are server-side only — used by `seed/` scripts,
  never shipped to the app bundle.
- `.env.example` documents the required variables; real values stay local.

## Common Build Failures (debug fast)

- **`Missing dataset folders`** — no `fdc-download/` dumps; junction or copy
  them in.
- **`no_energy` gaps** — the release offers no energy row for that fdc; it's a
  legit drop, not a bug.
- **`taxo: FAIL orphan subcategory …`** — a category/subcategory pair is not in
  the canonical maps; fix `config/taxonomy.js` (add to the set or map an alias)
  rather than patching the DB by hand.
- **Calorie blow-ups / tiny values in a column** — suspect a nutrient-id scheme
  mismatch; verify raw `food_nutrient.csv` ids for that release before touching
  mapping code.