#!/usr/bin/env node
/**
 * USDA FoodData Central bulk backfill for micro nutrients.
 *
 * Joins the bundled catalog's `usda_<fdcId>` rows against the official FDC
 * bulk CSV downloads (Foundation, SR Legacy, optional Branded):
 *
 *   https://fdc.nal.usda.gov/download-datasets.html
 *
 * Each dataset ships `food_nutrient.csv` + `nutrient.csv`. We match nutrient
 * NUMBER first (291 Fiber / 307 Sodium / 606 Saturated fat / 269 Sugars), then
 * fall back to normalized nutrient-name patterns (Branded rows often lack a
 * number). Multi-sampled rows are stable: later datasets never overwrite an
 * already-resolved value.
 *
 * Usage:
 *   node enrich-nutrients.js [--dir <extract-dir>] [--replace]
 *
 * Default dir: fdc-download (Foundation/SR Legacy + optional Branded
 * subfolder). Default output is foodDatabase.enriched.sqlite; pass --replace
 * to write the canonical catalog DB (a backup is created first).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import initSqlJs from 'sql.js';
import {
  normalizeNutrients,
  normalizeNutrientValue,
} from './config/nutrients.js';

const PROJECT_ROOT = globalThis.process.cwd();
const CANONICAL_DB_PATH = path.resolve(PROJECT_ROOT, 'foodDatabase.sqlite');
const BACKUP_DB_PATH = path.resolve(
  PROJECT_ROOT,
  'foodDatabase.backup.sqlite'
);
const REPORTS_DIR = path.resolve(PROJECT_ROOT, 'reports');
const DEFAULT_DOWNLOAD_DIR = path.resolve(PROJECT_ROOT, 'fdc-download');
const ENRICHED_OUTPUT_PATH = path.resolve(
  PROJECT_ROOT,
  'foodDatabase.enriched.sqlite'
);

// Canonical USDA nutrient numbers + name fallbacks.
const TARGET_NUTRIENTS = [
  { number: '291', namePart: 'fiber, total dietary', column: 'fiber' },
  { number: '307', namePart: 'sodium', column: 'sodium' },
  {
    number: '606',
    namePart: 'fatty acids, total saturated',
    column: 'saturated_fats',
  },
  {
    number: '269',
    namePart: 'sugars, total including nlea',
    column: 'sugars',
  },
];

const normalizeName = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const toFiniteOrNull = (value) => {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseArgs = () => {
  const args = globalThis.process.argv.slice(2);
  const result = {
    dir: DEFAULT_DOWNLOAD_DIR,
    replace: args.includes('--replace'),
  };
  const dirIndex = args.indexOf('--dir');
  if (dirIndex !== -1 && args[dirIndex + 1]) {
    result.dir = path.resolve(PROJECT_ROOT, args[dirIndex + 1]);
  }
  return result;
};

// Minimal RFC-4180-ish CSV parser (quoted commas + escaped quotes).
const parseCsv = (text) => {
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
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== '')) {
      rows.push(row);
    }
  }

  return rows;
};

const readCsv = async (filePath) => {
  const text = await fs.readFile(filePath, 'utf8');
  return parseCsv(text);
};

const isFileName = (fullPath, fileName) => {
  const base = path.basename(fullPath);
  return base === fileName;
};

const findCsvFiles = async (dirPath) => {
  const files = [];
  const entries = await fs
    .readdir(dirPath, { withFileTypes: true })
    .catch(() => []);

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findCsvFiles(full)));
    } else if (
      entry.name === 'food_nutrient.csv' ||
      entry.name === 'nutrient.csv'
    ) {
      files.push(full);
    }
  }

  return files;
};

/**
 * Returns { nutrientId -> { name, number } } from every nutrient.csv found.
 */
const loadNutrientCatalogs = async (dirPath) => {
  const catalogs = new Map();

  for (const filePath of await findCsvFiles(dirPath)) {
    if (!isFileName(filePath, 'nutrient.csv')) {
      continue;
    }

    const rows = await readCsv(filePath);
    const [header, ...body] = rows;
    const idIndex = header.indexOf('id');
    const nameIndex = header.indexOf('name');
    const numberIndex = header.indexOf('nutrient_nbr');
    if (idIndex === -1 || nameIndex === -1) {
      continue;
    }

    for (const row of body) {
      const id = String(row[idIndex] ?? '').trim();
      if (!id) {
        continue;
      }
      catalogs.set(id, {
        id,
        name: normalizeName(row[nameIndex] ?? ''),
        number: numberIndex !== -1 ? String(row[numberIndex] ?? '').trim() : '',
      });
    }
  }

  return catalogs;
};

