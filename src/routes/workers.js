// ============================================================
//  Workers Routes
//  Mounted at: /api/workers
//
//  POST /api/workers              - สมัครเป็นช่าง (login + ยังไม่เป็นช่าง)
//  PUT  /api/workers/:id/skills   - เลือกสกิลของช่าง (replace mode)
//  GET  /api/workers/search       - ค้นหาช่างตามสกิล + พื้นที่
//  GET  /api/workers/:id          - รายละเอียดช่างคนเดียว (skills+portfolio)
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../db');
const { verifyToken, requireAccountType } = require('../middleware/auth');
const {
  parseLatLng,
  bboxFromRadius,
  distanceKm,
  publicCoords,
} = require('../lib/geo');

const router = express.Router();

// ตั๋วเริ่มต้นตอนสมัครเป็นช่าง
const DEFAULT_JOB_TICKETS = 25;

// ------------------------------------------------------------
//  Upload config: crime document + portfolio image
// ------------------------------------------------------------
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');
const CRIME_DIR = path.join(UPLOADS_DIR, 'crime-docs');
const PORTFOLIO_DIR = path.join(UPLOADS_DIR, 'portfolio');
fs.mkdirSync(CRIME_DIR, { recursive: true });
fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

const UPLOAD_MAX = Number(process.env.UPLOAD_MAX_BYTES) || 5 * 1024 * 1024;

function makeStorage(dir, prefix) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      let ext = path.extname(file.originalname || '').toLowerCase();
      const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
      if (!allowedExt.includes(ext)) {
        const map = {
          'image/jpeg': '.jpg',
          'image/png': '.png',
          'image/webp': '.webp',
          'application/pdf': '.pdf',
        };
        ext = map[file.mimetype] || '.bin';
      }
      const wid = (req.params && req.params.worker_id) || 'anon';
      const ts = Date.now();
      cb(null, `${prefix}_${wid}_${ts}${ext}`);
    },
  });
}

const crimeUpload = multer({
  storage: makeStorage(CRIME_DIR, 'crime'),
  limits: { fileSize: UPLOAD_MAX },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('รองรับเฉพาะไฟล์ jpg/png/webp/pdf'));
  },
});

const portfolioUpload = multer({
  storage: makeStorage(PORTFOLIO_DIR, 'portfolio'),
  limits: { fileSize: UPLOAD_MAX },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('รองรับเฉพาะไฟล์รูป jpg/png/webp'));
  },
});

// helper: ตรวจรัศมีรับงาน — คืนตัวเลข, null (ไม่ส่งมา = ใช้ default), หรือ 'INVALID'
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 200;          // รัศมีรับงานที่ช่างตั้งเอง
const MAX_SEARCH_RADIUS_KM = 50;    // เพดานการมองเห็นบนแผนที่ — ดูได้แค่รอบตัว
function parseRadiusKm(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RADIUS_KM) return 'INVALID';
  return n;
}

// helper: คนที่กำลังดูอยู่ ยืนยันตัวตนแล้วหรือยัง (ใช้ตัดสินว่าเห็นพิกัดจริงหรือพิกัดเบลอ)
async function isViewerVerified(viewer) {
  if (!viewer || !viewer.user_id) return false;
  const [rows] = await pool.execute(
    'SELECT user_identity_verified_at FROM user_chaungthai WHERE user_id = ? LIMIT 1',
    [viewer.user_id]
  );
  return Boolean(rows[0] && rows[0].user_identity_verified_at);
}

// helper: ตรวจว่า user_id ที่ login เป็นเจ้าของ worker_id หรือไม่
async function assertWorkerOwner(workerId, userId, conn = pool) {
  const [rows] = await conn.execute(
    'SELECT worker_user_id FROM worker_chaungthai WHERE worker_id = ? LIMIT 1',
    [workerId]
  );
  if (rows.length === 0) return { error: 'ไม่พบช่างที่ระบุ', status: 404 };
  if (rows[0].worker_user_id !== userId) return { error: 'ไม่อนุญาตให้แก้ไขข้อมูลของผู้อื่น', status: 403 };
  return { ok: true };
}

