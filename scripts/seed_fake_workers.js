// ============================================================
//  Seed Fake Workers
//
//  สำหรับ user ที่ email = "fake_*@chaungthai-test.com":
//    1. random 10% เป็นช่าง -> INSERT worker_chaungthai (tickets=25)
//    2. UPDATE user_role = 'worker' ของ user เหล่านั้น
//    3. แต่ละช่าง random เลือก 3-10 skills -> INSERT workerskill_chaungthai
//
//  Usage:
//    node scripts/seed_fake_workers.js [ratio]
//      ratio = สัดส่วน user ที่จะเป็น worker (default 0.1 = 10%)
//
//  Examples:
//    node scripts/seed_fake_workers.js          # 10% ของ fake user
//    node scripts/seed_fake_workers.js 0.05     # 5%
//
//  ปลอดภัย:
//    - เลือกเฉพาะ fake users (LIKE 'fake_%@chaungthai-test.com')
//    - ไม่กระทบ user จริงเลย
//    - skip user ที่เป็น worker อยู่แล้ว (กันรันซ้ำ)
// ============================================================

require('dotenv').config();
const mysql = require('mysql2/promise');
const { faker } = require('@faker-js/faker');

const RATIO = Number(process.argv[2]) || 0.1;
const BATCH_SIZE = 1000;
const MIN_SKILLS = 3;
const MAX_SKILLS = 10;
const DEFAULT_TICKETS = 25;

