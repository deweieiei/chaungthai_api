// ============================================================
//  Generate 02_locations_data.sql from JSON
//  Input:  data/province.json, district.json, sub_district.json
//  Output: sql/migrations/02_locations_data.sql
//  Run:    node scripts/gen_locations_sql.js
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dataDir = path.join(ROOT, 'data');
const outFile = path.join(ROOT, 'sql', 'migrations', '02_locations_data.sql');

const provinces = JSON.parse(fs.readFileSync(path.join(dataDir, 'province.json'), 'utf8'));
const districts = JSON.parse(fs.readFileSync(path.join(dataDir, 'district.json'), 'utf8'));
const subs      = JSON.parse(fs.readFileSync(path.join(dataDir, 'sub_district.json'), 'utf8'));

const BATCH = 500;

// MySQL string escape: ' -> ''
function esc(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''").replace(/\\/g, '\\\\') + "'";
}

function num(n) {
  if (n === null || n === undefined) return 'NULL';
  return Number(n);
}

function batchInsert(table, columns, rows, buildRow) {
  let sql = '';
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map(buildRow).join(',\n  ');
    sql += `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n  ${values};\n\n`;
  }
  return sql;
}

let out = '';
out += '-- ============================================================\n';
out += `--  Migration 02: Locations data (generated ${new Date().toISOString()})\n`;
out += `--  Source: kongvut/thai-province-data (api/latest/*)\n`;
out += `--  Provinces: ${provinces.length}, Districts: ${districts.length}, Subdistricts: ${subs.length}\n`;
out += '-- ============================================================\n\n';
out += 'USE chaungthai;\n\n';
out += 'SET FOREIGN_KEY_CHECKS = 0;\n';
out += 'TRUNCATE TABLE location_subdistrict_chaungthai;\n';
out += 'TRUNCATE TABLE location_district_chaungthai;\n';
out += 'TRUNCATE TABLE location_province_chaungthai;\n';
out += 'SET FOREIGN_KEY_CHECKS = 1;\n\n';

// --- Province ---
out += '-- ----- Provinces -----\n';
out += batchInsert(
  'location_province_chaungthai',
  ['province_id', 'province_name_th', 'province_name_en'],
  provinces,
  (p) => `(${num(p.id)}, ${esc(p.name_th)}, ${esc(p.name_en)})`
);

// --- District ---
out += '-- ----- Districts -----\n';
out += batchInsert(
  'location_district_chaungthai',
  ['district_id', 'district_province_id', 'district_name_th', 'district_name_en'],
  districts,
  (d) => `(${num(d.id)}, ${num(d.province_id)}, ${esc(d.name_th)}, ${esc(d.name_en)})`
);

// --- Subdistrict ---
out += '-- ----- Subdistricts -----\n';
out += batchInsert(
  'location_subdistrict_chaungthai',
  ['subdistrict_id', 'subdistrict_district_id', 'subdistrict_name_th', 'subdistrict_name_en', 'subdistrict_zip_code'],
  subs,
  (s) => `(${num(s.id)}, ${num(s.district_id)}, ${esc(s.name_th)}, ${esc(s.name_en)}, ${num(s.zip_code)})`
);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out, 'utf8');

console.log(`Wrote ${outFile}`);
console.log(`  provinces: ${provinces.length}`);
console.log(`  districts: ${districts.length}`);
console.log(`  subdistricts: ${subs.length}`);
console.log(`  output size: ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
