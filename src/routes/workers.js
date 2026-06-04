// ============================================================
//  Workers Routes
//  Mounted at: /api/workers
//
//  POST /api/workers              - สมัครเป็นช่าง (login + ยังไม่เป็นช่าง)
//  PUT  /api/workers/:id/skills   - เลือกสกิลของช่าง (replace mode)
//  GET  /api/workers/search       - ค้นหาช่างตามสกิล + พื้นที่
// ============================================================

const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// ตั๋วเริ่มต้นตอนสมัครเป็นช่าง
const DEFAULT_JOB_TICKETS = 25;

// ============================================================
//  POST /api/workers
//  สมัครเป็นช่าง (1 transaction รวมทุกอย่าง):
//    1. INSERT worker_chaungthai (resume + tickets=25)
//    2. INSERT workerskill_chaungthai (skill_ids ที่เลือก) - ถ้ามี
//    3. UPDATE user_chaungthai SET user_role='worker'
//
//  Body:
//    {
//      "worker_resume": "ประวัติ ประสบการณ์..." (optional),
//      "skill_ids": [1, 11, 13]                (optional, max 50)
//    }
//
//  สมัครซ้ำ -> 409
// ============================================================
router.post('/', verifyToken, async (req, res) => {
  const userId = req.user.user_id;
  const body = req.body || {};

  // --- 1) parse + validate input ---
  const worker_resume =
    typeof body.worker_resume === 'string' && body.worker_resume.trim() !== ''
      ? body.worker_resume.trim()
      : null;

  let uniqueSkillIds = [];
  if (body.skill_ids !== undefined && body.skill_ids !== null) {
    if (!Array.isArray(body.skill_ids)) {
      return res.status(400).json({ error: 'skill_ids ต้องเป็น array' });
    }
    uniqueSkillIds = [...new Set(body.skill_ids.map((x) => Number(x)))];
    if (uniqueSkillIds.some((x) => !Number.isInteger(x) || x < 1)) {
      return res.status(400).json({ error: 'skill_ids ต้องเป็นจำนวนเต็มบวก' });
    }
    if (uniqueSkillIds.length > 50) {
      return res.status(400).json({ error: 'เลือกสกิลไม่เกิน 50 รายการ' });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // --- 2) เช็คซ้ำ ---
    const [existing] = await conn.execute(
      'SELECT worker_id FROM worker_chaungthai WHERE worker_user_id = ? LIMIT 1',
      [userId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        error: 'คุณเป็นช่างอยู่แล้ว',
        worker_id: existing[0].worker_id,
      });
    }

    // --- 3) validate skill_ids มีจริง + active ---
    if (uniqueSkillIds.length > 0) {
      const placeholders = uniqueSkillIds.map(() => '?').join(',');
      const [exists] = await conn.query(
        `SELECT skill_id FROM skill_chaungthai
          WHERE skill_id IN (${placeholders}) AND skill_is_active = 1`,
        uniqueSkillIds
      );
      if (exists.length !== uniqueSkillIds.length) {
        await conn.rollback();
        const foundIds = exists.map((r) => r.skill_id);
        const missingIds = uniqueSkillIds.filter((x) => !foundIds.includes(x));
        return res.status(400).json({
          error: 'มี skill_id บางตัวไม่มีในระบบหรือถูกปิดใช้',
          missing_skill_ids: missingIds,
        });
      }
    }

    // --- 4) INSERT worker_chaungthai (resume + tickets=25) ---
    const [result] = await conn.execute(
      `INSERT INTO worker_chaungthai
        (worker_user_id, worker_resume, worker_job_tickets)
       VALUES (?, ?, ?)`,
      [userId, worker_resume, DEFAULT_JOB_TICKETS]
    );
    const newWorkerId = result.insertId;

    // --- 5) INSERT workerskill_chaungthai (ถ้าส่ง skills มา) ---
    if (uniqueSkillIds.length > 0) {
      const values = uniqueSkillIds.map(() => '(?, ?)').join(', ');
      const params = [];
      for (const sid of uniqueSkillIds) {
        params.push(newWorkerId, sid);
      }
      await conn.query(
        `INSERT INTO workerskill_chaungthai
          (workerskill_worker_id, workerskill_skill_id) VALUES ${values}`,
        params
      );
    }

    // --- 6) UPDATE user_role = 'worker' ---
    await conn.execute(
      `UPDATE user_chaungthai SET user_role = 'worker' WHERE user_id = ?`,
      [userId]
    );

    await conn.commit();

    return res.status(201).json({
      message: 'สมัครเป็นช่างสำเร็จ',
      worker_id: newWorkerId,
      worker_user_id: userId,
      worker_resume,
      worker_job_tickets: DEFAULT_JOB_TICKETS,
      worker_total_jobs: 0,
      skill_count: uniqueSkillIds.length,
      skill_ids: uniqueSkillIds,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[workers][POST] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
});

// ============================================================
//  PUT /api/workers/:worker_id/skills
//  เลือก/แทนที่สกิลของช่าง (replace mode - ส่ง array มาทั้งชุด)
//  Body: { "skill_ids": [1, 5, 7] }
// ============================================================
router.put('/:worker_id/skills', verifyToken, async (req, res) => {
  const workerId = Number(req.params.worker_id);
  if (!Number.isInteger(workerId) || workerId < 1) {
    return res.status(400).json({ error: 'worker_id ไม่ถูกต้อง' });
  }

  const body = req.body || {};
  const skillIds = Array.isArray(body.skill_ids) ? body.skill_ids : null;
  if (!skillIds) {
    return res.status(400).json({ error: 'skill_ids ต้องเป็น array' });
  }

  // ตรวจว่าทุกค่าเป็น integer
  const uniqueIds = [...new Set(skillIds.map((x) => Number(x)))];
  if (uniqueIds.some((x) => !Number.isInteger(x) || x < 1)) {
    return res.status(400).json({ error: 'skill_ids ต้องเป็นจำนวนเต็มบวก' });
  }
  if (uniqueIds.length > 50) {
    return res.status(400).json({ error: 'เลือกสกิลไม่เกิน 50 รายการ' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. หา worker + เช็คเจ้าของ
    const [w] = await conn.execute(
      'SELECT worker_user_id FROM worker_chaungthai WHERE worker_id = ? LIMIT 1',
      [workerId]
    );
    if (w.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'ไม่พบช่างที่ระบุ' });
    }
    if (w[0].worker_user_id !== req.user.user_id) {
      await conn.rollback();
      return res.status(403).json({ error: 'ไม่อนุญาตให้แก้ไขข้อมูลของผู้อื่น' });
    }

    // 2. ตรวจว่า skill_ids มีจริงทั้งหมด
    if (uniqueIds.length > 0) {
      const placeholders = uniqueIds.map(() => '?').join(',');
      const [exists] = await conn.query(
        `SELECT skill_id FROM skill_chaungthai
          WHERE skill_id IN (${placeholders}) AND skill_is_active = 1`,
        uniqueIds
      );
      if (exists.length !== uniqueIds.length) {
        await conn.rollback();
        const foundIds = exists.map((r) => r.skill_id);
        const missingIds = uniqueIds.filter((x) => !foundIds.includes(x));
        return res.status(400).json({
          error: 'มี skill_id บางตัวไม่มีในระบบหรือถูกปิดใช้',
          missing_skill_ids: missingIds,
        });
      }
    }

    // 3. DELETE ของเก่า + INSERT ของใหม่ (replace mode)
    await conn.execute(
      'DELETE FROM workerskill_chaungthai WHERE workerskill_worker_id = ?',
      [workerId]
    );

    if (uniqueIds.length > 0) {
      const values = uniqueIds.map(() => '(?, ?)').join(', ');
      const params = [];
      for (const sid of uniqueIds) {
        params.push(workerId, sid);
      }
      await conn.query(
        `INSERT INTO workerskill_chaungthai
          (workerskill_worker_id, workerskill_skill_id) VALUES ${values}`,
        params
      );
    }

    await conn.commit();

    return res.json({
      message: 'อัปเดตสกิลของช่างสำเร็จ',
      worker_id: workerId,
      skill_count: uniqueIds.length,
      skill_ids: uniqueIds,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[workers][PUT skills] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
});

// ============================================================
//  GET /api/workers/search
//  ค้นหาช่างตามสกิล + พื้นที่
//  Query params:
//    skill_id        (required) - id ของสกิลที่ต้องการ
//    subdistrict_id  (optional) - หาในตำบลนั้น
//    district_id     (optional) - หาในอำเภอนั้น
//    province_id     (optional) - หาในจังหวัดนั้น
//    auto_expand     (optional) - 'true' = ถ้าไม่เจอในตำบล/อำเภอที่ส่ง
//                                  จะขยายไปขั้นถัดไปอัตโนมัติ
//    limit           (optional) - default 20, max 100
//
//  ลำดับความสำคัญ: subdistrict > district > province
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const q = req.query;

    // ----- required: skill_id -----
    const skillId = Number(q.skill_id);
    if (!Number.isInteger(skillId) || skillId < 1) {
      return res.status(400).json({ error: 'skill_id (required) ต้องเป็นจำนวนเต็มบวก' });
    }

    // ----- optional location ids -----
    const parsePosInt = (v) => {
      if (v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : 'INVALID';
    };
    const subId = parsePosInt(q.subdistrict_id);
    const disId = parsePosInt(q.district_id);
    const provId = parsePosInt(q.province_id);
    if (subId === 'INVALID' || disId === 'INVALID' || provId === 'INVALID') {
      return res.status(400).json({ error: 'location id ต้องเป็นจำนวนเต็มบวก' });
    }
    if (!subId && !disId && !provId) {
      return res.status(400).json({
        error: 'กรุณาระบุพื้นที่ค้นหาอย่างน้อย 1 ระดับ (subdistrict_id / district_id / province_id)',
      });
    }

    const autoExpand = String(q.auto_expand || '').toLowerCase() === 'true';
    let limit = Number(q.limit) || 20;
    if (!Number.isInteger(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    // ลำดับ scope ที่จะลอง (เล็ก -> ใหญ่)
    const scopes = [];
    if (subId) scopes.push({ level: 'subdistrict', field: 'u.user_subdistrict_id', val: subId });
    if (disId) scopes.push({ level: 'district', field: 'u.user_district_id', val: disId });
    if (provId) scopes.push({ level: 'province', field: 'u.user_province_id', val: provId });

    // หา scope ที่เล็กสุด ลอง search ก่อน
    // ถ้า auto_expand=true และไม่เจอใน scope เล็ก -> ขยาย
    const scopesToTry = autoExpand ? scopes : [scopes[0]];

    let results = [];
    let matchedLevel = null;
    for (const scope of scopesToTry) {
      const [rows] = await pool.execute(
        `SELECT
            w.worker_id,
            w.worker_user_id,
            w.worker_job_tickets,
            w.worker_total_jobs,
            w.worker_resume,
            u.user_id,
            u.user_name,
            u.user_lastname,
            u.user_image,
            u.user_phone,
            u.user_address,
            u.user_province_id,
            u.user_district_id,
            u.user_subdistrict_id,
            p.province_name_th,
            d.district_name_th,
            s.subdistrict_name_th,
            sk.skill_id,
            sk.skill_name_th
          FROM workerskill_chaungthai ws
          JOIN skill_chaungthai sk ON sk.skill_id = ws.workerskill_skill_id
          JOIN worker_chaungthai w ON w.worker_id = ws.workerskill_worker_id
          JOIN user_chaungthai u ON u.user_id = w.worker_user_id
          LEFT JOIN location_province_chaungthai p ON p.province_id = u.user_province_id
          LEFT JOIN location_district_chaungthai d ON d.district_id = u.user_district_id
          LEFT JOIN location_subdistrict_chaungthai s ON s.subdistrict_id = u.user_subdistrict_id
          WHERE ws.workerskill_skill_id = ?
            AND u.user_status = 'Active'
            AND ${scope.field} = ?
          ORDER BY w.worker_total_jobs DESC, w.worker_id ASC
          LIMIT ${limit}`,
        [skillId, scope.val]
      );

      if (rows.length > 0) {
        results = rows;
        matchedLevel = scope.level;
        break;
      }
    }

    return res.json({
      skill_id: skillId,
      query: { subdistrict_id: subId, district_id: disId, province_id: provId },
      auto_expand: autoExpand,
      matched_level: matchedLevel,  // null = ไม่เจอเลย
      total: results.length,
      workers: results,
    });
  } catch (err) {
    console.error('[workers/search] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
