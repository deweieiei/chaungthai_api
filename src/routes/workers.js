const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

// ── GET /api/workers  ── public search ────────────────────────────────────
const searchSchema = z.object({
  skillId:    z.coerce.number().int().positive().optional(),
  provinceId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
  level:      z.coerce.number().int().min(1).max(5).optional(),
  ratingMin:  z.coerce.number().min(0).max(5).optional(),
  priceMax:   z.coerce.number().min(0).optional(),
  q:          z.string().trim().max(100).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate({ query: searchSchema }), asyncHandler(async (req, res) => {
  const { skillId, provinceId, districtId, level, ratingMin, priceMax, q, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const params = {};
  const wheres = ['wp.user_id IS NOT NULL', 'u.is_active = 1'];

  if (skillId) {
    wheres.push('ws.skill_id = :skillId');
    params.skillId = skillId;
  }
  if (provinceId) {
    wheres.push('EXISTS (SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = wp.user_id AND wsa.province_id = :provinceId)');
    params.provinceId = provinceId;
  }
  if (districtId) {
    wheres.push('EXISTS (SELECT 1 FROM worker_service_areas wsa2 WHERE wsa2.worker_id = wp.user_id AND wsa2.district_id = :districtId)');
    params.districtId = districtId;
  }
  if (level) {
    wheres.push('ws.skill_level >= :level');
    params.level = level;
  }
  if (ratingMin) {
    wheres.push('wp.rating_avg >= :ratingMin');
    params.ratingMin = ratingMin;
  }
  if (priceMax) {
    wheres.push('(ws.price <= :priceMax OR ws.price_type = \'negotiable\')');
    params.priceMax = priceMax;
  }
  if (q) {
    wheres.push('(u.first_name LIKE :q OR u.last_name LIKE :q OR wp.bio LIKE :q)');
    params.q = `%${q}%`;
  }

  const joinSkill = skillId ? 'JOIN worker_skills ws ON ws.worker_id = wp.user_id' : 'LEFT JOIN worker_skills ws ON ws.worker_id = wp.user_id';
  const whereSQL = 'WHERE ' + wheres.join(' AND ');

  const workers = await db.query(
    `SELECT DISTINCT
        u.id, u.first_name, u.last_name, u.role,
        wp.bio, wp.avatar_url, wp.rating_avg, wp.rating_count,
        wp.is_verified, wp.tickets_balance
     FROM worker_profiles wp
     JOIN users u ON u.id = wp.user_id
     ${joinSkill}
     ${whereSQL}
     ORDER BY wp.rating_avg DESC, wp.rating_count DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );

  // attach skills for each worker
  const ids = workers.map(w => w.id);
  let workerSkills = [];
  if (ids.length > 0) {
    workerSkills = await db.query(
      `SELECT ws.worker_id, ws.skill_level, ws.price_type, ws.price,
              s.id AS skill_id, s.name_th, s.name_en
       FROM worker_skills ws
       JOIN skills s ON s.id = ws.skill_id
       WHERE ws.worker_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
  }

  const skillMap = {};
  for (const sk of workerSkills) {
    if (!skillMap[sk.worker_id]) skillMap[sk.worker_id] = [];
    skillMap[sk.worker_id].push(sk);
  }

  const data = workers.map(w => ({ ...w, skills: skillMap[w.id] || [] }));
  res.json({ ok: true, data, page, limit });
}));

// ── GET /api/workers/:id  ── public profile ────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) throw errors.badRequest('invalid_id', 'รหัสไม่ถูกต้อง');

  const user = await db.queryOne(
    `SELECT u.id, u.first_name, u.last_name,
            wp.bio, wp.avatar_url, wp.rating_avg, wp.rating_count, wp.is_verified
     FROM users u
     JOIN worker_profiles wp ON wp.user_id = u.id
     WHERE u.id = :id AND u.is_active = 1`,
    { id }
  );
  if (!user) throw errors.notFound('worker_not_found', 'ไม่พบช่างรายนี้');

  const skills = await db.query(
    `SELECT ws.skill_id, ws.skill_level, ws.price_type, ws.price, ws.description,
            s.name_th, s.name_en, c.name_th AS category_name
     FROM worker_skills ws
     JOIN skills s ON s.id = ws.skill_id
     JOIN skill_categories c ON c.id = s.category_id
     WHERE ws.worker_id = :id`,
    { id }
  );

  const areas = await db.query(
    `SELECT wsa.province_id, p.name_th AS province_name,
            wsa.district_id, d.name_th AS district_name
     FROM worker_service_areas wsa
     JOIN provinces p ON p.id = wsa.province_id
     LEFT JOIN districts d ON d.id = wsa.district_id
     WHERE wsa.worker_id = :id`,
    { id }
  );

  const recentRatings = await db.query(
    `SELECT r.stars, r.review_text, r.created_at
     FROM ratings r WHERE r.to_user_id = :id AND r.is_public = 1
     ORDER BY r.created_at DESC LIMIT 10`,
    { id }
  );

  res.json({ ok: true, data: { ...user, skills, areas, recentRatings } });
}));

