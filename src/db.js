// ============================================================
//  MySQL Connection Pool
//  ใช้ mysql2 + promise (async/await ได้)
// ============================================================

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'chaungthai',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

// ทดสอบ connection ตอน start (จะ log error ใน console ถ้าเชื่อมไม่ได้)
pool.getConnection()
  .then((conn) => {
    console.log(`[DB] Connected to ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
    conn.release();
  })
  .catch((err) => {
    console.error('[DB] Connection failed:', err.message);
  });

module.exports = pool;