// ============================================================
//  POST /api/workers
//  สมัครเป็นช่าง (1 transaction รวมทุกอย่าง):
//    1. INSERT worker_chaungthai (resume + tickets=25)
//    2. INSERT workerskill_chaungthai (skill_ids ที่เลือก) - ถ้ามี
//    3. UPDATE user_chaungthai SET user_role='worker'
//
//  Body:
//    {
//      "worker_resume": "ประวัติ ประสบการณ์..." (optional),
//      "skill_ids": [1, 11, 13],               (optional, max 50)
//      "worker_lat": 18.7883,                  (optional — หมุดจุดรับงาน)
//      "worker_lng": 98.9853,
//      "worker_service_radius_km": 15          (optional, default 10)
//    }
//
//  สมัครซ้ำ -> 409
// ============================================================
router.post('/', verifyToken, requireAccountType('worker'), async (req, res) => {
  const userId = req.user.user_id;
  const body = req.body || {};

  // --- 1) parse + validate input ---
  const worker_resume =
    typeof body.worker_resume === 'string' && body.worker_resume.trim() !== ''
      ? body.worker_resume.trim()
      : null;

  // หมุดบนแผนที่ — ไม่ส่งมาก็สมัครได้ แต่จะยังไม่ขึ้นแผนที่จนกว่าจะปักหมุด
  let lat = null;
  let lng = null;
  if (body.worker_lat !== undefined && body.worker_lat !== null && body.worker_lat !== '') {
    const geo = parseLatLng(body.worker_lat, body.worker_lng);
    if (!geo.ok) return res.status(400).json({ error: geo.error });
    lat = geo.lat;
    lng = geo.lng;
  }

  const radiusKm = parseRadiusKm(body.worker_service_radius_km);
  if (radiusKm === 'INVALID') {
    return res.status(400).json({ error: 'รัศมีรับงานต้องเป็นจำนวนเต็ม 1-200 กม.' });
  }

  let uniqueSkillIds = [];
  if (body.skill_ids !== undefined && body.skill_ids !== null) {
    if (!Array.isArray(body.skill_ids)) {
      return res.status(400).json({ error: 'skill_ids ต้องเป็น array' });
    }
    uniqueSkillIds = [...new Set(body.skill_ids.map((x) => Number(x)))];
    if (uniqueSkillIds.some((x) => !Number.isInteger(x) || x < 1)) {
      return res.status(400).json({ error: 'skill_ids ต้องเป็นจำนวนเต็มบวก' });
    }
    if (uniqueSkillIds.length > 50) {
      return res.status(400).json({ error: 'เลือกสกิลไม่เกิน 50 รายการ' });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // --- 2) เช็คซ้ำ ---
    const [existing] = await conn.execute(
      'SELECT worker_id FROM worker_chaungthai WHERE worker_user_id = ? LIMIT 1',
      [userId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        error: 'คุณเป็นช่างอยู่แล้ว',
        worker_id: existing[0].worker_id,
      });
    }

    // --- 3) validate skill_ids มีจริง + active ---
    if (uniqueSkillIds.length > 0) {
      const placeholders = uniqueSkillIds.map(() => '?').join(',');
      const [exists] = await conn.query(
        `SELECT skill_id FROM skill_chaungthai
          WHERE skill_id IN (${placeholders}) AND skill_is_active = 1`,
        uniqueSkillIds
      );
      if (exists.length !== uniqueSkillIds.length) {
        await conn.rollback();
        const foundIds = exists.map((r) => r.skill_id);
        const missingIds = uniqueSkillIds.filter((x) => !foundIds.includes(x));
        return res.status(400).json({
          error: 'มี skill_id บางตัวไม่มีในระบบหรือถูกปิดใช้',
          missing_skill_ids: missingIds,
        });
      }
    }

    // --- 4) INSERT worker_chaungthai (resume + tickets=25 + หมุดแผนที่) ---
    const [result] = await conn.execute(
      `INSERT INTO worker_chaungthai
        (worker_user_id, worker_resume, worker_job_tickets,
         worker_lat, worker_lng, worker_service_radius_km)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        worker_resume,
        DEFAULT_JOB_TICKETS,
        lat,
        lng,
        radiusKm === null ? DEFAULT_RADIUS_KM : radiusKm,
      ]
    );
    const newWorkerId = result.insertId;

    // --- 5) INSERT workerskill_chaungthai (ถ้าส่ง skills มา) ---
    if (uniqueSkillIds.length > 0) {
      const values = uniqueSkillIds.map(() => '(?, ?)').join(', ');
      const params = [];
      for (const sid of uniqueSkillIds) {
        params.push(newWorkerId, sid);
      }
      await conn.query(
        `INSERT INTO workerskill_chaungthai
          (workerskill_worker_id, workerskill_skill_id) VALUES ${values}`,
        params
      );
    }

    // --- 6) UPDATE user_role = 'worker' ---
    await conn.execute(
      `UPDATE user_chaungthai SET user_role = 'worker' WHERE user_id = ?`,
      [userId]
    );

    await conn.commit();

    return res.status(201).json({
      message: 'สมัครเป็นช่างสำเร็จ',
      worker_id: newWorkerId,
      worker_user_id: userId,
      worker_resume,
      worker_job_tickets: DEFAULT_JOB_TICKETS,
      worker_total_jobs: 0,
      worker_lat: lat,
      worker_lng: lng,
      worker_service_radius_km: radiusKm === null ? DEFAULT_RADIUS_KM : radiusKm,
      worker_availability: 'free',
      has_pin: lat !== null,
      skill_count: uniqueSkillIds.length,
      skill_ids: uniqueSkillIds,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[workers][POST] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
});

// ============================================================
//  PUT /api/workers/:worker_id/skills
//  เลือก/แทนที่สกิลของช่าง (replace mode - ส่ง array มาทั้งชุด)
//  Body: { "skill_ids": [1, 5, 7] }
// ============================================================
router.put('/:worker_id/skills', verifyToken, async (req, res) => {
  const workerId = Number(req.params.worker_id);
  if (!Number.isInteger(workerId) || workerId < 1) {
    return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
  }

  const body = req.body || {};
  const skillIds = Array.isArray(body.skill_ids) ? body.skill_ids : null;
  if (!skillIds) {
    return res.status(400).json({ error: 'skill_ids ต้องเป็น array' });
  }

  // ตรวจว่าทุกค่าเป็น integer
  const uniqueIds = [...new Set(skillIds.map((x) => Number(x)))];
  if (uniqueIds.some((x) => !Number.isInteger(x) || x < 1)) {
    return res.status(400).json({ error: 'skill_ids ต้องเป็นจำนวนเต็มบวก' });
  }
  if (uniqueIds.length > 50) {
    return res.status(400).json({ error: 'เลือกสกิลไม่เกิน 50 รายการ' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. หา worker + เช็คเจ้าของ
    const [w] = await conn.execute(
      'SELECT worker_user_id FROM worker_chaungthai WHERE worker_id = ? LIMIT 1',
      [workerId]
    );
    if (w.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'ไม่พบช่างที่ระบุ' });
    }
    if (w[0].worker_user_id !== req.user.user_id) {
      await conn.rollback();
      return res.status(403).json({ error: 'ไม่อนุญาตให้แก้ไขข้อมูลของผู้อื่น' });
    }

    // 2. ตรวจว่า skill_ids มีจริงทั้งหมด
    if (uniqueIds.length > 0) {
      const placeholders = uniqueIds.map(() => '?').join(',');
      const [exists] = await conn.query(
        `SELECT skill_id FROM skill_chaungthai
          WHERE skill_id IN (${placeholders}) AND skill_is_active = 1`,
        uniqueIds
      );
      if (exists.length !== uniqueIds.length) {
        await conn.rollback();
        const foundIds = exists.map((r) => r.skill_id);
        const missingIds = uniqueIds.filter((x) => !foundIds.includes(x));
        return res.status(400).json({
          error: 'มี skill_id บางตัวไม่มีในระบบหรือถูกปิดใช้',
          missing_skill_ids: missingIds,
        });
      }
    }

    // 3. DELETE ของเก่า + INSERT ของใหม่ (replace mode)
    await conn.execute(
      'DELETE FROM workerskill_chaungthai WHERE workerskill_worker_id = ?',
      [workerId]
    );

    if (uniqueIds.length > 0) {
      const values = uniqueIds.map(() => '(?, ?)').join(', ');
      const params = [];
      for (const sid of uniqueIds) {
        params.push(workerId, sid);
      }
      await conn.query(
        `INSERT INTO workerskill_chaungthai
          (workerskill_worker_id, workerskill_skill_id) VALUES ${values}`,
        params
      );
    }

    await conn.commit();

    return res.json({
      message: 'อัปเดตสกิลของช่างสำเร็จ',
      worker_id: workerId,
      skill_count: uniqueIds.length,
      skill_ids: uniqueIds,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[workers][PUT skills] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
});

// ============================================================
//  PUT /api/workers/:worker_id/location
//  ปักหมุด / ย้ายหมุดจุดรับงาน + ตั้งรัศมี (login + เจ้าของ)
//  Body: { "worker_lat": 18.7883, "worker_lng": 98.9853, "worker_service_radius_km": 15 }
// ============================================================
router.put('/:worker_id/location', verifyToken, async (req, res) => {
  try {
    const workerId = Number(req.params.worker_id);
    if (!Number.isInteger(workerId) || workerId < 1) {
      return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
    }

    const body = req.body || {};
    const geo = parseLatLng(body.worker_lat, body.worker_lng);
    if (!geo.ok) return res.status(400).json({ error: geo.error });

    const radiusKm = parseRadiusKm(body.worker_service_radius_km);
    if (radiusKm === 'INVALID') {
      return res.status(400).json({ error: 'รัศมีรับงานต้องเป็นจำนวนเต็ม 1-200 กม.' });
    }

    const check = await assertWorkerOwner(workerId, req.user.user_id);
    if (check.error) return res.status(check.status).json({ error: check.error });

    // ไม่ส่งรัศมีมา = คงค่าเดิมไว้
    const sets = ['worker_lat = ?', 'worker_lng = ?'];
    const params = [geo.lat, geo.lng];
    if (radiusKm !== null) {
      sets.push('worker_service_radius_km = ?');
      params.push(radiusKm);
    }
    params.push(workerId);

    await pool.execute(
      `UPDATE worker_chaungthai SET ${sets.join(', ')} WHERE worker_id = ?`,
      params
    );

    const [rows] = await pool.execute(
      `SELECT worker_lat, worker_lng, worker_service_radius_km, worker_availability
         FROM worker_chaungthai WHERE worker_id = ? LIMIT 1`,
      [workerId]
    );

    return res.json({
      message: 'บันทึกตำแหน่งรับงานแล้ว',
      worker_id: workerId,
      worker_lat: rows[0] ? Number(rows[0].worker_lat) : geo.lat,
      worker_lng: rows[0] ? Number(rows[0].worker_lng) : geo.lng,
      worker_service_radius_km: rows[0]?.worker_service_radius_km ?? DEFAULT_RADIUS_KM,
      worker_availability: rows[0]?.worker_availability ?? 'free',
    });
  } catch (err) {
    console.error('[workers][PUT location] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  PUT /api/workers/:worker_id/schedule
//  ตั้งเวลาทำงานประจำสัปดาห์ (login + เจ้าของ) — replace mode ส่งมาทั้งชุด
//
//  Body: { "schedule": [
//            { "day": 1, "start": "08:00", "end": "17:00" },
//            { "day": 2, "start": "08:00", "end": "17:00" }
//         ]}
//  day: 0=อาทิตย์ ... 6=เสาร์ · วันที่ไม่ส่งมา = วันนั้นไม่รับงาน
//  ส่ง [] = ไม่ระบุเวลา (ถือว่าติดต่อได้ตลอด)
// ============================================================
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

router.put('/:worker_id/schedule', verifyToken, requireAccountType('worker'), async (req, res) => {
  const workerId = Number(req.params.worker_id);
  if (!Number.isInteger(workerId) || workerId < 1) {
    return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
  }

  const raw = (req.body || {}).schedule;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'schedule ต้องเป็น array' });
  }
  if (raw.length > 7) {
    return res.status(400).json({ error: 'มีได้ไม่เกิน 7 วัน' });
  }

  // ----- ตรวจแต่ละวัน -----
  const rows = [];
  const seenDays = new Set();
  for (const item of raw) {
    const day = Number(item && item.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return res.status(400).json({ error: 'day ต้องเป็น 0-6 (0=อาทิตย์)' });
    }
    if (seenDays.has(day)) {
      return res.status(400).json({ error: 'ส่งวันซ้ำกันมา — วันละ 1 ช่วงเวลาเท่านั้น' });
    }
    seenDays.add(day);

    const start = String((item && item.start) || '');
    const end = String((item && item.end) || '');
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return res.status(400).json({ error: 'เวลาต้องอยู่ในรูปแบบ HH:MM (00:00-23:59)' });
    }
    if (end <= start) {
      // เทียบ string ได้เลยเพราะ HH:MM แบบเติมศูนย์หน้าเรียงตามเวลาจริง
      return res.status(400).json({ error: 'เวลาเลิกงานต้องอยู่หลังเวลาเริ่มงาน' });
    }
    rows.push([workerId, day, start + ':00', end + ':00']);
  }

  const conn = await pool.getConnection();
  try {
    const check = await assertWorkerOwner(workerId, req.user.user_id, conn);
    if (check.error) {
      conn.release();
      return res.status(check.status).json({ error: check.error });
    }

    await conn.beginTransaction();
    await conn.execute(
      'DELETE FROM worker_schedule_chaungthai WHERE sched_worker_id = ?',
      [workerId]
    );
    if (rows.length > 0) {
      await conn.query(
        `INSERT INTO worker_schedule_chaungthai
          (sched_worker_id, sched_day, sched_start, sched_end) VALUES ?`,
        [rows]
      );
    }
    await conn.commit();

    return res.json({
      message: rows.length
        ? `บันทึกเวลาทำงาน ${rows.length} วันแล้ว`
        : 'ล้างเวลาทำงานแล้ว — ถือว่าติดต่อได้ตลอด',
      worker_id: workerId,
      schedule: rows.map(([, day, s, e]) => ({
        day,
        start: s.slice(0, 5),
        end: e.slice(0, 5),
      })),
    });
  } catch (err) {
    await conn.rollback();
    console.error('[workers][PUT schedule] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
});

// ============================================================
//  GET /api/workers/search
//  ค้นหาช่างบนแผนที่ (แทนระบบจังหวัด/อำเภอ/ตำบลเดิม)
//
//  Skill filter (optional - ระดับใดระดับหนึ่ง; ไม่ระบุ = ทุกสกิล):
//    skill_id              - กรองด้วยสกิลเดียว (เฉพาะที่สุด)
//    skill_subcategory_id  - กรองทุกสกิลใน subcategory นี้
//    skill_category_id     - กรองทุกสกิลใน category นี้ (สาขา)
//    ถ้าระบุหลายตัว ใช้อันที่เฉพาะที่สุด: skill > subcategory > category
//
//  พื้นที่ (required - เลือก 1 แบบ):
//    bbox=min_lat,min_lng,max_lat,max_lng   กรอบแผนที่ที่ผู้ใช้เห็นอยู่
//    lat=..&lng=..&radius_km=..             ปุ่ม "ใกล้ฉัน" (radius default 10, max 200)
//
//  อื่นๆ:
//    include_busy - 'true' = เอาช่างที่ติดงานอยู่มาด้วย (default: เฉพาะช่างว่าง)
//    limit        - default 50, max 200
//
//  หมายเหตุพิกัด: คนที่ยังไม่ยืนยันตัวตนจะได้พิกัด "เบลอ" ปัดกริด ~1 กม.
//  (ดู src/lib/geo.js + docs/04_ระบบแผนที่.md)
// ============================================================
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const q = req.query;

    const parsePosInt = (v) => {
      if (v === undefined || v === '' || v === null) return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : 'INVALID';
    };

    // ----- skill filter (all optional) -----
    const skillId = parsePosInt(q.skill_id);
    const subcatId = parsePosInt(q.skill_subcategory_id);
    const catId = parsePosInt(q.skill_category_id);
    if (skillId === 'INVALID' || subcatId === 'INVALID' || catId === 'INVALID') {
      return res.status(400).json({ error: 'skill_id / skill_subcategory_id / skill_category_id ต้องเป็นจำนวนเต็มบวก' });
    }

    // ----- พื้นที่: รัศมีรอบจุดที่ระบุเท่านั้น -----
    //  ไม่รับ bbox แล้ว — เดิมเปิดให้ส่งกรอบกว้างเท่าไหร่ก็ได้ = กวาดช่างทั้งประเทศ
    //  ตอนนี้จำกัดไว้ที่ MAX_SEARCH_RADIUS_KM เพื่อให้ดูได้แค่รอบตัวเอง
    if (q.lat === undefined || q.lng === undefined) {
      return res.status(400).json({
        error: 'กรุณาระบุตำแหน่ง: lat, lng และ radius_km (สูงสุด ' + MAX_SEARCH_RADIUS_KM + ' กม.)',
      });
    }

    const geo = parseLatLng(q.lat, q.lng);
    if (!geo.ok) return res.status(400).json({ error: geo.error });

    //  ไม่ใช้ parseRadiusKm ตรงนี้ เพราะตัวนั้นคุมรัศมี "รับงานของช่าง" (สูงสุด 200)
    //  ส่วนรัศมี "การมองเห็นบนแผนที่" หั่นลงเงียบ ๆ ไม่ต้อง error
    let r = DEFAULT_RADIUS_KM;
    if (q.radius_km !== undefined && q.radius_km !== '') {
      const n = Number(q.radius_km);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ error: 'radius_km ต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป' });
      }
      r = Math.min(Math.round(n), MAX_SEARCH_RADIUS_KM);
    }

    const center = { lat: geo.lat, lng: geo.lng, radiusKm: r };
    const box = bboxFromRadius(geo.lat, geo.lng, r);   // กรองหยาบใน SQL ก่อน

    // ช่างที่ติดงานอยู่จะหายจากแผนที่ (docs/04 ข้อ 4.5) เว้นแต่ขอมาชัดเจน
    const includeBusy = String(q.include_busy || '').toLowerCase() === 'true';

    let limit = Number(q.limit) || 50;
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    // ----- เลือกหลายสกิลพร้อมกัน (ตัวกรองแบบ skill tree) -----
    //  skill_ids=1,5,7 → เจอช่างที่มีสกิล "อย่างน้อย 1 อัน" ในรายการ
    //  มาก่อน filter ตัวเดียวแบบเดิม เพราะเฉพาะเจาะจงกว่า
    let skillIds = [];
    if (q.skill_ids !== undefined && String(q.skill_ids).trim() !== '') {
      skillIds = String(q.skill_ids)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (skillIds.length === 0) {
        return res.status(400).json({ error: 'skill_ids ต้องเป็นรายการจำนวนเต็มบวก คั่นด้วยจุลภาค' });
      }
      if (skillIds.length > 200) {
        return res.status(400).json({ error: 'เลือกสกิลกรองได้ไม่เกิน 200 อัน' });
      }
      skillIds = [...new Set(skillIds)];
    }

    // ----- เลือก skill filter ที่เฉพาะที่สุด -----
    //   skill_ids > skill > subcategory > category
    let skillCond = '';
    let skillParam = null;
    let appliedFilter = null;  // 'skills' | 'skill' | 'subcategory' | 'category' | null
    if (skillIds.length > 0) {
      skillCond = `AND sk.skill_id IN (${skillIds.map(() => '?').join(',')})`;
      skillParam = skillIds;      // array — จะ spread ตอนใส่ params
      appliedFilter = 'skills';
    } else if (skillId) {
      skillCond = 'AND sk.skill_id = ?';
      skillParam = skillId;
      appliedFilter = 'skill';
    } else if (subcatId) {
      skillCond = 'AND sk.skill_subcategory_id = ?';
      skillParam = subcatId;
      appliedFilter = 'subcategory';
    } else if (catId) {
      // category → ผ่าน sub join
      skillCond = 'AND sub.skill_subcategory_category_id = ?';
      skillParam = catId;
      appliedFilter = 'category';
    }
    // ไม่ระบุอะไรเลย → skillCond = '' = ทุกสกิล

    // ----- ดึง label ของ filter (สำหรับ frontend แสดงผล) -----
    let filterInfo = {
      skill_ids: skillIds.length ? skillIds : null,
      skill_id: skillId || null,
      skill_subcategory_id: subcatId || null,
      skill_category_id: catId || null,
      skill_names_th: null,
      skill_name_th: null,
      skill_subcategory_name_th: null,
      skill_category_name_th: null,
    };
    if (appliedFilter === 'skills') {
      const [rows] = await pool.query(
        `SELECT skill_id, skill_name_th FROM skill_chaungthai WHERE skill_id IN (?)`,
        [skillIds]
      );
      filterInfo.skill_names_th = rows.map((r) => r.skill_name_th);
    } else if (appliedFilter === 'skill') {
      const [rows] = await pool.execute(
        `SELECT sk.skill_id, sk.skill_name_th,
                sub.skill_subcategory_id, sub.skill_subcategory_name_th,
                cat.skill_category_id, cat.skill_category_name_th
           FROM skill_chaungthai sk
           LEFT JOIN skill_subcategory_chaungthai sub ON sub.skill_subcategory_id = sk.skill_subcategory_id
           LEFT JOIN skill_category_chaungthai cat ON cat.skill_category_id = sub.skill_subcategory_category_id
          WHERE sk.skill_id = ? LIMIT 1`,
        [skillId]
      );
      if (rows[0]) {
        filterInfo.skill_name_th = rows[0].skill_name_th;
        filterInfo.skill_subcategory_id = rows[0].skill_subcategory_id;
        filterInfo.skill_subcategory_name_th = rows[0].skill_subcategory_name_th;
        filterInfo.skill_category_id = rows[0].skill_category_id;
        filterInfo.skill_category_name_th = rows[0].skill_category_name_th;
      }
    } else if (appliedFilter === 'subcategory') {
      const [rows] = await pool.execute(
        `SELECT sub.skill_subcategory_id, sub.skill_subcategory_name_th,
                cat.skill_category_id, cat.skill_category_name_th
           FROM skill_subcategory_chaungthai sub
           LEFT JOIN skill_category_chaungthai cat ON cat.skill_category_id = sub.skill_subcategory_category_id
          WHERE sub.skill_subcategory_id = ? LIMIT 1`,
        [subcatId]
      );
      if (rows[0]) {
        filterInfo.skill_subcategory_name_th = rows[0].skill_subcategory_name_th;
        filterInfo.skill_category_id = rows[0].skill_category_id;
        filterInfo.skill_category_name_th = rows[0].skill_category_name_th;
      }
    } else if (appliedFilter === 'category') {
      const [rows] = await pool.execute(
        `SELECT skill_category_id, skill_category_name_th
           FROM skill_category_chaungthai WHERE skill_category_id = ? LIMIT 1`,
        [catId]
      );
      if (rows[0]) {
        filterInfo.skill_category_name_th = rows[0].skill_category_name_th;
      }
    }

    // ----- main query -----
    //  กรอบสี่เหลี่ยมกว้างกว่าวงกลม 4/π ≈ 1.27 เท่า ดึงเผื่อไว้ 1.6 เท่า
    //  แล้วค่อยคัดให้อยู่ในวงกลมจริงด้วย Haversine ใน JS
    const sqlLimit = Math.min(Math.ceil(limit * 1.6), 400);
    const availCond = includeBusy ? '' : `AND w.worker_availability = 'free'`;

    //  เรียงตามระยะทางกำลังสองใน SQL (ถ่วงลองจิจูดด้วย cos²(lat) ให้สัดส่วนถูก)
    const cosLat2 = Math.pow(Math.cos((center.lat * Math.PI) / 180), 2);
    const distExpr =
      '((w.worker_lat - ?) * (w.worker_lat - ?) + ' +
      '(w.worker_lng - ?) * (w.worker_lng - ?) * ?)';

    // ------------------------------------------------------------
    //  ค้นจากวงเล็กก่อนแล้วค่อยขยาย
    //
    //  ต้นทุนจริงอยู่ที่ ORDER BY ระยะทาง — MySQL ต้องคำนวณและเรียง
    //  "ทุกแถวในกรอบ" ก่อนตัด LIMIT · วัดแล้วที่กรุงเทพรัศมี 50 กม.
    //  มีผู้สมัคร 56,746 คน → เรียง 1.3 วินาที (ไม่เกี่ยวกับการกรองสกิลเลย)
    //
    //  พื้นที่หนาแน่นมักได้ครบตั้งแต่วงเล็ก (ผู้สมัครน้อยลงตามกำลังสองของรัศมี)
    //  ส่วนพื้นที่ห่างไกลถึงจะขยายเต็ม 50 กม. ก็มีคนไม่เยอะอยู่แล้ว
    // ------------------------------------------------------------
    const radiusSteps = [...new Set([
      Math.max(1, Math.round(center.radiusKm / 8)),
      Math.max(1, Math.round(center.radiusKm / 3)),
      center.radiusKm,
    ])];

    let results = [];
    let usedRadiusKm = center.radiusKm;

    for (const stepKm of radiusSteps) {
      const stepBox = bboxFromRadius(center.lat, center.lng, stepKm);
      const params = [stepBox.minLat, stepBox.maxLat, stepBox.minLng, stepBox.maxLng];
      if (Array.isArray(skillParam)) params.push(...skillParam);
      else if (skillParam !== null) params.push(skillParam);
      params.push(center.lat, center.lat, center.lng, center.lng, cosLat2);

      const [rows] = await pool.execute(buildSearchSql(availCond, skillCond, distExpr, sqlLimit), params);
      usedRadiusKm = stepKm;
      results = rows;

      // ได้ครบตามที่ขอแล้ว ไม่ต้องขยายวงต่อ
      if (rows.length >= sqlLimit) break;
    }

    function buildSearchSql(avail, skill, dist, lim) {
      return `SELECT
          w.worker_id,
          w.worker_user_id,
          w.worker_job_tickets,
          w.worker_total_jobs,
          w.worker_resume,
          w.worker_lat,
          w.worker_lng,
          w.worker_service_radius_km,
          w.worker_availability,
          w.worker_crime_check_status,
          u.user_id,
          u.user_name,
          u.user_lastname,
          u.user_image,
          u.user_bio,
          u.user_identity_verified_at
        FROM worker_chaungthai w
        JOIN user_chaungthai u ON u.user_id = w.worker_user_id
        WHERE u.user_status = 'Active'
          AND w.worker_lat IS NOT NULL
          AND w.worker_lng IS NOT NULL
          AND w.worker_lat BETWEEN ? AND ?
          AND w.worker_lng BETWEEN ? AND ?
          ${avail}
          AND EXISTS (
            SELECT 1 FROM workerskill_chaungthai ws
            JOIN skill_chaungthai sk ON sk.skill_id = ws.workerskill_skill_id
            LEFT JOIN skill_subcategory_chaungthai sub ON sub.skill_subcategory_id = sk.skill_subcategory_id
            WHERE ws.workerskill_worker_id = w.worker_id
              AND sk.skill_is_active = 1
              ${skill}
          )
        ORDER BY ${dist}
        LIMIT ${lim}`;
    }

    // ----- คัดให้อยู่ในวงกลมจริง (SQL กรองแค่กรอบสี่เหลี่ยม มุมกรอบอยู่นอกวง) -----
    //  SQL เรียงมาให้แล้ว แต่เรียงซ้ำด้วย Haversine เพื่อความแม่นยำของตัวเลขที่ส่งออก
    results = results
      .map((r) => ({
        ...r,
        distance_km: Number(
          distanceKm(center.lat, center.lng, Number(r.worker_lat), Number(r.worker_lng)).toFixed(2)
        ),
      }))
      .filter((r) => r.distance_km <= center.radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, limit);

    // ----- เปิดเผยพิกัด 2 ระดับ: ยังไม่ยืนยันตัวตน = เห็นแค่จุดเบลอ ~1 กม. -----
    const viewerVerified = await isViewerVerified(req.user);
    for (const r of results) {
      const isOwner = Boolean(req.user && req.user.user_id === r.worker_user_id);
      const coords = publicCoords(r.worker_lat, r.worker_lng, isOwner || viewerVerified);
      r.worker_lat = coords.lat;
      r.worker_lng = coords.lng;
      r.location_is_blurred = coords.is_blurred;
      // ไม่ส่งข้อมูลติดต่อออกไปกับผลค้นหา — ดูได้ในหน้าโปรไฟล์/ห้องแชตเท่านั้น
      r.is_identity_verified = Boolean(r.user_identity_verified_at);
      delete r.user_identity_verified_at;
    }

    // ดึงสกิลทั้งหมดของช่างแต่ละคน (เพื่อโชว์ "ความสามารถ" ในการ์ด)
    if (results.length > 0) {
      const workerIds = results.map((r) => r.worker_id);
      const placeholders = workerIds.map(() => '?').join(',');
      const [allSkillRows] = await pool.query(
        `SELECT
            ws.workerskill_worker_id AS worker_id,
            sk.skill_id,
            sk.skill_name_th,
            sub.skill_subcategory_id,
            sub.skill_subcategory_name_th,
            cat.skill_category_id,
            cat.skill_category_name_th
          FROM workerskill_chaungthai ws
          JOIN skill_chaungthai sk ON sk.skill_id = ws.workerskill_skill_id
          LEFT JOIN skill_subcategory_chaungthai sub ON sub.skill_subcategory_id = sk.skill_subcategory_id
          LEFT JOIN skill_category_chaungthai cat ON cat.skill_category_id = sub.skill_subcategory_category_id
          WHERE ws.workerskill_worker_id IN (${placeholders})
            AND sk.skill_is_active = 1
          ORDER BY cat.skill_category_id, sub.skill_subcategory_id, sk.skill_id`,
        workerIds
      );
      // จัดกลุ่ม skills เข้าตาม worker_id
      const skillsByWorker = {};
      for (const row of allSkillRows) {
        const wid = row.worker_id;
        if (!skillsByWorker[wid]) skillsByWorker[wid] = [];
        skillsByWorker[wid].push({
          skill_id: row.skill_id,
          skill_name_th: row.skill_name_th,
          skill_subcategory_id: row.skill_subcategory_id,
          skill_subcategory_name_th: row.skill_subcategory_name_th,
          skill_category_id: row.skill_category_id,
          skill_category_name_th: row.skill_category_name_th,
        });
      }
      // แนบ all_skills ใส่แต่ละ row
      for (const r of results) {
        r.all_skills = skillsByWorker[r.worker_id] || [];
        r.skill_count = r.all_skills.length;
      }
    }

    return res.json({
      filter: filterInfo,
      applied_filter: appliedFilter,  // 'skill' | 'subcategory' | 'category' | null
      query: {
        center: { lat: center.lat, lng: center.lng, radius_km: center.radiusKm },
        searched_radius_km: usedRadiusKm,   // วงที่ใช้จริง (ขยายทีละขั้นจนได้ครบ)
        max_radius_km: MAX_SEARCH_RADIUS_KM,
        include_busy: includeBusy,
        limit,
      },
      total: results.length,
      workers: results,
    });
  } catch (err) {
    console.error('[workers/search] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  GET /api/workers/by-user/:user_id
//  หา worker_id ของ user คนนั้น (ใช้ใน frontend หลัง login)
//  - ถ้า user ไม่ใช่ worker → 404
//  - ตอบเฉพาะ worker_id + worker_user_id + status
// ============================================================
router.get('/by-user/:user_id', async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: 'user_id ไม่ถูกต้อง' });
    }
    const [rows] = await pool.execute(
      `SELECT w.worker_id, w.worker_user_id, u.user_status
         FROM worker_chaungthai w
         JOIN user_chaungthai u ON u.user_id = w.worker_user_id
        WHERE w.worker_user_id = ?
        LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'user คนนี้ยังไม่ได้สมัครเป็นช่าง' });
    }
    return res.json({
      worker_id: rows[0].worker_id,
      worker_user_id: rows[0].worker_user_id,
      user_status: rows[0].user_status,
    });
  } catch (err) {
    console.error('[workers][by-user] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  GET /api/workers/:worker_id
//  รายละเอียดช่างคนเดียว (สาธารณะ - ไม่ต้อง login)
//    - worker + user info (ไม่รวม password/national_id)
//    - skills array
//    - portfolio images (max 20)
//  *** Hide ถ้า user_status != 'Active' ***
// ============================================================
// optional auth — ถ้ามี token ถูกต้อง จะใส่ req.user ให้ (ไม่ block ถ้าไม่มี/ผิด)
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !process.env.JWT_SECRET) return next();
  try {
    const jwt = require('jsonwebtoken');
    req.user = jwt.verify(match[1], process.env.JWT_SECRET);
  } catch {
    /* ignore — ถือว่าไม่ login */
  }
  next();
}

