# Energy Map — Food DB Pipeline

Standalone, **source-first** pipeline that launders USDA FoodData Central (FDC)
bulk CSV exports into a curated, validated SQLite food catalog — the same
catalog the consumer app (`calorieintaketracker`) ships. It also owns taxonomy
validation and the roadmap to seed the catalog into **Supabase** for cloud use.

```
fdc-download/            raw USDA bulk dumps (gitignored, local only; branded dump may be a
                         junction to an external drive)
config/
  curation.js            curation dial: junk/brand filters, manual staples, donor clones
  brands.js              brand-catalog dial: verified-complete gate, junk patterns, brand
                         owner filters, serving-unit→grams table, classification rules
  taxonomy.js            canonical category/subcategory maps, aliases, invalid-portion labels
  nutrients.js           micro-nutrient canonical defs (fiber/sodium/saturatedFats/sugars)
build.js                 raw CSVs → curated SQLite catalog (Foundation + SR Legacy + Survey)
build-brands.js          FDC Branded CSV → foodDatabase.branded.sqlite (cloud-only, streamed)
index.js                 audit / clean / quarantine tool for existing catalogs
enrich-nutrients.js      micro-nutrient backfill from FDC bulk CSVs
seed/supabase.js         idempotent ON CONFLICT (id) upsert of any catalog into Supabase `foods`
taxo-check.mjs           taxonomy + curation consistency validator (config/DB/--branded modes)
reports/                 generated audit/anomaly/quarantine JSON (gitignored, .gitkeep kept)
```

## Prerequisites

- Node ≥ 18 (`npm install`)
- Raw FDC dumps on disk. Download Foundation, SR Legacy and Survey/FNDDS bulk
  CSVs from <https://fdc.nal.usda.gov/download-datasets.html> and place each
  unpacked `FoodData_Central_*/` folder under `fdc-download/`.

> If you keep the dumps in the sibling app repo, you can junction them instead:
> `New-Item -ItemType Junction -Path .\fdc-download -Target <app-repo>\scripts\food-db\fdc-download`

## Standard workflow

| Step | Command | What to check |
|---|---|---|
| 1. Add/tune curation | edit `config/curation.js`, `config/taxonomy.js` | manual staples, include/exclude overrides, aliases |
| 2. Validate config | `npm run taxo:check` | zero `FAIL` lines |
| 3. Dry-run build | `npm run db:build` | `reports/curation.json`: row counts, junk dropped, collapse groups, kept samples |
| 4. Write catalog | `npm run db:build:replace` | writes `foodDatabase.sqlite` (backs up any prior one) |
| 5. Audit / clean | `npm run db:audit` · `db:clean:dry` · `db:clean` | `reports/audit.*.json`, `reports/quarantine.json` |
| 6. Enrich micros | `npm run db:enrich` | backfills fiber/sodium/saturated_fats/sugars from bulk CSVs |
| 7. Validate catalog | `npm run taxo:check:db` | zero orphan categories/subcategories, integrity `ok`, no duplicate rows |
| 8. Ship / seed | copy `foodDatabase.sqlite` to the consumer app, or seed to Supabase | see Cloud seeding |

Scripts are mirrored from the consumer repo conventions (`db:build`,
`db:build:write`, `db:build:replace`, `db:audit`, `db:clean:dry`, `db:clean`,
`db:enrich`, plus `taxo:check*`).

## Outputs (all gitignored)

- `foodDatabase.sqlite` — canonical catalog output (what ships in the app)
- `foodDatabase.curated.sqlite` — non-destructive build output (`--write`)
- `foodDatabase.enriched.sqlite` / `foodDatabase.backup.sqlite` — enrich/backup intermediates
- `reports/*.json` — `curation.json`, `audit.before.json`, `audit.after.json`,
  `quarantine.json`, `anomaly.deep.json`, `curated.audit.json`

## Manual curation rules

- Missing staples go in `config/curation.js` `manualFoods`:
  - Always **clone** nutrition + portions from a documented `basedOnFdcId` donor
    (numbers are never invented).
  - Use standard 100g macro baselines; add explicit household portion entries
    (e.g. `1 cup (240ml) (240g)`) on top of the always-present `100g`.
  - `curated_` ids are never collapsed away (they carry a `kept` group key).
- After **any** taxonomy or curation change, run `taxo-check.mjs` + the audit
  routine — zero category mismatches or orphans before shipping.

## Cloud seeding + catalog serving (Supabase)

- `seed/supabase.js` is ready to use:
  - Reads **any** catalog SQLite via `--db <path>` (default: this repo's
    `foodDatabase.sqlite`). To seed the exact catalog the consumer app ships,
    point it at the app's `src/constants/food/foodDatabase.sqlite`.
  - Upserts **500–1000 rows per batch** (default 500) with the service-role
    client from `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), keyed on
    food `id` (`ON CONFLICT (id)`) so re-seeding is idempotent and safe for
    incremental syncs. **Staples seeded: 9,644 rows** (M1 done).
  - Ship the table first: **`seed/supabase.sql`** (idempotent DDL — table,
    indexes incl. trigram name search, RLS with public read / service-role
    write). Applied to the EnergyMap project plus migrations `foods_add_brand_column`
    and `foods_search_rpc`.
  - `--dry-run` validates the batch plan against a local catalog without
    touching the network.
- **The app's online search reads this catalog through the same Vercel
  gateway, now branded `api/foods.js`** (`/api/foods` + a legacy `/api/usda`
  alias for already-shipped builds): the proxy calls the PostgREST RPCs
  `search_foods` / `search_foods_total` with the **read-only anon key**
  (`SUPABASE_URL` + `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY`). The
  `SUPABASE_SERVICE_ROLE_KEY` is used **only by this repo's seeder** — never by
  the Vercel deploy. FoodData Central is never called at runtime. See
  `docs/supabase-cloud-read-plan.md` (M2 live).
- **Brands (cloud-only, live):** `build-brands.js` launders the FDC Branded CSV
  dump (`FoodData_Central_branded_food_csv_2026-04-30`) into
  `foodDatabase.branded.sqlite` (same `foods` schema + `brand` column,
  `usda_<fdcId>` ids). It streams the ~2.9 GB release (2.0 M foods, 26 M nutrient
  rows), verifies the nutrient-id scheme against the release's `nutrient.csv`
  (1008=Energy; 1002=Nitrogen never aliased), and ships only **verified-complete**
  rows: all 4 macros present, a serving size convertible to grams, a real brand,
  US-invariant micros (`config/nutrients.js`), GTIN + fingerprint + exact dup
  collapse, and no staple collisions (`config/brands.js` policy). Gate it with
  `npm run taxo:check:brands` (zero violations). Seed idempotently with
  `npm run seed:supabase:brands` (`--batch 500`; batch retries built in).
  **Seeded: 348,459 branded rows** (358,103 total in `public.foods`). The app
  bundle never includes brands. If the repo drive is too full for the dump,
  junction it: `New-Item -ItemType Junction -Path .\fdc-download\FoodData_Central_branded_food_csv_2026-04-30 -Target D:\<path>\FoodData_Central_branded_food_csv_2026-04-30`.
- Later: ingest regional/Philippine datasets (PhilFCT, ASEAN FCD, Open Food
  Facts PH) through the same schema + curation pipeline.

## Safety

Never commit raw FDC CSVs (`fdc-download/`), sqlite/db binaries, generated
reports (`reports/*.json`), or `.env` secrets. See `.gitignore`.

See `AGENTS.md` for full operating rules and hard-learned data pitfalls.