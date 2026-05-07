const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createNotification } = require('../utils/notify');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// ── POST /api/jobs  ── ลูกค้าโพสงาน ─────────────────────────────────────
const createJobSchema = z.object({
  title:         z.string().trim().min(5).max(255),
  description:   z.string().trim().min(10).max(2000),
  jobLevel:      z.number().int().min(1).max(5).default(1),
  budgetType:    z.enum(['fixed', 'open']).default('open'),
  budgetAmount:  z.number().min(0).optional().nullable(),
  provinceId:    z.number().int().positive(),
  districtId:    z.number().int().positive().optional().nullable(),
  subdistrictId: z.number().int().positive().optional().nullable(),
  latitude:      z.number().optional().nullable(),
  longitude:     z.number().optional().nullable(),
  addressNote:   z.string().trim().max(255).optional(),
  skillIds:      z.array(z.number().int().positive()).min(1).max(5),
});

router.post(
  '/',
  requireRole('customer'),
  validate({ body: createJobSchema }),
  asyncHandler(async (req, res) => {
    const d = req.body;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day

    const result = await db.withTransaction(async (conn) => {
      const [r] = await conn.execute(
        `INSERT INTO jobs
          (customer_id, title, description, job_level, budget_type, budget_amount,
           province_id, district_id, subdistrict_id, latitude, longitude, address_note, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, d.title, d.description, d.jobLevel, d.budgetType,
         d.budgetAmount || null, d.provinceId, d.districtId || null,
         d.subdistrictId || null, d.latitude || null, d.longitude || null,
         d.addressNote || null, expiresAt]
      );
      const jobId = r.insertId;
      for (const sid of d.skillIds) {
        await conn.execute('INSERT IGNORE INTO job_skills (job_id, skill_id) VALUES (?, ?)', [jobId, sid]);
      }
      return jobId;
    });

    const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id', { id: result });
    res.status(201).json({ ok: true, data: job });
  })
);

// ── GET /api/jobs  ── list / feed ─────────────────────────────────────────
const listJobsSchema = z.object({
  status:     z.enum(['open','matched','in_progress','completed','expired','cancelled']).optional(),
  provinceId: z.coerce.number().int().positive().optional(),
  skillId:    z.coerce.number().int().positive().optional(),
  level:      z.coerce.number().int().min(1).max(5).optional(),
  budgetMax:  z.coerce.number().min(0).optional(),
  q:          z.string().trim().max(100).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate({ query: listJobsSchema }), asyncHandler(async (req, res) => {
  const { status, provinceId, skillId, level, budgetMax, q, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const wheres = [];
  const params = {};

  if (req.user.role === 'customer') {
    // customer sees only their own jobs
    wheres.push('j.customer_id = :uid');
    params.uid = req.user.id;
  } else if (req.user.role === 'worker') {
    // worker sees open jobs that match their skills/areas
    wheres.push('j.status = \'open\'');
    wheres.push('j.expires_at > NOW()');
    wheres.push(`EXISTS (
      SELECT 1 FROM job_skills js2
      JOIN worker_skills ws2 ON ws2.skill_id = js2.skill_id
      WHERE js2.job_id = j.id AND ws2.worker_id = :uid
    )`);
    wheres.push(`EXISTS (
      SELECT 1 FROM worker_service_areas wsa
      WHERE wsa.worker_id = :uid AND wsa.province_id = j.province_id
    )`);
    params.uid = req.user.id;
  }

  if (status && req.user.role === 'customer') {
    wheres.push('j.status = :status');
    params.status = status;
  }
  if (provinceId) { wheres.push('j.province_id = :provinceId'); params.provinceId = provinceId; }
  if (skillId) {
    wheres.push('EXISTS (SELECT 1 FROM job_skills js3 WHERE js3.job_id = j.id AND js3.skill_id = :skillId)');
    params.skillId = skillId;
  }
  if (level)    { wheres.push('j.job_level = :level');           params.level = level; }
  if (budgetMax){ wheres.push('(j.budget_amount <= :budgetMax OR j.budget_type = \'open\')'); params.budgetMax = budgetMax; }
  if (q)        { wheres.push('(j.title LIKE :q OR j.description LIKE :q)'); params.q = `%${q}%`; }

  const whereSQL = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  const jobs = await db.query(
    `SELECT j.*, u.first_name AS customer_first_name, u.last_name AS customer_last_name,
            p.name_th AS province_name, d.name_th AS district_name
     FROM jobs j
     JOIN users u ON u.id = j.customer_id
     LEFT JOIN provinces p ON p.id = j.province_id
     LEFT JOIN districts d ON d.id = j.district_id
     ${whereSQL}
     ORDER BY j.created_at DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );

  res.json({ ok: true, data: jobs, page, limit });
}));

// ── GET /api/jobs/:id ─────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const job = await db.queryOne(
    `SELECT j.*, u.first_name AS customer_first_name, u.last_name AS customer_last_name,
            p.name_th AS province_name, d.name_th AS district_name
     FROM jobs j
     JOIN users u ON u.id = j.customer_id
     LEFT JOIN provinces p ON p.id = j.province_id
     LEFT JOIN districts d ON d.id = j.district_id
     WHERE j.id = :id`,
    { id }
  );
  if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');

  const skills = await db.query(
    `SELECT s.id, s.name_th, s.name_en FROM job_skills js JOIN skills s ON s.id = js.skill_id WHERE js.job_id = :id`,
    { id }
  );

  // increment view count (non-blocking)
  db.query('UPDATE jobs SET view_count = view_count + 1 WHERE id = :id', { id }).catch(() => {});

  // if worker: check if already applied
  let myApplication = null;
  if (req.user.role === 'worker') {
    myApplication = await db.queryOne(
      'SELECT id, status, proposed_price FROM job_applications WHERE job_id = :jid AND worker_id = :wid',
      { jid: id, wid: req.user.id }
    );
  }

  res.json({ ok: true, data: { ...job, skills, myApplication } });
}));

