// ============================================================
//  Jobs Routes
//  Mounted at: /api/jobs
//  ทุก endpoint ต้อง login
//
//  POST   /api/jobs                  - ผู้จ้างสร้างงาน
//  GET    /api/jobs                  - งานของฉัน (?role=employer|worker&status=...)
//  GET    /api/jobs/unread-count     - จำนวนงาน pending (สำหรับ badge ฝั่งช่าง)
//  GET    /api/jobs/:id              - รายละเอียดงาน
//  PATCH  /api/jobs/:id/status       - เปลี่ยน status (server enforce transition + role)
//
//  State machine:
//    pending → not_started → in_progress → completed
//                ↘ cancelled  ↘ cancelled
//           ↘ declined
//           ↘ cancelled
// ============================================================

const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');
const { getIO } = require('../socket');

const router = express.Router();
router.use(verifyToken);

// ------------------------------------------------------------
//  Transition rules — เปลี่ยน status ได้ก็ต่อเมื่อตรงเงื่อนไข
//
//  key   = current status
//  value = { <new_status>: ['employer'|'worker', ...] }
// ------------------------------------------------------------
const TRANSITIONS = {
  pending: {
    not_started: ['worker'],   // ช่างกดรับ → หักบัตร
    declined:    ['worker'],   // ช่างปฏิเสธ
    cancelled:   ['employer', 'worker'],
  },
  not_started: {
    in_progress: ['worker'],
    cancelled:   ['employer', 'worker'],
  },
  in_progress: {
    completed:   ['worker'],
    cancelled:   ['employer', 'worker'],
  },
  completed: {},  // terminal
  declined: {},
  cancelled: {},
};

// ------------------------------------------------------------
//  Helper: insert system message ในห้องแชต (สำหรับ event ของงาน)
//  ไม่ใช้ transaction รวม — ถ้า fail แค่ log (ไม่ block flow หลัก)
// ------------------------------------------------------------
async function postSystemMessage(convId, payload) {
  if (!convId) return null;
  try {
    const content = JSON.stringify(payload);
    const [c] = await pool.execute(
      'SELECT conv_user1_id, conv_user2_id FROM conversation_chaungthai WHERE conv_id = ? LIMIT 1',
      [convId]
    );
    if (c.length === 0) return null;

    // ใช้ employer เป็น sender (เจ้าของ event) — หรือใช้ user ที่ trigger
    const senderId = payload.actor_user_id || c[0].conv_user1_id;

    const [ins] = await pool.execute(
      `INSERT INTO message_chaungthai (msg_conv_id, msg_sender_id, msg_content, msg_type)
       VALUES (?, ?, ?, 'system')`,
      [convId, senderId, content]
    );
    const msgId = ins.insertId;

    await pool.execute(
      `UPDATE conversation_chaungthai
          SET conv_last_message_id = ?, conv_last_message_at = CURRENT_TIMESTAMP
        WHERE conv_id = ?`,
      [msgId, convId]
    );

    const [m] = await pool.execute(
      `SELECT msg_id, msg_conv_id, msg_sender_id, msg_content, msg_type, msg_read_at, msg_created_at
         FROM message_chaungthai WHERE msg_id = ?`,
      [msgId]
    );
    const message = m[0];

    // broadcast ทั้ง 2 ฝั่ง
    try {
      const io = getIO();
      io.to(`user:${c[0].conv_user1_id}`).emit('chat:message', message);
      io.to(`user:${c[0].conv_user2_id}`).emit('chat:message', message);
    } catch {}

    return message;
  } catch (err) {
    console.error('[postSystemMessage] error:', err.message);
    return null;
  }
}

