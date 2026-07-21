// ============================================================
//  Users Routes
//  Mounted at: /api/users
//
//  GET  /api/users/:user_id        - ดูโปรไฟล์ (ไม่ต้อง login)
//  PUT  /api/users/:user_id        - อัปเดตโปรไฟล์ (login + เจ้าของ)
//  POST /api/users/:user_id/image  - อัปโหลดรูปโปรไฟล์ (login + เจ้าของ)
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');
const { parseLatLng } = require('../lib/geo');

const router = express.Router();

// ------------------------------------------------------------
//  Multer config สำหรับ upload รูปโปรไฟล์
//  เก็บใน UPLOADS_DIR/avatars/ (default <project>/uploads/avatars)
//  serve กลับผ่าน server.js: app.use('/api/uploads', express.static(UPLOADS_DIR))
// ------------------------------------------------------------
const UPLOADS_DIR =
  process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

const UPLOAD_MAX = Number(process.env.UPLOAD_MAX_BYTES) || 5 * 1024 * 1024;

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      // map MIME -> ext เผื่อ originalname ไม่มี ext
      const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
      ext = map[file.mimetype] || '.jpg';
    }
    const userId = (req.user && req.user.user_id) || 'anon';
    const ts = Date.now();
    cb(null, `avatar_${userId}_${ts}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: UPLOAD_MAX },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('รองรับเฉพาะไฟล์ jpg/png/webp'));
  },
});

// ------------------------------------------------------------
//  Field ที่ส่งกลับใน response (ตัด sensitive ออก)
//  *** ไม่รวม: user_password, user_national_id, user_national_id_hash ***
// ------------------------------------------------------------
const PUBLIC_FIELDS = `
  user_id, user_name, user_lastname, user_email, user_image,
  user_phone, user_birthday, user_address, user_bio,
  user_lat, user_lng,
  user_role, user_account_type, user_status,
  user_email_verified_at, user_phone_verified_at, user_identity_verified_at,
  user_created_at, user_updated_at, user_last_login_at
`;

// ------------------------------------------------------------
//  Field ที่อนุญาตให้ PUT แก้ได้ (whitelist)
// ------------------------------------------------------------
const UPDATABLE_FIELDS = [
  'user_name',
  'user_lastname',
  'user_phone',
  'user_birthday',
  'user_address',
  'user_image',
  'user_bio',
  'user_lat',
  'user_lng',
];

/**
 * ตรวจพิกัดที่อยู่ผู้ใช้ (ใช้เปิดแผนที่ที่ตำแหน่งตัวเอง)
 * - ต้องส่ง lat/lng มาคู่กันเสมอ
 * - ส่ง null ทั้งคู่ = ลบหมุดออก
 *
 * Return { ok: true } หรือ { ok: false, error: '...' }
 */
function validateUserCoords(fields) {
  const hasLat = fields.user_lat !== undefined;
  const hasLng = fields.user_lng !== undefined;
  if (!hasLat && !hasLng) return { ok: true };
  if (hasLat !== hasLng) {
    return { ok: false, error: 'ต้องส่ง user_lat และ user_lng มาคู่กัน' };
  }

  // ส่ง null ทั้งคู่ = ล้างพิกัดทิ้ง
  if (fields.user_lat === null && fields.user_lng === null) return { ok: true };

  const geo = parseLatLng(fields.user_lat, fields.user_lng);
  if (!geo.ok) return { ok: false, error: geo.error };

  fields.user_lat = geo.lat;
  fields.user_lng = geo.lng;
  return { ok: true };
}

// ความยาวสูงสุดของแต่ละ field (ตาม schema DB)
const FIELD_MAX_LEN = {
  user_name: 100,
  user_lastname: 100,
  user_phone: 20,
  user_address: 500,
  user_image: 500,
  // user_bio = TEXT (ไม่จำกัด)
  // user_birthday = DATE (ตรวจ format แทน)
};

// ------------------------------------------------------------
//  Helper: validate user_id ใน URL params
// ------------------------------------------------------------
function parseUserId(req, res) {
  const id = Number(req.params.user_id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'user_id ไม่ถูกต้อง' });
    return null;
  }
  return id;
}

// ============================================================
//  GET /api/users/:user_id
//  ดูโปรไฟล์ของผู้ใช้คนหนึ่ง (สาธารณะ)
// ============================================================
router.get('/:user_id', async (req, res) => {
  try {
    const userId = parseUserId(req, res);
    if (userId === null) return;

    const [rows] = await pool.execute(
      `SELECT ${PUBLIC_FIELDS} FROM user_chaungthai WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    }

    return res.json({ user: rows[0] });
  } catch (err) {
    console.error('[users][GET] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  PUT /api/users/:user_id
//  อัปเดตโปรไฟล์ (login + ต้องเป็นเจ้าของเท่านั้น)
//  Partial update: ส่งมาเฉพาะ field ที่อยากแก้
// ============================================================
router.put('/:user_id', verifyToken, async (req, res) => {
  try {
    const userId = parseUserId(req, res);
    if (userId === null) return;

    // ----- 1. ตรวจสอบเจ้าของ -----
    if (req.user.user_id !== userId) {
      return res.status(403).json({
        error: 'ไม่อนุญาตให้แก้ไขโปรไฟล์ของผู้อื่น',
      });
    }

    // ----- 2. เลือกเฉพาะ field ที่ allow + ส่งมาจริง -----
    const body = req.body || {};
    const fieldsToUpdate = {};
    const ignoredFields = [];

    for (const key of Object.keys(body)) {
      if (UPDATABLE_FIELDS.includes(key)) {
        let val = body[key];
        // พิกัด: รับเป็น number หรือ string ตัวเลข -> แปลงเป็น number
        if (key === 'user_lat' || key === 'user_lng') {
          if (val === null || val === '') {
            val = null;
          } else {
            const n = Number(val);
            val = Number.isFinite(n) ? n : val; // แปลงไม่ได้ปล่อยให้ validate ทีหลัง reject
          }
        } else if (typeof val === 'string') {
          // string: trim, ถ้าว่าง -> null (สำหรับ "clear" field)
          val = val.trim();
          if (val === '') val = null;
        }
        fieldsToUpdate[key] = val;
      } else {
        ignoredFields.push(key);
      }
    }

    // ----- 3. ถ้าไม่ส่ง field ที่แก้ได้เลย -----
    if (Object.keys(fieldsToUpdate).length === 0) {
      return res.status(400).json({
        error: 'ไม่มีข้อมูลที่ต้องการอัปเดต',
        allowed_fields: UPDATABLE_FIELDS,
        ignored: ignoredFields,
      });
    }

    // ----- 4. validate ค่าแต่ละ field -----

    // user_name ห้าม null (NOT NULL ใน DB)
    if (Object.prototype.hasOwnProperty.call(fieldsToUpdate, 'user_name')
        && !fieldsToUpdate.user_name) {
      return res.status(400).json({ error: 'user_name ห้ามว่าง' });
    }

    // ตรวจความยาว
    for (const [field, maxLen] of Object.entries(FIELD_MAX_LEN)) {
      const v = fieldsToUpdate[field];
      if (v && typeof v === 'string' && v.length > maxLen) {
        return res.status(400).json({
          error: `${field} ยาวเกิน ${maxLen} ตัวอักษร`,
        });
      }
    }

    // ตรวจรูปแบบ user_birthday (YYYY-MM-DD)
    if (fieldsToUpdate.user_birthday) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fieldsToUpdate.user_birthday)) {
        return res.status(400).json({
          error: 'รูปแบบ user_birthday ต้องเป็น YYYY-MM-DD',
        });
      }
    }

    // ตรวจพิกัด (ต้องมาคู่กัน + อยู่ในขอบเขตประเทศไทย)
    const coordCheck = validateUserCoords(fieldsToUpdate);
    if (!coordCheck.ok) {
      return res.status(400).json({ error: coordCheck.error });
    }

    // ----- 5. สร้าง SQL UPDATE แบบ dynamic -----
    const setClauses = Object.keys(fieldsToUpdate)
      .map((f) => `${f} = ?`)
      .join(', ');
    const values = Object.values(fieldsToUpdate);
    values.push(userId);

    const [result] = await pool.execute(
      `UPDATE user_chaungthai SET ${setClauses} WHERE user_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    }

    // ----- 6. SELECT user ใหม่กลับมา (ดู state หลัง update) -----
    const [rows] = await pool.execute(
      `SELECT ${PUBLIC_FIELDS} FROM user_chaungthai WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    return res.json({
      message: 'อัปเดตข้อมูลสำเร็จ',
      updated_fields: Object.keys(fieldsToUpdate),
      ignored_fields: ignoredFields,
      user: rows[0],
    });

  } catch (err) {
    console.error('[users][PUT] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  POST /api/users/:user_id/image
//  อัปโหลดรูปโปรไฟล์ (login + เจ้าของเท่านั้น)
//  - รับ multipart/form-data, field name = "image"
//  - ขนาด <= UPLOAD_MAX (default 5MB)
//  - MIME: jpg/png/webp เท่านั้น
//  - save filename: avatar_<user_id>_<timestamp>.<ext>
//  - update DB: user_image = "/api/uploads/avatars/<filename>"
//  - ลบรูปเก่า (ถ้ามีและอยู่ใน /api/uploads/)
// ============================================================
router.post(
  '/:user_id/image',
  verifyToken,
  (req, res, next) => {
    // ใช้ middleware แบบ wrapped เพื่อ handle multer error เอง
    avatarUpload.single('image')(req, res, (err) => {
      if (err) {
        // multer error (file too big, MIME ไม่ผ่าน, ฯลฯ)
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const userId = parseUserId(req, res);
      if (userId === null) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return;
      }

      // ต้องเป็นเจ้าของ
      if (req.user.user_id !== userId) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({
          error: 'ไม่อนุญาตให้แก้ไขโปรไฟล์ของผู้อื่น',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'กรุณาแนบไฟล์รูปที่ field "image"',
        });
      }

      const publicUrl = `/api/uploads/avatars/${req.file.filename}`;

      // ดึงรูปเก่ามาเพื่อลบทีหลัง (ถ้าเป็นไฟล์ที่ upload ไว้บน server)
      const [oldRows] = await pool.execute(
        'SELECT user_image FROM user_chaungthai WHERE user_id = ?',
        [userId]
      );
      const oldImage = oldRows[0]?.user_image || null;

      // update DB
      const [result] = await pool.execute(
        'UPDATE user_chaungthai SET user_image = ? WHERE user_id = ?',
        [publicUrl, userId]
      );
      if (result.affectedRows === 0) {
        // user หาย -> ลบไฟล์ที่เพิ่งอัปโหลด
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
      }

      // ลบรูปเก่าถ้าเก็บใน server (path เริ่มด้วย /api/uploads/avatars/)
      if (oldImage && oldImage.startsWith('/api/uploads/avatars/')) {
        const oldFile = path.join(AVATARS_DIR, path.basename(oldImage));
        // safety: ต้องอยู่ใน AVATARS_DIR เท่านั้น
        if (oldFile.startsWith(AVATARS_DIR + path.sep)) {
          fs.unlink(oldFile, () => {}); // silent (ถ้าไฟล์หาย ไม่ error)
        }
      }

      return res.json({
        message: 'อัปโหลดรูปโปรไฟล์สำเร็จ',
        user_id: userId,
        user_image: publicUrl,
        size_bytes: req.file.size,
        mimetype: req.file.mimetype,
      });
    } catch (err) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error('[users][POST image] error:', err);
      return res.status(500).json({
        error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
        detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      });
    }
  }
);

// ============================================================
//  PATCH /api/users/:user_id/password
//  เปลี่ยนรหัสผ่าน (auth + เจ้าของ + ต้องรู้รหัสเก่า)
//  Body: { old_password, new_password }
// ============================================================
router.patch('/:user_id/password', verifyToken, async (req, res) => {
  try {
    const userId = parseUserId(req, res);
    if (userId === null) return;

    if (req.user.user_id !== userId) {
      return res.status(403).json({ error: 'ไม่อนุญาตให้แก้รหัสผ่านของผู้อื่น' });
    }

    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password) {
      return res.status(400).json({ error: 'กรุณาส่ง old_password + new_password' });
    }
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'new_password ต้องมีอย่างน้อย 8 ตัวอักษร' });
    }
    if (old_password === new_password) {
      return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับของเดิม' });
    }

    // ดึง hash ปัจจุบัน
    const [rows] = await pool.execute(
      'SELECT user_password FROM user_chaungthai WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (rows.length === 0 || !rows[0].user_password) {
      return res.status(400).json({ error: 'ไม่พบรหัสผ่านในระบบ' });
    }

    // ตรวจ old
    const match = await bcrypt.compare(old_password, rows[0].user_password);
    if (!match) {
      return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    }

    // hash + update
    const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
    const newHash = await bcrypt.hash(new_password, rounds);
    await pool.execute(
      'UPDATE user_chaungthai SET user_password = ? WHERE user_id = ?',
      [newHash, userId]
    );
    return res.json({ message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  } catch (err) {
    console.error('[users][PATCH password] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ============================================================
//  DELETE /api/users/:user_id
//  ปิดบัญชี (auth + เจ้าของ + ต้องยืนยันด้วย password)
//  Soft delete: user_status = 'Closed'
//  Body: { password: "รหัสปัจจุบัน" }
// ============================================================
router.delete('/:user_id', verifyToken, async (req, res) => {
  try {
    const userId = parseUserId(req, res);
    if (userId === null) return;

    if (req.user.user_id !== userId) {
      return res.status(403).json({ error: 'ไม่อนุญาตให้ปิดบัญชีของผู้อื่น' });
    }

    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'กรุณายืนยันด้วยรหัสผ่านปัจจุบัน' });
    }

    const [rows] = await pool.execute(
      'SELECT user_password, user_status FROM user_chaungthai WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (rows[0].user_status === 'Closed') {
      return res.status(409).json({ error: 'บัญชีถูกปิดอยู่แล้ว' });
    }
    if (!rows[0].user_password) {
      return res.status(400).json({ error: 'ไม่พบรหัสผ่านในระบบ' });
    }

    const match = await bcrypt.compare(password, rows[0].user_password);
    if (!match) {
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }

    await pool.execute(
      `UPDATE user_chaungthai SET user_status = 'Closed' WHERE user_id = ?`,
      [userId]
    );
    return res.json({
      message: 'ปิดบัญชีสำเร็จ — ข้อมูลของคุณยังอยู่แต่จะไม่ปรากฏในระบบ',
      user_id: userId,
      user_status: 'Closed',
    });
  } catch (err) {
    console.error('[users][DELETE] error:', err);
    return res.status(500).json({
      error: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์',
      detail: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
