const db = require('../db');
const ws = require('../ws');

/**
 * Insert a notification row + push ผ่าน WebSocket (real-time)
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.type
 * @param {string}  opts.title
 * @param {string}  [opts.body]
 * @param {object}  [opts.data]   - JSON payload e.g. { job_id, match_id }
 */
async function createNotification({ userId, type, title, body = null, data = null }) {
  try {
    const [r] = await db.pool.execute(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, type, title, body, data ? JSON.stringify(data) : null]
    );

    // WebSocket push แบบ real-time → ถ้า user online จะได้ทันที
    ws.broadcast(userId, {
      type:           'notification',
      notificationId: r.insertId,
      notifType:      type,
      title,
      body,
      data,
      createdAt:      new Date().toISOString(),
    });
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

module.exports = { createNotification };
