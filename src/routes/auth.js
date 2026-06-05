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

// ============================================================
//  POST /api/auth/register
//  สมัครสมาชิก (รับ 4 fields: name, lastname, email, password)
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const {
      user_name,
      user_lastname,
      user_email,
      user_password,
    } = req.body || {};

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

    // ----- 3. เช็คอีเมลซ้ำ -----
    const [existing] = await pool.execute(
      'SELECT user_id FROM user_chaungthai WHERE user_email = ? LIMIT 1',
      [user_email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'อีเมลนี้มีผู้ใช้งานแล้ว' });
    }

    // ----- 4. Hash password ด้วย bcrypt -----
    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(user_password, rounds);

    // ----- 5. บันทึก DB -----
    const [result] = await pool.execute(
      `INSERT INTO user_chaungthai
        (user_name, user_lastname, user_email, user_password)
       VALUES (?, ?, ?, ?)`,
      [
        user_name.trim(),
        user_lastname ? user_lastname.trim() : null,
        user_email.trim().toLowerCase(),
        passwordHash,
      ]
    );

    // ----- 6. ตอบกลับ (ไม่ส่ง password กลับ!) -----
    return res.status(201).json({
      message: 'สมัครสมาชิกสำเร็จ',
      user_id: result.insertId,
      user_name: user_name.trim(),
      user_email: user_email.trim().toLowerCase(),
    });

  } catch (err) {
    // จัดการ error ที่หลุดมา (เช่น DB ล่ม, duplicate race condition)
    console.error('[register] error:', err);

    // กรณี race condition (เช็คอีเมลผ่าน แต่ INSERT แล้ว unique key ชน)
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'อีเมลนี้มีผู้ใช้งานแล้ว' });
    }

    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  POST /api/auth/login
//  รับ user_email + user_password -> ตรวจรหัส -> ออก JWT token
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

    // ----- 2. ค้นหา user จาก email -----
    const emailNorm = user_email.trim().toLowerCase();
    const [rows] = await pool.execute(
      `SELECT user_id, user_email, user_password, user_name, user_lastname,
              user_role, user_status, user_image
         FROM user_chaungthai
        WHERE user_email = ?
        LIMIT 1`,
      [emailNorm]
    );

    // ใช้ error message เดียวกันสำหรับ "email ไม่พบ" และ "password ผิด"
    // เพื่อไม่ให้ผู้ไม่ประสงค์ดี เดาว่ามี email นี้ในระบบหรือไม่
    const INVALID = { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' };

    if (rows.length === 0) {
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
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // ----- 8. ตอบกลับ -----
    return res.json({
      message: 'เข้าสู่ระบบสำเร็จ',
      token,
      expires_in: process.env.JWT_EXPIRES_IN || '7d',
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        user_lastname: user.user_lastname,
        user_email: user.user_email,
        user_role: user.user_role,
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

router.post('/verify-email/request', verifyToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // ดึงอีเมลปัจจุบัน + เช็คว่ายืนยันแล้วยัง
    const [rows] = await pool.execute(
      'SELECT user_email, user_email_verified_at FROM user_chaungthai WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (rows[0].user_email_verified_at) {
      return res.status(409).json({ error: 'ยืนยันอีเมลแล้ว' });
    }

    const token = jwt.sign(
      { type: 'email_verify', user_id: userId, email: rows[0].user_email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Mock: ส่ง URL กลับใน response (dev)
    // ใน production: ส่ง email + ตอบ message อย่างเดียว
    const verifyUrl = `/verify-email?token=${token}`;
    const response = {
      message: 'ส่งลิงก์ยืนยันอีเมลแล้ว (mock - dev)',
    };
    if (isDev()) {
      response.verify_url = verifyUrl;
      response.verify_token = token;
      response.note = 'mock: ใน production จะส่งอีเมลแทน';
    }
    return res.json(response);
  } catch (err) {
    console.error('[verify-email/request] error:', err);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

router.post('/verify-email/confirm', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'กรุณาส่ง token' });

    let decoded;
    try {
      decoded = jwt.verify(String(token), process.env.JWT_SECRET);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return res.status(400).json({ error: 'token หมดอายุ กรุณาขอใหม่' });
      }
      return res.status(400).json({ error: 'token ไม่ถูกต้อง' });
    }
    if (decoded.type !== 'email_verify') {
      return res.status(400).json({ error: 'token ไม่ใช่ประเภทยืนยันอีเมล' });
    }

    const [result] = await pool.execute(
      `UPDATE user_chaungthai
          SET user_email_verified_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
          AND user_email = ?`,
      [decoded.user_id, decoded.email]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ error: 'ไม่พบผู้ใช้หรืออีเมลเปลี่ยนไปแล้ว' });
    }
    return res.json({ message: 'ยืนยันอีเมลสำเร็จ', user_id: decoded.user_id });
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

    const [rows] = await pool.execute(
      'SELECT user_id FROM user_chaungthai WHERE user_email = ? AND user_status = "Active" LIMIT 1',
      [user_email.trim().toLowerCase()]
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
