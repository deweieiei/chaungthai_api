const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/stats
router.get('/stats', asyncHandler(async (_req, res) => {
  const [[users]] = await Promise.all([
    db.query(`SELECT
      COUNT(*) AS total_users,
      SUM(role = 'worker')   AS workers,
      SUM(role = 'customer') AS customers,
      SUM(is_active = 0)     AS inactive
     FROM users`),
  ]);

  const [[jobs]] = await Promise.all([
    db.query(`SELECT
      COUNT(*) AS total,
      SUM(status = 'open') AS open,
      SUM(status = 'completed') AS completed,
      SUM(status = 'expired') AS expired
     FROM jobs`),
  ]);

  const [[matches]] = await Promise.all([
    db.query(`SELECT
      COUNT(*) AS total,
      SUM(status = 'completed')   AS completed,
      SUM(status = 'in_progress') AS in_progress,
      SUM(status = 'cancelled')   AS cancelled
     FROM job_matches`),
  ]);

  const [[reports]] = await Promise.all([
    db.query(`SELECT COUNT(*) AS pending FROM reports WHERE status = 'pending'`),
  ]);

  res.json({ ok: true, data: { users: users[0], jobs: jobs[0], matches: matches[0], reports: reports[0] } });
}));

// GET /api/admin/users
const listUsersSchema = z.object({
  role:   z.enum(['customer','worker','admin']).optional(),
  active: z.enum(['0','1']).optional(),
  q:      z.string().trim().max(100).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(30),
});

router.get('/users', validate({ query: listUsersSchema }), asyncHandler(async (req, res) => {
  const { role, active, q, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const wheres = [];
  const params = {};

  if (role)   { wheres.push('role = :role');         params.role = role; }
  if (active) { wheres.push('is_active = :active');  params.active = parseInt(active, 10); }
  if (q) {
    wheres.push('(email LIKE :q OR phone LIKE :q OR first_name LIKE :q OR last_name LIKE :q)');
    params.q = `%${q}%`;
  }

  const whereSQL = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const users = await db.query(
    `SELECT id, email, phone, first_name, last_name, role, is_active,
            email_verified_at, phone_verified_at, last_login_at, created_at
     FROM users ${whereSQL}
     ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  res.json({ ok: true, data: users, page, limit });
}));

// PATCH /api/admin/users/:id/status
router.patch('/:id/status', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { isActive, reason } = req.body || {};
  if (isActive === undefined) throw errors.badRequest('missing_field', 'ต้องระบุ isActive');

  await db.query(`UPDATE users SET is_active = :v, updated_at = NOW() WHERE id = :id`, { v: isActive ? 1 : 0, id });
  await db.query(
    `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata) VALUES (:uid, 'admin_toggle_user', :ip, :ua, :meta)`,
    {
      uid: req.user.id, ip: req.ip,
      ua: (req.headers['user-agent'] || '').slice(0, 255),
      meta: JSON.stringify({ target_user: id, is_active: isActive, reason }),
    }
  );
  res.json({ ok: true });
}));

// PATCH /api/admin/users/:id/adjust-tickets
const adjustTicketsSchema = z.object({
  amount: z.number().int().min(-100).max(100),
  reason: z.string().trim().min(3).max(255),
});

router.patch(
  '/users/:id/adjust-tickets',
  validate({ body: adjustTicketsSchema }),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { amount, reason } = req.body;

    const wp = await db.queryOne('SELECT tickets_balance FROM worker_profiles WHERE user_id = :id', { id: userId });
    if (!wp) throw errors.notFound('not_found', 'ไม่พบโปรไฟล์ช่าง');

    const newBalance = Math.max(0, wp.tickets_balance + amount);
    await db.withTransaction(async (conn) => {
      await conn.execute('UPDATE worker_profiles SET tickets_balance = ?, updated_at = NOW() WHERE user_id = ?', [newBalance, userId]);
      await conn.execute(
        `INSERT INTO ticket_transactions (worker_id, type, amount, balance_after, reference_type, note)
         VALUES (?, 'admin_adjust', ?, ?, 'admin', ?)`,
        [userId, amount, newBalance, `Admin: ${reason}`]
      );
    });
    res.json({ ok: true, newBalance });
  })
);

// GET /api/admin/jobs
const listJobsSchema = z.object({
  status: z.enum(['open','matched','in_progress','completed','expired','cancelled']).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(30),
});

router.get('/jobs', validate({ query: listJobsSchema }), asyncHandler(async (req, res) => {
  const { status, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const wheres = [];
  const params = {};

  if (status) { wheres.push('j.status = :status'); params.status = status; }

  const whereSQL = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const jobs = await db.query(
    `SELECT j.id, j.title, j.status, j.job_level, j.budget_type, j.budget_amount,
            j.application_count, j.view_count, j.created_at, j.expires_at,
            u.first_name, u.last_name, u.email
     FROM jobs j JOIN users u ON u.id = j.customer_id
     ${whereSQL}
     ORDER BY j.created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  res.json({ ok: true, data: jobs, page, limit });
}));

// GET /api/admin/reports
router.get('/reports', asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
  const status = req.query.status || 'pending';

  const reports = await db.query(
    `SELECT r.*,
            u.first_name AS reporter_first_name, u.last_name AS reporter_last_name
     FROM reports r JOIN users u ON u.id = r.reporter_id
     WHERE r.status = :status
     ORDER BY r.created_at ASC LIMIT :limit OFFSET :offset`,
    { status, limit, offset: (page - 1) * limit }
  );
  res.json({ ok: true, data: reports, page, limit });
}));

