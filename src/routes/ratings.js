const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();

// GET /api/ratings/worker/:workerId  — public ratings list
router.get('/worker/:workerId', asyncHandler(async (req, res) => {
  const workerId = parseInt(req.params.workerId, 10);
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

  const ratings = await db.query(
    `SELECT r.stars, r.review_text, r.created_at,
            jm.agreed_price,
            j.title AS job_title, j.job_level
     FROM ratings r
     JOIN job_matches jm ON jm.id = r.match_id
     JOIN jobs j ON j.id = jm.job_id
     WHERE r.to_user_id = :wid AND r.is_public = 1
     ORDER BY r.created_at DESC
     LIMIT :limit OFFSET :offset`,
    { wid: workerId, limit, offset: (page - 1) * limit }
  );

  const summary = await db.queryOne(
    `SELECT rating_avg, rating_count FROM worker_profiles WHERE user_id = :id`,
    { id: workerId }
  );

  res.json({ ok: true, data: ratings, summary, page, limit });
}));

// POST /api/ratings  — customer gives rating after completed match
const ratingSchema = z.object({
  matchId:    z.number().int().positive(),
  stars:      z.number().int().min(1).max(5),
  reviewText: z.string().trim().max(1000).optional(),
});

router.post(
  '/',
  requireAuth,
  requireRole('customer'),
  validate({ body: ratingSchema }),
  asyncHandler(async (req, res) => {
    const { matchId, stars, reviewText } = req.body;
    const uid = req.user.id;

    const match = await db.queryOne(
      `SELECT * FROM job_matches WHERE id = :id AND customer_id = :uid`,
      { id: matchId, uid }
    );
    if (!match) throw errors.notFound('match_not_found', 'ไม่พบงาน');
    if (match.status !== 'completed') throw errors.badRequest('not_completed', 'รีวิวได้เฉพาะงานที่เสร็จแล้ว');

    const existing = await db.queryOne(
      `SELECT id FROM ratings WHERE match_id = :mid AND from_user_id = :uid`,
      { mid: matchId, uid }
    );
    if (existing) throw errors.conflict('already_rated', 'คุณให้คะแนนงานนี้แล้ว');

    await db.withTransaction(async (conn) => {
      await conn.execute(
        `INSERT INTO ratings (match_id, from_user_id, to_user_id, stars, review_text)
         VALUES (?, ?, ?, ?, ?)`,
        [matchId, uid, match.worker_id, stars, reviewText || null]
      );
      // recalculate worker rating
      await conn.execute(
        `UPDATE worker_profiles SET
           rating_avg   = (SELECT ROUND(AVG(stars), 2) FROM ratings WHERE to_user_id = ?),
           rating_count = (SELECT COUNT(*) FROM ratings WHERE to_user_id = ?),
           updated_at   = NOW()
         WHERE user_id = ?`,
        [match.worker_id, match.worker_id, match.worker_id]
      );
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, 'rating_received', ?, ?, ?)`,
        [match.worker_id, `คุณได้รับคะแนน ${stars} ดาว!`,
         reviewText ? reviewText.slice(0, 100) : 'ลูกค้าให้คะแนนงานของคุณแล้ว',
         JSON.stringify({ match_id: matchId, stars })]
      );
    });

    res.status(201).json({ ok: true, message: 'ขอบคุณสำหรับการให้คะแนน' });
  })
);

// GET /api/ratings/customer/:customerId  — ประวัติการรีวิวของลูกค้า (ช่างดูได้)
// แสดงรีวิวที่ลูกค้าคนนี้เคยให้กับช่างต่างๆ (เพื่อดูว่าลูกค้าดุหรือใจดี)
router.get('/customer/:customerId', asyncHandler(async (req, res) => {
  const customerId = parseInt(req.params.customerId, 10);
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);

  // ตรวจว่า customer มีอยู่จริง
  const customer = await db.queryOne(
    `SELECT id, first_name, last_name FROM users WHERE id = :id AND role = 'customer'`,
    { id: customerId }
  );
  if (!customer) throw errors.notFound('customer_not_found', 'ไม่พบผู้ว่าจ้างรายนี้');

  // รีวิวที่ลูกค้าคนนี้ให้ (from_user_id = customerId) เฉพาะที่ public
  const reviews = await db.query(
    `SELECT r.stars, r.review_text, r.created_at,
            jm.agreed_price,
            j.title AS job_title, j.job_level,
            uw.first_name AS worker_first_name, uw.last_name AS worker_last_name
     FROM ratings r
     JOIN job_matches jm ON jm.id = r.match_id
     JOIN jobs j         ON j.id  = jm.job_id
     JOIN users uw       ON uw.id = jm.worker_id
     WHERE r.from_user_id = :cid AND r.is_public = 1
     ORDER BY r.created_at DESC
     LIMIT :limit OFFSET :offset`,
    { cid: customerId, limit, offset: (page - 1) * limit }
  );

  // สรุปสถิติ: ให้คะแนนเฉลี่ยเท่าไหร่ → บอกว่าลูกค้าคนนี้ใจดีแค่ไหน
  const summary = await db.queryOne(
    `SELECT
       COUNT(*)           AS total_reviews,
       ROUND(AVG(stars), 2) AS avg_stars_given,
       SUM(stars = 5)     AS stars_5,
       SUM(stars = 4)     AS stars_4,
       SUM(stars = 3)     AS stars_3,
       SUM(stars <= 2)    AS stars_low
     FROM ratings
     WHERE from_user_id = :cid AND is_public = 1`,
    { cid: customerId }
  );

  res.json({
    ok: true,
    customer: { id: customer.id, firstName: customer.first_name, lastName: customer.last_name },
    summary,
    data: reviews,
    page,
    limit,
  });
}));

module.exports = router;
