// ============================================================
//  ChaungThai API - Main Server
//  Created: 2026-06-04
// ============================================================

// โหลด environment variables จากไฟล์ .env
require('dotenv').config();

// import express framework
const express = require('express');

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
