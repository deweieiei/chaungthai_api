// ============================================================
//  Favorites Routes
//  Mounted at: /api/favorites
//  ทุก endpoint ต้อง login
//
//  GET    /api/favorites/workers           - รายการช่างที่ฉันติดดาว
//  POST   /api/favorites/workers/:worker_id  - กดดาว (idempotent)
//  DELETE /api/favorites/workers/:worker_id  - ปลดดาว
// ============================================================

const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// ------------------------------------------------------------
//  GET /api/favorites/workers
//  รายการช่างที่ฉันติดดาว — เรียงล่าสุดก่อน
//  Response: { favorites: [{ worker_id, user_id, user_name, user_image, ... }] }
// ------------------------------------------------------------
router.get('/workers', async (req, res) => {
  try {
    const me = req.user.user_id;
    const [rows] = await pool.execute(
      `SELECT
          f.fav_id, f.fav_worker_id AS worker_id, f.fav_created_at,
          w.worker_user_id, w.worker_total_jobs,
          u.user_id, u.user_name, u.user_lastname, u.user_image,
          u.user_identity_verified_at,
          p.province_name_th, d.district_name_th, s.subdistrict_name_th
        FROM favorite_worker_chaungthai f
        JOIN worker_chaungthai w ON w.worker_id = f.fav_worker_id
        JOIN user_chaungthai u ON u.user_id = w.worker_user_id
        LEFT JOIN location_province_chaungthai p ON p.province_id = u.user_province_id
        LEFT JOIN location_district_chaungthai d ON d.district_id = u.user_district_id
        LEFT JOIN location_subdistrict_chaungthai s ON s.subdistrict_id = u.user_subdistrict_id
        WHERE f.fav_user_id = ?
          AND u.user_status = 'Active'
        ORDER BY f.fav_created_at DESC
        LIMIT 100`,
      [me]
    );
    return res.json({ favorites: rows });
  } catch (err) {
    console.error('[favorites][GET] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  POST /api/favorites/workers/:worker_id
//  กดดาว (idempotent — ซ้ำก็ตอบ ok)
// ------------------------------------------------------------
router.post('/workers/:worker_id', async (req, res) => {
  try {
    const me = req.user.user_id;
    const workerId = Number(req.params.worker_id);
    if (!Number.isInteger(workerId) || workerId < 1) {
      return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
    }

    // ตรวจช่างมีอยู่ + active
    const [w] = await pool.execute(
      `SELECT w.worker_id, w.worker_user_id, u.user_status
         FROM worker_chaungthai w
         JOIN user_chaungthai u ON u.user_id = w.worker_user_id
        WHERE w.worker_id = ? LIMIT 1`,
      [workerId]
    );
    if (w.length === 0 || w[0].user_status !== 'Active') {
      return res.status(404).json({ error: 'ไม่พบช่าง' });
    }
    if (w[0].worker_user_id === me) {
      return res.status(400).json({ error: 'ติดดาวตัวเองไม่ได้' });
    }

    try {
      await pool.execute(
        `INSERT INTO favorite_worker_chaungthai (fav_user_id, fav_worker_id)
         VALUES (?, ?)`,
        [me, workerId]
      );
    } catch (e) {
      // ซ้ำ — idempotent
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
    return res.json({ message: 'ติดดาวแล้ว', worker_id: workerId, is_favorited: true });
  } catch (err) {
    console.error('[favorites][POST] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ------------------------------------------------------------
//  DELETE /api/favorites/workers/:worker_id
//  ปลดดาว (idempotent — ไม่มีก็ตอบ ok)
// ------------------------------------------------------------
router.delete('/workers/:worker_id', async (req, res) => {
  try {
    const me = req.user.user_id;
    const workerId = Number(req.params.worker_id);
    if (!Number.isInteger(workerId) || workerId < 1) {
      return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
    }
    await pool.execute(
      `DELETE FROM favorite_worker_chaungthai
         WHERE fav_user_id = ? AND fav_worker_id = ?`,
      [me, workerId]
    );
    return res.json({ message: 'ปลดดาวแล้ว', worker_id: workerId, is_favorited: false });
  } catch (err) {
    console.error('[favorites][DELETE] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

module.exports = router;