// ============================================================
//  POST /api/jobs
//  Body: { worker_user_id, detail, price, start_date, deadline, conv_id? }
// ============================================================
router.post('/', async (req, res) => {
  try {
    const me = req.user.user_id;
    const {
      worker_user_id,
      detail,
      price,
      start_date,
      deadline,
      conv_id,
    } = req.body || {};

    // -------- validation --------
    const workerUserId = Number(worker_user_id);
    if (!Number.isInteger(workerUserId) || workerUserId < 1) {
      return res.status(400).json({ error: 'worker_user_id ไม่ถูกต้อง' });
    }
    if (workerUserId === me) {
      return res.status(400).json({ error: 'จ้างตัวเองไม่ได้' });
    }
    if (!detail || typeof detail !== 'string' || !detail.trim()) {
      return res.status(400).json({ error: 'กรุณาใส่รายละเอียดงาน' });
    }
    const detailTrim = detail.trim();
    if (detailTrim.length > 5000) {
      return res.status(400).json({ error: 'รายละเอียดงานยาวเกิน 5000 ตัวอักษร' });
    }
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > 99_999_999.99) {
      return res.status(400).json({ error: 'ราคาไม่ถูกต้อง' });
    }
    if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return res.status(400).json({ error: 'วันที่เริ่มงานไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)' });
    }
    if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      return res.status(400).json({ error: 'วันที่ต้องเสร็จไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)' });
    }
    if (deadline < start_date) {
      return res.status(400).json({ error: 'วันที่ต้องเสร็จต้องไม่เร็วกว่าวันที่เริ่ม' });
    }

    // -------- ตรวจช่างมีอยู่ + active + เป็นช่างจริง --------
    const [wRows] = await pool.execute(
      `SELECT u.user_id, u.user_name, u.user_lastname, u.user_status,
              w.worker_id
         FROM user_chaungthai u
         LEFT JOIN worker_chaungthai w ON w.worker_user_id = u.user_id
        WHERE u.user_id = ? LIMIT 1`,
      [workerUserId]
    );
    if (wRows.length === 0 || wRows[0].user_status !== 'Active') {
      return res.status(404).json({ error: 'ไม่พบช่างหรือบัญชีไม่พร้อมใช้งาน' });
    }
    if (!wRows[0].worker_id) {
      return res.status(400).json({ error: 'ผู้ใช้นี้ยังไม่ได้สมัครเป็นช่าง' });
    }

    // -------- ตรวจ conv_id (ถ้ามี) ว่า me อยู่ในห้อง --------
    let convIdParam = null;
    if (conv_id !== undefined && conv_id !== null) {
      const cid = Number(conv_id);
      if (!Number.isInteger(cid) || cid < 1) {
        return res.status(400).json({ error: 'conv_id ไม่ถูกต้อง' });
      }
      const [c] = await pool.execute(
        'SELECT conv_user1_id, conv_user2_id FROM conversation_chaungthai WHERE conv_id = ? LIMIT 1',
        [cid]
      );
      if (c.length === 0) {
        return res.status(404).json({ error: 'ไม่พบห้องแชต' });
      }
      const isMember = c[0].conv_user1_id === me || c[0].conv_user2_id === me;
      if (!isMember) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงห้องแชตนี้' });
      }
      convIdParam = cid;
    }

    // -------- insert --------
    const [ins] = await pool.execute(
      `INSERT INTO job_chaungthai
        (job_employer_id, job_worker_id, job_conv_id,
         job_detail, job_price, job_start_date, job_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [me, workerUserId, convIdParam, detailTrim, priceNum, start_date, deadline]
    );
    const jobId = ins.insertId;

    // โหลด job + employer info เพื่อตอบกลับ
    const [job] = await pool.execute(
      `SELECT j.*,
              eu.user_name AS employer_name, eu.user_lastname AS employer_lastname,
              wu.user_name AS worker_name, wu.user_lastname AS worker_lastname
         FROM job_chaungthai j
         JOIN user_chaungthai eu ON eu.user_id = j.job_employer_id
         JOIN user_chaungthai wu ON wu.user_id = j.job_worker_id
        WHERE j.job_id = ?`,
      [jobId]
    );

    // -------- system message ในห้องแชต (ถ้ามี) --------
    if (convIdParam) {
      await postSystemMessage(convIdParam, {
        type: 'job_created',
        job_id: jobId,
        actor_user_id: me,
        employer_name: job[0].employer_name,
        price: priceNum,
        detail: detailTrim.length > 80 ? detailTrim.slice(0, 80) + '...' : detailTrim,
        start_date,
        deadline,
      });
    }

    // -------- notify ฝั่งช่างผ่าน socket (event แยกสำหรับ jobs badge) --------
    try {
      getIO().to(`user:${workerUserId}`).emit('job:new', { job_id: jobId });
    } catch {}

    return res.status(201).json({ job: job[0] });
  } catch (err) {
    console.error('[jobs][POST] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  GET /api/jobs?role=employer|worker&status=...
// ============================================================
router.get('/', async (req, res) => {
  try {
    const me = req.user.user_id;
    const role = req.query.role === 'employer' ? 'employer'
               : req.query.role === 'worker'   ? 'worker'
               : null;
    const status = req.query.status || null;

    const where = [];
    const params = [];

    if (role === 'employer') {
      where.push('j.job_employer_id = ?'); params.push(me);
    } else if (role === 'worker') {
      where.push('j.job_worker_id = ?'); params.push(me);
    } else {
      where.push('(j.job_employer_id = ? OR j.job_worker_id = ?)');
      params.push(me, me);
    }

    if (status) {
      const VALID = ['pending','not_started','in_progress','completed','declined','cancelled'];
      const list = String(status).split(',').filter((s) => VALID.includes(s));
      if (list.length > 0) {
        where.push(`j.job_status IN (${list.map(() => '?').join(',')})`);
        params.push(...list);
      }
    }

    const [rows] = await pool.execute(
      `SELECT
          j.job_id, j.job_employer_id, j.job_worker_id, j.job_conv_id,
          j.job_detail, j.job_price, j.job_start_date, j.job_deadline,
          j.job_status, j.job_responded_at, j.job_started_at, j.job_completed_at,
          j.job_cancelled_at, j.job_cancelled_by, j.job_created_at, j.job_updated_at,
          eu.user_name AS employer_name, eu.user_lastname AS employer_lastname,
          eu.user_image AS employer_image,
          wu.user_name AS worker_name, wu.user_lastname AS worker_lastname,
          wu.user_image AS worker_image
         FROM job_chaungthai j
         JOIN user_chaungthai eu ON eu.user_id = j.job_employer_id
         JOIN user_chaungthai wu ON wu.user_id = j.job_worker_id
        WHERE ${where.join(' AND ')}
        ORDER BY j.job_created_at DESC
        LIMIT 100`,
      params
    );

    return res.json({ jobs: rows });
  } catch (err) {
    console.error('[jobs][GET] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  GET /api/jobs/unread-count
//  จำนวนงาน pending ของฉัน (ในฐานะช่าง) — ใช้ทำ badge
// ============================================================
router.get('/unread-count', async (req, res) => {
  try {
    const me = req.user.user_id;
    const [r] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM job_chaungthai
        WHERE job_worker_id = ? AND job_status = 'pending'`,
      [me]
    );
    return res.json({ unread_count: Number(r[0].cnt) });
  } catch (err) {
    console.error('[jobs][unread-count] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  GET /api/jobs/:id
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const me = req.user.user_id;
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId) || jobId < 1) {
      return res.status(400).json({ error: 'job_id ไม่ถูกต้อง' });
    }
    const [rows] = await pool.execute(
      `SELECT j.*,
              eu.user_name AS employer_name, eu.user_lastname AS employer_lastname,
              eu.user_image AS employer_image,
              wu.user_name AS worker_name, wu.user_lastname AS worker_lastname,
              wu.user_image AS worker_image,
              w.worker_id AS worker_worker_id, w.worker_job_tickets
         FROM job_chaungthai j
         JOIN user_chaungthai eu ON eu.user_id = j.job_employer_id
         JOIN user_chaungthai wu ON wu.user_id = j.job_worker_id
         LEFT JOIN worker_chaungthai w ON w.worker_user_id = j.job_worker_id
        WHERE j.job_id = ?
        LIMIT 1`,
      [jobId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบงาน' });
    }
    const job = rows[0];
    if (job.job_employer_id !== me && job.job_worker_id !== me) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูงานนี้' });
    }
    return res.json({ job });
  } catch (err) {
    console.error('[jobs][GET :id] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  PATCH /api/jobs/:id/status
//  Body: { status: 'not_started' | 'in_progress' | 'completed' | 'declined' | 'cancelled' }
// ============================================================
router.patch('/:id/status', async (req, res) => {
  const me = req.user.user_id;
  const jobId = Number(req.params.id);
  if (!Number.isInteger(jobId) || jobId < 1) {
    return res.status(400).json({ error: 'job_id ไม่ถูกต้อง' });
  }
  const newStatus = req.body && req.body.status;
  const VALID_TARGETS = ['not_started','in_progress','completed','declined','cancelled'];
  if (!VALID_TARGETS.includes(newStatus)) {
    return res.status(400).json({ error: 'status ไม่ถูกต้อง' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      `SELECT job_id, job_employer_id, job_worker_id, job_conv_id, job_status, job_detail, job_price
         FROM job_chaungthai WHERE job_id = ? FOR UPDATE`,
      [jobId]
    );
    if (rows.length === 0) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ error: 'ไม่พบงาน' });
    }
    const job = rows[0];

    // ตรวจ role ของ me
    let myRole = null;
    if (job.job_employer_id === me) myRole = 'employer';
    else if (job.job_worker_id === me) myRole = 'worker';
    else {
      await conn.rollback(); conn.release();
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เปลี่ยน status งานนี้' });
    }

    // ตรวจ transition
    const allowed = TRANSITIONS[job.job_status] || {};
    const allowedRoles = allowed[newStatus];
    if (!allowedRoles) {
      await conn.rollback(); conn.release();
      return res.status(400).json({
        error: `ไม่สามารถเปลี่ยนจาก ${job.job_status} เป็น ${newStatus} ได้`,
      });
    }
    if (!allowedRoles.includes(myRole)) {
      await conn.rollback(); conn.release();
      return res.status(403).json({
        error: `${myRole === 'worker' ? 'ช่าง' : 'ผู้จ้าง'}ไม่สามารถเปลี่ยนสถานะนี้ได้`,
      });
    }

    // SET ที่จะใช้ update
    const sets = ['job_status = ?'];
    const params = [newStatus];
    const now = new Date();

    if (newStatus === 'not_started') {
      // ช่างกดรับ — หักบัตร 1 ใบ (ในเงื่อนไข tickets > 0)
      const [t] = await conn.execute(
        `UPDATE worker_chaungthai
            SET worker_job_tickets = worker_job_tickets - 1
          WHERE worker_user_id = ? AND worker_job_tickets > 0`,
        [me]
      );
      if (t.affectedRows === 0) {
        await conn.rollback(); conn.release();
        return res.status(400).json({
          error: 'บัตรรับงานหมด — ไม่สามารถรับงานเพิ่มได้',
        });
      }
      sets.push('job_responded_at = ?'); params.push(now);
    } else if (newStatus === 'in_progress') {
      sets.push('job_started_at = ?'); params.push(now);
    } else if (newStatus === 'completed') {
      sets.push('job_completed_at = ?'); params.push(now);
    } else if (newStatus === 'declined') {
      sets.push('job_responded_at = ?'); params.push(now);
      sets.push('job_cancelled_at = ?'); params.push(now);
      sets.push('job_cancelled_by = ?'); params.push(me);
    } else if (newStatus === 'cancelled') {
      sets.push('job_cancelled_at = ?'); params.push(now);
      sets.push('job_cancelled_by = ?'); params.push(me);
    }

    params.push(jobId);
    await conn.execute(
      `UPDATE job_chaungthai SET ${sets.join(', ')} WHERE job_id = ?`,
      params
    );

    await conn.commit();
    conn.release();

    // โหลด job ใหม่
    const [updated] = await pool.execute(
      `SELECT j.*,
              eu.user_name AS employer_name, eu.user_lastname AS employer_lastname,
              wu.user_name AS worker_name, wu.user_lastname AS worker_lastname
         FROM job_chaungthai j
         JOIN user_chaungthai eu ON eu.user_id = j.job_employer_id
         JOIN user_chaungthai wu ON wu.user_id = j.job_worker_id
        WHERE j.job_id = ?`,
      [jobId]
    );

    // system message ในห้องแชต (ถ้ามี)
    if (job.job_conv_id) {
      const STATUS_LABEL = {
        not_started: 'ช่างรับงานแล้ว',
        in_progress: 'ช่างเริ่มดำเนินงาน',
        completed: 'ช่างทำงานเสร็จแล้ว',
        declined: 'ช่างปฏิเสธงาน',
        cancelled: (myRole === 'employer' ? 'ผู้จ้างยกเลิกงาน' : 'ช่างยกเลิกงาน'),
      };
      await postSystemMessage(job.job_conv_id, {
        type: 'job_status_changed',
        job_id: jobId,
        actor_user_id: me,
        new_status: newStatus,
        label: STATUS_LABEL[newStatus],
      });
    }

    // notify อีกฝ่ายผ่าน socket
    const otherUserId = myRole === 'employer' ? job.job_worker_id : job.job_employer_id;
    try {
      getIO().to(`user:${otherUserId}`).emit('job:updated', { job_id: jobId, status: newStatus });
    } catch {}

    return res.json({ job: updated[0] });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    conn.release();
    console.error('[jobs][PATCH status] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

module.exports = router;
