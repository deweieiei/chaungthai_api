const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createNotification } = require('../utils/notify');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/matches ────────────────────────────────────────────────────────
const listSchema = z.object({
  status: z.enum(['matched','in_progress','completed','cancelled','disputed']).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate({ query: listSchema }), asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const uid = req.user.id;

  const wheres = ['(jm.customer_id = :uid OR jm.worker_id = :uid)'];
  const params = { uid };
  if (status) { wheres.push('jm.status = :status'); params.status = status; }

  const matches = await db.query(
    `SELECT jm.*,
            j.title AS job_title, j.job_level,
            uc.first_name AS customer_first_name, uc.last_name AS customer_last_name,
            uw.first_name AS worker_first_name,   uw.last_name AS worker_last_name,
            wp.avatar_url AS worker_avatar, wp.rating_avg AS worker_rating,
            (SELECT id FROM chat_rooms WHERE match_id = jm.id LIMIT 1) AS chat_room_id
     FROM job_matches jm
     JOIN jobs j   ON j.id  = jm.job_id
     JOIN users uc ON uc.id = jm.customer_id
     JOIN users uw ON uw.id = jm.worker_id
     JOIN worker_profiles wp ON wp.user_id = jm.worker_id
     WHERE ${wheres.join(' AND ')}
     ORDER BY jm.created_at DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  res.json({ ok: true, data: matches, page, limit });
}));

// ── GET /api/matches/:id ────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = req.user.id;

  const match = await db.queryOne(
    `SELECT jm.*,
            j.title, j.description, j.job_level, j.address_note,
            p.name_th AS province_name, d.name_th AS district_name,
            uc.first_name AS customer_first_name, uc.last_name AS customer_last_name, uc.phone AS customer_phone,
            uw.first_name AS worker_first_name,   uw.last_name AS worker_last_name,   uw.phone AS worker_phone,
            wp.avatar_url, wp.rating_avg, wp.is_verified,
            (SELECT id FROM chat_rooms WHERE match_id = jm.id LIMIT 1) AS chat_room_id
     FROM job_matches jm
     JOIN jobs j ON j.id = jm.job_id
     JOIN users uc ON uc.id = jm.customer_id
     JOIN users uw ON uw.id = jm.worker_id
     JOIN worker_profiles wp ON wp.user_id = jm.worker_id
     LEFT JOIN provinces p ON p.id = j.province_id
     LEFT JOIN districts d ON d.id = j.district_id
     WHERE jm.id = :id AND (jm.customer_id = :uid OR jm.worker_id = :uid)`,
    { id, uid }
  );
  if (!match) throw errors.notFound('match_not_found', 'ไม่พบงาน');

  res.json({ ok: true, data: match });
}));

// ── PATCH /api/matches/:id/start ── worker เริ่มงาน ───────────────────────
router.patch('/:id/start', requireRole('worker'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const match = await db.queryOne(
    `SELECT * FROM job_matches WHERE id = :id AND worker_id = :uid`,
    { id, uid: req.user.id }
  );
  if (!match) throw errors.notFound('match_not_found', 'ไม่พบงาน');
  if (match.status !== 'matched') throw errors.badRequest('invalid_status', 'สถานะงานไม่ถูกต้อง');

  await db.query(
    `UPDATE job_matches SET status = 'in_progress', started_at = NOW(), updated_at = NOW() WHERE id = :id`,
    { id }
  );
  await db.query(`UPDATE jobs SET status = 'in_progress', updated_at = NOW() WHERE id = :jid`, { jid: match.job_id });

  // notify customer
  const job = await db.queryOne('SELECT title, customer_id FROM jobs WHERE id = :id', { id: match.job_id });
  await createNotification({ userId: job.customer_id, type: 'job_started', title: 'ช่างเริ่มงานแล้ว',
    body: `ช่างเริ่มดำเนินงาน "${job.title.slice(0, 50)}" แล้ว`, data: { match_id: id } });

  res.json({ ok: true, message: 'เริ่มงานแล้ว' });
}));

// ── PATCH /api/matches/:id/complete ── customer ยืนยันงานเสร็จ ─────────────
router.patch('/:id/complete', requireRole('customer'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const match = await db.queryOne(
    `SELECT * FROM job_matches WHERE id = :id AND customer_id = :uid`,
    { id, uid: req.user.id }
  );
  if (!match) throw errors.notFound('match_not_found', 'ไม่พบงาน');
  if (!['matched', 'in_progress'].includes(match.status)) {
    throw errors.badRequest('invalid_status', 'สถานะงานไม่ถูกต้อง');
  }

  await db.withTransaction(async (conn) => {
    await conn.execute(
      `UPDATE job_matches SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?`, [id]
    );
    await conn.execute(
      `UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [match.job_id]
    );
    // lock chat room
    await conn.execute(`UPDATE chat_rooms SET is_locked = 0 WHERE match_id = ?`, [id]);
    // notify worker
    await conn.execute(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'job_completed', ?, ?, ?)`,
      [match.worker_id, 'งานเสร็จสิ้น!', 'ลูกค้ายืนยันงานเสร็จแล้ว คุณสามารถดูรีวิวได้ที่โปรไฟล์',
       JSON.stringify({ match_id: id })]
    );
  });

  res.json({ ok: true, message: 'ยืนยันงานเสร็จสิ้น กรุณาให้คะแนนช่างด้วยนะครับ' });
}));

// ── PATCH /api/matches/:id/cancel ── ยกเลิก ───────────────────────────────
const cancelSchema = z.object({
  reason: z.string().trim().min(5).max(255),
});

router.patch(
  '/:id/cancel',
  validate({ body: cancelSchema }),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const uid = req.user.id;

    const match = await db.queryOne(
      `SELECT * FROM job_matches WHERE id = :id AND (customer_id = :uid OR worker_id = :uid)`,
      { id, uid }
    );
    if (!match) throw errors.notFound('match_not_found', 'ไม่พบงาน');
    if (!['matched', 'in_progress'].includes(match.status)) {
      throw errors.badRequest('invalid_status', 'ยกเลิกไม่ได้ในสถานะนี้');
    }

    const { reason } = req.body;
    await db.withTransaction(async (conn) => {
      await conn.execute(
        `UPDATE job_matches SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ?,
                                cancel_reason = ?, updated_at = NOW() WHERE id = ?`,
        [uid, reason, id]
      );
      await conn.execute(
        `UPDATE jobs SET status = 'open', matched_at = NULL, updated_at = NOW() WHERE id = ?`,
        [match.job_id]
      );
      // notify the other party
      const otherId = uid === match.customer_id ? match.worker_id : match.customer_id;
      const role = uid === match.customer_id ? 'ลูกค้า' : 'ช่าง';
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'job_cancelled', ?, ?, ?)`,
        [otherId, `${role}ยกเลิกงาน`, `เหตุผล: ${reason.slice(0, 80)}`, JSON.stringify({ match_id: id })]
      );
    });

    res.json({ ok: true, message: 'ยกเลิกงานแล้ว' });
  })
);