// ── PATCH /api/jobs/:id ── ลูกค้าแก้ไขงาน ────────────────────────────────
const updateJobSchema = z.object({
  title:       z.string().trim().min(5).max(255).optional(),
  description: z.string().trim().min(10).max(2000).optional(),
  budgetType:  z.enum(['fixed', 'open']).optional(),
  budgetAmount: z.number().min(0).optional().nullable(),
  addressNote:  z.string().trim().max(255).optional(),
}).strict();

router.patch(
  '/:id',
  requireRole('customer'),
  validate({ body: updateJobSchema }),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id AND customer_id = :uid', { id, uid: req.user.id });
    if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');
    if (job.status !== 'open') throw errors.badRequest('job_not_editable', 'แก้ไขได้เฉพาะงานที่ยังเปิดรับสมัคร');

    const { title, description, budgetType, budgetAmount, addressNote } = req.body;
    const sets = []; const params = { id };
    if (title       !== undefined) { sets.push('title = :title');              params.title = title; }
    if (description !== undefined) { sets.push('description = :desc');         params.desc = description; }
    if (budgetType  !== undefined) { sets.push('budget_type = :bt');           params.bt = budgetType; }
    if (budgetAmount!== undefined) { sets.push('budget_amount = :ba');         params.ba = budgetAmount; }
    if (addressNote !== undefined) { sets.push('address_note = :an');          params.an = addressNote; }

    if (sets.length) {
      await db.query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = :id`, params);
    }
    const updated = await db.queryOne('SELECT * FROM jobs WHERE id = :id', { id });
    res.json({ ok: true, data: updated });
  })
);

// ── DELETE /api/jobs/:id ── ลูกค้ายกเลิกงาน ─────────────────────────────
router.delete('/:id', requireRole('customer'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id AND customer_id = :uid', { id, uid: req.user.id });
  if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');
  if (!['open'].includes(job.status)) throw errors.badRequest('job_not_cancellable', 'ยกเลิกได้เฉพาะงานที่ยังเปิดรับสมัคร');

  await db.query(
    `UPDATE jobs SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer_cancelled' WHERE id = :id`,
    { id }
  );
  res.json({ ok: true, message: 'ยกเลิกประกาศงานแล้ว' });
}));

