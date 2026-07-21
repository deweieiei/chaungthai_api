// ============================================================
//  Auth Routes (register, login, ...)
//  Mounted at: /api/auth
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// helper: เปิด mock tokens (verify_url, otp_code, reset_token) ใน response ไหม
// - default: เปิดถ้า NODE_ENV ไม่ใช่ production
// - override ด้วย env EXPOSE_MOCK_TOKENS=true (สำหรับ MVP ที่ยังไม่ได้ต่อ email/SMS gateway)
const exposeMockTokens = () =>
  String(process.env.EXPOSE_MOCK_TOKENS).toLowerCase() === 'true' ||
  process.env.NODE_ENV !== 'production';

const isDev = exposeMockTokens; // alias สำหรับโค้ดเดิม

// helper: random 6 digit OTP
function generate6DigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// regex ง่ายๆ เช็ค format อีเมล (ไม่ต้องเป๊ะ - DB จะ unique ให้อีกชั้น)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------
//  ประเภทบัญชี — ช่างกับผู้ว่าจ้างเป็นคนละบัญชีกันสมบูรณ์
//  อีเมลเดียวกันมีได้ทั้ง 2 ฝั่ง (DB unique = email + account_type)
// ------------------------------------------------------------
const ACCOUNT_TYPES = ['employer', 'worker'];
const TYPE_LABEL = { employer: 'ผู้ว่าจ้าง', worker: 'ช่าง' };

/** อ่านประเภทบัญชีจาก body/query — ไม่ส่งมา = employer */
function parseAccountType(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    return required ? 'MISSING' : 'employer';
  }
  const v = String(raw).trim().toLowerCase();
  return ACCOUNT_TYPES.includes(v) ? v : 'INVALID';
}

/** field ที่ก็อปข้ามฝั่งตอนสร้างบัญชีคู่ (ก็อปครั้งเดียว หลังจากนั้นต่างคนต่างแก้) */
const COPYABLE_PROFILE_FIELDS = [
  'user_name', 'user_lastname', 'user_password', 'user_phone',
  'user_image', 'user_birthday', 'user_bio', 'user_address',
  'user_lat', 'user_lng',
];

// ============================================================
//  POST /api/auth/register
//  สมัครสมาชิก
//  Body: user_name, user_lastname, user_email, user_password
//        + user_account_type: 'employer' (default) | 'worker'
//
//  อีเมลเดียวกันสมัครได้ทั้ง 2 ฝั่ง — ซ้ำเฉพาะเมื่อฝั่งเดียวกันเท่านั้น
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const {
      user_name,
      user_lastname,
      user_email,
      user_password,
    } = req.body || {};

    const accountType = parseAccountType((req.body || {}).user_account_type);
    if (accountType === 'INVALID') {
      return res.status(400).json({ error: 'user_account_type ต้องเป็น employer หรือ worker' });
    }

    // ----- 1. ตรวจ required fields -----
    if (!user_name || !user_email || !user_password) {
      return res.status(400).json({
        error: 'กรุณากรอก ชื่อ (user_name), อีเมล (user_email), รหัสผ่าน (user_password) ให้ครบ',
      });
    }

    // ----- 2. ตรวจชนิด/รูปแบบ -----
    if (typeof user_name !== 'string' || user_name.trim().length === 0) {
      return res.status(400).json({ error: 'user_name ไม่ถูกต้อง' });
    }
    if (typeof user_email !== 'string' || !EMAIL_REGEX.test(user_email)) {
      return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
    if (typeof user_password !== 'string' || user_password.length < 8) {
      return res.status(400).json({
        error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
      });
    }
    if (user_name.length > 100) {
      return res.status(400).json({ error: 'ชื่อยาวเกิน 100 ตัวอักษร' });
    }
    if (user_lastname && (typeof user_lastname !== 'string' || user_lastname.length > 100)) {
      return res.status(400).json({ error: 'นามสกุลไม่ถูกต้อง' });
    }
    if (user_email.length > 255) {
      return res.status(400).json({ error: 'อีเมลยาวเกิน 255 ตัวอักษร' });
    }

    // ----- 3. เช็คอีเมลซ้ำ "เฉพาะฝั่งเดียวกัน" -----
    const emailNorm = user_email.trim().toLowerCase();
    const [existing] = await pool.execute(
      `SELECT user_id, user_account_type FROM user_chaungthai
        WHERE user_email = ? AND user_account_type = ? LIMIT 1`,
      [emailNorm, accountType]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        error: `อีเมลนี้มีบัญชี${TYPE_LABEL[accountType]}อยู่แล้ว`,
        user_account_type: accountType,
      });
    }

    // ----- 4. Hash password ด้วย bcrypt -----
    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(user_password, rounds);

    // ----- 5. บันทึก DB -----
    const [result] = await pool.execute(
      `INSERT INTO user_chaungthai
        (user_name, user_lastname, user_email, user_password, user_account_type)
       VALUES (?, ?, ?, ?, ?)`,
      [
        user_name.trim(),
        user_lastname ? user_lastname.trim() : null,
        emailNorm,
        passwordHash,
        accountType,
      ]
    );

    // ----- 6. ตอบกลับ (ไม่ส่ง password กลับ!) -----
    return res.status(201).json({
      message: `สมัครบัญชี${TYPE_LABEL[accountType]}สำเร็จ`,
      user_id: result.insertId,
      user_name: user_name.trim(),
      user_email: emailNorm,
      user_account_type: accountType,
    });

  } catch (err) {
    // จัดการ error ที่หลุดมา (เช่น DB ล่ม, duplicate race condition)
    console.error('[register] error:', err);

    // กรณี race condition (เช็คอีเมลผ่าน แต่ INSERT แล้ว unique key ชน)
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'อีเมลนี้มีบัญชีฝั่งนี้อยู่แล้ว' });
    }

    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  POST /api/auth/login
