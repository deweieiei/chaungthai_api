// ============================================================
//  ChaungThai API - Main Server
//  Created: 2026-06-04
// ============================================================

// โหลด environment variables จากไฟล์ .env (ต้องอยู่บรรทัดแรกสุด)
require('dotenv').config();

// import express framework
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

// โหลด DB pool (จะลอง connect ตอน start - เห็นผลใน log)
require('./src/db');

// Socket.io setup (attach กับ http server ก่อน listen)
const { initSocket } = require('./src/socket');

// import routes
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const skillRoutes = require('./src/routes/skills');
const workerRoutes = require('./src/routes/workers');
const chatRoutes = require('./src/routes/chat');
const jobRoutes = require('./src/routes/jobs');
const favoriteRoutes = require('./src/routes/favorites');

// สร้าง app
const app = express();

// อ่าน PORT จาก .env ถ้าไม่มีใช้ 3000
const PORT = process.env.PORT || 3000;

// ============================================================
//  CORS (Cross-Origin Resource Sharing)
//  ให้ web ที่อยู่คนละ origin (เช่น :8086) เรียก API ที่ :443 ได้
//  อ่าน whitelist จาก env CORS_ORIGINS (comma separated) หรือ allow all ถ้าไม่ตั้ง
// ============================================================
const corsOriginsEnv = process.env.CORS_ORIGINS;
let corsOptions;
if (corsOriginsEnv && corsOriginsEnv.trim() !== '') {
  const whitelist = corsOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean);
  corsOptions = {
    origin: (origin, callback) => {
      // ไม่มี origin (เช่น curl, Postman, mobile app) -> อนุญาต
      if (!origin) return callback(null, true);
      if (whitelist.includes(origin)) return callback(null, true);
      return callback(new Error('CORS: origin not allowed -> ' + origin));
    },
    credentials: true,
  };
  console.log('[CORS] whitelist:', whitelist);
} else {
  // dev / ยังไม่ได้ตั้ง -> เปิดทั้งหมด
  corsOptions = { origin: true, credentials: true };
  console.log('[CORS] allow all origins (CORS_ORIGINS not set)');
}
app.use(cors(corsOptions));

// บอก express ให้ parse JSON body ของ request ได้
app.use(express.json());

// ============================================================
//  Static: /api/uploads/  -> serve ไฟล์ที่อัปโหลด (รูปโปรไฟล์ ฯลฯ)
// ============================================================
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
app.use('/api/uploads', express.static(UPLOADS_DIR, {
  maxAge: '7d',          // browser cache 7 วัน
  fallthrough: true,
}));
console.log('[uploads] serving from:', UPLOADS_DIR);

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
app.use('/api/workers', workerRoutes);
//  → POST /api/workers                (auth required)
//  → PUT  /api/workers/:id/skills     (auth + owner)
//  → PUT  /api/workers/:id/location   (auth + owner) — ปักหมุดจุดรับงาน
//  → GET  /api/workers/search         (public) — ค้นบนแผนที่: bbox หรือ lat/lng/radius_km
app.use('/api/chat', chatRoutes);
//  → GET  /api/chat/unread-count
//  → GET  /api/chat/conversations
//  → GET  /api/chat/conversations/with/:user_id
//  → GET  /api/chat/conversations/:conv_id/messages
//  → POST /api/chat/conversations/:conv_id/messages
app.use('/api/jobs', jobRoutes);
//  → POST  /api/jobs
//  → GET   /api/jobs (?role=employer|worker&status=...)
//  → GET   /api/jobs/unread-count
//  → GET   /api/jobs/:id
//  → PATCH /api/jobs/:id/status
app.use('/api/favorites', favoriteRoutes);
//  → GET    /api/favorites/workers
//  → POST   /api/favorites/workers/:worker_id
//  → DELETE /api/favorites/workers/:worker_id

// ============================================================
//  404 handler (ทุก route ที่ไม่ match ข้างบน)
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: 'ไม่พบ endpoint นี้', path: req.path });
});

// ============================================================
//  เริ่มรัน server
//  ใช้ http.createServer() เพื่อให้ socket.io attach ได้ (ใช้ server เดียวกับ express)
// ============================================================
const server = http.createServer(app);
initSocket(server, corsOptions);

server.listen(PORT, () => {
  console.log('============================================');
  console.log(`  ChaungThai API`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Test: http://localhost:${PORT}/api/health`);
  console.log(`  Socket.io at /api/socket.io`);
  console.log(`  Env: ${process.env.NODE_ENV || 'undefined'}`);
  console.log('============================================');
});