// ── Worker-only routes ─────────────────────────────────────────────────────
router.use(requireAuth, requireRole('worker'));

// PUT /api/workers/me/profile
const profileSchema = z.object({
  bio:       z.string().trim().max(1000).optional(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
}).strict();

router.put('/me/profile', validate({ body: profileSchema }), asyncHandler(async (req, res) => {
  const { bio, avatarUrl } = req.body;
  const sets = [];
  const params = { id: req.user.id };
  if (bio       !== undefined) { sets.push('bio = :bio');             params.bio = bio; }
  if (avatarUrl !== undefined) { sets.push('avatar_url = :avatarUrl'); params.avatarUrl = avatarUrl; }

  if (sets.length) {
    await db.query(`UPDATE worker_profiles SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = :id`, params);
  }
  const wp = await db.queryOne('SELECT * FROM worker_profiles WHERE user_id = :id', { id: req.user.id });
  res.json({ ok: true, data: wp });
}));

// PUT /api/workers/me/skills  — replace full skill set
const skillsSchema = z.object({
  skills: z.array(z.object({
    skillId:     z.number().int().positive(),
    skillLevel:  z.number().int().min(1).max(5).default(1),
    priceType:   z.enum(['fixed', 'per_hour', 'negotiable']).default('fixed'),
    price:       z.number().min(0).default(0),
    description: z.string().trim().max(500).optional(),
  })).min(1).max(20),
});

router.put('/me/skills', validate({ body: skillsSchema }), asyncHandler(async (req, res) => {
  const { skills } = req.body;
  const wid = req.user.id;

  await db.withTransaction(async (conn) => {
    await conn.execute('DELETE FROM worker_skills WHERE worker_id = ?', [wid]);
    for (const sk of skills) {
      await conn.execute(
        `INSERT INTO worker_skills (worker_id, skill_id, skill_level, price_type, price, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [wid, sk.skillId, sk.skillLevel, sk.priceType, sk.price, sk.description || null]
      );
    }
  });

  const updated = await db.query(
    `SELECT ws.*, s.name_th FROM worker_skills ws JOIN skills s ON s.id = ws.skill_id WHERE ws.worker_id = :id`,
    { id: wid }
  );
  res.json({ ok: true, data: updated });
}));

// PUT /api/workers/me/areas
const areasSchema = z.object({
  areas: z.array(z.object({
    provinceId:    z.number().int().positive(),
    districtId:    z.number().int().positive().optional().nullable(),
    subdistrictId: z.number().int().positive().optional().nullable(),
  })).min(1).max(20),
});

router.put('/me/areas', validate({ body: areasSchema }), asyncHandler(async (req, res) => {
  const { areas } = req.body;
  const wid = req.user.id;

  await db.withTransaction(async (conn) => {
    await conn.execute('DELETE FROM worker_service_areas WHERE worker_id = ?', [wid]);
    for (const a of areas) {
      await conn.execute(
        `INSERT INTO worker_service_areas (worker_id, province_id, district_id, subdistrict_id)
         VALUES (?, ?, ?, ?)`,
        [wid, a.provinceId, a.districtId || null, a.subdistrictId || null]
      );
    }
  });

  res.json({ ok: true, message: 'อัพเดทพื้นที่บริการสำเร็จ' });
}));

// PUT /api/workers/me/location
const locationSchema = z.object({
  latitude:         z.number().min(-90).max(90),
  longitude:        z.number().min(-180).max(180),
  serviceRadiusKm:  z.number().int().min(1).max(200).optional(),
});

router.put('/me/location', validate({ body: locationSchema }), asyncHandler(async (req, res) => {
  const { latitude, longitude, serviceRadiusKm } = req.body;
  await db.query(
    `INSERT INTO worker_locations (worker_id, latitude, longitude, service_radius_km)
     VALUES (:id, :lat, :lng, :r)
     ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude),
       service_radius_km = COALESCE(:r, service_radius_km), updated_at = NOW()`,
    { id: req.user.id, lat: latitude, lng: longitude, r: serviceRadiusKm || null }
  );
  res.json({ ok: true, message: 'อัพเดทพิกัดสำเร็จ' });
}));

// ── POST /api/workers/me/verify-id ── ส่งเอกสารยืนยันตัวตน ───────────────
const verifyIdSchema = z.object({
  idCardFront: z.string().url().max(500),
  idCardBack:  z.string().url().max(500).optional().nullable(),
  selfieUrl:   z.string().url().max(500).optional().nullable(),
});

router.post('/me/verify-id', validate({ body: verifyIdSchema }), asyncHandler(async (req, res) => {
  const wid = req.user.id;

  // เช็คว่า verified แล้วหรือยัง
  const wp = await db.queryOne('SELECT is_verified FROM worker_profiles WHERE user_id = :id', { id: wid });
  if (!wp) throw errors.notFound('profile_not_found', 'ไม่พบโปรไฟล์ช่าง');
  if (wp.is_verified) {
    return res.json({ ok: true, message: 'ผ่านการยืนยันตัวตนแล้ว' });
  }

  // เช็คว่ามี request pending อยู่แล้วหรือยัง
  const pending = await db.queryOne(
    `SELECT id FROM worker_verifications WHERE worker_id = :id AND status = 'pending'`,
    { id: wid }
  );
  if (pending) {
    throw errors.conflict('verify_pending', 'คำขอยืนยันตัวตนของคุณอยู่ระหว่างการตรวจสอบ');
  }

  const { idCardFront, idCardBack, selfieUrl } = req.body;
  const [r] = await db.pool.execute(
    `INSERT INTO worker_verifications (worker_id, id_card_front, id_card_back, selfie_url)
     VALUES (?, ?, ?, ?)`,
    [wid, idCardFront, idCardBack || null, selfieUrl || null]
  );

  res.status(201).json({
    ok:       true,
    message:  'ส่งคำขอยืนยันตัวตนแล้ว ทีมงานจะตรวจสอบภายใน 1-2 วันทำการ',
    requestId: r.insertId,
  });
}));

// ── GET /api/workers/me/verify-id ── ดูสถานะคำขอ ──────────────────────────
router.get('/me/verify-id', asyncHandler(async (req, res) => {
  const wid = req.user.id;
  const wp = await db.queryOne(
    'SELECT is_verified, verified_at FROM worker_profiles WHERE user_id = :id',
    { id: wid }
  );

  const latest = await db.queryOne(
    `SELECT id, status, reject_reason, created_at, reviewed_at
     FROM worker_verifications WHERE worker_id = :id
     ORDER BY created_at DESC LIMIT 1`,
    { id: wid }
  );

  res.json({
    ok: true,
    data: {
      isVerified:  !!wp?.is_verified,
      verifiedAt:  wp?.verified_at || null,
      latestRequest: latest || null,
    },
  });
}));

// GET /api/workers/me/stats
router.get('/me/stats', asyncHandler(async (req, res) => {
  const id = req.user.id;
  const [jobStats] = await db.query(
    `SELECT
       COUNT(CASE WHEN jm.status = 'completed' THEN 1 END) AS completed_jobs,
       COUNT(CASE WHEN jm.status = 'in_progress' THEN 1 END) AS active_jobs,
       COUNT(CASE WHEN jm.status = 'cancelled' THEN 1 END) AS cancelled_jobs
     FROM job_matches jm WHERE jm.worker_id = :id`,
    { id }
  );
  const wp = await db.queryOne(
    `SELECT rating_avg, rating_count, tickets_balance, is_verified FROM worker_profiles WHERE user_id = :id`,
    { id }
  );
  res.json({ ok: true, data: { ...jobStats, ...wp } });
}));

module.exports = router;
