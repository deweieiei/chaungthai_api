const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications
const listSchema = z.object({
  unreadOnly: z.enum(['true','false']).transform(v => v === 'true').optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(100).default(30),
});

router.get('/', validate({ query: listSchema }), asyncHandler(async (req, res) => {
  const { unreadOnly, page, limit } = req.query;
  const offset = (page - 1) * limit;
  const uid = req.user.id;

  const wheres = ['user_id = :uid'];
  const params = { uid };
  if (unreadOnly) { wheres.push('is_read = 0'); }

  const [notifs, [countRow]] = await Promise.all([
    db.query(
      `SELECT id, type, title, body, data, is_read, read_at, created_at
       FROM notifications
       WHERE ${wheres.join(' AND ')}
       ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset }
    ),
    db.query(
      `SELECT COUNT(*) AS total, SUM(is_read = 0) AS unread FROM notifications WHERE user_id = :uid`,
      { uid }
    ),
  ]);

  res.json({ ok: true, data: notifs, total: countRow.total, unread: countRow.unread, page, limit });
}));

// PATCH /api/notifications/read-all
router.patch('/read-all', asyncHandler(async (req, res) => {
  await db.query(
    `UPDATE notifications SET is_read = 1, read_at = NOW() WHERE user_id = :uid AND is_read = 0`,
    { uid: req.user.id }
  );
  res.json({ ok: true });
}));

// PATCH /api/notifications/:id/read
router.patch('/:id/read', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query(
    `UPDATE notifications SET is_read = 1, read_at = NOW()
     WHERE id = :id AND user_id = :uid AND is_read = 0`,
    { id, uid: req.user.id }
  );
  res.json({ ok: true });
}));

// DELETE /api/notifications/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query(
    'DELETE FROM notifications WHERE id = :id AND user_id = :uid',
    { id, uid: req.user.id }
  );
  res.json({ ok: true });
}));

module.exports = router;