/**
 * Aggregates food_nutrient.csv rows into fdc_id -> nutrient values for the
 * four target nutrients. Returns a Map of fdc_id -> { fiber?, sodium?, ... }.
 */
const aggregateNutrientValues = async (dirPath, nutrientCatalogs) => {
  const aggregated = new Map();

  const targetIdsByNumber = new Map();
  TARGET_NUTRIENTS.forEach(({ number }) => {
    nutrientCatalogs.forEach((meta) => {
      if (meta.number === number) {
        targetIdsByNumber.set(meta.id, meta);
      }
    });
  });

  const isTargetNutrient = (meta) => {
    if (!meta) {
      return null;
    }
    return (
      TARGET_NUTRIENTS.find(
        ({ number, namePart }) =>
          meta.number === number || meta.name.includes(namePart)
      ) ?? null
    );
  };

  for (const filePath of await findCsvFiles(dirPath)) {
    if (!isFileName(filePath, 'food_nutrient.csv')) {
      continue;
    }

    const rows = await readCsv(filePath);
    const [header, ...body] = rows;
    const fdcIdIndex = header.indexOf('fdc_id');
    const nutrientIdIndex = header.indexOf('nutrient_id');
    const amountIndex = header.indexOf('amount');
    if (fdcIdIndex === -1 || nutrientIdIndex === -1 || amountIndex === -1) {
      continue;
    }

    for (const row of body) {
      const fdcId = String(row[fdcIdIndex] ?? '').trim();
      const nutrientId = String(row[nutrientIdIndex] ?? '').trim();
      const amount = toFiniteOrNull(row[amountIndex]);
      if (!fdcId || !nutrientId || amount == null) {
        continue;
      }

      const meta =
        nutrientCatalogs.get(nutrientId) || targetIdsByNumber.get(nutrientId);
      const target = isTargetNutrient(meta);
      if (!target) {
        continue;
      }

      const entry = aggregated.get(fdcId) ?? {};
      if (entry[target.column] == null) {
        entry[target.column] = amount;
        aggregated.set(fdcId, entry);
      }
    }
  }

  return aggregated;
};

const NUTRIENT_COLUMN_TO_KEY = {
  fiber: 'fiber',
  sodium: 'sodium',
  saturated_fats: 'saturatedFats',
  sugars: 'sugars',
};

const roundColumnValue = (value, column) =>
  normalizeNutrientValue(value, NUTRIENT_COLUMN_TO_KEY[column]);

const MICRO_COLUMNS = ['fiber', 'sodium', 'saturated_fats', 'sugars'];

