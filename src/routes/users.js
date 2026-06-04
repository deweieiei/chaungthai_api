// ============================================================
//  Users Routes
//  Mounted at: /api/users
//
//  GET  /api/users/:user_id  - ดูโปรไฟล์ (ไม่ต้อง login)
//  PUT  /api/users/:user_id  - อัปเดตโปรไฟล์ (login + เจ้าของเท่านั้น)
// ============================================================

const express = require('express');
const pool = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// ------------------------------------------------------------
//  Field ที่ส่งกลับใน response (ตัด sensitive ออก)
//  *** ไม่รวม: user_password, user_national_id, user_national_id_hash ***
// ------------------------------------------------------------
const PUBLIC_FIELDS = `
  user_id, user_name, user_lastname, user_email, user_image,
  user_phone, user_birthday, user_address, user_bio,
  user_province_id, user_district_id, user_subdistrict_id,
  user_role, user_status,
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
  'user_province_id',
  'user_district_id',
  'user_subdistrict_id',
];

// field ที่เป็น location id (จะ validate type + parent-child match)
const LOCATION_ID_FIELDS = ['user_province_id', 'user_district_id', 'user_subdistrict_id'];

/**
 * ตรวจสอบ location ids:
 * - ทุก id ที่ส่งมาต้องเป็น integer
 * - ถ้าส่งหลาย id มาด้วยกัน parent-child ต้องตรง
 * - id ต้องมีอยู่ใน DB
 *
 * Return { ok: true } หรือ { ok: false, error: '...' }
 */
async function validateLocationIds(pool, ids) {
  const { user_province_id: p, user_district_id: d, user_subdistrict_id: s } = ids;

  // 1. ตรวจ type
  for (const k of LOCATION_ID_FIELDS) {
    if (ids[k] !== undefined && ids[k] !== null) {
      if (!Number.isInteger(ids[k]) || ids[k] < 1) {
        return { ok: false, error: `${k} ต้องเป็นจำนวนเต็มบวก` };
      }
    }
  }

  // 2. ตรวจ exists + parent-child
  if (p !== undefined && p !== null) {
    const [r] = await pool.execute(
      'SELECT 1 FROM location_province_chaungthai WHERE province_id = ?',
      [p]
    );
    if (r.length === 0) return { ok: false, error: 'user_province_id ไม่พบในระบบ' };
  }

  if (d !== undefined && d !== null) {
    const [r] = await pool.execute(
      'SELECT district_province_id FROM location_district_chaungthai WHERE district_id = ?',
      [d]
    );
    if (r.length === 0) return { ok: false, error: 'user_district_id ไม่พบในระบบ' };
    if (p !== undefined && p !== null && r[0].district_province_id !== p) {
      return { ok: false, error: 'user_district_id ไม่อยู่ใน user_province_id ที่เลือก' };
    }
  }

  if (s !== undefined && s !== null) {
    const [r] = await pool.execute(
      'SELECT subdistrict_district_id FROM location_subdistrict_chaungthai WHERE subdistrict_id = ?',
      [s]
    );
    if (r.length === 0) return { ok: false, error: 'user_subdistrict_id ไม่พบในระบบ' };
    if (d !== undefined && d !== null && r[0].subdistrict_district_id !== d) {
      return { ok: false, error: 'user_subdistrict_id ไม่อยู่ใน user_district_id ที่เลือก' };
    }
  }

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
        // location id: รับเป็น number หรือ string ตัวเลข -> แปลงเป็น number
        if (LOCATION_ID_FIELDS.includes(key)) {
          if (val === null || val === '') {
            val = null;
          } else {
            const n = Number(val);
            val = Number.isFinite(n) ? n : val; // ถ้าแปลงไม่ได้ปล่อยให้ validate ทีหลัง reject
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

    // ตรวจ location ids (type + exists + parent-child)
    if (LOCATION_ID_FIELDS.some((k) => k in fieldsToUpdate)) {
      const v = await validateLocationIds(pool, fieldsToUpdate);
      if (!v.ok) {
        return res.status(400).json({ error: v.error });
      }
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

module.exports = router;
