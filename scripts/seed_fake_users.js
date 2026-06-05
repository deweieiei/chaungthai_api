// ============================================================
//  Seed Fake Users
//
//  สร้าง user_chaungthai ปลอม + กระจายตามจังหวัด/อำเภอ/ตำบลจริง
//
//  Usage:
//    cd ~/projcet/chaungthai_api
//    node scripts/seed_fake_users.js [count]
//
//  Examples:
//    node scripts/seed_fake_users.js 10000     # 10K
//    node scripts/seed_fake_users.js 100000    # 100K
//    node scripts/seed_fake_users.js 1000000   # 1M
//
//  Performance tips:
//    - bcrypt rounds = 4 (fake user, ไม่ login จริง)
//    - batch INSERT 1000 rows / statement
//    - 1 transaction ใหญ่ครอบทุก batch
//    - email format: fake_<id>_<ts>@chaungthai-test.com (cleanup ง่าย)
// ============================================================

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { fakerTH, faker } = require('@faker-js/faker');

const TOTAL = Number(process.argv[2]) || 10_000;
const BATCH_SIZE = 1000;
const BCRYPT_ROUNDS = 4; // ต่ำสำหรับ fake (ปกติ 12)
const RUN_ID = Date.now();

// hash 1 ครั้งใช้ทุก user (fake user ไม่ login)
const FAKE_PASSWORD_HASH = bcrypt.hashSync('FakePass_LoadTest_1234', BCRYPT_ROUNDS);

console.log('============================================');
console.log('  Seed Fake Users');
console.log('============================================');
console.log(`  TOTAL:      ${TOTAL.toLocaleString()}`);
console.log(`  BATCH_SIZE: ${BATCH_SIZE}`);
console.log(`  RUN_ID:     ${RUN_ID}`);
console.log('============================================');

(async () => {
  const startTime = Date.now();

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chaungthai',
    connectionLimit: 5,
    charset: 'utf8mb4',
    // settings เพิ่ม performance สำหรับ bulk insert
    multipleStatements: true,
  });

  // ----- 1. โหลด locations -----
  console.log('\n[1/3] Loading locations from DB...');
  const [provinces] = await pool.query('SELECT province_id FROM location_province_chaungthai');
  const [districts] = await pool.query('SELECT district_id, district_province_id FROM location_district_chaungthai');
  const [subs] = await pool.query('SELECT subdistrict_id, subdistrict_district_id FROM location_subdistrict_chaungthai');

  console.log(`   provinces:    ${provinces.length}`);
  console.log(`   districts:    ${districts.length}`);
  console.log(`   subdistricts: ${subs.length}`);

  // index ตาม parent (สำหรับ random ลูกใต้ parent)
  const dByP = {};
  for (const d of districts) {
    (dByP[d.district_province_id] = dByP[d.district_province_id] || []).push(d.district_id);
  }
  const sByD = {};
  for (const s of subs) {
    (sByD[s.subdistrict_district_id] = sByD[s.subdistrict_district_id] || []).push(s.subdistrict_id);
  }
  const provinceIds = provinces.map(p => p.province_id);

  function pickLocation() {
    const pId = provinceIds[Math.floor(Math.random() * provinceIds.length)];
    const dList = dByP[pId];
    if (!dList || dList.length === 0) return { pId, dId: null, sId: null };
    const dId = dList[Math.floor(Math.random() * dList.length)];
    const sList = sByD[dId];
    if (!sList || sList.length === 0) return { pId, dId, sId: null };
    const sId = sList[Math.floor(Math.random() * sList.length)];
    return { pId, dId, sId };
  }

  // ----- 2. ปิด safety constraints ชั่วคราว (เร่งความเร็ว) -----
  console.log('\n[2/3] Tuning MySQL for bulk insert...');
  const conn = await pool.getConnection();
  await conn.query('SET unique_checks = 0');
  await conn.query('SET foreign_key_checks = 0');
  await conn.query('SET autocommit = 0');

  // ----- 3. Batch insert -----
  console.log('\n[3/3] Inserting...');
  const insertSql = `
    INSERT INTO user_chaungthai (
      user_name, user_lastname, user_email, user_password,
      user_phone, user_address, user_bio,
      user_province_id, user_district_id, user_subdistrict_id
    ) VALUES ?
  `;

  let inserted = 0;
  const batches = Math.ceil(TOTAL / BATCH_SIZE);

  try {
    for (let b = 0; b < batches; b++) {
      const rows = [];
      const remaining = Math.min(BATCH_SIZE, TOTAL - inserted);

      for (let i = 0; i < remaining; i++) {
        const idx = inserted + i;
        const loc = pickLocation();
        rows.push([
          fakerTH.person.firstName(),                         // user_name
          fakerTH.person.lastName(),                          // user_lastname
          `fake_${RUN_ID}_${idx}@chaungthai-test.com`,        // unique email
          FAKE_PASSWORD_HASH,                                  // password (reused)
          '08' + faker.string.numeric(8),                      // user_phone
          fakerTH.location.streetAddress(),                    // user_address
          fakerTH.lorem.sentence(),                            // user_bio
          loc.pId,
          loc.dId,
          loc.sId,
        ]);
      }

      await conn.query(insertSql, [rows]);
      inserted += remaining;

      // commit ทุก 10K rows กัน transaction ใหญ่เกิน
      if (inserted % 10_000 === 0 || inserted === TOTAL) {
        await conn.query('COMMIT');
        await conn.query('START TRANSACTION');
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = Math.floor(inserted / elapsed);
        console.log(`   ${inserted.toLocaleString()} / ${TOTAL.toLocaleString()}  (${rate.toLocaleString()} rows/sec, ${elapsed.toFixed(1)}s elapsed)`);
      }
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    // คืนค่า safety
    await conn.query('SET unique_checks = 1');
    await conn.query('SET foreign_key_checks = 1');
    await conn.query('SET autocommit = 1');
    conn.release();
  }

  // ----- Done -----
  const totalSec = (Date.now() - startTime) / 1000;
  const rate = Math.floor(inserted / totalSec);

  console.log('\n============================================');
  console.log('  DONE');
  console.log('============================================');
  console.log(`  Inserted:  ${inserted.toLocaleString()}`);
  console.log(`  Time:      ${totalSec.toFixed(1)} seconds`);
  console.log(`  Rate:      ${rate.toLocaleString()} rows/second`);
  console.log(`  Email tag: fake_${RUN_ID}_*`);
  console.log('============================================');

  await pool.end();
})().catch(err => {
  console.error('SEED ERROR:', err);
  process.exit(1);
});