console.log('============================================');
console.log('  Seed Fake Workers');
console.log('============================================');
console.log(`  RATIO:        ${(RATIO * 100).toFixed(1)}% ของ fake users`);
console.log(`  SKILLS/worker: ${MIN_SKILLS}-${MAX_SKILLS} (random)`);
console.log(`  TICKETS:      ${DEFAULT_TICKETS} (start)`);
console.log('============================================');

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomN(array, n) {
  const result = [];
  const taken = new Set();
  while (result.length < n && result.length < array.length) {
    const idx = Math.floor(Math.random() * array.length);
    if (!taken.has(idx)) {
      taken.add(idx);
      result.push(array[idx]);
    }
  }
  return result;
}

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
  });

  // ----- 1. หา fake users ที่ยังไม่เป็น worker -----
  console.log('\n[1/5] Loading fake users (not yet worker)...');
  const [fakeUsers] = await pool.query(`
    SELECT u.user_id
      FROM user_chaungthai u
      LEFT JOIN worker_chaungthai w ON w.worker_user_id = u.user_id
     WHERE u.user_email LIKE 'fake_%@chaungthai-test.com'
       AND w.worker_id IS NULL
  `);
  console.log(`   fake users (eligible): ${fakeUsers.length.toLocaleString()}`);

  if (fakeUsers.length === 0) {
    console.log('   ❌ no eligible users — run seed_fake_users.js first');
    await pool.end();
    return;
  }

  const targetCount = Math.floor(fakeUsers.length * RATIO);
  console.log(`   will create: ${targetCount.toLocaleString()} workers`);

  const selectedUsers = pickRandomN(fakeUsers, targetCount);

  // ----- 2. โหลด active skills -----
  console.log('\n[2/5] Loading active skills...');
  const [skills] = await pool.query(
    'SELECT skill_id FROM skill_chaungthai WHERE skill_is_active = 1'
  );
  const skillIds = skills.map(s => s.skill_id);
  console.log(`   active skills: ${skillIds.length}`);

  // ----- 3. INSERT worker_chaungthai (batched) -----
  console.log('\n[3/5] Inserting worker rows...');
  const conn = await pool.getConnection();
  await conn.query('SET unique_checks = 0');
  await conn.query('SET foreign_key_checks = 0');
  await conn.query('SET autocommit = 0');

  let workerInserted = 0;
  let workerIdsByUserId = {}; // map user_id -> worker_id (เก็บไว้ใส่ workerskill)

  try {
    for (let i = 0; i < selectedUsers.length; i += BATCH_SIZE) {
      const chunk = selectedUsers.slice(i, i + BATCH_SIZE);
      const rows = chunk.map(u => [
        u.user_id,
        DEFAULT_TICKETS,
        0,
        faker.lorem.paragraph(),
      ]);

      const [result] = await conn.query(
        `INSERT INTO worker_chaungthai
           (worker_user_id, worker_job_tickets, worker_total_jobs, worker_resume)
         VALUES ?`,
        [rows]
      );

      // mysql2: result.insertId = first inserted id (sequential)
      const firstId = result.insertId;
      for (let j = 0; j < chunk.length; j++) {
        workerIdsByUserId[chunk[j].user_id] = firstId + j;
      }

      workerInserted += chunk.length;

      if (workerInserted % 10_000 === 0 || workerInserted === selectedUsers.length) {
        await conn.query('COMMIT');
        await conn.query('START TRANSACTION');
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = Math.floor(workerInserted / elapsed);
        console.log(`   ${workerInserted.toLocaleString()} / ${selectedUsers.length.toLocaleString()}  (${rate.toLocaleString()} rows/sec)`);
      }
    }
    await conn.query('COMMIT');

    // ----- 4. UPDATE user_role = 'worker' (batched) -----
    console.log('\n[4/5] Updating user_role to "worker"...');
    const userIds = selectedUsers.map(u => u.user_id);
    await conn.query('START TRANSACTION');
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const chunk = userIds.slice(i, i + BATCH_SIZE);
      await conn.query(
        `UPDATE user_chaungthai SET user_role = 'worker' WHERE user_id IN (?)`,
        [chunk]
      );
    }
    await conn.query('COMMIT');
    console.log(`   role updated: ${userIds.length.toLocaleString()}`);

    // ----- 5. INSERT workerskill_chaungthai -----
    console.log('\n[5/5] Inserting workerskill assignments...');
    await conn.query('START TRANSACTION');

    let skillInserted = 0;
    const skillRowsBuf = [];
    const SKILL_BATCH = 5000; // workerskill มี row เยอะ ใช้ batch ใหญ่ขึ้น

    for (const userId of userIds) {
      const workerId = workerIdsByUserId[userId];
      const n = randomInt(MIN_SKILLS, MAX_SKILLS);
      const picked = pickRandomN(skillIds, n);
      for (const sid of picked) {
        skillRowsBuf.push([workerId, sid]);
      }

      if (skillRowsBuf.length >= SKILL_BATCH) {
        await conn.query(
          `INSERT INTO workerskill_chaungthai
             (workerskill_worker_id, workerskill_skill_id) VALUES ?`,
          [skillRowsBuf.splice(0, skillRowsBuf.length)]
        );
        skillInserted += SKILL_BATCH;

        if (skillInserted % 50_000 === 0) {
          await conn.query('COMMIT');
          await conn.query('START TRANSACTION');
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(`   ${skillInserted.toLocaleString()} skill assignments (${Math.floor(skillInserted / elapsed)} rows/sec)`);
        }
      }
    }
    // flush remaining
    if (skillRowsBuf.length > 0) {
      await conn.query(
        `INSERT INTO workerskill_chaungthai
           (workerskill_worker_id, workerskill_skill_id) VALUES ?`,
        [skillRowsBuf]
      );
      skillInserted += skillRowsBuf.length;
    }
    await conn.query('COMMIT');

    console.log(`   total skill assignments: ${skillInserted.toLocaleString()}`);

    // ----- Done -----
    const totalSec = (Date.now() - startTime) / 1000;
    console.log('\n============================================');
    console.log('  DONE');
    console.log('============================================');
    console.log(`  Workers created:      ${workerInserted.toLocaleString()}`);
    console.log(`  User roles updated:   ${userIds.length.toLocaleString()}`);
    console.log(`  Skill assignments:    ${skillInserted.toLocaleString()}`);
    console.log(`  Avg skills/worker:    ${(skillInserted / workerInserted).toFixed(1)}`);
    console.log(`  Total time:           ${totalSec.toFixed(1)} seconds`);
    console.log('============================================');
  } catch (err) {
    await conn.query('ROLLBACK');
    console.error('SEED ERROR:', err);
    throw err;
  } finally {
    await conn.query('SET unique_checks = 1');
    await conn.query('SET foreign_key_checks = 1');
    await conn.query('SET autocommit = 1');
    conn.release();
  }

  await pool.end();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