router.get('/:worker_id', optionalAuth, async (req, res) => {
  try {
    const workerId = Number(req.params.worker_id);
    if (!Number.isInteger(workerId) || workerId < 1) {
      return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
    }

    // ----- 1. worker + user (active only) -----
    const [workers] = await pool.execute(
      `SELECT
          w.worker_id, w.worker_user_id,
          w.worker_resume, w.worker_job_tickets, w.worker_total_jobs,
          w.worker_crime_checked_at,
          w.worker_crime_document_url,
          w.worker_crime_check_status,
          w.worker_created_at,
          w.worker_lat, w.worker_lng,
          w.worker_service_radius_km, w.worker_availability,
          u.user_id, u.user_name, u.user_lastname, u.user_email,
          u.user_image, u.user_phone, u.user_bio,
          u.user_address, u.user_status, u.user_role,
          u.user_email_verified_at, u.user_phone_verified_at,
          u.user_identity_verified_at
        FROM worker_chaungthai w
        JOIN user_chaungthai u ON u.user_id = w.worker_user_id
        WHERE w.worker_id = ?
          AND u.user_status = 'Active'
        LIMIT 1`,
      [workerId]
    );
    if (workers.length === 0) {
      return res.status(404).json({ error: 'ไม่พบช่างที่ระบุ' });
    }
    const w = workers[0];

    // ----- 2. skills (active only) -----
    const [skills] = await pool.execute(
      `SELECT sk.skill_id, sk.skill_name_th, sk.skill_name_en,
              sub.skill_subcategory_id, sub.skill_subcategory_name_th,
              cat.skill_category_id, cat.skill_category_name_th
         FROM workerskill_chaungthai ws
         JOIN skill_chaungthai sk ON sk.skill_id = ws.workerskill_skill_id
         LEFT JOIN skill_subcategory_chaungthai sub ON sub.skill_subcategory_id = sk.skill_subcategory_id
         LEFT JOIN skill_category_chaungthai cat ON cat.skill_category_id = sub.skill_subcategory_category_id
        WHERE ws.workerskill_worker_id = ?
          AND sk.skill_is_active = 1
        ORDER BY cat.skill_category_id, sub.skill_subcategory_id, sk.skill_id`,
      [workerId]
    );

    // ----- 3. portfolio images -----
    const [images] = await pool.execute(
      `SELECT worker_resume_image_id, worker_resume_image_url,
              worker_resume_image_order, worker_resume_image_caption,
              worker_resume_image_uploaded_at
         FROM worker_resume_image_chaungthai
        WHERE worker_resume_image_worker_id = ?
        ORDER BY worker_resume_image_order`,
      [workerId]
    );

    // ----- 3.5 เวลาทำงานประจำสัปดาห์ -----
    const [schedRows] = await pool.execute(
      `SELECT sched_day, sched_start, sched_end
         FROM worker_schedule_chaungthai
        WHERE sched_worker_id = ?
        ORDER BY sched_day`,
      [workerId]
    );
    const schedule = schedRows.map((r) => ({
      day: r.sched_day,
      start: String(r.sched_start).slice(0, 5),
      end: String(r.sched_end).slice(0, 5),
    }));

    // ----- 4. is_favorited (ถ้า login) -----
    let isFavorited = false;
    if (req.user && req.user.user_id) {
      const [fav] = await pool.execute(
        `SELECT 1 FROM favorite_worker_chaungthai
          WHERE fav_user_id = ? AND fav_worker_id = ? LIMIT 1`,
        [req.user.user_id, workerId]
      );
      isFavorited = fav.length > 0;
    }

    // ----- 5. พิกัด: เจ้าของหมุด/คนที่ยืนยันตัวตนแล้ว เห็นจุดจริง นอกนั้นเห็นจุดเบลอ -----
    const isOwner = Boolean(req.user && req.user.user_id === w.worker_user_id);
    const viewerVerified = await isViewerVerified(req.user);
    const coords = publicCoords(w.worker_lat, w.worker_lng, isOwner || viewerVerified);

    // ----- 6. response -----
    return res.json({
      is_favorited: isFavorited,
      worker: {
        worker_id: w.worker_id,
        worker_user_id: w.worker_user_id,
        worker_resume: w.worker_resume,
        worker_job_tickets: w.worker_job_tickets,
        worker_total_jobs: w.worker_total_jobs,
        worker_crime_checked_at: w.worker_crime_checked_at,
        worker_crime_document_url: w.worker_crime_document_url,
        worker_crime_check_status: w.worker_crime_check_status,
        worker_created_at: w.worker_created_at,
        worker_lat: coords.lat,
        worker_lng: coords.lng,
        worker_service_radius_km: w.worker_service_radius_km,
        worker_availability: w.worker_availability,
        location_is_blurred: coords.is_blurred,
      },
      user: {
        user_id: w.user_id,
        user_name: w.user_name,
        user_lastname: w.user_lastname,
        user_email: w.user_email,
        user_image: w.user_image,
        user_phone: w.user_phone,
        user_bio: w.user_bio,
        user_address: w.user_address,
        user_status: w.user_status,
        user_role: w.user_role,
        user_email_verified_at: w.user_email_verified_at,
        user_phone_verified_at: w.user_phone_verified_at,
        user_identity_verified_at: w.user_identity_verified_at,
      },
      skills,
      schedule,
      portfolio_images: images,
    });
  } catch (err) {
    console.error('[workers][GET :id] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  POST /api/workers/:worker_id/crime-document
//  อัพโหลดเอกสารประวัติอาชญากรรม (login + เจ้าของ)
//  - multipart field name = "document"
//  - jpg/png/webp/pdf, max 5MB
//  - บันทึกไฟล์ใน uploads/crime-docs/crime_<worker_id>_<ts>.<ext>
//  - SET worker_crime_checked_at = NOW() (ถือว่ายื่นแล้ว/รอตรวจ)
// ============================================================
router.post(
  '/:worker_id/crime-document',
  verifyToken,
  (req, res, next) => {
    crimeUpload.single('document')(req, res, (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({
          error: err.code === 'LIMIT_FILE_SIZE'
            ? `ไฟล์ใหญ่เกิน ${Math.round(UPLOAD_MAX / 1024 / 1024)} MB — ลองย่อรูปหรือบันทึกเป็น JPG ก่อน`
            : err.message,
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const workerId = Number(req.params.worker_id);
      if (!Number.isInteger(workerId) || workerId < 1) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'กรุณาแนบไฟล์ที่ field "document"' });
      }

      const check = await assertWorkerOwner(workerId, req.user.user_id);
      if (check.error) {
        fs.unlink(req.file.path, () => {});
        return res.status(check.status).json({ error: check.error });
      }

      // ดึง URL เก่ามาเพื่อลบไฟล์ทีหลัง (ถ้ามี)
      const [oldRows] = await pool.execute(
        'SELECT worker_crime_document_url FROM worker_chaungthai WHERE worker_id = ?',
        [workerId]
      );
      const oldUrl = oldRows[0]?.worker_crime_document_url || null;

      const publicUrl = `/api/uploads/crime-docs/${req.file.filename}`;

      // อัปเดต DB → set url + checked_at = NOW() + status='pending'
      const [result] = await pool.execute(
        `UPDATE worker_chaungthai
            SET worker_crime_checked_at = NOW(),
                worker_crime_document_url = ?,
                worker_crime_check_status = 'pending'
          WHERE worker_id = ?`,
        [publicUrl, workerId]
      );
      if (result.affectedRows === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'ไม่พบช่างที่ระบุ' });
      }

      // ลบไฟล์เก่า (ถ้าเป็น path ใน CRIME_DIR)
      if (oldUrl && oldUrl.startsWith('/api/uploads/crime-docs/')) {
        const oldFile = path.join(CRIME_DIR, path.basename(oldUrl));
        if (oldFile.startsWith(CRIME_DIR + path.sep)) {
          fs.unlink(oldFile, () => {});
        }
      }

      // ดึง state ล่าสุด
      const [rows] = await pool.execute(
        `SELECT worker_crime_checked_at, worker_crime_document_url, worker_crime_check_status
           FROM worker_chaungthai WHERE worker_id = ?`,
        [workerId]
      );

      return res.json({
        message: 'อัพโหลดเอกสารประวัติอาชญากรรมสำเร็จ — รอเจ้าหน้าที่ตรวจสอบ',
        worker_id: workerId,
        worker_crime_checked_at: rows[0]?.worker_crime_checked_at || null,
        worker_crime_document_url: rows[0]?.worker_crime_document_url || null,
        worker_crime_check_status: rows[0]?.worker_crime_check_status || null,
        file: {
          filename: req.file.filename,
          size_bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
      });
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error('[workers][crime-document] error:', err);
      return res.status(500).json({
        error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
        detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      });
    }
  }
);

// ============================================================
//  POST /api/workers/:worker_id/resume-images
//  อัพโหลดภาพ portfolio (login + เจ้าของ)
//  - multipart: image + caption (optional)
//  - jpg/png/webp, max 5MB
//  - max 20 รูป/ช่าง (DB trigger บังคับ)
//  - order = max(order)+1
// ============================================================
router.post(
  '/:worker_id/resume-images',
  verifyToken,
  (req, res, next) => {
    portfolioUpload.single('image')(req, res, (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({
          error: err.code === 'LIMIT_FILE_SIZE'
            ? `ไฟล์ใหญ่เกิน ${Math.round(UPLOAD_MAX / 1024 / 1024)} MB — ลองย่อรูปหรือบันทึกเป็น JPG ก่อน`
            : err.message,
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const workerId = Number(req.params.worker_id);
      if (!Number.isInteger(workerId) || workerId < 1) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'กรุณาแนบไฟล์รูปที่ field "image"' });
      }

      const check = await assertWorkerOwner(workerId, req.user.user_id);
      if (check.error) {
        fs.unlink(req.file.path, () => {});
        return res.status(check.status).json({ error: check.error });
      }

      const caption =
        typeof req.body.caption === 'string' && req.body.caption.trim() !== ''
          ? req.body.caption.trim().slice(0, 255)
          : null;

      const publicUrl = `/api/uploads/portfolio/${req.file.filename}`;

      // หา next order
      const [maxRows] = await pool.execute(
        `SELECT COALESCE(MAX(worker_resume_image_order), 0) AS max_order
           FROM worker_resume_image_chaungthai
          WHERE worker_resume_image_worker_id = ?`,
        [workerId]
      );
      const nextOrder = Number(maxRows[0].max_order) + 1;

      try {
        const [result] = await pool.execute(
          `INSERT INTO worker_resume_image_chaungthai
             (worker_resume_image_worker_id, worker_resume_image_url,
              worker_resume_image_order, worker_resume_image_caption)
           VALUES (?, ?, ?, ?)`,
          [workerId, publicUrl, nextOrder, caption]
        );
        return res.status(201).json({
          message: 'อัพโหลดภาพ portfolio สำเร็จ',
          image: {
            worker_resume_image_id: result.insertId,
            worker_resume_image_worker_id: workerId,
            worker_resume_image_url: publicUrl,
            worker_resume_image_order: nextOrder,
            worker_resume_image_caption: caption,
          },
        });
      } catch (dbErr) {
        // DB trigger throw error เมื่อเกิน 20 รูป
        fs.unlink(req.file.path, () => {});
        const msg = (dbErr && dbErr.sqlMessage) || dbErr.message || '';
        if (msg.includes('20')) {
          return res.status(409).json({ error: 'ช่างคนนี้มีรูป portfolio ครบ 20 ภาพแล้ว' });
        }
        throw dbErr;
      }
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error('[workers][resume-images][POST] error:', err);
      return res.status(500).json({
        error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
        detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      });
    }
  }
);

// ============================================================
//  DELETE /api/workers/:worker_id/resume-images/:image_id
//  ลบภาพ portfolio (login + เจ้าของ)
// ============================================================
router.delete('/:worker_id/resume-images/:image_id', verifyToken, async (req, res) => {
  try {
    const workerId = Number(req.params.worker_id);
    const imageId = Number(req.params.image_id);
    if (!Number.isInteger(workerId) || workerId < 1 ||
        !Number.isInteger(imageId) || imageId < 1) {
      return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
    }

    const check = await assertWorkerOwner(workerId, req.user.user_id);
    if (check.error) return res.status(check.status).json({ error: check.error });

    // หา URL ของรูปก่อนเพื่อลบไฟล์
    const [imgRows] = await pool.execute(
      `SELECT worker_resume_image_url
         FROM worker_resume_image_chaungthai
        WHERE worker_resume_image_id = ?
          AND worker_resume_image_worker_id = ?
        LIMIT 1`,
      [imageId, workerId]
    );
    if (imgRows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบรูปที่ระบุ' });
    }
    const imageUrl = imgRows[0].worker_resume_image_url;

    // ลบ row
    await pool.execute(
      `DELETE FROM worker_resume_image_chaungthai
        WHERE worker_resume_image_id = ?`,
      [imageId]
    );

    // ลบไฟล์จริง (silent — ไม่ throw)
    if (imageUrl && imageUrl.startsWith('/api/uploads/portfolio/')) {
      const filename = path.basename(imageUrl);
      const filePath = path.join(PORTFOLIO_DIR, filename);
      if (filePath.startsWith(PORTFOLIO_DIR + path.sep)) {
        fs.unlink(filePath, () => {});
      }
    }

    return res.json({
      message: 'ลบรูปสำเร็จ',
      worker_resume_image_id: imageId,
    });
  } catch (err) {
    console.error('[workers][resume-images][DELETE] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
