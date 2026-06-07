// ============================================================
//  Chat Routes
//  Mounted at: /api/chat
//  ทุก endpoint ต้อง login
//
//  GET  /api/chat/unread-count                       - จำนวนข้อความยังไม่อ่าน (รวม) ใช้ทำ badge
//  GET  /api/chat/conversations                      - inbox: รายการห้องแชตของฉัน
//  GET  /api/chat/conversations/with/:user_id        - เปิด/สร้างห้องกับ user คนนั้น
//  GET  /api/chat/conversations/:conv_id/messages    - โหลดข้อความ (cursor: before_id)
//  POST /api/chat/conversations/:conv_id/messages    - ส่งข้อความ
// ============================================================

const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');
const { getIO } = require('../socket');

const router = express.Router();

// ทุก endpoint ต้อง login
router.use(verifyToken);

const MAX_MESSAGE_LEN = 4000;

// ------------------------------------------------------------
//  GET /api/chat/unread-count
// ------------------------------------------------------------
router.get('/unread-count', async (req, res) => {
  try {
    const me = req.user.user_id;
    const [r] = await pool.execute(
      `SELECT COUNT(*) AS cnt
         FROM message_chaungthai m
         JOIN conversation_chaungthai c ON c.conv_id = m.msg_conv_id
        WHERE m.msg_read_at IS NULL
          AND m.msg_sender_id <> ?
          AND (c.conv_user1_id = ? OR c.conv_user2_id = ?)`,
      [me, me, me]
    );
    return res.json({ unread_count: Number(r[0].cnt) });
  } catch (err) {
    console.error('[chat][unread-count] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  GET /api/chat/conversations
//  inbox - เรียงตามข้อความล่าสุด
// ------------------------------------------------------------
router.get('/conversations', async (req, res) => {
  try {
    const me = req.user.user_id;
    const [rows] = await pool.execute(
      `SELECT
         c.conv_id,
         c.conv_last_message_at,
         CASE WHEN c.conv_user1_id = ? THEN c.conv_user2_id ELSE c.conv_user1_id END AS other_user_id,
         u.user_name      AS other_user_name,
         u.user_lastname  AS other_user_lastname,
         u.user_image     AS other_user_image,
         m.msg_id         AS last_msg_id,
         m.msg_sender_id  AS last_msg_sender_id,
         m.msg_content    AS last_msg_content,
         m.msg_type       AS last_msg_type,
         m.msg_created_at AS last_msg_created_at,
         (SELECT COUNT(*) FROM message_chaungthai mu
            WHERE mu.msg_conv_id = c.conv_id
              AND mu.msg_sender_id <> ?
              AND mu.msg_read_at IS NULL) AS unread_count
       FROM conversation_chaungthai c
       LEFT JOIN user_chaungthai u
         ON u.user_id = CASE WHEN c.conv_user1_id = ? THEN c.conv_user2_id ELSE c.conv_user1_id END
       LEFT JOIN message_chaungthai m ON m.msg_id = c.conv_last_message_id
       WHERE (c.conv_user1_id = ? OR c.conv_user2_id = ?)
         AND c.conv_last_message_id IS NOT NULL
       ORDER BY c.conv_last_message_at DESC
       LIMIT 100`,
      [me, me, me, me, me]
    );
    return res.json({ conversations: rows });
  } catch (err) {
    console.error('[chat][GET conversations] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  GET /api/chat/conversations/with/:user_id
//  หา/สร้างห้องกับ user คนนั้น (idempotent)
// ------------------------------------------------------------
router.get('/conversations/with/:user_id', async (req, res) => {
  try {
    const me = req.user.user_id;
    const other = Number(req.params.user_id);
    if (!Number.isInteger(other) || other < 1) {
      return res.status(400).json({ error: 'user_id ไม่ถูกต้อง' });
    }
    if (other === me) {
      return res.status(400).json({ error: 'ไม่สามารถแชตกับตัวเองได้' });
    }

    // ตรวจว่า other user มีอยู่ + active
    const [u] = await pool.execute(
      `SELECT user_id, user_name, user_lastname, user_image, user_status
         FROM user_chaungthai
        WHERE user_id = ? LIMIT 1`,
      [other]
    );
    if (u.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (u[0].user_status !== 'Active') {
      return res.status(400).json({ error: 'ผู้ใช้นี้ไม่สามารถรับข้อความได้' });
    }

    // เรียง user1 < user2
    const u1 = Math.min(me, other);
    const u2 = Math.max(me, other);

    // หาห้องที่มีอยู่
    const [existing] = await pool.execute(
      `SELECT conv_id FROM conversation_chaungthai
        WHERE conv_user1_id = ? AND conv_user2_id = ? LIMIT 1`,
      [u1, u2]
    );

    let convId;
    if (existing.length > 0) {
      convId = existing[0].conv_id;
    } else {
      try {
        const [ins] = await pool.execute(
          `INSERT INTO conversation_chaungthai (conv_user1_id, conv_user2_id)
           VALUES (?, ?)`,
          [u1, u2]
        );
        convId = ins.insertId;
      } catch (e) {
        // race condition: คนละ request สร้างพร้อมกัน → unique key ชน
        if (e.code === 'ER_DUP_ENTRY') {
          const [again] = await pool.execute(
            `SELECT conv_id FROM conversation_chaungthai
              WHERE conv_user1_id = ? AND conv_user2_id = ? LIMIT 1`,
            [u1, u2]
          );
          convId = again[0].conv_id;
        } else {
          throw e;
        }
      }
    }

    return res.json({
      conv_id: convId,
      other_user: {
        user_id: u[0].user_id,
        user_name: u[0].user_name,
        user_lastname: u[0].user_lastname,
        user_image: u[0].user_image,
      },
    });
  } catch (err) {
    console.error('[chat][with] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  GET /api/chat/conversations/:conv_id/messages
//    ?before_id=12345  (cursor — โหลดที่เก่ากว่า id นี้)
//    ?limit=30
//  ตอบกลับเรียง chronological (เก่า → ใหม่)
//  + auto mark-as-read สำหรับข้อความที่ฝั่งตรงข้ามส่งมา
// ------------------------------------------------------------
router.get('/conversations/:conv_id/messages', async (req, res) => {
  try {
    const me = req.user.user_id;
    const convId = Number(req.params.conv_id);
    if (!Number.isInteger(convId) || convId < 1) {
      return res.status(400).json({ error: 'conv_id ไม่ถูกต้อง' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const beforeId = req.query.before_id ? Number(req.query.before_id) : null;
    if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId < 1)) {
      return res.status(400).json({ error: 'before_id ไม่ถูกต้อง' });
    }

    // ตรวจสิทธิ์ + ดึงข้อมูลคู่สนทนา
    const [c] = await pool.execute(
      `SELECT conv_user1_id, conv_user2_id
         FROM conversation_chaungthai WHERE conv_id = ? LIMIT 1`,
      [convId]
    );
    if (c.length === 0) return res.status(404).json({ error: 'ไม่พบห้องแชต' });
    if (c[0].conv_user1_id !== me && c[0].conv_user2_id !== me) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงห้องแชตนี้' });
    }
    const otherUserId =
      c[0].conv_user1_id === me ? c[0].conv_user2_id : c[0].conv_user1_id;

    // โหลดข้อความ (ใช้ literal limit เพราะ mysql2 prepared มีปัญหากับ LIMIT)
    let rows;
    if (beforeId) {
      [rows] = await pool.execute(
        `SELECT msg_id, msg_conv_id, msg_sender_id, msg_content, msg_type, msg_read_at, msg_created_at
           FROM message_chaungthai
          WHERE msg_conv_id = ? AND msg_id < ?
          ORDER BY msg_id DESC
          LIMIT ${limit}`,
        [convId, beforeId]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT msg_id, msg_conv_id, msg_sender_id, msg_content, msg_type, msg_read_at, msg_created_at
           FROM message_chaungthai
          WHERE msg_conv_id = ?
          ORDER BY msg_id DESC
          LIMIT ${limit}`,
        [convId]
      );
    }

    // mark read (ไม่รอ — fire-and-forget)
    pool
      .execute(
        `UPDATE message_chaungthai
            SET msg_read_at = CURRENT_TIMESTAMP
          WHERE msg_conv_id = ?
            AND msg_sender_id <> ?
            AND msg_read_at IS NULL`,
        [convId, me]
      )
      .then(([r]) => {
        if (r.affectedRows > 0) {
          try {
            getIO().to(`user:${otherUserId}`).emit('chat:read', {
              conv_id: convId,
              by_user_id: me,
              read_at: new Date().toISOString(),
            });
          } catch (e) {
            /* io ยังไม่พร้อม — ไม่ใช่ปัญหา */
          }
        }
      })
      .catch((e) => console.error('[chat][auto-read]', e.message));

    return res.json({
      conv_id: convId,
      messages: rows.reverse(), // ส่งกลับเรียงเก่า→ใหม่
      has_more: rows.length === limit,
    });
  } catch (err) {
    console.error('[chat][GET messages] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  POST /api/chat/conversations/:conv_id/messages
//  Body: { content: string, type?: 'text'|'image' }
// ------------------------------------------------------------
router.post('/conversations/:conv_id/messages', async (req, res) => {
  const me = req.user.user_id;
  const convId = Number(req.params.conv_id);
  if (!Number.isInteger(convId) || convId < 1) {
    return res.status(400).json({ error: 'conv_id ไม่ถูกต้อง' });
  }

  const { content, type } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'กรุณาส่งข้อความ' });
  }
  const trimmed = content.trim();
  if (trimmed.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({
      error: `ข้อความยาวเกิน ${MAX_MESSAGE_LEN} ตัวอักษร`,
    });
  }
  const msgType = ['text', 'image'].includes(type) ? type : 'text';

  const conn = await pool.getConnection();
  try {
    // ตรวจสิทธิ์ + lock row กัน race
    const [c] = await conn.execute(
      `SELECT conv_user1_id, conv_user2_id
         FROM conversation_chaungthai WHERE conv_id = ? LIMIT 1 FOR UPDATE`,
      [convId]
    );
    if (c.length === 0) {
      conn.release();
      return res.status(404).json({ error: 'ไม่พบห้องแชต' });
    }
    if (c[0].conv_user1_id !== me && c[0].conv_user2_id !== me) {
      conn.release();
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงห้องแชตนี้' });
    }
    const otherUserId =
      c[0].conv_user1_id === me ? c[0].conv_user2_id : c[0].conv_user1_id;

    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO message_chaungthai (msg_conv_id, msg_sender_id, msg_content, msg_type)
       VALUES (?, ?, ?, ?)`,
      [convId, me, trimmed, msgType]
    );
    const msgId = ins.insertId;

    await conn.execute(
      `UPDATE conversation_chaungthai
          SET conv_last_message_id = ?, conv_last_message_at = CURRENT_TIMESTAMP
        WHERE conv_id = ?`,
      [msgId, convId]
    );

    const [m] = await conn.execute(
      `SELECT msg_id, msg_conv_id, msg_sender_id, msg_content, msg_type, msg_read_at, msg_created_at
         FROM message_chaungthai WHERE msg_id = ?`,
      [msgId]
    );
    await conn.commit();
    conn.release();

    const message = m[0];

    // broadcast ทั้งสองฝั่ง (ตัวเองด้วย เผื่อเปิดหลาย tab)
    try {
      const io = getIO();
      io.to(`user:${me}`).emit('chat:message', message);
      io.to(`user:${otherUserId}`).emit('chat:message', message);
    } catch (e) {
      console.error('[chat][POST] socket emit fail:', e.message);
    }

    return res.status(201).json({ message });
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    conn.release();
    console.error('[chat][POST] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

module.exports = router;