//  รับ user_email + user_password + user_account_type -> ออก JWT token
//
//  ต้องระบุฝั่งเสมอ เพราะอีเมลเดียวกันมีได้ 2 บัญชี (ช่าง / ผู้ว่าจ้าง)
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { user_email, user_password } = req.body || {};

    // ----- 1. ตรวจ required fields -----
    if (!user_email || !user_password) {
      return res.status(400).json({
        error: 'กรุณากรอกอีเมลและรหัสผ่าน',
      });
    }
    if (typeof user_email !== 'string' || typeof user_password !== 'string') {
      return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
    }

    // ไม่ระบุฝั่งมา = ถือว่าเป็นผู้ว่าจ้าง (client เก่ายังใช้ได้)
    const accountType = parseAccountType((req.body || {}).user_account_type);
    if (accountType === 'INVALID') {
      return res.status(400).json({ error: 'user_account_type ต้องเป็น employer หรือ worker' });
    }

    // ----- 2. ค้นหา user จาก email + ฝั่ง -----
    const emailNorm = user_email.trim().toLowerCase();
    const [rows] = await pool.execute(
      `SELECT user_id, user_email, user_password, user_name, user_lastname,
              user_role, user_account_type, user_status, user_image
         FROM user_chaungthai
        WHERE user_email = ? AND user_account_type = ?
        LIMIT 1`,
      [emailNorm, accountType]
    );

    // ใช้ error message เดียวกันสำหรับ "email ไม่พบ" และ "password ผิด"
    // เพื่อไม่ให้ผู้ไม่ประสงค์ดี เดาว่ามี email นี้ในระบบหรือไม่
    const INVALID = { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };

    if (rows.length === 0) {
      // ช่วยคนที่กดผิดฝั่ง — บอกได้เฉพาะเมื่อรหัสผ่านฝั่งตรงข้ามถูกต้องจริง
      // (ไม่งั้นจะกลายเป็นช่องให้เดาว่าอีเมลไหนมีในระบบ)
      const other = accountType === 'worker' ? 'employer' : 'worker';
      const [otherRows] = await pool.execute(
        `SELECT user_password FROM user_chaungthai
          WHERE user_email = ? AND user_account_type = ? LIMIT 1`,
        [emailNorm, other]
      );
      if (otherRows.length > 0 && otherRows[0].user_password) {
        const otherMatch = await bcrypt.compare(user_password, otherRows[0].user_password);
        if (otherMatch) {
          return res.status(401).json({
            error: `อีเมลนี้เป็นบัญชี${TYPE_LABEL[other]} ไม่ใช่บัญชี${TYPE_LABEL[accountType]} — กดปุ่ม "${TYPE_LABEL[other]}" แล้วลองใหม่`,
            wrong_side: true,
            correct_account_type: other,
          });
        }
      }
      return res.status(401).json(INVALID);
    }

    const user = rows[0];

    // ----- 3. user ยังไม่ได้ตั้งรหัสผ่าน (เช่น social login ในอนาคต) -----
    if (!user.user_password) {
      return res.status(401).json(INVALID);
    }

    // ----- 4. เทียบรหัสผ่านด้วย bcrypt -----
    const match = await bcrypt.compare(user_password, user.user_password);
    if (!match) {
      return res.status(401).json(INVALID);
    }

    // ----- 5. ตรวจสถานะบัญชี -----
    if (user.user_status !== 'Active') {
      return res.status(403).json({
        error: `บัญชี ${user.user_status} ใช้งานไม่ได้`,
      });
    }

    // ----- 6. อัปเดตเวลา login ล่าสุด (ไม่ block flow ถ้า fail) -----
    pool.execute(
      'UPDATE user_chaungthai SET user_last_login_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [user.user_id]
    ).catch((e) => console.error('[login] update last_login_at fail:', e.message));

    // ----- 7. สร้าง JWT token -----
    if (!process.env.JWT_SECRET) {
      console.error('[login] JWT_SECRET not set in .env');
      return res.status(500).json({ error: 'Server config error: JWT_SECRET missing' });
    }
    const token = jwt.sign(
      {
        user_id: user.user_id,
        user_email: user.user_email,
        user_role: user.user_role,
        user_account_type: user.user_account_type,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // ----- 8. ตอบกลับ -----
    return res.json({
      message: `เข้าสู่ระบบฝั่ง${TYPE_LABEL[user.user_account_type]}สำเร็จ`,
      token,
      expires_in: process.env.JWT_EXPIRES_IN || '7d',
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        user_lastname: user.user_lastname,
        user_email: user.user_email,
        user_role: user.user_role,
        user_account_type: user.user_account_type,
        user_image: user.user_image,
      },
    });

  } catch (err) {
    console.error('[login] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  POST /api/auth/create-counterpart   (ต้องล็อกอิน)
//  สร้าง "บัญชีอีกฝั่ง" ด้วยอีเมลเดียวกัน โดยไม่ต้องกรอกข้อมูลซ้ำ
//
//  อยู่ในบัญชีผู้ว่าจ้าง → สร้างบัญชีช่าง (และกลับกัน)
//  ก็อป ชื่อ/นามสกุล/เบอร์/รูป/วันเกิด/bio/ที่อยู่/พิกัด + รหัสผ่านเดิม มาให้ครั้งเดียว
//  หลังจากนั้น 2 บัญชีแยกกันสมบูรณ์ — แก้ที่ไหนไม่กระทบอีกฝั่ง
//
//  ตอบกลับพร้อม token ของบัญชีใหม่ → frontend สลับเข้าใช้ได้ทันที
// ============================================================
router.post('/create-counterpart', verifyToken, async (req, res) => {
  try {
    const me = req.user.user_id;

    const [rows] = await pool.execute(
      `SELECT user_id, user_email, user_account_type, user_status,
              ${COPYABLE_PROFILE_FIELDS.join(', ')}
         FROM user_chaungthai WHERE user_id = ? LIMIT 1`,
      [me]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบบัญชีของคุณ' });
    }
    const src = rows[0];
    if (src.user_status !== 'Active') {
      return res.status(403).json({ error: 'บัญชีนี้ใช้งานไม่ได้' });
    }

    const target = src.user_account_type === 'worker' ? 'employer' : 'worker';

    // มีอยู่แล้ว → ไม่สร้างซ้ำ บอกให้ไปล็อกอินฝั่งนั้นแทน
    const [dup] = await pool.execute(
      `SELECT user_id FROM user_chaungthai
        WHERE user_email = ? AND user_account_type = ? LIMIT 1`,
      [src.user_email, target]
    );
    if (dup.length > 0) {
      return res.status(409).json({
        error: `คุณมีบัญชี${TYPE_LABEL[target]}ด้วยอีเมลนี้อยู่แล้ว — เข้าสู่ระบบฝั่ง${TYPE_LABEL[target]}ได้เลย`,
        user_account_type: target,
        existing_user_id: dup[0].user_id,
      });
    }

    const cols = ['user_email', 'user_account_type', ...COPYABLE_PROFILE_FIELDS];
    const params = [src.user_email, target, ...COPYABLE_PROFILE_FIELDS.map((f) => src[f] ?? null)];

    const [ins] = await pool.execute(
      `INSERT INTO user_chaungthai (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      params
    );
    const newUserId = ins.insertId;

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'Server config error: JWT_SECRET missing' });
    }
    const token = jwt.sign(
      {
        user_id: newUserId,
        user_email: src.user_email,
        user_role: 'user',
        user_account_type: target,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.status(201).json({
      message: `สร้างบัญชี${TYPE_LABEL[target]}ด้วยอีเมลเดิมแล้ว — รหัสผ่านเดียวกับบัญชีเดิม`,
      token,
      expires_in: process.env.JWT_EXPIRES_IN || '7d',
      user: {
        user_id: newUserId,
        user_name: src.user_name,
        user_lastname: src.user_lastname,
        user_email: src.user_email,
        user_role: 'user',
        user_account_type: target,
        user_image: src.user_image,
      },
    });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'มีบัญชีฝั่งนั้นอยู่แล้ว' });
    }
    console.error('[create-counterpart] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  Email Verification
// ============================================================
//
//  POST /api/auth/verify-email/request   (auth required)
//    -> สร้าง JWT ประเภท email_verify (exp 24h)
//    -> Mock: return verify_url ใน response
//       (production จะส่ง email ตาม flow จริง)
//
//  POST /api/auth/verify-email/confirm   (public)
//    -> รับ token -> verify -> update user_email_verified_at = NOW()
// ------------------------------------------------------------

// ============================================================
//  POST /api/auth/verify-email/request
//  - gen OTP 6 หลัก เก็บใน email_otp_chaungthai (exp 5 นาที)
//  - rate-limit: ขอใหม่ได้ทุก 60 วินาที
//  - mock (dev): return otp_code ใน response
//  - production: ส่งทาง SMTP (TODO เมื่อสมัคร SMTP provider)
// ============================================================
router.post('/verify-email/request', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const [rows] = await pool.execute(
      'SELECT user_email, user_email_verified_at FROM user_chaungthai WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (rows[0].user_email_verified_at) {
      return res.status(409).json({ error: 'ยืนยันอีเมลแล้ว' });
    }
    if (!rows[0].user_email) {
      return res.status(400).json({ error: 'ไม่มีอีเมลในระบบ' });
    }

    // rate-limit: ห้ามขอใหม่เกิน 1 ครั้งใน 60 วินาที
    const [recent] = await pool.execute(
      `SELECT otp_id FROM email_otp_chaungthai
        WHERE otp_user_id = ?
          AND otp_created_at > NOW() - INTERVAL 60 SECOND
        ORDER BY otp_id DESC LIMIT 1`,
      [userId]
    );
    if (recent.length > 0) {
      return res.status(429).json({ error: 'ขอ OTP ได้อีกครั้งใน 60 วินาที' });
    }

    const otp = generate6DigitOtp();
    await pool.execute(
      `INSERT INTO email_otp_chaungthai
         (otp_user_id, otp_email, otp_code, otp_expires_at)
       VALUES (?, ?, ?, NOW() + INTERVAL 5 MINUTE)`,
      [userId, rows[0].user_email, otp]
    );

    // TODO: ส่ง email จริง — เมื่อสมัคร SMTP provider แล้ว
    // const emailService = require('../services/email');
    // await emailService.sendOtp(rows[0].user_email, otp);

    const response = {
      message: 'ส่งรหัส OTP ไปยังอีเมลแล้ว (mock - dev)',
      expires_in_seconds: 300,
    };
    if (isDev()) {
      response.otp_code = otp;
      response.note = 'mock: ใน production จะส่งทางอีเมลแทน (ยังไม่ตั้ง SMTP)';
    }
    return res.json(response);
  } catch (err) {
    console.error('[verify-email/request] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  POST /api/auth/verify-email/confirm
//  Body: { otp_code }
//  - match OTP ของ user + ยังไม่ใช้ + ยังไม่หมดอายุ
//  - lock for update + mark used + set user_email_verified_at
// ============================================================
router.post('/verify-email/confirm', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { otp_code } = req.body || {};
    if (!otp_code || !/^\d{6}$/.test(String(otp_code))) {
      return res.status(400).json({ error: 'otp_code ต้องเป็นตัวเลข 6 หลัก' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.execute(
        `SELECT otp_id, otp_email FROM email_otp_chaungthai
           WHERE otp_user_id = ?
             AND otp_code = ?
             AND otp_used_at IS NULL
             AND otp_expires_at > NOW()
           ORDER BY otp_id DESC LIMIT 1
           FOR UPDATE`,
        [userId, String(otp_code)]
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
      }

      // ตรวจว่า email ยังตรงกับตอนขอ OTP
      const [user] = await conn.execute(
        'SELECT user_email FROM user_chaungthai WHERE user_id = ?',
        [userId]
      );
      if (user.length === 0 || user[0].user_email !== rows[0].otp_email) {
        await conn.rollback();
        return res.status(400).json({ error: 'อีเมลเปลี่ยนไปแล้ว กรุณาขอ OTP ใหม่' });
      }

      await conn.execute(
        'UPDATE email_otp_chaungthai SET otp_used_at = CURRENT_TIMESTAMP WHERE otp_id = ?',
        [rows[0].otp_id]
      );
      await conn.execute(
        'UPDATE user_chaungthai SET user_email_verified_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [userId]
      );

      await conn.commit();
      return res.json({ message: 'ยืนยันอีเมลสำเร็จ', user_id: userId });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[verify-email/confirm] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  Phone OTP Verification
// ============================================================
//
//  POST /api/auth/verify-phone/request   (auth required)
//    -> ต้องมี user_phone ใน user_chaungthai แล้ว
//    -> generate 6-digit OTP เก็บใน phone_otp_chaungthai (exp 5 min)
//    -> Mock: return otp_code ใน response (dev)
//       (production จะส่ง SMS)
//    -> rate-limit: ขอใหม่ได้ทุก 60 วินาที
//
//  POST /api/auth/verify-phone/confirm   (auth required)
//    -> รับ otp_code -> match unused + not expired -> update verified_at
// ------------------------------------------------------------

router.post('/verify-phone/request', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const [rows] = await pool.execute(
      'SELECT user_phone, user_phone_verified_at FROM user_chaungthai WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (!rows[0].user_phone) {
      return res.status(400).json({ error: 'กรุณาตั้งเบอร์โทรในโปรไฟล์ก่อน' });
    }
    if (rows[0].user_phone_verified_at) {
      return res.status(409).json({ error: 'ยืนยันเบอร์โทรแล้ว' });
    }

    // rate-limit: ห้ามขอใหม่เกิน 1 ครั้งใน 60 วินาที
    const [recent] = await pool.execute(
      `SELECT otp_id FROM phone_otp_chaungthai
        WHERE otp_user_id = ?
          AND otp_created_at > NOW() - INTERVAL 60 SECOND
        ORDER BY otp_id DESC LIMIT 1`,
      [userId]
    );
    if (recent.length > 0) {
      return res.status(429).json({ error: 'ขอ OTP ได้อีกครั้งใน 60 วินาที' });
    }

    const otp = generate6DigitOtp();
    await pool.execute(
      `INSERT INTO phone_otp_chaungthai
        (otp_user_id, otp_phone, otp_code, otp_expires_at)
       VALUES (?, ?, ?, NOW() + INTERVAL 5 MINUTE)`,
      [userId, rows[0].user_phone, otp]
    );

    const response = {
      message: 'ส่งรหัส OTP ไปยังเบอร์โทรแล้ว (mock - dev)',
      expires_in_seconds: 300,
    };
    if (isDev()) {
      response.otp_code = otp;
      response.note = 'mock: ใน production จะส่ง SMS แทน';
    }
    return res.json(response);
  } catch (err) {
    console.error('[verify-phone/request] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

router.post('/verify-phone/confirm', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { otp_code } = req.body || {};
    if (!otp_code || !/^\d{6}$/.test(String(otp_code))) {
      return res.status(400).json({ error: 'otp_code ต้องเป็นตัวเลข 6 หลัก' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.execute(
        `SELECT otp_id FROM phone_otp_chaungthai
          WHERE otp_user_id = ?
            AND otp_code = ?
            AND otp_used_at IS NULL
            AND otp_expires_at > NOW()
          ORDER BY otp_id DESC LIMIT 1
          FOR UPDATE`,
        [userId, String(otp_code)]
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'OTP ไม่ถูกต้องหรือหมดอายุ' });
      }

      await conn.execute(
        'UPDATE phone_otp_chaungthai SET otp_used_at = CURRENT_TIMESTAMP WHERE otp_id = ?',
        [rows[0].otp_id]
      );
      await conn.execute(
        'UPDATE user_chaungthai SET user_phone_verified_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [userId]
      );

      await conn.commit();
      return res.json({ message: 'ยืนยันเบอร์โทรสำเร็จ' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[verify-phone/confirm] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// ============================================================
//  Forgot Password
//    POST /api/auth/forgot-password (public)
//      -> รับ user_email -> ถ้าเจอ generate reset token
//      -> ตอบ message เดียวกันเสมอ (กัน enumeration)
//      -> Mock: return reset_url ใน response (dev)
//
//    POST /api/auth/reset-password (public)
//      -> รับ token + new_password -> verify -> bcrypt -> UPDATE
// ============================================================

router.post('/forgot-password', async (req, res) => {
  try {
    const { user_email } = req.body || {};
    const response = {
      message: 'ถ้ามีอีเมลนี้ในระบบ ลิงก์รีเซ็ตรหัสผ่านจะถูกส่งให้',
    };

    if (!user_email || typeof user_email !== 'string' || !EMAIL_REGEX.test(user_email)) {
      // ตอบเหมือนกัน
      return res.json(response);
    }

    // อีเมลเดียวกันมีได้ 2 บัญชี → ต้องบอกว่าจะรีเซ็ตของฝั่งไหน
    const accountType = parseAccountType((req.body || {}).user_account_type);
    if (accountType === 'INVALID') {
      return res.json(response);
    }

    const [rows] = await pool.execute(
      `SELECT user_id FROM user_chaungthai
        WHERE user_email = ? AND user_account_type = ? AND user_status = "Active" LIMIT 1`,
      [user_email.trim().toLowerCase(), accountType]
    );

    if (rows.length === 0) {
      // ตอบเหมือนกัน — ไม่บอกว่ามี email ในระบบหรือไม่
      return res.json(response);
    }

    const token = jwt.sign(
      { type: 'password_reset', user_id: rows[0].user_id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const resetUrl = `/reset-password?token=${token}`;

    if (isDev()) {
      response.reset_url = resetUrl;
      response.reset_token = token;
      response.note = 'mock: ใน production จะส่งอีเมลแทน';
    }
    return res.json(response);
  } catch (err) {
    console.error('[forgot-password] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) {
      return res.status(400).json({ error: 'กรุณาส่ง token + new_password' });
    }
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'new_password ต้องมีอย่างน้อย 8 ตัวอักษร' });
    }

    let decoded;
    try {
      decoded = jwt.verify(String(token), process.env.JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return res.status(400).json({ error: 'token หมดอายุ กรุณาขอใหม่' });
      }
      return res.status(400).json({ error: 'token ไม่ถูกต้อง' });
    }
    if (decoded.type !== 'password_reset') {
      return res.status(400).json({ error: 'token ไม่ใช่ประเภทรีเซ็ตรหัสผ่าน' });
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const hash = await bcrypt.hash(new_password, rounds);

    const [result] = await pool.execute(
      'UPDATE user_chaungthai SET user_password = ? WHERE user_id = ? AND user_status = "Active"',
      [hash, decoded.user_id]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'ไม่พบผู้ใช้หรือบัญชีถูกปิด' });
    }
    return res.json({ message: 'รีเซ็ตรหัสผ่านสำเร็จ กรุณา login ใหม่' });
  } catch (err) {
    console.error('[reset-password] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

module.exports = router;