// ── GET /api/jobs/:id/applications ────────────────────────────────────────
router.get('/:id/applications', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id', { id });
  if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');

  if (req.user.role === 'customer' && job.customer_id !== req.user.id) {
    throw errors.forbidden('forbidden', 'ไม่มีสิทธิ์เข้าถึง');
  }

  let apps;
  if (req.user.role === 'customer') {
    apps = await db.query(
      `SELECT ja.id, ja.worker_id, ja.proposed_price, ja.message, ja.tickets_used,
              ja.status, ja.applied_at,
              u.first_name, u.last_name, wp.avatar_url, wp.rating_avg, wp.rating_count, wp.is_verified
       FROM job_applications ja
       JOIN users u ON u.id = ja.worker_id
       JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ja.job_id = :id
       ORDER BY wp.rating_avg DESC, ja.applied_at ASC`,
      { id }
    );
  } else {
    apps = await db.query(
      'SELECT * FROM job_applications WHERE job_id = :jid AND worker_id = :wid',
      { jid: id, wid: req.user.id }
    );
  }
  res.json({ ok: true, data: apps });
}));

// ── POST /api/jobs/:id/apply ── ช่างสมัครงาน ─────────────────────────────
const applySchema = z.object({
  proposedPrice: z.number().min(0),
  message:       z.string().trim().max(500).optional(),
});

