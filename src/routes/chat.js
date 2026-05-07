const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { errors, asyncHandler } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/chat ── รายการห้องแชท ─────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const uid = req.user.id;
  const rooms = await db.query(
    `SELECT cr.id, cr.match_id, cr.job_id, cr.is_locked,
            cr.last_message_at, cr.created_at,
            j.title AS job_title,
            -- other participant
            CASE WHEN cr.participant_a = :uid THEN cr.participant_b ELSE cr.participant_a END AS other_user_id,
            CASE WHEN cr.participant_a = :uid THEN ub.first_name ELSE ua.first_name END AS other_first_name,
            CASE WHEN cr.participant_a = :uid THEN ub.last_name  ELSE ua.last_name  END AS other_last_name,
            CASE WHEN cr.participant_a = :uid THEN wpb.avatar_url ELSE wpa.avatar_url END AS other_avatar,
            -- last message
            (SELECT content FROM chat_messages
             WHERE room_id = cr.id AND is_deleted = 0
             ORDER BY created_at DESC LIMIT 1) AS last_message,
            -- unread count
            (SELECT COUNT(*) FROM chat_messages
             WHERE room_id = cr.id AND sender_id != :uid AND read_at IS NULL AND is_deleted = 0) AS unread_count
     FROM chat_rooms cr
     JOIN users ua ON ua.id = cr.participant_a
     JOIN users ub ON ub.id = cr.participant_b
     LEFT JOIN worker_profiles wpa ON wpa.user_id = cr.participant_a
     LEFT JOIN worker_profiles wpb ON wpb.user_id = cr.participant_b
     LEFT JOIN jobs j ON j.id = cr.job_id
     WHERE cr.participant_a = :uid OR cr.participant_b = :uid
     ORDER BY COALESCE(cr.last_message_at, cr.created_at) DESC`,
    { uid }
  );
  res.json({ ok: true, data: rooms });
}));

// ── GET /api/chat/:roomId ── ข้อความในห้อง ────────────────────────────────
const messagesSchema = z.object({
  before:  z.coerce.number().int().positive().optional(),
  limit:   z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  '/:roomId',
  validate({ query: messagesSchema }),
  asyncHandler(async (req, res) => {
    const roomId = parseInt(req.params.roomId, 10);
    const uid    = req.user.id;

    const room = await db.queryOne(
      `SELECT * FROM chat_rooms WHERE id = :id AND (participant_a = :uid OR participant_b = :uid)`,
      { id: roomId, uid }
    );
    if (!room) throw errors.notFound('room_not_found', 'ไม่พบห้องแชท');

    const { before, limit } = req.query;
    const params = { roomId };
    const wheres = ['room_id = :roomId', 'is_deleted = 0', 'expires_at > NOW()'];

    if (before) { wheres.push('id < :before'); params.before = before; }

    const messages = await db.query(
      `SELECT cm.id, cm.sender_id, cm.message_type, cm.content, cm.image_url,
              cm.read_at, cm.created_at,
              u.first_name AS sender_first_name
       FROM chat_messages cm
       JOIN users u ON u.id = cm.sender_id
       WHERE ${wheres.join(' AND ')}
       ORDER BY cm.id DESC
       LIMIT :limit`,
      { ...params, limit }
    );

    // mark messages from other person as read
    await db.query(
      `UPDATE chat_messages SET read_at = NOW()
       WHERE room_id = :roomId AND sender_id != :uid AND read_at IS NULL`,
      { roomId, uid }
    );

    res.json({ ok: true, data: messages.reverse(), roomId });
  })
);

// ── POST /api/chat/:roomId ── ส่งข้อความ ──────────────────────────────────
const sendSchema = z.object({
  content:     z.string().trim().min(1).max(2000),
  messageType: z.enum(['text', 'image']).default('text'),
  imageUrl:    z.string().url().max(500).optional(),
});

router.post(
  '/:roomId',
  validate({ body: sendSchema }),
  asyncHandler(async (req, res) => {
    const roomId = parseInt(req.params.roomId, 10);
    const uid    = req.user.id;

    const room = await db.queryOne(
      `SELECT * FROM chat_rooms WHERE id = :id AND (participant_a = :uid OR participant_b = :uid)`,
      { id: roomId, uid }
    );
    if (!room) throw errors.notFound('room_not_found', 'ไม่พบห้องแชท');
    if (room.is_locked) throw errors.badRequest('room_locked', 'ห้องแชทนี้ถูกปิดแล้ว');

    const { content, messageType, imageUrl } = req.body;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const [r] = await db.pool.execute(
      `INSERT INTO chat_messages (room_id, sender_id, message_type, content, image_url, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [roomId, uid, messageType, content, imageUrl || null, expiresAt]
    );
    const msgId = r.insertId;

    await db.query('UPDATE chat_rooms SET last_message_at = NOW() WHERE id = :id', { id: roomId });

    // notify the other participant
    const otherId = room.participant_a === uid ? room.participant_b : room.participant_a;
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES (:uid, 'new_message', 'ข้อความใหม่', :body, :data)`,
      {
        uid: otherId,
        body: content.slice(0, 100),
        data: JSON.stringify({ room_id: roomId, message_id: msgId }),
      }
    );

    const msg = await db.queryOne('SELECT * FROM chat_messages WHERE id = :id', { id: msgId });
    res.status(201).json({ ok: true, data: msg });
  })
);

// ── PATCH /api/chat/:roomId/read ── mark all as read ─────────────────────
router.patch('/:roomId/read', asyncHandler(async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const uid    = req.user.id;

  const room = await db.queryOne(
    `SELECT id FROM chat_rooms WHERE id = :id AND (participant_a = :uid OR participant_b = :uid)`,
    { id: roomId, uid }
  );
  if (!room) throw errors.notFound('room_not_found', 'ไม่พบห้องแชท');

  await db.query(
    `UPDATE chat_messages SET read_at = NOW()
     WHERE room_id = :roomId AND sender_id != :uid AND read_at IS NULL`,
    { roomId, uid }
  );
  res.json({ ok: true });
}));

module.exports = router;