// ── POST /api/matches/direct ── ลูกค้าจ้างช่างโดยตรง ─────────────────────
const directHireSchema = z.object({
  workerId:    z.number().int().positive(),
  skillId:     z.number().int().positive(),
  title:       z.string().trim().min(5).max(255),
  description: z.string().trim().min(10).max(2000),
  agreedPrice: z.number().min(0),
  provinceId:  z.number().int().positive(),
  districtId:  z.number().int().positive().optional().nullable(),
  addressNote: z.string().trim().max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
});

router.post(
  '/direct',
  requireRole('customer'),
  validate({ body: directHireSchema }),
  asyncHandler(async (req, res) => {
    const d = req.body;

    // verify worker exists and is active
    const worker = await db.queryOne(
      `SELECT u.id, wp.is_verified FROM users u JOIN worker_profiles wp ON wp.user_id = u.id
       WHERE u.id = :id AND u.is_active = 1 AND u.role = 'worker'`,
      { id: d.workerId }
    );
    if (!worker) throw errors.notFound('worker_not_found', 'ไม่พบช่างรายนี้');

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await db.withTransaction(async (conn) => {
      // create a job entry for tracking
      const [jr] = await conn.execute(
        `INSERT INTO jobs (customer_id, title, description, job_level, budget_type, budget_amount,
                          province_id, district_id, address_note, status, expires_at, matched_at)
         VALUES (?, ?, ?, 1, 'fixed', ?, ?, ?, ?, 'matched', ?, NOW())`,
        [req.user.id, d.title, d.description, d.agreedPrice,
         d.provinceId, d.districtId || null, d.addressNote || null, expiresAt]
      );
      const jobId = jr.insertId;
      if (d.skillId) {
        await conn.execute('INSERT IGNORE INTO job_skills (job_id, skill_id) VALUES (?, ?)', [jobId, d.skillId]);
      }
      const [mr] = await conn.execute(
        `INSERT INTO job_matches (job_id, customer_id, worker_id, agreed_price, match_type, scheduled_at)
         VALUES (?, ?, ?, ?, 'direct_hire', ?)`,
        [jobId, req.user.id, d.workerId, d.agreedPrice, d.scheduledAt || null]
      );
      const matchId = mr.insertId;
      await conn.execute(
        `INSERT INTO chat_rooms (match_id, job_id, participant_a, participant_b) VALUES (?, ?, ?, ?)`,
        [matchId, jobId, req.user.id, d.workerId]
      );
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'match_accepted', ?, ?, ?)`,
        [d.workerId, 'มีลูกค้าจ้างงานคุณ!', `ลูกค้าส่งงาน "${d.title.slice(0,50)}" ให้คุณโดยตรง`,
         JSON.stringify({ match_id: matchId, job_id: jobId })]
      );
      return { matchId, jobId };
    });

    res.status(201).json({ ok: true, message: 'ส่งงานให้ช่างแล้ว', ...result });
  })
);

module.exports = router;
