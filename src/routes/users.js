const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/users/me ──────────────────────────────────────────────────────
router.get('/me', asyncHandler(async (req, res) => {
  const user = await db.queryOne(
    `SELECT id, email, phone, first_name, last_name, role,
            email_verified_at, phone_verified_at, is_active,
            newsletter_opt_in, last_login_at, created_at, updated_at
     FROM users WHERE id = :id`,
    { id: req.user.id }
  );
  if (!user) throw errors.notFound('user_not_found', 'ไม่พบผู้ใช้');

  let workerProfile = null;
  if (user.role === 'worker') {
    workerProfile = await db.queryOne(
      `SELECT wp.bio, wp.avatar_url, wp.rating_avg, wp.rating_count,
              wp.tickets_balance, wp.is_verified, wp.verified_at
       FROM worker_profiles wp WHERE wp.user_id = :id`,
      { id: user.id }
    );
  }

  res.json({ ok: true, user: { ...user, workerProfile } });
}));

// ── PATCH /api/users/me ────────────────────────────────────────────────────
const updateMeSchema = z.object({
  firstName:      z.string().trim().min(1).max(100).optional(),
  lastName:       z.string().trim().min(1).max(100).optional(),
  newsletterOptIn: z.boolean().optional(),
}).strict();

router.patch(
  '/me',
  validate({ body: updateMeSchema }),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, newsletterOptIn } = req.body;
    const sets = [];
    const params = { id: req.user.id };

    if (firstName  !== undefined) { sets.push('first_name = :fn'); params.fn = firstName; }
    if (lastName   !== undefined) { sets.push('last_name = :ln');  params.ln = lastName; }
    if (newsletterOptIn !== undefined) { sets.push('newsletter_opt_in = :nl'); params.nl = newsletterOptIn ? 1 : 0; }

    if (sets.length) {
      await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = :id`, params);
    }

    const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });
    res.json({ ok: true, user });
  })
);

// ── PATCH /api/users/me/password ───────────────────────────────────────────
const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8).max(100)
                     .regex(/[A-Za-z]/, 'ต้องมีตัวอักษร')
                     .regex(/[0-9]/,    'ต้องมีตัวเลข'),
});

router.patch(
  '/me/password',
  validate({ body: changePwSchema }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await db.queryOne('SELECT * FROM users WHERE id = :id', { id: req.user.id });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) throw errors.badRequest('wrong_password', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');

    const newHash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await db.query('UPDATE users SET password_hash = :h, updated_at = NOW() WHERE id = :id',
      { h: newHash, id: req.user.id });

    // revoke all refresh tokens for security
    await db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = :id AND revoked_at IS NULL',
      { id: req.user.id });

    await db.query(
      `INSERT INTO audit_log (user_id, action, ip, user_agent) VALUES (:u, 'change_password', :ip, :ua)`,
      { u: req.user.id, ip: req.ip, ua: (req.headers['user-agent'] || '').slice(0, 255) }
    );

    res.json({ ok: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ กรุณา login ใหม่' });
  })
);

// ── DELETE /api/users/me ── PDPA right to delete ───────────────────────────
router.delete('/me', asyncHandler(async (req, res) => {
  await db.withTransaction(async (conn) => {
    await conn.execute('UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = ?', [req.user.id]);
    await conn.execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
    await conn.execute(
      `INSERT INTO audit_log (user_id, action, ip, user_agent) VALUES (?, 'delete_account_request', ?, ?)`,
      [req.user.id, req.ip, (req.headers['user-agent'] || '').slice(0, 255)]
    );
  });
  res.json({ ok: true, message: 'บัญชีของคุณถูกระงับแล้ว ข้อมูลจะถูกลบใน 90 วัน' });
}));

// ── GET /api/users/me/consent ──────────────────────────────────────────────
router.get('/me/consent', asyncHandler(async (req, res) => {
  const logs = await db.query(
    `SELECT id, document_type, document_version, accepted, ip, created_at
     FROM consent_logs WHERE user_id = :id ORDER BY created_at DESC`,
    { id: req.user.id }
  );
  res.json({ ok: true, data: logs });
}));

// ── POST /api/users/me/consent ─────────────────────────────────────────────
const consentSchema = z.object({
  documentType:    z.enum(['terms', 'privacy_policy', 'cookie']),
  documentVersion: z.string().max(20).default('1.0'),
  accepted:        z.boolean(),
});

router.post(
  '/me/consent',
  validate({ body: consentSchema }),
  asyncHandler(async (req, res) => {
    const { documentType, documentVersion, accepted } = req.body;
    await db.query(
      `INSERT INTO consent_logs (user_id, document_type, document_version, accepted, ip, user_agent)
       VALUES (:uid, :dt, :dv, :acc, :ip, :ua)`,
      {
        uid: req.user.id, dt: documentType, dv: documentVersion,
        acc: accepted ? 1 : 0, ip: req.ip,
        ua: (req.headers['user-agent'] || '').slice(0, 255),
      }
    );
    res.status(201).json({ ok: true });
  })
);

// ── POST /api/users/me/device-token ───────────────────────────────────────
const deviceTokenSchema = z.object({
  token:      z.string().min(10).max(255),
  platform:   z.enum(['fcm', 'apns', 'web']).default('fcm'),
  deviceName: z.string().max(100).optional(),
});

router.post(
  '/me/device-token',
  validate({ body: deviceTokenSchema }),
  asyncHandler(async (req, res) => {
    const { token, platform, deviceName } = req.body;
    await db.query(
      `INSERT INTO device_tokens (user_id, token, platform, device_name)
       VALUES (:uid, :token, :platform, :dn)
       ON DUPLICATE KEY UPDATE platform = VALUES(platform), device_name = VALUES(device_name),
                               is_active = 1, updated_at = NOW()`,
      { uid: req.user.id, token, platform, dn: deviceName || null }
    );
    res.status(201).json({ ok: true });
  })
);

// ── DELETE /api/users/me/device-token ─────────────────────────────────────
router.delete('/me/device-token', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (token) {
    await db.query(
      `UPDATE device_tokens SET is_active = 0 WHERE user_id = :uid AND token = :token`,
      { uid: req.user.id, token }
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