const enrichDb = async (SQL, aggregated) => {
  const buffer = await fs.readFile(CANONICAL_DB_PATH);
  const source = new SQL.Database(new Uint8Array(buffer));

  const colsResult = source.exec("PRAGMA table_info('foods')");
  const existingColumns = new Set(
    (colsResult?.[0]?.values ?? []).map((row) => String(row[1] ?? '').trim())
  );
  const hadMicroColumns = MICRO_COLUMNS.every((column) =>
    existingColumns.has(column)
  );

  // Row order: id(0) name(1) category(2) subcategory(3) calories(4) protein(5)
  // carbs(6) fats(7) portions(8).
  const { values } = source.exec(`
    SELECT id, name, category, subcategory, calories, protein, carbs, fats, portions
    FROM foods
  `)[0];

  let matchedRows = 0;
  const perNutrientCounts = {
    fiber: 0,
    sodium: 0,
    saturated_fats: 0,
    sugars: 0,
  };

  const rebuilt = new SQL.Database();
  rebuilt.run(`
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

  const insert = rebuilt.prepare(`
    INSERT INTO foods (id, name, category, subcategory, calories, protein, carbs, fats, fiber, sodium, saturated_fats, sugars, portions)
    VALUES (:id, :name, :category, :subcategory, :calories, :protein, :carbs, :fats, :fiber, :sodium, :saturated_fats, :sugars, :portions)
  `);

  for (const row of values) {
    const id = String(row[0] ?? '');
    const micros = {};

    if (id.startsWith('usda_')) {
      const fdcId = id.slice('usda_'.length);
      const found = aggregated.get(fdcId);
      if (found) {
        let hit = false;
        TARGET_NUTRIENTS.forEach(({ column }) => {
          if (found[column] == null) {
            return;
          }
          micros[column] = found[column];
          perNutrientCounts[column] += 1;
          hit = true;
        });
        if (hit) {
          matchedRows += 1;
        }
      }
    }

    // Soft US-scope invariants against the row's own per-100g macros.
    const { nutrients } = normalizeNutrients(
      {
        fiber: micros.fiber ?? null,
        sodium: micros.sodium ?? null,
        saturatedFats: micros.saturated_fats ?? null,
        sugars: micros.sugars ?? null,
      },
      {
        parentTotals: {
          protein: Number(row[5] ?? 0),
          carbs: Number(row[6] ?? 0),
          fats: Number(row[7] ?? 0),
        },
        source: 'usda',
      }
    );

    insert.run({
      ':id': id,
      ':name': row[1],
      ':category': row[2],
      ':subcategory': row[3] ?? null,
      ':calories': row[4],
      ':protein': row[5],
      ':carbs': row[6],
      ':fats': row[7],
      ':fiber': roundColumnValue(nutrients.fiber, 'fiber'),
      ':sodium': roundColumnValue(nutrients.sodium, 'sodium'),
      ':saturated_fats': roundColumnValue(
        nutrients.saturatedFats,
        'saturated_fats'
      ),
      ':sugars': roundColumnValue(nutrients.sugars, 'sugars'),
      ':portions': row[8] ?? '[]',
    });
  }

  insert.free();
  source.close();

  const integrity = rebuilt.exec('PRAGMA integrity_check');
  const integrityMessage = integrity?.[0]?.values?.[0]?.[0] ?? 'unknown';
  if (integrityMessage !== 'ok') {
    rebuilt.close();
    throw new Error(`Integrity check failed: ${integrityMessage}`);
  }

  const bytes = rebuilt.export();
  rebuilt.close();

  return {
    bytes,
    hadMicroColumns,
    totalRows: values.length,
    matchedRows,
    perNutrientCounts,
  };
};

const ensureReportsDir = async () => {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
};

const replaceDatabaseFile = async (bytes) => {
  const tempPath = `${CANONICAL_DB_PATH}.tmp`;
  const sourceBuffer = await fs.readFile(CANONICAL_DB_PATH);
  await fs.writeFile(BACKUP_DB_PATH, sourceBuffer);
  await fs.writeFile(tempPath, Buffer.from(bytes));
  await fs.rename(tempPath, CANONICAL_DB_PATH);
};

const main = async () => {
  const args = parseArgs();

  const SQL = await initSqlJs();
  const nutrientCatalogs = await loadNutrientCatalogs(args.dir);
  const aggregated = await aggregateNutrientValues(args.dir, nutrientCatalogs);

  if (nutrientCatalogs.size === 0 || aggregated.size === 0) {
    console.warn(
      `No FDC CSVs found under ${args.dir}. Download Foundation/SR Legacy (and optional Branded) from https://fdc.nal.usda.gov/download-datasets.html and extract them there.`
    );
  }

  const { bytes, totalRows, matchedRows, perNutrientCounts } = await enrichDb(
    SQL,
    aggregated
  );

  await ensureReportsDir();
  await fs.writeFile(
    path.resolve(REPORTS_DIR, 'enrich.after.json'),
    `${JSON.stringify(
      {
        downloadDir: args.dir,
        totalRows,
        matchedRows,
        coveragePercent:
          totalRows > 0 ? ((matchedRows / totalRows) * 100).toFixed(1) : '0.0',
        perNutrientCounts,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  if (args.replace) {
    await replaceDatabaseFile(bytes);
    console.log(
      `Enriched DB written to ${CANONICAL_DB_PATH} (backup: ${BACKUP_DB_PATH}). Matched ${matchedRows}/${totalRows} rows.`
    );
    return;
  }

  await fs.writeFile(ENRICHED_OUTPUT_PATH, Buffer.from(bytes));
  console.log(
    `Enriched DB written to ${ENRICHED_OUTPUT_PATH}. Matched ${matchedRows}/${totalRows} rows. Pass --replace to overwrite the bundled catalog.`
  );
};

main().catch((error) => {
  console.error('Enrichment failed:', error);
  globalThis.process.exitCode = 1;
});