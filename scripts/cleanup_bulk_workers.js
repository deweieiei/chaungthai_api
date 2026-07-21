// ============================================================
//  Cleanup Bulk Workers — ลบช่างปลอมที่สร้างจาก seed_bulk_workers.js
//
//  ลบทีละก้อน (default 20,000 คน/รอบ) เพื่อไม่ให้ undo log บวม
//  และไม่ล็อกตารางยาวจนเว็บค้าง — ลบ 1 ล้านแถวรวดเดียวไม่ควรทำบนเครื่องจริง
//
//  Usage:
//    node scripts/cleanup_bulk_workers.js            # ลบจริง
//    node scripts/cleanup_bulk_workers.js --count    # นับอย่างเดียว ไม่ลบ
//    node scripts/cleanup_bulk_workers.js --chunk=50000
//
//  ปลอดภัย: แตะเฉพาะ user_email LIKE 'fake_%@chaungthai-test.com'
//           บัญชีจริงไม่โดน
// ============================================================

require('dotenv').config();
const mysql = require('mysql2/promise');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const CHUNK = Number(args.chunk) || 20000;
const COUNT_ONLY = Boolean(args.count);
const PATTERN = 'fake_%@chaungthai-test.com';

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chaungthai',
    charset: 'utf8mb4',
  });

  try {
    const [[before]] = await conn.query(
      'SELECT COUNT(*) AS n FROM user_chaungthai WHERE user_email LIKE ?',
      [PATTERN]
    );
    console.log(`ช่างปลอมในระบบตอนนี้: ${before.n.toLocaleString('th-TH')} คน`);

    if (COUNT_ONLY) {
      const [[real]] = await conn.query(
        'SELECT COUNT(*) AS n FROM user_chaungthai WHERE user_email NOT LIKE ?',
        [PATTERN]
      );
      console.log(`บัญชีจริง (ไม่โดนลบ): ${real.n.toLocaleString('th-TH')} คน`);
      return;
    }
    if (before.n === 0) {
      console.log('ไม่มีอะไรให้ลบ');
      return;
    }

    const t0 = Date.now();
    let removed = 0;

    // worker_chaungthai + workerskill_chaungthai มี FK ON DELETE CASCADE
    // → ลบ user แล้วลูกหายตามเอง
    for (;;) {
      const [res] = await conn.query(
        'DELETE FROM user_chaungthai WHERE user_email LIKE ? LIMIT ?',
        [PATTERN, CHUNK]
      );
      if (res.affectedRows === 0) break;
      removed += res.affectedRows;
      const sec = (Date.now() - t0) / 1000;
      console.log(
        `  ลบแล้ว ${removed.toLocaleString('th-TH')} / ${before.n.toLocaleString('th-TH')}` +
        `  (${Math.round(removed / Math.max(sec, 0.001)).toLocaleString('th-TH')} แถว/วิ)`
      );
    }

    const [[after]] = await conn.query(
      `SELECT
        (SELECT COUNT(*) FROM user_chaungthai) AS users,
        (SELECT COUNT(*) FROM worker_chaungthai) AS workers,
        (SELECT COUNT(*) FROM workerskill_chaungthai) AS workerskills`
    );
    console.log(`\nเสร็จใน ${((Date.now() - t0) / 1000).toFixed(1)} วินาที`);
    console.log(`เหลือในระบบ — ผู้ใช้ ${after.users} · ช่าง ${after.workers} · แถวสกิล ${after.workerskills}`);
  } catch (err) {
    console.error('[cleanup] ล้มเหลว:', err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