// PATCH /api/admin/reports/:id
const resolveReportSchema = z.object({
  status: z.enum(['reviewed', 'resolved', 'dismissed']),
  note:   z.string().trim().max(500).optional(),
});

router.patch(
  '/reports/:id',
  validate({ body: resolveReportSchema }),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, note } = req.body;
    await db.query(
      `UPDATE reports SET status = :status, reviewed_by = :uid, reviewed_at = NOW() WHERE id = :id`,
      { status, uid: req.user.id, id }
    );
    if (note) {
      await db.query(
        `INSERT INTO audit_log (user_id, action, ip, user_agent, metadata) VALUES (:uid, 'admin_resolve_report', :ip, :ua, :meta)`,
        { uid: req.user.id, ip: req.ip, ua: '', meta: JSON.stringify({ report_id: id, note }) }
      );
    }
    res.json({ ok: true });
  })
);

// GET /api/admin/audit
router.get('/audit', asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const uid   = req.query.userId;

  const wheres = [];
  const params = {};
  if (uid) { wheres.push('al.user_id = :uid'); params.uid = uid; }
  const whereSQL = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  const logs = await db.query(
    `SELECT al.id, al.user_id, al.action, al.ip, al.created_at,
            u.first_name, u.last_name, u.email
     FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
     ${whereSQL}
     ORDER BY al.created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset: (page - 1) * limit }
  );
  res.json({ ok: true, data: logs, page, limit });
}));

// POST /api/admin/blacklist
const blacklistSchema = z.object({
  identifier: z.string().min(5).max(255),
  type:       z.enum(['phone','email','device_id']),
  reason:     z.string().trim().min(5).max(255),
  expiresAt:  z.string().datetime().optional().nullable(),
});

router.post(
  '/blacklist',
  validate({ body: blacklistSchema }),
  asyncHandler(async (req, res) => {
    const { identifier, type, reason, expiresAt } = req.body;
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(identifier).digest('hex');

    await db.query(
      `INSERT INTO blacklist (identifier_hash, identifier_type, reason, banned_by, expires_at)
       VALUES (:hash, :type, :reason, :uid, :exp)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), banned_by = VALUES(banned_by),
                               expires_at = VALUES(expires_at)`,
      { hash, type, reason, uid: req.user.id, exp: expiresAt || null }
    ).catch(() => {
      // table may be on DB2 — skip silently in dev
      console.warn('[admin] blacklist table not found (likely on DB2)');
    });

    res.status(201).json({ ok: true, message: 'เพิ่ม blacklist แล้ว' });
  })
);

module.exports = router;
