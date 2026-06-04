// ============================================================
//  ChaungThai API - Main Server
//  Created: 2026-06-04
// ============================================================

// โหลด environment variables จากไฟล์ .env (ต้องอยู่บรรทัดแรกสุด)
require('dotenv').config();

// import express framework
const express = require('express');

// โหลด DB pool (จะลอง connect ตอน start - เห็นผลใน log)
require('./src/db');

// import routes
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const skillRoutes = require('./src/routes/skills');

// สร้าง app
const app = express();

// อ่าน PORT จาก .env ถ้าไม่มีใช้ 3000
const PORT = process.env.PORT || 3000;

// บอก express ให้ parse JSON body ของ request ได้
app.use(express.json());

// ============================================================
//  Endpoint #1: GET /api/health
//  ใช้เช็คว่า server ทำงานปกติไหม
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ChaungThai API is running',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ============================================================
//  Mount routes
// ============================================================
app.use('/api/auth', authRoutes);
//  → POST /api/auth/register
//  → POST /api/auth/login
app.use('/api/users', userRoutes);
//  → GET  /api/users/:user_id
//  → PUT  /api/users/:user_id  (auth required)
app.use('/api/skills', skillRoutes);
//  → GET  /api/skills  (tree: category -> subcategory -> skill)

// ============================================================
//  404 handler (ทุก route ที่ไม่ match ข้างบน)
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: 'ไม่พบ endpoint นี้', path: req.path });
});

// ============================================================
//  เริ่มรัน server
// ============================================================
app.listen(PORT, () => {
  console.log('============================================');
  console.log(`  ChaungThai API`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Test: http://localhost:${PORT}/api/health`);
  console.log(`  Env: ${process.env.NODE_ENV || 'undefined'}`);
  console.log('============================================');
});
