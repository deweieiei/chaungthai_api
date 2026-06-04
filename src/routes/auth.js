// ============================================================
//  Auth Routes (register, login, ...)
//  Mounted at: /api/auth
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');

const router = express.Router();

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

module.exports = router;