router.post(
  '/:id/apply',
  requireRole('worker'),
  validate({ body: applySchema }),
  asyncHandler(async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    const wid   = req.user.id;

    const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id', { id: jobId });
    if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');
    if (job.status !== 'open') throw errors.badRequest('job_closed', 'งานนี้ไม่ได้รับสมัครแล้ว');
    if (new Date(job.expires_at) < new Date()) throw errors.badRequest('job_expired', 'ประกาศงานหมดอายุแล้ว');

    // check already applied
    const existing = await db.queryOne(
      'SELECT id FROM job_applications WHERE job_id = :jid AND worker_id = :wid',
      { jid: jobId, wid }
    );
    if (existing) throw errors.conflict('already_applied', 'สมัครงานนี้แล้ว');

    // check ticket balance
    const wp = await db.queryOne('SELECT tickets_balance FROM worker_profiles WHERE user_id = :id', { id: wid });
    if (!wp || wp.tickets_balance < job.job_level) {
      throw errors.badRequest('insufficient_tickets', `ตั๋วไม่พอ ต้องการ ${job.job_level} ตั๋ว มีอยู่ ${wp?.tickets_balance || 0} ตั๋ว`);
    }

    // check worker is verified for level 3+
    if (job.job_level >= 3 && !wp.is_verified) {
      throw errors.forbidden('not_verified', 'งานระดับ 3 ขึ้นไปต้องผ่านการยืนยันตัวตนก่อน');
    }

    const { proposedPrice, message } = req.body;
    const newBalance = wp.tickets_balance - job.job_level;

    await db.withTransaction(async (conn) => {
      const [r] = await conn.execute(
        `INSERT INTO job_applications (job_id, worker_id, proposed_price, message, tickets_used)
         VALUES (?, ?, ?, ?, ?)`,
        [jobId, wid, proposedPrice, message || null, job.job_level]
      );
      const appId = r.insertId;

      await conn.execute('UPDATE worker_profiles SET tickets_balance = ? WHERE user_id = ?', [newBalance, wid]);
      await conn.execute('UPDATE jobs SET application_count = application_count + 1 WHERE id = ?', [jobId]);
      await conn.execute(
        `INSERT INTO ticket_transactions (worker_id, type, amount, balance_after, reference_id, reference_type, note)
         VALUES (?, 'application_deduct', ?, ?, ?, 'job_application', ?)`,
        [wid, -job.job_level, newBalance, appId, `สมัครงาน #${jobId} (ระดับ ${job.job_level})`]
      );

      // notify customer
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'new_application', ?, ?, ?)`,
        [
          job.customer_id,
          'มีช่างสมัครงานของคุณ!',
          `มีช่างใหม่สมัครงาน "${job.title.slice(0, 50)}"`,
          JSON.stringify({ job_id: jobId, application_id: appId }),
        ]
      );
    });

    res.status(201).json({ ok: true, message: 'สมัครงานสำเร็จ', ticketsUsed: job.job_level, ticketsRemaining: newBalance });
  })
);

// ── DELETE /api/jobs/:id/apply ── ช่างถอนใบสมัคร ─────────────────────────
router.delete('/:id/apply', requireRole('worker'), asyncHandler(async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  const app = await db.queryOne(
    'SELECT * FROM job_applications WHERE job_id = :jid AND worker_id = :wid',
    { jid: jobId, wid: req.user.id }
  );
  if (!app) throw errors.notFound('application_not_found', 'ไม่พบใบสมัคร');
  if (app.status !== 'pending') throw errors.badRequest('cannot_withdraw', 'ถอนได้เฉพาะใบสมัครที่รอตอบรับ');

  const wp = await db.queryOne('SELECT tickets_balance FROM worker_profiles WHERE user_id = :id', { id: req.user.id });
  const newBalance = wp.tickets_balance + app.tickets_used;

  await db.withTransaction(async (conn) => {
    await conn.execute(`UPDATE job_applications SET status = 'withdrawn' WHERE id = ?`, [app.id]);
    await conn.execute('UPDATE worker_profiles SET tickets_balance = ? WHERE user_id = ?', [newBalance, req.user.id]);
    await conn.execute('UPDATE jobs SET application_count = GREATEST(0, application_count - 1) WHERE id = ?', [jobId]);
    await conn.execute(
      `INSERT INTO ticket_transactions (worker_id, type, amount, balance_after, reference_id, reference_type, note)
       VALUES (?, 'admin_adjust', ?, ?, ?, 'job_application', 'คืนตั๋วจากการถอนใบสมัคร')`,
      [req.user.id, app.tickets_used, newBalance, app.id]
    );
  });

  res.json({ ok: true, message: 'ถอนใบสมัครสำเร็จ ตั๋วถูกคืนแล้ว', ticketsReturned: app.tickets_used });
}));

// ── POST /api/jobs/:id/select/:appId ── ลูกค้าเลือกช่าง ─────────────────
router.post(
  '/:id/select/:appId',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    const appId = parseInt(req.params.appId, 10);

    const job = await db.queryOne('SELECT * FROM jobs WHERE id = :id AND customer_id = :uid', { id: jobId, uid: req.user.id });
    if (!job) throw errors.notFound('job_not_found', 'ไม่พบประกาศงาน');
    if (job.status !== 'open') throw errors.badRequest('job_not_open', 'งานนี้ไม่ได้เปิดรับสมัครแล้ว');

    const app = await db.queryOne(
      'SELECT * FROM job_applications WHERE id = :aid AND job_id = :jid AND status = \'pending\'',
      { aid: appId, jid: jobId }
    );
    if (!app) throw errors.notFound('application_not_found', 'ไม่พบใบสมัคร');

    const matchId = await db.withTransaction(async (conn) => {
      // accept chosen application
      await conn.execute(
        `UPDATE job_applications SET status = 'accepted', responded_at = NOW() WHERE id = ?`, [appId]
      );
      // reject others
      await conn.execute(
        `UPDATE job_applications SET status = 'rejected', responded_at = NOW()
         WHERE job_id = ? AND id != ? AND status = 'pending'`,
        [jobId, appId]
      );
      // update job status
      await conn.execute(
        `UPDATE jobs SET status = 'matched', matched_at = NOW(), updated_at = NOW() WHERE id = ?`, [jobId]
      );
      // create match
      const [mr] = await conn.execute(
        `INSERT INTO job_matches (job_id, customer_id, worker_id, application_id, agreed_price, match_type)
         VALUES (?, ?, ?, ?, ?, 'from_post')`,
        [jobId, req.user.id, app.worker_id, appId, app.proposed_price]
      );
      const mid = mr.insertId;
      // create chat room
      await conn.execute(
        `INSERT INTO chat_rooms (match_id, job_id, participant_a, participant_b)
         VALUES (?, ?, ?, ?)`,
        [mid, jobId, req.user.id, app.worker_id]
      );
      // notify worker
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'match_accepted', ?, ?, ?)`,
        [
          app.worker_id,
          'ยินดีด้วย! คุณได้รับงาน',
          `คุณได้รับเลือกสำหรับงาน "${job.title.slice(0, 50)}"`,
          JSON.stringify({ job_id: jobId, match_id: mid }),
        ]
      );
      return mid;
    });

    res.status(201).json({ ok: true, message: 'เลือกช่างสำเร็จ', matchId });
  })
);

module.exports = router;
