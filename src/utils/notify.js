const db = require('../db');

/**
 * Insert a notification row.
 * @param {object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.type
 * @param {string}  opts.title
 * @param {string}  [opts.body]
 * @param {object}  [opts.data]   - JSON payload e.g. { job_id, match_id }
 */
async function createNotification({ userId, type, title, body = null, data = null }) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES (:userId, :type, :title, :body, :data)`,
      { userId, type, title, body, data: data ? JSON.stringify(data) : null }
    );
  } catch (err) {
    console.error('[notify] failed to insert notification:', err.message);
  }
}

module.exports = { createNotification };
